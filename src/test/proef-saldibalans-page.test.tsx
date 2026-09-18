import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

/**
 * Fase 6C-b7 PR 3 — de proef- en saldibalanspagina.
 *
 * De datalaag is gemockt; het rekenwerk NIET: buildAccountReport (PR 1) en
 * buildTrialBalance draaien echt. Zo bewijzen deze tests dat de pagina de kern
 * gebruikt en zelf niets optelt.
 */

const state = {
  selectedClientId: "c-1",
  postings: [] as Array<Record<string, unknown>>,
  postingsPending: false,
  postingsError: null as { message: string } | null,
  accounts: [] as Array<Record<string, unknown>>,
  accountsPending: false,
  accountsError: false,
  completeness: undefined as unknown,
  completenessPending: false,
  completenessError: false,
};

const { ledgerSpy } = vi.hoisted(() => ({ ledgerSpy: vi.fn() }));

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Résidence Atlas", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({
    data: state.accounts,
    isPending: state.accountsPending,
    isError: state.accountsError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: unknown) => {
    ledgerSpy(opts);
    return {
      // React Query houdt `data` vast wanneer een achtergrondverversing faalt;
      // die combinatie moet uitdrukbaar zijn, anders blijft de staleexport-bug
      // onzichtbaar voor de test.
      data: state.postingsPending ? undefined : state.postings,
      isPending: state.postingsPending,
      isError: !!state.postingsError,
      error: state.postingsError,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({
    data: state.completeness,
    isPending: state.completenessPending,
    isError: state.completenessError,
  }),
  // 6C-b8 PR 3: beginbalansdimensie; standaard niet aanwezig zodat de bestaande verwachtingen gelden.
  useOpeningBalanceCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
}));

import ProefSaldibalans from "@/pages/ProefSaldibalans";
import { computeLedgerCompleteness, unknownLedgerCompleteness } from "@/lib/ledger-completeness";

// Byte order mark als code point: een letterlijk teken in de bron is
// onzichtbaar en sneuvelt bij de eerste bewerking.
const BOM = String.fromCharCode(0xfeff);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}
function renderPage(path = "/overzichten/proef-saldibalans") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/overzichten/proef-saldibalans" element={<ProefSaldibalans />} />
        <Route path="/grootboek/saldi/:accountId" element={<div>rekeningpagina</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

let seq = 0;
const p = (over: Record<string, unknown>) => {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: "c-1",
    organization_id: "org-1",
    posting_group_id: "g-1",
    line_no: 1,
    posting_date: "2027-02-01",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "manual_journal",
    source_id: "mj-1",
    source_line_id: null,
    reversal_of_posting_id: null,
    user_id: "u-1",
    created_at: "2027-02-01T00:00:00Z",
    created_xact_id: "1",
    ...over,
  };
};
const YEAR = new Date().getFullYear();
const grp = (g: string, date: string, legs: Array<[string, number, number]>) =>
  legs.map(([acc, d, c], i) =>
    p({ posting_group_id: g, line_no: i + 1, posting_date: date, boekjaar: Number(date.slice(0, 4)), grootboekrekening_id: acc, debit_amount: d, credit_amount: c }),
  );

const accounts = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true, client_id: null },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true, client_id: null },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true, client_id: null },
  { id: "gb-7777", nummer: 7777, omschrijving: "Nooit gebruikt", categorie: "kosten", actief: true, client_id: null },
];

const rows = () => screen.getAllByTestId("psb-row");
const exportBtn = () => screen.getByTestId("psb-export") as HTMLButtonElement;

// CSV-download opvangen zonder echte browser-download.
let blobDelen: string[] = [];
let laatsteNaam = "";
beforeEach(() => {
  ledgerSpy.mockClear();
  state.selectedClientId = "c-1";
  state.postings = [];
  state.postingsPending = false;
  state.postingsError = null;
  state.accounts = accounts;
  state.accountsPending = false;
  state.accountsError = false;
  state.completeness = undefined;
  state.completenessPending = false;
  state.completenessError = false;
  blobDelen = [];
  laatsteNaam = "";
  vi.stubGlobal("Blob", class {
    constructor(parts: string[]) { blobDelen = parts; }
  });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    laatsteNaam = this.download;
  });
});

describe("ProefSaldibalans — pagina", () => {
  it("1. zonder specifieke administratie: NoClientBanner, geen tabel", () => {
    state.selectedClientId = "all";
    renderPage();
    expect(screen.getByText(/Kies eerst een specifieke administratie/)).toBeInTheDocument();
    expect(screen.queryByTestId("psb-row")).toBeNull();
  });

  it("2. laden toont een skeleton en geen cijfers", () => {
    state.postingsPending = true;
    renderPage();
    expect(screen.getByText("Proef- en saldibalans laden…")).toBeInTheDocument();
    expect(screen.queryByTestId("psb-row")).toBeNull();
    expect(exportBtn().disabled).toBe(true);
  });

  it("3. leeg grootboek geeft een eerlijke lege staat", () => {
    renderPage();
    expect(screen.getByText("Nog geen geboekte grootboekmutaties voor deze periode.")).toBeInTheDocument();
    expect(screen.queryByTestId("psb-row")).toBeNull();
  });

  it("4. geldig rapport: negen kolommen, rijen en een totaalregel", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 121, 0], ["gb-1600", 0, 121]]);
    renderPage();
    for (const kop of ["Rekening", "Omschrijving", "Categorie", "Beginsaldo debet", "Beginsaldo credit",
      "Periode debet", "Periode credit", "Eindsaldo debet", "Eindsaldo credit"]) {
      expect(screen.getByRole("columnheader", { name: kop })).toBeInTheDocument();
    }
    expect(rows()).toHaveLength(2);
    const totaal = screen.getByTestId("psb-totals");
    expect(totaal).toHaveTextContent("2 rekeningen");
    const cellen = totaal.querySelectorAll("td");
    expect(cellen[3]).toHaveTextContent("121,00"); // periode debet
    expect(cellen[4]).toHaveTextContent("121,00"); // periode credit
  });

  it("6. een creditsaldo staat positief in de creditkolom, niet negatief", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 250, 0], ["gb-1600", 0, 250]]);
    renderPage();
    const cred = rows().find((r) => r.getAttribute("data-account-id") === "gb-1600")!;
    const td = cred.querySelectorAll("td");
    expect(td[7]).toHaveTextContent("0,00");   // eindsaldo debet
    expect(td[8]).toHaveTextContent("250,00"); // eindsaldo credit
    expect(td[8].textContent).not.toContain("-");
  });

  it("15. een falende zelfcontrole blokkeert de cijfers en de export", () => {
    state.postings = [
      p({ grootboekrekening_id: "gb-4000", debit_amount: 100, posting_date: `${YEAR}-02-01`, posting_group_id: "g-a" }),
      p({ grootboekrekening_id: "gb-1600", credit_amount: 100, posting_date: `${YEAR}-02-01`, posting_group_id: "g-b" }),
    ];
    renderPage();
    const alert = screen.getByTestId("psb-self-check-failed");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit.");
    expect(screen.queryByTestId("psb-row")).toBeNull();
    expect(screen.queryByTestId("psb-totals")).toBeNull();
    expect(exportBtn().disabled).toBe(true);
  });

  it("17. een niet-EUR-rij blokkeert de cijfers", () => {
    state.postings = [
      ...grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]),
      ...grp("g-2", `${YEAR}-02-02`, [["gb-4000", 5, 0], ["gb-1600", 0, 5]]).map((r) => ({ ...r, currency: "USD" })),
    ];
    renderPage();
    expect(screen.getByTestId("psb-error")).toHaveTextContent(/alleen EUR/);
    expect(screen.queryByTestId("psb-row")).toBeNull();
    expect(exportBtn().disabled).toBe(true);
  });

  it("22/23. nulrekeningen verschijnen pas met de schakelaar, zonder de totalen te raken", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    renderPage();
    expect(rows()).toHaveLength(2);
    const totaalVoor = screen.getByTestId("psb-totals").textContent;

    fireEvent.click(screen.getByLabelText("Toon nulrekeningen"));
    const na = rows();
    expect(na.length).toBeGreaterThan(2);
    expect(na.map((r) => r.getAttribute("data-account-id"))).toContain("gb-7777");
    expect(screen.getByTestId("psb-totals").textContent?.replace(/\d+ rekening(en)?/, "")).toBe(
      totaalVoor?.replace(/\d+ rekening(en)?/, ""),
    );
  });

  it("24. de rekeningnaam linkt naar de bestaande rekeningpagina", async () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    renderPage();
    const link = screen.getByRole("link", { name: "Open mutaties van 4000 - Kosten" });
    expect(link).toHaveAttribute("href", "/grootboek/saldi/gb-4000");
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/grootboek/saldi/gb-4000"));
  });

  it("25/26/27. periodefilters gaan half-open door, met dezelfde omzetting als PR 2", () => {
    renderPage();
    const laatste = () => ledgerSpy.mock.calls.at(-1)![0] as { clientId: string; period: { from: string; toExclusive: string } };
    expect(laatste()).toMatchObject({ clientId: "c-1", period: { from: `${YEAR}-01-01`, toExclusive: `${YEAR + 1}-01-01` } });
    expect(JSON.stringify(laatste())).not.toContain("boekjaar");

    fireEvent.click(screen.getByRole("button", { name: String(YEAR - 1) }));
    expect(laatste().period).toEqual({ from: `${YEAR - 1}-01-01`, toExclusive: `${YEAR}-01-01` });

    fireEvent.click(screen.getByRole("button", { name: "Alle jaren" }));
    expect(laatste().period).toEqual({ from: "2000-01-01", toExclusive: "2101-01-01" });

    fireEvent.change(screen.getByLabelText("Van"), { target: { value: "2027-02-01" } });
    fireEvent.change(screen.getByLabelText("Tot en met"), { target: { value: "2027-02-28" } });
    fireEvent.click(screen.getByRole("button", { name: "Periode toepassen" }));
    expect(laatste().period).toEqual({ from: "2027-02-01", toExclusive: "2027-03-01" });
    expect(screen.getByTestId("psb-period-label")).toHaveTextContent("01-02-2027 t/m 28-02-2027");
  });

  it("28/29. de volledigheidsmelding staat er en raakt geen enkel bedrag", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    state.completeness = computeLedgerCompleteness({
      purchase: { eligible: 10, posted: 7 },
      sales: { eligible: 5, posted: 5, refusedVerlegd: 2 },
      bank: { eligible: 4, posted: 4, awaitingInvoice: 0 },
      manual: { total: 2, posted: 1 },
    });
    renderPage();
    const melding = screen.getByTestId("ledger-completeness");
    expect(melding).toHaveAttribute("data-status", "incomplete");
    expect(melding).not.toHaveTextContent("€");
    // De cijfers zijn precies gelijk aan het geval zonder volledigheidsdata.
    const totaalMet = screen.getByTestId("psb-totals").textContent;
    state.completeness = undefined;
    renderPage();
    expect(screen.getAllByTestId("psb-totals").at(-1)!.textContent).toBe(totaalMet);
  });

  it("30. onbekende volledigheid wordt eerlijk gemeld en blokkeert het rapport niet", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    state.completeness = unknownLedgerCompleteness();
    renderPage();
    expect(screen.getByTestId("ledger-completeness")).toHaveAttribute("data-status", "unknown");
    expect(rows()).toHaveLength(2);
    expect(exportBtn().disabled).toBe(false);
  });

  it("31/32. export is uit bij een ongeldig rapport en levert anders exact de zichtbare rijen", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 121.5, 0], ["gb-1600", 0, 121.5]]);
    renderPage();
    expect(exportBtn().disabled).toBe(false);
    fireEvent.click(exportBtn());

    const csv = blobDelen.join("");
    expect(csv.startsWith(BOM)).toBe(true);
    const regels = csv.replace(new RegExp(`^${BOM}`), "").trimEnd().split("\r\n");
    // kop + zichtbare rijen + totaal
    expect(regels).toHaveLength(rows().length + 2);
    expect(regels[0].split(";")).toHaveLength(9);
    expect(csv).toContain('"121,50"');
    expect(csv).not.toContain("€");
    expect(laatsteNaam).toBe(`proef-en-saldibalans-residence-atlas-${YEAR}.csv`);
  });

  it("31b. een mislukte verversing met behouden data: geen cijfers EN geen export (review P1)", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 121, 0], ["gb-1600", 0, 121]]);
    state.postingsError = { message: "JWT expired" };
    renderPage();
    // Het scherm faalt dicht…
    expect(screen.getByTestId("psb-error")).toHaveTextContent("JWT expired");
    expect(screen.queryByTestId("psb-row")).toBeNull();
    // …en de export mag de cijfers van vóór de fout niet meer weggeven.
    expect(exportBtn().disabled).toBe(true);
    fireEvent.click(exportBtn());
    expect(blobDelen).toEqual([]);
    expect(laatsteNaam).toBe("");
  });

  it("P2. een mislukt rekeningschema blokkeert het rapport in plaats van 'Onbekende rekening' overal", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 121, 0], ["gb-1600", 0, 121]]);
    state.accounts = [];
    state.accountsError = true;
    renderPage();
    expect(screen.getByTestId("psb-accounts-error")).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("psb-row")).toBeNull();
    expect(exportBtn().disabled).toBe(true);
    fireEvent.click(exportBtn());
    expect(blobDelen).toEqual([]);
  });

  it("P2b. terwijl het rekeningschema laadt verschijnt er nog geen rapport", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 121, 0], ["gb-1600", 0, 121]]);
    state.accountsPending = true;
    renderPage();
    expect(screen.getByText("Proef- en saldibalans laden…")).toBeInTheDocument();
    expect(screen.queryByTestId("psb-row")).toBeNull();
    expect(exportBtn().disabled).toBe(true);
  });

  it("P3-2. een leeg rapport levert geen exporteerbaar bestand op", () => {
    renderPage();
    expect(screen.getByText("Nog geen geboekte grootboekmutaties voor deze periode.")).toBeInTheDocument();
    expect(exportBtn().disabled).toBe(true);
  });

  it("P3-3. met 'Toon nulrekeningen' aan wint het rekeningschema van de lege staat", () => {
    renderPage(); // geen boekingen
    fireEvent.click(screen.getByLabelText("Toon nulrekeningen"));
    expect(screen.queryByText("Nog geen geboekte grootboekmutaties voor deze periode.")).toBeNull();
    expect(rows().length).toBe(accounts.length);
    expect(exportBtn().disabled).toBe(false);
  });

  it("er is precies één h1 en de tabel heeft een caption", () => {
    state.postings = grp("g-1", `${YEAR}-02-01`, [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Proef- en saldibalans");
    expect(screen.getByRole("table")).toContainHTML("<caption");
  });
});
