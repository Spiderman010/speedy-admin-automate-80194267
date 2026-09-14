import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Statische migratietests voor fase 6C-b2 (ledger_postings).
 *
 * Er is geen DB-integratieharnas in deze repo — elke suite draait in jsdom
 * tegen een gemockte Supabase — dus de garanties worden hier structureel op de
 * migratie-SQL vastgelegd, net als in accounting-foundation-config.test.tsx.
 */

const MIGRATION = "supabase/migrations/20260914120000_add_ledger_postings_foundation.sql";

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");

// Alleen uitvoerbare SQL: de headercomment documenteert de rollback (met DROP
// TABLE, DROP POLICY, ...) en zou anders elke negatieve assertie bevredigen.
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — ledger postings foundation (schema)", () => {
  it("1. maakt exact één nieuwe tabel: ledger_postings", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ledger_postings/);
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["ledger_postings"]);
  });

  it("2. definieert alle verplichte identiteitskolommen als NOT NULL", () => {
    expect(sql).toMatch(/organization_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/client_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/grootboekrekening_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/posting_group_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/posting_date\s+date\s+NOT NULL/);
    expect(sql).toMatch(/boekjaar\s+integer\s+NOT NULL/);
    expect(sql).toMatch(/source_type\s+text\s+NOT NULL/);
    expect(sql).toMatch(/user_id\s+uuid\s+NOT NULL/);
    expect(sql).toMatch(/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("3. gebruikt numeric(12,2) voor geld en nooit een floating point type", () => {
    expect(sql).toMatch(/debit_amount\s+numeric\(12,2\)\s+NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/credit_amount\s+numeric\(12,2\)\s+NOT NULL DEFAULT 0/);
    expect(sql).not.toMatch(/\b(float|float4|float8|real|double precision|money)\b/i);
  });

  it("4. laat optionele kolommen nullable en vereist geen brondocument", () => {
    // source_id/source_line_id/description/reversal zijn bewust nullable:
    // een opening_balance heeft geen brondocument.
    expect(sql).toMatch(/source_id\s+uuid,/);
    expect(sql).toMatch(/source_line_id\s+uuid,/);
    expect(sql).toMatch(/description\s+text,/);
    expect(sql).toMatch(/reversal_of_posting_id uuid,/);
  });

  it("5. heeft geen updated_at kolom (append-only, rijen wijzigen nooit)", () => {
    expect(sql).not.toMatch(/updated_at/);
    expect(sql).not.toMatch(/update_updated_at_column/);
  });
});

describe("Migratie — financiële integriteit op rijniveau", () => {
  it("6. staat geen negatieve bedragen toe", () => {
    expect(sql).toMatch(/CHECK \(debit_amount\s+>= 0\)/);
    expect(sql).toMatch(/CHECK \(credit_amount >= 0\)/);
  });

  it("7. staat niet toe dat debet én credit gevuld zijn, of allebei nul", () => {
    expect(sql).toMatch(/CONSTRAINT ledger_postings_single_side_check CHECK \(/);
    expect(sql).toMatch(/\(debit_amount > 0 AND credit_amount = 0\)/);
    expect(sql).toMatch(/\(credit_amount > 0 AND debit_amount = 0\)/);
  });

  it("8. kent geen saldoveld op rijniveau", () => {
    expect(sql).not.toMatch(/\bbalance\b|\bsaldo\b/i);
  });

  it("9. dwingt een positief regelnummer af zonder default", () => {
    expect(sql).toMatch(/line_no\s+integer\s+NOT NULL CHECK \(line_no > 0\)/);
    // Geen DEFAULT: anders botsen alle regels van één groep op line_no = 1.
    expect(sql).not.toMatch(/line_no\s+integer\s+NOT NULL DEFAULT/);
  });

  it("9b. bewaakt bij source_type de vorm, niet een vaste waardenlijst", () => {
    // De canonieke grootboektabel mag niet bij elke nieuwe bronsoort een
    // schemamigratie eisen; de echte bescherming is de idempotency-constraint
    // die elke schrijverfase voor zijn eigen bronsoort toevoegt.
    expect(sql).toMatch(/btrim\(source_type\) <> ''/);
    expect(sql).toMatch(/source_type ~ '\^\[a-z\]\[a-z0-9_\]\*\$'/);
    // Geen harde waardenlijst en geen PostgreSQL enum.
    expect(sql).not.toMatch(/source_type IN \(/);
    expect(sql).not.toMatch(/CREATE TYPE/);
  });

  it("10. vereist currency expliciet, zonder impliciete EUR-default", () => {
    expect(sql).toMatch(/currency\s+text\s+NOT NULL CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
    expect(sql).not.toMatch(/currency[^\n]*DEFAULT/);
  });
});

describe("Migratie — boekingsgroep-invarianten", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.enforce_ledger_posting_group_balance"));

  it("11. valideert de groep met een DEFERRABLE INITIALLY DEFERRED constraint trigger", () => {
    // Zonder deferral zou de eerste regel van een sluitende meerregelige
    // boeking geweigerd worden omdat de groep dan nog half geschreven is.
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER validate_ledger_posting_group_balance_trigger\s+AFTER INSERT ON public\.ledger_postings\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW/,
    );
  });

  it("12. eist minimaal twee regels per boeking", () => {
    expect(fn).toMatch(/v_rows < 2/);
  });

  it("13. eist precies één organisatie en één administratie per groep", () => {
    expect(fn).toMatch(/COUNT\(DISTINCT p\.organization_id\)/);
    expect(fn).toMatch(/COUNT\(DISTINCT p\.client_id\)/);
    expect(fn).toMatch(/v_orgs > 1/);
    expect(fn).toMatch(/v_clients > 1/);
  });

  it("14. eist één valuta per groep, zodat 100 EUR debet / 100 USD credit niet 'sluit'", () => {
    expect(fn).toMatch(/COUNT\(DISTINCT p\.currency\)/);
    expect(fn).toMatch(/v_currencies > 1/);
    // De valutacontrole moet vóór de saldovergelijking staan, anders wordt de
    // groep afgekeurd op de verkeerde reden.
    expect(fn.indexOf("v_currencies > 1")).toBeLessThan(fn.indexOf("v_debit <> v_credit"));
  });

  it("15. eist één boekingsdatum en één boekjaar per groep", () => {
    expect(fn).toMatch(/COUNT\(DISTINCT p\.posting_date\)/);
    expect(fn).toMatch(/COUNT\(DISTINCT p\.boekjaar\)/);
    expect(fn).toMatch(/v_dates > 1 OR v_boekjaren > 1/);
  });

  it("16. eist dat debet én credit groter dan nul zijn en exact gelijk", () => {
    expect(fn).toMatch(/v_debit <= 0 OR v_credit <= 0/);
    expect(fn).toMatch(/v_debit <> v_credit/);
  });

  it("17. rekent met exacte NUMERIC, niet met floats", () => {
    expect(fn).toMatch(/v_debit\s+numeric;/);
    expect(fn).toMatch(/v_credit\s+numeric;/);
  });

  it("18b. serialiseert gelijktijdige schrijvers per posting_group_id", () => {
    // De deferred check ziet alleen commits + eigen transactie, dus twee
    // gelijktijdige transacties konden elk hun eigen helft goedkeuren en samen
    // een ongeldige groep achterlaten — onherstelbaar in een append-only tabel.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.lock_ledger_posting_group/);
    expect(sql).toMatch(/PERFORM pg_advisory_xact_lock\(/);
    // Transactie-scope, niet sessie-scope: een sessielock zou in een pooled
    // connectie kunnen blijven hangen.
    expect(sql).not.toMatch(/pg_advisory_lock\(/);
    expect(sql).toMatch(
      /CREATE TRIGGER lock_ledger_posting_group_trigger\s+BEFORE INSERT ON public\.ledger_postings/,
    );
  });

  it("18c. leidt de locksleutel deterministisch af uit posting_group_id", () => {
    // Geen hashfunctie waarvan de uitkomst per PostgreSQL-versie kan verschillen.
    expect(sql).toMatch(
      /\('x' \|\| substr\(replace\(NEW\.posting_group_id::text, '-', ''\), 1, 16\)\)::bit\(64\)::bigint/,
    );
    expect(sql).not.toMatch(/hashtext|md5\(/);
  });

  it("18e. weigert REPEATABLE READ, waar de lock alleen niet genoeg is", () => {
    // Onder REPEATABLE READ legt een transactie haar snapshot vast vóórdat ze
    // op de lock wacht; na het verkrijgen van de lock ziet ze de zojuist
    // gecommitte rijen van de ander nóg steeds niet. Twee op zichzelf geldige
    // helften kunnen dan samen één ongeldige groep vormen.
    const fn = sql.slice(sql.indexOf("FUNCTION public.lock_ledger_posting_group"));
    expect(fn).toMatch(/current_setting\('transaction_isolation'\) = 'repeatable read'/);
    expect(fn).toMatch(/ERRCODE = '0A000'/);
    // De weigering staat vóór de lock, dus er wordt nooit een rij geaccepteerd.
    expect(fn.indexOf("repeatable read")).toBeLessThan(fn.indexOf("pg_advisory_xact_lock"));
  });

  it("18f. laat READ COMMITTED en SERIALIZABLE ongemoeid", () => {
    const fn = sql.slice(
      sql.indexOf("FUNCTION public.lock_ledger_posting_group"),
      sql.indexOf("FUNCTION public.lock_ledger_posting_group") + 900,
    );
    // Alleen 'repeatable read' wordt geweigerd; serializable is bewezen veilig
    // via SSI en read committed via de advisory lock.
    expect(fn).not.toMatch(/= 'serializable'/);
    expect(fn).not.toMatch(/= 'read committed'/);
  });

  it("18d. pakt de lock vóór alle validatie (naamvolgorde van de triggers)", () => {
    // PostgreSQL vuurt row-triggers op naam; "lock_" moet vóór "set_" en
    // "validate_" komen zodat de tweede transactie meteen wacht.
    expect("lock_ledger_posting_group_trigger" < "set_organization_id_trigger").toBe(true);
    expect("lock_ledger_posting_group_trigger" < "validate_ledger_posting_org_trigger").toBe(true);
  });

  it("18. beoordeelt de eindstaat van de hele groep, niet alleen de nieuwe rij", () => {
    // De aggregatie loopt over alle rijen met hetzelfde posting_group_id.
    expect(fn).toMatch(/FROM public\.ledger_postings p\s+WHERE p\.posting_group_id = NEW\.posting_group_id/);
  });
});

describe("Migratie — tenant-isolatie", () => {
  it("19. controleert dat de administratie in dezelfde organisatie zit", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.posting_client_org_ok/);
    expect(sql).toMatch(/FROM public\.clients c\s+WHERE c\.id = _client_id\s+AND c\.organization_id IS NOT DISTINCT FROM _organization_id/);
  });

  it("20. hergebruikt ledger_link_org_ok voor de grootboekrekening", () => {
    expect(sql).toMatch(/public\.ledger_link_org_ok\(NEW\.grootboekrekening_id, NEW\.organization_id\)/);
    // De bestaande gedeelde functie wordt hergebruikt, niet geherdefinieerd.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.ledger_link_org_ok/);
  });

  it("21. weigert beide richtingen met een check_violation", () => {
    expect(sql).toMatch(/client_id verwijst naar een administratie buiten de organisatie/);
    expect(sql).toMatch(/grootboekrekening_id verwijst naar een grootboekrekening buiten de organisatie/);
    const errcodes = sql.match(/ERRCODE = '23514'/g) ?? [];
    expect(errcodes.length).toBeGreaterThanOrEqual(2);
  });

  it("22. draait de validatietrigger ná set_organization_id_trigger", () => {
    // PostgreSQL vuurt row-triggers op naamvolgorde; organization_id moet al
    // afgeleid zijn voordat hij vergeleken wordt.
    expect("validate_ledger_posting_org_trigger" > "set_organization_id_trigger").toBe(true);
    expect(sql).toMatch(/CREATE TRIGGER set_organization_id_trigger\s+BEFORE INSERT ON public\.ledger_postings/);
  });

  it("23. houdt de trigger-functies SECURITY DEFINER met een vast search_path", () => {
    const definers = [
      "posting_client_org_ok",
      "enforce_ledger_posting_org",
      "prevent_ledger_posting_mutation",
      "enforce_ledger_posting_group_balance",
      "lock_ledger_posting_group",
    ];
    for (const name of definers) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${name}`));
      expect(body.slice(0, 400)).toMatch(/SECURITY DEFINER/);
      expect(body.slice(0, 400)).toMatch(/SET search_path = public/);
    }
  });

  it("24. ontneemt PUBLIC het recht om de trigger-functies aan te roepen", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.posting_client_org_ok\(uuid, uuid\)\s+FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_ledger_posting_org\(\)\s+FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.prevent_ledger_posting_mutation\(\)\s+FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_ledger_posting_group_balance\(\)\s+FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.lock_ledger_posting_group\(\)\s+FROM PUBLIC;/);
    // Trigger-only functies worden nooit als RPC aan gebruikers gegeven.
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(posting_client_org_ok|enforce_ledger_posting|prevent_ledger_posting)/);
  });
});

describe("Migratie — append-only", () => {
  it("25. blokkeert UPDATE en DELETE met een trigger", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.prevent_ledger_posting_mutation/);
    expect(sql).toMatch(
      /CREATE TRIGGER prevent_ledger_posting_mutation_trigger\s+BEFORE UPDATE OR DELETE ON public\.ledger_postings/,
    );
    expect(sql).toMatch(/ledger_postings is append-only/);
  });

  it("26. maakt geen UPDATE- of DELETE-policy aan", () => {
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR UPDATE/);
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR DELETE/);
    expect(sql).not.toMatch(/role_ledger_postings_update|role_ledger_postings_delete/);
  });

  it("27. trekt muteerrechten in bij álle applicatierollen, inclusief service_role", () => {
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON public\.ledger_postings FROM anon, authenticated, service_role;/,
    );
  });

  it("27b. dicht het TRUNCATE-gat dat trigger noch RLS kan afdekken", () => {
    // TRUNCATE vuurt geen row-trigger, en service_role omzeilt RLS. Alleen een
    // expliciete REVOKE sluit dit; anders zou één TRUNCATE het hele grootboek
    // wissen terwijl UPDATE en DELETE keurig geblokkeerd blijven.
    const revoke = sql.match(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.ledger_postings FROM ([^;]+);/);
    expect(revoke).not.toBeNull();
    const roles = (revoke as RegExpMatchArray)[1].split(",").map((r) => r.trim());
    expect(new Set(roles)).toEqual(new Set(["anon", "authenticated", "service_role"]));
  });

  it("27c. laat service_role wél lezen en schrijven", () => {
    // De REVOKE noemt alleen UPDATE/DELETE/TRUNCATE; SELECT en INSERT blijven,
    // zodat edge functions gewoon kunnen boeken.
    expect(sql).not.toMatch(/REVOKE[^\n]*\bINSERT\b[^\n]*service_role/);
    expect(sql).not.toMatch(/REVOKE ALL ON public\.ledger_postings FROM[^\n]*service_role/);
  });

  it("28. bouwt nog geen reversal-logica, alleen een kolom voor later", () => {
    expect(sql).toMatch(/reversal_of_posting_id/);
    // Geen RPC, geen functie die tegenboekingen aanmaakt.
    expect(sql).not.toMatch(/FUNCTION public\.\w*revers\w*/i);
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings/);
  });
});

describe("Migratie — RLS", () => {
  it("29. zet RLS aan", () => {
    expect(sql).toContain("ALTER TABLE public.ledger_postings ENABLE ROW LEVEL SECURITY;");
  });

  it("30. gebruikt de bestaande has_min_role-ladder, TO authenticated", () => {
    expect(sql).toMatch(
      /CREATE POLICY role_ledger_postings_select ON public\.ledger_postings\s+FOR SELECT TO authenticated\s+USING \(public\.has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)\)/,
    );
    expect(sql).toMatch(
      /CREATE POLICY role_ledger_postings_insert ON public\.ledger_postings\s+FOR INSERT TO authenticated\s+WITH CHECK \(\s*public\.has_min_role\(auth\.uid\(\), organization_id, 'assistant'\)/,
    );
  });

  it("30b. bindt user_id aan auth.uid(), zodat een boeking niet aan een ander toegeschreven kan worden", () => {
    // Zonder deze eis zou elk lid een andere bestaande auth-uuid kunnen
    // meesturen: de FK slaagt en de onveranderlijke boeking staat voorgoed op
    // naam van de verkeerde persoon.
    const policy = sql.slice(
      sql.indexOf("CREATE POLICY role_ledger_postings_insert"),
      sql.indexOf("CREATE POLICY role_ledger_postings_insert") + 400,
    );
    expect(policy).toMatch(/AND user_id = auth\.uid\(\)/);
  });

  it("30c. herschrijft user_id niet stilzwijgend met een trigger", () => {
    // Weigeren is eerlijker dan een gespooofde waarde stil corrigeren.
    expect(sql).not.toMatch(/NEW\.user_id\s*:=/);
    expect(sql).not.toMatch(/user_id[^\n]*DEFAULT auth\.uid\(\)/);
  });

  it("31. geeft anon nergens toegang", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.ledger_postings FROM anon;/);
    expect(sql).not.toMatch(/GRANT[^\n]*TO anon/);
    expect(sql).not.toMatch(/TO anon, authenticated;\s*$/m);
  });

  it("32. verzint geen nieuw rechtenframework", () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(has_min_role|is_organization_member|has_role|role_rank)/);
  });
});

describe("Migratie — foreign keys en verwijdergedrag", () => {
  it("33. gebruikt overal ON DELETE RESTRICT en nooit CASCADE of SET NULL", () => {
    const restricts = sql.match(/ON DELETE RESTRICT/g) ?? [];
    expect(restricts).toHaveLength(5);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
  });

  it("34. verankert organisatie, administratie, rekening en tegenboeking", () => {
    expect(sql).toMatch(/ledger_postings_organization_id_fkey[\s\S]*?REFERENCES public\.organizations \(id\)\s+ON DELETE RESTRICT/);
    expect(sql).toMatch(/ledger_postings_client_id_fkey[\s\S]*?REFERENCES public\.clients \(id\)\s+ON DELETE RESTRICT/);
    expect(sql).toMatch(/ledger_postings_grootboekrekening_id_fkey[\s\S]*?REFERENCES public\.grootboekrekeningen \(id\)\s+ON DELETE RESTRICT/);
    expect(sql).toMatch(/ledger_postings_reversal_of_posting_id_fkey[\s\S]*?REFERENCES public\.ledger_postings \(id\)\s+ON DELETE RESTRICT/);
  });

  it("34b. legt user_id vast met een FK naar auth.users, niet-cascaderend", () => {
    // Een onveranderlijke boeking mag nooit een verzonnen of verweesde
    // maker-uuid bevatten; CASCADE zou boekhistorie wissen bij het
    // verwijderen van een gebruiker.
    expect(sql).toMatch(
      /ledger_postings_user_id_fkey\s+FOREIGN KEY \(user_id\)\s+REFERENCES auth\.users \(id\)\s+ON DELETE RESTRICT/,
    );
  });

  it("35. voegt de constraints idempotent toe via pg_constraint", () => {
    const guards = sql.match(/FROM pg_constraint c/g) ?? [];
    expect(guards).toHaveLength(5);
  });
});

describe("Migratie — indexen en idempotentie", () => {
  it("36. maakt posting_group_id niet uniek, maar wel (posting_group_id, line_no)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ledger_postings_group_line_key\s+ON public\.ledger_postings \(posting_group_id, line_no\);/,
    );
    expect(sql).not.toMatch(/UNIQUE[^\n]*\(posting_group_id\)/);
  });

  it("37. legt geen universele source-uniciteit op (bewust uitgesteld)", () => {
    expect(sql).not.toMatch(/UNIQUE[^\n]*source_type[^\n]*source_id/);
    expect(raw).toMatch(/DELIBERATELY DEFERRED/);
  });

  it("38. voegt alleen de onderbouwde indexen toe", () => {
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(new Set(indexes)).toEqual(
      new Set([
        "ledger_postings_group_line_key",
        "idx_ledger_postings_organization_date",
        "idx_ledger_postings_client_account_date",
        "idx_ledger_postings_grootboekrekening_id",
        "idx_ledger_postings_source",
        "idx_ledger_postings_user_id",
        "idx_ledger_postings_reversal_of_posting_id",
      ]),
    );
  });

  it("38b. indexeert user_id zodat de RESTRICT-FK geen seq scan wordt", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_ledger_postings_user_id\s+ON public\.ledger_postings \(user_id\);/);
  });

  it("39. is idempotent te herhalen", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    const createIdx = sql.match(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/g) ?? [];
    expect(createIdx).toHaveLength(0);
  });

  it("40. documenteert een rollback in de header", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP TABLE IF EXISTS public\.ledger_postings;/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.enforce_ledger_posting_group_balance\(\);/);
    expect(raw).toMatch(/DROP POLICY IF EXISTS role_ledger_postings_select ON public\.ledger_postings;/);
  });
});

describe("Migratie — geen historische backfill, geen scope-uitbreiding", () => {
  it("41. voegt geen enkele boeking in", () => {
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/ledger_postings\s*\([^)]*\)\s*SELECT/i);
  });

  it("42. leest geen historische brontabellen", () => {
    // Geen backfill vanuit bestaande documenten: de tabel start leeg.
    for (const table of [
      "purchase_invoices",
      "purchase_invoice_lines",
      "sales_invoices",
      "bank_transactions",
      "bank_transaction_allocations",
      "journal_entries",
    ]) {
      expect(sql).not.toMatch(new RegExp(`public\\.${table}\\b`));
    }
  });

  it("43. wijzigt geen enkele bestaande tabel", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["ledger_postings"]));
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE TABLE|ALTER COLUMN/);
  });

  it("44. definieert alleen de eigen functies en raakt gedeelde functies niet aan", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fns)).toEqual(
      new Set([
        "posting_client_org_ok",
        "enforce_ledger_posting_org",
        "prevent_ledger_posting_mutation",
        "enforce_ledger_posting_group_balance",
        "lock_ledger_posting_group",
      ]),
    );
    expect(sql).not.toMatch(/FUNCTION public\.(set_organization_id|prevent_org_user_rebind|update_updated_at_column)\s*\(\)\s*\n?RETURNS/);
  });

  it("45. raakt geen policies van andere tabellen aan", () => {
    const policies = [...sql.matchAll(/(?:CREATE|DROP) POLICY (?:IF EXISTS )?(\w+) ON public\.(\w+)/g)].map((m) => m[2]);
    expect(new Set(policies)).toEqual(new Set(["ledger_postings"]));
  });
});
