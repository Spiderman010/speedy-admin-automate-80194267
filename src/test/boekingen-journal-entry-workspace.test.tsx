import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!(Element.prototype as any).hasPointerCapture) {
  (Element.prototype as any).hasPointerCapture = () => false;
  (Element.prototype as any).setPointerCapture = () => {};
  (Element.prototype as any).releasePointerCapture = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
}

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
const setSelectedClientIdSpy = vi.fn();
const addMutateAsync = vi.fn();
const deleteMutateAsync = vi.fn();
const refetchSpy = vi.fn();
const exportJournalEntriesCSVSpy = vi.fn();
const pending = { add: false, delete: false };

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: state.clients }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: setSelectedClientIdSpy }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: state.ledgers }),
}));
vi.mock("@/hooks/useJournalEntries", () => ({
  useJournalEntries: () => ({
    data: state.journalEntries,
    isLoading: state.entriesLoading,
    isError: state.entriesError,
    refetch: refetchSpy,
  }),
  useAddJournalEntry: () => ({ mutateAsync: addMutateAsync, isPending: pending.add }),
  useDeleteJournalEntry: () => ({ mutateAsync: deleteMutateAsync, isPending: pending.delete }),
}));
vi.mock("@/lib/snelstart-export", () => ({
  exportJournalEntriesCSV: (...args: unknown[]) => exportJournalEntriesCSVSpy(...args),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      aria-label="Grootboekrekening"
      value={value ?? ""}
      onChange={(e) => { onValueChange?.(e.target.value); onIdChange?.("gb-mock-1"); }}
    />
  ),
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
  render(<Boekingen />);
}

const amountInput = () => screen.getByLabelText("Bedrag (incl. BTW) *") as HTMLInputElement;
const opslaanBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const fillAndSave = async (amount: string) => {
  const callsBefore = addMutateAsync.mock.calls.length;
  fireEvent.change(amountInput(), { target: { value: amount } });
  fireEvent.click(opslaanBtn());
  await waitFor(() => expect(addMutateAsync.mock.calls.length).toBeGreaterThan(callsBefore));
};

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
  setSelectedClientIdSpy.mockReset();
  addMutateAsync.mockReset().mockResolvedValue({});
  deleteMutateAsync.mockReset().mockResolvedValue("deleted");
  refetchSpy.mockReset();
  exportJournalEntriesCSVSpy.mockReset();
  pending.add = false;
  pending.delete = false;
});

describe("Snelle invoer — basis", () => {
  // 1. pagina rendert
  it("rendert de pagina", () => {
    renderBoekingen();
    expect(screen.getByRole("heading", { name: "Nieuwe boeking" })).toBeInTheDocument();
  });

  // 2. sr-only Snelle invoer titel
  it("heeft een sr-only h1 met Snelle invoer", () => {
    renderBoekingen();
    const h1 = document.querySelector("h1");
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveTextContent("Snelle invoer");
    expect(h1).toHaveClass("sr-only");
  });
});

describe("Snelle invoer — administratiekeuze", () => {
  // 3. specifieke administratie uit ClientContext initieel gebruikt
  it("gebruikt de specifieke administratie uit ClientContext bij initialisatie", async () => {
    state.selectedClientId = "client-1";
    renderBoekingen();
    expect(screen.queryByText(/kies eerst een specifieke administratie/i)).not.toBeInTheDocument();
    await fillAndSave("50");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ client_id: "client-1" }));
  });

  // 4. `all` toont NoClientBanner
  it("toont de NoClientBanner wanneer ClientContext op 'all' staat", () => {
    state.selectedClientId = "all";
    renderBoekingen();
    expect(screen.getByText("Kies eerst een specifieke administratie om een boeking toe te voegen.")).toBeInTheDocument();
  });

  // 5. geen specifieke client → save geblokkeerd
  it("blokkeert Opslaan wanneer er geen specifieke administratie is gekozen", () => {
    state.selectedClientId = "all";
    renderBoekingen();
    expect(opslaanBtn()).toBeDisabled();
    fireEvent.click(opslaanBtn());
    expect(addMutateAsync).not.toHaveBeenCalled();
  });

  // 6. client switch synchroniseert ClientContext
  it("synchroniseert ClientContext wanneer een andere klant wordt gekozen", () => {
    renderBoekingen();
    fireEvent.click(screen.getByLabelText("Klant *"));
    fireEvent.click(screen.getByRole("option", { name: /klant twee/i }));
    expect(setSelectedClientIdSpy).toHaveBeenCalledWith("client-2");
  });
});

describe("Snelle invoer — BTW", () => {
  // 7. BTW-vrijgestelde klant zet BTW op 0
  it("zet het BTW-percentage op 0 bij een BTW-vrijgestelde klant", async () => {
    renderBoekingen();
    fireEvent.click(screen.getByLabelText("Klant *"));
    fireEvent.click(screen.getByRole("option", { name: /klant twee/i }));
    expect(screen.getByText("0%")).toBeInTheDocument();
    await fillAndSave("100");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ btw_percentage: 0, btw_amount: 0 }));
  });

  // 8. normale klant gebruikt bestaande BTW-default
  it("gebruikt het bestaande BTW-standaardpercentage (21%) voor een normale klant", async () => {
    renderBoekingen();
    expect(screen.getByText("21%")).toBeInTheDocument();
    await fillAndSave("121");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ btw_percentage: 21 }));
  });
});

describe("Snelle invoer — velden", () => {
  // 9. datumveld intact
  it("houdt het datumveld werkend", () => {
    renderBoekingen();
    const dateInput = screen.getByLabelText("Datum") as HTMLInputElement;
    expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(dateInput, { target: { value: "2026-01-15" } });
    expect(dateInput).toHaveValue("2026-01-15");
  });

  // 10. grootboekcombobox intact
  it("houdt de GrootboekCombobox werkend en neemt de waarde over in de payload", async () => {
    renderBoekingen();
    fireEvent.change(screen.getByLabelText("Grootboekrekening"), { target: { value: "4400 - Kantoorkosten" } });
    await fillAndSave("50");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      ledger_account_text: "4400 - Kantoorkosten",
      grootboekrekening_id: "gb-mock-1",
    }));
  });

  // 11. bedrag verplicht
  it("blokkeert opslaan zonder bedrag en toont de validatiemelding", () => {
    renderBoekingen();
    fireEvent.click(opslaanBtn());
    expect(toastSpy).toHaveBeenCalledWith({ title: "Vul een bedrag in", variant: "destructive" });
    expect(addMutateAsync).not.toHaveBeenCalled();
  });

  // 12. amount incl.-semantiek blijft
  it("stuurt het ingevoerde bedrag als incl.-bedrag door", async () => {
    await (async () => {
      renderBoekingen();
      await fillAndSave("121");
    })();
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ amount: 121 }));
  });

  // 13. BTW-berekening vóór payload blijft exact
  it("berekent het BTW-bedrag exact volgens de bestaande formule vóór de payload", async () => {
    renderBoekingen();
    await fillAndSave("100"); // 100 - 100/1.21 = 17.36 (afgerond)
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ amount: 100, btw_amount: 17.36 }));
  });

  // 14. buildJournalEntryInsertPayload blijft gebruikt
  it("gebruikt de bestaande payload-builder (herkenbaar aan entry_type en ledger_account_id)", async () => {
    renderBoekingen();
    await fillAndSave("50");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      entry_type: "handmatig",
      ledger_account_id: null,
    }));
  });

  // 21. factuurnummer optioneel
  it("laat factuurnummer optioneel — opslaan lukt zonder", async () => {
    renderBoekingen();
    await fillAndSave("50");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ invoice_number: null }));
  });

  // 22. omschrijving intact
  it("neemt de omschrijving mee in de payload", async () => {
    renderBoekingen();
    fireEvent.change(screen.getByLabelText("Omschrijving"), { target: { value: "Test omschrijving" } });
    await fillAndSave("50");
    expect(addMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ description: "Test omschrijving" }));
  });
});

describe("Snelle invoer — save/reset", () => {
  // 15, 16. save gebruikt bestaande mutation + succes toast
  it("roept de bestaande add-mutation aan en toont de succes-toast", async () => {
    renderBoekingen();
    await fillAndSave("50");
    expect(toastSpy).toHaveBeenCalledWith({ title: "Boeking opgeslagen" });
  });

  // 17, 18, 19, 20. reset exact bestaande velden; client/datum/BTW blijven staan
  it("reset na opslaan alleen bedrag/factuurnummer/omschrijving/grootboek — client, datum en BTW blijven staan", async () => {
    renderBoekingen();
    const dateInput = screen.getByLabelText("Datum") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-02-10" } });
    fireEvent.change(screen.getByLabelText("Factuurnummer"), { target: { value: "F-1" } });
    fireEvent.change(screen.getByLabelText("Omschrijving"), { target: { value: "Iets" } });
    fireEvent.change(screen.getByLabelText("Grootboekrekening"), { target: { value: "4400 - Kantoorkosten" } });

    await fillAndSave("75");

    expect(amountInput().value).toBe("");
    expect(screen.getByLabelText("Factuurnummer")).toHaveValue("");
    expect(screen.getByLabelText("Omschrijving")).toHaveValue("");
    expect(screen.getByLabelText("Grootboekrekening")).toHaveValue("");
    // Datum en BTW blijven ongewijzigd staan.
    expect(dateInput).toHaveValue("2026-02-10");
    expect(screen.getByText("21%")).toBeInTheDocument();
    // Client blijft: een tweede save zonder opnieuw te kiezen gebruikt nog steeds client-1.
    await fillAndSave("10");
    expect(addMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ client_id: "client-1" }));
    // Focus keert terug naar het bedragveld voor snel herhaald boeken.
    expect(document.activeElement).toBe(amountInput());
  });
});

describe("Snelle invoer — recente boekingen", () => {
  // 23. recente boekingen zichtbaar
  it("toont recente boekingen", () => {
    state.journalEntries = [makeEntry({ description: "Zichtbare boeking" })];
    renderBoekingen();
    expect(screen.getByText("Zichtbare boeking")).toBeInTheDocument();
  });

  // 24. datum formatting
  it("formatteert de datum als DD-MM-YYYY", () => {
    state.journalEntries = [makeEntry({ entry_date: "2026-07-20", description: "Datumtest" })];
    renderBoekingen();
    const row = screen.getByText("Datumtest").closest("tr")!;
    expect(within(row).getByText("20-07-2026")).toBeInTheDocument();
  });

  // 25. grootboeklabel via bestaande helper
  it("toont het grootboeklabel via resolveJournalEntryLedgerLabel met de geladen rekeningen", () => {
    state.ledgers = [{ id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten" }];
    state.journalEntries = [makeEntry({
      description: "Ledger-test",
      grootboekrekening_id: "gb-1",
      ledger_account_text: "oude tekst die genegeerd hoort te worden",
    })];
    renderBoekingen();
    const row = screen.getByText("Ledger-test").closest("tr")!;
    expect(within(row).getByText("4400 - Kantoorkosten")).toBeInTheDocument();
  });

  // 26. bedragen formatGetal
  it("formatteert bedragen met formatGetal (komma als decimaalteken, 2 decimalen, geen valutateken)", () => {
    state.journalEntries = [makeEntry({ description: "Bedragtest", amount: 121 })];
    renderBoekingen();
    const row = screen.getByText("Bedragtest").closest("tr")!;
    expect(within(row).getByText("121,00")).toBeInTheDocument();
  });
});

describe("Snelle invoer — verwijderen", () => {
  // 27. delete opent confirmatie (en toont welke boeking het betreft)
  it("opent een confirmatie met datum, omschrijving en bedrag van de boeking", () => {
    state.journalEntries = [makeEntry({ description: "Te verwijderen boeking", amount: 88, entry_date: "2026-03-05" })];
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));
    expect(screen.getByText("Boeking verwijderen?")).toBeInTheDocument();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Te verwijderen boeking")).toBeInTheDocument();
    expect(within(dialog).getByText("05-03-2026")).toBeInTheDocument();
    expect(within(dialog).getByText("88,00")).toBeInTheDocument();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });

  // 28. cancel delete doet niets
  it("annuleren sluit de confirmatie zonder de mutation aan te roepen", async () => {
    state.journalEntries = [makeEntry({ description: "Blijft bestaan" })];
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuleren" }));
    await waitFor(() => expect(screen.queryByText("Boeking verwijderen?")).not.toBeInTheDocument());
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });

  // 29. confirm delete gebruikt bestaande mutation
  it("bevestigen roept de bestaande delete-mutation aan met het juiste id", async () => {
    const entry = makeEntry({ id: "je-target", description: "Doelwit" });
    state.journalEntries = [entry];
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith("je-target"));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Boeking verwijderd" });
  });

  // 30. delete error toast
  it("toont een foutmelding wanneer de delete-mutation faalt", async () => {
    deleteMutateAsync.mockRejectedValue(new Error("constraint failure"));
    state.journalEntries = [makeEntry({ description: "Faalt bij verwijderen" })];
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({
      title: "Verwijderen mislukt",
      description: "constraint failure",
      variant: "destructive",
    }));
  });
});

describe("Snelle invoer — export", () => {
  // 31. exportknop aanwezig
  it("toont de Export Snelstart-knop", () => {
    renderBoekingen();
    expect(screen.getByRole("button", { name: /export snelstart/i })).toBeInTheDocument();
  });

  // 32. lege export geeft bestaande toast
  it("toont de bestaande foutmelding bij export zonder boekingen", () => {
    state.journalEntries = [];
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: /export snelstart/i }));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Geen boekingen om te exporteren", variant: "destructive" });
    expect(exportJournalEntriesCSVSpy).not.toHaveBeenCalled();
  });

  // 33, 34. export gebruikt exportJournalEntriesCSV met de huidige dataset
  it("gebruikt exportJournalEntriesCSV met de huidige journalEntries-dataset", () => {
    const entries = [makeEntry({ id: "je-a" }), makeEntry({ id: "je-b" })];
    state.journalEntries = entries;
    renderBoekingen();
    fireEvent.click(screen.getByRole("button", { name: /export snelstart/i }));
    expect(exportJournalEntriesCSVSpy).toHaveBeenCalledWith(entries, "Klant Een");
    expect(toastSpy).toHaveBeenCalledWith({ title: "2 boekingen geëxporteerd" });
  });
});

describe("Snelle invoer — states", () => {
  // 35. loading state
  it("toont een laadstatus in plaats van de tabel", () => {
    state.entriesLoading = true;
    renderBoekingen();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // 36. empty state
  it("toont de lege-staat melding wanneer er nog geen boekingen zijn", () => {
    state.journalEntries = [];
    renderBoekingen();
    expect(screen.getByText("Nog geen handmatige boekingen voor deze administratie.")).toBeInTheDocument();
  });
});

describe("Snelle invoer — responsive en scope-grenzen", () => {
  // 37. responsive classes
  it("verbergt alleen Factuurnummer en BTW op kleine schermen", () => {
    state.journalEntries = [makeEntry()];
    renderBoekingen();
    const headers = screen.getAllByRole("columnheader");
    const byName = (name: string) => headers.find((h) => h.textContent === name)!;
    expect(byName("Factuurnummer").className).toMatch(/hidden/);
    expect(byName("Factuurnummer").className).toMatch(/md:table-cell/);
    expect(byName("BTW").className).toMatch(/hidden/);
    for (const name of ["Datum", "Grootboek", "Omschrijving", "Bedrag", "Acties"]) {
      expect(byName(name).className).not.toMatch(/hidden/);
    }
  });

  // 38. geen jaarfilter
  it("bevat geen jaar-/boekjaarfilter", () => {
    renderBoekingen();
    expect(screen.queryByText(/boekjaar/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/jaar/i)).not.toBeInTheDocument();
  });

  // 39. geen debet/credit UI
  it("bevat geen debet-/creditvelden", () => {
    renderBoekingen();
    expect(screen.queryByText(/debet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/credit/i)).not.toBeInTheDocument();
  });

  // 40. geen nieuwe queryarchitectuur (geen paginatie-UI toegevoegd)
  it("bevat geen paginatiebediening", () => {
    state.journalEntries = [makeEntry()];
    renderBoekingen();
    expect(screen.queryByText(/volgende pagina/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pagina \d+/i)).not.toBeInTheDocument();
  });
});
