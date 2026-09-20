import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bank inhaalslag — het scherm.
 *
 * De datalaag is gemockt; wat hier wordt vastgelegd is wat de accountant ziet
 * en wat er gebeurt als hij op de bulkknop drukt. De kern van deze PR is een
 * grens, geen berekening: de pagina mag de servertoestanden tonen en id's
 * doorgeven, en verder niets. Die grens wordt zowel op gedrag als op de tekst
 * van de bestanden getoetst.
 */

const state = {
  clientId: "client-1" as string,
  data: undefined as unknown,
  isPending: false,
  isError: false,
  error: null as Error | null,
  post: vi.fn(),
  postPending: false,
  refetch: vi.fn(),
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
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({
    data: [{ id: "acc-1", nummer: 4400, omschrijving: "Kantoorkosten" }],
  }),
}));
vi.mock("@/hooks/useBankBulkPosting", () => ({
  useBankBulkCandidates: () => ({
    data: state.data,
    isPending: state.isPending,
    isError: state.isError,
    error: state.error,
    refetch: state.refetch,
  }),
  usePostBankTransactionsBulk: () => ({ mutateAsync: state.post, isPending: state.postPending }),
}));

import BankInhaalslag, {
  INHAALSLAG_DEPLOY_MESSAGE,
  INHAALSLAG_EMPTY_MESSAGE,
} from "@/pages/BankInhaalslag";
import {
  BankBulkPartialError,
  chunkTransactionIds,
  partialErrorForChunk,
  reconcileSelection,
  submittableIds,
  type BankBulkCandidate,
  type BankBulkResult,
} from "@/lib/bank-bulk-posting";

const rij = (over: Partial<BankBulkCandidate>): BankBulkCandidate => ({
  transaction_id: "tx-0000-0000",
  transaction_date: "2027-03-01",
  amount: -121,
  description: "Bankregel",
  counter_account: "NL00BANK0123456789",
  match_status: "handmatig_geboekt",
  grootboekrekening_id: "acc-1",
  btw_percentage: 21,
  is_posted: false,
  is_allocated: false,
  posting_group_id: null,
  workflow_state: "ready",
  reason: null,
  ...over,
});

const REGELS: BankBulkCandidate[] = [
  rij({ transaction_id: "tx-ready-1", description: "Kantoorartikelen" }),
  rij({ transaction_id: "tx-ready-2", amount: -55, btw_percentage: null }),
  rij({
    transaction_id: "tx-review",
    workflow_state: "review_needed",
    grootboekrekening_id: null,
    reason: "Deze banktransactie heeft nog geen grootboekrekening.",
  }),
  rij({
    transaction_id: "tx-blocked",
    workflow_state: "blocked",
    is_allocated: true,
    reason: "Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering.",
  }),
  rij({
    transaction_id: "tx-posted",
    workflow_state: "posted",
    is_posted: true,
    posting_group_id: "pg-1",
  }),
];

const resultaat = (over: Partial<BankBulkResult>): BankBulkResult => ({
  ordinal: 1,
  transaction_id: "tx-ready-1",
  outcome: "posted",
  posting_group_id: "pg-9",
  error_code: null,
  message: null,
  ...over,
});

const renderPagina = () => render(<MemoryRouter><BankInhaalslag /></MemoryRouter>);

/** De rij in de tabel die bij deze transactie hoort. */
const rowOf = (id: string) =>
  screen.getAllByTestId("inhaalslag-row").find((r) => r.getAttribute("data-transaction-id") === id)!;

const selecteer = (id: string) =>
  fireEvent.click(within(rowOf(id)).getByTestId("inhaalslag-checkbox"));

beforeEach(() => {
  state.clientId = "client-1";
  state.isPending = false;
  state.isError = false;
  state.error = null;
  state.postPending = false;
  state.data = REGELS;
  state.post = vi.fn().mockResolvedValue([resultaat({})]);
  state.refetch = vi.fn().mockResolvedValue({ data: REGELS });
});

describe("selectie", () => {
  it("1. een gereed-regel kan worden geselecteerd", () => {
    renderPagina();
    selecteer("tx-ready-1");
    expect(screen.getByTestId("bulkbalk-geselecteerd")).toHaveTextContent("1");
    expect(screen.getByTestId("bulkbalk-gereed")).toHaveTextContent("1");
    expect(screen.getByTestId("inhaalslag-bulk")).toHaveTextContent("1 bankregels boeken");
  });

  it("2. een geblokkeerde regel kan niet worden aangevinkt en gaat dus nooit mee", () => {
    renderPagina();
    const vinkje = within(rowOf("tx-blocked")).getByTestId("inhaalslag-checkbox");
    expect(vinkje).toBeDisabled();
    // En zelfs als zo'n id op een andere manier in de selectie zou belanden,
    // is de laatste zeef vóór de RPC eenduidig.
    expect(submittableIds(REGELS, ["tx-blocked", "tx-ready-1"])).toEqual(["tx-ready-1"]);
  });

  it("3. een al geboekte regel evenmin", () => {
    renderPagina();
    expect(within(rowOf("tx-posted")).getByTestId("inhaalslag-checkbox")).toBeDisabled();
    expect(submittableIds(REGELS, ["tx-posted"])).toEqual([]);
  });

  it("3b. en een regel die controle nodig heeft ook niet — die blijft wel inspecteerbaar", () => {
    renderPagina();
    expect(within(rowOf("tx-review")).getByTestId("inhaalslag-checkbox")).toBeDisabled();
    expect(within(rowOf("tx-review")).getByTestId("inhaalslag-detail")).toBeEnabled();
    expect(submittableIds(REGELS, ["tx-review"])).toEqual([]);
  });

  it("3c. 'zichtbare gereed selecteren' pakt uitsluitend de gereed-regels", () => {
    renderPagina();
    fireEvent.click(screen.getByTestId("inhaalslag-selecteer-zichtbaar"));
    expect(screen.getByTestId("bulkbalk-geselecteerd")).toHaveTextContent("2");
    expect(screen.getByTestId("bulkbalk-gereed")).toHaveTextContent("2");
  });

  it("3d. de selectie kan in één keer worden gewist", () => {
    renderPagina();
    selecteer("tx-ready-1");
    fireEvent.click(screen.getByTestId("inhaalslag-selectie-wissen"));
    expect(screen.queryByTestId("inhaalslag-bulkbalk")).not.toBeInTheDocument();
  });
});

describe("de servertoestand is leidend", () => {
  it("4. badges en tellingen volgen workflow_state, zonder tweede statussysteem", () => {
    renderPagina();
    expect(within(rowOf("tx-ready-1")).getByTestId("inhaalslag-state")).toHaveTextContent("Gereed");
    expect(within(rowOf("tx-review")).getByTestId("inhaalslag-state")).toHaveTextContent("Controle nodig");
    expect(within(rowOf("tx-blocked")).getByTestId("inhaalslag-state")).toHaveTextContent("Geblokkeerd");
    expect(within(rowOf("tx-posted")).getByTestId("inhaalslag-state")).toHaveTextContent("Geboekt");

    expect(screen.getByTestId("inhaalslag-totaal")).toHaveTextContent("5");
    expect(screen.getByTestId("inhaalslag-gereed")).toHaveTextContent("2");
    expect(screen.getByTestId("inhaalslag-controle")).toHaveTextContent("1");
    expect(screen.getByTestId("inhaalslag-geblokkeerd")).toHaveTextContent("1");
    expect(screen.getByTestId("inhaalslag-geboekt")).toHaveTextContent("1");
  });

  it("4b. de toestand staat niet alleen in een kleur maar ook in tekst en in een data-attribuut", () => {
    renderPagina();
    expect(rowOf("tx-blocked")).toHaveAttribute("data-state-label", "blocked");
    expect(within(rowOf("tx-blocked")).getByTestId("inhaalslag-state").textContent?.trim()).not.toBe("");
  });
});

describe("de grens met de boekhouding", () => {
  const pagina = readFileSync(resolve(process.cwd(), "src/pages/BankInhaalslag.tsx"), "utf8");
  const sheet = readFileSync(
    resolve(process.cwd(), "src/components/bank/BankBulkCandidateSheet.tsx"), "utf8",
  );
  const hook = readFileSync(resolve(process.cwd(), "src/hooks/useBankBulkPosting.ts"), "utf8");
  const bestanden = { pagina, sheet, hook };

  it("5. nergens een BTW-berekening", () => {
    for (const [naam, tekst] of Object.entries(bestanden)) {
      expect(tekst, naam).not.toMatch(/\/\s*\(\s*1\s*\+/);
      expect(tekst, naam).not.toMatch(/btw_amount|net_amount|gross_amount/);
      expect(tekst, naam).not.toMatch(/btw_vrijgesteld/);
      // Het percentage mag worden GETOOND, maar nooit ergens mee vermenigvuldigd.
      expect(tekst, naam).not.toMatch(/btw_percentage\s*[*/]/);
    }
  });

  it("6. nergens debet-/creditlogica", () => {
    for (const [naam, tekst] of Object.entries(bestanden)) {
      // De woorden mogen in uitleg voor de gebruiker staan; een debet- of
      // creditVELD aanraken of toekennen mag nooit.
      expect(tekst, naam).not.toMatch(/debit_amount|credit_amount/);
      expect(tekst, naam).not.toMatch(/\b(debit|credit)\s*[:=]/i);
      expect(tekst, naam).not.toMatch(/posting_account_ok|afgesloten_boekjaar/);
    }
  });

  it("7. geen enkel schrijfpad naar het grootboek", () => {
    for (const [naam, tekst] of Object.entries(bestanden)) {
      expect(tekst, naam).not.toMatch(/from\(["']ledger_postings["']\)/);
      expect(tekst, naam).not.toMatch(/insert\(|upsert\(|\.delete\(/);
    }
  });

  it("8. en geen schrijfpad naar de markertabel", () => {
    for (const [naam, tekst] of Object.entries(bestanden)) {
      expect(tekst, naam).not.toMatch(/from\(["']bank_transaction_postings["']\)/);
    }
  });

  it("8b. de enkelvoudige schrijver wordt niet vanuit React aangeroepen", () => {
    for (const [naam, tekst] of Object.entries(bestanden)) {
      expect(tekst, naam).not.toMatch(/rpc\(["']post_bank_transaction["']/);
    }
    // En de pagina praat überhaupt niet rechtstreeks met de databaseclient.
    expect(pagina).not.toMatch(/from ["']@\/integrations\/supabase\/client["']/);
    expect(sheet).not.toMatch(/from ["']@\/integrations\/supabase\/client["']/);
  });

  it("8c. het auditpaneel toont geen berekende tegenboeking", () => {
    renderPagina();
    fireEvent.click(within(rowOf("tx-ready-1")).getByTestId("inhaalslag-detail"));
    expect(screen.getByTestId("bulk-sheet-bedrag")).toBeInTheDocument();
    expect(screen.getByTestId("bulk-sheet-btw")).toHaveTextContent("21%");
    expect(screen.getByTestId("bulk-sheet-rekening")).toHaveTextContent("4400 · Kantoorkosten");
    // Geen regeltabel: er wordt geen enkele (voorbeeld)boekingsregel getoond.
    expect(within(screen.getByRole("dialog")).queryByRole("table")).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByText(/^Voorbeeld$/)).not.toBeInTheDocument();
  });
});

describe("bevestiging en aanroep", () => {
  it("9. de dialoog noemt het werkelijke aantal", async () => {
    renderPagina();
    selecteer("tx-ready-1");
    selecteer("tx-ready-2");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => expect(screen.getByTestId("inhaalslag-dialog-titel")).toBeInTheDocument());
    expect(screen.getByTestId("inhaalslag-dialog-titel")).toHaveTextContent("2 bankregels boeken?");
    expect(screen.getByTestId("inhaalslag-dialog-tekst")).toHaveTextContent("worden er 2");
    expect(screen.getByTestId("inhaalslag-dialog-tekst")).toHaveTextContent(
      /opnieuw door de database gevalideerd/i,
    );
    expect(screen.getByTestId("inhaalslag-dialog-tekst")).toHaveTextContent(/blijven ongeboekt/i);
    expect(screen.getByTestId("inhaalslag-dialog-tekst")).toHaveTextContent(/nooit een tweede keer/i);
    expect(screen.getByText("Annuleren")).toBeInTheDocument();
  });

  it("9b. zonder bevestiging wordt er niets geboekt", () => {
    renderPagina();
    selecteer("tx-ready-1");
    expect(state.post).not.toHaveBeenCalled();
  });

  it("10. de RPC krijgt uitsluitend transactie-id's", async () => {
    renderPagina();
    selecteer("tx-ready-1");
    selecteer("tx-ready-2");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => screen.getByTestId("inhaalslag-bevestig"));
    fireEvent.click(screen.getByTestId("inhaalslag-bevestig"));
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    expect(state.post).toHaveBeenCalledWith({ transactionIds: ["tx-ready-1", "tx-ready-2"] });
  });
});

describe("resultaat", () => {
  async function boek(resultaten: BankBulkResult[]) {
    state.post = vi.fn().mockResolvedValue(resultaten);
    renderPagina();
    selecteer("tx-ready-1");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => screen.getByTestId("inhaalslag-bevestig"));
    fireEvent.click(screen.getByTestId("inhaalslag-bevestig"));
    await waitFor(() => expect(screen.getByTestId("inhaalslag-resultaat")).toBeInTheDocument());
  }

  it("11. geboekt, al geboekt en geweigerd staan apart", async () => {
    await boek([
      resultaat({ transaction_id: "a", outcome: "posted" }),
      resultaat({ transaction_id: "b", outcome: "already_posted", ordinal: 2 }),
      resultaat({
        transaction_id: "c", outcome: "rejected", ordinal: 3, posting_group_id: null,
        error_code: "22023", message: "Boekjaar 2027 is afgesloten voor deze administratie",
      }),
    ]);
    expect(screen.getByTestId("resultaat-geboekt")).toHaveTextContent("1");
    expect(screen.getByTestId("resultaat-al-geboekt")).toHaveTextContent("1");
    expect(screen.getByTestId("resultaat-geweigerd")).toHaveTextContent("1");
  });

  it("12. een geweigerde regel toont de melding van de server zelf", async () => {
    await boek([
      resultaat({ transaction_id: "a", outcome: "posted" }),
      resultaat({
        transaction_id: "c", outcome: "rejected", ordinal: 2, posting_group_id: null,
        error_code: "22023", message: "Deze banktransactie heeft nog geen grootboekrekening",
      }),
    ]);
    expect(screen.getByText(/Deze banktransactie heeft nog geen grootboekrekening/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("inhaalslag-toon-geweigerd"));
    const regels = screen.getAllByTestId("inhaalslag-resultaatregel");
    expect(regels).toHaveLength(1);
    expect(regels[0]).toHaveAttribute("data-outcome", "rejected");
  });

  it("13. de selectie wordt na afloop naast de verse servergegevens gelegd", async () => {
    // De server geeft de regel daarna als `posted` terug; die is niet langer
    // selecteerbaar en verdwijnt dus uit de selectie.
    const na = REGELS.map((r) =>
      r.transaction_id === "tx-ready-1"
        ? { ...r, workflow_state: "posted" as const, is_posted: true, posting_group_id: "pg-9" }
        : r,
    );
    state.refetch = vi.fn().mockResolvedValue({ data: na });
    await boek([resultaat({ transaction_id: "tx-ready-1", outcome: "posted" })]);
    await waitFor(() => expect(state.refetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("inhaalslag-bulkbalk")).not.toBeInTheDocument());
    // en de pure regel erachter
    expect(reconcileSelection(["tx-ready-1"], na)).toEqual([]);
  });

  it("13b. een afgebroken reeks partijen meldt wat wél is verwerkt, zonder herkansing", async () => {
    state.post = vi.fn().mockRejectedValue(
      new BankBulkPartialError("Boeken is niet gelukt. Probeer het opnieuw.",
        [resultaat({ transaction_id: "a", outcome: "posted" })], 500, 200),
    );
    renderPagina();
    selecteer("tx-ready-1");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => screen.getByTestId("inhaalslag-bevestig"));
    fireEvent.click(screen.getByTestId("inhaalslag-bevestig"));

    await waitFor(() => expect(screen.getByTestId("inhaalslag-afgebroken")).toBeInTheDocument());
    expect(screen.getByTestId("resultaat-geboekt")).toHaveTextContent("1");
    expect(state.post).toHaveBeenCalledTimes(1);
  });
});

/**
 * Een verzoek dat de deur uit is, is niet hetzelfde als een verzoek dat nooit
 * is gedaan. Breekt een partij af nadat zij is verstuurd, dan kan de database
 * haar hebben verwerkt en het antwoord onderweg verloren zijn gegaan. De
 * uitkomst is dan ONBEKEND — en het scherm mag noch "wel geboekt" noch "niet
 * aangeboden" beweren.
 */
describe("de drie groepen bij een afgebroken partijreeks", () => {
  const eersteVijfhonderd = [
    resultaat({ transaction_id: "a", outcome: "posted" }),
    resultaat({ transaction_id: "b", outcome: "already_posted", ordinal: 2 }),
  ];

  /** 500 geslaagd · 500 waarvan het verzoek faalde · 200 nooit verstuurd. */
  const drieLuik = () =>
    new BankBulkPartialError(
      "Boeken is niet gelukt. Probeer het opnieuw.", eersteVijfhonderd, 500, 200,
    );

  async function boekMetFout(fout: unknown) {
    state.post = vi.fn().mockRejectedValue(fout);
    renderPagina();
    selecteer("tx-ready-1");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => screen.getByTestId("inhaalslag-bevestig"));
    fireEvent.click(screen.getByTestId("inhaalslag-bevestig"));
    await waitFor(() => expect(screen.getByTestId("inhaalslag-afgebroken")).toBeInTheDocument());
  }

  it("19. de fout draagt de drie groepen los van elkaar", () => {
    const fout = drieLuik();
    expect(fout.results).toHaveLength(2);
    expect(fout.outcomeUnknown).toBe(500);
    expect(fout.notSubmitted).toBe(200);
  });

  it("20. de mislukte partij telt als onbekend, niet als niet-aangeboden", async () => {
    await boekMetFout(drieLuik());
    expect(screen.getByTestId("afgebroken-onbekend")).toHaveTextContent(
      "De uitkomst van 500 bankregel(s) kon niet worden bevestigd",
    );
  });

  it("21. alleen de latere partijen heten niet-aangeboden", async () => {
    await boekMetFout(drieLuik());
    expect(screen.getByTestId("afgebroken-niet-aangeboden")).toHaveTextContent(
      "200 bankregel(s) zijn daarna niet meer aangeboden",
    );
  });

  it("22. het aantal van de mislukte partij wordt nergens 'niet aangeboden' genoemd", async () => {
    await boekMetFout(drieLuik());
    const melding = screen.getByTestId("inhaalslag-afgebroken").textContent ?? "";
    expect(melding).not.toMatch(/500 bankregel\(s\) zijn daarna niet meer aangeboden/);
    expect(melding).not.toMatch(/700/); // 500 + 200 op één hoop: precies de oude fout
    // En er wordt geen uitkomst aan toegedicht.
    expect(melding).not.toMatch(/500 bankregel\(s\) (zijn|is) (wel )?geboekt/);
  });

  it("23. de bevestigde uitkomsten van de eerdere partij blijven zichtbaar", async () => {
    await boekMetFout(drieLuik());
    expect(screen.getByTestId("inhaalslag-resultaat")).toBeInTheDocument();
    expect(screen.getByTestId("resultaat-geboekt")).toHaveTextContent("1");
    expect(screen.getByTestId("resultaat-al-geboekt")).toHaveTextContent("1");
    expect(screen.getByTestId("resultaat-geweigerd")).toHaveTextContent("0");
  });

  it("24. er wordt niets automatisch opnieuw geprobeerd, en het scherm zegt dat", async () => {
    await boekMetFout(drieLuik());
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inhaalslag-afgebroken")).toHaveTextContent(
      /niets automatisch opnieuw geprobeerd/,
    );
    expect(screen.getByTestId("inhaalslag-afgebroken")).toHaveTextContent(/ververs eerst de actuele status/i);
  });

  it("25. na de fout wordt opnieuw opgehaald en de selectie verzoend", async () => {
    const na = REGELS.map((r) =>
      r.transaction_id === "tx-ready-1"
        ? { ...r, workflow_state: "posted" as const, is_posted: true, posting_group_id: "pg-9" }
        : r,
    );
    state.refetch = vi.fn().mockResolvedValue({ data: na });
    await boekMetFout(drieLuik());
    await waitFor(() => expect(state.refetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("inhaalslag-bulkbalk")).not.toBeInTheDocument());
  });

  it("26. een fout die de drie groepen niet kent, telt als onbekend en niet als niet-aangeboden", async () => {
    await boekMetFout(new Error("Netwerkfout"));
    expect(screen.getByTestId("afgebroken-onbekend")).toHaveTextContent("1 bankregel(s)");
    expect(screen.queryByTestId("afgebroken-niet-aangeboden")).not.toBeInTheDocument();
  });

  it("27. de indeling zelf: 500 geslaagd, 500 verstuurd-maar-onbekend, 200 nooit verstuurd", () => {
    // Precies het voorbeeld uit de melding, op de ECHTE functie die de hook
    // aanroept — niet op een nagebouwd dubbel.
    const chunks = chunkTransactionIds(Array.from({ length: 1200 }, (_, i) => `id-${i}`));
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);

    const fout = partialErrorForChunk(chunks, 1, eersteVijfhonderd, "Verbinding verbroken");
    expect(fout.results).toBe(eersteVijfhonderd);
    expect(fout.outcomeUnknown).toBe(500);
    expect(fout.notSubmitted).toBe(200);
  });

  it("27b. faalt de laatste partij, dan is er niets meer dat niet is aangeboden", () => {
    const chunks = chunkTransactionIds(Array.from({ length: 1200 }, (_, i) => `id-${i}`));
    const fout = partialErrorForChunk(chunks, 2, [], "x");
    expect(fout.outcomeUnknown).toBe(200);
    expect(fout.notSubmitted).toBe(0);
  });

  it("27c. faalt de eerste partij, dan staat er niets vast en is de rest niet aangeboden", () => {
    const chunks = chunkTransactionIds(Array.from({ length: 1200 }, (_, i) => `id-${i}`));
    const fout = partialErrorForChunk(chunks, 0, [], "x");
    expect(fout.results).toEqual([]);
    expect(fout.outcomeUnknown).toBe(500);
    expect(fout.notSubmitted).toBe(700);
  });

  it("27d. de mislukte partij wordt nooit bij de niet-aangeboden geteld", () => {
    const chunks = chunkTransactionIds(Array.from({ length: 1200 }, (_, i) => `id-${i}`));
    for (const index of [0, 1, 2]) {
      const fout = partialErrorForChunk(chunks, index, [], "x");
      const nietAangebodenInclusief = chunks
        .slice(index)
        .reduce((som, c) => som + c.length, 0);
      // De oude, foute som telde de mislukte partij mee; die mag nooit
      // terugkomen als `notSubmitted`.
      expect(fout.notSubmitted).not.toBe(nietAangebodenInclusief);
      expect(fout.notSubmitted + fout.outcomeUnknown).toBe(nietAangebodenInclusief);
    }
  });
});

describe("de hook gebruikt die indeling ook echt", () => {
  it("28. de hook rekent de groepen niet zelf uit maar roept de pure indeling aan", () => {
    const hook = readFileSync(resolve(process.cwd(), "src/hooks/useBankBulkPosting.ts"), "utf8");
    expect(hook).toContain("partialErrorForChunk(chunks, index, results, bulkErrorMessage(error))");
    // Geen eigen som meer in de hook, en zeker niet de oude die de verstuurde
    // partij als niet-aangeboden telde.
    expect(hook).not.toMatch(/chunks\s*\.?\s*slice\(index\)/);
    expect(hook).not.toMatch(/new BankBulkPartialError\(/);
  });
});

describe("laden, leeg, deploy-venster en fout", () => {
  it("14. candidates === null is het deploy-venster, niet 'geen bankregels'", () => {
    state.data = null;
    renderPagina();
    expect(screen.getByTestId("inhaalslag-deploy")).toHaveTextContent(INHAALSLAG_DEPLOY_MESSAGE);
    expect(screen.queryByText(INHAALSLAG_EMPTY_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByTestId("inhaalslag-row")).not.toBeInTheDocument();
  });

  it("15. een lege lijst is iets anders dan een fout", () => {
    state.data = [];
    renderPagina();
    expect(screen.getByText(INHAALSLAG_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId("inhaalslag-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inhaalslag-deploy")).not.toBeInTheDocument();
  });

  it("15b. een fout toont een veilige melding, geen ruwe driverfout", () => {
    state.isError = true;
    state.error = new Error("Bulkboeken is nog niet beschikbaar voor deze omgeving.");
    renderPagina();
    const alert = screen.getByTestId("inhaalslag-error");
    expect(alert).toHaveTextContent("Bulkboeken is nog niet beschikbaar");
    expect(alert.textContent).not.toMatch(/at \w+ \(|PGRST|stack/);
  });

  it("15c. tijdens het laden staat er een skeleton en geen lege tabel", () => {
    state.isPending = true;
    renderPagina();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("inhaalslag-row")).not.toBeInTheDocument();
  });

  it("15d. zonder specifieke administratie wordt er niets getoond en niets geladen", () => {
    state.clientId = "all";
    renderPagina();
    expect(screen.getByText(/Kies eerst een specifieke administratie/)).toBeInTheDocument();
    expect(screen.queryByTestId("inhaalslag-row")).not.toBeInTheDocument();
  });
});

describe("filters", () => {
  it("15e. zoeken beperkt de zichtbare regels zonder de tellingen te herrekenen", () => {
    renderPagina();
    fireEvent.change(screen.getByTestId("inhaalslag-zoek"), { target: { value: "Kantoorartikelen" } });
    expect(screen.getAllByTestId("inhaalslag-row")).toHaveLength(1);
    // De samenvatting blijft de volledige administratie beschrijven.
    expect(screen.getByTestId("inhaalslag-totaal")).toHaveTextContent("5");
  });

  it("15f. 'alleen afwijkingen' toont uitsluitend controle nodig en geblokkeerd", () => {
    renderPagina();
    fireEvent.click(screen.getByText("Alleen afwijkingen"));
    const toestanden = screen.getAllByTestId("inhaalslag-row").map((r) => r.getAttribute("data-state-label"));
    expect(toestanden.sort()).toEqual(["blocked", "review_needed"]);
  });
});

describe("toegankelijkheid en bereikbaarheid", () => {
  it("16. de bulkactie blijft op elk formaat bereikbaar en raakbaar", () => {
    renderPagina();
    selecteer("tx-ready-1");
    const balk = screen.getByTestId("inhaalslag-bulkbalk");
    // Vastgezet onderaan het scherm, dus ook op een telefoon in beeld.
    expect(balk.className).toContain("fixed");
    expect(balk).toHaveAttribute("role", "region");
    expect(screen.getByTestId("inhaalslag-bulk").className).toContain("h-11");
  });

  it("16b. elk selectievakje heeft een eigen leesbaar label", () => {
    renderPagina();
    expect(within(rowOf("tx-ready-1")).getByTestId("inhaalslag-checkbox"))
      .toHaveAttribute("aria-label", expect.stringContaining("selecteren"));
  });

  it("16c. de bevestiging heeft een titel én een omschrijving", async () => {
    renderPagina();
    selecteer("tx-ready-1");
    fireEvent.click(screen.getByTestId("inhaalslag-bulk"));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByTestId("inhaalslag-dialog-titel")).toBeInTheDocument();
    expect(within(dialog).getByTestId("inhaalslag-dialog-tekst")).toBeInTheDocument();
  });

  it("16d. de kolommen die er op een klein scherm toe doen blijven staan", () => {
    const pagina = readFileSync(resolve(process.cwd(), "src/pages/BankInhaalslag.tsx"), "utf8");
    // Grootboekrekening en BTW wijken bij smalle schermen naar het paneel;
    // datum, bedrag en status doen dat nooit.
    expect(pagina).toMatch(/hidden[^"]*md:table-cell[^"]*">Grootboekrekening/);
    expect(pagina).toMatch(/hidden[^"]*lg:table-cell[^"]*">BTW/);
    expect(pagina).not.toMatch(/hidden[^"]*table-cell[^"]*">(Datum|Bedrag|Status)/);
  });
});

describe("de grenzen van deze branch", () => {
  function changedFiles(): string[] | null {
    try {
      return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      return null;
    }
  }

  it("17. het bestaande bankscherm krijgt er één link bij en verandert verder niet", () => {
    const changed = changedFiles();
    if (!changed) return;
    if (!changed.includes("src/pages/Bank.tsx")) return;
    const diff = execFileSync("git", ["diff", "origin/main...HEAD", "--", "src/pages/Bank.tsx"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const toegevoegd = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const verwijderd = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    // Alleen de router-import en de knop; niets wordt weggehaald behalve die
    // ene importregel die wordt uitgebreid.
    expect(verwijderd).toHaveLength(1);
    expect(verwijderd[0]).toContain("react-router-dom");
    expect(toegevoegd.join("\n")).toContain("/bank/inhaalslag");
    expect(toegevoegd.join("\n")).not.toMatch(/ledger_postings|post_bank_transaction/);
  });

  it("17b. de nieuwe route hangt onder het bestaande Bank-item, zonder nieuw nav-item", () => {
    const changed = changedFiles();
    if (changed) expect(changed).not.toContain("src/components/layout/nav.ts");
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain('<Route path="/bank/inhaalslag" element={<BankInhaalslag />} />');
  });

  it("18. geen migratie, geen SQL en geen handmatige typewijziging", () => {
    const changed = changedFiles();
    if (!changed) return;
    expect(changed.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed.filter((f) => f.endsWith(".sql"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed).not.toContain("package-lock.json");
  });
});
