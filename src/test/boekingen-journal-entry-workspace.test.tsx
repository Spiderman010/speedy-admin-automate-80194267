import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Snelle invoer — ALLEEN-LEZEN.
 *
 * De oude snelle invoer schreef één bedrag op één rekening in `journal_entries`,
 * buiten `ledger_postings`, de jaarafsluiting en de boekingsblokkade om. De pagina
 * maakt en verwijdert daarom niets meer: zij toont de historische regels,
 * exporteert ze nog naar SnelStart, en stuurt nieuwe boekingen naar het
 * memoriaal (`post_manual_journal()`).
 */

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = {
  selectedClientId: "client-1" as string,
  clients: [] as any[],
  journalEntries: [] as any[],
  entriesLoading: false,
  entriesError: false,
  ledgers: [] as any[],
};

const toastSpy = vi.fn();
const refetchSpy = vi.fn();
const exportJournalEntriesCSVSpy = vi.fn();
const useJournalEntriesSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: state.clients }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: state.ledgers }),
}));
vi.mock("@/hooks/useJournalEntries", () => ({
  useJournalEntries: (options: unknown) => {
    useJournalEntriesSpy(options);
    return {
      data: state.journalEntries,
      isLoading: state.entriesLoading,
      isError: state.entriesError,
      refetch: refetchSpy,
    };
  },
}));
vi.mock("@/lib/snelstart-export", () => ({
  exportJournalEntriesCSV: (...args: unknown[]) => exportJournalEntriesCSVSpy(...args),
}));

import Boekingen from "@/pages/Boekingen";

const makeEntry = (over: Partial<any> = {}) => ({
  id: `je-${Math.random().toString(36).slice(2)}`,
  user_id: "u1",
  client_id: "client-1",
  organization_id: "org-1",
  entry_date: "2026-07-20",
  description: "Kantoorartikelen",
  amount: 121,
  btw_percentage: 21,
  btw_amount: 21,
  ledger_account_id: null,
  grootboekrekening_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  invoice_number: "J-001",
  entry_type: "handmatig",
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
  ...over,
});

function renderBoekingen() {
  render(
    <MemoryRouter>
      <Boekingen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.selectedClientId = "client-1";
  state.clients = [
    { id: "client-1", name: "Klant Een", btw_vrijgesteld: false },
    { id: "client-2", name: "Klant Twee", btw_vrijgesteld: true },
  ];
  state.journalEntries = [];
  state.entriesLoading = false;
  state.entriesError = false;
  state.ledgers = [];
  toastSpy.mockReset();
  refetchSpy.mockReset();
  exportJournalEntriesCSVSpy.mockReset();
  useJournalEntriesSpy.mockReset();
});

describe("Snelle invoer — basis", () => {
  it("rendert de pagina met een sr-only h1", () => {
    renderBoekingen();
    const h1 = screen.getByRole("heading", { level: 1, name: "Snelle invoer" });
    expect(h1.className).toContain("sr-only");
  });
});

describe("Snelle invoer — alleen-lezen", () => {
  it("biedt geen formulier meer om een boeking aan te maken", () => {
    state.journalEntries = [makeEntry()];
    renderBoekingen();
    expect(screen.queryByRole("button", { name: /opslaan/i })).toBeNull();
    expect(screen.queryByLabelText(/bedrag/i)).toBeNull();
    expect(screen.queryByLabelText(/grootboekrekening/i)).toBeNull();
    expect(screen.queryByText("Nieuwe boeking")).toBeNull();
  });

  it("biedt geen verwijderactie meer — historische regels blijven staan", () => {
    state.journalEntries = [makeEntry(), makeEntry({ description: "Tweede" })];
    renderBoekingen();
    expect(screen.queryByRole("button", { name: /verwijder/i })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Acties" })).toBeNull();
  });

  it("legt uit dat deze regels niet in het grootboek staan", () => {
    renderBoekingen();
    const notice = screen.getByTestId("snelle-invoer-alleen-lezen");
    expect(notice.textContent).toContain("niet in het");
    expect(notice.textContent).toContain("grootboek");
    expect(notice.textContent).toMatch(/balans/);
    expect(notice.textContent).toMatch(/SnelStart/);
  });

  it("stuurt nieuwe boekingen naar het memoriaal", () => {
    renderBoekingen();
    const link = screen.getByRole("link", { name: /naar memoriaal/i });
    expect(link.getAttribute("href")).toBe("/grootboek/memoriaal");
  });
});

describe("Snelle invoer — administratie", () => {
  it("leest alleen voor de gekozen administratie", () => {
    renderBoekingen();
    expect(useJournalEntriesSpy).toHaveBeenLastCalledWith({
      organizationId: "org-1",
      clientId: "client-1",
      enabled: true,
    });
  });

  it("leest niets en toont de NoClientBanner wanneer ClientContext op 'all' staat", () => {
    state.selectedClientId = "all";
    renderBoekingen();
    expect(useJournalEntriesSpy).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByText("Kies een specifieke administratie om de boekingen te zien.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /export snelstart/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Snelle invoer — historische regels", () => {
  it("toont de historische regels met datum als DD-MM-YYYY", () => {
    state.journalEntries = [makeEntry({ description: "Kantoorartikelen", entry_date: "2026-07-20" })];
    renderBoekingen();
    expect(screen.getByText("Kantoorartikelen")).toBeTruthy();
    expect(screen.getByText("20-07-2026")).toBeTruthy();
  });

  it("toont het grootboeklabel via resolveJournalEntryLedgerLabel met de geladen rekeningen", () => {
    state.ledgers = [{ id: "gb-1", nummer: 4500, omschrijving: "Reiskosten" }];
    state.journalEntries = [makeEntry({ grootboekrekening_id: "gb-1", ledger_account_text: "oud label" })];
    renderBoekingen();
    expect(screen.getByText("4500 - Reiskosten")).toBeTruthy();
    expect(screen.queryByText("oud label")).toBeNull();
  });

  it("formatteert bedragen met formatGetal (komma, 2 decimalen, geen valutateken)", () => {
    state.journalEntries = [makeEntry({ amount: 1234.5 })];
    renderBoekingen();
    expect(screen.getByText("1.234,50")).toBeTruthy();
  });

  it("toont een laadstatus in plaats van de tabel", () => {
    state.entriesLoading = true;
    renderBoekingen();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("toont een foutmelding met opnieuw proberen", () => {
    state.entriesError = true;
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it("toont de lege-staat melding wanneer er geen historische regels zijn", () => {
    renderBoekingen();
    expect(screen.getByText("Geen historische snelle invoer voor deze administratie.")).toBeTruthy();
  });

  it("bevat geen debet-/creditvelden en geen paginatie", () => {
    state.journalEntries = [makeEntry()];
    renderBoekingen();
    expect(screen.queryByText(/debet/i)).toBeNull();
    expect(screen.queryByText(/credit/i)).toBeNull();
    expect(screen.queryByRole("navigation", { name: /paginering|pagination/i })).toBeNull();
  });
});

describe("Snelle invoer — SnelStart-export blijft", () => {
  it("exporteert de historische regels met de naam van de administratie", () => {
    const entries = [makeEntry(), makeEntry()];
    state.journalEntries = entries;
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: /export snelstart/i }));
    expect(exportJournalEntriesCSVSpy).toHaveBeenCalledWith(entries, "Klant Een");
    expect(toastSpy).toHaveBeenCalledWith({ title: "2 boekingen geëxporteerd" });
  });

  it("toont de bestaande foutmelding bij export zonder boekingen", () => {
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: /export snelstart/i }));
    expect(exportJournalEntriesCSVSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({ title: "Geen boekingen om te exporteren", variant: "destructive" });
  });
});
