import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Direct geboekte bankregels (post_bank_transaction).
 *
 * Structurele tests: ze bewijzen wat de migratie ZEGT. De semantiek wordt
 * server-side afgedwongen door de writer, de source claim en de bevriezing.
 */

const MIGRATION =
  "supabase/migrations/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const claimFn = sql.slice(
  sql.indexOf("FUNCTION public.enforce_bank_transaction_source_claim"),
  sql.indexOf("FUNCTION public.prevent_posted_bank_transaction_mutation"),
);
const guardFn = sql.slice(
  sql.indexOf("FUNCTION public.prevent_posted_bank_transaction_mutation"),
  sql.indexOf("FUNCTION public.post_bank_transaction"),
);
const writer = sql.slice(sql.indexOf("FUNCTION public.post_bank_transaction"));

describe("markertabel bank_transaction_postings", () => {
  it("heeft de transactie-id als primaire sleutel (idempotentie)", () => {
    expect(sql).toMatch(/bank_transaction_id uuid PRIMARY KEY/);
  });

  it("is alleen leesbaar voor organisatieleden en niet schrijfbaar vanaf de client", () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.bank_transaction_postings TO authenticated/);
    expect(sql).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE)[^;]*ON public\.bank_transaction_postings TO authenticated/,
    );
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)/);
  });
});

describe("writer post_bank_transaction", () => {
  it("draait als security definer met vaste search_path", () => {
    expect(writer).toMatch(/SECURITY DEFINER/);
    expect(writer).toMatch(/SET search_path = public/);
  });

  it("eist minimaal de rol assistant binnen de organisatie", () => {
    expect(writer).toMatch(/has_min_role\(v_uid, v_tx\.organization_id, 'assistant'\)/);
  });

  it("boekt alleen handmatig gecodeerde regels zonder factuurkoppeling", () => {
    expect(writer).toMatch(/v_tx\.match_status <> 'handmatig_geboekt'/);
    expect(writer).toMatch(/FROM public\.bank_transaction_allocations WHERE bank_transaction_id/);
  });

  it("weigert een afgesloten boekjaar", () => {
    expect(writer).toMatch(/afgesloten_boekjaar/);
  });

  it("valideert bank- en tegenrekening tegen organisatie en administratie", () => {
    expect(writer).toMatch(/posting_account_ok\(v_client\.bank_rekening_id/);
    expect(writer).toMatch(/posting_account_ok\(v_tx\.grootboekrekening_id/);
  });

  it("splitst BTW uit het brutobedrag en boekt nooit BTW voor vrijgestelde administraties", () => {
    expect(writer).toMatch(/v_client\.btw_vrijgesteld THEN 0/);
    expect(writer).toMatch(/v_net\s*:= round\(v_gross \/ \(1 \+ v_pct \/ 100\), 2\)/);
    expect(writer).toMatch(/v_btw\s*:= v_gross - v_net/);
  });

  it("kiest te vorderen bij uitgaand geld en te betalen bij inkomend geld", () => {
    expect(writer).toMatch(
      /CASE WHEN v_tx\.amount < 0\s*\n?\s*THEN v_client\.btw_te_vorderen_rekening_id\s*\n?\s*ELSE v_client\.btw_te_betalen_rekening_id END/,
    );
  });

  it("claimt de marker vóór de grootboekregels en weigert dubbel boeken", () => {
    const markerIndex = writer.indexOf("INSERT INTO public.bank_transaction_postings");
    const postingIndex = writer.indexOf("INSERT INTO public.ledger_postings");
    expect(markerIndex).toBeGreaterThan(-1);
    expect(postingIndex).toBeGreaterThan(markerIndex);
    expect(writer).toMatch(/Deze banktransactie is al geboekt/);
  });

  it("neemt datum en boekjaar uit de banktransactie", () => {
    expect(writer).toMatch(/EXTRACT\(YEAR FROM v_tx\.transaction_date\)/);
    expect(writer).not.toMatch(/CURRENT_DATE/);
  });
});

describe("source claim en bevriezing", () => {
  it("staat geen losse grootboekregels toe voor een bankregel", () => {
    expect(claimFn).toMatch(
      /Deze banktransactie is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan/,
    );
    expect(sql).toMatch(/CREATE TRIGGER validate_bank_transaction_source_claim_trigger/);
  });

  it("bindt elke regel aan de geboekte groep, organisatie, administratie en datum", () => {
    expect(claimFn).toMatch(/NEW\.posting_group_id <> v_marker\.posting_group_id/);
    expect(claimFn).toMatch(/NEW\.organization_id IS DISTINCT FROM v_marker\.organization_id/);
    expect(claimFn).toMatch(/NEW\.posting_date IS DISTINCT FROM v_marker\.posting_date/);
  });

  it("laat hooguit drie regels toe met bruto-, netto- of BTW-bedrag", () => {
    expect(claimFn).toMatch(/NEW\.line_no NOT IN \(1, 2, 3\)/);
    expect(claimFn).toMatch(/v_marker\.gross_amount, v_marker\.net_amount, v_marker\.btw_amount/);
  });

  it("bevriest een geboekte bankregel voor wijzigen en verwijderen", () => {
    expect(guardFn).toMatch(/bank_transaction_postings WHERE bank_transaction_id = OLD\.id/);
    expect(guardFn).toMatch(/verwijderen is niet mogelijk/);
    expect(guardFn).toMatch(/NEW\.grootboekrekening_id IS DISTINCT FROM OLD\.grootboekrekening_id/);
    expect(guardFn).toMatch(/NEW\.btw_percentage\s+IS DISTINCT FROM OLD\.btw_percentage/);
  });

  it("laat bestaande afletterboekingen ongemoeid", () => {
    expect(guardFn).toMatch(/bank_allocation_postings WHERE bank_transaction_id = OLD\.id/);
  });
});
