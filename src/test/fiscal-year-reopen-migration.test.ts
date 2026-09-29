import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * 6C-b11 PR E — heropenen en opnieuw afsluiten.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/fiscal-year-reopen/` en draait tegen een
 * echte PostgreSQL (60 bewijzen, incl. twee gelijktijdige sessies en erfenis
 * die vóór de migratie is aangelegd). Dit bestand bewaakt de VORM, en de
 * beloftes die PR E onderscheidt: de boekingsblokkade en het grootboek worden
 * nergens geraakt, de bewakers aanvaarden alleen bewijs uit dezelfde
 * transactie, en de herafsluiting draait de volledige gereedheid opnieuw.
 */

const MIGRATION_DIR = "supabase/migrations";
const allMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
const own = allMigrations.filter((f) => f.endsWith("_add_fiscal_year_reopen.sql"));
const MIGRATION = `${MIGRATION_DIR}/${own[0]}`;

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
const withoutComments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
const sql = withoutComments(raw);
const flat = sql.replace(/\s+/g, " ");

function functie(naam: string, text = sql): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${naam}(`);
  if (start < 0) return "";
  const as = text.indexOf("AS $$", start);
  const end = text.indexOf("$$;", as + 5);
  return text.slice(start, end + 3);
}

const reopen = functie("reopen_fiscal_year");
const close = functie("close_fiscal_year");
const statusGuard = functie("prevent_year_closure_mutation");
const watermarkGuard = functie("enforce_year_close_watermark");
const stamp = functie("stamp_fiscal_year_event_xact");

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const changed = git("diff", "--name-only", "origin/main...HEAD");
const introducedHere = git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD").includes(MIGRATION);

describe("Migratie — PR E, vorm", () => {
  it("1. bestaat precies één keer, met een tijdstempel ná alle bestaande migraties", () => {
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^\d{14}_add_fiscal_year_reopen\.sql$/);
    expect(own[0].slice(0, 14) > "20260930120000").toBe(true);
    expect(own[0].slice(0, 14)).not.toBe("20260929120000");
  });

  it("2. definieert precies deze vijf functies", () => {
    const defined = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
    expect(defined).toEqual([
      "close_fiscal_year",
      "enforce_year_close_watermark",
      "prevent_year_closure_mutation",
      "reopen_fiscal_year",
      "stamp_fiscal_year_event_xact",
    ]);
  });

  it("3. de enige schemawijziging is created_xact_id: nullable, zonder default (geen verzonnen herkomst)", () => {
    const alters = [...flat.matchAll(/ALTER TABLE public\.(\w+) ([^;]*);/g)].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(alters).toEqual([
      "fiscal_year_events ADD COLUMN IF NOT EXISTS created_xact_id xid8 NULL",
      "fiscal_year_events ENABLE ALWAYS TRIGGER stamp_fiscal_year_event_xact_trigger",
    ]);
    expect(flat).not.toMatch(/created_xact_id xid8[^;]*DEFAULT/);
    expect(flat).not.toMatch(/CREATE TABLE|DROP TABLE|DROP COLUMN|ALTER COLUMN/i);
    expect(stamp).toContain("NEW.created_xact_id := pg_current_xact_id();");
  });

  it("4. raakt de boekingsblokkade en het grootboek nergens (uitvoerbare code)", () => {
    // Zonder de COMMENT ON-teksten: uitvoerbaar, maar inhoudelijk proza.
    const code = sql.replace(/COMMENT ON [^;]*;/g, "");
    expect(code).not.toMatch(/posting_locked_through|posting_lock_events|set_posting_lock/);
    expect(code).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.ledger_postings/i);
    expect(code).not.toMatch(/DELETE FROM|TRUNCATE/i);
  });
});

describe("reopen_fiscal_year", () => {
  it("5. SECURITY DEFINER, vast search_path, alleen EXECUTE voor authenticated", () => {
    expect(reopen).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    expect(flat).toContain("REVOKE ALL ON FUNCTION public.reopen_fiscal_year(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;");
    expect(flat).toContain("GRANT EXECUTE ON FUNCTION public.reopen_fiscal_year(uuid, integer, text) TO authenticated;");
  });

  it("6. reden getrimd (ook tab/CR/LF), verplicht en hooguit 500 tekens", () => {
    expect(reopen).toContain("btrim(COALESCE(_reason, ''), E' \\t\\r\\n')");
    expect(reopen).toMatch(/length\(v_reason\) > 500/);
  });

  it("7. tenant-veilig en rolvloer accountant, met één antwoord voor 'bestaat niet' en 'geen toegang'", () => {
    expect(reopen).toContain("v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'read_only')");
    expect(reopen).toContain("public.has_min_role(v_uid, v_org, 'accountant')");
  });

  it("8. grendelt administratie, administratierij en afsluitbewijs vóór er iets wordt gelezen of geschreven", () => {
    const lock = reopen.indexOf("PERFORM public.lock_ledger_client(_client_id);");
    const clientRow = reopen.indexOf("FROM public.clients c WHERE c.id = _client_id FOR UPDATE");
    const closureRow = reopen.indexOf("WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year\n  FOR UPDATE");
    const firstWrite = reopen.indexOf("INSERT INTO public.fiscal_year_events");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(clientRow);
    expect(clientRow).toBeLessThan(closureRow);
    expect(closureRow).toBeLessThan(firstWrite);
  });

  it("9. volgorde: gebeurtenis, dan status, dan watermerk — nooit blind jaar - 1", () => {
    const event = reopen.indexOf("INSERT INTO public.fiscal_year_events");
    const status = reopen.indexOf("SET status = 'reopened'");
    const mark = reopen.indexOf("SET afgesloten_boekjaar = v_new_mark");
    expect(event).toBeLessThan(status);
    expect(status).toBeLessThan(mark);
    expect(reopen).not.toMatch(/_fiscal_year\s*-\s*1/);
    expect(reopen).toMatch(/max\(yc\.fiscal_year\)[\s\S]*yc\.status = 'closed' AND yc\.fiscal_year <> _fiscal_year/);
  });

  it("10. herhaald heropenen is een no-op zonder nieuwe gebeurtenis; inconsistente standen falen dicht", () => {
    expect(reopen).toMatch(/IF v_existing\.status = 'reopened' THEN[\s\S]*?false;\s*RETURN;/);
    expect((reopen.match(/de afsluitstand is inconsistent/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(reopen).toContain("Alleen het laatst afgesloten boekjaar");
  });
});

describe("De bewakers — alleen bewijs uit dezelfde transactie", () => {
  it("11. status alleen mét een gebeurtenis van hetzelfde type uit deze transactie; al het andere blijft append-only", () => {
    expect(statusGuard).toContain("e.event_type = NEW.status");
    expect(statusGuard).toContain("e.created_xact_id = pg_current_xact_id()");
    expect(statusGuard).toMatch(/NEW\.closed_at, NEW\.closed_by\)\s+IS NOT DISTINCT FROM/);
    expect(statusGuard).toContain("year_closures is append-only");
  });

  it("12. watermerk omlaag alleen met een heropening uit deze transactie en exact het hoogste afgesloten jaar", () => {
    expect(watermarkGuard).toContain("e.event_type = 'reopened' AND e.created_xact_id = pg_current_xact_id()");
    expect(watermarkGuard).toContain("e.event_type = 'closed' AND e.created_xact_id = pg_current_xact_id()");
    expect(watermarkGuard).toMatch(/NEW\.afgesloten_boekjaar IS DISTINCT FROM v_highest/);
  });

  it("13. geen sessie-GUC als bewijs", () => {
    for (const fn of [statusGuard, watermarkGuard, reopen, close, stamp]) {
      expect(fn).not.toMatch(/current_setting\((?!'transaction_isolation')/);
      expect(fn).not.toMatch(/set_config/);
    }
  });
});

describe("close_fiscal_year — ook opnieuw afsluiten", () => {
  const b = readFileSync(resolve(process.cwd(), MIGRATION_DIR, "20260926120000_close_writes_fiscal_year_event.sql"), "utf8");
  const prB = functie("close_fiscal_year", withoutComments(b));

  it("14. elke weigering en controle van PR B staat er nog — de gereedheid draait volledig, ook bij herafsluiten", () => {
    const messages = (text: string) =>
      [...text.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]).filter((m) => !m.startsWith("Er bestaat al een afsluitbewijs"));
    for (const m of messages(prB)) expect(close, m).toContain(m);
    expect(close).toContain("v_reclose := true;");
    // De herafsluiting keert niet terug vóór de controles B t/m E.
    // Controle B (afsluitvolgorde) staat NA het zetten van v_reclose: niets keert eerder terug.
    expect(close.indexOf("v_reclose := true;")).toBeLessThan(close.indexOf("INTO v_open_years"));
    expect(close.slice(close.indexOf("v_reclose := true;"), close.indexOf("IF v_reclose THEN"))).not.toMatch(/\bRETURN\b/);
    expect(close.indexOf("IF v_reclose THEN")).toBeGreaterThan(close.indexOf("afsluiten zou % voorgoed onboekbaar maken"));
  });

  it("15. herafsluiten: nieuwe closed-gebeurtenis, dan status, dan watermerk — het originele bewijs blijft staan", () => {
    const re = close.slice(close.indexOf("IF v_reclose THEN"), close.indexOf("RETURN;", close.indexOf("IF v_reclose THEN")));
    const event = re.indexOf("INSERT INTO public.fiscal_year_events");
    const status = re.indexOf("SET status = 'closed'");
    const mark = re.indexOf("SET afgesloten_boekjaar = _fiscal_year");
    expect(event).toBeGreaterThan(0);
    expect(event).toBeLessThan(status);
    expect(status).toBeLessThan(mark);
    expect(re).not.toMatch(/closed_at\s*=|closed_by\s*=/);
    expect(re).not.toMatch(/INSERT INTO public\.year_closures/);
  });

  it("16. weigert zolang een ouder boekjaar heropend is", () => {
    expect(close).toContain("yc.fiscal_year < _fiscal_year AND yc.status = 'reopened'");
  });

  it("17. een eerste afsluiting is ongewijzigd: bewijs, gebeurtenis uit de bewijsrij, dan watermerk", () => {
    const first = close.slice(close.lastIndexOf("INSERT INTO public.year_closures"));
    expect(first).toContain("v_row.closed_at, v_row.closed_by, NULL, false");
    expect(first.indexOf("INSERT INTO public.fiscal_year_events")).toBeLessThan(first.indexOf("SET afgesloten_boekjaar = _fiscal_year"));
  });

  it("18. rechten ongewijzigd", () => {
    expect(flat).toContain("REVOKE ALL ON FUNCTION public.close_fiscal_year(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;");
    expect(flat).toContain("GRANT EXECUTE ON FUNCTION public.close_fiscal_year(uuid, integer) TO authenticated;");
  });
});

describe("Scope", () => {
  it("19. geen bestaande migratie wordt gewijzigd, hernoemd of verwijderd", () => {
    expect(git("diff", "--name-only", "--diff-filter=MDR", "origin/main...HEAD", "--", MIGRATION_DIR)).toEqual([]);
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("20. de branch die PR E invoert, bevat geen UI en geen gegenereerde types", () => {
    if (!introducedHere) return;
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
  });
});
