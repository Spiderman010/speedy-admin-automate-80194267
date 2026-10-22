import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #292 — herkenningsregels achteraf toepassen ("Preview toepassen op open
 * bankregels" → "Toepassen") is fail-closed zonder rechtsvormscope.
 *
 * Dit pad kent de rechtsvorm van een administratie niet. Een regel die alleen
 * voor BV's of alleen voor eenmanszaken geldt, mag daar dus nooit op een
 * bankregel worden toegepast, en een regel "specifieke klant" zonder gekozen
 * klant evenmin. Voorheen bewaakte alleen een stringcontract dit
 * (booking-template-grootboekrekening.test.ts:195-201); de nulmeting (E-03,
 * mutatie M3b) toonde dat het uitcommentariëren van de bewaking dan groen bleef.
 *
 * Deze test rendert de echte pagina Instellingen met een nagebouwde datalaag en
 * kijkt naar wat er werkelijk naar `bank_transactions` wordt geschreven.
 */

const ORG = "org-1";

const state = {
  templates: [] as any[],
  transactions: [] as any[],
  updates: [] as Array<{ id: unknown; payload: any; filters: unknown[][] }>,
};

/**
 * Een kleine, getrouwe nabouw van de PostgREST-querybouwer voor deze pagina:
 * eq/in-filters, order en range/limit, zodat ook een gepagineerde query (zoals
 * herstelpakket 3 die hier invoert) elke rij precies één keer ziet. Een update
 * raakt alleen de rijen die aan álle filters voldoen, en wordt op de
 * nagebouwde rij toegepast.
 */
function queryBuilder(table: string) {
  const ctx = {
    op: "select" as "select" | "update",
    payload: undefined as any,
    filters: [] as unknown[][],
    order: [] as Array<{ col: string; ascending: boolean }>,
    range: undefined as [number, number] | undefined,
    single: false,
  };
  const matches = (row: any) =>
    ctx.filters.every(([col, val]) =>
      val !== null && typeof val === "object" && "in" in val
        ? (val as { in: unknown[] }).in.includes(row[col as string])
        : row[col as string] === val,
    );
  const result = () => {
    if (table !== "bank_transactions") return { data: ctx.single ? null : [], error: null };
    let rows = state.transactions.filter(matches);
    if (ctx.op === "update") {
      for (const row of rows) {
        state.updates.push({ id: row.id, payload: ctx.payload, filters: ctx.filters });
        Object.assign(row, ctx.payload);
      }
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    for (const { col, ascending } of [...ctx.order].reverse()) {
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (ctx.range) rows = rows.slice(ctx.range[0], ctx.range[1] + 1);
    rows = rows.map((r) => ({ ...r }));
    return { data: ctx.single ? rows[0] ?? null : rows, error: null };
  };
  const builder: any = {
    select: () => builder,
    update: (payload: unknown) => {
      ctx.op = "update";
      ctx.payload = payload;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      ctx.filters.push([col, val]);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      ctx.filters.push([col, { in: vals }]);
      return builder;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      ctx.order.push({ col, ascending: opts?.ascending !== false });
      return builder;
    },
    range: (from: number, to: number) => {
      ctx.range = [from, to];
      return builder;
    },
    limit: (n: number) => {
      ctx.range = [0, n - 1];
      return builder;
    },
    maybeSingle: () => {
      ctx.single = true;
      return builder;
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => queryBuilder(table),
    auth: { updateUser: vi.fn(), signOut: vi.fn() },
  },
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => toast(...args), useToast: () => ({ toast }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1", email: "a@example.invalid" } }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: ORG, isReady: true }),
}));
vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: () => ({ data: {}, isLoading: false }),
  useSaveAppSetting: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useBookingTemplates", () => ({
  useBookingTemplates: () => ({ data: state.templates, isLoading: false }),
  useAddBookingTemplate: () => ({ mutate: vi.fn() }),
  useUpdateBookingTemplate: () => ({ mutate: vi.fn() }),
  useDeleteBookingTemplate: () => ({ mutate: vi.fn() }),
}));
const createVraagpost = vi.fn(async () => ({}));
vi.mock("@/hooks/useVraagposten", () => ({ useCreateVraagpost: () => ({ mutateAsync: createVraagpost }) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({
    data: [
      { id: "gb-4300", nummer: 4300, omschrijving: "Huisvestingskosten", organization_id: ORG, client_id: null },
      { id: "gb-4500", nummer: 4500, omschrijving: "Telefoonkosten", organization_id: ORG, client_id: null },
      { id: "gb-4600", nummer: 4600, omschrijving: "Verzekeringen", organization_id: ORG, client_id: null },
      { id: "gb-4700", nummer: 4700, omschrijving: "Advieskosten", organization_id: ORG, client_id: null },
      { id: "gb-4800", nummer: 4800, omschrijving: "Software", organization_id: ORG, client_id: null },
    ],
  }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-bv", name: "Bakkerij BV" }, { id: "c-ez", name: "Jansen Eenmanszaak" }] }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import Instellingen from "@/pages/Instellingen";

const rule = (over: Record<string, unknown>) => ({
  id: String(over.id),
  user_id: "user-1",
  name: null,
  description: null,
  default_amount: null,
  btw_percentage: null,
  ledger_account_text: null,
  ledger_account_id: null,
  client_id: null,
  zoek_in: "omschrijving",
  actie: "grootboek",
  geldt_voor: "alle",
  client_id_filter: null,
  prioriteit: 0,
  actief: true,
  created_at: "2026-10-01T00:00:00Z",
  organization_id: ORG,
  ...over,
});

const tx = (id: string, client_id: string, description: string) => ({
  id,
  client_id,
  organization_id: ORG,
  match_status: "niet_gematcht",
  transaction_date: "2026-10-01",
  description,
  reference: "",
  counter_account: "",
  amount: -100,
});

beforeEach(() => {
  state.updates = [];
  toast.mockClear();
  createVraagpost.mockClear();
  state.templates = [
    rule({ id: "r-bv", zoekterm: "huur", geldt_voor: "bv", grootboekrekening_id: "gb-4300", prioriteit: 10 }),
    rule({ id: "r-ez", zoekterm: "advies", geldt_voor: "eenmanszaak", grootboekrekening_id: "gb-4700", prioriteit: 9 }),
    rule({ id: "r-klant-zonder-filter", zoekterm: "verzekering", geldt_voor: "specifieke_klant", grootboekrekening_id: "gb-4600" }),
    rule({ id: "r-klant-ez", zoekterm: "abonnement", geldt_voor: "specifieke_klant", client_id_filter: "c-ez", grootboekrekening_id: "gb-4800" }),
    rule({ id: "r-alle", zoekterm: "telefoon", geldt_voor: "alle", grootboekrekening_id: "gb-4500" }),
  ];
  state.transactions = [
    tx("tx-huur-ez", "c-ez", "Huur bedrijfspand oktober"), // alleen een BV-regel past
    tx("tx-advies-bv", "c-bv", "Advies jaarrekening"), // alleen een eenmanszaak-regel past
    tx("tx-verzekering", "c-bv", "Verzekering bedrijfsauto"), // alleen een klantregel zónder klant past
    tx("tx-abonnement-bv", "c-bv", "Abonnement software"), // klantregel voor c-ez, niet voor c-bv
    tx("tx-abonnement-ez", "c-ez", "Abonnement software"), // klantregel voor c-ez: mag
    tx("tx-telefoon", "c-bv", "Telefoon KPN"), // regel voor alle klanten: mag
  ];
});

function renderInstellingen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Instellingen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Radix schakelt van tabblad op mouseDown, niet op click.
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Herkenningsregels" }));
}

async function openPreview() {
  renderInstellingen();
  fireEvent.click(await screen.findByRole("button", { name: /Preview toepassen op open bankregels/ }));
  return screen.findByRole("dialog", { name: /Preview: herkenningsregels op open bankregels/ });
}

const tile = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label).parentElement!.querySelector("p:last-child")!.textContent;

describe("#292 herkenningsregels achteraf toepassen: fail-closed zonder rechtsvormscope", () => {
  it("de preview telt alleen regels die zonder rechtsvorm veilig zijn", async () => {
    const dialog = await openPreview();
    expect(tile(dialog, "Gescand")).toBe("6");
    expect(tile(dialog, "Wordt bijgewerkt")).toBe("2");
    expect(tile(dialog, "Geen match")).toBe("4");
    // De BV-, eenmanszaak- en klantloze regel komen in de telling per regel niet voor.
    expect(within(dialog).queryByText(/huur \(/)).toBeNull();
    expect(within(dialog).queryByText(/advies \(/)).toBeNull();
    expect(within(dialog).queryByText(/verzekering \(/)).toBeNull();
    expect(within(dialog).getByText(/telefoon \(Boeken op grootboek\) · 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/abonnement \(Boeken op grootboek\) · 1/)).toBeInTheDocument();
    // De preview schrijft niets.
    expect(state.updates).toEqual([]);
  });

  it("toepassen schrijft een BV- of eenmanszaakregel nooit op een bankregel, en een klantregel zonder klant evenmin", async () => {
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: /Toepassen op 2 open bankregels/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Klaar" })));

    const written = state.updates.map((u) => [u.id, u.payload.grootboekrekening_id]).sort();
    expect(written).toEqual([
      ["tx-abonnement-ez", "gb-4800"],
      ["tx-telefoon", "gb-4500"],
    ]);
    for (const id of ["tx-huur-ez", "tx-advies-bv", "tx-verzekering", "tx-abonnement-bv"]) {
      expect(state.updates.some((u) => u.id === id), id).toBe(false);
    }
    // Elke schrijfactie blijft binnen de organisatie en alleen op nog open regels.
    for (const u of state.updates) {
      expect(u.filters).toContainEqual(["match_status", "niet_gematcht"]);
      expect(u.filters).toContainEqual(["organization_id", ORG]);
      expect(u.payload).toMatchObject({ match_status: "handmatig_geboekt" });
    }
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "2 geboekt op grootboek · 4 overgeslagen" }),
    );
    expect(createVraagpost).not.toHaveBeenCalled();
  });

  it("ook een vraagpostregel met rechtsvormscope maakt achteraf geen vraagpost aan", async () => {
    state.templates = [
      rule({ id: "r-bv-vraag", zoekterm: "huur", geldt_voor: "bv", actie: "vraagpost" }),
      rule({ id: "r-alle", zoekterm: "telefoon", geldt_voor: "alle", grootboekrekening_id: "gb-4500" }),
    ];
    const dialog = await openPreview();
    expect(tile(dialog, "Wordt bijgewerkt")).toBe("1");
    fireEvent.click(within(dialog).getByRole("button", { name: /Toepassen op 1 open bankregel$/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Klaar" })));
    expect(createVraagpost).not.toHaveBeenCalled();
    expect(state.updates.map((u) => u.id)).toEqual(["tx-telefoon"]);
  });
});
