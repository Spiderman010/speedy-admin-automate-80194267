import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * 6C-b11 PR A — de fundering van de boekjaarlevenscyclus.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Wat de DATABASE doet — triggers, rechten, RLS, constraints en een backfill
 * over echte rijen — is niet met een reguliere expressie te bewijzen. Dat staat
 * in `supabase/tests/fiscal-year-events/` en draait tegen een echte PostgreSQL
 * (31 bewijzen), waar de wereld eerst wordt opgebouwd zoals productie hem
 * vandaag heeft, drie boekjaren via de ECHTE schrijver worden afgesloten, en
 * pas daarna de migratie onder test wordt toegepast — twee keer.
 *
 * Dit bestand bewaakt wat daar juist NIET te zien is: dat de migratie blijft
 * zeggen wat zij hoort te zeggen, en vooral dat deze PR de belofte houdt die
 * hem onderscheidt van alle volgende PR's — **er verandert niets aan het
 * gedrag**.
 */

const MIGRATION_SLUG = "_add_fiscal_year_lifecycle_events.sql";
const MIGRATION_DIR = "supabase/migrations";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith(MIGRATION_SLUG),
);
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

/**
 * Alleen de UITVOERENDE SQL, zonder de `COMMENT ON … IS '…'`-teksten.
 *
 * Die zijn weliswaar uitvoerbaar, maar inhoudelijk proza: zij leggen juist uit
 * wat deze migratie NIET doet ("prevent_year_closure_mutation() weigert elke
 * UPDATE", "heropenen bestaat nog niet"). Een assertie over het ontbreken van
 * die woorden zou daar altijd op afgaan — en dan zou de test de documentatie
 * wegduwen in plaats van de code te bewaken.
 */
const code = sql.replace(/COMMENT ON [^;]*;/g, "");

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

describe("Migratie — de boekjaargebeurtenissen", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_add_fiscal_year_lifecycle_events\.sql$/);
  });

  it("2. maakt exact één nieuwe tabel: fiscal_year_events", () => {
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["fiscal_year_events"]);
  });

  it("3. de gebeurtenis heeft een eigen sleutel, niet (administratie, boekjaar)", () => {
    // Load-bearing: elke sleutel die op (client, jaar) uniek is, zou
    // closed → reopened → closed voorgoed onmogelijk maken.
    expect(flat).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(flat).not.toMatch(/PRIMARY KEY \(client_id, fiscal_year\)/);
  });

  it("4. de twee soorten gebeurtenissen liggen vast, en verder niets", () => {
    expect(flat).toMatch(/CHECK \(event_type IN \('closed', 'reopened'\)\)/);
  });

  it("5. een heropening zonder reden kan niet bestaan; een afsluiting zonder reden wel", () => {
    const reasonCheck = flat.slice(flat.indexOf("fiscal_year_events_reason_check"));
    expect(reasonCheck).toContain("WHEN event_type = 'reopened'");
    expect(reasonCheck).toContain("THEN reason IS NOT NULL");
    // Whitespace-aware: btrim() alleen trimt spaties, dus tab, CR en LF expliciet.
    expect(reasonCheck).toContain("btrim(reason, E' \\t\\r\\n') <> ''");
    expect(reasonCheck).toContain("ELSE reason IS NULL");
  });

  it("6. tenantintegriteit hergebruikt de bewezen functie in plaats van een tweede model", () => {
    expect(flat).toMatch(/posting_client_org_ok\(NEW\.client_id, NEW\.organization_id\)/);
    expect(flat).toMatch(/BEFORE INSERT ON public\.fiscal_year_events/);
    expect(flat.match(/REFERENCES public\.\w+ \(id\) ON DELETE RESTRICT/g) ?? []).toHaveLength(2);
    expect(flat).toMatch(/REFERENCES auth\.users \(id\) ON DELETE RESTRICT/);
  });

  it("7. de geschiedenis is append-only, ook tegen TRUNCATE en session_replication_role", () => {
    expect(flat).toMatch(/BEFORE UPDATE OR DELETE ON public\.fiscal_year_events/);
    expect(flat).toMatch(/BEFORE TRUNCATE ON public\.fiscal_year_events/);
    expect(flat).toMatch(
      /ALTER TABLE public\.fiscal_year_events ENABLE ALWAYS TRIGGER prevent_fiscal_year_event_mutation_trigger/,
    );
    expect(flat).toMatch(
      /ALTER TABLE public\.fiscal_year_events ENABLE ALWAYS TRIGGER prevent_fiscal_year_event_truncate_trigger/,
    );
  });

  it("8. applicatierollen mogen de geschiedenis alleen lezen", () => {
    expect(flat).toMatch(/ALTER TABLE public\.fiscal_year_events ENABLE ROW LEVEL SECURITY/);
    expect(flat).toMatch(/has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)/);
    expect(flat).toMatch(/REVOKE ALL ON public\.fiscal_year_events FROM anon, authenticated, service_role/);
    expect(flat).toMatch(/GRANT SELECT ON public\.fiscal_year_events TO authenticated, service_role/);
    expect(flat).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* ON public\.fiscal_year_events/);
  });
});

describe("De backfill", () => {
  const backfill = sql.slice(sql.indexOf("INSERT INTO public.fiscal_year_events"));

  it("9. leest uitsluitend uit year_closures", () => {
    expect(backfill.replace(/\s+/g, " ")).toContain("FROM public.year_closures yc");
    const tabellen = [...backfill.matchAll(/FROM public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(tabellen)].sort()).toEqual(["fiscal_year_events", "year_closures"]);
  });

  it("10. gebruikt clients.afgesloten_boekjaar NIET als bron", () => {
    /*
     * Het hart van deze migratie. Productie kent administraties waarvan dat
     * veld vóór 6C-b10 met de hand is gezet, zonder afsluitrij: voor die jaren
     * bestaat geen tijdstip en geen actor. Daar een gebeurtenis van maken zou
     * betekenen dat er een afsluiting wordt gefabriceerd die nooit is
     * uitgevoerd — in precies die tabel die het auditspoor moet zijn.
     */
    expect(backfill).not.toContain("afgesloten_boekjaar");
    expect(backfill).not.toMatch(/FROM public\.clients/);
    // En de migratie raakt de kolom nergens aan.
    expect(sql).not.toMatch(/UPDATE public\.clients/);
    expect(sql).not.toMatch(/ALTER TABLE public\.clients/);
  });

  it("11. neemt elk veld uit de afsluitrij over en verzint er geen bij", () => {
    const f = backfill.replace(/\s+/g, " ");
    expect(f).toContain("yc.client_id");
    expect(f).toContain("yc.organization_id");
    expect(f).toContain("yc.fiscal_year");
    expect(f).toContain("yc.closed_at");
    expect(f).toContain("yc.closed_by");
    expect(f).toContain("'closed'");
    // Geen now(), geen auth.uid(), geen verzonnen reden.
    expect(f).not.toMatch(/now\(\)|auth\.uid\(\)/);
  });

  it("12. is idempotent door een databaseregel, niet door 'de migratie draait één keer'", () => {
    expect(flat).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_fiscal_year_events_backfill ON public\.fiscal_year_events \(client_id, fiscal_year\) WHERE backfilled/,
    );
    expect(backfill.replace(/\s+/g, " ")).toContain("WHERE NOT EXISTS");
  });

  it("13. die regel blokkeert geen TOEKOMSTIGE gebeurtenissen", () => {
    // De uniciteit is partieel (`WHERE backfilled`). Was zij dat niet, dan was
    // closed → reopened → closed voorgoed onmogelijk — precies het gedrag dat
    // deze hele herziening wil toevoegen.
    const index = flat.slice(flat.indexOf("uniq_fiscal_year_events_backfill"));
    expect(index.slice(0, 200)).toContain("WHERE backfilled");
    const unieken = [...sql.matchAll(/CREATE UNIQUE INDEX[^;]*/g)].map((m) => m[0].replace(/\s+/g, " "));
    expect(unieken).toHaveLength(1);
  });
});

describe("PR A verandert geen enkel gedrag", () => {
  it("14. year_closures krijgt er alleen een kolom bij", () => {
    const alters = [...sql.matchAll(/ALTER TABLE public\.year_closures[^;]*/g)].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    for (const alter of alters) {
      expect(alter).toMatch(/ALTER TABLE public\.year_closures (ADD COLUMN IF NOT EXISTS|ADD CONSTRAINT)/);
    }
    expect(flat).toContain("ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'closed'");
    expect(flat).toContain("CHECK (status IN ('closed', 'reopened'))");
  });

  it("15. de bestaande onuitwisbaarheid van year_closures wordt NIET versoepeld", () => {
    /*
     * PR E versmalt `prevent_year_closure_mutation()` bewust tot "alleen de
     * kolom status mag wijzigen", met een eigen bewijs en een eigen review.
     * Hier gebeurt dat uitdrukkelijk niet — dat is het verschil tussen een
     * fundering en een gedragswijziging.
     */
    expect(code).not.toMatch(/prevent_year_closure_mutation/);
    expect(code).not.toMatch(/DROP TRIGGER[^;]*year_closures/);
    expect(code).not.toMatch(/DISABLE TRIGGER/);
  });

  it("16. close_fiscal_year() wordt niet aangeraakt", () => {
    expect(sql).not.toMatch(/close_fiscal_year/);
    expect(changed).not.toContain("supabase/migrations/20260924120000_add_year_close_writer.sql");
  });

  it("17. er komt geen boekingsblokkade en geen heropenweg bij", () => {
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.sort()).toEqual(["enforce_fiscal_year_event_org", "prevent_fiscal_year_event_mutation"]);
    expect(code).not.toMatch(/posting_allowed|posting_lock|locked_through/i);
    /*
     * Gericht op wat er WORDT GEDEFINIEERD, niet op het woord: `'reopened'`
     * hoort hier juist te staan — het is een toegestane waarde van
     * `event_type`, en dat de tabel die waarde nu al kent is precies de
     * fundering die PR A legt. Wat er niet mag zijn, is een FUNCTIE die
     * heropent; de lijst hierboven legt dat sluitend vast.
     */
    expect(functies.filter((naam) => /reopen|heropen/i.test(naam))).toEqual([]);
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*(reopen|heropen)/i);
  });

  it("18. geen enkele bestaande schrijver of het grootboek wordt geraakt", () => {
    expect(sql).not.toMatch(/ledger_postings/);
    expect(sql).not.toMatch(/post_purchase_invoice|post_sales_invoice|post_bank|post_manual_journal/);
    expect(sql).not.toMatch(/post_opening_balance|declare_opening_balance_nil|reverse_posting_group/);
    expect(sql).not.toMatch(/bank_bulk_posting_candidates/);
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("19. de koppeling van vandaag staat er nog — die test moet gewoon blijven slagen", () => {
    // `src/test/year-close-coupling.test.ts` pint de acht schrijvers en hun
    // identieke toets. Zou PR A daar iets aan veranderd hebben, dan viel die
    // test om. Hier alleen vastgelegd dat hij nog bestaat, zodat een latere PR
    // hem niet ongemerkt kan weghalen.
    expect(changed).not.toContain("src/test/year-close-coupling.test.ts");
  });

  it("20. de app leest de nieuwe tabel nog niet, en de gegenereerde types zijn niet bijgewerkt", () => {
    // PR A is fundering. Frontendgebruik komt in PR F.
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });
});
