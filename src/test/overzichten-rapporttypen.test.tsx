import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";

/**
 * Fase 6C-b7 PR 3 — de rapportkaarten op Overzichten.
 *
 * Alleen de proef- en saldibalans wordt geactiveerd. Balans en W&V blijven
 * dicht met een waarheidsgetrouwe reden, en de KPI-tegels houden hun eigen
 * berekening — alleen hun label is verduidelijkt.
 */

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "all", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
const leeg = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
vi.mock("@/hooks/useClients", () => ({ useClients: () => leeg }));
vi.mock("@/hooks/usePurchaseInvoices", () => ({ usePurchaseInvoices: () => leeg }));
vi.mock("@/hooks/useJournalEntries", () => ({ useJournalEntries: () => leeg }));
vi.mock("@/hooks/useBankTransactions", () => ({ useBankTransactions: () => leeg }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => leeg }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import Overzichten from "@/pages/Overzichten";

const renderPage = () => render(<MemoryRouter><Overzichten /></MemoryRouter>);

describe("Overzichten — rapporttypen", () => {
  it("39. de proef- en saldibalans is geactiveerd en linkt naar de route", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "Open Proef- en saldibalans" });
    expect(link).toHaveAttribute("href", "/overzichten/proef-saldibalans");
    expect(link).toHaveTextContent("Proef- en saldibalans");
    expect(link).toHaveTextContent("Beschikbaar");
  });

  it("40/41. Balans en W&V zijn beschikbaar en linken naar hun rapport", () => {
    // Voorheen: "blijven dicht, met een waarheidsgetrouwe reden". Dat was waar
    // zolang de rapporten niet bestonden; Balans/W&V PR 4 bouwt ze. De
    // invariant die blijft: een kaart is aanklikbaar precies dan wanneer het
    // rapport er werkelijk is, en de status is tekst, nooit alleen kleur.
    renderPage();
    const verwacht: Record<string, string> = {
      Balans: "/grootboek/balans",
      "Winst-en-verliesrekening": "/grootboek/winst-verlies",
    };
    for (const [titel, href] of Object.entries(verwacht)) {
      const kop = screen.getByRole("heading", { name: titel, level: 3 });
      const kaart = kop.closest("div[class*='min-h-32']")!;
      // Exacte tekst op de badge zelf: "Beschikbaar na openingsbalans"
      // zou een substring-match op de kaart ten onrechte laten slagen.
      expect(within(kaart as HTMLElement).getByText("Beschikbaar")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: `Open ${titel}` })).toHaveAttribute("href", href);
    }
  });

  it("40b. een rapport dat nog niet bestaat blijft een inerte kaart", () => {
    renderPage();
    for (const titel of ["Grootboek", "BTW-overzicht"]) {
      const kop = screen.getByRole("heading", { name: titel, level: 3 });
      const kaart = kop.closest("div[class*='min-h-32']")!;
      expect(kaart).toHaveTextContent("Nog niet beschikbaar");
      expect(kaart.querySelector("a")).toBeNull();
    }
  });

  it("de KPI-tegels heten nu onmiskenbaar brondocumenten, en de berekening is niet aangeraakt", () => {
    // Die sectie rendert pas bij een gekozen administratie mét gegevens, dus
    // de formulering wordt op bronniveau getoetst.
    const bron = readFileSync("src/pages/Overzichten.tsx", "utf8");
    expect(bron).toContain("Brondocumenten van deze administratie");
    expect(bron).toContain("niet uit het grootboek");
    expect(bron).not.toContain("Huidig financieel overzicht");
    // Exact de drie sommen die er al stonden.
    expect(bron).toContain("const totalInvoices = invoices?.reduce((s, i) => s + (i.amount_incl ?? 0), 0) ?? 0;");
    expect(bron).toContain("const totalBtw = invoices?.reduce((s, i) => s + (i.btw_amount ?? 0), 0) ?? 0;");
    expect(bron).toContain("const totalEntries = entries?.reduce((s, e) => s + e.amount, 0) ?? 0;");
    // En de export van deze pagina is ongemoeid gebleven.
    expect(bron).toContain("exportAllForClient");
  });
});
