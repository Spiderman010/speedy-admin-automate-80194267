import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Het "Met saldo"-filter op het rekeningschema.
 *
 * DEFINITIE, en waarom zij niet `eindsaldo !== 0` is: een rekening waarop
 * €500 is gedebiteerd en €500 gecrediteerd heeft een eindsaldo van nul en tóch
 * een volle kolom mutaties. Die verbergen zou precies de rekeningen
 * wegfilteren waar iets aan de hand is. Het filter draait daarom op dezelfde
 * activiteitsdefinitie als de rapportage-engine, geijkt in
 * `grootboek-account-activity.test.ts`.
 *
 * De fixtures lopen door de échte rapportagekern (`buildAccountReport`);
 * alleen de dataleverende hooks zijn gemockt.
 */

const state = {
  rekeningen: [] as any[],
  clientId: "client-1" as string,
  postings: [] as any[],
  postingsPending: false,
  postingsError: false,
};

const toastSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: any) => ({
    // Dezelfde administratiescheiding als de echte hook: alleen rijen van de
    // gevraagde administratie komen eruit.
    // Net als react-query: geen data zolang de query uit staat of faalde.
    data: opts?.enabled === false || !opts?.clientId || state.postingsError
      ? undefined
      : state.postings.filter((r: any) => r.client_id === opts.clientId),
    isPending: state.postingsPending,
    isError: state.postingsError,
  }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: state.rekeningen, isLoading: false }),
  useAddGrootboekrekening: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateGrootboekrekening: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useDeleteGrootboekrekening: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSeedGrootboekrekeningen: () => ({ mutate: vi.fn(), isPending: false }),
  useCanEditGrootboekClassification: () => ({ data: true }),
}));

import Grootboek from "@/pages/Grootboek";

const CLIENT = "client-1";
const ANDER = "client-2";

const rek = (over: Record<string, unknown> = {}) => ({
  id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten", categorie: "kosten", actief: true,
  client_id: null, organization_id: "org-1",
  statement_type: "winst_verlies", report_group: "overige_bedrijfskosten", normal_side: null, report_sort: null,
  ...over,
});

let seq = 0;
/** Eén sluitende boekingsgroep tussen twee rekeningen. */
function boeking(debet: string, credit: string, bedrag: string, client = CLIENT) {
  seq++;
  const g = `pg-${seq}`;
  const base = {
    client_id: client, posting_group_id: g, posting_date: "2026-04-01", boekjaar: 2026,
    currency: "EUR", source_type: "manual_journal",
  };
  return [
    { ...base, id: `${g}-1`, line_no: 1, grootboekrekening_id: debet, debit_amount: bedrag, credit_amount: "0.00" },
    { ...base, id: `${g}-2`, line_no: 2, grootboekrekening_id: credit, debit_amount: "0.00", credit_amount: bedrag },
  ];
}

const renderPagina = () => render(<MemoryRouter><Grootboek /></MemoryRouter>);

const saldoChip = () => screen.getByRole("button", { name: /met saldo/i });
/**
 * De zichtbare rekeningnummers, in de volgorde van de tabel. De rijen hebben
 * geen testid — net als in de bestaande schematests wordt er op de gerenderde
 * inhoud gekeken, zodat dit filter niets aan de productiecode hoeft toe te
 * voegen om meetbaar te zijn.
 */
const rijNummers = () =>
  Array.from(document.querySelectorAll("tbody tr"))
    .map((r) => r.querySelector("td")?.textContent?.trim() ?? "")
    .filter((n) => n !== "");

beforeEach(() => {
  toastSpy.mockReset();
  state.clientId = CLIENT;
  state.postings = [];
  state.postingsPending = false;
  state.postingsError = false;
  state.rekeningen = [];
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Met saldo", () => {
  it("1. een rekening zonder activiteit verdwijnt zodra het filter aanstaat", () => {
    state.rekeningen = [
      rek({ id: "gb-actief", nummer: 4400 }),
      rek({ id: "gb-stil", nummer: 4500, omschrijving: "Nooit gebruikt" }),
    ];
    state.postings = boeking("gb-actief", "gb-actief2", "100.00");
    renderPagina();

    expect(rijNummers()).toEqual(["4400", "4500"]);
    fireEvent.click(saldoChip());
    expect(rijNummers()).toEqual(["4400"]);
  });

  it("2. een rekening met debet- en creditactiviteit verschijnt", () => {
    state.rekeningen = [rek({ id: "gb-debet", nummer: 4400 }), rek({ id: "gb-credit", nummer: 1600 })];
    state.postings = boeking("gb-debet", "gb-credit", "250.00");
    renderPagina();

    fireEvent.click(saldoChip());
    expect(rijNummers().sort()).toEqual(["1600", "4400"]);
  });

  it("3. activiteit die op nul uitkomt telt nog steeds als saldo", () => {
    // Dit is de kern van de definitie: €500 erin en €500 eruit geeft een
    // eindsaldo van nul, maar de rekening is wel degelijk gebruikt.
    state.rekeningen = [
      rek({ id: "gb-nul", nummer: 4400, omschrijving: "Heen en weer" }),
      rek({ id: "gb-tegen", nummer: 1600 }),
      rek({ id: "gb-stil", nummer: 4500 }),
    ];
    state.postings = [
      ...boeking("gb-nul", "gb-tegen", "500.00"),
      ...boeking("gb-tegen", "gb-nul", "500.00"),
    ];
    renderPagina();

    fireEvent.click(saldoChip());
    const nummers = rijNummers();
    expect(nummers).toContain("4400");
    expect(nummers).not.toContain("4500");
  });

  it("4. Met saldo en Niet geclassificeerd combineren tot de doorsnede", () => {
    state.rekeningen = [
      // saldo + geclassificeerd → valt af op classificatie
      rek({ id: "gb-a", nummer: 4400 }),
      // saldo + niet geclassificeerd → dit is de gezochte rekening
      rek({ id: "gb-b", nummer: 4602, omschrijving: "Telefoon", statement_type: null, report_group: null }),
      // geen saldo + niet geclassificeerd → valt af op saldo
      rek({ id: "gb-c", nummer: 4700, omschrijving: "Advies", statement_type: null, report_group: null }),
    ];
    state.postings = boeking("gb-a", "gb-b", "100.00");
    renderPagina();

    fireEvent.click(screen.getByRole("button", { name: /^niet geclassificeerd$/i }));
    expect(rijNummers().sort()).toEqual(["4602", "4700"]);

    fireEvent.click(saldoChip());
    expect(rijNummers()).toEqual(["4602"]);
  });

  it("5. zonder Met saldo blijft het classificatiefilter zich precies zo gedragen", () => {
    state.rekeningen = [
      rek({ id: "gb-a", nummer: 4400 }),
      rek({ id: "gb-b", nummer: 4602, statement_type: null, report_group: null }),
      rek({ id: "gb-c", nummer: 4700, statement_type: null, report_group: null }),
    ];
    // Er ís activiteit, maar het saldofilter staat uit: die mag niets wegnemen.
    state.postings = boeking("gb-a", "gb-b", "100.00");
    renderPagina();

    fireEvent.click(screen.getByRole("button", { name: /^niet geclassificeerd$/i }));
    expect(rijNummers().sort()).toEqual(["4602", "4700"]);

    fireEvent.click(screen.getByRole("button", { name: /^geclassificeerd$/i }));
    expect(rijNummers()).toEqual(["4400"]);
  });

  it("6. administratiescheiding: mutaties van een andere administratie tellen niet", () => {
    state.rekeningen = [rek({ id: "gb-eigen", nummer: 4400 }), rek({ id: "gb-vreemd", nummer: 4500 })];
    // De activiteit op gb-vreemd hoort bij een ándere administratie.
    state.postings = [
      ...boeking("gb-eigen", "gb-tegen", "100.00", CLIENT),
      ...boeking("gb-vreemd", "gb-tegen", "100.00", ANDER),
    ];
    renderPagina();

    fireEvent.click(saldoChip());
    expect(rijNummers()).toEqual(["4400"]);
  });

  it("7. zonder gekozen administratie wordt er niets beloofd", () => {
    state.clientId = "all";
    state.rekeningen = [rek({ id: "gb-1", nummer: 4400 })];
    renderPagina();

    expect(screen.queryByRole("button", { name: /met saldo/i })).toBeNull();
    expect(screen.getByTestId("saldo-geen-administratie")).toHaveTextContent(
      "Kies een administratie om op saldo te filteren.",
    );
  });

  it("8. het filter is uitschakelbaar en herstelt de volledige lijst", () => {
    state.rekeningen = [rek({ id: "gb-actief", nummer: 4400 }), rek({ id: "gb-stil", nummer: 4500 })];
    state.postings = boeking("gb-actief", "gb-tegen", "100.00");
    renderPagina();

    fireEvent.click(saldoChip());
    expect(rijNummers()).toEqual(["4400"]);
    fireEvent.click(saldoChip());
    expect(rijNummers()).toEqual(["4400", "4500"]);
  });

  it("9. laden en fouten worden benoemd, en er wordt dan niet stilletjes gefilterd", () => {
    state.rekeningen = [rek({ id: "gb-actief", nummer: 4400 }), rek({ id: "gb-stil", nummer: 4500 })];
    state.postings = [];
    state.postingsError = true;
    renderPagina();

    fireEvent.click(saldoChip());
    expect(screen.getByTestId("saldo-fout")).toBeInTheDocument();
    // Geen betrouwbare bron → geen filtering, in plaats van een lege lijst.
    expect(rijNummers()).toEqual(["4400", "4500"]);
  });
});
