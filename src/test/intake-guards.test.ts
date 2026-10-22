// Gedragstests van de pure beslislogica van de OCR-intake
// (supabase/functions/{process-invoice,process-sales-invoice}/intake-guards.ts).
// Nulmeting: A2-01/A1-20/B2-04/C-13 (onbekend bedrag ⇒ "Betaald"), A2-06/B2-01
// (rolcheck), A2-11 (verzonnen nummer/datum), B2-05 (deterministische validatie),
// NM-02 kanaal 1 (0 % wordt NULL).
import { describe, expect, it, vi } from "vitest";
import * as purchase from "../../supabase/functions/process-invoice/intake-guards";
import * as sales from "../../supabase/functions/process-sales-invoice/intake-guards";
import { getInvoicePaymentState } from "@/lib/invoice-balances";

const NOW = new Date("2026-10-21T12:00:00Z");
const USER = "00000000-0000-4000-8000-0000000000e1";
const ORG = "00000000-0000-4000-8000-00000000a001";
const CLIENT = "00000000-0000-4000-8000-00000000c001";

function rpcClient(result: { data: unknown; error: unknown } | (() => never)) {
  return {
    rpc: vi.fn((_fn: string, _args: Record<string, unknown>) =>
      typeof result === "function" ? result() : Promise.resolve(result),
    ),
  };
}

const purchaseCtx = {
  userId: USER, clientId: CLIENT, organizationId: ORG,
  filePath: `${USER}/${CLIENT}/f.pdf`, supplierBtwNumber: null, now: NOW,
};
const salesCtx = { userId: USER, clientId: CLIENT, organizationId: ORG, filePath: `${USER}/sales/${CLIENT}/f.pdf`, now: NOW };

describe("rolvloeren van de intake", () => {
  it("inkoop eist assistant (= role_purchase_invoices_insert), verkoop fail-closed owner (= role_sales_invoices_insert, D2 open)", () => {
    expect(purchase.PURCHASE_WRITE_MIN_ROLE).toBe("assistant");
    expect(sales.SALES_WRITE_MIN_ROLE).toBe("owner");
  });
});

// Dezelfde gevallen tegen beide kopieën van het gedeelde blok.
describe.each([
  ["process-invoice", purchase],
  ["process-sales-invoice", sales],
] as const)("authorizeIntakeWrite (%s)", (_name, mod) => {
  it("vraagt has_min_role met de gebruiker, de organisatie uit de klantrij en de vloer", async () => {
    const client = rpcClient({ data: true, error: null });
    await expect(mod.authorizeIntakeWrite(client, USER, ORG, "assistant")).resolves.toEqual({ allowed: true });
    expect(client.rpc).toHaveBeenCalledWith("has_min_role", { _user_id: USER, _organization_id: ORG, _min: "assistant" });
  });

  it("weigert met 403 en een neutrale melding als de rol te laag is", async () => {
    const decision = await mod.authorizeIntakeWrite(rpcClient({ data: false, error: null }), USER, ORG, "owner");
    expect(decision).toEqual({ allowed: false, status: 403, error: mod.INTAKE_FORBIDDEN_MESSAGE });
  });

  it.each([
    ["null", null],
    ["de tekst 'true'", "true"],
    ["1", 1],
    ["een object", { ok: true }],
  ])("geeft alleen bij een expliciete true toegang (data = %s ⇒ 403)", async (_label, data) => {
    const decision = await mod.authorizeIntakeWrite(rpcClient({ data, error: null }), USER, ORG, "assistant");
    expect(decision).toMatchObject({ allowed: false, status: 403 });
  });

  it("is fail-closed bij een rpc-fout of een uitzondering (500, niets toegestaan)", async () => {
    await expect(mod.authorizeIntakeWrite(rpcClient({ data: true, error: { message: "x" } }), USER, ORG, "assistant"))
      .resolves.toEqual({ allowed: false, status: 500, error: mod.INTAKE_ROLE_CHECK_FAILED_MESSAGE });
    const throwing = rpcClient(() => { throw new Error("netwerk"); });
    await expect(mod.authorizeIntakeWrite(throwing, USER, ORG, "assistant"))
      .resolves.toEqual({ allowed: false, status: 500, error: mod.INTAKE_ROLE_CHECK_FAILED_MESSAGE });
  });

  it("weigert zonder gebruiker of organisatie, zonder de database te raadplegen", async () => {
    const client = rpcClient({ data: true, error: null });
    await expect(mod.authorizeIntakeWrite(client, USER, null, "assistant")).resolves.toMatchObject({ allowed: false, status: 403 });
    await expect(mod.authorizeIntakeWrite(client, "", ORG, "assistant")).resolves.toMatchObject({ allowed: false, status: 403 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe.each([
  ["process-invoice", purchase],
  ["process-sales-invoice", sales],
] as const)("validatie van de extractie (%s)", (_name, mod) => {
  it("parseAmount: 0 blijft 0, afwezig wordt null, onzin wordt null én een bevinding", () => {
    expect(mod.parseAmount(0)).toEqual({ value: 0, invalid: false });
    expect(mod.parseAmount("0")).toEqual({ value: 0, invalid: false });
    expect(mod.parseAmount("121.50")).toEqual({ value: 121.5, invalid: false });
    for (const absent of [null, undefined, "", "  "]) {
      expect(mod.parseAmount(absent)).toEqual({ value: null, invalid: false });
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "abc", "1,50", "1.234,56", "12e3", {}, [], true]) {
      expect(mod.parseAmount(bad)).toEqual({ value: null, invalid: true });
    }
  });

  it("parseIsoDate: alleen echte kalenderdatums binnen 2000-01-01 … vandaag + 1 jaar", () => {
    expect(mod.parseIsoDate("2026-10-01", NOW, true)).toEqual({ value: "2026-10-01", issue: null });
    expect(mod.parseIsoDate("2000-01-01", NOW, true)).toEqual({ value: "2000-01-01", issue: null });
    expect(mod.parseIsoDate("2027-10-21", NOW, true)).toEqual({ value: "2027-10-21", issue: null });
    expect(mod.parseIsoDate("2027-10-22", NOW, true)).toEqual({ value: null, issue: "datum_onwaarschijnlijk" });
    expect(mod.parseIsoDate("1999-12-31", NOW, true)).toEqual({ value: null, issue: "datum_onwaarschijnlijk" });
    expect(mod.parseIsoDate("2026-02-31", NOW, true)).toEqual({ value: null, issue: "datum_ongeldig" });
    expect(mod.parseIsoDate("21-10-2026", NOW, true)).toEqual({ value: null, issue: "datum_ongeldig" });
    expect(mod.parseIsoDate(20261021, NOW, true)).toEqual({ value: null, issue: "datum_ongeldig" });
    expect(mod.parseIsoDate(undefined, NOW, true)).toEqual({ value: null, issue: null });
    // Zonder plausibiliteitseis telt alleen de kalender.
    expect(mod.parseIsoDate("2031-01-31", NOW, false)).toEqual({ value: "2031-01-31", issue: null });
  });

  it("totalen sluiten binnen € 0,01; daarbuiten een bevinding en geen vertrouwde bedragen", () => {
    expect(mod.checkExtractedInvoice({ amount_excl: 100, btw_amount: 21, amount_incl: 121 }, NOW).validation.ok).toBe(true);
    expect(mod.checkExtractedInvoice({ amount_excl: 0.1, btw_amount: 0.2, amount_incl: 0.3 }, NOW).validation.ok).toBe(true);
    const oneCent = mod.checkExtractedInvoice({ amount_excl: 100, btw_amount: 21.01, amount_incl: 121 }, NOW);
    expect(oneCent.validation.ok).toBe(true);
    const twoCents = mod.checkExtractedInvoice({ amount_excl: 100, btw_amount: 21.02, amount_incl: 121 }, NOW);
    expect(twoCents.amountsUntrusted).toBe(true);
    expect(twoCents.validation.issues.map((i) => i.code)).toEqual(["totalen_kloppen_niet"]);
    const b205 = mod.checkExtractedInvoice({ amount_excl: 100, btw_amount: 21, amount_incl: 5000 }, NOW);
    expect(b205.amountsUntrusted).toBe(true);
    expect(mod.openAmountAtIntake(b205)).toBeNull();
  });

  it("een afwijkend btw-tarief wordt gemarkeerd, niet weggegooid; de bedragen blijven vertrouwd", () => {
    const c = mod.checkExtractedInvoice({ amount_excl: 100, btw_amount: 19, amount_incl: 119, btw_percentage: 19 }, NOW);
    expect(c.btwPercentage).toBe(19);
    expect(c.validation.issues.map((i) => [i.code, i.veld])).toEqual([["btw_tarief_afwijkend", "btw_percentage"]]);
    expect(c.amountsUntrusted).toBe(false);
    expect(mod.openAmountAtIntake(c)).toBe(119);
  });

  it("openAmountAtIntake is nooit 0 als standaardwaarde en nooit het bedrag excl.", () => {
    expect(mod.openAmountAtIntake(mod.checkExtractedInvoice({}, NOW))).toBeNull();
    expect(mod.openAmountAtIntake(mod.checkExtractedInvoice({ amount_excl: 100 }, NOW))).toBeNull();
    expect(mod.openAmountAtIntake(mod.checkExtractedInvoice({ amount_incl: 121 }, NOW))).toBe(121);
    expect(mod.openAmountAtIntake(mod.checkExtractedInvoice({ amount_incl: "abc", amount_excl: 100 }, NOW))).toBeNull();
  });

  it("asExtraction: alleen een object telt als extractie", () => {
    expect(mod.asExtraction(null)).toEqual({});
    expect(mod.asExtraction("tekst")).toEqual({});
    expect(mod.asExtraction([1, 2])).toEqual({});
    expect(mod.asExtraction({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("de twee kopieën van het gedeelde blok gedragen zich identiek", () => {
  const extractions: Record<string, unknown>[] = [
    {},
    { supplier: "X" },
    { amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21, invoice_date: "2026-10-01" },
    { amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0, invoice_date: "2026-02-31" },
    { amount_excl: "100", btw_amount: "abc", amount_incl: 5000, btw_percentage: 6, invoice_date: "1999-01-01" },
    { amount_excl: Number.NaN, amount_incl: Number.POSITIVE_INFINITY, invoice_date: 7 },
  ];
  it.each(extractions.map((e) => [JSON.stringify(e), e]))("%s", (_label, e) => {
    expect(sales.checkExtractedInvoice(e, NOW)).toEqual(purchase.checkExtractedInvoice(e, NOW));
    const c = purchase.checkExtractedInvoice(e, NOW);
    expect(sales.openAmountAtIntake(c)).toEqual(purchase.openAmountAtIntake(c));
  });
});

describe("inkoop-insert (buildPurchaseInvoiceInsert)", () => {
  it("A2-01: alleen een leverancier herkend ⇒ bedrag en saldo NULL, dus nooit 'Betaald'", () => {
    const row = purchase.buildPurchaseInvoiceInsert({ supplier: "Leverancier X BV" }, purchaseCtx);
    expect(row).toMatchObject({
      supplier: "Leverancier X BV", amount_incl: null, amount_excl: null, remaining_amount: null,
      status: "te_controleren", organization_id: ORG, client_id: CLIENT, user_id: USER,
    });
    expect(getInvoicePaymentState(row)).not.toBe("paid");
    expect(getInvoicePaymentState(row)).toBe("unknown");
  });

  it("geen extractie of geen object ⇒ 'Onbekend', alles NULL, saldo NULL", () => {
    for (const nothing of [null, undefined, "x", []]) {
      const row = purchase.buildPurchaseInvoiceInsert(nothing, purchaseCtx);
      expect(row).toMatchObject({ supplier: "Onbekend", invoice_number: null, invoice_date: null, remaining_amount: null });
    }
  });

  it("NM-02 kanaal 1: een 0 %-factuur houdt btw 0 en tarief 0 (geen NULL)", () => {
    const row = purchase.buildPurchaseInvoiceInsert(
      { supplier: "X", amount_excl: 500, btw_amount: 0, amount_incl: 500, btw_percentage: 0, invoice_date: "2026-10-01" },
      purchaseCtx,
    );
    expect(row).toMatchObject({ btw_amount: 0, btw_percentage: 0, amount_incl: 500, remaining_amount: 500 });
    expect(row.ocr_data.validation).toEqual({ ok: true, issues: [] });
  });

  it("B2-05: inconsistente totalen worden opgeslagen ter controle, maar niet als openstaand saldo gebruikt", () => {
    const row = purchase.buildPurchaseInvoiceInsert(
      { supplier: "X", amount_excl: 100, btw_amount: 21, amount_incl: 5000, invoice_date: "2026-02-31" },
      purchaseCtx,
    );
    expect(row).toMatchObject({ amount_excl: 100, btw_amount: 21, amount_incl: 5000, remaining_amount: null, invoice_date: null, status: "te_controleren" });
    expect(row.ocr_data.validation.ok).toBe(false);
    expect(row.ocr_data.validation.issues.map((i) => i.code)).toEqual(["totalen_kloppen_niet", "datum_ongeldig"]);
    // De ruwe extractie blijft bewaard voor de beoordelaar.
    expect(row.ocr_data).toMatchObject({ amount_incl: 5000, invoice_date: "2026-02-31" });
  });

  it("een volledig en consistent herkende factuur: saldo = bedrag incl.", () => {
    const row = purchase.buildPurchaseInvoiceInsert(
      { supplier: "X", invoice_number: "000123", invoice_date: "2026-10-01", amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21 },
      { ...purchaseCtx, supplierBtwNumber: "NL123456789B01" },
    );
    expect(row).toMatchObject({
      invoice_number: "000123", invoice_date: "2026-10-01", amount_incl: 121, remaining_amount: 121,
      supplier_btw_number: "NL123456789B01", file_path: purchaseCtx.filePath,
    });
    expect(getInvoicePaymentState(row)).toBe("open");
  });
});

describe("verkoop-insert (buildSalesInvoiceInsert)", () => {
  const full = {
    customer_name: "Afnemer BV", invoice_number: "V-1", invoice_date: "2026-10-01",
    amount_excl: 1000, btw_amount: 210, amount_incl: 1210, btw_percentage: 21,
  };

  it.each([
    ["geen factuurnummer", { ...full, invoice_number: undefined }, ["invoice_number"]],
    ["leeg factuurnummer", { ...full, invoice_number: "  " }, ["invoice_number"]],
    ["geen factuurdatum", { ...full, invoice_date: undefined }, ["invoice_date"]],
    ["ongeldige factuurdatum", { ...full, invoice_date: "2026-02-31" }, ["invoice_date"]],
    ["onwaarschijnlijke factuurdatum", { ...full, invoice_date: "1999-12-31" }, ["invoice_date"]],
    ["niets herkend", {}, ["invoice_number", "invoice_date"]],
  ])("A2-11: %s ⇒ weigering (422), geen verzonnen nummer of datum", (_label, extracted, missing) => {
    const decision = sales.buildSalesInvoiceInsert(extracted, salesCtx);
    expect(decision).toMatchObject({ ok: false, status: 422, error: sales.SALES_INCOMPLETE_MESSAGE, missing });
    expect(JSON.stringify(decision)).not.toMatch(/VF-\d/);
  });

  it("een volledige factuur: geen notitie, saldo = incl., status concept", () => {
    const decision = sales.buildSalesInvoiceInsert({ ...full, due_date: "2026-10-31" }, salesCtx);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.row).toMatchObject({
      customer_name: "Afnemer BV", invoice_number: "V-1", invoice_date: "2026-10-01", due_date: "2026-10-31",
      amount_incl: 1210, remaining_amount: 1210, status: "concept", pdf_path: salesCtx.filePath, organization_id: ORG,
    });
    expect(decision.row).not.toHaveProperty("notes");
  });

  it("A2-01 (verkoop): geen bedrag herkend ⇒ saldo NULL, dus nooit 'Betaald'", () => {
    const decision = sales.buildSalesInvoiceInsert({ invoice_number: "V-2", invoice_date: "2026-10-01" }, salesCtx);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.row).toMatchObject({ amount_incl: null, remaining_amount: null, customer_name: "Onbekend" });
    expect(getInvoicePaymentState(decision.row as never)).toBe("unknown");
  });

  it("B2-05 (verkoop): inconsistente bedragen of een ongeldige vervaldatum ⇒ wel opgeslagen, saldo NULL, bevinding zichtbaar in notes", () => {
    const decision = sales.buildSalesInvoiceInsert({ ...full, amount_incl: 5000, due_date: "2026-13-01" }, salesCtx);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.row).toMatchObject({ amount_incl: 5000, remaining_amount: null, due_date: null, status: "concept" });
    expect(decision.validation.issues.map((i) => i.code)).toEqual(["totalen_kloppen_niet", "datum_ongeldig"]);
    expect(String(decision.row.notes)).toMatch(/^Automatische controle bij het inlezen:/);
    expect(String(decision.row.notes)).toContain("wijkt meer dan € 0,01 af");
    expect(String(decision.row.notes)).toContain("Vervaldatum is geen geldige datum");
  });

  it("NM-02 kanaal 1 (verkoop): 0 % blijft 0", () => {
    const decision = sales.buildSalesInvoiceInsert({ ...full, amount_excl: 500, btw_amount: 0, amount_incl: 500, btw_percentage: 0 }, salesCtx);
    expect(decision.ok && decision.row).toMatchObject({ btw_amount: 0, btw_percentage: 0, remaining_amount: 500 });
  });
});
