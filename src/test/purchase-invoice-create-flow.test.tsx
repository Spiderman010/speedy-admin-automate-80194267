import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Tables } from "@/integrations/supabase/types";

// Polyfills voor Radix in jsdom
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

const createdInvoice: Tables<"purchase_invoices"> = {
  id: "inv-new-1",
  client_id: "client-1",
  supplier: "Test Leverancier BV",
  invoice_number: "F-2026-001",
  invoice_date: "2026-07-18",
  amount_excl: 100 as any,
  amount_incl: 121 as any,
  btw_amount: 21 as any,
  btw_percentage: 21 as any,
  status: "te_controleren",
  remaining_amount: 121 as any,
  user_id: "u1",
  organization_id: "org-1",
  leverancier_id: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as unknown as Tables<"purchase_invoices">;

const mutateAsync = vi.fn(async (_payload: any) => createdInvoice);

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("@/hooks/usePurchaseInvoices", () => ({
  useAddPurchaseInvoice: () => ({ mutateAsync, isPending: false }),
}));

vi.mock("@/hooks/useLeveranciers", () => ({
  useLeveranciers: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Stub InvoiceEditDialog: toont supplier + factuurregel prefill preview
vi.mock("@/components/InvoiceEditDialog", () => ({
  InvoiceEditDialog: ({ invoice, open }: any) =>
    open && invoice ? (
      <div data-testid="edit-dialog">
        <div data-testid="edit-supplier">{invoice.supplier}</div>
        <div data-testid="edit-line">
          Regel: {invoice.supplier} — €{Number(invoice.amount_excl).toFixed(2)} excl., BTW {invoice.btw_percentage}%
        </div>
      </div>
    ) : null,
}));

import { PurchaseInvoiceCreateDialog } from "@/components/PurchaseInvoiceCreateDialog";
import { InvoiceEditDialog } from "@/components/InvoiceEditDialog";

function Harness() {
  const [createOpen, setCreateOpen] = useState(true);
  const [edit, setEdit] = useState<Tables<"purchase_invoices"> | null>(null);
  return (
    <>
      <PurchaseInvoiceCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        clients={[{ id: "client-1", name: "Klant Een" }]}
        organizationId="org-1"
        defaultClientId="client-1"
        onCreated={(inv) => setEdit(inv)}
      />
      <InvoiceEditDialog
        invoice={edit}
        open={!!edit}
        onOpenChange={(o: boolean) => !o && setEdit(null)}
        onSave={async () => {}}
        onApprove={async () => {}}
      />
    </>
  );
}

describe("Nieuwe inkoopfactuur → InvoiceEditDialog flow", () => {
  it("maakt factuur aan en opent direct de edit-dialog met de juiste regel", async () => {
    render(<Harness />);

    const supplierInput = screen.getByPlaceholderText(/of typ leveranciernaam/i);
    fireEvent.change(supplierInput, { target: { value: "Test Leverancier BV" } });

    const invoiceNumber = screen.getByPlaceholderText("F-2026-001");
    fireEvent.change(invoiceNumber, { target: { value: "F-2026-001" } });

    const [amountExcl, btwAmount, amountIncl] = screen.getAllByPlaceholderText("0,00");
    fireEvent.change(amountExcl, { target: { value: "100,00" } });
    fireEvent.change(btwAmount, { target: { value: "21,00" } });
    fireEvent.change(amountIncl, { target: { value: "121,00" } });

    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0] as any;
    expect(payload.client_id).toBe("client-1");
    expect(payload.supplier).toBe("Test Leverancier BV");
    expect(payload.invoice_number).toBe("F-2026-001");
    expect(payload.amount_excl).toBe(100);
    expect(payload.amount_incl).toBe(121);
    expect(payload.btw_amount).toBe(21);
    expect(payload.status).toBe("te_controleren");

    await waitFor(() => {
      expect(screen.getByTestId("edit-dialog")).toBeInTheDocument();
    });
    expect(screen.getByTestId("edit-supplier")).toHaveTextContent("Test Leverancier BV");
    expect(screen.getByTestId("edit-line")).toHaveTextContent(
      "Regel: Test Leverancier BV — €100.00 excl., BTW 21%",
    );
  });
});
