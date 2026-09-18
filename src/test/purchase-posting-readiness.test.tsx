import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PR B — boekbaarheid zichtbaar vóór goedkeuren en boeken.
 *
 * Twee poorten met bewust VERSCHILLENDE betekenis:
 *
 *  • Goedkeuren  = is het DOCUMENT af? Kop compleet, regels sluiten aan, minstens
 *    één betekenisvolle regel, en elke betekenisvolle regel heeft een
 *    grootboekrekening. Beoordeeld op wat er NU in het formulier staat.
 *
 *  • Boeken      = zou `post_purchase_invoice()` slagen? Beoordeeld door
 *    `evaluatePurchaseInvoice()` uit ledger-catchup.ts — dezelfde regels als de
 *    historische grootboekvulling — op de OPGESLAGEN factuur, want dat is wat de
 *    writer leest. Hier tellen óók de administratie-instellingen mee.
 *
 * Een ontbrekende crediteuren- of BTW-rekening blokkeert dus wél het boeken en
 * NIET het goedkeuren: de factuur kan af zijn terwijl de administratie nog niet
 * is ingericht.
 */

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const toastSpy = vi.fn();
const navigateSpy = vi.fn();
const atomicMutateAsync = vi.fn();
const postMutateAsync = vi.fn();

const baseInvoice = {
  id: "inv-1",
  client_id: "client-1",
  supplier: "Test Leverancier BV",
  invoice_number: "F-2026-001",
  invoice_date: "2026-07-20",
  amount_excl: 100,
  btw_amount: 21,
  amount_incl: 121,
  btw_percentage: 21,
  status: "gecontroleerd",
  ledger_account_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  leverancier_id: null,
  notes: null,
  remaining_amount: 121,
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

const baseLine = {
  id: "line-1",
  purchase_invoice_id: "inv-1",
  user_id: "user-1",
  organization_id: "org-1",
  omschrijving: "Consultancy",
  amount_excl: 100,
  btw_percentage: 21,
  grootboekrekening_id: "gb-1",
  sort_order: 0,
  created_at: "2026-07-20T08:00:00Z",
};

/** Volledig ingerichte administratie. */
const volledigeClient = {
  id: "client-1",
  name: "Klant Een",
  btw_vrijgesteld: false,
  afgesloten_boekjaar: null as number | null,
  crediteuren_rekening_id: "cred-1",
  debiteuren_rekening_id: "deb-1",
  btw_te_vorderen_rekening_id: "btwv-1",
  btw_te_betalen_rekening_id: "btwb-1",
};

const state = {
  invoiceId: "inv-1" as string | undefined,
  invoice: { ...baseInvoice } as typeof baseInvoice | null,
  storedLines: [{ ...baseLine }] as Array<typeof baseLine>,
  clients: [{ ...volledigeClient }] as any[],
  posting: null as { posting_group_id: string } | null,
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useParams: () => ({ invoiceId: state.invoiceId }), useNavigate: () => navigateSpy };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "purchase_invoices") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.invoice, error: null }) }) }),
      };
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
  useActiveGrootboekrekeningen: () => ({ data: [{ id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [{ id: "inv-1", invoice_date: "2026-07-20" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: () => ({ data: state.storedLines, isLoading: false }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: atomicMutateAsync }),
}));
vi.mock("@/hooks/usePurchaseInvoicePosting", () => ({
  usePurchaseInvoicePosting: () => ({ data: state.posting }),
  usePostPurchaseInvoice: () => ({ mutateAsync: postMutateAsync, isPending: false }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      aria-label="Grootboek"
      value={value ?? ""}
      onChange={(e) => { onValueChange?.(e.target.value); onIdChange?.(e.target.value ? "gb-1" : null); }}
    />
  ),
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

const approveBtn = () => screen.getByRole("button", { name: /goedkeuren/i });
const postBtn = () => screen.getByTestId("purchase-posting-button");
const readiness = () => screen.getByTestId("posting-readiness");
/** De uitleg "Waarom kan ik niet goedkeuren?" (id, gekoppeld via aria-describedby). */
const blockers = () => document.getElementById("approve-blockers")!;
/**
 * De grootboekkiezer van de EERSTE boekingsregel. Bewust via de rij en niet via
 * index: de kop heeft óók een "Standaard grootboek"-kiezer met hetzelfde label,
 * en die hoort bij de factuurkop, niet bij een regel.
 */
const ledgerInputOfFirstLine = () => {
  const row = screen.getAllByPlaceholderText("Omschrijving")[0].closest("tr")!;
  return within(row).getByLabelText("Grootboek");
};

beforeEach(() => {
  toastSpy.mockReset();
  navigateSpy.mockReset();
  atomicMutateAsync.mockReset();
  atomicMutateAsync.mockResolvedValue(baseInvoice);
  postMutateAsync.mockReset();
  postMutateAsync.mockResolvedValue("pg-1");
  state.invoiceId = "inv-1";
  state.invoice = { ...baseInvoice };
  state.storedLines = [{ ...baseLine }];
  state.clients = [{ ...volledigeClient }];
  state.posting = null;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("goedkeuren — documentcorrectheid", () => {
  it("1. een regel met inhoud maar zonder grootboekrekening blokkeert goedkeuren", async () => {
    state.storedLines = [{ ...baseLine, grootboekrekening_id: null }];
    await renderReady();

    expect(approveBtn()).toBeDisabled();
    expect(blockers()).toHaveTextContent("Kies een grootboekrekening voor elke boekingsregel.");
  });

  it("2. zodra de rekening is gekozen verdwijnt die blokkade", async () => {
    state.storedLines = [{ ...baseLine, grootboekrekening_id: null }];
    await renderReady();
    expect(approveBtn()).toBeDisabled();

    fireEvent.change(ledgerInputOfFirstLine(), { target: { value: "4400 - Kantoorkosten" } });

    await waitFor(() => expect(approveBtn()).toBeEnabled());
    expect(document.getElementById("approve-blockers")).toBeNull();
  });

  it("3. een volledig lege extra regel blokkeert goedkeuren niet", async () => {
    // Bestaand gedrag: een lege invoerrij is geen boekhoudkundige inhoud en
    // wordt nergens opgeslagen. Alleen een rij mét inhoud telt mee.
    await renderReady();
    expect(approveBtn()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));

    expect(approveBtn()).toBeEnabled();
    expect(document.getElementById("approve-blockers")).toBeNull();
  });

  it("4. opslaan blijft mogelijk terwijl de rekening nog ontbreekt", async () => {
    // De rekening opzoeken kost tijd; tussentijds bewaren moet kunnen. Alleen
    // GOEDKEUREN is geblokkeerd, niet opslaan.
    state.storedLines = [{ ...baseLine, grootboekrekening_id: null }];
    await renderReady();
    expect(screen.getByRole("button", { name: /^opslaan$/i })).toBeEnabled();
  });
});

describe("boeken — writer-uitgelijnde boekbaarheid", () => {
  it("5. ontbrekende BTW te vorderen-rekening is zichtbaar vóór het boeken", async () => {
    state.clients = [{ ...volledigeClient, btw_te_vorderen_rekening_id: null }];
    await renderReady();

    expect(readiness()).toHaveAttribute("data-readiness", "geblokkeerd");
    expect(readiness().querySelector("[data-block-code='geen_btw_rekening']")).not.toBeNull();
    expect(readiness()).toHaveTextContent(/BTW te vorderen/i);
    expect(postBtn()).toBeDisabled();
    // Documentcorrectheid is niet geraakt: goedkeuren mag nog steeds.
    expect(approveBtn()).toBeEnabled();
  });

  it("6. ontbrekende crediteurenrekening is zichtbaar vóór het boeken", async () => {
    state.clients = [{ ...volledigeClient, crediteuren_rekening_id: null }];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='geen_crediteurenrekening']")).not.toBeNull();
    expect(postBtn()).toBeDisabled();
    expect(approveBtn()).toBeEnabled();
  });

  it("7. een configuratieblokkade biedt een weg naar de instellingen", async () => {
    state.clients = [{ ...volledigeClient, crediteuren_rekening_id: null }];
    await renderReady();

    fireEvent.click(screen.getByTestId("posting-readiness-settings"));
    expect(navigateSpy).toHaveBeenCalledWith("/klanten");
  });

  it("8. zonder opgeslagen boekingsregels is dat een zichtbare blokkade", async () => {
    state.storedLines = [];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='geen_boekingsregels']")).not.toBeNull();
    expect(postBtn()).toBeDisabled();
  });

  it("9. regels die niet aansluiten op het factuurbedrag zijn een zichtbare blokkade", async () => {
    state.storedLines = [{ ...baseLine, amount_excl: 90 }];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='regels_sluiten_niet_aan']")).not.toBeNull();
    expect(postBtn()).toBeDisabled();
  });

  it("10. een regel zonder rekening blokkeert óók het boeken", async () => {
    state.storedLines = [{ ...baseLine, grootboekrekening_id: null }];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='regel_zonder_rekening']")).not.toBeNull();
    expect(postBtn()).toBeDisabled();
  });

  it("11. een niet-boekbare status is een zichtbare blokkade", async () => {
    state.invoice = { ...baseInvoice, status: "te_controleren" };
    await renderReady();

    expect(readiness().querySelector("[data-block-code='status_niet_postbaar']")).not.toBeNull();
    expect(readiness()).toHaveTextContent(/te_controleren/);
    expect(postBtn()).toBeDisabled();
  });

  it("12. een afgesloten boekjaar is een zichtbare blokkade", async () => {
    state.clients = [{ ...volledigeClient, afgesloten_boekjaar: 2026 }];
    await renderReady();

    expect(readiness().querySelector("[data-block-code='boekjaar_afgesloten']")).not.toBeNull();
    expect(readiness()).toHaveTextContent("2026");
    expect(postBtn()).toBeDisabled();
  });

  it("13. een complete factuur meldt 'Klaar om te boeken' en de knop staat aan", async () => {
    await renderReady();

    expect(readiness()).toHaveAttribute("data-readiness", "klaar");
    expect(readiness()).toHaveTextContent("Klaar om te boeken");
    expect(postBtn()).toBeEnabled();
  });

  it("14. boeken loopt via de bestaande writer-hook, met alleen de factuur-id", async () => {
    await renderReady();
    fireEvent.click(postBtn());

    await waitFor(() => expect(postMutateAsync).toHaveBeenCalledTimes(1));
    expect(postMutateAsync).toHaveBeenCalledWith("inv-1");
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Factuur geboekt" }));
  });

  it("15. weigert de writer alsnog, dan blijft de factuur ongeboekt en toont de fout", async () => {
    // De beoordeling is UX; de server houdt het laatste woord.
    postMutateAsync.mockRejectedValue(new Error("Boekjaar 2026 is afgesloten voor deze administratie"));
    await renderReady();
    fireEvent.click(postBtn());

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
        title: "Boeken niet gelukt",
        description: "Boekjaar 2026 is afgesloten voor deze administratie",
      })),
    );
    // Geen "geboekt"-melding.
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Factuur geboekt" }));
  });

  it("16. een reeds geboekte factuur toont geen boekbaarheidspaneel meer", async () => {
    state.posting = { posting_group_id: "pg-1" };
    await renderReady();

    expect(screen.queryByTestId("posting-readiness")).toBeNull();
    expect(screen.getByTestId("purchase-posting-done")).toBeInTheDocument();
  });
});

describe("statische grenzen", () => {
  const bronnen = [
    "src/pages/PurchaseInvoiceWorkspace.tsx",
    "src/components/purchase/PurchaseInvoicePostingReadiness.tsx",
    "src/lib/purchase-line-validation.ts",
  ].map((p) => ({ p, code: readFileSync(p, "utf8") }));

  it("17. geen enkele laag schrijft in ledger_postings of roept een eigen RPC aan", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/ledger_postings/);
      expect(code, p).not.toMatch(/supabase\.rpc\(/);
      expect(code, p).not.toMatch(/INSERT\s+INTO/i);
    }
  });

  it("18. geen rekeningnummer-heuristiek in de boekbaarheidslaag", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/\b(1100|1300|1520|1600|1799)\b/);
    }
  });

  it("19. de boekbaarheid hergebruikt de bestaande writer-uitgelijnde regels", () => {
    // Geen tweede regelset naast ledger-catchup.ts.
    const workspace = bronnen.find((b) => b.p.endsWith("PurchaseInvoiceWorkspace.tsx"))!.code;
    expect(workspace).toMatch(/evaluatePurchaseInvoice/);
    expect(workspace).toMatch(/aggregateInvoiceLines/);
    expect(workspace).toMatch(/from "@\/lib\/ledger-catchup"/);
  });

  it("20. boeken gebeurt uitsluitend via de bestaande posting-hook", () => {
    const workspace = bronnen.find((b) => b.p.endsWith("PurchaseInvoiceWorkspace.tsx"))!.code;
    expect(workspace).toMatch(/usePostPurchaseInvoice/);
    expect(workspace).toMatch(/postInvoice\.mutateAsync\(invoiceId\)/);
  });
});
