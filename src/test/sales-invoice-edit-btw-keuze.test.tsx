import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * F1b-N1 — de verkoop-bewerkdialoog maakt van een ontbrekend btw-percentage
 * nooit meer stil 21%. Opslaan en Goedkeuren vragen een expliciete keuze.
 * De garanties van PR #293 blijven: Opslaan stuurt geen `status`, de status is
 * alleen-lezen en Goedkeuren is een aparte actie. Gedragstests op de echte
 * dialoog (mockpatroon van sales-invoice-ledger-link.test.tsx).
 */

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!(Element.prototype as any).hasPointerCapture) {
  (Element.prototype as any).hasPointerCapture = () => false;
  (Element.prototype as any).setPointerCapture = () => {};
  (Element.prototype as any).releasePointerCapture = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
}

const onSaveSpy = vi.fn();
const onApproveSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant Een", btw_vrijgesteld: false }] }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), download: async () => ({ data: null, error: null }) }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange }: any) => (
    <input aria-label="Grootboekrekening" value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)} />
  ),
}));

import { SalesInvoiceEditDialog } from "@/components/SalesInvoiceEditDialog";

/** Wat process-sales-invoice voor een 0%-verkoopfactuur opsloeg: `|| null` maakte 0 tot NULL. */
const makeInvoice = (over: Partial<any> = {}) => ({
  id: "si-1", client_id: "c-1", organization_id: "org-1", user_id: "u-1",
  customer_name: "Export BV", invoice_number: "V-9", invoice_date: "2026-10-01", due_date: null,
  amount_excl: 500, amount_incl: 500, btw_amount: null, btw_percentage: null, btw_verlegd: false,
  status: "concept", ledger_account_text: "8000 - Omzet", grootboekrekening_id: null,
  remaining_amount: 500, notes: null, pdf_path: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

function renderDialog(invoice: any) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SalesInvoiceEditDialog invoice={invoice} open onOpenChange={() => {}} onSave={onSaveSpy} onApprove={onApproveSpy} />
    </QueryClientProvider>,
  );
}

const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const approveBtn = () => screen.getByRole("button", { name: /goedkeuren/i });
const pctSelect = () => screen.getByRole("combobox", { name: "BTW-percentage" });

async function choose(trigger: HTMLElement, option: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  onSaveSpy.mockReset().mockResolvedValue(undefined);
  onApproveSpy.mockReset().mockResolvedValue(undefined);
});

describe("F1b-N1 — een ontbrekend btw-percentage wordt nooit stil 21%", () => {
  it("de 0%-exportfactuur (btw NULL/NULL) toont geen 21% en Opslaan en Goedkeuren vragen een keuze", async () => {
    renderDialog(makeInvoice());
    expect(pctSelect()).not.toHaveTextContent("21%");
    expect(pctSelect()).toHaveTextContent("Kies");
    expect(screen.getByTestId("sales-btw-keuze-ontbreekt")).toHaveTextContent("BTW niet herkend");
    expect(saveBtn()).toBeDisabled();
    expect(approveBtn()).toBeDisabled();
    fireEvent.click(saveBtn());
    fireEvent.click(approveBtn());
    await new Promise((r) => setTimeout(r, 0));
    expect(onSaveSpy).not.toHaveBeenCalled();
    expect(onApproveSpy).not.toHaveBeenCalled();
  });

  it("na de expliciete keuze 0% bewaart Opslaan 0 (niet 21) en geen status", async () => {
    renderDialog(makeInvoice());
    await choose(pctSelect(), "0%");
    await waitFor(() => expect(saveBtn()).toBeEnabled());
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    const payload = onSaveSpy.mock.calls[0][1];
    expect(payload.btw_percentage).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(payload, "status")).toBe(false);
  });

  it("Goedkeuren na de keuze zet alleen de status (aparte actie) en bewaart het gekozen percentage", async () => {
    renderDialog(makeInvoice());
    await choose(pctSelect(), "0%");
    await waitFor(() => expect(approveBtn()).toBeEnabled());
    fireEvent.click(approveBtn());
    await waitFor(() => expect(onApproveSpy).toHaveBeenCalledTimes(1));
    expect(onApproveSpy.mock.calls[0][1]).toMatchObject({ btw_percentage: 0, status: "gecontroleerd" });
  });

  it("BTW uitzetten is een expliciete keuze voor 0%; weer aanzetten vraagt opnieuw een keuze (geen 21)", async () => {
    renderDialog(makeInvoice({ btw_percentage: 21, btw_amount: 105, amount_incl: 605 }));
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle); // uit → 0
    await waitFor(() => expect(saveBtn()).toBeEnabled());
    fireEvent.click(toggle); // aan → kiezen
    await waitFor(() => expect(pctSelect()).toHaveTextContent("Kies"));
    expect(saveBtn()).toBeDisabled();
  });

  it("een opgeslagen percentage dat de dialoog niet aanbiedt (6) wordt niet stil 21: eerst kiezen", () => {
    renderDialog(makeInvoice({ btw_percentage: 6, btw_amount: 30, amount_incl: 530 }));
    expect(pctSelect()).not.toHaveTextContent("21%");
    expect(saveBtn()).toBeDisabled();
  });

  it("controle: een opgeslagen 0 met btw 0 blijft 0 (BTW uit) en is direct op te slaan", async () => {
    renderDialog(makeInvoice({ btw_percentage: 0, btw_amount: 0 }));
    expect(screen.queryByTestId("sales-btw-keuze-ontbreekt")).not.toBeInTheDocument();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    expect(onSaveSpy.mock.calls[0][1]).toMatchObject({ btw_percentage: 0, btw_amount: 0 });
  });

  it("controle: een opgeslagen 21% blijft 21% en het restant volgt de bestaande regel (P5 regelt het restant)", async () => {
    renderDialog(makeInvoice({ btw_percentage: 21, btw_amount: 105, amount_incl: 605, remaining_amount: 605 }));
    expect(pctSelect()).toHaveTextContent("21%");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    const payload = onSaveSpy.mock.calls[0][1];
    expect(payload).toMatchObject({ btw_percentage: 21, btw_amount: 105, amount_incl: 605, remaining_amount: 605 });
    expect(Object.prototype.hasOwnProperty.call(payload, "status")).toBe(false);
  });
});

describe("PR #293 blijft intact", () => {
  it("het statusblok bevat geen enkel bewerkbaar element", () => {
    renderDialog(makeInvoice({ btw_percentage: 21, btw_amount: 105, amount_incl: 605 }));
    const blok = screen.getByText(/Status wordt beheerd via de goedkeurings- en betalingsworkflow/).parentElement!;
    expect(within(blok).queryByRole("combobox")).toBeNull();
    expect(within(blok).queryByRole("textbox")).toBeNull();
    expect(within(blok).queryByRole("button")).toBeNull();
  });
});
