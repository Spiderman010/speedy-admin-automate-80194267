import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Balans/W&V PR 2 — rapportageclassificatie-UI.
 *
 * De pure regels worden rechtstreeks op src/lib/reporting-classification.ts
 * bewezen; het gedrag van de pagina met een gemockte datalaag, zodat zichtbaar
 * is wát er precies wordt opgeslagen. Geen migratie, geen SQL, geen
 * typewijziging, geen rekenwerk: die grenzen staan onderaan als statische
 * bewaking.
 */

// ── Gedeelde, muteerbare toestand voor de paginatests ────────────────────────
const state = {
  rekeningen: [] as any[],
  isLoading: false,
  canClassify: true as boolean | undefined,
};

const toastSpy = vi.fn();
const addMutateAsync = vi.fn();
const updateMutate = vi.fn();
const updateMutateAsync = vi.fn();
const deleteMutateAsync = vi.fn();
const seedMutate = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: state.rekeningen, isLoading: state.isLoading }),
  useAddGrootboekrekening: () => ({ mutateAsync: addMutateAsync, isPending: false }),
  useUpdateGrootboekrekening: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: false,
    variables: undefined,
  }),
  useDeleteGrootboekrekening: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
  useSeedGrootboekrekeningen: () => ({ mutate: seedMutate, isPending: false }),
  useCanEditGrootboekClassification: () => ({ data: state.canClassify }),
}));

import Grootboek from "@/pages/Grootboek";

// Radix Select gebruikt scrollIntoView en ResizeObserver; jsdom kent die niet.
// Zelfde stub als in grootboek-combobox-client-scope.test.tsx.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: typeof ResizeObserverStub }).ResizeObserver ?? ResizeObserverStub;

import {
  BALANS_GROUPS,
  WINST_VERLIES_GROUPS,
  EMPTY_CLASSIFICATION,
  buildClassificationPayload,
  classificationErrorMessage,
  classificationFromAccount,
  classificationLabel,
  groupsFor,
  isClassified,
  isGroupAllowed,
  matchesClassificationFilter,
  onReportGroupChange,
  onStatementTypeChange,
  parseReportSort,
  sameClassification,
  validateClassification,
} from "@/lib/reporting-classification";
import type { ClassificationForm } from "@/lib/reporting-classification";

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
  statement_type: null,
  report_group: null,
  normal_side: null,
  report_sort: null,
  ...over,
});

const form = (over: Partial<ClassificationForm> = {}): ClassificationForm => ({
  ...EMPTY_CLASSIFICATION,
  ...over,
});

function renderGrootboek() {
  render(
    <MemoryRouter initialEntries={["/grootboek"]}>
      <Grootboek />
    </MemoryRouter>,
  );
}

/** Opent het bewerkdialoog van de eerste rekening. */
function openEditDialog(naam = /bewerken/i) {
  fireEvent.click(screen.getAllByRole("button", { name: naam })[0]);
  return screen.getByRole("dialog");
}

/** Kiest een optie in een Radix Select via de zichtbare trigger. */
async function chooseOption(triggerName: RegExp, optionName: RegExp | string) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
}

beforeEach(() => {
  state.rekeningen = [];
  state.isLoading = false;
  state.canClassify = true;
  toastSpy.mockReset();
  addMutateAsync.mockReset().mockResolvedValue(undefined);
  updateMutate.mockReset();
  updateMutateAsync.mockReset().mockResolvedValue(undefined);
  deleteMutateAsync.mockReset().mockResolvedValue(undefined);
  seedMutate.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("toestandsregels (puur)", () => {
  it("3. Balans biedt uitsluitend balansgroepen", () => {
    expect(groupsFor("balans")).toEqual(BALANS_GROUPS);
    expect(BALANS_GROUPS).toHaveLength(7);
    for (const g of WINST_VERLIES_GROUPS) {
      expect(isGroupAllowed("balans", g), g).toBe(false);
    }
  });

  it("4. Winst-en-verliesrekening biedt uitsluitend W&V-groepen", () => {
    expect(groupsFor("winst_verlies")).toEqual(WINST_VERLIES_GROUPS);
    expect(WINST_VERLIES_GROUPS).toHaveLength(8);
    for (const g of BALANS_GROUPS) {
      expect(isGroupAllowed("winst_verlies", g), g).toBe(false);
    }
  });

  it("5. Balans → W&V wist de onverenigbare groep", () => {
    const next = onStatementTypeChange(
      form({ statementType: "balans", reportGroup: "vaste_activa", normalSide: "debet", reportSort: "10" }),
      "winst_verlies",
    );
    expect(next.statementType).toBe("winst_verlies");
    expect(next.reportGroup).toBeNull();
    // Zijde en sortering blijven staan: alleen de groep is onverenigbaar.
    expect(next.normalSide).toBe("debet");
    expect(next.reportSort).toBe("10");
  });

  it("6. W&V → Balans wist de onverenigbare groep", () => {
    const next = onStatementTypeChange(
      form({ statementType: "winst_verlies", reportGroup: "netto_omzet" }),
      "balans",
    );
    expect(next.statementType).toBe("balans");
    expect(next.reportGroup).toBeNull();
  });

  it("terug naar Niet geclassificeerd wist óók zijde en sortering", () => {
    const next = onStatementTypeChange(
      form({ statementType: "balans", reportGroup: "eigen_vermogen", normalSide: "credit", reportSort: "3" }),
      null,
    );
    expect(next).toEqual(EMPTY_CLASSIFICATION);
  });

  it("hetzelfde rapport opnieuw kiezen laat de groep staan", () => {
    const start = form({ statementType: "balans", reportGroup: "voorzieningen" });
    expect(onStatementTypeChange(start, "balans").reportGroup).toBe("voorzieningen");
  });

  it("een groep van het andere overzicht wordt niet aangenomen", () => {
    const start = form({ statementType: "balans", reportGroup: "vaste_activa" });
    expect(onReportGroupChange(start, "netto_omzet" as never)).toEqual(start);
  });

  it("7. Niet geclassificeerd levert statement_type én report_group null", () => {
    expect(buildClassificationPayload(form())).toEqual({
      statement_type: null,
      report_group: null,
      normal_side: null,
      report_sort: null,
    });
  });

  it("7b. een ongeldige combinatie kan nooit een payload opleveren", () => {
    // Zelfs als de toestand op een of andere manier corrupt raakt.
    expect(buildClassificationPayload(form({ statementType: "balans", reportGroup: "netto_omzet" as never })))
      .toEqual({ statement_type: null, report_group: null, normal_side: null, report_sort: null });
    expect(buildClassificationPayload(form({ reportGroup: "vaste_activa" })).report_group).toBeNull();
  });

  it("8. validatie blokkeert elke ongeldige combinatie", () => {
    expect(validateClassification(form({ statementType: "balans" })).reportGroup).toBeTruthy();
    expect(validateClassification(form({ reportGroup: "vaste_activa" })).reportGroup).toBeTruthy();
    expect(
      validateClassification(form({ statementType: "winst_verlies", reportGroup: "prive" as never })).reportGroup,
    ).toBeTruthy();
    expect(validateClassification(form())).toEqual({});
    expect(validateClassification(form({ statementType: "balans", reportGroup: "prive" }))).toEqual({});
  });

  it("9/10/11. normale zijde: debet, credit en leeg zijn alle drie geldig", () => {
    const base = { statementType: "balans" as const, reportGroup: "vaste_activa" as const };
    expect(buildClassificationPayload(form({ ...base, normalSide: "debet" })).normal_side).toBe("debet");
    expect(buildClassificationPayload(form({ ...base, normalSide: "credit" })).normal_side).toBe("credit");
    expect(buildClassificationPayload(form({ ...base, normalSide: null })).normal_side).toBeNull();
    expect(validateClassification(form({ ...base, normalSide: null }))).toEqual({});
  });

  it("12/13/14. sortering: leeg → null, 0 geldig, negatief geweigerd", () => {
    expect(parseReportSort("")).toEqual({ kind: "ok", value: null });
    expect(parseReportSort("   ")).toEqual({ kind: "ok", value: null });
    expect(parseReportSort("0")).toEqual({ kind: "ok", value: 0 });
    expect(parseReportSort("10")).toEqual({ kind: "ok", value: 10 });
    expect(parseReportSort("-1").kind).toBe("invalid");
    expect(parseReportSort("2,5").kind).toBe("invalid");
    expect(parseReportSort("abc").kind).toBe("invalid");

    const base = { statementType: "balans" as const, reportGroup: "vaste_activa" as const };
    // 0 is een waarde, geen synoniem voor leeg.
    expect(buildClassificationPayload(form({ ...base, reportSort: "0" })).report_sort).toBe(0);
    expect(buildClassificationPayload(form({ ...base, reportSort: "" })).report_sort).toBeNull();
    expect(validateClassification(form({ ...base, reportSort: "-1" })).reportSort).toBeTruthy();
    expect(validateClassification(form({ ...base, reportSort: "0" }))).toEqual({});
  });

  it("2. een bestaande classificatie laadt in het formulier", () => {
    expect(
      classificationFromAccount({
        statement_type: "winst_verlies",
        report_group: "afschrijvingen",
        normal_side: "debet",
        report_sort: 0,
      }),
    ).toEqual({
      statementType: "winst_verlies",
      reportGroup: "afschrijvingen",
      normalSide: "debet",
      reportSort: "0",
    });
  });

  it("2b. een onbekende of onverenigbare opgeslagen waarde wordt niet stilzwijgend overgenomen", () => {
    expect(classificationFromAccount({ statement_type: "foo", report_group: "vaste_activa" })).toEqual(
      EMPTY_CLASSIFICATION,
    );
    expect(
      classificationFromAccount({ statement_type: "balans", report_group: "netto_omzet" }).reportGroup,
    ).toBeNull();
    expect(classificationFromAccount(null)).toEqual(EMPTY_CLASSIFICATION);
  });

  it("geclassificeerd vereist overzicht én passende groep; half telt niet mee", () => {
    expect(isClassified({ statement_type: "balans", report_group: "vaste_activa" })).toBe(true);
    expect(isClassified({ statement_type: "balans", report_group: null })).toBe(false);
    expect(isClassified({ statement_type: null, report_group: "vaste_activa" })).toBe(false);
    expect(isClassified({ statement_type: "balans", report_group: "netto_omzet" })).toBe(false);
    expect(isClassified(null)).toBe(false);
    expect(classificationLabel({ statement_type: "balans", report_group: "prive" })).toBe("Privé");
    expect(classificationLabel(null)).toBe("Niet geclassificeerd");
  });

  it("23/24. het filter verdeelt de rekeningen zonder er een over te slaan", () => {
    const geclassificeerd = { statement_type: "balans", report_group: "vaste_activa" };
    const niet = { statement_type: null, report_group: null };
    expect(matchesClassificationFilter(geclassificeerd, "alle")).toBe(true);
    expect(matchesClassificationFilter(niet, "alle")).toBe(true);
    expect(matchesClassificationFilter(geclassificeerd, "geclassificeerd")).toBe(true);
    expect(matchesClassificationFilter(niet, "geclassificeerd")).toBe(false);
    expect(matchesClassificationFilter(geclassificeerd, "niet_geclassificeerd")).toBe(false);
    expect(matchesClassificationFilter(niet, "niet_geclassificeerd")).toBe(true);
  });

  it("28. een databasefout toont nooit SQL-interna", () => {
    const echt = {
      code: "23514",
      message:
        'new row for relation "grootboekrekeningen" violates check constraint "grootboekrekeningen_reporting_pair_check"',
    };
    const tekst = classificationErrorMessage(echt);
    expect(tekst).toBe("Deze combinatie van overzicht en groep is niet toegestaan.");
    for (const leak of ["check constraint", "grootboekrekeningen_", "relation", "23514", "new row"]) {
      expect(tekst, leak).not.toContain(leak);
    }
    expect(classificationErrorMessage({ code: "42501", message: "permission denied for table" })).toMatch(
      /geen rechten/i,
    );
    expect(classificationErrorMessage({ message: "violates check constraint \"grootboekrekeningen_report_sort_check\"" }))
      .toMatch(/negatief/i);
    // Onbekende fouten krijgen een neutrale tekst, nooit de servertekst.
    const onbekend = classificationErrorMessage({ message: "SQLSTATE 42P01 relation does not exist" });
    expect(onbekend).toBe("Opslaan is niet gelukt. Probeer het opnieuw.");
    expect(onbekend).not.toMatch(/42P01|relation/);
  });

  it("28b. meldingen van de applicatie zelf blijven staan — die vertellen wat er te doen valt", () => {
    // De hooks werpen deze letterlijk op; hij komt niet van de database en
    // mag niet verdwijnen achter een neutrale tekst.
    expect(classificationErrorMessage(new Error("Niet ingelogd"))).toBe("Niet ingelogd");
    expect(readFileSync("src/hooks/useGrootboekrekeningen.ts", "utf8")).toContain('throw new Error("Niet ingelogd")');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("overzicht — badges en filter", () => {
  const seedTwo = () => {
    state.rekeningen = [
      makeAccount({
        id: "gb-1",
        nummer: 1000,
        omschrijving: "Kas",
        categorie: "activa",
        statement_type: "balans",
        report_group: "vlottende_activa",
      }),
      makeAccount({ id: "gb-2", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten" }),
    ];
  };

  it("1. een ongeclassificeerde rekening rendert met de juiste badge", () => {
    state.rekeningen = [makeAccount({ id: "gb-2", omschrijving: "Advieskosten" })];
    renderGrootboek();
    const badge = screen.getByTestId("classificatie-badge-gb-2");
    expect(badge).toHaveTextContent("Niet geclassificeerd");
    expect(badge).toHaveAttribute("data-classified", "false");
    expect(screen.queryByTestId("classificatie-groep-gb-2")).toBeNull();
  });

  it("21. een geclassificeerde rekening toont de badge én het groepslabel", () => {
    seedTwo();
    renderGrootboek();
    const badge = screen.getByTestId("classificatie-badge-gb-1");
    expect(badge).toHaveTextContent("Geclassificeerd");
    expect(badge).toHaveAttribute("data-classified", "true");
    expect(screen.getByTestId("classificatie-groep-gb-1")).toHaveTextContent("Balans · Vlottende activa");
  });

  it("22. een half ingevulde rij geldt als niet geclassificeerd", () => {
    state.rekeningen = [makeAccount({ id: "gb-3", statement_type: "balans", report_group: null })];
    renderGrootboek();
    expect(screen.getByTestId("classificatie-badge-gb-3")).toHaveAttribute("data-classified", "false");
  });

  it("23. het filter Geclassificeerd toont alleen geclassificeerde rekeningen", () => {
    seedTwo();
    renderGrootboek();
    fireEvent.click(within(screen.getByTestId("classificatie-filters")).getByText("Geclassificeerd"));
    expect(screen.getByText("Kas")).toBeInTheDocument();
    expect(screen.queryByText("Advieskosten")).toBeNull();
  });

  it("24. het filter Niet geclassificeerd toont alleen de rest", () => {
    seedTwo();
    renderGrootboek();
    fireEvent.click(within(screen.getByTestId("classificatie-filters")).getByText("Niet geclassificeerd"));
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
    expect(screen.queryByText("Kas")).toBeNull();
  });

  it("het filter is omkeerbaar en Alle toont weer alles", () => {
    seedTwo();
    renderGrootboek();
    const chips = () => within(screen.getByTestId("classificatie-filters"));
    fireEvent.click(chips().getByText("Geclassificeerd"));
    fireEvent.click(chips().getByText("Geclassificeerd")); // nogmaals = uit
    expect(screen.getByText("Advieskosten")).toBeInTheDocument();
    expect(screen.getByText("Kas")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("formulier — opslaan", () => {
  it("2. het bewerkformulier laadt de bestaande classificatie", async () => {
    state.rekeningen = [
      makeAccount({
        id: "gb-1",
        omschrijving: "Kas",
        statement_type: "balans",
        report_group: "vlottende_activa",
        normal_side: "debet",
        report_sort: 5,
      }),
    ];
    renderGrootboek();
    openEditDialog();
    expect(screen.getByRole("combobox", { name: /rapport/i })).toHaveTextContent("Balans");
    expect(screen.getByRole("combobox", { name: /groep/i })).toHaveTextContent("Vlottende activa");
    expect(screen.getByRole("combobox", { name: /normale zijde/i })).toHaveTextContent("Debet");
    expect(screen.getByLabelText(/sortering/i)).toHaveValue(5);
  });

  it("3/4. de groeplijst bevat precies de groepen van het gekozen rapport", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" })];
    renderGrootboek();
    openEditDialog();

    fireEvent.click(screen.getByRole("combobox", { name: /groep/i }));
    expect(await screen.findByRole("option", { name: "Eigen vermogen" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Privé" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Netto-omzet" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Afschrijvingen" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(7);
  });

  it("5. het rapport wisselen wist de groep in het formulier en blokkeert opslaan tot er een nieuwe is", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" })];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Winst-en-verliesrekening");
    expect(screen.getByRole("combobox", { name: /groep/i })).toHaveTextContent("Kies een groep");
    expect(screen.getByRole("button", { name: /opslaan/i })).toBeDisabled();

    // En de lijst toont nu uitsluitend W&V-groepen.
    fireEvent.click(screen.getByRole("combobox", { name: /groep/i }));
    expect(await screen.findByRole("option", { name: "Netto-omzet" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Vaste activa" })).toBeNull();
  });

  it("8b. een onvolledige classificatie zegt meteen waaróm opslaan niet kan", async () => {
    // Zonder deze melding zou de knop grijs zijn zonder enige uitleg: de
    // opslaanknop is immers uitgeschakeld, dus een melding die pas ná een
    // poging verschijnt, verschijnt nooit.
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Balans");
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent(/kies een groep binnen balans/i);
    const groep = screen.getByRole("combobox", { name: /groep/i });
    expect(groep).toHaveAttribute("aria-invalid", "true");
    expect(groep).toHaveAttribute("aria-describedby", "gb-report-group-error");
  });

  it("8. een onvolledige classificatie kan niet worden opgeslagen", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Balans");
    const opslaan = screen.getByRole("button", { name: /opslaan/i });
    expect(opslaan).toBeDisabled();
    fireEvent.click(opslaan);
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("14. een negatieve sortering blokkeert opslaan en wordt nooit verstuurd", async () => {
    state.rekeningen = [
      makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" }),
    ];
    renderGrootboek();
    openEditDialog();

    fireEvent.change(screen.getByLabelText(/sortering/i), { target: { value: "-1" } });
    expect(await screen.findByText(/niet negatief/i)).toBeInTheDocument();
    const opslaan = screen.getByRole("button", { name: /opslaan/i });
    expect(opslaan).toBeDisabled();
    fireEvent.click(opslaan);
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("13. sortering 0 wordt als 0 opgeslagen, niet als leeg", async () => {
    state.rekeningen = [
      makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" }),
    ];
    renderGrootboek();
    openEditDialog();

    fireEvent.change(screen.getByLabelText(/sortering/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0].report_sort).toBe(0);
  });

  it("7/15/16/17/18. Niet geclassificeerd slaat null op en laat de stamvelden ongemoeid", async () => {
    state.rekeningen = [
      makeAccount({
        id: "gb-1",
        nummer: 1000,
        omschrijving: "Kas",
        categorie: "activa",
        actief: true,
        statement_type: "balans",
        report_group: "vlottende_activa",
        normal_side: "debet",
        report_sort: 5,
      }),
    ];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Niet geclassificeerd");
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());

    const payload = updateMutateAsync.mock.calls[0][0];
    // 7: alle vier expliciet null — geen onzichtbare restwaarde.
    expect(payload.statement_type).toBeNull();
    expect(payload.report_group).toBeNull();
    expect(payload.normal_side).toBeNull();
    expect(payload.report_sort).toBeNull();
    // 15/16/17/18: categorie, nummer, omschrijving en actief onveranderd.
    expect(payload.categorie).toBe("activa");
    expect(payload.nummer).toBe(1000);
    expect(payload.omschrijving).toBe("Kas");
    expect(payload.actief).toBe(true);
  });

  it("9/10. een volledige classificatie gaat compleet mee, met behoud van categorie", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1", nummer: 8000, omschrijving: "Omzet", categorie: "omzet" })];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Winst-en-verliesrekening");
    await chooseOption(/groep/i, "Netto-omzet");
    await chooseOption(/normale zijde/i, "Credit");
    fireEvent.change(screen.getByLabelText(/sortering/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());

    expect(updateMutateAsync.mock.calls[0][0]).toMatchObject({
      id: "gb-1",
      statement_type: "winst_verlies",
      report_group: "netto_omzet",
      normal_side: "credit",
      report_sort: 10,
      categorie: "omzet",
      nummer: 8000,
      omschrijving: "Omzet",
    });
  });

  it("11. zonder normale zijde wordt null opgeslagen", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    renderGrootboek();
    openEditDialog();

    await chooseOption(/rapport/i, "Balans");
    await chooseOption(/groep/i, "Voorzieningen");
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0].normal_side).toBeNull();
    expect(updateMutateAsync.mock.calls[0][0].report_sort).toBeNull();
  });

  it("19/20. een nieuwe rekening wordt niet automatisch geclassificeerd op nummer of categorie", async () => {
    renderGrootboek();
    fireEvent.click(screen.getByRole("button", { name: /nieuwe grootboekrekening/i }));

    // Een nummer uit het "vaste activa"-bereik en categorie activa: er mag
    // niets worden voorgesteld of ingevuld.
    fireEvent.change(screen.getByLabelText(/nummer/i), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/omschrijving/i), { target: { value: "Bedrijfsgebouwen" } });
    await chooseOption(/categorie/i, "Activa");
    expect(screen.getByRole("combobox", { name: /rapport/i })).toHaveTextContent("Niet geclassificeerd");
    // Zonder rapport is er geen groepkeuze zichtbaar.
    expect(screen.queryByRole("combobox", { name: /groep/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /toevoegen/i }));
    await waitFor(() => expect(addMutateAsync).toHaveBeenCalled());
    const payload = addMutateAsync.mock.calls[0][0];
    expect(payload.statement_type).toBeNull();
    expect(payload.report_group).toBeNull();
    expect(payload.categorie).toBe("activa");
  });

  it("28. een mislukte opslag toont een nette tekst zonder SQL-interna", async () => {
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    updateMutateAsync.mockRejectedValue({
      code: "23514",
      message:
        'new row for relation "grootboekrekeningen" violates check constraint "grootboekrekeningen_reporting_pair_check"',
    });
    renderGrootboek();
    openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const beschrijving = toastSpy.mock.calls.at(-1)![0].description as string;
    expect(beschrijving).not.toMatch(/check constraint|grootboekrekeningen_|relation|23514/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("onaangeroerde classificatie blijft met rust", () => {
  it("een hernoeming van een ongeclassificeerde rekening wist geen verborgen zijde of sortering", async () => {
    // Het schema staat normal_side/report_sort toe zonder overzicht; die twee
    // velden zijn dan niet zichtbaar. Ze mogen niet sneuvelen bij een edit die
    // er niets mee te maken heeft.
    state.rekeningen = [
      makeAccount({ id: "gb-1", omschrijving: "Oude naam", normal_side: "debet", report_sort: 42 }),
    ];
    renderGrootboek();
    openEditDialog();
    fireEvent.change(screen.getByLabelText(/omschrijving/i), { target: { value: "Nieuwe naam" } });
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());

    const payload = updateMutateAsync.mock.calls[0][0];
    expect(payload.omschrijving).toBe("Nieuwe naam");
    // Niets aangeraakt = niets meegestuurd, dus niets overschreven.
    expect(payload).not.toHaveProperty("normal_side");
    expect(payload).not.toHaveProperty("report_sort");
    expect(payload).not.toHaveProperty("statement_type");
  });

  it("een opgeslagen groep die deze versie niet kent blokkeert het bewerken van de rekening niet", async () => {
    // De groepenlijst kan server-side groeien. Een oudere client mag zo'n
    // rekening dan niet onbewerkbaar maken — nummer en omschrijving staan er
    // los van, en de onbekende waarde blijft onaangeroerd staan.
    state.rekeningen = [
      makeAccount({ id: "gb-1", omschrijving: "Onbekend", statement_type: "balans", report_group: "groep_uit_de_toekomst" }),
    ];
    renderGrootboek();
    openEditDialog();

    fireEvent.change(screen.getByLabelText(/omschrijving/i), { target: { value: "Hernoemd" } });
    const opslaan = screen.getByRole("button", { name: /opslaan/i });
    expect(opslaan).not.toBeDisabled();
    fireEvent.click(opslaan);
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());

    const payload = updateMutateAsync.mock.calls[0][0];
    expect(payload.omschrijving).toBe("Hernoemd");
    expect(payload).not.toHaveProperty("statement_type");
    expect(payload).not.toHaveProperty("report_group");
  });

  it("maar zodra de classificatie wél wordt aangeraakt, gelden de regels onverkort", async () => {
    state.rekeningen = [
      makeAccount({ id: "gb-1", statement_type: "balans", report_group: "groep_uit_de_toekomst" }),
    ];
    renderGrootboek();
    openEditDialog();

    // Dezelfde rekening, nu mét een ingreep in de classificatie: onvolledig,
    // dus geblokkeerd.
    await chooseOption(/rapport/i, "Winst-en-verliesrekening");
    expect(screen.getByRole("button", { name: /opslaan/i })).toBeDisabled();
    // En na een geldige keuze gaat ze gewoon mee.
    await chooseOption(/groep/i, "Belastingen");
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(updateMutateAsync.mock.calls[0][0]).toMatchObject({
      statement_type: "winst_verlies",
      report_group: "belastingen",
    });
  });

  it("sameClassification vergelijkt sortering op waarde, niet op tekst", () => {
    const base = { statementType: "balans" as const, reportGroup: "prive" as const };
    expect(sameClassification(form({ ...base, reportSort: "7" }), form({ ...base, reportSort: "07" }))).toBe(true);
    expect(sameClassification(form({ reportSort: "" }), form({ reportSort: "   " }))).toBe(true);
    expect(sameClassification(form({ ...base, reportSort: "7" }), form({ ...base, reportSort: "8" }))).toBe(false);
    // 0 is een waarde, leeg is er geen.
    expect(sameClassification(form({ ...base, reportSort: "0" }), form({ ...base, reportSort: "" }))).toBe(false);
    // Ongeldige invoer telt altijd als aangeraakt.
    expect(sameClassification(form({ ...base, reportSort: "-1" }), form({ ...base, reportSort: "-1" }))).toBe(false);
  });
});

describe("rechten", () => {
  it("25. read_only kan de classificatie zien maar niet wijzigen", () => {
    state.canClassify = false;
    state.rekeningen = [
      makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" }),
    ];
    renderGrootboek();
    // Zichtbaar in het overzicht…
    expect(screen.getByTestId("classificatie-badge-gb-1")).toHaveAttribute("data-classified", "true");
    // …en in het formulier, maar niet bewerkbaar.
    openEditDialog();
    const blok = screen.getByTestId("rapportageclassificatie");
    expect(blok).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /rapport/i })).toBeDisabled();
    expect(screen.getByText(/bekijken maar niet wijzigen/i)).toBeInTheDocument();
  });

  it("25b. bij alleen-leesrechten gaan de classificatievelden niet mee in de payload", async () => {
    state.canClassify = false;
    state.rekeningen = [
      makeAccount({ id: "gb-1", statement_type: "balans", report_group: "vaste_activa" }),
    ];
    renderGrootboek();
    openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());

    const payload = updateMutateAsync.mock.calls[0][0];
    expect(payload).not.toHaveProperty("statement_type");
    expect(payload).not.toHaveProperty("report_group");
    expect(payload).not.toHaveProperty("normal_side");
    expect(payload).not.toHaveProperty("report_sort");
  });

  it("25c. een onbekend recht telt als niet toegestaan", () => {
    state.canClassify = undefined;
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    renderGrootboek();
    openEditDialog();
    expect(screen.getByTestId("rapportageclassificatie")).toBeDisabled();
  });

  it("26. een accountant kan de classificatie wel bewerken", () => {
    state.canClassify = true;
    state.rekeningen = [makeAccount({ id: "gb-1" })];
    renderGrootboek();
    openEditDialog();
    expect(screen.getByTestId("rapportageclassificatie")).not.toBeDisabled();
    expect(screen.getByRole("combobox", { name: /rapport/i })).not.toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("statische grenzen", () => {
  const hooks = readFileSync("src/hooks/useGrootboekrekeningen.ts", "utf8");
  const page = readFileSync("src/pages/Grootboek.tsx", "utf8");
  const lib = readFileSync("src/lib/reporting-classification.ts", "utf8");

  /**
   * Commentaar weggestript: een bewering over de CODE mag nooit slagen of
   * falen op proza. (De pagina benoemt in een bestaande comment bijvoorbeeld
   * `ledger_postings`, en deze module legt in haar kop juist uit dat ze niets
   * uit nummer of categorie afleidt.)
   */
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  const pageCode = stripComments(page);
  const libCode = stripComments(lib);

  it("27. de bestaande query-invalidatie is ongewijzigd: elke mutatie invalideert grootboekrekeningen", () => {
    const invalidaties = hooks.match(/invalidateQueries\(\{ queryKey: \["grootboekrekeningen"\] \}\)/g) ?? [];
    // seed, add, update en delete — alle vier zoals ze waren.
    expect(invalidaties).toHaveLength(4);
    expect(hooks).not.toMatch(/queryClient\.setQueryData|refetchQueries|removeQueries/);
  });

  it("26b. het recht komt uit de bestaande rollenladder in de database, niet uit een nieuw model", () => {
    expect(hooks).toContain('supabase.rpc("has_min_role"');
    expect(hooks).toContain('_min: "accountant"');
    // Geen client-side rangorde of eigen rollenlijst.
    expect(hooks).not.toMatch(/role_rank|ROLE_ORDER|\brolesAbove\b/);
  });

  it("de datalaag blijft één laag: geen tweede API naast de bestaande hooks", () => {
    expect(page).not.toMatch(/from\(["']grootboekrekeningen["']\)/);
    expect(page).not.toMatch(/supabase\./);
    expect(lib).not.toMatch(/supabase|useQuery|useMutation|from\(/);
  });

  it("19/20. er wordt nergens geclassificeerd op nummer, categorie of omschrijving", () => {
    // De pure module kent `categorie` niet eens: in de code komt het woord niet
    // voor, dus er kan niets uit worden afgeleid.
    expect(libCode).not.toMatch(/categorie|omschrijving/);
    // `nummer` evenmin — geen enkel rekeningbereik.
    expect(libCode).not.toMatch(/\bnummer\b/);
    // En de pagina leidt geen classificatie af uit een bereik of uit categorie.
    expect(pageCode).not.toMatch(/nummer\s*[<>]=?[^;]*\b(statement_type|report_group|statementType|reportGroup)\b/);
    expect(pageCode).not.toMatch(/\bcategorie\b[^;\n]*\b(statementType|reportGroup)\b/);
    expect(pageCode).not.toMatch(/autoClassify|guessClassification|suggestGroup|inferStatement/i);
  });

  it("15. categorie blijft ongemoeid: dezelfde vijf waarden, geen classificatie die haar aanpast", () => {
    expect(page).toContain('const CATEGORIEEN = ["activa", "passiva", "omzet", "kosten", "privé"]');
    // Nergens wordt categorie gezet op grond van een classificatieveld.
    expect(page).not.toMatch(/categorie:\s*(form\.statementType|form\.reportGroup|statement_type|report_group)/);
  });

  it("32/33. geen rapportage-engine en geen rekenwerk in deze laag", () => {
    for (const bron of [libCode, pageCode]) {
      expect(bron).not.toMatch(/ledger_postings|buildAccountReport|buildTrialBalance|openingCents|closingCents/);
      expect(bron).not.toMatch(/debitCents|creditCents|toCents/);
    }
  });
});

describe("branch-scope", () => {
  /** null wanneer origin/main niet beschikbaar is: dan overslaan, niet vals slagen. */
  function changedFiles(): string[] | null {
    try {
      return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  const changed = changedFiles();
  const branchIt = changed === null ? it.skip : it;

  branchIt("29. geen migratie en geen SQL in deze branch", () => {
    expect(changed!.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed!.filter((f) => f.endsWith(".sql"))).toEqual([]);
  });

  branchIt("30. de gegenereerde types zijn ongewijzigd", () => {
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  branchIt("31. geen afhankelijkheidswijziging", () => {
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  branchIt("33. de rapportagekern en de boekers zijn niet aangeraakt", () => {
    for (const f of [
      "src/lib/ledger-reporting.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/ledger-completeness.ts",
      "src/lib/grootboek-saldi-utils.ts",
      "src/hooks/useLedgerPostings.ts",
      "src/components/layout/nav.ts",
    ]) {
      expect(changed, f).not.toContain(f);
    }
  });

  it("55b. de gegenereerde types worden uitsluitend als typen geïmporteerd", () => {
    for (const bron of [hooksSource, pageSource]) {
      for (const line of bron.split("\n").filter((l) => /integrations\/supabase\/types/.test(l))) {
        expect(line).toMatch(/^import type /);
      }
    }
  });
});

const hooksSource = readFileSync("src/hooks/useGrootboekrekeningen.ts", "utf8");
const pageSource = readFileSync("src/pages/Grootboek.tsx", "utf8");
