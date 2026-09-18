import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

/**
 * Fase 6C-b8 (PR 2) — de beginbalanspagina (/grootboek/beginbalans).
 *
 * De hooks zijn gemockt: hier gaat het om de samenwerking van de pagina —
 * de vier toestanden, concept opslaan via precies één save-RPC, boeken via
 * precies één post-RPC met bevestiging uit de claimtabel, de nihil-verklaring,
 * de meerdere-conceptenregel en de foutafhandeling. Nummering volgt de
 * testmatrix van de opdracht.
 */

type Row = Record<string, unknown>;

const state = {
  selectedClientId: "c-1",
  headers: [] as Row[],
  clientMarker: null as Row | null,
  header: null as Row | null,
  lines: [] as Row[],
  marker: null as Row | null,
  canAssert: true as boolean | undefined,
  overviewError: false,
  /** Eerdere data aanwezig, laatste verversing mislukt. */
  overviewRefreshError: false,
};

const {
  createSpy, updateSpy, saveLinesSpy, deleteSpy, postSpy, nilSpy, toastSpy, overviewRefetchSpy, comboboxProps, store,
} = vi.hoisted(() => {
  // De gemockte hooks lezen `state` bij het renderen. Een refetch in de echte
  // app zou een nieuwe render uitlokken; hier doet `store.bump()` dat, zodat
  // "opnieuw ophalen" ook in de test zichtbaar gedrag is.
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    createSpy: vi.fn(),
    updateSpy: vi.fn(),
    saveLinesSpy: vi.fn(),
    deleteSpy: vi.fn(),
    postSpy: vi.fn(),
    nilSpy: vi.fn(),
    toastSpy: vi.fn(),
    overviewRefetchSpy: vi.fn(),
    comboboxProps: [] as Array<Record<string, unknown>>,
    store: {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getVersion: () => version,
      bump: () => {
        version += 1;
        listeners.forEach((l) => l());
      },
    },
  };
});

const MOCK_ACCOUNTS = [
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true, client_id: null },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true, client_id: null },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog", categorie: "omzet", actief: true, client_id: null },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true, client_id: null },
  { id: "gb-651", nummer: 651, omschrijving: "Privé-stortingen", categorie: "privé", actief: true, client_id: null },
  { id: "gb-oud", nummer: 1999, omschrijving: "Oude rekening", categorie: "activa", actief: false, client_id: null },
];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant Een", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: MOCK_ACCOUNTS }),
  useActiveGrootboekrekeningen: () => ({ data: MOCK_ACCOUNTS.filter((a) => a.actief) }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: (props: {
    value: string;
    clientId?: string;
    onValueChange: (v: string) => void;
    onIdChange?: (id: string) => void;
  }) => {
    comboboxProps.push(props);
    return (
      <div>
        <button type="button" role="combobox">{props.value || "Selecteer rekening..."}</button>
        {MOCK_ACCOUNTS.filter((a) => a.actief).map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              props.onValueChange(`${a.nummer} - ${a.omschrijving}`);
              props.onIdChange?.(a.id);
            }}
          >
            kies {a.nummer}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("@/hooks/useOpeningBalances", async () => {
  const { useSyncExternalStore } = await import("react");
  const useVersion = () => useSyncExternalStore(store.subscribe, store.getVersion);
  const headerFor = (id?: string) => (state.header && state.header.id === id ? state.header : null);
  return {
    useOpeningBalanceOverview: () => {
      useVersion();
      return {
        data: state.overviewError ? undefined : { headers: state.headers, marker: state.clientMarker },
        isPending: false,
        isError: state.overviewError || state.overviewRefreshError,
        isFetching: false,
        error: state.overviewError || state.overviewRefreshError ? { code: "PGRST205", message: "schema cache" } : null,
        refetch: async () => {
          overviewRefetchSpy();
          store.bump();
          return { data: { headers: state.headers, marker: state.clientMarker } };
        },
      };
    },
    useOpeningBalance: (id?: string) => {
      useVersion();
      return {
        data: id ? headerFor(id) : undefined,
        isPending: false,
        refetch: async () => {
          store.bump();
          return { data: headerFor(id) };
        },
      };
    },
    useOpeningBalanceLines: (id?: string) => {
      useVersion();
      return {
        data: id ? state.lines.filter((l) => l.opening_balance_id === id) : undefined,
        isPending: false,
        refetch: async () => {
          store.bump();
          return { data: state.lines };
        },
      };
    },
    useCreateOpeningBalance: () => ({ mutateAsync: createSpy, isPending: false }),
    useUpdateOpeningBalance: () => ({ mutateAsync: updateSpy, isPending: false }),
    useSaveOpeningBalanceLines: () => ({ mutateAsync: saveLinesSpy, isPending: false }),
    useDeleteOpeningBalance: () => ({ mutateAsync: deleteSpy, isPending: false }),
  };
});

vi.mock("@/hooks/useOpeningBalancePosting", async () => {
  const { useSyncExternalStore } = await import("react");
  const useVersion = () => useSyncExternalStore(store.subscribe, store.getVersion);
  const markerFor = (id?: string) =>
    id && state.marker && state.marker.opening_balance_id === id ? state.marker : null;
  return {
    useOpeningBalanceMarker: (id?: string) => {
      useVersion();
      return {
        data: markerFor(id),
        isPending: false,
        isError: false,
        refetch: async () => {
          store.bump();
          return { data: markerFor(id) };
        },
      };
    },
    useCanAssertOpeningBalance: () => ({ data: state.canAssert }),
    usePostOpeningBalance: () => ({ mutateAsync: postSpy, isPending: false }),
    useDeclareOpeningBalanceNil: () => ({ mutateAsync: nilSpy, isPending: false }),
  };
});

import Beginbalans from "@/pages/Beginbalans";

const YEAR = new Date().getFullYear();

const headerRow = (over: Row = {}): Row => ({
  id: "ob-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: YEAR,
  opening_date: `${YEAR}-01-01`,
  description: `Beginbalans ${YEAR}`,
  reference: "OPEN-1",
  nil_declaration: false,
  nil_declared_at: null,
  nil_declared_by: null,
  created_at: "2027-01-01T00:00:00Z",
  updated_at: "2027-01-01T00:00:00Z",
  ...over,
});

const lineRow = (over: Row = {}): Row => ({
  id: "l-1",
  opening_balance_id: "ob-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  sort_order: 0,
  grootboekrekening_id: "gb-1300",
  description: "Debiteuren",
  debit_amount: 1000,
  credit_amount: 0,
  created_at: "2027-01-01T00:00:00Z",
  updated_at: "2027-01-01T00:00:00Z",
  ...over,
});

const markerRow = (over: Row = {}): Row => ({
  opening_balance_id: "ob-1",
  posting_group_id: "g-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: YEAR,
  opening_date: `${YEAR}-01-01`,
  line_count: 2,
  total_amount: 1000,
  created_at: "2027-01-02T09:30:00Z",
  ...over,
});

const nilRow = (over: Row = {}): Row =>
  headerRow({ nil_declaration: true, nil_declared_at: "2027-01-05T10:00:00Z", nil_declared_by: "u-9", ...over });

/**
 * Simuleert wat de echte hook doet: de RPC slaat op, daarna wordt de cache
 * opnieuw opgehaald (hier: `state.lines` bijgewerkt + re-render) en pas dan
 * lost de belofte op.
 */
const persistLines = async ({ openingBalanceId, lines }: { openingBalanceId: string; lines: Array<Record<string, unknown>> }) => {
  state.lines = lines.map((l, i) =>
    lineRow({
      id: `l-saved-${i}`,
      opening_balance_id: openingBalanceId,
      sort_order: l.sort_order,
      grootboekrekening_id: l.grootboekrekening_id,
      description: l.description,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
    }),
  );
  store.bump();
  return { openingBalanceId, refreshed: true };
};

/** Een opgeslagen, sluitend concept: Debiteuren 1000 / Crediteuren 1000. */
function loadBalancedDraft() {
  state.headers = [headerRow()];
  state.header = headerRow();
  state.lines = [
    lineRow(),
    lineRow({ id: "l-2", sort_order: 1, grootboekrekening_id: "gb-1600", description: "Crediteuren", debit_amount: 0, credit_amount: 1000 }),
  ];
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Beginbalans />
    </MemoryRouter>,
  );
}

const debit = (n: number) => screen.getByLabelText(new RegExp(`^Debet regel ${n}`)) as HTMLInputElement;
const credit = (n: number) => screen.getByLabelText(new RegExp(`^Credit regel ${n}`)) as HTMLInputElement;
const rows = () => screen.getAllByTestId("beginbalans-line-row");
const saveButton = () => screen.getByTestId("beginbalans-save") as HTMLButtonElement;
const postButton = () => screen.queryByTestId("beginbalans-posting-button") as HTMLButtonElement | null;
const postHint = () => screen.getByTestId("beginbalans-posting-hint");
const nilButton = () => screen.queryByTestId("beginbalans-nil-button") as HTMLButtonElement | null;
const pickAccount = (rowIndex: number, nummer: number) =>
  fireEvent.click(screen.getAllByRole("button", { name: `kies ${nummer}` })[rowIndex]);

beforeEach(() => {
  createSpy.mockReset().mockResolvedValue({ id: "ob-new" });
  updateSpy.mockReset().mockResolvedValue({ id: "ob-1" });
  saveLinesSpy.mockReset().mockResolvedValue({ openingBalanceId: "ob-1", refreshed: true });
  deleteSpy.mockReset().mockResolvedValue("ob-1");
  postSpy.mockReset().mockResolvedValue("g-1");
  nilSpy.mockReset().mockResolvedValue("ob-1");
  toastSpy.mockClear();
  overviewRefetchSpy.mockClear();
  comboboxProps.length = 0;
  state.selectedClientId = "c-1";
  state.headers = [];
  state.clientMarker = null;
  state.header = null;
  state.lines = [];
  state.marker = null;
  state.canAssert = true;
  state.overviewError = false;
  state.overviewRefreshError = false;
});

describe("Beginbalans — toestanden", () => {
  it("1. zonder specifieke administratie: NoClientBanner en geen formulier", () => {
    state.selectedClientId = "all";
    renderPage();
    expect(screen.getByText("Kies eerst een specifieke administratie om de beginbalans te bekijken.")).toBeInTheDocument();
    expect(screen.queryByTestId("beginbalans-header-card")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("2. nieuwe administratie: geen-kop-toestand met leeg formulier, niets is geboekt of nihil", () => {
    renderPage();
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Nog geen beginbalans");
    expect(screen.queryByTestId("beginbalans-posted-notice")).toBeNull();
    expect(screen.queryByTestId("beginbalans-nil-notice")).toBeNull();
    expect(postHint()).toHaveTextContent("Sla de beginbalans eerst op.");
    expect(screen.getByTestId("beginbalans-nil-hint")).toHaveTextContent("Sla de beginbalans eerst op (zonder regels).");
  });

  it("4. standaard: boekjaar = huidig jaar, openingsdatum 1 januari, omschrijving 'Beginbalans <jaar>'", () => {
    renderPage();
    expect((screen.getByLabelText("Boekjaar") as HTMLInputElement).value).toBe(String(YEAR));
    expect((screen.getByLabelText("Openingsdatum") as HTMLInputElement).value).toBe(`${YEAR}-01-01`);
    expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).value).toBe(`Beginbalans ${YEAR}`);
    expect((screen.getByLabelText("Administratie") as HTMLInputElement).value).toBe("Klant Een");
  });

  it("6. een nieuw concept begint met twee lege regels", () => {
    renderPage();
    expect(rows()).toHaveLength(2);
    expect(debit(1).value).toBe("");
    expect(credit(2).value).toBe("");
  });

  it("49. de dubbeltellingswaarschuwing staat op het concept", () => {
    renderPage();
    expect(screen.getByTestId("beginbalans-double-count-warning")).toHaveTextContent(
      "Let op: neem openstaande debiteuren en crediteuren niet dubbel op wanneer de bijbehorende facturen ook in BoekAssist worden geboekt.",
    );
  });

  it("44. meerdere concepten voor het jaar: fail closed met lijst, geen formulier; openen is een expliciete keuze", async () => {
    state.headers = [headerRow(), headerRow({ id: "ob-2", opening_date: `${YEAR}-01-02`, description: "Tweede" })];
    state.header = headerRow({ id: "ob-2", opening_date: `${YEAR}-01-02`, description: "Tweede" });
    renderPage();
    const alert = screen.getByTestId("beginbalans-multiple-drafts");
    expect(alert).toHaveTextContent(`Meerdere concepten voor boekjaar ${YEAR}`);
    expect(within(alert).getAllByTestId("beginbalans-draft-option")).toHaveLength(2);
    expect(alert).toHaveTextContent("ob-2");
    expect(screen.queryByTestId("beginbalans-header-card")).toBeNull();
    expect(saveLinesSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: `Open concept van 02-01-${YEAR}` }));
    await waitFor(() => expect(screen.getByTestId("beginbalans-header-card")).toBeInTheDocument());
    await waitFor(() => expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).value).toBe("Tweede"));
  });

  it("43. geboekt én nihil tegelijk → conflict, alleen-lezen, geen formulier", () => {
    state.headers = [nilRow()];
    state.clientMarker = markerRow({ opening_balance_id: "ob-9" });
    renderPage();
    expect(screen.getByTestId("beginbalans-conflict")).toHaveTextContent("zowel een geboekte beginbalans als een nihil-verklaring");
    expect(screen.queryByTestId("beginbalans-save")).toBeNull();
    expect(postButton()).toBeNull();
    expect(nilButton()).toBeNull();
  });

  it("het overzicht kan niet geladen worden → fail closed, geen formulier", () => {
    state.overviewError = true;
    renderPage();
    expect(screen.getByTestId("beginbalans-load-error")).toBeInTheDocument();
    expect(screen.queryByTestId("beginbalans-header-card")).toBeNull();
  });
});

describe("Beginbalans — concept", () => {
  it("3/25. concept opslaan: eerst de kop, dan precies één save_opening_balance_lines-aanroep", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Omschrijving regel 1"), { target: { value: "Debiteuren" } });
    pickAccount(0, 1300);
    fireEvent.change(debit(1), { target: { value: "1000,00" } });
    pickAccount(1, 1600);
    fireEvent.change(credit(2), { target: { value: "1000,00" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(1));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toEqual({
      form: { boekjaar: String(YEAR), opening_date: `${YEAR}-01-01`, description: `Beginbalans ${YEAR}`, reference: "" },
      clientId: "c-1",
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(saveLinesSpy.mock.calls[0][0]).toEqual({
      openingBalanceId: "ob-new",
      lines: [
        { sort_order: 0, grootboekrekening_id: "gb-1300", description: "Debiteuren", debit_amount: 1000, credit_amount: 0 },
        { sort_order: 1, grootboekrekening_id: "gb-1600", description: null, debit_amount: 0, credit_amount: 1000 },
      ],
    });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans opgeslagen" }));
  });

  it("5. boekjaar en openingsdatum die niet bij elkaar horen: fout zichtbaar, opslaan geblokkeerd", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Openingsdatum"), { target: { value: `${YEAR - 1}-12-31` } });
    expect(screen.getByTestId("beginbalans-header-issues")).toHaveTextContent(`valt niet in boekjaar ${YEAR}`);
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Opslaan niet mogelijk" })));
    expect(createSpy).not.toHaveBeenCalled();
    // Boekjaar wijzigen zet de datum weer op 1 januari van dat jaar.
    fireEvent.change(screen.getByLabelText("Boekjaar"), { target: { value: String(YEAR - 1) } });
    expect((screen.getByLabelText("Openingsdatum") as HTMLInputElement).value).toBe(`${YEAR - 1}-01-01`);
    expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).value).toBe(`Beginbalans ${YEAR - 1}`);
    expect(screen.queryByTestId("beginbalans-header-issues")).toBeNull();
  });

  it("7/8. regel toevoegen en verwijderen", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    expect(rows()).toHaveLength(3);
    fireEvent.change(debit(1), { target: { value: "10,00" } });
    fireEvent.change(debit(2), { target: { value: "20,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Regel 1 verwijderen" }));
    expect(rows()).toHaveLength(2);
    expect(debit(1).value).toBe("20,00");
  });

  it("9/10. de rekeningkeuze is de bestaande GrootboekCombobox, beperkt tot deze administratie", () => {
    renderPage();
    pickAccount(0, 1300);
    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("1300 - Debiteuren");
    expect(comboboxProps.every((p) => p.clientId === "c-1")).toBe(true);
    // Debet/credit kennen hun regelcontext.
    expect(screen.getByLabelText("Debet regel 1 (1300 - Debiteuren)")).toBeInTheDocument();
  });

  it("11/12/16/17. exacte centen: 0,29 + 0,01 tegen 0,30 is in balans met verschil 0", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    fireEvent.change(debit(1), { target: { value: "0,29" } });
    fireEvent.change(debit(2), { target: { value: "0,01" } });
    fireEvent.change(credit(3), { target: { value: "0,30" } });
    expect(screen.getByTestId("beginbalans-total-debit")).toHaveTextContent("0,30");
    expect(screen.getByTestId("beginbalans-total-credit")).toHaveTextContent("0,30");
    expect(screen.getByTestId("beginbalans-difference")).toHaveTextContent("0,00");
    expect(screen.getByTestId("beginbalans-balanced")).toHaveTextContent("In balans");
  });

  it("13. debet én credit op één regel → fout bij de regel", () => {
    renderPage();
    fireEvent.change(debit(1), { target: { value: "10" } });
    fireEvent.change(credit(1), { target: { value: "5" } });
    // Niets wordt stilletjes leeggemaakt of ingevuld.
    expect(debit(1).value).toBe("10");
    expect(credit(1).value).toBe("5");
    expect(screen.getByTestId("beginbalans-line-issue-both-sides")).toHaveTextContent("Regel 1: Een regel kan niet tegelijk debet en credit zijn.");
    expect(screen.getByTestId("beginbalans-line-issue-both-sides").closest("[role=alert]")).not.toBeNull();
  });

  it("14. negatief bedrag → fout bij de regel", () => {
    renderPage();
    fireEvent.change(debit(1), { target: { value: "-5" } });
    expect(screen.getByTestId("beginbalans-line-issue-negative")).toHaveTextContent("Negatieve bedragen worden niet ondersteund");
  });

  it("15. drie decimalen worden niet afgerond: blur laat 0,005 staan en de RPC krijgt 0.005", async () => {
    renderPage();
    fireEvent.change(debit(1), { target: { value: "0,005" } });
    fireEvent.blur(debit(1));
    expect(debit(1).value).toBe("0,005");
    expect(screen.getByTestId("beginbalans-line-issue-decimals")).toHaveTextContent("Maximaal twee decimalen");
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(1));
    expect(saveLinesSpy.mock.calls[0][0].lines[0].debit_amount).toBe(0.005);
  });

  it("blur lijnt een geldig bedrag nl-NL uit", () => {
    renderPage();
    fireEvent.change(debit(1), { target: { value: "1234.5" } });
    fireEvent.blur(debit(1));
    expect(debit(1).value).toBe("1234,50");
  });

  it("18. niet in balans: verschil getekend, boeken uit", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    fireEvent.change(credit(2), { target: { value: "1021,00" } });
    expect(screen.getByTestId("beginbalans-difference")).toHaveTextContent("-21,00");
    expect(screen.getByTestId("beginbalans-difference")).toHaveTextContent("credit is hoger");
    expect(postButton()!.disabled).toBe(true);
    // Geen sluitregel: er staan nog steeds precies twee regels en nergens 9998 of 2010.
    expect(rows()).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/9998|2010 Tussenrekening|Resultaat/);
  });

  it("21. een assistent kan opslaan zonder boekrecht", async () => {
    state.canAssert = false;
    renderPage();
    fireEvent.change(debit(1), { target: { value: "10,00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(1));
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("26. een mislukte regelopslag maakt bij een nieuwe poging geen tweede kop aan en bewaart de regels", async () => {
    saveLinesSpy
      .mockRejectedValueOnce({ code: "22023", message: "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde" })
      .mockImplementation(persistLines);
    // Na het aanmaken bestaat de kop in de database (zonder regels) en vindt
    // het overzicht hem meteen — precies het moment waarop de getypte regels
    // vroeger door lege databaserijen konden worden overschreven.
    createSpy.mockImplementation(async () => {
      state.header = headerRow({ id: "ob-new", reference: null });
      state.headers = [headerRow({ id: "ob-new", reference: null })];
      store.bump();
      return { id: "ob-new" };
    });
    renderPage();
    fireEvent.change(debit(1), { target: { value: "-5" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Opslaan niet gelukt",
        description: "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde",
        variant: "destructive",
      }),
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    // De getypte regel is niet overschreven door de (lege) databaserijen.
    expect(debit(1).value).toBe("-5");
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Concept");

    fireEvent.change(debit(1), { target: { value: "5,00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(2));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(saveLinesSpy.mock.calls[1][0].openingBalanceId).toBe("ob-new");
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans opgeslagen" }));
    // Na de geslaagde opslag toont het formulier de opgeslagen (verse) rijen.
    await waitFor(() => expect(debit(1).value).toBe("5,00"));
    expect(rows()).toHaveLength(2);
  });

  it("26b. opslaan van een bestaand concept toont daarna de verse rijen, nooit de oude cache", async () => {
    loadBalancedDraft();
    // De kop krijgt bij het bijwerken een nieuwe updated_at, zoals de trigger doet.
    updateSpy.mockImplementation(async ({ id }: { id: string }) => {
      state.header = headerRow({ id, updated_at: "2027-04-02T00:00:00Z" });
      store.bump();
      return { id };
    });
    saveLinesSpy.mockImplementation(persistLines);
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    fireEvent.change(debit(1), { target: { value: "1500,00" } });
    fireEvent.change(credit(2), { target: { value: "1500,00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans opgeslagen" }));
    await waitFor(() => expect(debit(1).value).toBe("1500,00"));
    expect(credit(2).value).toBe("1500,00");
    // En het formulier is niet meer "gewijzigd": boeken is weer mogelijk.
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
  });

  it("26c. opgeslagen maar herladen mislukt: het formulier houdt de opgeslagen invoer vast tot de verse rijen er zijn", async () => {
    loadBalancedDraft();
    updateSpy.mockImplementation(async ({ id }: { id: string }) => {
      state.header = headerRow({ id, updated_at: "2027-04-02T00:00:00Z" });
      store.bump();
      return { id };
    });
    // De RPC slaagde, maar het opnieuw laden niet: de cache houdt de oude rijen.
    saveLinesSpy.mockImplementation(async ({ openingBalanceId }: { openingBalanceId: string }) => ({ openingBalanceId, refreshed: false }));
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    fireEvent.change(debit(1), { target: { value: "1500,00" } });
    fireEvent.change(credit(2), { target: { value: "1500,00" } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Beginbalans opgeslagen", description: expect.stringMatching(/opnieuw laden is mislukt/) })),
    );
    // Niet teruggevallen op de oude cache (1000,00).
    expect(debit(1).value).toBe("1500,00");
    // Zodra de database de opgeslagen rijen wél teruggeeft, volgt het formulier ze.
    state.lines = [
      lineRow({ id: "l-a", debit_amount: 1500 }),
      lineRow({ id: "l-b", sort_order: 1, grootboekrekening_id: "gb-1600", description: "Crediteuren", debit_amount: 0, credit_amount: 1500 }),
    ];
    store.bump();
    await waitFor(() => expect(debit(1).value).toBe("1500,00"));
    expect(credit(2).value).toBe("1500,00");
  });

  it("boekjaar wijzigen op een nieuw formulier met inhoud vervangt de invoer niet; het bestaande concept wordt gemeld", async () => {
    state.headers = [headerRow({ id: "ob-prev", boekjaar: YEAR - 1, opening_date: `${YEAR - 1}-01-01`, description: "Vorig jaar" })];
    state.header = headerRow({ id: "ob-prev", boekjaar: YEAR - 1, opening_date: `${YEAR - 1}-01-01`, description: "Vorig jaar" });
    renderPage();
    fireEvent.change(debit(1), { target: { value: "250,00" } });
    fireEvent.change(screen.getByLabelText("Boekjaar"), { target: { value: String(YEAR - 1) } });
    // De regel staat er nog, het concept van dat jaar is niet stilzwijgend geopend.
    expect(debit(1).value).toBe("250,00");
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Nog geen beginbalans");
    const note = screen.getByTestId("beginbalans-typed-year-drafts");
    expect(note).toHaveTextContent(`Er bestaat al een concept voor boekjaar ${YEAR - 1}`);
    // Openen is een expliciete keuze en vraagt eerst om bevestiging.
    fireEvent.click(within(note).getByRole("button", { name: /Open concept/ }));
    expect(await screen.findByText("Niet-opgeslagen wijzigingen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /wijzigingen weggooien/i }));
    await waitFor(() => expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).value).toBe("Vorig jaar"));
  });

  it("boekjaar wijzigen op een leeg nieuw formulier opent het concept van dat jaar", async () => {
    state.headers = [headerRow({ id: "ob-prev", boekjaar: YEAR - 1, opening_date: `${YEAR - 1}-01-01`, description: "Vorig jaar" })];
    state.header = headerRow({ id: "ob-prev", boekjaar: YEAR - 1, opening_date: `${YEAR - 1}-01-01`, description: "Vorig jaar" });
    renderPage();
    fireEvent.change(screen.getByLabelText("Boekjaar"), { target: { value: String(YEAR - 1) } });
    await waitFor(() => expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).value).toBe("Vorig jaar"));
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Concept");
  });

  it("boekjaar van een bestaand concept wijzigen en opslaan houdt het concept in beeld", async () => {
    loadBalancedDraft();
    updateSpy.mockImplementation(async ({ id, form }: { id: string; form: { boekjaar: string; opening_date: string } }) => {
      const updated = headerRow({ id, boekjaar: Number(form.boekjaar), opening_date: form.opening_date, updated_at: "2027-04-02T00:00:00Z" });
      state.header = updated;
      state.headers = [updated];
      store.bump();
      return { id };
    });
    saveLinesSpy.mockImplementation(persistLines);
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    fireEvent.change(screen.getByLabelText("Boekjaar"), { target: { value: String(YEAR - 1) } });
    expect((screen.getByLabelText("Openingsdatum") as HTMLInputElement).value).toBe(`${YEAR - 1}-01-01`);
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans opgeslagen" }));
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Concept");
    expect((screen.getByLabelText("Boekjaar") as HTMLInputElement).value).toBe(String(YEAR - 1));
    expect(debit(1).value).toBe("1000,00");
  });

  it("een mislukte verversing mét eerdere data laat het formulier staan en meldt het", async () => {
    loadBalancedDraft();
    state.overviewRefreshError = true;
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    expect(screen.getByTestId("beginbalans-refresh-error")).toHaveTextContent("kan verouderd zijn");
    expect(screen.queryByTestId("beginbalans-load-error")).toBeNull();
    expect(screen.getByTestId("beginbalans-header-card")).toBeInTheDocument();
  });

  it("een onleesbaar bedrag blokkeert opslaan (null zou server-side 0 worden)", async () => {
    renderPage();
    fireEvent.change(debit(1), { target: { value: "abc" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Opslaan niet mogelijk" })));
    expect(createSpy).not.toHaveBeenCalled();
    expect(saveLinesSpy).not.toHaveBeenCalled();
  });

  it("33/34/35. omzet, kosten en privé zijn toegestaan met een niet-blokkerende opmerking", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    pickAccount(0, 8000);
    expect(screen.getByTestId("beginbalans-category-note")).toHaveTextContent("Omzetrekening in een beginbalans: toegestaan");
    pickAccount(0, 4000);
    expect(screen.getByTestId("beginbalans-category-note")).toHaveTextContent("Kostenrekening");
    pickAccount(0, 651);
    expect(screen.getByTestId("beginbalans-category-note")).toHaveTextContent("Privérekening");
    expect(screen.queryByTestId("beginbalans-line-notes")?.querySelector("[role=alert]")).toBeNull();
  });

  it("de pagina boekt of verklaart nooit uit zichzelf", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    expect(postSpy).not.toHaveBeenCalled();
    expect(nilSpy).not.toHaveBeenCalled();
    expect(saveLinesSpy).not.toHaveBeenCalled();
  });
});

describe("Beginbalans — boeken", () => {
  it("19/20. nul totaal of ontbrekende rekening houdt boeken uit", async () => {
    state.headers = [headerRow()];
    state.header = headerRow();
    state.lines = [lineRow({ debit_amount: 0 }), lineRow({ id: "l-2", sort_order: 1, grootboekrekening_id: null, credit_amount: 0 })];
    renderPage();
    await waitFor(() => expect(postButton()).not.toBeNull());
    expect(postButton()!.disabled).toBe(true);
    expect(postHint()).toHaveTextContent("Elke regel heeft een grootboekrekening nodig.");
    pickAccount(1, 1600);
    await waitFor(() => expect(postHint()).toHaveTextContent("Er zijn niet-opgeslagen wijzigingen. Sla eerst op."));
  });

  it("22. een assistent krijgt de boekactie niet aangeboden", async () => {
    state.canAssert = false;
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    expect(postButton()).toBeNull();
    expect(postHint()).toHaveTextContent("Alleen een accountant kan een beginbalans boeken.");
    expect(nilButton()).toBeNull();
  });

  it("24. een onbekende rol krijgt de boekactie niet aangeboden", async () => {
    state.canAssert = undefined;
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    expect(postButton()).toBeNull();
    expect(postHint()).toHaveTextContent("Rechten worden gecontroleerd…");
  });

  it("23/27/28. accountant: bevestiging, precies één post_opening_balance, succes pas na de claimrij", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Beginbalans boeken in het grootboek?");
    const points = within(dialog).getByTestId("beginbalans-post-confirm-points");
    expect(points).toHaveTextContent("beginpositie van deze administratie vast in het grootboek");
    expect(points).toHaveTextContent("onveranderbaar");
    expect(points).toHaveTextContent("geen functie om een geboekte beginbalans terug te draaien");
    expect(points).toHaveTextContent("compenserende boeking");
    expect(postSpy).not.toHaveBeenCalled();

    postSpy.mockImplementation(async () => {
      state.marker = markerRow();
      state.clientMarker = markerRow();
      return "g-1";
    });
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans geboekt" }));
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith("ob-1");
    expect(overviewRefetchSpy).toHaveBeenCalled();
  });

  it("28. geen succes zolang de claimrij het niet bevestigt", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Boeking niet bevestigd", variant: "destructive" })),
    );
    expect(toastSpy).not.toHaveBeenCalledWith({ title: "Beginbalans geboekt" });
  });

  it("29/30/50/51. geboekt: alleen-lezen, status Geboekt, geen opslaan/verwijderen/toevoegen, met rapportlinks", async () => {
    loadBalancedDraft();
    state.clientMarker = markerRow();
    state.marker = markerRow();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Geboekt"));
    expect(screen.getByTestId("beginbalans-posted-notice")).toHaveTextContent("definitief zolang er geen tegenboekingsfunctie bestaat");
    expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Openingsdatum") as HTMLInputElement).disabled).toBe(true);
    expect(debit(1).disabled).toBe(true);
    expect(screen.queryByTestId("beginbalans-save")).toBeNull();
    expect(postButton()).toBeNull();
    expect(nilButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /regel toevoegen/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /verwijderen/i })).toBeNull();
    const details = screen.getByTestId("beginbalans-posted-details");
    expect(details).toHaveTextContent("1.000,00");
    expect(details).toHaveTextContent("g-1");
    expect(details).toHaveTextContent(String(YEAR));
    const links = screen.getByTestId("beginbalans-report-links");
    expect(within(links).getByRole("link", { name: /Proef- en saldibalans/ })).toHaveAttribute("href", "/overzichten/proef-saldibalans");
    expect(within(links).getByRole("link", { name: /Grootboeksaldi/ })).toHaveAttribute("href", "/grootboek/saldi");
  });

  it("achtergebleven concepten naast een geboekte beginbalans blijven zichtbaar en zijn alleen te verwijderen", async () => {
    loadBalancedDraft();
    state.headers = [headerRow(), headerRow({ id: "ob-rest", opening_date: `${YEAR}-01-02`, description: "Restant" })];
    state.clientMarker = markerRow();
    state.marker = markerRow();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Geboekt"));
    const leftover = screen.getByTestId("beginbalans-leftover-drafts");
    expect(within(leftover).getAllByTestId("beginbalans-leftover-draft")).toHaveLength(1);
    expect(leftover).toHaveTextContent("Restant");
    expect(within(leftover).queryByRole("button", { name: /Open concept/ })).toBeNull();
    fireEvent.click(within(leftover).getByRole("button", { name: `Verwijder concept van 02-01-${YEAR}` }));
    expect(await screen.findByText("Concept verwijderen?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("ob-rest"));
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("31/47. 23505 (al geboekt) → claimrij opnieuw ophalen, geboekte weergave, geen foutmelding", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    postSpy.mockImplementation(async () => {
      state.marker = markerRow();
      state.clientMarker = markerRow();
      throw Object.assign(new Error("Deze beginbalans is al geboekt"), { kind: "duplicate", code: "23505" });
    });
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Deze beginbalans is al geboekt." }));
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
    expect(overviewRefetchSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Geboekt"));
    expect(screen.queryByTestId("beginbalans-save")).toBeNull();
  });

  it("47. 23505 voor een andere beginbalans van deze administratie → servermelding en de waarheid opnieuw laden", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    postSpy.mockRejectedValueOnce(Object.assign(new Error("Deze administratie heeft al een geboekte beginbalans"), { kind: "duplicate", code: "23505" }));
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Boeken niet gelukt", description: "Deze administratie heeft al een geboekte beginbalans", variant: "destructive" }),
    );
    expect(overviewRefetchSpy).toHaveBeenCalled();
  });

  it("45. 40001 → opnieuw ophalen en een veilige melding, geen tweede poging", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    postSpy.mockRejectedValueOnce(Object.assign(new Error("De beginbalans is tussentijds gewijzigd. De actuele toestand is opnieuw geladen; controleer en probeer opnieuw."), { kind: "stale", code: "40001" }));
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Boeken niet gelukt", description: expect.stringMatching(/tussentijds gewijzigd/) })),
    );
    expect(overviewRefetchSpy).toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("46. 40P01 → herhaalbare melding, geen automatische tweede poging", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    postSpy.mockRejectedValueOnce(Object.assign(new Error("Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw."), { kind: "deadlock", code: "40P01" }));
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw.",
        variant: "destructive",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Concept");
  });

  it("48. weigering wegens eerdere grootboekfeiten wordt letterlijk getoond", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(postButton()!.disabled).toBe(false));
    fireEvent.click(postButton()!);
    const dialog = await screen.findByRole("alertdialog");
    const message = `Er staan al boekingen vóór ${YEAR}-01-01 in het grootboek van deze administratie (laatste: ${YEAR - 1}-11-30); een beginbalans moet het eerste feit zijn`;
    postSpy.mockRejectedValueOnce(Object.assign(new Error(message), { kind: "validation", code: "22023" }));
    fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Boeken niet gelukt", description: message, variant: "destructive" }));
    expect((screen.getByLabelText("Openingsdatum") as HTMLInputElement).value).toBe(`${YEAR}-01-01`);
  });

  it("opslaan na een boeking elders: servermelding en het formulier onderwerpt zich aan de waarheid", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    fireEvent.change(debit(1), { target: { value: "1500,00" } });
    updateSpy.mockImplementation(async () => {
      state.marker = markerRow();
      state.clientMarker = markerRow();
      throw { code: "42501", message: "Deze beginbalans is vastgelegd (geboekt of op nihil verklaard); boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking." };
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Opslaan niet gelukt" })));
    expect(saveLinesSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Geboekt"));
    // Geen bewerkbaar formulier meer over een geboekte rij: de databasewaarde wint.
    await waitFor(() => expect(debit(1).value).toBe("1000,00"));
    expect(debit(1).disabled).toBe(true);
    expect(screen.queryByTestId("beginbalans-save")).toBeNull();
  });
});

describe("Beginbalans — nihil-verklaring", () => {
  function loadLinelessDraft() {
    state.headers = [headerRow()];
    state.header = headerRow();
    state.lines = [];
  }

  it("36. alleen een accountant ziet de actie", async () => {
    state.canAssert = false;
    loadLinelessDraft();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Concept"));
    expect(nilButton()).toBeNull();
  });

  it("37. opgeslagen regels blokkeren de nihil-verklaring", async () => {
    loadBalancedDraft();
    renderPage();
    await waitFor(() => expect(nilButton()).not.toBeNull());
    expect(nilButton()!.disabled).toBe(true);
    expect(screen.getByTestId("beginbalans-nil-hint")).toHaveTextContent("2 opgeslagen regel(s)");
  });

  it("38/39/40. bevestiging, precies één declare_opening_balance_nil, succes pas na bevestigde kop", async () => {
    loadLinelessDraft();
    renderPage();
    await waitFor(() => expect(nilButton()!.disabled).toBe(false));
    fireEvent.click(nilButton()!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Vastleggen dat er geen beginbalans nodig is?");
    expect(within(dialog).getByTestId("beginbalans-nil-confirm-points")).toHaveTextContent("kan niet ongedaan worden gemaakt");
    expect(nilSpy).not.toHaveBeenCalled();

    // Eerst: de RPC slaagt maar de kop bevestigt niets → geen succes.
    fireEvent.click(within(dialog).getByTestId("beginbalans-nil-confirm"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Nihil-verklaring niet bevestigd", variant: "destructive" })),
    );
    expect(nilSpy).toHaveBeenCalledTimes(1);
    expect(nilSpy).toHaveBeenCalledWith("ob-1");
    expect(screen.queryByTestId("beginbalans-nil-notice")).toBeNull();

    // Dan: de kop bevestigt nil_declaration + nil_declared_at → succes.
    nilSpy.mockImplementation(async () => {
      state.header = nilRow();
      state.headers = [nilRow()];
      return "ob-1";
    });
    fireEvent.click(nilButton()!);
    const dialog2 = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog2).getByTestId("beginbalans-nil-confirm"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Vastgelegd: geen beginbalans nodig" }));
    expect(nilSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("beginbalans-nil-notice")).toHaveTextContent("Beginbalans bewust op nihil gezet"));
  });

  it("41/42. nihil: alleen-lezen met tijdstip, geen regels, geen opslaan, geen boeken, niet ongedaan te maken", async () => {
    state.headers = [nilRow()];
    state.header = nilRow();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Nihil"));
    const notice = screen.getByTestId("beginbalans-nil-notice");
    expect(notice).toHaveTextContent("Beginbalans bewust op nihil gezet op");
    expect(notice).toHaveTextContent("2027");
    expect(notice).toHaveTextContent("kan niet worden ingetrokken");
    expect((screen.getByLabelText("Omschrijving") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("beginbalans-lines-card")).toBeNull();
    expect(screen.queryByTestId("beginbalans-save")).toBeNull();
    expect(postButton()).toBeNull();
    expect(nilButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /ongedaan|intrekken|verwijderen/i })).toBeNull();
    expect(screen.getByTestId("beginbalans-report-links")).toBeInTheDocument();
  });

  it("de nihil-toestand wordt nooit als 'geen beginbalans' getoond", async () => {
    state.headers = [nilRow()];
    state.header = nilRow();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("beginbalans-status")).toHaveTextContent("Nihil"));
    expect(screen.queryByText("Nog geen beginbalans")).toBeNull();
  });
});
