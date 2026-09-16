import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fase 6C-b6 (PR 2) — de memoriaalpagina (/grootboek/memoriaal).
 *
 * De hooks zijn gemockt: hier gaat het om de samenwerking van de pagina —
 * concept opslaan via precies één save-RPC, niet-opgeslagen wijzigingen die
 * boeken blokkeren, en een geboekte memoriaal die volledig alleen-lezen wordt.
 */

const state = {
  selectedClientId: "c-1",
  journals: [] as Array<Record<string, unknown>>,
  journal: null as Record<string, unknown> | null,
  lines: [] as Array<Record<string, unknown>>,
  marker: null as Record<string, unknown> | null,
  canPost: true as boolean | undefined,
};

const {
  createSpy, updateSpy, saveLinesSpy, deleteSpy, postSpy, toastSpy, setClientSpy,
} = vi.hoisted(() => ({
  createSpy: vi.fn(),
  updateSpy: vi.fn(),
  saveLinesSpy: vi.fn(),
  deleteSpy: vi.fn(),
  postSpy: vi.fn(),
  toastSpy: vi.fn(),
  setClientSpy: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({
    selectedClientId: state.selectedClientId,
    setSelectedClientId: setClientSpy,
  }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant Een", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({
    data: [
      { id: "gb-1", nummer: 4000, omschrijving: "Kosten" },
      { id: "gb-2", nummer: 1600, omschrijving: "Crediteuren" },
    ],
  }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({
    value, onValueChange, onIdChange,
  }: { value: string; onValueChange: (v: string) => void; onIdChange?: (id: string) => void }) => (
    <button
      type="button"
      role="combobox"
      onClick={() => {
        onValueChange("4000 - Kosten");
        onIdChange?.("gb-1");
      }}
    >
      {value || "Selecteer rekening..."}
    </button>
  ),
}));

vi.mock("@/hooks/useManualJournals", () => ({
  useManualJournals: () => ({
    data: state.journals.map((journal) => ({
      journal,
      marker: state.marker && state.marker.manual_journal_id === journal.id ? state.marker : null,
      lines: state.lines.filter((l) => l.manual_journal_id === journal.id),
      posted: !!(state.marker && state.marker.manual_journal_id === journal.id),
    })),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useManualJournal: () => ({ data: state.journal }),
  useManualJournalLines: () => ({ data: state.lines }),
  useCreateManualJournal: () => ({ mutateAsync: createSpy, isPending: false }),
  useUpdateManualJournal: () => ({ mutateAsync: updateSpy, isPending: false }),
  useSaveManualJournalLines: () => ({ mutateAsync: saveLinesSpy, isPending: false }),
  useDeleteManualJournal: () => ({ mutateAsync: deleteSpy, isPending: false }),
}));

vi.mock("@/hooks/useManualJournalPosting", () => ({
  useManualJournalPosting: () => ({
    data: state.marker,
    isPending: false,
    isError: false,
    refetch: async () => ({ data: state.marker }),
  }),
  useCanPostManualJournal: () => ({ data: state.canPost }),
  usePostManualJournal: () => ({ mutateAsync: postSpy, isPending: false }),
}));

import Memoriaal from "@/pages/Memoriaal";

const journalRow = (over: Record<string, unknown> = {}) => ({
  id: "mj-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  posting_date: "2027-03-31",
  description: "Afschrijving maart",
  reference: "MEM-1",
  created_at: "2027-03-31T00:00:00Z",
  updated_at: "2027-03-31T00:00:00Z",
  ...over,
});

const lineRow = (over: Record<string, unknown> = {}) => ({
  id: "l-1",
  manual_journal_id: "mj-1",
  organization_id: "org-1",
  user_id: "u-1",
  sort_order: 0,
  grootboekrekening_id: "gb-1",
  omschrijving: "Kosten",
  debit_amount: 100,
  credit_amount: 0,
  created_at: "2027-03-31T00:00:00Z",
  ...over,
});

const newButton = () => screen.getByTestId("memoriaal-new") as HTMLButtonElement;
const debit = (n: number) => screen.getByLabelText(`Debet regel ${n}`) as HTMLInputElement;
const credit = (n: number) => screen.getByLabelText(`Credit regel ${n}`) as HTMLInputElement;

beforeEach(() => {
  createSpy.mockReset().mockResolvedValue({ id: "mj-new" });
  updateSpy.mockReset().mockResolvedValue({ id: "mj-1" });
  saveLinesSpy.mockReset().mockResolvedValue("mj-1");
  deleteSpy.mockReset().mockResolvedValue("mj-1");
  postSpy.mockReset().mockResolvedValue("g-1");
  toastSpy.mockClear();
  state.selectedClientId = "c-1";
  state.journals = [];
  state.journal = null;
  state.lines = [];
  state.marker = null;
  state.canPost = true;
});

describe("Memoriaal — pagina", () => {
  it("1. zonder specifieke administratie: NoClientBanner en geen nieuwe boeking", () => {
    state.selectedClientId = "all";
    render(<Memoriaal />);
    expect(
      screen.getByText("Kies eerst een specifieke administratie om memoriaalboekingen te bekijken."),
    ).toBeInTheDocument();
    expect(newButton().disabled).toBe(true);
    expect(screen.queryByTestId("memoriaal-editor")).toBeNull();
  });

  it("2. een nieuw concept begint met twee lege regels", () => {
    render(<Memoriaal />);
    fireEvent.click(newButton());
    expect(screen.getAllByTestId("memoriaal-line-row")).toHaveLength(2);
    expect(debit(1).value).toBe("");
    expect(credit(2).value).toBe("");
  });

  it("3. concept opslaan: eerst de kop, dan precies één save-RPC voor de regels", async () => {
    render(<Memoriaal />);
    fireEvent.click(newButton());
    fireEvent.change(screen.getByLabelText("Omschrijving regel 1"), { target: { value: "Kosten" } });
    fireEvent.change(debit(1), { target: { value: "100,00" } });
    fireEvent.change(credit(2), { target: { value: "100,00" } });
    fireEvent.click(screen.getByRole("button", { name: /concept opslaan/i }));

    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(1));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(saveLinesSpy.mock.calls[0][0]).toEqual({
      journalId: "mj-new",
      lines: [
        { sort_order: 0, grootboekrekening_id: null, omschrijving: "Kosten", debit_amount: 100, credit_amount: 0 },
        { sort_order: 1, grootboekrekening_id: null, omschrijving: null, debit_amount: 0, credit_amount: 100 },
      ],
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Memoriaalboeking opgeslagen" }),
    );
  });

  it("4. een onopgeslagen concept blokkeert boeken", async () => {
    render(<Memoriaal />);
    fireEvent.click(newButton());
    await waitFor(() =>
      expect(screen.getByTestId("memoriaal-posting-hint")).toHaveTextContent(
        "Sla de memoriaalboeking eerst op.",
      ),
    );
    expect((screen.getByTestId("memoriaal-posting-button") as HTMLButtonElement).disabled).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("5. wijzigingen na het laden blokkeren boeken tot er opnieuw is opgeslagen", async () => {
    state.journals = [journalRow()];
    state.journal = journalRow();
    state.lines = [lineRow(), lineRow({ id: "l-2", sort_order: 1, grootboekrekening_id: "gb-2", debit_amount: 0, credit_amount: 100 })];
    render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /open memoriaalboeking/i }));

    await waitFor(() => expect(debit(1).value).toBe("100,00"));
    // Ongewijzigd geladen → boeken mag.
    await waitFor(() =>
      expect((screen.getByTestId("memoriaal-posting-button") as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.change(debit(1), { target: { value: "150,00" } });
    await waitFor(() =>
      expect(screen.getByTestId("memoriaal-posting-hint")).toHaveTextContent(
        "Er zijn niet-opgeslagen wijzigingen. Sla eerst op.",
      ),
    );
  });

  it("6. geboekt: alleen-lezen, vaste melding, geen opslaan en geen verwijderactie", async () => {
    state.journals = [journalRow()];
    state.journal = journalRow();
    state.lines = [lineRow()];
    state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 100, line_count: 2 };
    render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /open memoriaalboeking/i }));

    await waitFor(() =>
      expect(screen.getByTestId("memoriaal-posted-notice")).toHaveTextContent(
        "Deze memoriaalboeking is geboekt. Een correctie vereist een tegenboeking.",
      ),
    );
    expect((screen.getByLabelText("Omschrijving regel 1") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Boekingsdatum") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /concept opslaan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /regel toevoegen/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /verwijder memoriaalboeking/i })).toBeNull();
    expect(screen.getByTestId("memoriaal-posting-done")).toBeInTheDocument();
  });

  it("7. de lijst toont de afgeleide status en het juiste bedrag", () => {
    state.journals = [journalRow(), journalRow({ id: "mj-2", posting_date: "2027-02-28" })];
    state.lines = [lineRow({ manual_journal_id: "mj-2", debit_amount: 42 })];
    state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 121, line_count: 2 };
    render(<Memoriaal />);

    const rows = screen.getAllByTestId("memoriaal-list-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Geboekt");
    expect(rows[0]).toHaveTextContent("121,00");
    expect(rows[1]).toHaveTextContent("Concept");
    expect(rows[1]).toHaveTextContent("42,00");
    expect(rows[0]).toHaveTextContent("31-03-2027");
    expect(rows[0]).toHaveTextContent("MEM-1");
  });

  it("8. verwijderen vraagt eerst om bevestiging", async () => {
    state.journals = [journalRow()];
    render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /verwijder memoriaalboeking/i }));

    expect(await screen.findByText("Memoriaalboeking verwijderen?")).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("mj-1"));
  });

  it("9. sluiten met niet-opgeslagen wijzigingen vraagt om bevestiging", async () => {
    render(<Memoriaal />);
    fireEvent.click(newButton());
    fireEvent.change(debit(1), { target: { value: "10,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Sluiten" }));

    expect(await screen.findByText("Niet-opgeslagen wijzigingen")).toBeInTheDocument();
    expect(screen.getByTestId("memoriaal-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /wijzigingen weggooien/i }));
    await waitFor(() => expect(screen.queryByTestId("memoriaal-editor")).toBeNull());
  });

  it("9b. opslaan draait het formulier niet terug naar de nog niet ververste cache", async () => {
    // Regressie: het sync-effect mocht na een geslaagde opslag niet opnieuw
    // vuren op de oude gecachte rijen. Deed het dat wel, dan stond het scherm
    // op de oude waarden terwijl de toast "opgeslagen" meldde — én met een
    // ingeschakelde boekknop.
    state.journals = [journalRow()];
    state.journal = journalRow();
    state.lines = [
      lineRow(),
      lineRow({ id: "l-2", sort_order: 1, grootboekrekening_id: "gb-2", debit_amount: 0, credit_amount: 100 }),
    ];
    render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /open memoriaalboeking/i }));
    await waitFor(() => expect(debit(1).value).toBe("100,00"));

    fireEvent.change(debit(1), { target: { value: "150,00" } });
    fireEvent.change(credit(2), { target: { value: "150,00" } });
    fireEvent.click(screen.getByRole("button", { name: /concept opslaan/i }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Memoriaalboeking opgeslagen" }),
    );
    // De mock-cache is bewust NIET ververst: het scherm moet de opgeslagen
    // waarden houden, niet terugvallen op 100,00.
    expect(debit(1).value).toBe("150,00");
    expect(saveLinesSpy.mock.calls[0][0].lines[0].debit_amount).toBe(150);
  });

  it("9c. een lopende bewerking wordt niet overschreven door een achtergrondrefetch", async () => {
    state.journals = [journalRow()];
    state.journal = journalRow();
    state.lines = [lineRow()];
    const { rerender } = render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /open memoriaalboeking/i }));
    await waitFor(() => expect(debit(1).value).toBe("100,00"));

    fireEvent.change(debit(1), { target: { value: "250,00" } });
    // Elders gewijzigde rij komt binnen terwijl de gebruiker aan het typen is.
    state.journal = journalRow({ description: "Elders gewijzigd", updated_at: "2027-04-02T00:00:00Z" });
    state.lines = [lineRow({ debit_amount: 999 })];
    rerender(<Memoriaal />);

    expect(debit(1).value).toBe("250,00");
  });

  it("9d. een mislukte regelopslag maakt bij een nieuwe poging geen tweede kop aan", async () => {
    saveLinesSpy.mockRejectedValueOnce({
      code: "22023",
      message: "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde",
    });
    render(<Memoriaal />);
    fireEvent.click(newButton());
    fireEvent.change(debit(1), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: /concept opslaan/i }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Opslaan niet gelukt",
        description: "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde",
        variant: "destructive",
      }),
    );
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Corrigeren en opnieuw opslaan: de bestaande kop wordt bijgewerkt.
    fireEvent.change(debit(1), { target: { value: "5,00" } });
    fireEvent.click(screen.getByRole("button", { name: /concept opslaan/i }));
    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(2));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(saveLinesSpy.mock.calls[1][0].journalId).toBe("mj-new");
  });

  it("9e. een bedrag met drie decimalen gaat onafgerond naar de RPC", async () => {
    render(<Memoriaal />);
    fireEvent.click(newButton());
    fireEvent.change(debit(1), { target: { value: "0,005" } });
    // Klikken op een knop haalt in een browser de focus weg; blur mag het
    // bedrag niet stilletjes naar 0,01 afronden.
    fireEvent.blur(debit(1));
    fireEvent.click(screen.getByRole("button", { name: /concept opslaan/i }));

    await waitFor(() => expect(saveLinesSpy).toHaveBeenCalledTimes(1));
    expect(saveLinesSpy.mock.calls[0][0].lines[0].debit_amount).toBe(0.005);
  });

  it("10. de pagina boekt nooit uit zichzelf", async () => {
    state.journals = [journalRow()];
    state.journal = journalRow();
    state.lines = [lineRow(), lineRow({ id: "l-2", sort_order: 1, grootboekrekening_id: "gb-2", debit_amount: 0, credit_amount: 100 })];
    render(<Memoriaal />);
    fireEvent.click(screen.getByRole("button", { name: /open memoriaalboeking/i }));
    await waitFor(() => expect(debit(1).value).toBe("100,00"));
    expect(postSpy).not.toHaveBeenCalled();
    expect(saveLinesSpy).not.toHaveBeenCalled();
  });
});

describe("Memoriaal — geen regressie op de bestaande boekhouding", () => {
  const sources = [
    "src/pages/Memoriaal.tsx",
    "src/hooks/useManualJournals.ts",
    "src/hooks/useManualJournalPosting.ts",
    "src/lib/manual-journal-utils.ts",
    "src/components/memoriaal/MemoriaalLinesTable.tsx",
    "src/components/memoriaal/MemoriaalPostingAction.tsx",
  ].map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("11. raakt journal_entries / Boekingen / snelstart-export nergens aan", () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/journal_entries/);
      expect(text, path).not.toMatch(/useJournalEntries/);
      expect(text, path).not.toMatch(/snelstart-export/);
      expect(text, path).not.toMatch(/ledger-mutations/);
    }
  });

  it("12. schrijft nooit rechtstreeks in ledger_postings en leest geen statuskolom", () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/from\(["']ledger_postings["']\)/);
      // Er bestaat geen status-/geboekt-kolom op manual_journals: geen enkele
      // bron mag zo'n veld van een rij lezen of wegschrijven.
      expect(text, path).not.toMatch(/\.status\b/);
      expect(text, path).not.toMatch(/["']status["']\s*[:,)]/);
      expect(text, path).not.toMatch(/\bis_posted\b|\bgeboekt_op\b/);
    }
    // En "geboekt" wordt uitsluitend uit de claimtabel afgeleid.
    const hooks = sources.find((s) => s.path === "src/hooks/useManualJournals.ts")!.text;
    expect(hooks).toMatch(/posted:\s*!!marker/);
  });

  it("13. gebruikt de GrootboekCombobox ongewijzigd (geen postableOnly)", () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/postableOnly/);
    }
  });

  it("14. de route is genest onder /grootboek en er is geen nav-item bijgekomen", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toMatch(/path="\/grootboek\/memoriaal"/);
    expect(app).toMatch(/path="\/grootboek\/mutaties"/);
    expect(app).toMatch(/path="\/boekingen"/);
    const nav = readFileSync("src/components/layout/nav.ts", "utf8");
    expect(nav).not.toMatch(/memoriaal/i);
  });
});
