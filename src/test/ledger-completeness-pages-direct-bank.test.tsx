import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { computeLedgerCompleteness, type LedgerCompletenessCounts } from "@/lib/ledger-completeness";

/**
 * Herstel P7 — A3-02/A3-11 op de pagina's die de volledigheidsmeter tonen:
 * de proef- en saldibalans en de grootboeksaldi. Een gecodeerde, nog niet
 * geboekte bankregel maakt de meter "mogelijk onvolledig" en staat er als
 * eigen bron, met aantallen. De tellingen gaan door de echte
 * `computeLedgerCompleteness`; alleen de datahooks zijn gemockt.
 */

const counts = (bankDirect: LedgerCompletenessCounts["bankDirect"]): LedgerCompletenessCounts => ({
  purchase: { eligible: 1, posted: 1 },
  sales: { eligible: 1, posted: 1, refusedVerlegd: 0 },
  bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
  bankDirect,
  manual: { total: 0, posted: 0 },
});

const state = { completeness: computeLedgerCompleteness(counts({ eligible: 0, posted: 0 })) };

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c-1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant 1", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: () => ({ data: [], isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({ data: state.completeness, isPending: false, isError: false }),
  useOpeningBalanceCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
}));

import ProefSaldibalans from "@/pages/ProefSaldibalans";
import GrootboekSaldi from "@/pages/GrootboekSaldi";

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/overzichten/proef-saldibalans" element={<ProefSaldibalans />} />
        <Route path="/grootboek/saldi" element={<GrootboekSaldi />} />
      </Routes>
    </MemoryRouter>,
  );

describe("de meter op de PSB en de grootboeksaldi telt de gecodeerde bankregels", () => {
  beforeEach(() => {
    state.completeness = computeLedgerCompleteness(counts({ eligible: 0, posted: 0 }));
  });

  for (const [naam, pad] of [
    ["proef- en saldibalans", "/overzichten/proef-saldibalans"],
    ["grootboeksaldi", "/grootboek/saldi"],
  ] as const) {
    it(`${naam}: twee open bankregels → 'mogelijk onvolledig' met een eigen regel en aantallen`, () => {
      state.completeness = computeLedgerCompleteness(counts({ eligible: 3, posted: 1 }));
      renderAt(pad);
      const meter = screen.getByTestId("ledger-completeness");
      expect(meter).toHaveAttribute("data-status", "incomplete");
      expect(meter).toHaveTextContent("mogelijk onvolledig");
      expect(meter).toHaveTextContent("2 postbare documenten zijn nog niet geboekt");
      const rij = screen.getByTestId("completeness-bank_transaction");
      expect(rij).toHaveTextContent("Gecodeerde bankregels");
      expect(rij).toHaveTextContent("1 / 3");
      expect(rij).toHaveTextContent("2 nog niet geboekt");
    });

    it(`${naam}: alles geboekt, ook de bankregels → 'Alle postbare documenten zijn geboekt'`, () => {
      state.completeness = computeLedgerCompleteness(counts({ eligible: 2, posted: 2 }));
      renderAt(pad);
      const meter = screen.getByTestId("ledger-completeness");
      expect(meter).toHaveAttribute("data-status", "complete");
      expect(meter).toHaveTextContent("Alle postbare documenten zijn geboekt");
      expect(screen.getByTestId("completeness-bank_transaction")).toHaveTextContent("volledig");
    });
  }
});
