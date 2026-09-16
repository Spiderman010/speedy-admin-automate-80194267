import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b6 (PR 1) — memoriaalboekingen (manual journal writer): schema + writer.
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. De semantiek (balans, idempotentie, rollback, rechten,
 * onveranderlijkheid, claimtrigger en gelijktijdigheid) is bewezen met echte
 * PostgreSQL-probes op een wegwerpcluster; zie de PR. Dit bestand leest
 * uitsluitend de migratie — geen cross-file greps van src/.
 */

const MIGRATION = "supabase/migrations/20260918120000_add_manual_journal_posting.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const OWN_FUNCTIONS = [
  "enforce_manual_journal_client_org",
  "set_manual_journal_line_org",
  "save_manual_journal_lines",
  "post_manual_journal",
  "enforce_manual_journal_source_claim",
  "prevent_posted_manual_journal_mutation",
  "prevent_posted_manual_journal_line_mutation",
];
const TRIGGER_FUNCTIONS = OWN_FUNCTIONS.filter((f) => !["save_manual_journal_lines", "post_manual_journal"].includes(f));

/** Alleen de functie-body: van CREATE OR REPLACE tot en met de afsluitende $$; */
function body(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}

const saveFn = body("save_manual_journal_lines");
const postFn = body("post_manual_journal");
const claimFn = body("enforce_manual_journal_source_claim");
const headerGuard = body("prevent_posted_manual_journal_mutation");
const lineGuard = body("prevent_posted_manual_journal_line_mutation");
const lineOrgFn = body("set_manual_journal_line_org");
const clientOrgFn = body("enforce_manual_journal_client_org");

const headerTable = sql.slice(
  sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journals ("),
  sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journals (")),
);
const linesTable = sql.slice(
  sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journal_lines ("),
  sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journal_lines (")),
);
const markerTable = sql.slice(
  sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journal_postings ("),
  sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journal_postings (")),
);

describe("Migratie — voorwaardenguard", () => {
  it("1. weigert te draaien zolang 6C-b2 en de rollenladder niet zijn toegepast, vóór het eerste object", () => {
    const guard = sql.slice(0, sql.indexOf("CREATE TABLE IF NOT EXISTS public.manual_journals"));
    expect(guard).toMatch(/to_regclass\('public\.ledger_postings'\) IS NULL/);
    expect(guard).toMatch(/to_regprocedure\('public\.posting_account_ok\(uuid,uuid,uuid\)'\) IS NULL/);
    expect(guard).toMatch(/to_regprocedure\('public\.posting_client_org_ok\(uuid,uuid\)'\) IS NULL/);
    expect(guard).toMatch(/to_regprocedure\('public\.has_min_role\(uuid,uuid,public\.app_role\)'\) IS NULL/);
    expect(guard).toMatch(/column_name = 'afgesloten_boekjaar'/);
    expect((guard.match(/RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst/g) ?? []).length).toBe(5);
  });
});

describe("Migratie — brontabellen", () => {
  it("2. maakt precies de drie tabellen, allemaal IF NOT EXISTS", () => {
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
    expect(tables).toEqual(["manual_journals", "manual_journal_lines", "manual_journal_postings"]);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it("3. kop: NOT NULL-set, nullable omschrijving/referentie, en posting_date binnen 2000..2100", () => {
    for (const col of ["organization_id", "client_id", "user_id"]) {
      expect(headerTable).toMatch(new RegExp(`${col}\\s+uuid\\s+NOT NULL`));
    }
    expect(headerTable).toMatch(/posting_date\s+date\s+NOT NULL/);
    expect(headerTable).toMatch(/CONSTRAINT manual_journals_posting_date_check\s+CHECK \(posting_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'\)/);
    expect(headerTable).toMatch(/description\s+text\s+NULL/);
    expect(headerTable).toMatch(/reference\s+text\s+NULL/);
    expect(headerTable).toMatch(/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    expect(headerTable).toMatch(/updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("4. regels: vier CHECKs (>= 0 ×2, één zijde, geen NaN), géén dode two_decimals-CHECK, numeric(12,2), nooit float/money, sort_order DEFAULT 0 en niet uniek", () => {
    expect(linesTable).toMatch(/CONSTRAINT manual_journal_lines_debit_amount_check\s+CHECK \(debit_amount >= 0\)/);
    expect(linesTable).toMatch(/CONSTRAINT manual_journal_lines_credit_amount_check\s+CHECK \(credit_amount >= 0\)/);
    expect(linesTable).toMatch(/CONSTRAINT manual_journal_lines_single_side_check\s+CHECK \(debit_amount = 0 OR credit_amount = 0\)/);
    // NaN: ">= 0", "= 0 OR", "= round(x, 2)" en zelfs "<>" in de balanscheck laten NaN door; alleen "x <> 'NaN'" is FALSE voor NaN.
    expect(linesTable).toMatch(/CONSTRAINT manual_journal_lines_no_nan_check\s+CHECK \(debit_amount <> 'NaN'::numeric AND credit_amount <> 'NaN'::numeric\)/);
    // De numeric(12,2)-typmod rondt vóór de CHECK af, dus een "x = round(x, 2)"-CHECK kan nooit falen: bewust afwezig.
    expect(sql).not.toMatch(/two_decimals_check/);
    expect(linesTable).not.toMatch(/round\(/);
    expect((linesTable.match(/CONSTRAINT manual_journal_lines_\w+_check/g) ?? []).length).toBe(4);
    expect(linesTable).toMatch(/debit_amount\s+numeric\(12,2\) NOT NULL DEFAULT 0/);
    expect(linesTable).toMatch(/credit_amount\s+numeric\(12,2\) NOT NULL DEFAULT 0/);
    expect(sql).not.toMatch(/\b(float|float4|float8|double precision|real|money)\b/i);
    expect(linesTable).toMatch(/sort_order\s+integer\s+NOT NULL DEFAULT 0/);
    expect(linesTable).not.toMatch(/sort_order[^\n]*UNIQUE/);
    expect(sql).not.toMatch(/UNIQUE[^\n]*sort_order/);
    expect(linesTable).toMatch(/grootboekrekening_id\s+uuid\s+NULL/);
    expect(linesTable).toMatch(/manual_journal_id\s+uuid\s+NOT NULL/);
    expect(linesTable).toMatch(/organization_id\s+uuid\s+NOT NULL/);
    expect(linesTable).toMatch(/user_id\s+uuid\s+NOT NULL/);
  });

  it("5. kop en regels hebben geen status-, boekjaar-, valuta-, btw-, nummer- of tegenboekingskolommen", () => {
    for (const t of [headerTable, linesTable]) {
      expect(t).not.toMatch(/\b(status|boekjaar|currency|btw\w*|journal_number|number|reversal\w*|posting_group_id)\b/);
    }
  });

  it("6. claimtabel: journal-id als PK, unieke groep, CHECKs op regelaantal en totaal", () => {
    expect(markerTable).toMatch(/manual_journal_id\s+uuid\s+PRIMARY KEY/);
    expect(markerTable).toMatch(/posting_group_id\s+uuid\s+NOT NULL UNIQUE/);
    expect(markerTable).toMatch(/CONSTRAINT manual_journal_postings_line_count_check\s+CHECK \(line_count >= 2\)/);
    expect(markerTable).toMatch(/CONSTRAINT manual_journal_postings_total_amount_check\s+CHECK \(total_amount > 0 AND total_amount <> 'NaN'::numeric\)/);
    for (const col of ["organization_id", "client_id", "user_id"]) {
      expect(markerTable).toMatch(new RegExp(`${col}\\s+uuid\\s+NOT NULL`));
    }
    expect(markerTable).toMatch(/posting_date\s+date\s+NOT NULL/);
  });

  it("7. verwijzingen: 10× ON DELETE RESTRICT, precies 1× CASCADE (regels → kop), nooit SET NULL, 11 pg_constraint-guards", () => {
    expect(sql.match(/ON DELETE RESTRICT/g) ?? []).toHaveLength(10);
    expect(sql.match(/ON DELETE CASCADE/g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
    expect(sql).toMatch(
      /ADD CONSTRAINT manual_journal_lines_manual_journal_id_fkey\s+FOREIGN KEY \(manual_journal_id\) REFERENCES public\.manual_journals \(id\)\s+ON DELETE CASCADE/,
    );
    expect(sql.match(/FROM pg_constraint c/g) ?? []).toHaveLength(11);
    for (const c of [
      "manual_journals_organization_id_fkey", "manual_journals_client_id_fkey", "manual_journals_user_id_fkey",
      "manual_journal_lines_manual_journal_id_fkey", "manual_journal_lines_organization_id_fkey",
      "manual_journal_lines_user_id_fkey", "manual_journal_lines_grootboekrekening_id_fkey",
      "manual_journal_postings_manual_journal_id_fkey", "manual_journal_postings_organization_id_fkey",
      "manual_journal_postings_client_id_fkey", "manual_journal_postings_user_id_fkey",
    ]) {
      expect(sql).toMatch(new RegExp(`ADD CONSTRAINT ${c}\\b`));
    }
    expect(sql).toMatch(/FOREIGN KEY \(grootboekrekening_id\) REFERENCES public\.grootboekrekeningen \(id\)\s+ON DELETE RESTRICT/);
  });

  it("8. heeft precies de negen indexen plus de partiële unieke index op ledger_postings", () => {
    const idx = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(new Set(idx)).toEqual(new Set([
      "idx_manual_journals_organization", "idx_manual_journals_client_posting_date", "idx_manual_journals_user_id",
      "idx_manual_journal_lines_journal", "idx_manual_journal_lines_organization",
      "idx_manual_journal_lines_grootboekrekening_id", "idx_manual_journal_lines_user_id",
      "idx_manual_journal_postings_organization", "idx_manual_journal_postings_client",
    ]));
    expect(idx).toHaveLength(9);
    expect(sql).toMatch(/idx_manual_journals_client_posting_date\s+ON public\.manual_journals \(client_id, posting_date DESC\)/);
    expect(sql).toMatch(/idx_manual_journal_lines_journal\s+ON public\.manual_journal_lines \(manual_journal_id, sort_order\)/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_manual_journal_line\s+ON public\.ledger_postings \(posting_group_id, source_line_id\)\s+WHERE source_type = 'manual_journal';/,
    );
    expect(sql.match(/CREATE UNIQUE INDEX/g) ?? []).toHaveLength(1);
  });
});

describe("Migratie — RLS, policies en rechten", () => {
  it("9. schakelt RLS in op alle drie de tabellen", () => {
    for (const t of ["manual_journals", "manual_journal_lines", "manual_journal_postings"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`));
    }
  });

  it("10. policies: exact negen, met de juiste drempels, user_id = auth.uid() op beide inserts, kop-delete accountant, regel-delete assistant", () => {
    const policies = [...sql.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)\s+FOR (\w+) TO authenticated/g)].map((m) => [m[1], m[2], m[3]].join("|"));
    expect(new Set(policies)).toEqual(new Set([
      "role_manual_journals_select|manual_journals|SELECT",
      "role_manual_journals_insert|manual_journals|INSERT",
      "role_manual_journals_update|manual_journals|UPDATE",
      "role_manual_journals_delete|manual_journals|DELETE",
      "role_manual_journal_lines_select|manual_journal_lines|SELECT",
      "role_manual_journal_lines_insert|manual_journal_lines|INSERT",
      "role_manual_journal_lines_update|manual_journal_lines|UPDATE",
      "role_manual_journal_lines_delete|manual_journal_lines|DELETE",
      "role_manual_journal_postings_select|manual_journal_postings|SELECT",
    ]));
    expect(policies).toHaveLength(9);
    expect(sql.match(/DROP POLICY IF EXISTS/g) ?? []).toHaveLength(9);
    for (const t of ["manual_journals", "manual_journal_lines", "manual_journal_postings"]) {
      expect(sql).toMatch(new RegExp(`role_${t}_select ON public\\.${t}\\s+FOR SELECT TO authenticated\\s+USING \\(public\\.has_min_role\\(auth\\.uid\\(\\), organization_id, 'read_only'\\)\\)`));
    }
    for (const t of ["manual_journals", "manual_journal_lines"]) {
      expect(sql).toMatch(new RegExp(
        `role_${t}_insert ON public\\.${t}\\s+FOR INSERT TO authenticated\\s+WITH CHECK \\(\\s+public\\.has_min_role\\(auth\\.uid\\(\\), organization_id, 'assistant'\\)\\s+AND user_id = auth\\.uid\\(\\)\\s+\\)`,
      ));
      expect(sql).toMatch(new RegExp(
        `role_${t}_update ON public\\.${t}\\s+FOR UPDATE TO authenticated\\s+USING\\s+\\(public\\.has_min_role\\(auth\\.uid\\(\\), organization_id, 'assistant'\\)\\)\\s+WITH CHECK \\(public\\.has_min_role\\(auth\\.uid\\(\\), organization_id, 'assistant'\\)\\)`,
      ));
    }
    expect(sql).toMatch(/role_manual_journals_delete ON public\.manual_journals\s+FOR DELETE TO authenticated\s+USING \(public\.has_min_role\(auth\.uid\(\), organization_id, 'accountant'\)\)/);
    expect(sql).toMatch(/role_manual_journal_lines_delete ON public\.manual_journal_lines\s+FOR DELETE TO authenticated\s+USING \(public\.has_min_role\(auth\.uid\(\), organization_id, 'assistant'\)\)/);
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*manual_journal_postings[^\n]*FOR (INSERT|UPDATE|DELETE)/);
  });

  it("11. rechten: volledige reset per tabel, exact de bedoelde grants, en exact de RPC-ACL's", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.manual_journal_postings FROM anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.manual_journal_postings TO authenticated, service_role;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.manual_journals, public\.manual_journal_lines FROM anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.manual_journals, public\.manual_journal_lines TO authenticated;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.manual_journals, public\.manual_journal_lines TO service_role;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.post_manual_journal\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_manual_journal\(uuid\) TO authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.save_manual_journal_lines\(uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.save_manual_journal_lines\(uuid, jsonb\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO (anon|service_role)/);
    expect(sql).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE)[^\n]*TO (anon|service_role)/);
  });
});

describe("Migratie — triggers op de brontabellen", () => {
  it("12. set_organization_id_trigger alleen op de kop, prevent_org_user_rebind_trg op beide, updated_at op de kop", () => {
    const setOrg = [...sql.matchAll(/CREATE TRIGGER set_organization_id_trigger\s+BEFORE INSERT ON public\.(\w+)/g)].map((m) => m[1]);
    expect(setOrg).toEqual(["manual_journals"]);
    const rebind = [...sql.matchAll(/CREATE TRIGGER prevent_org_user_rebind_trg\s+BEFORE UPDATE ON public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(rebind)).toEqual(new Set(["manual_journals", "manual_journal_lines"]));
    expect(sql).toMatch(/CREATE TRIGGER update_manual_journals_updated_at\s+BEFORE UPDATE ON public\.manual_journals\s+FOR EACH ROW EXECUTE FUNCTION public\.update_updated_at_column\(\);/);
    expect(sql).toMatch(/CREATE TRIGGER set_manual_journal_line_org_trigger\s+BEFORE INSERT OR UPDATE ON public\.manual_journal_lines/);
    expect(sql).not.toMatch(/set_organization_id_trigger\s+BEFORE INSERT ON public\.manual_journal_lines/);
  });

  it("13. validate_manual_journal_client_org_trigger vuurt bij UPDATE OF client_id, organization_id en gebruikt posting_client_org_ok", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER validate_manual_journal_client_org_trigger\s+BEFORE INSERT OR UPDATE OF client_id, organization_id ON public\.manual_journals\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_manual_journal_client_org\(\);/,
    );
    expect(clientOrgFn).toMatch(/IF NOT public\.posting_client_org_ok\(NEW\.client_id, NEW\.organization_id\) THEN/);
    expect(clientOrgFn).toMatch(/TG_OP = 'UPDATE'\s+AND NEW\.client_id IS DISTINCT FROM OLD\.client_id\s+AND EXISTS \(SELECT 1 FROM public\.manual_journal_lines WHERE manual_journal_id = OLD\.id\)/);
    expect(clientOrgFn).toMatch(/verwijder eerst de regels/);
  });

  it("14. set_manual_journal_line_org neemt organization_id van de kop over en weigert een gewijzigde manual_journal_id", () => {
    expect(lineOrgFn).toMatch(/SELECT organization_id INTO v_org\s+FROM public\.manual_journals\s+WHERE id = NEW\.manual_journal_id;/);
    expect(lineOrgFn).toMatch(/Memoriaalboeking niet gevonden voor deze regel' USING ERRCODE = '23503'/);
    expect(lineOrgFn).toMatch(/TG_OP = 'UPDATE' AND NEW\.manual_journal_id IS DISTINCT FROM OLD\.manual_journal_id/);
    expect(lineOrgFn).toMatch(/manual_journal_id kan niet worden gewijzigd' USING ERRCODE = '23514'/);
    expect(lineOrgFn).toMatch(/NEW\.organization_id := v_org;/);
  });

  it("15. maakt precies negen triggers (5 kop + 3 regels + 1 grootboek), elk met DROP IF EXISTS ervoor", () => {
    const created = [...sql.matchAll(/CREATE TRIGGER (\w+)\s+[^;]*? ON public\.(\w+)/g)].map((m) => `${m[2]}.${m[1]}`);
    expect(new Set(created)).toEqual(new Set([
      "manual_journals.set_organization_id_trigger",
      "manual_journals.validate_manual_journal_client_org_trigger",
      "manual_journals.prevent_org_user_rebind_trg",
      "manual_journals.update_manual_journals_updated_at",
      "manual_journals.prevent_posted_manual_journal_mutation_trigger",
      "manual_journal_lines.set_manual_journal_line_org_trigger",
      "manual_journal_lines.prevent_org_user_rebind_trg",
      "manual_journal_lines.prevent_posted_manual_journal_line_mutation_trigger",
      "ledger_postings.validate_manual_journal_source_claim_trigger",
    ]));
    expect(created).toHaveLength(9);
    expect(sql.match(/DROP TRIGGER IF EXISTS/g) ?? []).toHaveLength(9);
  });
});

describe("Migratie — save_manual_journal_lines", () => {
  it("16. is SECURITY INVOKER met vast search_path en grendelt de kop FOR UPDATE vóór de DELETE", () => {
    expect(saveFn.slice(0, 300)).toMatch(/RETURNS void/);
    expect(saveFn.slice(0, 300)).toMatch(/SECURITY INVOKER/);
    expect(saveFn.slice(0, 300)).toMatch(/SET search_path = public/);
    const lock = saveFn.search(/FROM public\.manual_journals\s+WHERE id = _journal_id\s+FOR UPDATE;/);
    const del = saveFn.indexOf("DELETE FROM public.manual_journal_lines");
    const ins = saveFn.indexOf("INSERT INTO public.manual_journal_lines");
    expect(lock).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(lock);
    expect(ins).toBeGreaterThan(del);
    expect(saveFn).toMatch(/Memoriaalboeking niet gevonden' USING ERRCODE = 'P0002'/);
  });

  it("17. weigert op een marker, eist een JSON-array, en valideert bedragen (NaN eerst, geen negatief, één zijde, twee decimalen vóór de cast)", () => {
    expect(saveFn).toMatch(/IF EXISTS \(SELECT 1 FROM public\.manual_journal_postings WHERE manual_journal_id = _journal_id\) THEN\s+RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; regels kunnen niet meer worden gewijzigd'\s+USING ERRCODE = '42501'/);
    expect(saveFn).toMatch(/jsonb_typeof\(_lines\) <> 'array'/);
    // NaN-weigering per element, vóór elke andere bedragcontrole (NaN < 0 is FALSE, NaN > 0 is TRUE, NaN = round(NaN) is TRUE).
    const nan = saveFn.search(/IF v_debit = 'NaN'::numeric OR v_credit = 'NaN'::numeric THEN\s+RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023'/);
    const negative = saveFn.search(/IF v_debit < 0 OR v_credit < 0 THEN/);
    const bothSides = saveFn.search(/IF v_debit > 0 AND v_credit > 0 THEN/);
    const decimals = saveFn.search(/IF v_debit <> round\(v_debit, 2\) OR v_credit <> round\(v_credit, 2\) THEN/);
    const insert = saveFn.indexOf("INSERT INTO public.manual_journal_lines");
    expect(nan).toBeGreaterThan(-1);
    expect(negative).toBeGreaterThan(nan);
    expect(bothSides).toBeGreaterThan(negative);
    expect(decimals).toBeGreaterThan(bothSides);
    expect(insert).toBeGreaterThan(decimals);
    expect(saveFn).toMatch(/Bedragen mogen maximaal twee decimalen hebben/);
    // De decimalencheck is het ENIGE pad dat >2 decimalen weigert: hij werkt op een ONGEBONDEN numeric-variabele,
    // vóór de cast naar numeric(12,2) bij de INSERT (een numeric(12,2)-variabele zou 0.005 al tot 0.01 hebben afgerond).
    expect(saveFn).toMatch(/v_debit\s+numeric;/);
    expect(saveFn).toMatch(/v_credit\s+numeric;/);
    expect(saveFn).not.toMatch(/v_(debit|credit)\s+numeric\(/);
    expect(saveFn).toMatch(/IF v_uid IS NULL THEN\s+RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000'/);
    // user_id = de aanroeper; organization_id wordt door de regeltrigger gezet, niet hier.
    expect(saveFn).toMatch(/INSERT INTO public\.manual_journal_lines \(\s+manual_journal_id, user_id, sort_order, grootboekrekening_id, omschrijving,\s+debit_amount, credit_amount\s+\)/);
    // omschrijving: whitespace-bewust genormaliseerd (tabs/newlines tellen als leeg), niet alleen spaties.
    expect(saveFn).toMatch(/NULLIF\(btrim\(COALESCE\(elem->>'omschrijving', ''\), E' \\t\\r\\n'\), ''\)/);
    expect(saveFn).not.toMatch(/btrim\([^,()]*\)/);
  });
});

describe("Migratie — post_manual_journal", () => {
  it("18. accepteert uitsluitend de journal-id, is SECURITY DEFINER met vast search_path, en eist accountant", () => {
    const signature = /CREATE OR REPLACE FUNCTION public\.post_manual_journal\(([^)]*)\)/.exec(sql);
    expect((signature as RegExpExecArray)[1].trim()).toBe("_journal_id uuid");
    expect(postFn.slice(0, 300)).toMatch(/RETURNS uuid/);
    expect(postFn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(postFn.slice(0, 300)).toMatch(/SET search_path = public/);
    expect(postFn).toMatch(/v_journal\.organization_id IS NULL\s+OR NOT public\.has_min_role\(v_uid, v_journal\.organization_id, 'accountant'\)/);
    expect(postFn).not.toMatch(/has_min_role\([^)]*'assistant'\)/);
    expect(postFn).toMatch(/accountant vereist/);
    expect(postFn).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    // Authenticatie is de EERSTE check, vóór de grendel.
    expect(postFn.indexOf("IF v_uid IS NULL THEN")).toBeLessThan(postFn.indexOf("FOR UPDATE"));
    expect(postFn).toMatch(/IF v_uid IS NULL THEN\s+RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000'/);
    expect(postFn).not.toMatch(/created_xact_id/);
  });

  it("19. volgt de grendelvolgorde: kop FOR UPDATE → afgesloten boekjaar → regels FOR UPDATE → scope → claim → grootboek", () => {
    const headerLock = postFn.search(/FROM public\.manual_journals\s+WHERE id = _journal_id\s+FOR UPDATE;/);
    const closedYear = postFn.indexOf("afgesloten_boekjaar");
    const linesLock = postFn.search(/FROM public\.manual_journal_lines\s+WHERE manual_journal_id = v_journal\.id\s+ORDER BY sort_order, id\s+FOR UPDATE;/);
    const scope = postFn.indexOf("posting_account_ok");
    const claim = postFn.indexOf("INSERT INTO public.manual_journal_postings");
    const ledger = postFn.indexOf("INSERT INTO public.ledger_postings");
    expect(headerLock).toBeGreaterThan(-1);
    expect(closedYear).toBeGreaterThan(headerLock);
    expect(linesLock).toBeGreaterThan(closedYear);
    expect(scope).toBeGreaterThan(linesLock);
    expect(claim).toBeGreaterThan(scope);
    expect(ledger).toBeGreaterThan(claim);
    expect(postFn.match(/INSERT INTO public\.ledger_postings/g) ?? []).toHaveLength(1);
  });

  it("20. claimt via de primary key: EXCEPTION WHEN unique_violation → 23505, zonder EXISTS-voorcontrole", () => {
    expect(postFn).toMatch(/EXCEPTION WHEN unique_violation THEN\s+RAISE EXCEPTION 'Deze memoriaalboeking is al geboekt' USING ERRCODE = '23505'/);
    expect(postFn).not.toMatch(/FROM public\.manual_journal_postings/);
    expect(postFn).toMatch(
      /INSERT INTO public\.manual_journal_postings \(\s+manual_journal_id, posting_group_id, organization_id, client_id, user_id,\s+posting_date, line_count, total_amount\s+\)/,
    );
    expect(postFn).toMatch(/v_journal\.posting_date, v_line_count, v_sum_debit\s+\)/);
  });

  it("21. balanceert exact (<>), zonder tolerantie of afronding, minimaal twee regels en géén bovengrens", () => {
    expect(postFn).toMatch(/IF v_sum_debit <> v_sum_credit THEN/);
    expect(postFn).toMatch(/Memoriaalboeking is niet in balans: debet % is ongelijk aan credit %/);
    expect(postFn).not.toMatch(/abs\(|tolerance|0\.01|0\.001|LEAST\(|GREATEST\(/i);
    expect(postFn).not.toMatch(/round\(v_sum/);
    expect(postFn).toMatch(/IF v_line_count < 2 THEN/);
    expect(postFn).toMatch(/minimaal twee regels/);
    expect(postFn).not.toMatch(/v_line_count >/);
    expect(postFn).toMatch(/IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN/);
  });

  it("22. weigert regels zonder rekening, zonder bedrag, tweezijdig, negatief, NaN (vóór de balanscheck), met >2 decimalen of van een andere organisatie", () => {
    expect(postFn).toMatch(/COUNT\(\*\) FILTER \(WHERE l\.grootboekrekening_id IS NULL\)/);
    expect(postFn).toMatch(/COUNT\(\*\) FILTER \(WHERE l\.debit_amount = 0 AND l\.credit_amount = 0\)/);
    expect(postFn).toMatch(/COUNT\(\*\) FILTER \(WHERE l\.debit_amount > 0 AND l\.credit_amount > 0\)/);
    expect(postFn).toMatch(/COUNT\(\*\) FILTER \(WHERE l\.debit_amount < 0 OR l\.credit_amount < 0\)/);
    // NaN passeert de nul-, zijde-, negatief- en decimalenfilters én de balanscheck (NaN = NaN is TRUE): eigen filter, eigen weigering.
    expect(postFn).toMatch(/COUNT\(\*\) FILTER \(WHERE l\.debit_amount = 'NaN'::numeric OR l\.credit_amount = 'NaN'::numeric\)/);
    expect(postFn).toMatch(/v_nan\s+integer;/);
    const nanRefusal = postFn.search(/IF v_nan > 0 THEN\s+RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023'/);
    const balance = postFn.indexOf("IF v_sum_debit <> v_sum_credit THEN");
    expect(nanRefusal).toBeGreaterThan(-1);
    expect(nanRefusal).toBeLessThan(balance);
    // Decimalenfilter blijft (onbereikbaar via de numeric(12,2)-typmod; de writer leunt niet op een typmod die hij niet bezit).
    expect(postFn).toMatch(/l\.debit_amount <> round\(l\.debit_amount, 2\)\s+OR l\.credit_amount <> round\(l\.credit_amount, 2\)/);
    expect(postFn).toMatch(/l\.organization_id IS DISTINCT FROM v_journal\.organization_id/);
    expect(postFn).toMatch(/% regel\(s\) zonder grootboekrekening; boeken is niet mogelijk/);
    expect(postFn).toMatch(/% regel\(s\) zonder bedrag; boeken is niet mogelijk/);
    expect(postFn).toMatch(/Een regel kan niet tegelijk debet en credit zijn/);
    expect(postFn).toMatch(/Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde/);
    expect(postFn).toMatch(/Bedragen mogen maximaal twee decimalen hebben/);
    expect(postFn).toMatch(/Een regel hoort bij een andere organisatie dan de memoriaalboeking/);
  });

  it("23. eist scope (posting_account_ok) en actieve rekeningen; verzint nooit een rekening", () => {
    expect(postFn).toMatch(/NOT public\.posting_account_ok\(l\.grootboekrekening_id, v_journal\.organization_id, v_journal\.client_id\)/);
    expect(postFn).toMatch(/% regel\(s\) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie/);
    expect(postFn).toMatch(/JOIN public\.grootboekrekeningen g ON g\.id = l\.grootboekrekening_id[\s\S]*?AND NOT g\.actief/);
    expect(postFn).toMatch(/Een regel verwijst naar een niet-actieve grootboekrekening \(%\)/);
    expect(sql).not.toMatch(/\b(1100|1300|1600|1799|4000|8000)\b/);
    expect(sql).not.toMatch(/btw_te_(vorderen|betalen)_rekening_id|clients\.btw_/);
    expect(sql).not.toMatch(/bank_rekening_id|debiteuren_rekening_id|crediteuren_rekening_id/);
  });

  it("24. schrijft één grootboekregel per memoriaalregel, zoals opgeslagen, in EUR, met source_line_id = regel-id", () => {
    expect(postFn).toMatch(/FOR v_line IN\s+SELECT id, grootboekrekening_id, debit_amount, credit_amount, omschrijving\s+FROM public\.manual_journal_lines\s+WHERE manual_journal_id = v_journal\.id\s+ORDER BY sort_order, id\s+LOOP/);
    expect(postFn).toMatch(/v_journal\.posting_date, v_boekjaar, v_line\.debit_amount, v_line\.credit_amount, 'EUR',/);
    // Whitespace-bewuste fallback: een omschrijving van alleen tabs/newlines valt terug op de kop.
    expect(postFn).toMatch(/COALESCE\(NULLIF\(btrim\(v_line\.omschrijving, E' \\t\\r\\n'\), ''\), v_journal\.description\),\s+'manual_journal', v_journal\.id, v_line\.id, v_uid/);
    expect(postFn).not.toMatch(/btrim\([^,()]*\)/);
    expect(postFn).not.toMatch(/, NULL, v_uid/);
    expect(postFn).not.toMatch(/reversal_of_posting_id/);
    expect(postFn).toMatch(/EXTRACT\(YEAR FROM v_journal\.posting_date\)/);
    expect(postFn).toMatch(/v_boekjaar <= v_client\.afgesloten_boekjaar/);
    expect(postFn).toMatch(/Boekjaar % is afgesloten voor deze administratie/);
    expect(postFn).not.toMatch(/now\(\)|current_date/i);
  });

  it("25. eist een omschrijving (whitespace-bewust: tabs/newlines tellen als leeg) en een administratie binnen de organisatie", () => {
    expect(postFn).toMatch(/v_journal\.description IS NULL OR btrim\(v_journal\.description, E' \\t\\r\\n'\) = ''/);
    expect(postFn).toMatch(/Memoriaalboeking heeft geen omschrijving; boeken is niet mogelijk/);
    expect(postFn).toMatch(/IF NOT FOUND OR v_client\.organization_id IS DISTINCT FROM v_journal\.organization_id THEN/);
    expect(postFn).toMatch(/Administratie hoort niet bij de organisatie van deze memoriaalboeking/);
  });
});

describe("Migratie — bronidempotentie op ledger_postings zelf", () => {
  it("26. bewaakt memoriaalregels rechtstreeks op ledger_postings, BEFORE INSERT, strikt beperkt tot manual_journal", () => {
    expect(sql).toMatch(/CREATE TRIGGER validate_manual_journal_source_claim_trigger\s+BEFORE INSERT ON public\.ledger_postings\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_manual_journal_source_claim\(\);/);
    expect(claimFn).toMatch(/IF NEW\.source_type <> 'manual_journal' THEN\s+RETURN NEW;/);
    expect(claimFn).not.toMatch(/'sales_invoice'|'purchase_invoice'|'bank_allocation'/);
  });

  it("27. controleert marker, groep, organisatie/administratie, datum, regelnummer, tegenboeking en de bevroren regel", () => {
    expect(claimFn).toMatch(/NEW\.source_id IS NULL/);
    expect(claimFn).toMatch(/FROM public\.manual_journal_postings\s+WHERE manual_journal_id = NEW\.source_id/);
    expect(claimFn).toMatch(/niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan/);
    expect(claimFn).toMatch(/NEW\.posting_group_id <> v_marker\.posting_group_id[\s\S]*?USING ERRCODE = '23505'/);
    expect(claimFn).toMatch(/NEW\.organization_id IS DISTINCT FROM v_marker\.organization_id\s+OR NEW\.client_id IS DISTINCT FROM v_marker\.client_id/);
    expect(claimFn).toMatch(/NEW\.posting_date <> v_marker\.posting_date/);
    expect(claimFn).toMatch(/NEW\.line_no < 1 OR NEW\.line_no > v_marker\.line_count/);
    expect(claimFn).toMatch(/NEW\.reversal_of_posting_id IS NOT NULL THEN\s+RAISE EXCEPTION 'Een tegenboeking gebruikt een eigen bronsoort'/);
    expect(claimFn).toMatch(/NEW\.source_line_id IS NULL/);
    expect(claimFn).toMatch(/FROM public\.manual_journal_lines\s+WHERE id = NEW\.source_line_id\s+AND manual_journal_id = NEW\.source_id;/);
    expect(claimFn).toMatch(/source_line_id hoort niet bij deze memoriaalboeking/);
    expect(claimFn).toMatch(/NEW\.grootboekrekening_id <> v_line\.grootboekrekening_id\s+OR NEW\.debit_amount <> v_line\.debit_amount\s+OR NEW\.credit_amount <> v_line\.credit_amount/);
    expect(claimFn).toMatch(/Grootboekregel wijkt af van de bevroren memoriaalregel/);
  });
});

describe("Migratie — geboekte memoriaalboeking is bevroren", () => {
  it("28. kop: expliciete TG_OP-takken, exact zeven bevroren velden, DELETE geweigerd, id-verplaatsing geweigerd, nooit COALESCE(NEW", () => {
    expect(sql).toMatch(/CREATE TRIGGER prevent_posted_manual_journal_mutation_trigger\s+BEFORE UPDATE OR DELETE ON public\.manual_journals/);
    expect(headerGuard).toMatch(/IF TG_OP = 'DELETE' THEN/);
    expect(headerGuard).toMatch(/RETURN OLD;/);
    expect(headerGuard).not.toMatch(/COALESCE\(NEW/);
    const frozen = [...headerGuard.matchAll(/NEW\.(\w+)\s+IS DISTINCT FROM OLD\.\1/g)].map((m) => m[1]);
    expect(new Set(frozen)).toEqual(new Set(["id", "organization_id", "client_id", "user_id", "posting_date", "description", "reference"]));
    expect(frozen).toHaveLength(8); // zeven in de freeze + de losse NEW.id-verplaatsingscheck
    expect(headerGuard).not.toMatch(/NEW\.(created_at|updated_at)/);
    expect(headerGuard).toMatch(/IF NEW\.id IS DISTINCT FROM OLD\.id AND EXISTS \(\s+SELECT 1 FROM public\.manual_journal_postings WHERE manual_journal_id = NEW\.id/);
    expect(headerGuard).toMatch(/verwijderen is niet mogelijk\. Een correctie vereist een tegenboeking\./);
    expect(headerGuard).toMatch(/boekhoudkundige gegevens kunnen niet meer worden gewijzigd\. Een correctie vereist een tegenboeking\./);
    expect((headerGuard.match(/USING ERRCODE = '42501'/g) ?? []).length).toBe(3);
  });

  it("29. regels: INSERT/UPDATE tegen NEW, UPDATE/DELETE tegen OLD, RETURN OLD bij DELETE, KEY SHARE op de kop vóór de markercheck", () => {
    expect(sql).toMatch(/CREATE TRIGGER prevent_posted_manual_journal_line_mutation_trigger\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.manual_journal_lines/);
    expect(lineGuard).toMatch(/TG_OP IN \('INSERT', 'UPDATE'\) AND EXISTS \(\s+SELECT 1 FROM public\.manual_journal_postings\s+WHERE manual_journal_id = NEW\.manual_journal_id/);
    expect(lineGuard).toMatch(/TG_OP IN \('UPDATE', 'DELETE'\) AND EXISTS \(\s+SELECT 1 FROM public\.manual_journal_postings\s+WHERE manual_journal_id = OLD\.manual_journal_id/);
    expect(lineGuard).toMatch(/IF TG_OP = 'DELETE' THEN\s+RETURN OLD;/);
    expect(lineGuard).not.toMatch(/COALESCE\(NEW/);
    const keyShare = lineGuard.search(/IF TG_OP = 'INSERT' THEN\s+PERFORM 1 FROM public\.manual_journals WHERE id = NEW\.manual_journal_id FOR KEY SHARE;/);
    expect(keyShare).toBeGreaterThan(-1);
    expect(keyShare).toBeLessThan(lineGuard.indexOf("manual_journal_postings"));
    expect(lineGuard).toMatch(/regels kunnen niet meer worden gewijzigd\. Een correctie vereist een tegenboeking\./);
    expect((lineGuard.match(/USING ERRCODE = '42501'/g) ?? []).length).toBe(2);
  });
});

describe("Migratie — scope en veiligheid", () => {
  it("30. alle triggerfuncties: SECURITY DEFINER, vast search_path, REVOKE FROM PUBLIC, en geen auth.uid()/has_min_role erin", () => {
    for (const f of TRIGGER_FUNCTIONS) {
      const b = body(f);
      expect(b.slice(0, 250), f).toMatch(/RETURNS trigger/);
      expect(b.slice(0, 250), f).toMatch(/SECURITY DEFINER/);
      expect(b.slice(0, 250), f).toMatch(/SET search_path = public/);
      expect(b, f).not.toMatch(/auth\.uid\(\)|has_min_role/);
      expect(sql, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(\\)\\s+FROM PUBLIC;`));
    }
  });

  it("31. definieert precies de zeven eigen functies en herdefinieert geen bestaande", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fns)).toEqual(new Set(OWN_FUNCTIONS));
    expect(fns).toHaveLength(7);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(has_min_role|posting_account_ok|posting_client_org_ok|set_organization_id|prevent_org_user_rebind|update_updated_at_column|ledger_link_org_ok|post_purchase_invoice|post_sales_invoice|post_bank_allocation|enforce_(purchase|sales|bank)_source_claim|replace_purchase_invoice_lines|save_purchase_invoice_with_lines)\(/,
    );
  });

  it("32. raakt alleen de drie nieuwe tabellen aan; ledger_postings alleen via DROP/CREATE TRIGGER, de partiële index en de INSERT in de writer", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["manual_journals", "manual_journal_lines", "manual_journal_postings"]));
    const ledgerLines = sql.split("\n").filter((l) => /public\.ledger_postings/.test(l));
    for (const l of ledgerLines) {
      expect(l).toMatch(
        /DROP TRIGGER IF EXISTS \w+ ON public\.ledger_postings;|BEFORE INSERT ON public\.ledger_postings|ON public\.ledger_postings \(posting_group_id, source_line_id\)|INSERT INTO public\.ledger_postings \(|to_regclass\('public\.ledger_postings'\)|Migratie 6C-b6 vereist eerst/,
      );
    }
    expect(sql).not.toMatch(/journal_entries/);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/);
    expect(sql).not.toMatch(/^\s*UPDATE public\.(ledger_postings|manual_journal\w*|clients|grootboekrekeningen)/m);
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings[\s\S]{0,200}SELECT[\s\S]{0,200}FROM public\.manual_journal/);
    expect(sql).not.toMatch(/AFTER INSERT ON public\.manual_journal/);
  });

  it("33. is idempotent herhaalbaar", () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).toHaveLength(3);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).toMatch(/FROM pg_constraint c/);
    expect(sql).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE FUNCTION/);
    for (const m of sql.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)/g)) {
      expect(sql.indexOf(`DROP POLICY IF EXISTS ${m[1]} ON public.${m[2]};`), m[1]).toBeGreaterThan(-1);
      expect(sql.indexOf(`DROP POLICY IF EXISTS ${m[1]} ON public.${m[2]};`), m[1]).toBeLessThan(m.index as number);
    }
  });

  it("34. documenteert een volledige rollback die elk object noemt", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    for (const f of ["prevent_posted_manual_journal_line_mutation()", "prevent_posted_manual_journal_mutation()",
      "enforce_manual_journal_source_claim()", "post_manual_journal(uuid)", "save_manual_journal_lines(uuid, jsonb)",
      "set_manual_journal_line_org()", "enforce_manual_journal_client_org()"]) {
      expect(raw).toContain(`DROP FUNCTION IF EXISTS public.${f};`);
    }
    for (const t of [
      "validate_manual_journal_source_claim_trigger ON public.ledger_postings",
      "set_manual_journal_line_org_trigger ON public.manual_journal_lines",
      "prevent_org_user_rebind_trg ON public.manual_journal_lines",
      "prevent_posted_manual_journal_line_mutation_trigger ON public.manual_journal_lines",
      "prevent_posted_manual_journal_mutation_trigger ON public.manual_journals",
      "update_manual_journals_updated_at ON public.manual_journals",
      "prevent_org_user_rebind_trg ON public.manual_journals",
      "validate_manual_journal_client_org_trigger ON public.manual_journals",
      "set_organization_id_trigger ON public.manual_journals",
    ]) {
      expect(raw).toContain(`DROP TRIGGER IF EXISTS ${t};`);
    }
    for (const p of ["role_manual_journal_postings_select ON public.manual_journal_postings",
      "role_manual_journal_lines_delete ON public.manual_journal_lines", "role_manual_journal_lines_update ON public.manual_journal_lines",
      "role_manual_journal_lines_insert ON public.manual_journal_lines", "role_manual_journal_lines_select ON public.manual_journal_lines",
      "role_manual_journals_delete ON public.manual_journals", "role_manual_journals_update ON public.manual_journals",
      "role_manual_journals_insert ON public.manual_journals", "role_manual_journals_select ON public.manual_journals"]) {
      expect(raw).toContain(`DROP POLICY IF EXISTS ${p};`);
    }
    for (const i of ["idx_ledger_postings_manual_journal_line", "idx_manual_journal_postings_client", "idx_manual_journal_postings_organization",
      "idx_manual_journal_lines_user_id", "idx_manual_journal_lines_grootboekrekening_id", "idx_manual_journal_lines_organization",
      "idx_manual_journal_lines_journal", "idx_manual_journals_user_id", "idx_manual_journals_client_posting_date", "idx_manual_journals_organization"]) {
      expect(raw).toContain(`DROP INDEX IF EXISTS public.${i};`);
    }
    for (const t of ["manual_journal_postings", "manual_journal_lines", "manual_journals"]) {
      expect(raw).toContain(`DROP TABLE IF EXISTS public.${t};`);
    }
    // Omgekeerde volgorde: triggers → functies → policies → indexen → tabellen; regels vóór kop.
    const rb = raw.slice(raw.indexOf("-- rollback:"), raw.indexOf("-- ─", raw.indexOf("-- rollback:")));
    expect(rb.indexOf("DROP TRIGGER")).toBeLessThan(rb.indexOf("DROP FUNCTION"));
    expect(rb.indexOf("DROP FUNCTION")).toBeLessThan(rb.indexOf("DROP POLICY"));
    expect(rb.indexOf("DROP POLICY")).toBeLessThan(rb.indexOf("DROP INDEX"));
    expect(rb.indexOf("DROP INDEX")).toBeLessThan(rb.indexOf("DROP TABLE"));
    expect(rb.indexOf("DROP TABLE IF EXISTS public.manual_journal_lines")).toBeLessThan(rb.indexOf("DROP TABLE IF EXISTS public.manual_journals;"));
    // Voorwaarde: alleen veilig vóór de eerste boeking (ledger_postings is append-only; anders raken 'manual_journal'-rijen voorgoed wees).
    const pre = raw.slice(raw.indexOf("ROLLBACK PRECONDITION"), raw.indexOf("-- rollback:"));
    expect(pre).toMatch(/only safe BEFORE the first\s+--\s+posting/);
    expect(pre).toMatch(/append-only/);
    expect(pre).toMatch(/orphaned/);
    expect(pre).toMatch(/SELECT count\(\*\) FROM public\.ledger_postings WHERE source_type = 'manual_journal';/);
  });

  it("35. documenteert de boeking, de grendelvolgorde, de rollen, de bewuste uitzondering, de duurzame regel-id, beide 40P01-paden, decimalen en NaN eerlijk", () => {
    expect(raw).toMatch(/THE ENTRY/);
    expect(raw).toMatch(/LOCK ORDER/);
    expect(raw).toMatch(/NO BACKFILL/);
    expect(raw).toMatch(/NO UI/);
    expect(raw).toMatch(/POSTING FLOOR = accountant/);
    expect(raw).toMatch(/DOCUMENTED EXCEPTION — manual_journal_lines DELETE floor = assistant/);
    expect(raw).toMatch(/WHY source_line_id IS PERSISTED HERE/);
    expect(raw).toMatch(/WHY NEW TABLES, NOT journal_entries/);
    expect(raw).toMatch(/40P01/);
    // Beide handmatige deadlockpaden: (a) multi-row regelstatement in heapvolgorde, (b) één ruwe transactie UPDATE regel → INSERT regel
    // (regelgrendel vóór de kop-KEY SHARE in de freeze-trigger) tegen een poster die de kop houdt en op LOCK 2 wacht.
    expect(raw).toMatch(/Two paths CAN deadlock, both non-application/);
    expect(raw).toMatch(/\(a\) a raw MULTI-ROW line statement/);
    expect(raw).toMatch(/\(b\) a single raw TRANSACTION that first UPDATEs \(or DELETEs\) a line/);
    expect(raw).toMatch(/Line → header inverts the documented header → lines\s+--\s+order/);
    expect(raw).toMatch(/never an accounting\s+--\s+one/);
    expect(raw).toMatch(/never enters either cycle/);
    expect(raw).toMatch(/KEY SHARE/);
    // Decimalen en NaN eerlijk gedocumenteerd, inclusief de foundation-gap als follow-up buiten scope.
    expect(raw).toMatch(/DECIMALS — honest statement of who refuses what/);
    expect(raw).toMatch(/can never fail and is deliberately NOT declared/);
    expect(raw).toMatch(/NaN — 'NaN'::numeric is a legal numeric value/);
    expect(raw).toMatch(/public\.ledger_postings and the purchase\/sales\/bank marker tables have\s+--\s+the same gap at the foundation level/);
    expect(raw).toMatch(/unreachable through the numeric\(12,2\) typmod/);
    expect(raw).toMatch(/does not lean on a typmod it does not own/);
    expect(raw).toMatch(/VAT v1/);
    expect(raw).toMatch(/NUMBERING/);
    expect(raw).toMatch(/REVERSAL ENGINE/);
    expect(raw).toMatch(/A reversal is refused outright/);
  });
});
