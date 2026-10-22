/**
 * P5 — de betaalschrijver vanuit de app: het contract met link_bank_payment /
 * unlink_bank_payment (argumenten, foutvertaling, fail-closed in het
 * uitrolvenster) en de pure hulp (exacte bedragen, één melding).
 *
 * Wat de database ermee doet — restant, betaald, grendels, races, weigeringen —
 * bewijst het harnas supabase/tests/bank-payment-allocation/ tegen een echte
 * PostgreSQL (149 bewijzen).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => h.rpc(...args) },
}));

import {
  BANK_PAYMENT_NOT_AVAILABLE,
  BankPaymentError,
  amountToRpc,
  bankPaymentErrorMessage,
  batchResultMessage,
  linkResultMessage,
  minAmount,
  parseLinkResult,
  parseUnlinkResult,
  toBankPaymentError,
} from "@/lib/bank-payment-link";
import {
  BANK_PAYMENT_QUERY_KEYS,
  linkBankPayment,
  unlinkBankPayment,
  useBankPaymentLink,
} from "@/hooks/useBankPaymentLink";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  h.rpc.mockReset();
});

describe("bedragen: exact op twee decimalen, nooit stil afgerond", () => {
  it("geeft een exacte decimale tekst aan de RPC", () => {
    expect(amountToRpc(30)).toBe("30.00");
    expect(amountToRpc(1234.5)).toBe("1234.50");
    expect(amountToRpc(0.1 + 0.2)).toBe("0.30");
    expect(amountToRpc(9999999999.99)).toBe("9999999999.99");
  });

  it("weigert meer dan twee decimalen, nul, negatief en geen getal", () => {
    expect(() => amountToRpc(1.005)).toThrow(/twee decimalen/);
    expect(() => amountToRpc(0)).toThrow(/groter dan nul/);
    expect(() => amountToRpc(-5)).toThrow(/groter dan nul/);
    expect(() => amountToRpc(Number.NaN)).toThrow(BankPaymentError);
    expect(() => amountToRpc(Number.POSITIVE_INFINITY)).toThrow(BankPaymentError);
  });

  it("minAmount rekent in hele centen en kent geen onbekend", () => {
    expect(minAmount(100, 70)).toBe(70);
    expect(minAmount(100 - 33.33, 80)).toBe(66.67);
    expect(minAmount(100, null)).toBeNull();
    expect(minAmount(-10, 50)).toBe(-10);
  });
});

describe("foutvertaling", () => {
  it("een ontbrekende RPC (uitrolvenster) wordt een duidelijke melding en geen ruwe fout", () => {
    for (const code of ["PGRST202", "PGRST203", "42883"]) {
      const e = toBankPaymentError({ code, message: "Could not find the function public.link_bank_payment" });
      expect(e.deployWindow).toBe(true);
      expect(e.message).toBe(BANK_PAYMENT_NOT_AVAILABLE);
      expect(e.message).toMatch(/niets gewijzigd/);
    }
  });

  it("de eigen weigeringen van de database komen letterlijk door", () => {
    const e = toBankPaymentError({ code: "23514", message: "Openstaand bedrag wijkt af van de koppelingen; herstel nodig" });
    expect(e.message).toBe("Openstaand bedrag wijkt af van de koppelingen; herstel nodig");
    expect(e.code).toBe("23514");
    expect(e.deployWindow).toBe(false);
  });

  it("een onbekende fout wordt herkenbaar ingeleid", () => {
    expect(toBankPaymentError({ code: "XX000", message: "boem" }).message).toBe("Koppelen is niet gelukt: boem");
    expect(toBankPaymentError(null).message).toMatch(/niets gewijzigd/);
    expect(bankPaymentErrorMessage("geen fout-object")).toMatch(/niets gewijzigd/);
  });
});

describe("linkBankPayment / unlinkBankPayment — het RPC-contract", () => {
  it("koppelen: één RPC-aanroep met exact deze argumenten en een nieuwe request_id", async () => {
    h.rpc.mockResolvedValue({
      data: [{ allocation_id: "a-1", outcome: "created", invoice_remaining: "70.00", invoice_status: "gecontroleerd",
               tx_match_status: "gematcht", replayed: false }],
      error: null,
    });
    const result = await linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "verkoop", invoiceId: "inv-1", amount: 30 });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe("link_bank_payment");
    expect(args).toEqual({
      _bank_transaction_id: "tx-1",
      _invoice_type: "verkoop",
      _invoice_id: "inv-1",
      _amount: "30.00",
      _request_id: expect.stringMatching(UUID),
    });
    expect(result).toEqual({
      allocationId: "a-1", outcome: "created", invoiceRemaining: 70, invoiceStatus: "gecontroleerd",
      txMatchStatus: "gematcht", replayed: false,
    });
  });

  it("elke handeling krijgt een eigen request_id, tenzij de aanroeper bewust herhaalt", async () => {
    h.rpc.mockResolvedValue({ data: [{ allocation_id: "a", outcome: "created", invoice_remaining: 0, invoice_status: "x", tx_match_status: "gematcht", replayed: false }], error: null });
    await linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "i", amount: 1 });
    await linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "i", amount: 1 });
    await linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "i", amount: 1, requestId: "00000000-0000-4000-8000-000000000001" });
    const ids = h.rpc.mock.calls.map(([, a]) => a._request_id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("een ongeldig bedrag bereikt de database niet", async () => {
    await expect(linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "i", amount: 1.005 })).rejects.toThrow(/twee decimalen/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("zonder de RPC in de database (PGRST202): een BankPaymentError, verder niets", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    const err = await linkBankPayment({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "i", amount: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(BankPaymentError);
    expect(err.deployWindow).toBe(true);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("ontkoppelen: alle koppelingen, of precies één", async () => {
    h.rpc.mockResolvedValue({ data: [{ outcome: "unlinked", removed_count: 2, tx_match_status: "niet_gematcht", replayed: false }], error: null });
    const all = await unlinkBankPayment({ bankTransactionId: "tx-1" });
    await unlinkBankPayment({ bankTransactionId: "tx-1", allocationId: "a-9" });
    expect(h.rpc.mock.calls[0]).toEqual(["unlink_bank_payment", {
      _bank_transaction_id: "tx-1", _request_id: expect.stringMatching(UUID), _allocation_id: null,
    }]);
    expect(h.rpc.mock.calls[1][1]._allocation_id).toBe("a-9");
    expect(all).toEqual({ outcome: "unlinked", removedCount: 2, txMatchStatus: "niet_gematcht", replayed: false });
  });

  it("ontkoppelen met een fout (uitrolvenster of weigering) gooit een BankPaymentError — nooit een stil 'niets te ontkoppelen' (H-3)", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } });
    const missing = await unlinkBankPayment({ bankTransactionId: "tx-1" }).catch((e) => e);
    expect(missing).toBeInstanceOf(BankPaymentError);
    expect(missing.deployWindow).toBe(true);
    expect(missing.message).toBe(BANK_PAYMENT_NOT_AVAILABLE);

    h.rpc.mockResolvedValueOnce({ data: [{ outcome: "unchanged", removed_count: 0, tx_match_status: "gematcht", replayed: false }],
                                  error: { code: "23514", message: "Openstaand bedrag wijkt af van de koppelingen; herstel nodig" } });
    const refused = await unlinkBankPayment({ bankTransactionId: "tx-1" }).catch((e) => e);
    expect(refused).toBeInstanceOf(BankPaymentError);
    expect(refused.message).toBe("Openstaand bedrag wijkt af van de koppelingen; herstel nodig");

    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "08006", message: "connection lost" } });
    const network = await unlinkBankPayment({ bankTransactionId: "tx-1" }).catch((e) => e);
    expect(network.message).toBe("Ontkoppelen is niet gelukt: connection lost");
  });

  it("een onbruikbaar antwoord is een fout, geen stil succes", () => {
    expect(() => parseLinkResult([])).toThrow(BankPaymentError);
    expect(() => parseLinkResult([{ outcome: "weird" }])).toThrow(BankPaymentError);
    expect(() => parseUnlinkResult(null)).toThrow(BankPaymentError);
  });
});

describe("useBankPaymentLink", () => {
  it("ververst na een handeling alles wat een koppeling kan veranderen", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useBankPaymentLink(), { wrapper });
    expect(result.current.link).toBe(linkBankPayment);
    expect(result.current.unlink).toBe(unlinkBankPayment);
    await result.current.refresh();
    expect(spy.mock.calls.map(([arg]) => (arg as { queryKey: readonly string[] }).queryKey)).toEqual(
      BANK_PAYMENT_QUERY_KEYS.map((k) => [...k]),
    );
    expect(BANK_PAYMENT_QUERY_KEYS.map((k) => k[0]).sort()).toEqual([
      "bank_transaction_allocations", "bank_transactions", "ledger-completeness", "purchase_invoice",
      "purchase_invoice_has_allocations", "purchase_invoices", "sales_invoices", "unposted-source-work",
    ]);
    // Dezelfde sleutel als de hook die het overzicht ophaalt (H-8).
    const { UNPOSTED_SOURCE_WORK_QUERY_KEY } = await import("@/hooks/useUnpostedSourceWork");
    expect(BANK_PAYMENT_QUERY_KEYS.some((k) => k[0] === UNPOSTED_SOURCE_WORK_QUERY_KEY)).toBe(true);
  });
});

describe("meldingen: uit het antwoord van de database, één per handeling", () => {
  const base = { allocationId: "a", outcome: "created" as const, txMatchStatus: "gematcht", replayed: false };

  it("deelbetaling, volledig betaald, niet goedgekeurd, al gekoppeld", () => {
    expect(linkResultMessage({ ...base, invoiceRemaining: 70, invoiceStatus: "gecontroleerd" }, "verkoop").title).toBe("Deelbetaling gekoppeld");
    expect(linkResultMessage({ ...base, invoiceRemaining: 0, invoiceStatus: "betaald" }, "verkoop").description).toMatch(/volledig betaald/);
    expect(linkResultMessage({ ...base, invoiceRemaining: 0, invoiceStatus: "concept" }, "verkoop").description).toMatch(/nog niet goedgekeurd/);
    expect(linkResultMessage({ ...base, invoiceRemaining: 0, invoiceStatus: "gecontroleerd" }, "inkoop").description).toMatch(/volledig betaald/);
    expect(linkResultMessage({ ...base, outcome: "unchanged", invoiceRemaining: 0, invoiceStatus: "betaald" }, "inkoop").title).toBe("Al gekoppeld");
  });

  it("een reeks geeft één samenvatting met de eerste fout", () => {
    expect(batchResultMessage(3, [], { done: "ontkoppeld", failed: "mislukt" })).toEqual({ title: "3 ontkoppeld" });
    const m = batchResultMessage(2, ["Herstel nodig", "Andere fout"], { done: "ontkoppeld", failed: "mislukt" });
    expect(m).toEqual({ title: "2 ontkoppeld, 2 mislukt", description: "Herstel nodig (en 1 andere)", variant: "destructive" });
  });
});
