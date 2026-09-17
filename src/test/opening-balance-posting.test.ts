import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b8 (PR 1) — beginbalans (opening balance writer): schema + writers.
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. De semantiek (balans, idempotentie, domeinuniciteit,
 * nihil-verklaring, bevriezing, claimtrigger, rechten en gelijktijdigheid) is
 * bewezen met échte PostgreSQL-probes op een wegwerpcluster — zie
 * supabase/tests/opening-balance/ en de PR. Dit bestand leest uitsluitend de
 * migratie; geen cross-file greps van src/.
 */

const MIGRATION = "supabase/migrations/20260919120000_add_opening_balance_posting.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
/** Commentaar weggestript: een bewering over de CODE mag nooit op proza slagen. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const OWN_FUNCTIONS = [
  "enforce_opening_balance_client_org",
  "set_opening_balance_line_scope",
  "enforce_opening_balance_marker_exclusivity",
  "opening_balance_client_lock_key",
  "save_opening_balance_lines",
  "post_opening_balance",
  "declare_opening_balance_nil",
  "enforce_opening_balance_source_claim",
  "prevent_settled_opening_balance_mutation",
  "prevent_settled_opening_balance_line_mutation",
];

function body(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}

function table(name: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("\n);", start));
}

const postFn = body("post_opening_balance");
const nilFn = body("declare_opening_balance_nil");
const saveFn = body("save_opening_balance_lines");
const claimFn = body("enforce_opening_balance_source_claim");
const headerGuard = body("prevent_settled_opening_balance_mutation");
const lineGuard = body("prevent_settled_opening_balance_line_mutation");
const lineScopeFn = body("set_opening_balance_line_scope");
const markerExclusivityFn = body("enforce_opening_balance_marker_exclusivity");

const headerTable = table("opening_balances");
const linesTable = table("opening_balance_lines");
const markerTable = table("opening_balance_postings");

describe("6C-b8 PR 1 — migratiebestand", () => {
  it("1. is één migratie met een expliciete rollbacksectie en de rollbackvoorwaarde", () => {
    expect(raw).toContain("-- rollback:");
    expect(raw).toContain("ROLLBACK PRECONDITION");
    expect(raw).toContain("SELECT count(*) FROM public.ledger_postings WHERE source_type = 'opening_balance';");
    // Elk object dat de migratie maakt, staat ook in de rollback.
    for (const t of ["opening_balances", "opening_balance_lines", "opening_balance_postings"]) {
      expect(raw).toContain(`--   DROP TABLE IF EXISTS public.${t};`);
    }
    for (const f of OWN_FUNCTIONS) {
      expect(raw, f).toMatch(new RegExp(`--\\s+DROP FUNCTION IF EXISTS public\\.${f}\\(`));
    }
  });

  it("2. weigert toepassing zonder de 6C-b2 fundering", () => {
    const guard = sql.slice(0, sql.indexOf("CREATE TABLE IF NOT EXISTS public.opening_balances"));
    expect(guard).toContain("to_regclass('public.ledger_postings') IS NULL");
    expect(guard).toContain("posting_account_ok(uuid,uuid,uuid)");
    expect(guard).toContain("posting_client_org_ok(uuid,uuid)");
    expect(guard).toContain("has_min_role(uuid,uuid,public.app_role)");
    expect(guard).toContain("column_name = 'afgesloten_boekjaar'");
  });

  it("3. raakt geen bestaande boekhoudtabel aan en boekt niets na", () => {
    expect(sql).not.toMatch(/journal_entries/);
    expect(sql).not.toMatch(/purchase_invoice|sales_invoice|bank_transaction|manual_journal/);
    expect(sql).not.toMatch(/ALTER TABLE public\.ledger_postings/);
    expect(sql).not.toMatch(/DROP TABLE/);
    // Elke DROP in dit bestand is een idempotente DROP van een eigen object.
    const drops = sql.match(/DROP (TABLE|FUNCTION|POLICY|TRIGGER|INDEX)[^\n;]*/g) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.filter((d) => !/opening_balance/.test(d))).toEqual([]);
    // Eén INSERT INTO ledger_postings, en die staat in de schrijver.
    const inserts = sql.match(/INSERT INTO public\.ledger_postings/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(postFn).toContain("INSERT INTO public.ledger_postings");
  });

  it("4. gebruikt alleen additieve DDL", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).not.toMatch(/TRUNCATE|DELETE FROM public\.ledger_postings|DROP COLUMN/);
  });
});

describe("6C-b8 PR 1 — kop, regels en claim", () => {
  it("5. de kop heeft geen muteerbare statuskolom", () => {
    expect(headerTable).not.toMatch(/\bstatus\b/);
    expect(headerTable).toContain("nil_declaration  boolean     NOT NULL DEFAULT false");
    expect(headerTable).toContain("nil_declared_at  timestamptz NULL");
    expect(headerTable).toContain("nil_declared_by  uuid        NULL");
  });

  it("6. boekjaar is het kalenderjaar van de openingsdatum (kalenderjaarmodel v1)", () => {
    expect(headerTable).toContain("CHECK (boekjaar = EXTRACT(YEAR FROM opening_date)::integer)");
    expect(postFn).toContain("EXTRACT(YEAR FROM v_header.opening_date)::integer");
  });

  it("7. de drie nihil-kolommen bewegen als één geheel", () => {
    expect(headerTable).toContain("opening_balances_nil_consistent_check");
    expect(headerTable).toMatch(/nil_declaration = true\s+AND nil_declared_at IS NOT NULL AND nil_declared_by IS NOT NULL/);
  });

  it("8. regels zijn eenzijdig, niet-negatief en niet NaN", () => {
    expect(linesTable).toContain("opening_balance_lines_single_side_check");
    expect(linesTable).toContain("CHECK (debit_amount = 0 OR credit_amount = 0)");
    expect(linesTable).toContain("CHECK (debit_amount >= 0)");
    expect(linesTable).toContain("CHECK (credit_amount >= 0)");
    expect(linesTable).toContain("opening_balance_lines_no_nan_check");
    expect(linesTable).toContain("numeric(12,2)");
    // Een concept mag onvolledig zijn: de rekening is nullable.
    expect(linesTable).toMatch(/grootboekrekening_id\s+uuid\s+NULL/);
  });

  it("9. de claim draagt de identiteit én de vorm van de boeking", () => {
    expect(markerTable).toContain("opening_balance_id  uuid          PRIMARY KEY");
    expect(markerTable).toContain("posting_group_id    uuid          NOT NULL UNIQUE");
    expect(markerTable).toContain("CHECK (line_count >= 2)");
    expect(markerTable).toContain("CHECK (total_amount > 0 AND total_amount <> 'NaN'::numeric)");
    for (const col of ["boekjaar", "opening_date", "client_id", "organization_id", "user_id"]) {
      expect(markerTable, col).toContain(col);
    }
  });

  it("10. alle FK's zijn RESTRICT, behalve de cascade van kop naar conceptregels", () => {
    const cascades = sql.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades).toHaveLength(1);
    expect(sql).toMatch(
      /opening_balance_lines_opening_balance_id_fkey[\s\S]{0,200}ON DELETE CASCADE/,
    );
    expect((sql.match(/ON DELETE RESTRICT/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

describe("6C-b8 PR 1 — domeinuniciteit: draft / geboekt / nihil", () => {
  it("11. hoogstens één geboekte beginbalans per administratie, via een LOSSE index", () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uniq_opening_balance_postings_client\n  ON public.opening_balance_postings (client_id);",
    );
    // Geen permanente primary key of constraint op client_id: die zou de
    // latere tegenboekingsfase blokkeren.
    expect(markerTable).not.toMatch(/client_id[^\n]*PRIMARY KEY/);
    expect(sql).not.toMatch(/ADD CONSTRAINT \w*postings_client_id_key/);
  });

  it("12. hoogstens één nihil-verklaring per administratie, via een PARTIËLE index", () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uniq_opening_balance_nil_per_client\n  ON public.opening_balances (client_id)\n  WHERE nil_declared_at IS NOT NULL;",
    );
  });

  it("13. de versoepeling voor een latere tegenboekingsfase staat uitgeschreven", () => {
    expect(raw).toContain("RELAXATION");
    expect(raw).toContain("ADD COLUMN IF NOT EXISTS reversed_at timestamptz NULL;");
    expect(raw).toContain("WHERE reversed_at IS NULL;");
  });

  it("14. geboekt en nihil sluiten elkaar uit, in beide richtingen", () => {
    expect(postFn).toContain("nil_declared_at IS NOT NULL");
    expect(postFn).toContain("Deze administratie heeft al een nihil-verklaring");
    expect(nilFn).toContain("opening_balance_postings");
    expect(nilFn).toContain("Deze administratie heeft al een geboekte beginbalans");
    // En als staande bewaking in BEIDE richtingen, ook voor een aanroeper die
    // geen enkel recht tegenhoudt (een eigenaar-statement in de SQL-editor).
    expect(markerExclusivityFn).toContain("nil_declared_at IS NOT NULL");
    expect(sql).toContain("CREATE TRIGGER validate_opening_balance_marker_exclusivity_trigger");
    expect(headerGuard).toContain("OLD.nil_declared_at IS NULL AND NEW.nil_declared_at IS NOT NULL");
    expect(headerGuard).toContain("WHERE obp.client_id = OLD.client_id");
  });

  it("15. beide beweringen nemen dezelfde advisory lock op de administratie", () => {
    for (const [name, fn] of [["post", postFn], ["nil", nilFn]] as const) {
      expect(fn, name).toContain(
        "PERFORM pg_advisory_xact_lock(6118, public.opening_balance_client_lock_key(v_header.client_id));",
      );
      // De grendel wordt genomen vóór de kop wordt gegrendeld (LOCK 0 → LOCK 1).
      expect(fn.indexOf("pg_advisory_xact_lock"), name).toBeLessThan(fn.indexOf("FOR UPDATE"));
    }
  });

  it("16. beide beweringen eisen READ COMMITTED", () => {
    for (const [name, fn] of [["post", postFn], ["nil", nilFn]] as const) {
      expect(fn, name).toContain("current_setting('transaction_isolation') <> 'read committed'");
      expect(fn.indexOf("transaction_isolation"), name).toBeLessThan(fn.indexOf("pg_advisory_xact_lock"));
    }
  });
});

describe("6C-b8 PR 1 — de boekingsfunctie", () => {
  it("17. is SECURITY DEFINER met een vast search_path en heeft alleen de id als invoer", () => {
    expect(postFn).toContain("SECURITY DEFINER");
    expect(postFn).toContain("SET search_path = public");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.post_opening_balance(_opening_balance_id uuid)");
    // Geen enkele andere parameter: bedragen, datum en rekeningen komen uit de rijen.
    expect(sql).not.toMatch(/post_opening_balance\(_opening_balance_id uuid,/);
  });

  it("18. weigert een anonieme aanroep vóór er iets wordt gelezen of gegrendeld", () => {
    const authIdx = postFn.indexOf("Niet ingelogd");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(postFn.indexOf("FROM public.opening_balances"));
    expect(nilFn.indexOf("Niet ingelogd")).toBeLessThan(nilFn.indexOf("FROM public.opening_balances"));
  });

  it("19. vereist de rol accountant, getoetst op de opgeslagen organisatie", () => {
    expect(postFn).toContain("has_min_role(v_uid, v_header.organization_id, 'accountant')");
    expect(nilFn).toContain("has_min_role(v_uid, v_header.organization_id, 'accountant')");
  });

  it("20. volgt de gedocumenteerde grendelvolgorde kop → regels → claim → grootboek", () => {
    const lock1 = postFn.indexOf("FROM public.opening_balances\n  WHERE id = _opening_balance_id\n  FOR UPDATE");
    const lock2 = postFn.indexOf("FROM public.opening_balance_lines\n  WHERE opening_balance_id = v_header.id\n  ORDER BY sort_order, id\n  FOR UPDATE");
    const claim = postFn.indexOf("INSERT INTO public.opening_balance_postings");
    const ledger = postFn.indexOf("INSERT INTO public.ledger_postings");
    expect(lock1).toBeGreaterThan(-1);
    expect(lock2).toBeGreaterThan(lock1);
    expect(claim).toBeGreaterThan(lock2);
    expect(ledger).toBeGreaterThan(claim);
  });

  it("21. weigert elke onbruikbare regel vóór de balanscontrole, NaN vooraan", () => {
    const nan = postFn.indexOf("Bedragen moeten getallen zijn");
    const balans = postFn.indexOf("Beginbalans is niet in balans");
    expect(nan).toBeGreaterThan(-1);
    expect(nan).toBeLessThan(balans);
    for (const needle of [
      "minimaal twee regels",
      "zonder grootboekrekening",
      "zonder bedrag",
      "tegelijk debet en credit",
      "Negatieve bedragen",
      "twee decimalen",
      "andere organisatie of administratie",
    ]) {
      expect(postFn, needle).toContain(needle);
    }
  });

  it("22. weigert een niet-sluitende beginbalans met debet, credit én verschil", () => {
    expect(postFn).toContain(
      "RAISE EXCEPTION 'Beginbalans is niet in balans: debet % is ongelijk aan credit % (verschil %)',\n      v_sum_debit, v_sum_credit, (v_sum_debit - v_sum_credit)",
    );
    expect(postFn).toContain("IF v_sum_debit <> v_sum_credit THEN");
  });

  it("23. balanceert nooit zelf: geen sluitpost, geen tussen- of vermogensrekening", () => {
    expect(sql).not.toMatch(/suspense|vraagpost|1799|2010|9998|eigen.?vermogen|equity/i);
    // De enige INSERT in het grootboek loopt over de opgeslagen regels.
    expect(postFn).toMatch(/FOR v_line IN[\s\S]*FROM public\.opening_balance_lines/);
  });

  it("24. controleert reikwijdte en actief-zijn van elke rekening", () => {
    expect(postFn).toContain("NOT public.posting_account_ok(l.grootboekrekening_id, v_header.organization_id, v_header.client_id)");
    expect(postFn).toContain("NOT g.actief");
  });

  it("25. weigert een afgesloten boekjaar, net als de vier bestaande schrijvers", () => {
    expect(postFn).toContain("v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar");
    expect(nilFn).toContain("v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar");
  });

  it("26. weigert een beginbalans die niet het eerste feit van de administratie is", () => {
    expect(postFn).toContain("FROM public.ledger_postings lp");
    expect(postFn).toContain("AND lp.posting_date < v_header.opening_date");
    expect(postFn).toContain("moet het eerste feit zijn");
    // En dat gebeurt vóór de claim wordt geschreven.
    expect(postFn.indexOf("moet het eerste feit zijn")).toBeLessThan(
      postFn.indexOf("INSERT INTO public.opening_balance_postings"),
    );
  });

  it("27. schrijft het grootboekcontract precies zoals afgesproken", () => {
    expect(postFn).toContain("v_group_id     uuid := gen_random_uuid()");
    expect(postFn).toContain("'opening_balance', v_header.id, v_line.id, v_uid");
    expect(postFn).toContain("v_header.opening_date, v_header.boekjaar");
    expect(postFn).toContain("'EUR'");
    expect(postFn).toContain("v_line_no := v_line_no + 1;");
    expect(postFn).toContain("ORDER BY sort_order, id");
    expect(postFn).toContain("COALESCE(NULLIF(btrim(v_line.description, E' \\t\\r\\n'), ''), v_header.description)");
    // Geen tegenboeking, en geen valuta buiten EUR.
    expect(postFn).not.toMatch(/reversal_of_posting_id/);
    expect(sql).not.toMatch(/'(USD|GBP|CHF)'/);
  });

  it("28. leidt de boekingsgroep nooit voorspelbaar af", () => {
    expect(postFn).not.toMatch(/posting_group_id\s*:?=\s*(v_header|_opening_balance_id|md5|uuid_generate_v5)/);
    expect(postFn).toContain("gen_random_uuid()");
  });
});

describe("6C-b8 PR 1 — de nihil-verklaring", () => {
  it("29. is een eigen accountant-RPC, geen vrij bewerkbare boolean", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.declare_opening_balance_nil(_opening_balance_id uuid)");
    expect(nilFn).toContain("SECURITY DEFINER");
    expect(nilFn).toContain("SET search_path = public");
    // De nihil-kolommen zitten NIET in de kolomrechten van de applicatie.
    const grants = sql.slice(sql.indexOf("GRANT INSERT ("), sql.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON public.opening_balance_lines"));
    expect(grants).not.toMatch(/nil_declaration|nil_declared_at|nil_declared_by/);
    expect(grants).toContain("GRANT UPDATE (\n  boekjaar, opening_date, description, reference, updated_at\n)");
  });

  it("30. doorloopt alle negen voorwaarden uit de opdracht", () => {
    expect(nilFn).toContain("Niet ingelogd");
    expect(nilFn).toContain("FOR UPDATE");
    expect(nilFn).toContain("'accountant'");
    expect(nilFn).toContain("obp.opening_balance_id = v_header.id");
    expect(nilFn).toContain("obp.client_id = v_header.client_id");
    expect(nilFn).toContain("FROM public.opening_balance_lines");
    expect(nilFn).toContain("verwijder ze eerst");
    expect(nilFn).toContain("al op nihil verklaard");
    expect(nilFn).toContain("afgesloten_boekjaar");
    expect(nilFn).toContain("SET nil_declaration = true,\n      nil_declared_at = now(),\n      nil_declared_by = v_uid");
  });

  it("31. schrijft geen claim en geen grootboekregel", () => {
    expect(nilFn).not.toMatch(/INSERT INTO public\.(ledger_postings|opening_balance_postings)/);
  });

  it("32. en de boekingsfunctie en de opslagfunctie weigeren een nihil-verklaarde kop", () => {
    expect(postFn).toContain("op nihil verklaard en kan niet worden geboekt");
    expect(saveFn).toContain("v_header.nil_declared_at IS NOT NULL");
  });
});

describe("6C-b8 PR 1 — claimtrigger op ledger_postings", () => {
  it("33. is beperkt tot deze bronsoort en weigert een tegenboeking als eerste", () => {
    expect(claimFn).toContain("IF NEW.source_type <> 'opening_balance' THEN\n    RETURN NEW;");
    const rev = claimFn.indexOf("tegenboeking gebruikt een eigen bronsoort");
    expect(rev).toBeGreaterThan(-1);
    expect(rev).toBeLessThan(claimFn.indexOf("FROM public.opening_balance_postings"));
  });

  it("34. toetst kop, groep, organisatie, administratie, datum, boekjaar, regelnummer en regel", () => {
    for (const needle of [
      "niet geboekt via de boekingsfunctie",
      "maar één boekingsgroep",
      "Organisatie of administratie van deze regel wijkt af",
      "Boekingsdatum of boekjaar van deze regel wijkt af",
      "heeft geen regel",
      "source_line_id hoort niet bij deze beginbalans",
      "wijkt af van de bevroren beginbalansregel",
    ]) {
      expect(claimFn, needle).toContain(needle);
    }
    expect(claimFn).toContain("NEW.grootboekrekening_id <> v_line.grootboekrekening_id");
    expect(claimFn).toContain("NEW.debit_amount <> v_line.debit_amount");
    expect(claimFn).toContain("NEW.credit_amount <> v_line.credit_amount");
  });

  it("35. heeft een partiële unieke index op (groep, bronregel)", () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_opening_balance_line\n  ON public.ledger_postings (posting_group_id, source_line_id)\n  WHERE source_type = 'opening_balance';",
    );
  });

  it("36. is integriteit, geen autorisatie", () => {
    expect(claimFn).not.toMatch(/auth\.uid\(\)|has_min_role/);
    expect(sql).toContain("CREATE TRIGGER validate_opening_balance_source_claim_trigger\n  BEFORE INSERT ON public.ledger_postings");
  });
});

describe("6C-b8 PR 1 — bevriezing", () => {
  it("37. bevriest zowel de geboekte als de nihil-verklaarde staat", () => {
    expect(headerGuard).toContain("OLD.nil_declared_at IS NOT NULL");
    expect(headerGuard).toContain("FROM public.opening_balance_postings WHERE opening_balance_id = OLD.id");
    for (const col of [
      "NEW.organization_id IS DISTINCT FROM OLD.organization_id",
      "NEW.client_id       IS DISTINCT FROM OLD.client_id",
      "NEW.boekjaar        IS DISTINCT FROM OLD.boekjaar",
      "NEW.opening_date    IS DISTINCT FROM OLD.opening_date",
      "NEW.description     IS DISTINCT FROM OLD.description",
      "NEW.reference       IS DISTINCT FROM OLD.reference",
      "NEW.nil_declaration IS DISTINCT FROM OLD.nil_declaration",
      "NEW.nil_declared_at IS DISTINCT FROM OLD.nil_declared_at",
      "NEW.nil_declared_by IS DISTINCT FROM OLD.nil_declared_by",
    ]) {
      expect(headerGuard, col).toContain(col);
    }
  });

  it("38. weigert verwijderen van een vastgelegde kop", () => {
    expect(headerGuard).toContain("TG_OP = 'DELETE'");
    expect(headerGuard).toContain("op nihil verklaard; verwijderen is niet mogelijk");
    expect(headerGuard).toContain("geboekt; verwijderen is niet mogelijk");
  });

  it("39. toetst OLD en NEW apart, nooit via COALESCE(NEW.x, OLD.x)", () => {
    expect(lineGuard).not.toMatch(/COALESCE\(NEW\.\w+, OLD\.\w+\)/);
    expect(lineGuard).toContain("WHERE ob.id = NEW.opening_balance_id");
    expect(lineGuard).toContain("WHERE ob.id = OLD.opening_balance_id");
  });

  it("40. grendelt bij een losse regel-INSERT eerst de kop (FOR KEY SHARE)", () => {
    expect(lineGuard).toContain("FOR KEY SHARE");
    expect(lineGuard.indexOf("FOR KEY SHARE")).toBeLessThan(lineGuard.indexOf("opening_balance_postings"));
    expect(sql).toContain(
      "CREATE TRIGGER prevent_settled_opening_balance_line_mutation_trigger\n  BEFORE INSERT OR UPDATE OR DELETE ON public.opening_balance_lines",
    );
  });

  it("41. regels erven organisatie en administratie altijd van de kop", () => {
    expect(lineScopeFn).toContain("NEW.organization_id := v_org;");
    expect(lineScopeFn).toContain("NEW.client_id       := v_client;");
    expect(lineScopeFn).toContain("niet naar een andere beginbalans worden verplaatst");
  });
});

describe("6C-b8 PR 1 — RLS, rechten en de opslagfunctie", () => {
  it("42. gebruikt de bestaande rollenladder, zonder nieuw rechtenkader", () => {
    expect(sql).toContain("USING (public.has_min_role(auth.uid(), organization_id, 'read_only'))");
    expect(sql).toMatch(/role_opening_balances_insert[\s\S]{0,200}'assistant'[\s\S]{0,60}user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/CREATE POLICY role_opening_balances_delete[\s\S]{0,160}'accountant'/);
    expect(sql).toMatch(/CREATE POLICY role_opening_balance_lines_delete[\s\S]{0,200}'assistant'/);
  });

  it("43. de claimtabel is voor de applicatie alleen-lezen", () => {
    expect(sql).toContain("REVOKE ALL ON public.opening_balance_postings FROM anon, authenticated, service_role;");
    expect(sql).toContain("GRANT SELECT ON public.opening_balance_postings TO authenticated, service_role;");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^\n]*opening_balance_postings/);
  });

  it("44. service_role krijgt geen EXECUTE op de schrijvers", () => {
    for (const fn of ["post_opening_balance(uuid)", "declare_opening_balance_nil(uuid)", "save_opening_balance_lines(uuid, jsonb)"]) {
      expect(sql, fn).toContain(`REVOKE ALL ON FUNCTION public.${fn}\n  FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql, fn).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(post_opening_balance|declare_opening_balance_nil)[^\n]*service_role/);
  });

  it("45. de opslagfunctie draait als de aanroeper en weigert een vastgelegde kop", () => {
    expect(saveFn).toContain("SECURITY INVOKER");
    expect(saveFn).toContain("FOR UPDATE");
    expect(saveFn).toContain("Deze beginbalans is geboekt");
    expect(saveFn).toContain("op nihil verklaard");
    // Atomair vervangen, met de bekende RLS-verdediging na de DELETE.
    expect(saveFn).toContain("DELETE FROM public.opening_balance_lines");
    expect(saveFn).toContain("Geen rechten om de regels van deze beginbalans te vervangen");
  });

  it("46. de opslagfunctie keurt >2 decimalen af in plaats van af te ronden", () => {
    expect(saveFn).toContain("v_debit   numeric;");
    expect(saveFn).toContain("v_debit <> round(v_debit, 2)");
    expect(saveFn).toContain("maximaal twee decimalen");
  });

  it("47. elke SECURITY DEFINER-functie heeft een vast search_path en is REVOKEd van PUBLIC", () => {
    for (const fn of OWN_FUNCTIONS) {
      const src = body(fn);
      if (src.includes("SECURITY DEFINER")) {
        expect(src, fn).toContain("SET search_path = public");
      }
      expect(sql, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(`));
    }
  });
});
