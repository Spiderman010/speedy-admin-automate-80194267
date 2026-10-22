/**
 * Review P5 H-6 / A1-12c — het label "& Betaald" belooft alleen een volledige
 * betaling als het gekozen bedrag het openstaande bedrag van de factuur op de
 * cent afdekt. Bij "Bedrag ≈ gelijk (≤ € 0,50)" laat de betaalschrijver het
 * verschil open; dan zegt de knop gewoon "Koppelen".
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/bank/BtwKeuzeSelect", () => ({ BtwKeuzeSelect: () => null }));

import { BankMatchDialog } from "@/components/BankMatchDialog";

const tx = (amount: number) => ({
  id: "tx-1", user_id: "u-1", client_id: "c-1", organization_id: "org-1", amount,
  transaction_date: "2026-02-01", description: "Betaling INK-7 Leverancier", reference: null,
  counter_account: null, camt_ustrd: null, camt_addtl_ntry_inf: null, camt_counterparty_name: null,
  match_status: "niet_gematcht", match_confidence: null, matched_invoice_id: null,
  grootboekrekening_id: null, ledger_account_id: null, btw_percentage: null,
  created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
});
const invoice = {
  id: "P7", client_id: "c-1", organization_id: "org-1", supplier: "Leverancier", invoice_number: "INK-7",
  invoice_date: "2026-01-15", amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0,
  remaining_amount: 100, status: "gecontroleerd",
};

async function confirmButtonFor(amount: number) {
  render(
    <BankMatchDialog
      open
      onOpenChange={vi.fn()}
      transaction={tx(amount) as any}
      purchaseInvoices={[invoice] as any}
      salesInvoices={[]}
      onConfirm={vi.fn()}
      rejectionIndex={new Set()}
    />,
  );
  fireEvent.click(await screen.findByText("Leverancier"));
  return waitFor(() => screen.getByRole("button", { name: /^Koppelen/ }));
}

describe("BankMatchDialog — '& Betaald' alleen bij exact het openstaande bedrag", () => {
  it.each([
    ["exact gelijk (100,00 op 100,00)", -100, "Koppelen & Betaald"],
    ["≈ gelijk, 30 cent te weinig (99,70 op 100,00)", -99.7, "Koppelen"],
    ["één cent te weinig (99,99 op 100,00)", -99.99, "Koppelen"],
  ])("%s → %s", async (_label, amount, expected) => {
    const button = await confirmButtonFor(amount);
    expect(button.textContent?.trim()).toBe(expected);
  });

  it("met de hand het bedrag op het restant zetten maakt het wél '& Betaald'; één cent minder niet", async () => {
    const button = await confirmButtonFor(-100);
    const input = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(input.value).toBe("100.00");
    fireEvent.change(input, { target: { value: "99.99" } });
    await waitFor(() => expect(button.textContent?.trim()).toBe("Koppelen (deelallocatie)"));
    fireEvent.change(input, { target: { value: "100.00" } });
    await waitFor(() => expect(button.textContent?.trim()).toBe("Koppelen & Betaald"));
  });
});
