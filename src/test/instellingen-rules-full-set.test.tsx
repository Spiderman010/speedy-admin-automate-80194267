/**
 * Nulmeting C-01 (P1) — Instellingen › Herkenningsregels › "Regels toepassen".
 *
 * De preview en het toepassen lazen de open bankregels met één select zonder
 * range of volgorde: bij meer dan max_rows verwerkte de knop stil een
 * willekeurige 1000 en meldde dat als totaal. Hier: 1500 open bankregels
 * tegen een emulator die op 1000 afkapt; preview én toepassen zien ze alle
 * 1500. Echte pagina, geen netwerk.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPostgrestEmulator, readsOn, type Row } from "./support/postgrest-max-rows-emulator";

const h = vi.hoisted(() => ({ client: null as any, toast: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy({}, { get: (_t, prop) => (h.client as any)[prop] }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", email: "a@b.nl" }, loading: false }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: () => ({ data: {}, isLoading: false }),
  useSaveAppSetting: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useBookingTemplates", () => ({
  useBookingTemplates: () => ({
    data: [{
      id: "r1", actief: true, zoekterm: "vodafone", zoek_in: "omschrijving", actie: "grootboek",
      grootboekrekening_id: "gb-4500", ledger_account_text: "4500 - Telefoon", geldt_voor: "alle",
      client_id_filter: null, prioriteit: 0, btw_percentage: 21, name: null,
    }],
    isLoading: false,
  }),
  useAddBookingTemplate: () => ({ mutate: vi.fn() }),
  useUpdateBookingTemplate: () => ({ mutate: vi.fn() }),
  useDeleteBookingTemplate: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useVraagposten", () => ({ useCreateVraagpost: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [{ id: "gb-4500", nummer: 4500, omschrijving: "Telefoon" }] }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: [] }) }));
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: any[]) => h.toast(...a), useToast: () => ({ toast: h.toast }) }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import Instellingen from "@/pages/Instellingen";

const OPEN = 1500;
let emu: ReturnType<typeof createPostgrestEmulator>;

beforeEach(() => {
  h.toast = vi.fn();
  const rows: Row[] = Array.from({ length: OPEN }, (_, i) => ({
    id: `tx-${String(i).padStart(5, "0")}`, organization_id: "org-1", client_id: "c1", match_status: "niet_gematcht",
    transaction_date: "2026-10-01", amount: -25, description: `VODAFONE LIBERTEL termijn ${i}`, reference: null, counter_account: null,
  }));
  rows.push({ id: "tx-andere-org", organization_id: "org-2", client_id: "c9", match_status: "niet_gematcht", transaction_date: "2026-10-01", amount: -25, description: "VODAFONE", reference: null, counter_account: null });
  emu = createPostgrestEmulator({ maxRows: 1000, tables: { bank_transactions: rows, vraagposten: [] } });
  h.client = emu.client;
});

async function openRulesPreview() {
  render(<Instellingen />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Herkenningsregels" }), { button: 0 });
  fireEvent.click(await screen.findByRole("button", { name: /Preview toepassen op open bankregels/ }));
  return screen.findByRole("dialog");
}

describe("Regels toepassen op de volledige set open bankregels", () => {
  it("de preview telt alle 1500 open bankregels van de organisatie, niet de eerste 1000", async () => {
    const dialog = await openRulesPreview();
    const gescand = within(dialog).getByText("Gescand").nextElementSibling!;
    expect(gescand).toHaveTextContent(String(OPEN));
    expect(within(dialog).getByRole("button", { name: `Toepassen op ${OPEN} open bankregels` })).toBeEnabled();
    const reads = readsOn(emu.log, "bank_transactions");
    expect(reads.every((l) => l.range && l.order.join(",") === "id.asc")).toBe(true);
  });

  it("toepassen werkt alle 1500 bij en meldt dat aantal", async () => {
    const dialog = await openRulesPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: `Toepassen op ${OPEN} open bankregels` }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Klaar" })));
    const klaar = h.toast.mock.calls.find((c) => c[0]?.title === "Klaar")![0];
    expect(klaar.description).toContain(`${OPEN} geboekt op grootboek`);
    const updated = emu.tables.bank_transactions.filter((t) => t.match_status === "handmatig_geboekt");
    expect(updated).toHaveLength(OPEN);
    expect(updated.every((t) => t.organization_id === "org-1" && t.grootboekrekening_id === "gb-4500" && t.btw_percentage === 21)).toBe(true);
    // De regel van een andere organisatie blijft onaangeroerd.
    expect(emu.tables.bank_transactions.find((t) => t.id === "tx-andere-org")!.match_status).toBe("niet_gematcht");
  });
});
