import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b4 — verkoopboekingen.
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. De semantiek (balans, idempotentie, rollback, rechten en
 * gelijktijdigheid) is bewezen met echte PostgreSQL-probes; zie de PR.
 */

const MIGRATION = "supabase/migrations/20260915160000_add_sales_ledger_posting.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — claimtabel", () => {
  it("1. maakt sales_invoice_postings met de factuur-id als primary key", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.sales_invoice_postings/);
    expect(sql).toMatch(/sales_invoice_id uuid\s+PRIMARY KEY/);
    expect(sql).toMatch(/posting_group_id\s+uuid\s+NOT NULL UNIQUE/);
  });

  it("2. gebruikt geen regel-id's als identiteit — sales heeft sowieso geen regels", () => {
    expect(sql).toMatch(/source_line_id/);
    // Beide ledger-inserts gebruiken NULL voor source_line_id.
    expect(sql).toMatch(/'sales_invoice', v_inv\.id, NULL/);
  });

  it("3. verankert alle verwijzingen met ON DELETE RESTRICT", () => {
    const restricts = sql.match(/ON DELETE RESTRICT/g) ?? [];
    expect(restricts).toHaveLength(4);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
  });

  it("4. is alleen leesbaar voor applicatierollen", () => {
    expect(sql).toMatch(/ALTER TABLE public\.sales_invoice_postings ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/CREATE POLICY role_sales_invoice_postings_select[\s\S]*?FOR SELECT TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).toMatch(/GRANT SELECT ON public\.sales_invoice_postings TO authenticated, service_role;/);
  });

  it("5. trekt ook de minder voor de hand liggende rechten in", () => {
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON public\.sales_invoice_postings FROM anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(/REVOKE ALL ON public\.sales_invoice_postings FROM anon;/);
  });
});

describe("Migratie — de writer", () => {
  const fn = sql.slice(sql.indexOf("FUNCTION public.post_sales_invoice"));

  it("6. accepteert uitsluitend de factuur-id", () => {
    const signature = /CREATE OR REPLACE FUNCTION public\.post_sales_invoice\(([^)]*)\)/.exec(sql);
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

  it("9. weigert een niet-gefinaliseerde factuur, inclusief 'verzonden'", () => {
    // De DB CHECK op sales_invoices staat alleen concept/gecontroleerd/
    // verzonden/betaald toe; geexporteerd bestaat daarin niet voor sales en is
    // dode code in de bestaande app. 'verzonden' is een vrij te kiezen
    // dropdownwaarde zonder bewezen "goedgekeurd"-betekenis, dus expliciet
    // uitgesloten van de finale set.
    expect(fn).toMatch(/status NOT IN \('gecontroleerd', 'betaald'\)/);
    expect(fn).not.toMatch(/'verzonden'/);
  });

  it("10. eist een factuurdatum (defensief) en leidt het boekjaar kalenderjaarlijks af", () => {
    expect(fn).toMatch(/v_inv\.invoice_date IS NULL/);
    expect(fn).toMatch(/EXTRACT\(YEAR FROM v_inv\.invoice_date\)/);
  });

  it("11. weigert boeken in een afgesloten boekjaar", () => {
    expect(fn).toMatch(/v_boekjaar <= v_client\.afgesloten_boekjaar/);
  });

  it("12. weigert verlegde BTW expliciet in plaats van hem stil te negeren", () => {
    // Sales heeft, anders dan purchase, wél een btw_verlegd-veld. Een naieve
    // header-boeking zou sluiten (btw_amount=0) maar de BTW-aangifte-poten
    // missen. De SnelStart-export weigert deze facturen al om dezelfde reden.
    expect(fn).toMatch(/IF v_inv\.btw_verlegd THEN/);
    expect(fn).toMatch(/Verkoopfacturen met verlegde BTW kunnen nog niet worden geboekt/);
  });

  it("13. eist de geconfigureerde rekeningen en verzint er nooit een", () => {
    expect(fn).toMatch(/v_inv\.grootboekrekening_id IS NULL/);
    expect(fn).toMatch(/v_client\.debiteuren_rekening_id IS NULL/);
    expect(fn).toMatch(/v_btw > 0 AND v_client\.btw_te_betalen_rekening_id IS NULL/);
    expect(fn).not.toMatch(/\b(1300|1600|8000|1520|1530)\b/);
  });

  it("14. reconcilieert exact zonder tolerantie en zonder regelsom (header-only)", () => {
    expect(fn).toMatch(/v_inv\.amount_excl \+ v_btw <> v_inv\.amount_incl/);
    expect(fn).not.toMatch(/v_sum_lines/);
    expect(fn).not.toMatch(/tolerance|0\.02|ABS\(/i);
  });

  it("15. controleert elke rekening op organisatie- én administratiebereik", () => {
    const scopeChecks = fn.match(/posting_account_ok\(/g) ?? [];
    expect(scopeChecks.length).toBeGreaterThanOrEqual(3); // omzet, debiteuren, BTW
  });

  it("16. claimt de factuur vóór het schrijven van grootboekregels", () => {
    expect(fn.indexOf("INSERT INTO public.sales_invoice_postings"))
      .toBeLessThan(fn.indexOf("INSERT INTO public.ledger_postings"));
    expect(fn).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    expect(fn).toMatch(/Deze verkoopfactuur is al geboekt/);
  });

  it("17. debiteert de debiteur voor het bedrag inclusief BTW", () => {
    expect(fn).toMatch(/v_client\.debiteuren_rekening_id, v_group_id, v_line_no[\s\S]{0,200}v_inv\.amount_incl, 0/);
  });

  it("18. crediteert de omzetrekening voor het bedrag exclusief BTW, nooit inclusief", () => {
    expect(fn).toMatch(/v_inv\.grootboekrekening_id, v_group_id, v_line_no[\s\S]{0,200}0, v_inv\.amount_excl/);
  });

  it("19. boekt BTW apart en alleen wanneer er BTW is", () => {
    expect(fn).toMatch(/v_client\.btw_te_betalen_rekening_id, v_group_id, v_line_no/);
    expect(fn).toMatch(/'BTW te betalen'/);
    expect(fn).toMatch(/IF v_btw > 0 THEN/);
  });

  it("20. schrijft altijd EUR expliciet", () => {
    const eur = fn.match(/'EUR'/g) ?? [];
    expect(eur.length).toBeGreaterThanOrEqual(3);
  });

  it("21. gebruikt source_type sales_invoice en de factuur-id als source_id", () => {
    const st = fn.match(/'sales_invoice', v_inv\.id, NULL/g) ?? [];
    expect(st.length).toBeGreaterThanOrEqual(3);
  });

  it("22. is SECURITY DEFINER met vast search_path, zonder PUBLIC- of service_role-rechten", () => {
    expect(fn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(fn.slice(0, 300)).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.post_sales_invoice\(uuid\) FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_sales_invoice\(uuid\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO anon/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO service_role/);
  });

  it("23. neemt de rijgrendel vóór het lezen van boekingsfeiten", () => {
    expect(fn).toMatch(/FROM public\.sales_invoices WHERE id = _invoice_id FOR UPDATE;/);
  });

  it("24. weigert negatieve of nulbedragen (creditnota's)", () => {
    expect(fn).toMatch(/v_inv\.amount_excl < 0 OR v_btw < 0 OR v_inv\.amount_incl <= 0/);
    expect(fn).toMatch(/creditnota vereist een tegenboeking/);
  });
});

describe("Migratie — bronidempotentie op ledger_postings zelf", () => {
  const claimFn = sql.slice(sql.indexOf("FUNCTION public.enforce_sales_source_claim"));

  it("25. bewaakt verkoopregels rechtstreeks op ledger_postings", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.enforce_sales_source_claim/);
    expect(sql).toMatch(
      /CREATE TRIGGER validate_sales_source_claim_trigger\s+BEFORE INSERT ON public\.ledger_postings/,
    );
  });

  it("26. blijft strikt beperkt tot source_type = sales_invoice", () => {
    expect(claimFn).toMatch(/IF NEW\.source_type <> 'sales_invoice' THEN\s+RETURN NEW;/);
  });

  it("27. eist een marker en exact dezelfde boekingsgroep, organisatie en administratie", () => {
    expect(claimFn).toMatch(/NEW\.source_id IS NULL/);
    expect(claimFn).toMatch(/FROM public\.sales_invoice_postings\s+WHERE sales_invoice_id = NEW\.source_id/);
    expect(claimFn).toMatch(/NEW\.posting_group_id <> v_marker\.posting_group_id/);
    expect(claimFn).toMatch(/NEW\.organization_id IS DISTINCT FROM v_marker\.organization_id/);
    expect(claimFn).toMatch(/NEW\.client_id IS DISTINCT FROM v_marker\.client_id/);
  });
});

describe("Migratie — geboekte bron is bevroren", () => {
  const hdr = sql.slice(sql.indexOf("FUNCTION public.prevent_posted_sales_invoice_mutation"));

  it("28. bevriest de boekhoudkundige headervelden zodra er een marker is", () => {
    for (const field of [
      "client_id", "organization_id", "customer_name", "invoice_number",
      "invoice_date", "amount_excl", "btw_amount", "amount_incl", "btw_percentage",
      "btw_verlegd", "grootboekrekening_id", "ledger_account_text",
    ]) {
      expect(hdr).toContain(`NEW.${field}`);
    }
  });

  it("29. laat betaal- en workflowvelden bewust vrij", () => {
    for (const allowed of ["status", "due_date", "remaining_amount", "notes", "pdf_path"]) {
      expect(hdr).not.toMatch(new RegExp(`NEW\\.${allowed}\\s+IS DISTINCT FROM`));
    }
  });

  it("30. heeft geen regel-mutatiebewaker — sales heeft geen regels", () => {
    expect(sql).not.toMatch(/sales_invoice_lines/);
    expect(sql).not.toMatch(/prevent_posted_sales_line_mutation/);
  });
});

describe("Migratie — scope en veiligheid", () => {
  it("31. voert geen historische backfill uit", () => {
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings[\s\S]{0,200}SELECT[\s\S]{0,200}FROM public\.sales_invoices/);
    expect(sql).not.toMatch(/INSERT INTO public\.sales_invoice_postings[\s\S]{0,120}SELECT/);
  });

  it("32. raakt geen bestaande tabellen, geen purchase- en geen 6C-b2/b2a-migratie aan", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["sales_invoice_postings"]));
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE/);
    expect(sql).not.toMatch(/purchase_invoice/);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(posting_account_ok|has_min_role|ledger_link_org_ok|set_organization_id|post_purchase_invoice)/,
    );
  });

  it("33. definieert precies de drie eigen functies en niets meer", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fns)).toEqual(new Set([
      "post_sales_invoice",
      "enforce_sales_source_claim",
      "prevent_posted_sales_invoice_mutation",
    ]));
  });

  it("34. is idempotent herhaalbaar", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).toMatch(/FROM pg_constraint c/);
  });

  it("35. documenteert een rollback", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.post_sales_invoice\(uuid\);/);
    expect(raw).toMatch(/DROP TABLE IF EXISTS public\.sales_invoice_postings;/);
  });

  it("36. documenteert de bewust niet-ondersteunde gevallen", () => {
    expect(raw).toMatch(/[Cc]redit note|creditnota/);
    expect(raw).toMatch(/[Vv]erlegde BTW/);
  });
});
