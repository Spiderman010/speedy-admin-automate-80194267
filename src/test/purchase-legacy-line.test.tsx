import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PR C — legacy-factuur zonder opgeslagen boekingsregels.
 *
 * Het productiegeval: een oude factuur toont "4602 - Telefoonkosten" in de
 * rekeningkiezer en de totalen sluiten, terwijl de boekbaarheid terecht zegt
 * dat er geen boekingsregels zijn. Oorzaak: de afgeleide regel zette de vrije
 * tekst `ledger_account_text` als WAARDE in de kiezer, terwijl
 * `grootboekrekening_id` null bleef.
 *
 * Wat hier wordt vastgelegd: die tekst is nooit een gekozen rekening, de
 * afgeleide regel is herkenbaar een concept, een suggestie moet worden
 * bevestigd, en na opslaan via het bestaande atomaire pad verdwijnt de
 * blokkade.
 */

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

const toastSpy = vi.fn();
const navigateSpy = vi.fn();
const atomicMutateAsync = vi.fn();
const invalidateSpy = vi.fn();

/** Legacy: kop compleet, GEEN opgeslagen regels, wel oude rekeningtekst. */
const legacyInvoice = {
  id: "inv-1",
  client_id: "client-1",
  supplier: "Simyo",
  invoice_number: "F-2026-010",
  invoice_date: "2026-07-20",
  amount_excl: 3.8,
  btw_amount: 0.8,
  amount_incl: 4.6,
  btw_percentage: 21,
  status: "gecontroleerd",
  ledger_account_id: null as string | null,
  ledger_account_text: "4602 - Telefoonkosten" as string | null,
  leverancier_id: null,
  notes: null,
  remaining_amount: 4.6,
  file_path: null as string | null,
  document_route: "manual",
  route_reason: null,
  original_ubl_path: null,
  supplier_btw_number: null,
  ocr_data: null,
  organization_id: "org-1",
  user_id: "user-1",
  snelstart_package_download_count: 0,
  snelstart_package_downloaded_at: null,
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
};

const volledigeClient = {
  id: "client-1", name: "Klant Een", btw_vrijgesteld: false,
  afgesloten_boekjaar: null as number | null,
  crediteuren_rekening_id: "cred-1", debiteuren_rekening_id: "deb-1",
  btw_te_vorderen_rekening_id: "btwv-1", btw_te_betalen_rekening_id: "btwb-1",
};

const TELEFOON = { id: "gb-4602", nummer: 4602, omschrijving: "Telefoonkosten", client_id: null as string | null };
const KANTOOR = { id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten", client_id: null as string | null };

const state = {
  invoice: { ...legacyInvoice } as typeof legacyInvoice | null,
  storedLines: [] as any[],
  ledgers: [TELEFOON, KANTOOR] as any[],
  clients: [{ ...volledigeClient }] as any[],
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useParams: () => ({ invoiceId: "inv-1" }), useNavigate: () => navigateSpy };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "purchase_invoices") throw new Error(`Unexpected table ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.invoice, error: null }) }) }) };
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: state.clients }) }));
vi.mock("@/hooks/useLeveranciers", () => ({ useLeveranciers: () => ({ data: [] }) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: state.ledgers }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [{ id: "inv-1", invoice_date: "2026-07-20" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: () => ({ data: state.storedLines, isLoading: false }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: atomicMutateAsync }),
}));
vi.mock("@/hooks/usePurchaseInvoicePosting", () => ({
  usePurchaseInvoicePosting: () => ({ data: null }),
  usePostPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import PurchaseInvoiceWorkspaceRoute from "@/pages/PurchaseInvoiceWorkspace";

function renderWorkspace() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PurchaseInvoiceWorkspaceRoute />
    </QueryClientProvider>,
  );
}

async function renderReady() {
  const utils = renderWorkspace();
  await screen.findByLabelText("Leveranciersnaam");
  return utils;
}

const lineRow = () => screen.getAllByPlaceholderText("Omschrijving")[0].closest("tr")!;
/**
 * De rekeningkiezer van de regel. Bewust de eerste combobox in de rij: de
 * BTW%-keuze is óók een combobox, en die staat verderop in dezelfde rij.
 */
const ledgerTrigger = () => within(lineRow()).getAllByRole("combobox")[0];
const exclInput = () => within(lineRow()).getAllByRole("textbox")[1] as HTMLInputElement;
const approveBtn = () => screen.getByRole("button", { name: /goedkeuren/i });
const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const readiness = () => screen.getByTestId("posting-readiness");
const blockers = () => document.getElementById("approve-blockers");

beforeEach(() => {
  toastSpy.mockReset();
  navigateSpy.mockReset();
  invalidateSpy.mockReset();
  atomicMutateAsync.mockReset();
  atomicMutateAsync.mockResolvedValue(legacyInvoice);
  state.invoice = { ...legacyInvoice };
  state.storedLines = [];
  state.ledgers = [TELEFOON, KANTOOR];
  state.clients = [{ ...volledigeClient }];
});

// ─────────────────────────────────────────────────────────────────────────────
describe("de afgeleide legacy-regel", () => {
  it("1. een factuur zonder opgeslagen regels krijgt één afgeleide regel uit de kop", async () => {
    await renderReady();
    const rij = lineRow();
    expect(within(rij).getByLabelText("Omschrijving")).toHaveValue("Simyo");
    // Het bedrag exclusief staat in een invoerveld, niet als tekst.
    expect(exclInput()).toHaveValue("3,80");
    expect(rij).toHaveTextContent("€ 4,60");
  });

  it("2. die regel is herkenbaar nog niet opgeslagen", async () => {
    await renderReady();
    expect(screen.getByTestId("derived-line-notice")).toHaveTextContent(
      "Deze boekingsregel is nog niet opgeslagen.",
    );
  });

  it("3. de oude rekeningtekst staat NIET als gekozen rekening in de kiezer", async () => {
    // Dit is de kern van het productiegeval: "4602 - Telefoonkosten" mocht er
    // uitzien als een selectie terwijl er geen id achter zat.
    await renderReady();
    expect(ledgerTrigger()).toHaveTextContent(/selecteer rekening/i);
    expect(ledgerTrigger()).not.toHaveTextContent("4602 - Telefoonkosten");
    // De tekst blijft wél zichtbaar, maar als verwijzing.
    expect(screen.getByTestId("legacy-account-hint")).toHaveTextContent("4602 - Telefoonkosten");
  });

  it("4. zolang er alleen legacy-tekst is, kan er niet worden goedgekeurd", async () => {
    await renderReady();
    expect(approveBtn()).toBeDisabled();
    expect(blockers()).toHaveTextContent("Kies een grootboekrekening voor elke boekingsregel.");
  });

  it("5. de boekbaarheid blijft op de OPGESLAGEN toestand: geen boekingsregels", async () => {
    await renderReady();
    expect(readiness().querySelector("[data-block-code='geen_boekingsregels']")).not.toBeNull();
  });
});

describe("de suggestie", () => {
  it("6. precies één treffer op rekeningnummer wordt aangeboden ter bevestiging", async () => {
    await renderReady();
    const hint = screen.getByTestId("legacy-account-hint");
    expect(hint).toHaveTextContent("Voorgestelde rekening uit oude factuur — bevestigen");
    expect(screen.getByTestId("legacy-account-confirm")).toHaveTextContent("Bevestig 4602 - Telefoonkosten");
  });

  it("7. een suggestie wijst zélf niets toe", async () => {
    await renderReady();
    // De knop staat er, maar er is nog niets gekozen en niets opgeslagen.
    expect(screen.getByTestId("legacy-account-confirm")).toBeInTheDocument();
    expect(ledgerTrigger()).toHaveTextContent(/selecteer rekening/i);
    expect(approveBtn()).toBeDisabled();
    expect(atomicMutateAsync).not.toHaveBeenCalled();
  });

  it("8. geen enkele treffer → geen suggestie", async () => {
    state.ledgers = [KANTOOR];
    await renderReady();

    expect(screen.queryByTestId("legacy-account-confirm")).toBeNull();
    expect(screen.getByTestId("legacy-account-no-suggestion")).toHaveTextContent(
      "Geen eenduidige rekening te bepalen",
    );
  });

  it("9. meerdere treffers → geen suggestie", async () => {
    state.ledgers = [TELEFOON, { id: "gb-dup", nummer: 4602, omschrijving: "Telefoon klant", client_id: "client-1" }];
    await renderReady();

    expect(screen.queryByTestId("legacy-account-confirm")).toBeNull();
    expect(screen.getByTestId("legacy-account-no-suggestion")).toBeInTheDocument();
  });

  it("10. tekst zonder rekeningnummer → geen suggestie, wel de verwijzing", async () => {
    state.invoice = { ...legacyInvoice, ledger_account_text: "Telefoonkosten" };
    await renderReady();

    expect(screen.queryByTestId("legacy-account-confirm")).toBeNull();
    expect(screen.getByTestId("legacy-account-hint")).toHaveTextContent("Telefoonkosten");
  });

  it("11. zonder legacy-tekst is er niets te verwijzen", async () => {
    state.invoice = { ...legacyInvoice, ledger_account_text: null };
    await renderReady();

    expect(screen.queryByTestId("legacy-account-hint")).toBeNull();
  });

  it("11b. ledger_account_id telt NOOIT als gekozen rekening — ook niet bij een gelijke uuid", async () => {
    // `purchase_invoices.ledger_account_id` hoort bij het id-domein van
    // `ledger_accounts`. Hier is de waarde toevallig gelijk aan de id van een
    // bestaande grootboekrekening — precies het geval waarin de vorige versie
    // die rekening als "gekozen" toonde. Toeval is geen relatie: er mag niets
    // geselecteerd zijn.
    state.invoice = { ...legacyInvoice, ledger_account_id: KANTOOR.id, ledger_account_text: null };
    await renderReady();

    expect(ledgerTrigger()).toHaveTextContent(/selecteer rekening/i);
    expect(ledgerTrigger()).not.toHaveTextContent("4400 - Kantoorkosten");
    // En het blijft dus geblokkeerd tot iemand zelf een rekening kiest.
    expect(approveBtn()).toBeDisabled();
    expect(blockers()).toHaveTextContent("Kies een grootboekrekening voor elke boekingsregel.");
  });

  it("11c. een gelijke uuid levert ook geen suggestie op; alleen de tekst telt", async () => {
    // Zelfde botsing, maar nu mét legacy-tekst die naar een ándere rekening
    // wijst. De suggestie moet uit de TEKST komen (4602), niet uit het id.
    state.invoice = { ...legacyInvoice, ledger_account_id: KANTOOR.id, ledger_account_text: "4602 - Telefoonkosten" };
    await renderReady();

    expect(ledgerTrigger()).toHaveTextContent(/selecteer rekening/i);
    expect(screen.getByTestId("legacy-account-confirm")).toHaveTextContent("Bevestig 4602 - Telefoonkosten");
    expect(screen.getByTestId("legacy-account-confirm")).not.toHaveTextContent("Kantoorkosten");

    // En bevestigen wijst de rekening uit de TEKST toe, niet die uit het id.
    fireEvent.click(screen.getByTestId("legacy-account-confirm"));
    await waitFor(() => expect(approveBtn()).toBeEnabled());
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].lines[0].grootboekrekening_id).toBe(TELEFOON.id);
  });
});

describe("bevestigen en opslaan", () => {
  it("12. bevestigen kiest de échte rekening en heft de goedkeurblokkade op", async () => {
    await renderReady();
    expect(approveBtn()).toBeDisabled();

    fireEvent.click(screen.getByTestId("legacy-account-confirm"));

    await waitFor(() => expect(approveBtn()).toBeEnabled());
    expect(ledgerTrigger()).toHaveTextContent("4602 - Telefoonkosten");
    // De verwijzing verdwijnt zodra er een echte rekening staat.
    expect(screen.queryByTestId("legacy-account-hint")).toBeNull();
  });

  it("13. opslaan gaat via het bestaande atomaire pad, met het echte rekening-id", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("legacy-account-confirm"));
    await waitFor(() => expect(approveBtn()).toBeEnabled());

    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));

    const payload = atomicMutateAsync.mock.calls[0][0];
    expect(payload.invoiceId).toBe("inv-1");
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].grootboekrekening_id).toBe("gb-4602");
    expect(payload.lines[0].amount_excl).toBe(3.8);
    // De kop draagt de legacy-tekst ongewijzigd verder; er wordt geen id
    // uit deze lijst in ledger_account_id geschreven.
    expect(payload.headerUpdates).not.toHaveProperty("ledger_account_id");
  });

  it("14. goedkeuren slaat dezelfde regel op en zet de status via het bestaande pad", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("legacy-account-confirm"));
    await waitFor(() => expect(approveBtn()).toBeEnabled());

    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));

    const payload = atomicMutateAsync.mock.calls[0][0];
    expect(payload.headerUpdates.status).toBe("gecontroleerd");
    expect(payload.lines[0].grootboekrekening_id).toBe("gb-4602");
  });

  it("15. zodra de regel is opgeslagen, vervalt de blokkade 'geen boekingsregels'", async () => {
    // Na een geslaagde opslag invalideert de bestaande hook de regelquery en
    // komt de regel uit de database terug. Dat bootsen we hier na.
    state.storedLines = [{
      id: "line-1", purchase_invoice_id: "inv-1", omschrijving: "Simyo",
      amount_excl: 3.8, btw_percentage: 21, grootboekrekening_id: "gb-4602", sort_order: 0,
    }];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='geen_boekingsregels']")).toBeNull();
    expect(readiness()).toHaveAttribute("data-readiness", "klaar");
    // En dan is het ook geen conceptregel meer.
    expect(screen.queryByTestId("derived-line-notice")).toBeNull();
    expect(screen.queryByTestId("legacy-account-hint")).toBeNull();
  });
});

describe("statische grenzen", () => {
  const bronnen = [
    "src/pages/PurchaseInvoiceWorkspace.tsx",
    "src/components/purchase/PurchaseInvoiceLinesTable.tsx",
    "src/lib/legacy-ledger-suggestion.ts",
  ].map((p) => ({ p, code: readFileSync(p, "utf8") }));

  it("16. geen schrijfpad naar ledger_postings en geen tweede regel-insert", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/ledger_postings/);
      expect(code, p).not.toMatch(/from\(\s*["']purchase_invoice_lines["']\s*\)/);
      expect(code, p).not.toMatch(/\.insert\(|\.upsert\(/);
      expect(code, p).not.toMatch(/replace_purchase_invoice_lines/);
    }
    // Opslaan loopt uitsluitend via de bestaande atomaire hook.
    const workspace = bronnen[0].code;
    expect(workspace).toMatch(/useSavePurchaseInvoiceWithLines/);
    expect(workspace).toMatch(/saveInvoiceWithLines\.mutateAsync/);
  });

  it("17. de legacy-tekst wordt nergens als rekening-id gebruikt", () => {
    const workspace = bronnen[0].code;
    // ledger_account_text mag alleen als LABEL/verwijzing voorkomen, nooit als
    // bron van grootboekrekening_id.
    expect(workspace).not.toMatch(/grootboekrekening_id:\s*invoice\.ledger_account_(id|text)/);
    expect(workspace).not.toMatch(/grootboek_label:.*ledger_account_text/);
  });

  it("17b. ledger_account_id wordt nooit tegen een grootboekrekening-id gelegd", () => {
    // `purchase_invoices.ledger_account_id` hoort bij het id-domein van
    // `ledger_accounts`; een boekingsregel heeft een id uit
    // `grootboekrekeningen` nodig. Gelijkheid tussen die twee domeinen zou
    // toeval zijn, geen relatie — en dat toeval als gekozen rekening
    // behandelen kan een boeking op een willekeurige rekening opleveren.
    // Deze bewaking houdt die vergelijking eruit, ook in de toekomst.
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

    for (const { p, code } of bronnen) {
      const schoon = strip(code);
      // g.id === invoice.ledger_account_id, en elke schrijfwijze daarvan.
      expect(schoon, p).not.toMatch(/\.id\s*===\s*\w+\.ledger_account_id/);
      expect(schoon, p).not.toMatch(/\w+\.ledger_account_id\s*===\s*\w+\.id/);
      // Of het omgekeerde: het id als rekening toewijzen.
      expect(schoon, p).not.toMatch(/grootboekrekening_id[^;\n]*ledger_account_id/);
      expect(schoon, p).not.toMatch(/ledger_account_id[^;\n]*grootboekrekening_id/);
      // Geen zoekactie in het rekeningschema op dat id.
      expect(schoon, p).not.toMatch(/(find|filter|some)\([^)]*ledger_account_id/);
    }
  });

  it("17c. de afgeleide regel begint per definitie zonder rekening", () => {
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const workspace = strip(bronnen[0].code);
    // In het prefill-blok staan letterlijk null en "", geen voorwaardelijke
    // toewijzing uit een andere bron.
    const prefillBlok = workspace.slice(workspace.indexOf("if (prefill)"), workspace.indexOf("derived: true"));
    expect(prefillBlok).toMatch(/grootboekrekening_id:\s*null/);
    expect(prefillBlok).toMatch(/grootboek_label:\s*""/);
  });

  it("18. geen fuzzy matching in de suggestielaag", () => {
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const lib = strip(bronnen.find((b) => b.p.endsWith("legacy-ledger-suggestion.ts"))!.code);
    expect(lib).not.toMatch(/includes\(|startsWith\(|toLowerCase\(|levenshtein|fuzzy|score/i);
    // Alleen een exacte nummervergelijking.
    expect(lib).toMatch(/a\.nummer === nummer/);
  });

  it("19. geen migratie en geen handmatige typewijziging in deze branch", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let changed: string;
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // geen origin/main beschikbaar
    }
    expect(changed).not.toMatch(/integrations\/supabase\/types\.ts/);
    expect(changed.split("\n").filter((f) => f.startsWith("supabase/") || f.endsWith(".sql"))).toEqual([]);
  });
});
