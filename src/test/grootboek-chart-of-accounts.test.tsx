import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = {
  rekeningen: [] as any[],
  isLoading: false,
  updatePending: false,
  updateVariables: undefined as { id: string; actief?: boolean } | undefined,
  deletePending: false,
  seedPending: false,
  /** Administratie en grootboekmutaties voor het "Met saldo"-filter. */
  clientId: "client-1" as string,
  postings: [] as any[],
};

const toastSpy = vi.fn();
const addMutateAsync = vi.fn();
const updateMutate = vi.fn();
const updateMutateAsync = vi.fn();
const deleteMutateAsync = vi.fn();
const seedMutate = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
// Sinds het "Met saldo"-filter leest de pagina ook grootboekmutaties. Deze
// tests gaan over het schema en de bestaande filters; de saldobron staat hier
// standaard leeg en heeft een eigen testbestand.
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useAccountsWithActivity", () => ({
  useAccountsWithActivity: () => ({ ids: undefined, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: state.rekeningen, isLoading: state.isLoading }),
  useAddGrootboekrekening: () => ({ mutateAsync: addMutateAsync, isPending: false }),
  useUpdateGrootboekrekening: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: state.updatePending,
    variables: state.updateVariables,
  }),
  useDeleteGrootboekrekening: () => ({ mutateAsync: deleteMutateAsync, isPending: state.deletePending }),
  useSeedGrootboekrekeningen: () => ({ mutate: seedMutate, isPending: state.seedPending }),
  // Balans/W&V PR 2: de pagina vraagt nu ook het classificatierecht op.
  // Deze mock en de scrollIntoView-stub hieronder zijn testinfrastructuur. De
  // drie payload-asserties in dit bestand zijn wél gewijzigd, omdat de payload
  // sinds die PR classificatievelden kán dragen. Ze blijven exacte matches:
  // bij een nieuwe rekening staan de vier velden er als `null` in (dat pint
  // vast dat er niets automatisch wordt geclassificeerd), en bij het bewerken
  // van een rekening waarvan de classificatie niet is aangeraakt ontbreken ze
  // juist — die mag niet worden overschreven.
  useCanEditGrootboekClassification: () => ({ data: true }),
}));

import Grootboek from "@/pages/Grootboek";

// Radix Select (nieuw in de classificatiesectie) gebruikt scrollIntoView en
// ResizeObserver; jsdom kent die niet. Ook testinfrastructuur.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: typeof ResizeObserverStub }).ResizeObserver ?? ResizeObserverStub;

const makeAccount = (over: Partial<any> = {}) => ({
  id: `gb-${Math.random().toString(36).slice(2)}`,
  user_id: "u1",
  client_id: null,
  nummer: 4700,
  omschrijving: "Accountants- en advieskosten",
  categorie: "kosten",
  actief: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

function renderGrootboek() {
  // Router context is required since the page links to /grootboek/mutaties.
  // Test infrastructure only — no assertion in this file changed.
  render(
    <MemoryRouter initialEntries={["/grootboek"]}>
      <Grootboek />
    </MemoryRouter>,
  );
}

const statusFilters = () => within(screen.getByTestId("status-filters"));
const categorieFilters = () => within(screen.getByTestId("categorie-filters"));

beforeEach(() => {
  state.clientId = "client-1";
  state.postings = [];
  state.rekeningen = [];
  state.isLoading = false;
  state.updatePending = false;
  state.updateVariables = undefined;
  state.deletePending = false;
  state.seedPending = false;
  toastSpy.mockReset();
  addMutateAsync.mockReset().mockResolvedValue(undefined);
  updateMutate.mockReset();
  updateMutateAsync.mockReset().mockResolvedValue(undefined);
  deleteMutateAsync.mockReset().mockResolvedValue(undefined);
  seedMutate.mockReset();
});

describe("Rekeningschema — basis", () => {
  // 1. pagina rendert
  it("rendert de pagina", () => {
    state.rekeningen = [makeAccount()];
    renderGrootboek();
    expect(screen.getByRole("button", { name: /nieuwe grootboekrekening/i })).toBeInTheDocument();
  });

  // 2. sr-only Rekeningschema titel
  it("heeft een sr-only h1 met Rekeningschema", () => {
    renderGrootboek();
    const h1 = document.querySelector("h1");
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveTextContent("Rekeningschema");
    expect(h1).toHaveClass("sr-only");
  });
});

describe("Rekeningschema — zoeken en filters", () => {
  const seedThree = () => {
    state.rekeningen = [
      makeAccount({ id: "gb-1", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true }),
      makeAccount({ id: "gb-2", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: false }),
      makeAccount({ id: "gb-3", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten", actief: true }),
    ];
  };

  // 3. zoeken op nummer
  it("zoekt op rekeningnummer", () => {
    seedThree();
    renderGrootboek();
    fireEvent.change(screen.getByPlaceholderText(/zoek op nummer/i), { target: { value: "1300" } });
    expect(screen.getByText("Debiteuren")).toBeInTheDocument();
    expect(screen.queryByText("Crediteuren")).not.toBeInTheDocument();
    expect(screen.queryByText("Advieskosten")).not.toBeInTheDocument();
  });

  // 4. zoeken op omschrijving
  it("zoekt op omschrijving", () => {
    seedThree();
    renderGrootboek();
    fireEvent.change(screen.getByPlaceholderText(/zoek op nummer/i), { target: { value: "credit" } });
    expect(screen.getByText("Crediteuren")).toBeInTheDocument();
    expect(screen.queryByText("Debiteuren")).not.toBeInTheDocument();
  });

  // 5. zoeken op categorie
  it("zoekt op categorie", () => {
    seedThree();
    renderGrootboek();
    fireEvent.change(screen.getByPlaceholderText(/zoek op nummer/i), { target: { value: "kosten" } });
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
    expect(screen.queryByText("Debiteuren")).not.toBeInTheDocument();
    expect(screen.queryByText("Crediteuren")).not.toBeInTheDocument();
  });

  // 6. statusfilter Alle
  it("toont alle rekeningen met statusfilter Alle (standaard)", () => {
    seedThree();
    renderGrootboek();
    expect(screen.getByText("Debiteuren")).toBeInTheDocument();
    expect(screen.getByText("Crediteuren")).toBeInTheDocument();
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
  });

  // 7. statusfilter Actief
  it("filtert op statusfilter Actief", () => {
    seedThree();
    renderGrootboek();
    fireEvent.click(statusFilters().getByRole("button", { name: "Actief" }));
    expect(screen.getByText("Debiteuren")).toBeInTheDocument();
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
    expect(screen.queryByText("Crediteuren")).not.toBeInTheDocument();
  });

  // 8. statusfilter Inactief
  it("filtert op statusfilter Inactief", () => {
    seedThree();
    renderGrootboek();
    fireEvent.click(statusFilters().getByRole("button", { name: "Inactief" }));
    expect(screen.getByText("Crediteuren")).toBeInTheDocument();
    expect(screen.queryByText("Debiteuren")).not.toBeInTheDocument();
    expect(screen.queryByText("Advieskosten")).not.toBeInTheDocument();
  });

  // 9. categoriefilter
  it("filtert op categorie", () => {
    seedThree();
    renderGrootboek();
    fireEvent.click(categorieFilters().getByRole("button", { name: "Passiva" }));
    expect(screen.getByText("Crediteuren")).toBeInTheDocument();
    expect(screen.queryByText("Debiteuren")).not.toBeInTheDocument();
    expect(screen.queryByText("Advieskosten")).not.toBeInTheDocument();
  });

  // 10. gecombineerde search + filters
  it("combineert zoeken met status- en categoriefilter", () => {
    state.rekeningen = [
      makeAccount({ id: "gb-1", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten", actief: true }),
      makeAccount({ id: "gb-2", nummer: 4703, omschrijving: "Advocaatkosten", categorie: "kosten", actief: false }),
      makeAccount({ id: "gb-3", nummer: 1300, omschrijving: "Adviesdebiteuren", categorie: "activa", actief: true }),
    ];
    renderGrootboek();
    fireEvent.click(categorieFilters().getByRole("button", { name: "Kosten" }));
    fireEvent.click(statusFilters().getByRole("button", { name: "Actief" }));
    fireEvent.change(screen.getByPlaceholderText(/zoek op nummer/i), { target: { value: "advies" } });
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
    expect(screen.queryByText("Advocaatkosten")).not.toBeInTheDocument(); // inactief
    expect(screen.queryByText("Adviesdebiteuren")).not.toBeInTheDocument(); // categorie activa
  });
});

describe("Rekeningschema — tabel", () => {
  // 11. rekeningnummer zichtbaar
  it("toont het rekeningnummer", () => {
    state.rekeningen = [makeAccount({ nummer: 4753 })];
    renderGrootboek();
    expect(screen.getByText("4753")).toBeInTheDocument();
  });

  // 12. categoriebadge zichtbaar
  it("toont de categoriebadge", () => {
    state.rekeningen = [makeAccount({ categorie: "omzet" })];
    renderGrootboek();
    const col = screen.getByTestId("categorie-column-header").closest("table")!;
    expect(within(col).getByText("Omzet")).toBeInTheDocument();
  });

  // 13. actieve status zichtbaar
  it("toont Actief-status en een aangevinkte switch voor een actieve rekening", () => {
    state.rekeningen = [makeAccount({ omschrijving: "Actieve rekening", actief: true })];
    renderGrootboek();
    const row = screen.getByText("Actieve rekening").closest("tr")!;
    expect(within(row).getByText("Actief")).toBeInTheDocument();
    expect(within(row).getByRole("switch")).toBeChecked();
  });

  // 14. inactieve status zichtbaar
  it("toont Inactief-status en een uitgevinkte switch voor een inactieve rekening", () => {
    state.rekeningen = [makeAccount({ omschrijving: "Inactieve rekening", actief: false })];
    renderGrootboek();
    const row = screen.getByText("Inactieve rekening").closest("tr")!;
    expect(within(row).getByText("Inactief")).toBeInTheDocument();
    expect(within(row).getByRole("switch")).not.toBeChecked();
  });

  // 15. toggle actief gebruikt bestaande mutation
  it("toggelen van de switch roept de bestaande update-mutation aan", () => {
    state.rekeningen = [makeAccount({ id: "gb-toggle", omschrijving: "Toggle rekening", actief: true })];
    renderGrootboek();
    const row = screen.getByText("Toggle rekening").closest("tr")!;
    fireEvent.click(within(row).getByRole("switch"));
    expect(updateMutate).toHaveBeenCalledWith({ id: "gb-toggle", actief: false });
  });
});

describe("Rekeningschema — toevoegen/bewerken", () => {
  // 16. nieuwe rekening opent dialog
  it("Nieuwe grootboekrekening opent een leeg formulier", () => {
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /nieuwe grootboekrekening/i }));
    expect(screen.getByRole("heading", { name: "Nieuwe grootboekrekening" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nummer *")).toHaveValue(null);
    expect(screen.getByLabelText("Omschrijving *")).toHaveValue("");
    expect(screen.getByLabelText("Actief")).toBeChecked();
  });

  // 17. edit opent bestaande waarden
  it("bewerken opent het dialoog met de bestaande waarden voorgevuld", async () => {
    state.rekeningen = [
      makeAccount({ id: "gb-edit", nummer: 8199, omschrijving: "Vrijgestelde omzet", categorie: "omzet", actief: false }),
    ];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /vrijgestelde omzet bewerken/i }));
    expect(screen.getByRole("heading", { name: "Grootboekrekening bewerken" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nummer *")).toHaveValue(8199);
    expect(screen.getByLabelText("Omschrijving *")).toHaveValue("Vrijgestelde omzet");
    expect(screen.getByLabelText("Actief")).not.toBeChecked();

    // Save without changing anything: the categorie carried into the payload
    // proves the form was seeded from the row (not just nummer/omschrijving).
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    // Balans/W&V PR 2: de classificatie is hier niet aangeraakt, dus gaat ze
    // niet mee — wat opgeslagen staat blijft staan. De exacte match bewijst
    // tegelijk dat er niets is bíj verzonnen: categorie "omzet" leidt nergens
    // een W&V-classificatie uit af.
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: "gb-edit",
      nummer: 8199,
      omschrijving: "Vrijgestelde omzet",
      categorie: "omzet",
      actief: false,
    });
  });

  // 18. verplichte nummer/omschrijvingvalidatie blijft
  it("blokkeert opslaan zonder nummer of omschrijving en toont de validatiemelding", () => {
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /nieuwe grootboekrekening/i }));
    fireEvent.click(screen.getByRole("button", { name: /^toevoegen$/i }));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Vul alle verplichte velden in", variant: "destructive" });
    expect(addMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("Rekeningnummer is verplicht.")).toBeInTheDocument();
    expect(screen.getByText("Omschrijving is verplicht.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nummer *")).toHaveAttribute("aria-invalid", "true");
  });

  // 19. save bestaande rekening
  it("Opslaan werkt een bestaande rekening bij via de bestaande mutation", async () => {
    state.rekeningen = [makeAccount({ id: "gb-save", nummer: 4700, omschrijving: "Oude naam", categorie: "kosten", actief: true })];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /oude naam bewerken/i }));
    fireEvent.change(screen.getByLabelText("Omschrijving *"), { target: { value: "Nieuwe naam" } });
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));
    // Alleen de omschrijving wijzigt; de onaangeroerde classificatie gaat niet
    // mee en wordt dus ook niet overschreven.
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledWith({
      id: "gb-save",
      nummer: 4700,
      omschrijving: "Nieuwe naam",
      categorie: "kosten",
      actief: true,
    }));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Grootboekrekening bijgewerkt" });
  });

  // 20. add nieuwe rekening
  it("Toevoegen maakt een nieuwe rekening aan via de bestaande mutation", async () => {
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /nieuwe grootboekrekening/i }));
    fireEvent.change(screen.getByLabelText("Nummer *"), { target: { value: "4321" } });
    fireEvent.change(screen.getByLabelText("Omschrijving *"), { target: { value: "Testrekening" } });
    fireEvent.click(screen.getByRole("button", { name: /^toevoegen$/i }));
    await waitFor(() => expect(addMutateAsync).toHaveBeenCalledWith({
      nummer: 4321,
      omschrijving: "Testrekening",
      categorie: "kosten",
      actief: true,
      // Een nieuwe rekening wordt nooit automatisch geclassificeerd.
      statement_type: null,
      report_group: null,
      normal_side: null,
      report_sort: null,
    }));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Grootboekrekening toegevoegd" });
  });
});

describe("Rekeningschema — verwijderen", () => {
  // 21. delete vereist bevestiging
  it("verwijderen vereist eerst bevestiging voordat de mutation wordt aangeroepen", () => {
    state.rekeningen = [makeAccount({ id: "gb-del", omschrijving: "Te verwijderen rekening" })];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /te verwijderen rekening verwijderen/i }));
    expect(screen.getByRole("heading", { name: "Grootboekrekening verwijderen?" })).toBeInTheDocument();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });

  // 22. delete gebruikt bestaande mutation
  it("bevestigen roept de bestaande delete-mutation aan", async () => {
    state.rekeningen = [makeAccount({ id: "gb-del", omschrijving: "Te verwijderen rekening" })];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /te verwijderen rekening verwijderen/i }));
    fireEvent.click(screen.getByRole("button", { name: /^verwijderen$/i }));
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith("gb-del"));
    expect(toastSpy).toHaveBeenCalledWith({ title: "Grootboekrekening verwijderd" });
  });

  // 23. delete error wordt getoond
  it("toont een foutmelding wanneer de delete-mutation faalt", async () => {
    deleteMutateAsync.mockRejectedValue(new Error("foreign key constraint"));
    state.rekeningen = [makeAccount({ id: "gb-del", omschrijving: "Gekoppelde rekening" })];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /gekoppelde rekening verwijderen/i }));
    fireEvent.click(screen.getByRole("button", { name: /^verwijderen$/i }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({
      title: "Fout",
      description: "foreign key constraint",
      variant: "destructive",
    }));
  });
});

describe("Rekeningschema — standaard schema import", () => {
  // 24. import standaard schema vereist bevestiging
  it("Import standaard schema vereist eerst bevestiging", () => {
    state.rekeningen = [makeAccount()];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /import standaard schema/i }));
    expect(screen.getByRole("heading", { name: "Standaard grootboekrekeningen importeren?" })).toBeInTheDocument();
    expect(seedMutate).not.toHaveBeenCalled();
  });

  // 25. import gebruikt bestaande seed mutation
  it("bevestigen roept de bestaande seed-mutation aan met force=true", () => {
    state.rekeningen = [makeAccount()];
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /import standaard schema/i }));
    fireEvent.click(screen.getByRole("button", { name: /^importeren$/i }));
    expect(seedMutate).toHaveBeenCalledTimes(1);
    expect(seedMutate.mock.calls[0][0]).toBe(true);
  });
});

describe("Rekeningschema — auto-seed", () => {
  // 26. auto-seedgedrag blijft intact
  it("roept automatisch de seed-mutation aan met force=false wanneer er nog geen rekeningen zijn", () => {
    state.rekeningen = [];
    renderGrootboek();
    expect(seedMutate).toHaveBeenCalledWith(false);
  });

  it("roept geen auto-seed aan wanneer er al rekeningen bestaan", () => {
    state.rekeningen = [makeAccount()];
    renderGrootboek();
    expect(seedMutate).not.toHaveBeenCalled();
  });
});

describe("Rekeningschema — states", () => {
  // 27. loading state
  it("toont een laadstatus in plaats van de tabel", () => {
    state.isLoading = true;
    renderGrootboek();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // 28. empty state (helemaal geen rekeningen)
  it("toont een lege-staat melding wanneer er nog geen rekeningen zijn", () => {
    state.rekeningen = [];
    renderGrootboek();
    expect(screen.getByText(/nog geen grootboekrekeningen/i)).toBeInTheDocument();
  });

  // 29. filter-empty state
  it("toont een filterspecifieke lege-staat melding zonder zoekresultaten", () => {
    state.rekeningen = [makeAccount({ omschrijving: "Debiteuren", categorie: "activa" })];
    renderGrootboek();
    fireEvent.change(screen.getByPlaceholderText(/zoek op nummer/i), { target: { value: "nonexistent" } });
    expect(screen.getByText(/geen rekeningen gevonden voor/i)).toBeInTheDocument();
  });

  it("toont een categoriespecifieke lege-staat melding", () => {
    state.rekeningen = [makeAccount({ categorie: "activa" })];
    renderGrootboek();
    fireEvent.click(categorieFilters().getByRole("button", { name: "Kosten" }));
    expect(screen.getByText(/geen rekeningen gevonden in categorie kosten/i)).toBeInTheDocument();
  });
});

describe("Rekeningschema — responsive", () => {
  // 30. responsive classes
  it("verbergt alleen de categoriekolom op kleine schermen; nummer/omschrijving/status/acties blijven zichtbaar", () => {
    state.rekeningen = [makeAccount()];
    renderGrootboek();
    const categorieHeader = screen.getByTestId("categorie-column-header");
    expect(categorieHeader.className).toMatch(/hidden/);
    expect(categorieHeader.className).toMatch(/md:table-cell/);

    const headers = screen.getAllByRole("columnheader");
    const nummerHeader = headers.find((h) => h.textContent === "Nummer")!;
    const omschrijvingHeader = headers.find((h) => h.textContent === "Omschrijving")!;
    const statusHeader = headers.find((h) => h.textContent === "Status")!;
    const actiesHeader = headers.find((h) => h.textContent === "Acties")!;
    for (const h of [nummerHeader, omschrijvingHeader, statusHeader, actiesHeader]) {
      expect(h.className).not.toMatch(/hidden/);
    }
  });
});
