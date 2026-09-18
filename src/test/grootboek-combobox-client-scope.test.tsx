import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Fase 6C-b8 (PR 2) — de optionele `clientId`-prop van de GrootboekCombobox.
 *
 * Met de prop blijven alleen rekeningen over die voor de administratie
 * boekbaar zijn: organisatiebreed (client_id null) of van deze administratie.
 * Zonder de prop verandert er niets. Inactieve rekeningen kwamen al nooit in
 * de lijst: de combobox leest uitsluitend de actieve rekeningen.
 */

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({
    data: [
      { id: "gb-1", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true, client_id: null },
      { id: "gb-2", nummer: 1310, omschrijving: "Debiteuren klant A", categorie: "activa", actief: true, client_id: "c-1" },
      { id: "gb-3", nummer: 1320, omschrijving: "Debiteuren klant B", categorie: "activa", actief: true, client_id: "c-2" },
    ],
  }),
}));

import { GrootboekCombobox } from "@/components/GrootboekCombobox";

// cmdk gebruikt scrollIntoView en ResizeObserver; jsdom kent die niet.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: typeof ResizeObserverStub }).ResizeObserver ?? ResizeObserverStub;

describe("GrootboekCombobox — administratiebereik", () => {
  it("met clientId: alleen organisatiebrede en eigen rekeningen", async () => {
    render(<GrootboekCombobox value="" onValueChange={() => {}} clientId="c-1" />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByText("1300 - Debiteuren")).toBeInTheDocument();
    expect(screen.getByText("1310 - Debiteuren klant A")).toBeInTheDocument();
    expect(screen.queryByText("1320 - Debiteuren klant B")).toBeNull();
  });

  it("zonder clientId: bestaand gedrag, alle actieve rekeningen", async () => {
    render(<GrootboekCombobox value="" onValueChange={() => {}} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByText("1300 - Debiteuren")).toBeInTheDocument();
    expect(screen.getByText("1320 - Debiteuren klant B")).toBeInTheDocument();
  });
});
