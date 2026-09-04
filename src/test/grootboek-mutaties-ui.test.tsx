import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  selectedClientId: "c1" as string,
  clients: [] as any[],
  purchase: [] as any[],
  sales: [] as any[],
  journal: [] as any[],
  bank: [] as any[],
  allocations: [] as any[],
  accounts: [] as any[],
  loading: false,
  purchaseError: false,
  bankError: false,
};

const navigateSpy = vi.fn();
const setSelectedClientIdSpy = vi.fn();
const refetchSpy = vi.fn();

vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({
    selectedClientId: state.selectedClientId,
    setSelectedClientId: setSelectedClientIdSpy,
  }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: state.clients }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({
    data: state.purchase,
    isLoading: state.loading,
    isError: state.purchaseError,
    refetch: refetchSpy,
  }),
}));
vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: state.sales, isLoading: state.loading, isError: false, refetch: refetchSpy }),
}));
vi.mock("@/hooks/useJournalEntries", () => ({
  useJournalEntries: () => ({ data: state.journal, isLoading: state.loading, isError: false, refetch: refetchSpy }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({
    data: state.bank,
    isLoading: state.loading,
    isError: state.bankError,
    refetch: refetchSpy,
  }),
}));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({
    data: state.allocations,
    isLoading: state.loading,
    isError: false,
    refetch: refetchSpy,
  }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: state.accounts }),
}));

import GrootboekMutaties from "@/pages/GrootboekMutaties";

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/grootboek/mutaties"]}>
      <GrootboekMutaties />
    </MemoryRouter>,
  );
}

const table = () => screen.getByRole("table");
const rowFor = (text: string) => screen.getByText(text).closest("tr")!;
const sourceFilters = () => within(screen.getByTestId("source-filters"));

const purchaseInv = (over: Partial<any> = {}) => ({
  id: "pi-1", client_id: "c1", status: "gecontroleerd", invoice_date: "2026-03-10",
  supplier: "Acme B.V.", invoice_number: "F-001", amount_incl: 121, amount_excl: 100,
  btw_amount: 21, grootboekrekening_id: null, ledger_account_text: "4400 - Kantoorkosten", ...over,
});
const salesInv = (over: Partial<any> = {}) => ({
  id: "si-1", client_id: "c1", status: "gecontroleerd", invoice_date: "2026-04-01",
  customer_name: "Klant X", invoice_number: "V-001", amount_incl: 1210, amount_excl: 1000,
  btw_amount: 210, ledger_account_text: "8000 - Omzet hoog", ...over,
});
const journalEntry = (over: Partial<any> = {}) => ({
  id: "je-1", client_id: "c1", entry_date: "2026-05-05", amount: 60.5, btw_amount: 10.5,
  description: "Handmatige boeking", invoice_number: "J-001",
  grootboekrekening_id: "gb-4400", ledger_account_text: "4400 - Kantoorkosten", ...over,
});
const bankTx = (over: Partial<any> = {}) => ({
  id: "bt-1", client_id: "c1", transaction_date: "2026-06-06", amount: -75,
  match_status: "handmatig_geboekt", description: "Bankkosten juni", reference: null,
  counter_account: null, camt_counterparty_name: null, grootboekrekening_id: "gb-4400", ...over,
});

const seedAll = () => {
  state.purchase = [purchaseInv()];
  state.sales = [salesInv()];
  state.journal = [journalEntry()];
  state.bank = [bankTx()];
};

beforeEach(() => {
  state.selectedClientId = "c1";
  state.clients = [{ id: "c1", name: "Klant Een" }, { id: "c2", name: "Klant Twee" }];
  state.purchase = [];
  state.sales = [];
  state.journal = [];
  state.bank = [];
  state.allocations = [];
  state.accounts = [
    { id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten" },
    { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog" },
  ];
  state.loading = false;
  state.purchaseError = false;
  state.bankError = false;
  navigateSpy.mockReset();
  setSelectedClientIdSpy.mockReset();
  refetchSpy.mockReset();
});

describe("Grootboekmutaties — basis", () => {
  // 31. pagina rendert
  it("31. rendert de pagina met sr-only titel", () => {
    renderPage();
    const h1 = document.querySelector("h1");
    expect(h1).toHaveTextContent("Grootboekmutaties");
    expect(h1).toHaveClass("sr-only");
  });

  // 32. administratiefilter
  it("32. administratiefilter is aanwezig en synchroniseert ClientContext", () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Administratie"));
    fireEvent.click(screen.getByRole("option", { name: "Klant Twee" }));
    expect(setSelectedClientIdSpy).toHaveBeenCalledWith("c2");
  });

  it("32b. zonder specifieke administratie wordt de NoClientBanner getoond", () => {
    state.selectedClientId = "all";
    seedAll();
    renderPage();
    expect(screen.getByText(/kies eerst een specifieke administratie/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("Grootboekmutaties — filters", () => {
  // 33. jaarfilter
  it("33. filtert op jaar", () => {
    state.journal = [
      journalEntry({ id: "je-2025", entry_date: "2025-02-02", description: "Boeking 2025" }),
      journalEntry({ id: "je-2026", entry_date: "2026-02-02", description: "Boeking 2026" }),
    ];
    renderPage();
    expect(screen.getByText("Boeking 2025")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Jaar"));
    fireEvent.click(screen.getByRole("option", { name: "2026" }));
    expect(screen.getByText("Boeking 2026")).toBeInTheDocument();
    expect(screen.queryByText("Boeking 2025")).not.toBeInTheDocument();
  });

  // 34. bronfilter
  it("34. filtert op bron", () => {
    seedAll();
    renderPage();
    expect(screen.getByText("Acme B.V.")).toBeInTheDocument();
    fireEvent.click(sourceFilters().getByRole("button", { name: "Bank" }));
    expect(screen.getByText("Bankkosten juni")).toBeInTheDocument();
    expect(screen.queryByText("Acme B.V.")).not.toBeInTheDocument();
    expect(screen.queryByText("Klant X")).not.toBeInTheDocument();
  });

  // 35. rekeningfilter
  it("35. filtert op grootboekrekening en sluit verkoop zonder FK transparant uit", () => {
    seedAll();
    renderPage();
    fireEvent.click(screen.getByLabelText("Grootboekrekening"));
    fireEvent.click(screen.getByRole("option", { name: "4400 - Kantoorkosten" }));
    // Journal + bank hebben gb-4400; verkoop heeft nooit een FK.
    expect(screen.getByText("Handmatige boeking")).toBeInTheDocument();
    expect(screen.getByText("Bankkosten juni")).toBeInTheDocument();
    expect(screen.queryByText("Klant X")).not.toBeInTheDocument();
    expect(screen.getByText(/verkoopfacturen hebben geen gekoppelde grootboekrekening/i)).toBeInTheDocument();
  });

  // 36. zoeken
  it("36. zoekt over omschrijving, referentie en rekeninglabel", () => {
    seedAll();
    renderPage();
    const box = screen.getByPlaceholderText(/zoek op omschrijving/i);
    fireEvent.change(box, { target: { value: "acme" } });
    expect(screen.getByText("Acme B.V.")).toBeInTheDocument();
    expect(screen.queryByText("Klant X")).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: "V-001" } });
    expect(screen.getByText("Klant X")).toBeInTheDocument();
  });
});

describe("Grootboekmutaties — rijen", () => {
  // 37. inkooprij
  it("37. toont een inkooprij met datum, bedrag en BTW", () => {
    state.purchase = [purchaseInv()];
    renderPage();
    const row = rowFor("Acme B.V.");
    expect(within(row).getByText("10-03-2026")).toBeInTheDocument();
    expect(within(row).getByText("121,00")).toBeInTheDocument();
    expect(within(row).getByText("21,00")).toBeInTheDocument();
    expect(within(row).getByText("F-001")).toBeInTheDocument();
  });

  // 38. verkooprij
  it("38. toont een verkooprij", () => {
    state.sales = [salesInv()];
    renderPage();
    const row = rowFor("Klant X");
    expect(within(row).getByText("01-04-2026")).toBeInTheDocument();
    expect(within(row).getByText("1.210,00")).toBeInTheDocument();
  });

  // 39. bankrij
  it("39. toont een bankrij met behoud van het ondertekende bedrag", () => {
    state.bank = [bankTx({ amount: -75 })];
    renderPage();
    const row = rowFor("Bankkosten juni");
    expect(within(row).getByText("06-06-2026")).toBeInTheDocument();
    expect(within(row).getByText("-75,00")).toBeInTheDocument();
  });

  // 40. handmatige rij
  it("40. toont een handmatige rij", () => {
    state.journal = [journalEntry()];
    renderPage();
    const row = rowFor("Handmatige boeking");
    expect(within(row).getByText("05-05-2026")).toBeInTheDocument();
    expect(within(row).getByText("60,50")).toBeInTheDocument();
  });

  // 41. bronbadge
  it("41. toont per rij een bronbadge", () => {
    seedAll();
    renderPage();
    expect(within(rowFor("Acme B.V.")).getByText("Inkoop")).toBeInTheDocument();
    expect(within(rowFor("Klant X")).getByText("Verkoop")).toBeInTheDocument();
    expect(within(rowFor("Bankkosten juni")).getByText("Bank")).toBeInTheDocument();
    expect(within(rowFor("Handmatige boeking")).getByText("Handmatig")).toBeInTheDocument();
  });

  // 42. bedrag formatting
  it("42. formatteert bedragen monospaced/tabular en rechts uitgelijnd", () => {
    state.purchase = [purchaseInv({ amount_incl: 1234.5 })];
    renderPage();
    const cell = within(rowFor("Acme B.V.")).getByText("1.234,50");
    expect(cell.className).toMatch(/font-mono/);
    expect(cell.className).toMatch(/tabular-nums/);
    expect(cell.className).toMatch(/text-right/);
  });

  // 43. ledger ID lookup
  it("43. lost een echte grootboekrekening_id op naar nummer - omschrijving", () => {
    state.journal = [journalEntry({ grootboekrekening_id: "gb-4400", ledger_account_text: "oude tekst" })];
    renderPage();
    expect(within(rowFor("Handmatige boeking")).getByText("4400 - Kantoorkosten")).toBeInTheDocument();
  });

  // 44. vrije ledger text
  it("44. toont vrije tekst met 'Niet gekoppeld' wanneer er geen FK is", () => {
    state.purchase = [purchaseInv({ grootboekrekening_id: null, ledger_account_text: "4400 - Kantoorkosten" })];
    renderPage();
    const row = rowFor("Acme B.V.");
    expect(within(row).getByText("4400 - Kantoorkosten")).toBeInTheDocument();
    expect(within(row).getByText("Niet gekoppeld")).toBeInTheDocument();
  });

  // 45. verkoop zonder ledger ID
  it("45. verkoop krijgt nooit een gekoppelde rekening", () => {
    state.sales = [salesInv({ ledger_account_text: "8000 - Omzet hoog" })];
    renderPage();
    const row = rowFor("Klant X");
    expect(within(row).getByText("8000 - Omzet hoog")).toBeInTheDocument();
    expect(within(row).getByText("Niet gekoppeld")).toBeInTheDocument();
  });
});

describe("Grootboekmutaties — drill-down", () => {
  // 46. inkoop drill-down
  it("46. inkoop navigeert naar de bestaande workspace-route", () => {
    state.purchase = [purchaseInv({ id: "pi-42" })];
    renderPage();
    fireEvent.click(within(rowFor("Acme B.V.")).getByRole("button", { name: /open bron/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/facturen/inkoop/pi-42");
  });

  // 47. verkoop navigatie
  it("47. verkoop navigeert naar /verkoop", () => {
    state.sales = [salesInv()];
    renderPage();
    fireEvent.click(within(rowFor("Klant X")).getByRole("button", { name: /open bron/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/verkoop");
  });

  // 48. bank navigatie
  it("48. bank navigeert naar /bank", () => {
    state.bank = [bankTx()];
    renderPage();
    fireEvent.click(within(rowFor("Bankkosten juni")).getByRole("button", { name: /open bron/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/bank");
  });

  // 49. journal navigatie
  it("49. handmatig navigeert naar /boekingen", () => {
    state.journal = [journalEntry()];
    renderPage();
    fireEvent.click(within(rowFor("Handmatige boeking")).getByRole("button", { name: /open bron/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/boekingen");
  });
});

describe("Grootboekmutaties — transparantie", () => {
  // 50. excluded bank count
  it("50. toont hoeveel banktransacties niet zijn opgenomen, met redenen", () => {
    state.journal = [journalEntry()];
    state.bank = [
      bankTx({ id: "b1", match_status: "niet_gematcht" }),
      bankTx({ id: "b2", match_status: "suggestie" }),
      bankTx({ id: "b3", match_status: "gematcht" }),
      bankTx({ id: "b4", grootboekrekening_id: null }),
    ];
    renderPage();
    const note = screen.getByTestId("excluded-bank");
    expect(note).toHaveTextContent("4 banktransacties niet opgenomen");
    expect(note).toHaveTextContent("1 afgeletterd");
    expect(note).toHaveTextContent("1 niet gematcht");
    expect(note).toHaveTextContent("1 suggestie");
    expect(note).toHaveTextContent("1 zonder rekening");
  });

  it("50b. afgeletterde betaling telt niet dubbel naast de factuur", () => {
    state.purchase = [purchaseInv()];
    state.bank = [bankTx({ id: "bt-pay", amount: -121, match_status: "gematcht" })];
    state.allocations = [{ bank_transaction_id: "bt-pay" }];
    renderPage();
    expect(screen.getByText("Acme B.V.")).toBeInTheDocument();
    expect(screen.queryByText("Bankkosten juni")).not.toBeInTheDocument();
    expect(screen.getByTestId("mutation-count")).toHaveTextContent("1 mutatie");
  });

  // 51. uitleg dubbeltelling zichtbaar
  it("51. toont de uitleg over dubbeltelling", () => {
    renderPage();
    expect(
      screen.getByText(/zonder betalingen dubbel te tellen/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/afgeletterde bankbetalingen worden niet nogmaals/i)).toBeInTheDocument();
  });
});

describe("Grootboekmutaties — states", () => {
  // 52. loading
  it("52. toont een laadstatus in plaats van de tabel", () => {
    state.loading = true;
    seedAll();
    renderPage();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // 53. query error
  it("53. toont een foutstatus met retry wanneer een bron faalt — geen deellijst", () => {
    seedAll();
    state.purchaseError = true;
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(/mutaties laden is mislukt/i);
    expect(screen.getByText(/onvolledige financiële cijfers te voorkomen/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /opnieuw proberen/i }));
    expect(refetchSpy).toHaveBeenCalled();
  });

  // 54. empty states
  it("54. toont de lege staat zonder mutaties", () => {
    renderPage();
    expect(screen.getByText(/nog geen financiële mutaties voor deze administratie/i)).toBeInTheDocument();
  });

  it("54b. toont een bronspecifieke lege staat", () => {
    state.purchase = [purchaseInv()];
    renderPage();
    fireEvent.click(sourceFilters().getByRole("button", { name: "Bank" }));
    expect(screen.getByText(/geen mutaties uit bron bank/i)).toBeInTheDocument();
  });

  it("54c. toont een zoekspecifieke lege staat", () => {
    state.purchase = [purchaseInv()];
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/zoek op omschrijving/i), { target: { value: "zzz" } });
    expect(screen.getByText(/geen mutaties gevonden voor/i)).toBeInTheDocument();
  });

  it("54d. toont een jaarspecifieke lege staat", () => {
    state.journal = [journalEntry({ entry_date: "2025-01-01" })];
    state.purchase = [purchaseInv({ invoice_date: "2026-01-01" })];
    renderPage();
    fireEvent.click(screen.getByLabelText("Jaar"));
    fireEvent.click(screen.getByRole("option", { name: "2026" }));
    fireEvent.click(sourceFilters().getByRole("button", { name: "Handmatig" }));
    expect(screen.getByText(/geen mutaties uit bron handmatig/i)).toBeInTheDocument();
  });
});

describe("Grootboekmutaties — scope-grenzen", () => {
  // 55, 56, 57. geen debet/credit/saldo kolommen
  it("55-57. bevat geen Debet-, Credit- of Saldo-kolom", () => {
    seedAll();
    renderPage();
    const headers = within(table()).getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(["Datum", "Bron", "Rekening", "Omschrijving", "Referentie", "BTW", "Bedrag", "Actie"]);
    expect(headers).not.toContain("Debet");
    expect(headers).not.toContain("Credit");
    expect(headers).not.toContain("Saldo");
  });

  // 58. geen totale balans/saldo
  it("58. toont geen totaalbedrag, saldo of balans — alleen een aantal", () => {
    seedAll();
    renderPage();
    expect(screen.getByTestId("mutation-count")).toHaveTextContent("4 mutaties");
    expect(screen.queryByText(/^totaal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/saldo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/balans/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/winst|verlies/i)).not.toBeInTheDocument();
  });

  // 60. bestaande /grootboek route blijft intact
  it("60. /grootboek blijft het rekeningschema; /grootboek/mutaties is een nieuwe, aparte route", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf-8");
    expect(app).toMatch(/path="\/grootboek"\s+element=\{<Grootboek \/>\}/);
    expect(app).toMatch(/path="\/grootboek\/mutaties"\s+element=\{<GrootboekMutaties \/>\}/);
  });

  // 59. responsive gedrag
  it("59. verbergt secundaire kolommen op kleine schermen", () => {
    seedAll();
    renderPage();
    const headers = within(table()).getAllByRole("columnheader");
    const byName = (n: string) => headers.find((h) => h.textContent?.trim() === n)!;
    expect(byName("Rekening").className).toMatch(/hidden/);
    expect(byName("Referentie").className).toMatch(/hidden/);
    expect(byName("BTW").className).toMatch(/hidden/);
    for (const n of ["Datum", "Bron", "Omschrijving", "Bedrag", "Actie"]) {
      expect(byName(n).className).not.toMatch(/hidden/);
    }
  });
});
