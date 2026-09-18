import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Historische grootboekvulling — het scherm.
 *
 * De datalaag is gemockt; wat hier wordt vastgelegd is wat de gebruiker ziet
 * en wat er gebeurt als hij op de bulkknop drukt: eerst een bevestiging met
 * echte aantallen, en alleen de beschikbare records naar de writer.
 */

const state = {
  clientId: "client-1" as string,
  data: undefined as unknown,
  isPending: false,
  isError: false,
  run: vi.fn(),
};

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant A" }] }),
}));
vi.mock("@/hooks/useLedgerCatchup", () => ({
  useLedgerCatchup: () => ({
    data: state.data, isPending: state.isPending, isError: state.isError, error: null, refetch: vi.fn(),
  }),
  useRunLedgerCatchup: () => ({ mutateAsync: state.run, isPending: false }),
}));

import GrootboekHistorisch from "@/pages/GrootboekHistorisch";
import { evaluatePurchaseInvoice, summarize, type CatchupRecord } from "@/lib/ledger-catchup";

const CONFIG = {
  id: "client-1", afgesloten_boekjaar: null, crediteuren_rekening_id: "cred",
  debiteuren_rekening_id: "deb", btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb",
};

const factuur = (over: Record<string, unknown> = {}) => ({
  id: "pi-1", client_id: "client-1", status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev BV", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});

/** Echte engine-uitkomsten, geen met de hand verzonnen toestanden. */
function records(): CatchupRecord[] {
  return [
    evaluatePurchaseInvoice({
      invoice: factuur({ id: "pi-klaar" }), config: CONFIG,
      lines: { count: 1, sumExcl: 100, withoutAccount: 0, nonPositiveAmountCount: 0 }, postingGroupId: null,
    }),
    evaluatePurchaseInvoice({
      invoice: factuur({ id: "pi-blok", status: "te_controleren" }), config: CONFIG,
      lines: { count: 1, sumExcl: 100, withoutAccount: 0, nonPositiveAmountCount: 0 }, postingGroupId: null,
    }),
    evaluatePurchaseInvoice({
      invoice: factuur({ id: "pi-geboekt" }), config: CONFIG,
      lines: { count: 1, sumExcl: 100, withoutAccount: 0, nonPositiveAmountCount: 0 }, postingGroupId: "pg-1",
    }),
  ];
}

function laad(rs: CatchupRecord[] = records()) {
  state.data = { records: rs, purchase: summarize(rs), sales: summarize([]) };
}

const renderPagina = () => render(<MemoryRouter><GrootboekHistorisch /></MemoryRouter>);

beforeEach(() => {
  state.clientId = "client-1";
  state.isPending = false;
  state.isError = false;
  state.run = vi.fn().mockResolvedValue({ attempted: 1, posted: 1, failures: [], blocked: 1 });
  laad();
});

describe("historische boekingen — overzicht", () => {
  it("1. zonder specifieke administratie wordt er niets getoond", () => {
    state.clientId = "all";
    renderPagina();
    expect(screen.getByText(/Kies eerst een specifieke administratie/i)).toBeInTheDocument();
    expect(screen.queryByTestId("historisch-bulk")).toBeNull();
  });

  it("2. de samenvatting toont de echte tellingen per soort", () => {
    renderPagina();
    const inkoop = screen.getByTestId("historisch-inkoop");
    expect(within(inkoop).getByTestId("historisch-inkoop-totaal")).toHaveTextContent("3");
    expect(within(inkoop).getByTestId("historisch-inkoop-geboekt")).toHaveTextContent("1");
    expect(within(inkoop).getByTestId("historisch-inkoop-klaar")).toHaveTextContent("1");
    expect(within(inkoop).getByTestId("historisch-inkoop-geblokkeerd")).toHaveTextContent("1");
  });

  it("3. elk record toont brondatum, nummer, bedrag en grootboekstatus", () => {
    renderPagina();
    const rijen = screen.getAllByTestId("historisch-row");
    expect(rijen).toHaveLength(3);
    const klaar = rijen.find((r) => r.getAttribute("data-state-label") === "klaar")!;
    // De ECHTE brondatum, niet vandaag.
    expect(klaar).toHaveTextContent("2026-03-01");
    expect(klaar).toHaveTextContent("F-1");
    expect(within(klaar).getByTestId("historisch-state")).toHaveTextContent("Klaar");
  });

  it("4. een geblokkeerd record toont een concrete reden en noemt de status", () => {
    renderPagina();
    const blok = screen.getAllByTestId("historisch-row").find((r) => r.getAttribute("data-state-label") === "geblokkeerd")!;
    expect(within(blok).getByTestId("historisch-state")).toHaveTextContent("Geblokkeerd");
    expect(blok).toHaveTextContent(/te_controleren/);
    expect(blok.querySelector("[data-block-code='status_niet_postbaar']")).not.toBeNull();
  });

  it("5. een reeds geboekt record staat als Geboekt en zonder reden", () => {
    renderPagina();
    const geboekt = screen.getAllByTestId("historisch-row").find((r) => r.getAttribute("data-state-label") === "geboekt")!;
    expect(within(geboekt).getByTestId("historisch-state")).toHaveTextContent("Geboekt");
    expect(geboekt.querySelector("[data-block-code]")).toBeNull();
  });
});

describe("historische boekingen — bulkactie", () => {
  it("6. de knop noemt alleen de beschikbare records", () => {
    renderPagina();
    expect(screen.getByTestId("historisch-bulk")).toHaveTextContent("Boek alle beschikbare (1)");
  });

  it("7. zonder beschikbare records staat de knop uit", () => {
    laad(records().filter((r) => r.state !== "klaar"));
    renderPagina();
    expect(screen.getByTestId("historisch-bulk")).toBeDisabled();
  });

  it("8. er wordt eerst bevestigd, met beide aantallen", async () => {
    renderPagina();
    fireEvent.click(screen.getByTestId("historisch-bulk"));
    const dialoog = await screen.findByRole("alertdialog");
    expect(dialoog).toHaveTextContent(/1 record wordt aangeboden aan de bestaande grootboekwriters/i);
    expect(dialoog).toHaveTextContent(/1 geblokkeerd record wordt overgeslagen/i);
    // Nog niets geboekt zolang er niet is bevestigd.
    expect(state.run).not.toHaveBeenCalled();
  });

  it("9. na bevestiging gaat alleen het beschikbare record naar de writer", async () => {
    renderPagina();
    fireEvent.click(screen.getByTestId("historisch-bulk"));
    fireEvent.click(await screen.findByTestId("historisch-bevestig"));

    await waitFor(() => expect(state.run).toHaveBeenCalledTimes(1));
    const argument = state.run.mock.calls[0][0] as { records: CatchupRecord[]; blocked: number };
    expect(argument.records.map((r) => r.id)).toEqual(["pi-klaar"]);
    expect(argument.blocked).toBe(1);
  });

  it("10. het resultaat wordt getoond, inclusief weigeringen per record", async () => {
    state.run = vi.fn().mockResolvedValue({
      attempted: 2, posted: 1, blocked: 1,
      failures: [{ id: "pi-x", source: "inkoop", reference: "F-9", message: "Boekjaar 2025 is afgesloten" }],
    });
    renderPagina();
    fireEvent.click(screen.getByTestId("historisch-bulk"));
    fireEvent.click(await screen.findByTestId("historisch-bevestig"));

    const melding = await screen.findByTestId("historisch-resultaat");
    expect(melding).toHaveTextContent("2 aangeboden");
    expect(melding).toHaveTextContent("1 geboekt");
    expect(melding).toHaveTextContent("1 geweigerd");
    expect(screen.getByTestId("historisch-failure")).toHaveTextContent("Boekjaar 2025 is afgesloten");
  });
});

describe("statische grenzen", () => {
  const bronnen = [
    "src/lib/ledger-catchup.ts",
    "src/hooks/useLedgerCatchup.ts",
    "src/pages/GrootboekHistorisch.tsx",
  ].map((p) => ({ p, code: readFileSync(p, "utf8") }));

  it("11. geen enkele laag schrijft rechtstreeks in ledger_postings", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/from\(\s*["']ledger_postings["']\s*\)/);
      expect(code, p).not.toMatch(/insert\(|upsert\(/);
      expect(code, p).not.toMatch(/INSERT\s+INTO/i);
    }
  });

  it("12. boeken loopt uitsluitend via de bestaande writers", () => {
    const hook = bronnen.find((b) => b.p.endsWith("useLedgerCatchup.ts"))!.code;
    expect(hook).toMatch(/usePostPurchaseInvoice/);
    expect(hook).toMatch(/usePostSalesInvoice/);
    // Geen eigen RPC-namen en geen tweede schrijfpad naast de bestaande hooks.
    expect(hook).not.toMatch(/supabase\.rpc\(/);
  });

  it("13. geen rekeningnummer-heuristiek en geen statuswijziging", () => {
    for (const { p, code } of bronnen) {
      // Geen vaste rekeningnummers.
      expect(code, p).not.toMatch(/\b(1100|1300|1520|1600|1799)\b/);
      // Geen update van een documentstatus om iets boekbaar te maken.
      expect(code, p).not.toMatch(/update\(\s*\{[^}]*status/);
      expect(code, p).not.toMatch(/markPurchaseInvoices|status:\s*["']gecontroleerd["']/);
    }
  });

  it("14. de rapportagelagen staan niet in deze diff", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/buildAccountReport|buildTrialBalance|buildFinancialStatements/);
    }
  });
});
