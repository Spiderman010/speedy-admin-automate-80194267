import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b5b — bankafletteringen (bank settlement writer).
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. De semantiek (balans, idempotentie, rollback, rechten,
 * onveranderlijkheid en gelijktijdigheid) is bewezen met echte
 * PostgreSQL-probes op een wegwerpcluster; zie de PR.
 */

const MIGRATION = "supabase/migrations/20260917120000_add_bank_settlement_posting.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const fn = sql.slice(
  sql.indexOf("FUNCTION public.post_bank_allocation"),
  sql.indexOf("FUNCTION public.enforce_bank_source_claim"),
);
const claimFn = sql.slice(
  sql.indexOf("FUNCTION public.enforce_bank_source_claim"),
  sql.indexOf("FUNCTION public.prevent_posted_bank_allocation_mutation"),
);
const allocGuard = sql.slice(
  sql.indexOf("FUNCTION public.prevent_posted_bank_allocation_mutation"),
  sql.indexOf("FUNCTION public.prevent_posted_bank_transaction_mutation"),
);
const txGuard = sql.slice(sql.indexOf("FUNCTION public.prevent_posted_bank_transaction_mutation"));

describe("Migratie — claimtabel", () => {
  it("1. maakt bank_allocation_postings met de koppeling-id als primary key en unieke boekingsgroep", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.bank_allocation_postings/);
    expect(sql).toMatch(/allocation_id\s+uuid\s+PRIMARY KEY/);
    expect(sql).toMatch(/posting_group_id\s+uuid\s+NOT NULL UNIQUE/);
  });

  it("2. legt richting en bedrag van de claim vast met CHECKs", () => {
    expect(sql).toMatch(/invoice_type\s+text\s+NOT NULL CHECK \(invoice_type IN \('inkoop', 'verkoop'\)\)/);
    expect(sql).toMatch(/amount\s+numeric\(12,2\) NOT NULL CHECK \(amount > 0\)/);
    for (const col of ["organization_id", "client_id", "bank_transaction_id", "invoice_id", "user_id"]) {
      expect(sql).toMatch(new RegExp(`${col}\\s+uuid\\s+NOT NULL`));
    }
  });

  it("3. verankert alle vijf verwijzingen met ON DELETE RESTRICT, nooit CASCADE", () => {
    const restricts = sql.match(/ON DELETE RESTRICT/g) ?? [];
    expect(restricts).toHaveLength(5);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
    for (const col of ["allocation_id", "bank_transaction_id", "organization_id", "client_id", "user_id"]) {
      expect(sql).toMatch(new RegExp(`ADD CONSTRAINT bank_allocation_postings_${col}_fkey`));
    }
    expect(sql).toMatch(/FOREIGN KEY \(allocation_id\) REFERENCES public\.bank_transaction_allocations \(id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(bank_transaction_id\) REFERENCES public\.bank_transactions \(id\)/);
  });

  it("4. heeft de vier indexen", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_organization/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_client/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_bank_transaction/);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_invoice\s+ON public\.bank_allocation_postings \(invoice_type, invoice_id\)/,
    );
  });

  it("5. is alleen leesbaar voor applicatierollen (RLS + select-policy)", () => {
    expect(sql).toMatch(/ALTER TABLE public\.bank_allocation_postings ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(
      /CREATE POLICY role_bank_allocation_postings_select ON public\.bank_allocation_postings\s+FOR SELECT TO authenticated\s+USING \(public\.has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)\)/,
    );
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*FOR (INSERT|UPDATE|DELETE)/);
  });

  it("6. reset alle rechten met REVOKE ALL in plaats van een opsomming", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.bank_allocation_postings FROM anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.bank_allocation_postings TO authenticated, service_role;/);
    expect(sql).not.toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER/);
  });
});

describe("Migratie — de writer", () => {
  it("7. accepteert uitsluitend de koppeling-id en is SECURITY DEFINER met vast search_path", () => {
    const signature = /CREATE OR REPLACE FUNCTION public\.post_bank_allocation\(([^)]*)\)/.exec(sql);
    expect(signature).not.toBeNull();
    expect((signature as RegExpExecArray)[1].trim()).toBe("_allocation_id uuid");
    expect(fn.slice(0, 300)).toMatch(/RETURNS uuid/);
    expect(fn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(fn.slice(0, 300)).toMatch(/SET search_path = public/);
  });

  it("8. trekt EXECUTE expliciet in van PUBLIC, anon, authenticated en service_role en geeft alleen authenticated terug", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_bank_allocation\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_bank_allocation\(uuid\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO anon/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO service_role/);
  });

  it("9. bepaalt gebruiker, organisatie en administratie server-side en faalt gesloten op NULL organisatie", () => {
    expect(fn).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    expect(fn).toMatch(/IF v_uid IS NULL THEN/);
    expect(fn).toMatch(/v_alloc\.organization_id IS NULL\s+OR NOT public\.has_min_role\(v_uid, v_alloc\.organization_id, 'assistant'\)/);
    expect(fn).toMatch(/v_tx\.client_id <> v_alloc\.client_id\s+OR v_tx\.organization_id IS DISTINCT FROM v_alloc\.organization_id/);
    expect(fn).toMatch(/v_client\.organization_id IS DISTINCT FROM v_alloc\.organization_id/);
    expect(fn).toMatch(/v_inv_client_id <> v_alloc\.client_id\s+OR v_inv_org_id IS DISTINCT FROM v_alloc\.organization_id/);
    expect(fn).toMatch(/v_group_id\s+uuid := gen_random_uuid\(\)/);
    expect(fn).not.toMatch(/created_xact_id/);
  });

  it("10. volgt de grendelvolgorde: FOR UPDATE op de koppeling, dan FOR UPDATE op de banktransactie, dan FOR SHARE op de factuur", () => {
    const allocLock = fn.search(/FROM public\.bank_transaction_allocations\s+WHERE id = _allocation_id\s+FOR UPDATE;/);
    const txLock = fn.search(/FROM public\.bank_transactions\s+WHERE id = v_alloc\.bank_transaction_id\s+FOR UPDATE;/);
    const purchaseLock = fn.search(/FROM public\.purchase_invoices\s+WHERE id = v_alloc\.invoice_id\s+FOR SHARE;/);
    const salesLock = fn.search(/FROM public\.sales_invoices\s+WHERE id = v_alloc\.invoice_id\s+FOR SHARE;/);
    expect(allocLock).toBeGreaterThan(-1);
    expect(txLock).toBeGreaterThan(allocLock);
    expect(purchaseLock).toBeGreaterThan(txLock);
    expect(salesLock).toBeGreaterThan(txLock);
    // Claim en grootboekregels komen ná alle grendels en leesacties.
    expect(fn.indexOf("INSERT INTO public.bank_allocation_postings")).toBeGreaterThan(Math.max(purchaseLock, salesLock));
    expect(fn.indexOf("INSERT INTO public.bank_allocation_postings"))
      .toBeLessThan(fn.indexOf("INSERT INTO public.ledger_postings"));
  });

  it("11. eist dat de bronfactuur al een boekingsmarker heeft — status bewijst niets", () => {
    expect(fn).toMatch(/SELECT 1 FROM public\.purchase_invoice_postings WHERE purchase_invoice_id = v_alloc\.invoice_id/);
    expect(fn).toMatch(/SELECT 1 FROM public\.sales_invoice_postings WHERE sales_invoice_id = v_alloc\.invoice_id/);
    expect(fn).toMatch(/Inkoopfactuur is nog niet geboekt in het grootboek/);
    expect(fn).toMatch(/Verkoopfactuur is nog niet geboekt in het grootboek/);
    expect(fn).not.toMatch(/\.status/);
  });

  it("12. controleert de richting tegen het teken van de banktransactie (inkoop < 0, verkoop > 0)", () => {
    expect(fn).toMatch(/IF v_tx\.amount >= 0 THEN\s+RAISE EXCEPTION 'Een inkoopkoppeling vereist een uitgaande banktransactie'/);
    expect(fn).toMatch(/IF v_tx\.amount <= 0 THEN\s+RAISE EXCEPTION 'Een verkoopkoppeling vereist een inkomende banktransactie'/);
    expect(fn).toMatch(/Onbekend koppelingstype: %/);
  });

  it("13. eist de geconfigureerde rekeningen en verzint er nooit een", () => {
    expect(fn).toMatch(/v_client\.bank_rekening_id IS NULL/);
    expect(fn).toMatch(/v_client\.debiteuren_rekening_id IS NULL/);
    expect(fn).toMatch(/v_client\.crediteuren_rekening_id IS NULL/);
    expect(fn).toMatch(/Geen bankrekening \(grootboek\) ingesteld voor deze administratie/);
    const scopeChecks = fn.match(/posting_account_ok\(/g) ?? [];
    expect(scopeChecks).toHaveLength(3); // bank, debiteuren, crediteuren
    expect(fn).toMatch(/posting_account_ok\(v_client\.bank_rekening_id, v_alloc\.organization_id, v_alloc\.client_id\)/);
  });

  it("14. gebruikt nooit bank_dagboek, 1100, ledger_account_id of de tegenrekening van de banktransactie", () => {
    expect(sql).not.toMatch(/bank_dagboek/);
    expect(sql).not.toMatch(/\b1100\b/);
    expect(sql).not.toMatch(/ledger_account_id/);
    expect(sql).not.toMatch(/v_tx\.grootboekrekening_id/);
    expect(sql).not.toMatch(/categorie/);
    expect(fn).not.toMatch(/\b(1000|1300|1600|1799)\b/);
  });

  it("15. boekt verkoop als DEBET bank / CREDIT debiteuren en inkoop als DEBET crediteuren / CREDIT bank", () => {
    expect(fn).toMatch(
      /v_debit_account\s+:= v_client\.bank_rekening_id;\s+v_credit_account := v_client\.debiteuren_rekening_id;/,
    );
    expect(fn).toMatch(
      /v_debit_account\s+:= v_client\.crediteuren_rekening_id;\s+v_credit_account := v_client\.bank_rekening_id;/,
    );
    // Regel 1 debet, regel 2 credit, beide met het koppelingsbedrag als-is.
    expect(fn).toMatch(/v_debit_account, v_group_id, v_line_no,\s+v_tx\.transaction_date, v_boekjaar, v_alloc\.amount, 0, 'EUR'/);
    expect(fn).toMatch(/v_credit_account, v_group_id, v_line_no,\s+v_tx\.transaction_date, v_boekjaar, 0, v_alloc\.amount, 'EUR'/);
    const inserts = fn.match(/INSERT INTO public\.ledger_postings/g) ?? [];
    expect(inserts).toHaveLength(2);
    // Geen omzet-, kosten-, BTW- of betalingsverschilpoot: de enige rekeningen
    // die een grootboekregel voeden zijn v_debit_account / v_credit_account.
    expect(fn).not.toMatch(/btw_te_(vorderen|betalen)_rekening_id/);
    expect(fn).not.toMatch(/v_inv\.grootboekrekening_id|v_line\./);
    expect(fn).not.toMatch(/betalingsverschil|suspense|1799/i);
    const legAccounts = [...fn.matchAll(/\) VALUES \(\s+v_alloc\.organization_id, v_alloc\.client_id, (\w+),/g)].map((m) => m[1]);
    expect(legAccounts).toEqual(["v_debit_account", "v_credit_account"]);
  });

  it("16. gebruikt source_type bank_allocation, de koppeling-id als source_id en NULL als regel-id, altijd in EUR", () => {
    const st = fn.match(/'bank_allocation', v_alloc\.id, NULL, v_uid/g) ?? [];
    expect(st).toHaveLength(2);
    const eur = fn.match(/'EUR'/g) ?? [];
    expect(eur).toHaveLength(2);
  });

  it("17. neemt de boekingsdatum van de banktransactie en nooit van de factuur of van de klok", () => {
    expect(fn).toMatch(/EXTRACT\(YEAR FROM v_tx\.transaction_date\)/);
    expect(fn).not.toMatch(/invoice_date/);
    expect(fn).not.toMatch(/created_at/);
    expect(fn).not.toMatch(/now\(\)/);
    expect(fn).not.toMatch(/current_date/i);
  });

  it("18. weigert boeken in een afgesloten boekjaar", () => {
    expect(fn).toMatch(/v_boekjaar <= v_client\.afgesloten_boekjaar/);
    expect(fn).toMatch(/Boekjaar % is afgesloten voor deze administratie/);
  });

  it("19. weigert overallocatie en overbetaling op alle vier de manieren, exact en zonder tolerantie", () => {
    expect(fn).toMatch(/IF v_alloc\.amount <= 0 THEN/);
    expect(fn).toMatch(/IF v_alloc\.amount > abs\(v_tx\.amount\) THEN/);
    expect(fn).toMatch(/SELECT COALESCE\(SUM\(amount\), 0\) INTO v_sum_tx\s+FROM public\.bank_transaction_allocations\s+WHERE bank_transaction_id = v_tx\.id;/);
    expect(fn).toMatch(/IF v_sum_tx > abs\(v_tx\.amount\) THEN/);
    expect(fn).toMatch(/IF v_inv_amount_incl IS NULL THEN/);
    expect(fn).toMatch(/IF v_alloc\.amount > v_inv_amount_incl THEN/);
    expect(fn).toMatch(
      /SELECT COALESCE\(SUM\(amount\), 0\) INTO v_sum_inv\s+FROM public\.bank_transaction_allocations\s+WHERE invoice_type = v_alloc\.invoice_type\s+AND invoice_id = v_alloc\.invoice_id;/,
    );
    expect(fn).toMatch(/IF v_sum_inv > v_inv_amount_incl THEN/);
    expect(fn).toMatch(/een overbetaling wordt nog niet ondersteund/);
    expect(fn).not.toMatch(/tolerance|0\.001|0\.01|LEAST\(|GREATEST\(|round\(/i);
  });

  it("20. claimt de koppeling vóór het schrijven van grootboekregels en vertaalt de dubbele claim", () => {
    expect(fn).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    expect(fn).toMatch(/Deze bankkoppeling is al geboekt/);
    expect(fn).toMatch(
      /INSERT INTO public\.bank_allocation_postings \(\s+allocation_id, posting_group_id, organization_id, client_id,\s+bank_transaction_id, invoice_id, invoice_type, amount, user_id\s+\)/,
    );
  });
});

describe("Migratie — bronidempotentie op ledger_postings zelf", () => {
  it("21. bewaakt afletteringsregels rechtstreeks op ledger_postings", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.enforce_bank_source_claim/);
    expect(sql).toMatch(
      /CREATE TRIGGER validate_bank_source_claim_trigger\s+BEFORE INSERT ON public\.ledger_postings/,
    );
  });

  it("22. blijft strikt beperkt tot source_type = bank_allocation", () => {
    expect(claimFn).toMatch(/IF NEW\.source_type <> 'bank_allocation' THEN\s+RETURN NEW;/);
    expect(claimFn).not.toMatch(/'sales_invoice'|'purchase_invoice'/);
  });

  it("23. eist een marker en exact dezelfde boekingsgroep, organisatie en administratie", () => {
    expect(claimFn).toMatch(/NEW\.source_id IS NULL/);
    expect(claimFn).toMatch(/FROM public\.bank_allocation_postings\s+WHERE allocation_id = NEW\.source_id/);
    expect(claimFn).toMatch(/NEW\.posting_group_id <> v_marker\.posting_group_id/);
    expect(claimFn).toMatch(/NEW\.organization_id IS DISTINCT FROM v_marker\.organization_id/);
    expect(claimFn).toMatch(/NEW\.client_id IS DISTINCT FROM v_marker\.client_id/);
    expect(claimFn).toMatch(/NEW\.grootboekrekening_id IS NULL/);
  });
});

describe("Migratie — geboekte koppeling is bevroren", () => {
  it("24. gebruikt expliciete TG_OP-takken en nooit COALESCE(NEW", () => {
    expect(allocGuard).toMatch(/IF TG_OP = 'DELETE' THEN/);
    expect(allocGuard).toMatch(/RETURN OLD;/);
    expect(allocGuard).not.toMatch(/COALESCE\(NEW/);
    expect(sql).toMatch(
      /CREATE TRIGGER prevent_posted_bank_allocation_mutation_trigger\s+BEFORE UPDATE OR DELETE ON public\.bank_transaction_allocations/,
    );
  });

  it("25. bevriest precies de acht boekhoudkundige velden en weigert verwijderen", () => {
    for (const field of [
      "id", "amount", "bank_transaction_id", "client_id",
      "invoice_id", "invoice_type", "organization_id", "user_id",
    ]) {
      expect(allocGuard).toMatch(new RegExp(`NEW\\.${field}\\s+IS DISTINCT FROM OLD\\.${field}`));
    }
    expect(allocGuard).toMatch(/verwijderen is niet mogelijk\. Een correctie vereist een tegenboeking\./);
    expect(allocGuard).toMatch(/boekhoudkundige gegevens kunnen niet meer worden gewijzigd/);
  });

  it("26. laat created_at en updated_at vrij", () => {
    expect(allocGuard).not.toMatch(/NEW\.updated_at/);
    expect(allocGuard).not.toMatch(/NEW\.created_at/);
  });

  it("27. weigert het verplaatsen van een ongeboekte rij naar een geboekte identiteit", () => {
    expect(allocGuard).toMatch(
      /IF NEW\.id IS DISTINCT FROM OLD\.id AND EXISTS \(\s+SELECT 1 FROM public\.bank_allocation_postings WHERE allocation_id = NEW\.id/,
    );
  });
});

describe("Migratie — banktransactie met geboekte aflettering is bevroren", () => {
  it("28. bevriest precies id, amount, transaction_date, client_id, organization_id en user_id", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER prevent_posted_bank_transaction_mutation_trigger\s+BEFORE UPDATE OR DELETE ON public\.bank_transactions/,
    );
    expect(txGuard).toMatch(/WHERE bank_transaction_id = OLD\.id/);
    const frozen = [...txGuard.matchAll(/NEW\.(\w+)\s+IS DISTINCT FROM OLD\.\1/g)].map((m) => m[1]);
    expect(new Set(frozen)).toEqual(new Set(["id", "amount", "transaction_date", "client_id", "organization_id", "user_id"]));
    expect(frozen).toHaveLength(6);
  });

  it("29. laat omschrijving, referentie, matchvelden, tegenrekening en legacy-koppeling vrij", () => {
    for (const free of [
      "description", "reference", "counter_account", "camt_ustrd", "camt_addtl_ntry_inf",
      "camt_counterparty_name", "match_status", "match_confidence", "matched_invoice_id",
      "grootboekrekening_id", "ledger_account_id",
    ]) {
      expect(txGuard).not.toMatch(new RegExp(`NEW\\.${free}\\b`));
    }
  });

  it("30. weigert verwijderen (waardoor de cascade naar koppelingen nooit een geboekte koppeling raakt)", () => {
    expect(txGuard).toMatch(/IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION 'Deze banktransactie heeft een geboekte aflettering; verwijderen is niet mogelijk/);
  });
});

describe("Migratie — scope en veiligheid", () => {
  it("31. trekt elke triggerfunctie in van PUBLIC", () => {
    for (const f of [
      "enforce_bank_source_claim",
      "prevent_posted_bank_allocation_mutation",
      "prevent_posted_bank_transaction_mutation",
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(\\) FROM PUBLIC;`));
    }
  });

  it("32. voert geen historische backfill uit en boekt niets automatisch", () => {
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings[\s\S]{0,200}SELECT[\s\S]{0,200}FROM public\.bank_transaction/);
    expect(sql).not.toMatch(/INSERT INTO public\.bank_allocation_postings[\s\S]{0,160}SELECT/);
    expect(sql).not.toMatch(/AFTER INSERT ON public\.bank_transaction_allocations/);
  });

  it("33. raakt geen bestaande tabellen en geen inkoop-/verkoopwriter aan", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["bank_allocation_postings"]));
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE/);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(posting_account_ok|has_min_role|ledger_link_org_ok|set_organization_id|post_purchase_invoice|post_sales_invoice|enforce_sales_source_claim|enforce_purchase_source_claim)/,
    );
  });

  it("34. definieert precies de vier eigen functies en niets meer", () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(fns)).toEqual(new Set([
      "post_bank_allocation",
      "enforce_bank_source_claim",
      "prevent_posted_bank_allocation_mutation",
      "prevent_posted_bank_transaction_mutation",
    ]));
  });

  it("35. is idempotent herhaalbaar", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).toMatch(/FROM pg_constraint c/);
    const dropTriggers = sql.match(/DROP TRIGGER IF EXISTS/g) ?? [];
    const createTriggers = sql.match(/CREATE TRIGGER/g) ?? [];
    expect(dropTriggers).toHaveLength(3);
    expect(createTriggers).toHaveLength(3);
  });

  it("36. documenteert een volledige rollback", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.post_bank_allocation\(uuid\);/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.enforce_bank_source_claim\(\);/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.prevent_posted_bank_allocation_mutation\(\);/);
    expect(raw).toMatch(/DROP FUNCTION IF EXISTS public\.prevent_posted_bank_transaction_mutation\(\);/);
    expect(raw).toMatch(/DROP TRIGGER IF EXISTS validate_bank_source_claim_trigger ON public\.ledger_postings;/);
    expect(raw).toMatch(/DROP TRIGGER IF EXISTS prevent_posted_bank_allocation_mutation_trigger ON public\.bank_transaction_allocations;/);
    expect(raw).toMatch(/DROP TRIGGER IF EXISTS prevent_posted_bank_transaction_mutation_trigger ON public\.bank_transactions;/);
    expect(raw).toMatch(/DROP TABLE IF EXISTS public\.bank_allocation_postings;/);
  });

  it("37. documenteert de bewijzen, de grendelvolgorde en het bewust niet bevriezen van bank_rekening_id", () => {
    expect(raw).toMatch(/Bank\.tsx:111/);
    expect(raw).toMatch(/ledger-mutations\.ts:345/);
    expect(raw).toMatch(/snelstart-export\.ts:268/);
    expect(raw).toMatch(/LOCK ORDER/);
    expect(raw).toMatch(/KEY SHARE/);
    expect(raw).toMatch(/bank_rekening_id is deliberately NOT frozen/);
    expect(raw).toMatch(/NO BACKFILL/);
    expect(raw).toMatch(/overbetaling|overpayment/i);
  });

  // Reviewer-findings (onafhankelijke tweede lezing) — hieronder vastgelegd
  // zodat ze niet stilzwijgend kunnen terugkeren.
  it("38. weigert te draaien zolang 6C-b2/b3/b4/b5a niet zijn toegepast (voorwaardenguard vóór het eerste object)", () => {
    const guard = sql.slice(0, sql.indexOf("CREATE TABLE IF NOT EXISTS public.bank_allocation_postings"));
    expect(guard).toMatch(/to_regclass\('public\.ledger_postings'\) IS NULL/);
    expect(guard).toMatch(/to_regclass\('public\.purchase_invoice_postings'\) IS NULL/);
    expect(guard).toMatch(/to_regclass\('public\.sales_invoice_postings'\) IS NULL/);
    expect(guard).toMatch(/column_name = 'bank_rekening_id'/);
    expect((guard.match(/RAISE EXCEPTION 'Migratie 6C-b5b vereist eerst/g) ?? []).length).toBe(4);
  });

  it("39. de claimtrigger dwingt precies twee regels af, elk met exact het afgeletterde bedrag op één zijde", () => {
    // Zonder dit kon een raw-SQL-aanroeper binnen dezelfde transactie extra
    // sluitende regels (bv. DR omzet / CR bank) onder de geclaimde groep hangen
    // en een aflettering stilletjes in een omzetboeking veranderen.
    expect(claimFn).toMatch(/NEW\.line_no NOT IN \(1, 2\)/);
    expect(claimFn).toMatch(/NEW\.debit_amount = v_marker\.amount AND NEW\.credit_amount = 0/);
    expect(claimFn).toMatch(/NEW\.credit_amount = v_marker\.amount AND NEW\.debit_amount = 0/);
    expect(claimFn).toMatch(/precies twee regels/);
  });

  it("40. beschrijft het enige deadlock-pad eerlijk in plaats van 'geen cyclus' te claimen", () => {
    expect(raw).not.toMatch(/Why there is no lock cycle/);
    expect(raw).toMatch(/DELETE FROM bank_transactions/);
    expect(raw).toMatch(/40P01/);
    expect(raw).toMatch(/never an accounting one/);
  });
});
