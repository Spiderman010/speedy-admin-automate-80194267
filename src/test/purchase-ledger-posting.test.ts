import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b3 — inkoopboekingen.
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. De semantiek (balans, idempotentie, rollback, rechten en
 * gelijktijdigheid) is bewezen met echte PostgreSQL-probes; zie de PR.
 */

const MIGRATION = "supabase/migrations/20260915140000_add_purchase_ledger_posting.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — claimtabel", () => {
  it("1. maakt purchase_invoice_postings met de factuur-id als primary key", () => {
    // De PK ís de idempotentiegarantie: een tweede claim kán niet bestaan.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.purchase_invoice_postings/);
    expect(sql).toMatch(/purchase_invoice_id uuid\s+PRIMARY KEY/);
    expect(sql).toMatch(/posting_group_id\s+uuid\s+NOT NULL UNIQUE/);
  });

  it("2. gebruikt geen regel-id's als identiteit", () => {
    // purchase_invoice_lines.id wordt bij elke opslag verwijderd en opnieuw
    // aangemaakt, dus die kan nooit permanente boekhoudkundige identiteit zijn.
    expect(sql).not.toMatch(/purchase_invoice_lines\.id\b(?![\s\S]{0,40}ORDER BY)/);
    expect(sql).toMatch(/source_line_id/);
    expect(sql).toMatch(/NULL, v_uid/);
  });

  it("3. verankert alle verwijzingen met ON DELETE RESTRICT", () => {
    const restricts = sql.match(/ON DELETE RESTRICT/g) ?? [];
    expect(restricts).toHaveLength(4);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
  });

  it("4. is alleen leesbaar voor applicatierollen", () => {
    expect(sql).toMatch(/ALTER TABLE public\.purchase_invoice_postings ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/CREATE POLICY role_purchase_invoice_postings_select[\s\S]*?FOR SELECT TO authenticated/);
    // Geen INSERT/UPDATE/DELETE policy: het schrijfpad loopt uitsluitend via de RPC.
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).toMatch(/GRANT SELECT ON public\.purchase_invoice_postings TO authenticated, service_role;/);
  });

  it("5. trekt ook de minder voor de hand liggende rechten in", () => {
    // Lovable Cloud-defaults bleken ook TRUNCATE/REFERENCES/TRIGGER uit te delen;
    // met TRIGGER zou een rol een eigen trigger op de claimtabel kunnen hangen.
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON public\.purchase_invoice_postings FROM anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(/REVOKE ALL ON public\.purchase_invoice_postings FROM anon;/);
  });
});

describe("Migratie — de writer", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.post_purchase_invoice"));

  it("6. accepteert uitsluitend de factuur-id", () => {
    // Op de signatuur toetsen, niet op de body: lokale variabelen als
    // v_boekjaar bevatten legitiem dezelfde woorden.
    const signature = /CREATE OR REPLACE FUNCTION public\.post_purchase_invoice\(([^)]*)\)/.exec(sql);
    expect(signature).not.toBeNull();
    expect((signature as RegExpExecArray)[1].trim()).toBe("_invoice_id uuid");
  });

  it("7. bepaalt gebruiker, organisatie en administratie server-side", () => {
    expect(fn).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    expect(fn).toMatch(/IF v_uid IS NULL THEN/);
    expect(fn).toMatch(/public\.has_min_role\(v_uid, v_inv\.organization_id, 'assistant'\)/);
    expect(fn).toMatch(/v_client\.organization_id IS DISTINCT FROM v_inv\.organization_id/);
  });

  it("8. stelt created_xact_id en posting_group_id nooit zelf samen uit caller-invoer", () => {
    expect(fn).not.toMatch(/created_xact_id/);
    expect(fn).toMatch(/v_group_id\s+uuid := gen_random_uuid\(\)/);
  });

  it("9. weigert een niet-gefinaliseerde factuur", () => {
    expect(fn).toMatch(/status NOT IN \('gecontroleerd', 'betaald', 'geexporteerd'\)/);
  });

  it("10. eist een factuurdatum en leidt het boekjaar er kalenderjaarlijks uit af", () => {
    expect(fn).toMatch(/v_inv\.invoice_date IS NULL/);
    expect(fn).toMatch(/EXTRACT\(YEAR FROM v_inv\.invoice_date\)/);
  });

  it("11. weigert boeken in een afgesloten boekjaar", () => {
    expect(fn).toMatch(/v_boekjaar <= v_client\.afgesloten_boekjaar/);
  });

  it("12. eist de geconfigureerde rekeningen en verzint er nooit een", () => {
    expect(fn).toMatch(/v_client\.crediteuren_rekening_id IS NULL/);
    expect(fn).toMatch(/v_btw > 0 AND v_client\.btw_te_vorderen_rekening_id IS NULL/);
    // Geen hardgecodeerde rekeningnummers in de writer.
    expect(fn).not.toMatch(/\b(1600|1520|1530|4000)\b/);
  });

  it("13. reconcilieert exact, zonder tolerantie", () => {
    expect(fn).toMatch(/v_sum_lines <> v_inv\.amount_excl/);
    expect(fn).toMatch(/v_inv\.amount_excl \+ v_btw <> v_inv\.amount_incl/);
    // De UI-tolerantie uit purchase-line-validation is bewust NIET overgenomen.
    expect(fn).not.toMatch(/tolerance|0\.02|ABS\(/i);
  });

  it("14. controleert elke rekening op organisatie- én administratiebereik", () => {
    const scopeChecks = fn.match(/posting_account_ok\(/g) ?? [];
    expect(scopeChecks.length).toBeGreaterThanOrEqual(3); // regels, crediteuren, BTW
  });

  it("15. claimt de factuur vóór het schrijven van grootboekregels", () => {
    expect(fn.indexOf("INSERT INTO public.purchase_invoice_postings"))
      .toBeLessThan(fn.indexOf("INSERT INTO public.ledger_postings"));
    expect(fn).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    expect(fn).toMatch(/Deze inkoopfactuur is al geboekt/);
  });

  it("16. boekt BTW apart en nooit verstopt in een kostenregel", () => {
    expect(fn).toMatch(/v_client\.btw_te_vorderen_rekening_id, v_group_id, v_line_no/);
    expect(fn).toMatch(/'BTW te vorderen'/);
  });

  it("17. crediteert de crediteur voor het bedrag inclusief BTW", () => {
    expect(fn).toMatch(/v_client\.crediteuren_rekening_id, v_group_id, v_line_no[\s\S]*?0, v_inv\.amount_incl/);
  });

  it("18. schrijft altijd EUR expliciet", () => {
    const eur = fn.match(/'EUR'/g) ?? [];
    expect(eur.length).toBeGreaterThanOrEqual(3);
  });

  it("19. gebruikt source_type purchase_invoice en de factuur-id als source_id", () => {
    const st = fn.match(/'purchase_invoice', v_inv\.id, NULL/g) ?? [];
    expect(st.length).toBeGreaterThanOrEqual(3);
  });

  it("20. is SECURITY DEFINER met vast search_path en zonder PUBLIC-rechten", () => {
    expect(fn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(fn.slice(0, 300)).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.post_purchase_invoice\(uuid\) FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_purchase_invoice\(uuid\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO anon/);
  });
});

describe("Migratie — scope en veiligheid", () => {
  it("21. voert geen historische backfill uit", () => {
    // De enige INSERTs staan in de functiebody; er is geen set-based backfill
    // vanuit bestaande facturen.
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings[\s\S]{0,200}SELECT[\s\S]{0,200}FROM public\.purchase_invoices/);
    expect(sql).not.toMatch(/INSERT INTO public\.purchase_invoice_postings[\s\S]{0,120}SELECT/);
  });

  it("22. raakt geen bestaande tabellen of de 6C-b2 migratie aan", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["purchase_invoice_postings"]));
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE/);
    // De gedeelde helpers worden hergebruikt, niet geherdefinieerd.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(posting_account_ok|has_min_role|ledger_link_org_ok|set_organization_id)/);
  });

  it("23. definieert precies de vier eigen functies en niets meer", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fns)).toEqual(new Set([
      "post_purchase_invoice",
      "enforce_purchase_source_claim",
      "prevent_posted_purchase_invoice_mutation",
      "prevent_posted_purchase_line_mutation",
    ]));
  });

  it("24. is idempotent herhaalbaar", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).toMatch(/FROM pg_constraint c/);
  });

  it("25. documenteert een rollback", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.post_purchase_invoice\(uuid\);/);
    expect(raw).toMatch(/DROP TABLE IF EXISTS public\.purchase_invoice_postings;/);
  });

  it("26. documenteert de bewust niet-ondersteunde gevallen", () => {
    expect(raw).toMatch(/[Vv]erlegde BTW|reverse charge/);
    expect(raw).toMatch(/[Cc]redit note|creditnota/);
  });
});

describe("Migratie — bronidempotentie op ledger_postings zelf", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.enforce_purchase_source_claim"));

  it("27. bewaakt inkoopregels rechtstreeks op ledger_postings", () => {
    // De PK van de claimtabel beschermt alleen de RPC; authenticated heeft uit
    // 6C-b2 een directe INSERT op ledger_postings, dus een tweede groep moest
    // op de tabel zelf worden uitgesloten.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.enforce_purchase_source_claim/);
    expect(sql).toMatch(
      /CREATE TRIGGER validate_purchase_source_claim_trigger\s+BEFORE INSERT ON public\.ledger_postings/,
    );
  });

  it("28. blijft strikt beperkt tot source_type = purchase_invoice", () => {
    // Geen universele brontrigger: 6C-b4/b5/b6 hebben hun eigen contract.
    expect(fn).toMatch(/IF NEW\.source_type <> 'purchase_invoice' THEN\s+RETURN NEW;/);
  });

  it("29. eist een marker en exact dezelfde boekingsgroep, organisatie en administratie", () => {
    expect(fn).toMatch(/NEW\.source_id IS NULL/);
    expect(fn).toMatch(/FROM public\.purchase_invoice_postings\s+WHERE purchase_invoice_id = NEW\.source_id/);
    expect(fn).toMatch(/NEW\.posting_group_id <> v_marker\.posting_group_id/);
    expect(fn).toMatch(/NEW\.organization_id IS DISTINCT FROM v_marker\.organization_id/);
    expect(fn).toMatch(/NEW\.client_id IS DISTINCT FROM v_marker\.client_id/);
  });
});

describe("Migratie — geboekte bron is bevroren", () => {
  const hdr = sql.slice(sql.indexOf("FUNCTION public.prevent_posted_purchase_invoice_mutation"));

  it("30. bevriest de boekhoudkundige headervelden zodra er een marker is", () => {
    for (const field of [
      "client_id", "organization_id", "leverancier_id", "supplier", "invoice_number",
      "invoice_date", "amount_excl", "btw_amount", "amount_incl", "btw_percentage",
      "grootboekrekening_id", "ledger_account_id", "ledger_account_text",
    ]) {
      expect(hdr).toContain(`NEW.${field}`);
    }
  });

  it("31. laat betaal- en workflowvelden bewust vrij", () => {
    // status, remaining_amount en notes veranderen niets aan wat geboekt is.
    for (const allowed of ["status", "remaining_amount", "notes"]) {
      expect(hdr).not.toMatch(new RegExp(`NEW\\.${allowed}\\s+IS DISTINCT FROM`));
    }
  });

  it("32. blokkeert elke mutatie van boekingsregels van een geboekte factuur", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.prevent_posted_purchase_line_mutation/);
    expect(sql).toMatch(
      /CREATE TRIGGER prevent_posted_purchase_line_mutation_trigger\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.purchase_invoice_lines/,
    );
    // DELETE gebruikt OLD, INSERT gebruikt NEW.
    expect(sql).toMatch(/COALESCE\(NEW\.purchase_invoice_id, OLD\.purchase_invoice_id\)/);
  });

  it("33. serialiseert opslaan en boeken met een rijgrendel", () => {
    const writer = sql.slice(sql.indexOf("FUNCTION public.post_purchase_invoice"));
    expect(writer).toMatch(/FROM public\.purchase_invoices WHERE id = _invoice_id FOR UPDATE;/);
  });
});
