/**
 * VerwerkingsScherm → "Factuur koppelen": de veilige-matchpoort op het levende
 * pad (nulmeting A1-04, C-04, C-14; F4-test A en F1a test 4). Het echte scherm;
 * de klik op "Koppelen" gaat naar onMatchInvoice (het schrijfpad, P5).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import { VerwerkingsScherm } from "@/components/VerwerkingsScherm";
import { buildRejectionIndex } from "@/lib/bank-match-rejections";

const tx = (over: any = {}) => ({
  id: "t1", client_id: "c1", organization_id: "org-1", transaction_date: "2026-10-02", amount: -121,
  description: "VODAFONE LIBERTEL B.V. maandtermijn incasso", reference: null, counter_account: null,
  match_status: "niet_gematcht", matched_invoice_id: null, match_confidence: null, grootboekrekening_id: null,
  btw_percentage: null, ...over,
}) as any;
const purchase = (id: string, over: any = {}) => ({
  id, client_id: "c1", supplier: "Vodafone Libertel", invoice_number: id.toUpperCase(), status: "gecontroleerd",
  amount_excl: null, amount_incl: 121, remaining_amount: 121, invoice_date: "2026-09-01", ...over,
}) as any;
const sale = (id: string, over: any = {}) => ({
  id, client_id: "c1", customer_name: "Vodafone Libertel", invoice_number: id.toUpperCase(), status: "verzonden",
  amount_excl: null, amount_incl: 121, remaining_amount: 121, invoice_date: "2026-09-01", ...over,
}) as any;

const PURCHASES = [
  purchase("vf-jan"),
  purchase("vf-feb"),
  purchase("vf-betaald", { remaining_amount: 0 }), // volledig betaald, status blijft gecontroleerd (F1a test 4)
  purchase("vf-andere-klant", { client_id: "c2" }),
  purchase("bouw-1000", { supplier: "Bouwbedrijf Jansen", invoice_number: "BJ-1001", amount_incl: 1000, remaining_amount: 1000 }), // geen identiteit (F4-test A)
  purchase("vf-afgewezen"),
];
const SALES = [sale("vf-verkoop")]; // verkeerde richting voor geld uit

function renderScherm(transaction: any, opts: { rejections?: any[] | null } = {}) {
  const onMatchInvoice = vi.fn(async () => undefined);
  const rejectionIndex = opts.rejections === null
    ? undefined
    : buildRejectionIndex(opts.rejections ?? [{ bank_transaction_id: "t1", invoice_type: "inkoop", invoice_id: "vf-afgewezen" }]);
  render(
    <VerwerkingsScherm open onOpenChange={() => {}} transactions={[transaction]} purchaseInvoices={PURCHASES}
      salesInvoices={SALES} rejectionIndex={rejectionIndex} onBookPrivate={async () => {}} onBookLedger={async () => {}}
      onMatchInvoice={onMatchInvoice} onSkip={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Factuur koppelen/ }));
  return { onMatchInvoice };
}

const offered = () => screen.queryAllByRole("button", { pressed: undefined }).filter((b) => b.hasAttribute("aria-pressed")).map((b) => b.textContent ?? "");
const koppelen = () => screen.getByTestId("verwerking-match-submit");

describe("VerwerkingsScherm — kandidaten alleen via de veilige-matchpoort", () => {
  it("geen andere richting, geen andere administratie, niets zonder openstaand bedrag, geen afgewezen factuur, geen factuur zonder identiteit", () => {
    renderScherm(tx());
    const shown = offered();
    expect(shown).toHaveLength(2);
    expect(shown.some((t) => t.includes("VF-JAN"))).toBe(true);
    expect(shown.some((t) => t.includes("VF-FEB"))).toBe(true);
    for (const absent of ["VF-BETAALD", "VF-ANDERE-KLANT", "BJ-1001", "VF-AFGEWEZEN", "VF-VERKOOP"]) {
      expect(shown.some((t) => t.includes(absent)), absent).toBe(false);
    }
  });

  it("gelijke topscore: geen voorselectie, Koppelen pas na een eigen keuze (C-04)", () => {
    const { onMatchInvoice } = renderScherm(tx());
    expect(screen.getByTestId("verwerking-tie")).toBeInTheDocument();
    expect(koppelen()).toBeDisabled();
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    fireEvent.click(koppelen());
    expect(onMatchInvoice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /VF-FEB/ }));
    expect(screen.getByRole("button", { name: /VF-FEB/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(koppelen());
    expect(onMatchInvoice).toHaveBeenCalledWith("t1", "vf-feb", "inkoop");
  });

  it("één beste kandidaat (factuurnummer in de omschrijving) wordt vooraf geselecteerd", () => {
    const { onMatchInvoice } = renderScherm(tx({ description: "VODAFONE LIBERTEL B.V. factuur VF-JAN" }));
    expect(screen.queryByTestId("verwerking-tie")).toBeNull();
    expect(screen.getByRole("button", { name: /VF-JAN/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(koppelen());
    expect(onMatchInvoice).toHaveBeenCalledWith("t1", "vf-jan", "inkoop");
  });

  it("geld in krijgt alleen verkoopfacturen", () => {
    renderScherm(tx({ amount: 121 }));
    const shown = offered();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("VF-VERKOOP");
  });

  it("de parkeerbetaling van F4-test A krijgt de factuur van € 1.000 niet meer aangeboden", () => {
    renderScherm(tx({ amount: -100, description: "PARKEERGARAGE CENTRUM pinbetaling" }));
    expect(offered()).toEqual([]);
    expect(screen.getByText(/Geen passende openstaande factuur gevonden/)).toBeInTheDocument();
    expect(koppelen()).toBeDisabled();
  });

  it("zonder afwijzingsdata geen enkele kandidaat (fail-closed)", () => {
    renderScherm(tx({ description: "VODAFONE LIBERTEL B.V. factuur VF-JAN" }), { rejections: null });
    expect(offered()).toEqual([]);
    expect(koppelen()).toBeDisabled();
  });
});
