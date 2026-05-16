type InvoiceAmounts = {
  status: string;
  amount_excl: number | null;
  amount_incl: number | null;
  remaining_amount?: number | null;
};

const CLOSED_INVOICE_STATUSES = new Set(["betaald", "geexporteerd"]);

export function isClosedInvoiceStatus(status: string) {
  return CLOSED_INVOICE_STATUSES.has(status);
}

export function getInvoiceTotalAmount(invoice: Pick<InvoiceAmounts, "amount_excl" | "amount_incl">) {
  return invoice.amount_incl ?? invoice.amount_excl ?? null;
}

export function getInvoiceRemainingAmount(invoice: InvoiceAmounts) {
  if (invoice.status === "betaald") return 0;
  return invoice.remaining_amount ?? getInvoiceTotalAmount(invoice);
}

export function shouldSyncRemainingAmount(invoice: InvoiceAmounts) {
  const totalAmount = getInvoiceTotalAmount(invoice);
  return invoice.status !== "betaald" && (invoice.remaining_amount == null || invoice.remaining_amount === totalAmount);
}

export function getInvoicePaymentState(invoice: InvoiceAmounts): "paid" | "partial" | "open" | "unknown" {
  const remaining = getInvoiceRemainingAmount(invoice);
  if (remaining === 0) return "paid";
  const total = getInvoiceTotalAmount(invoice);
  if (total != null && remaining != null && remaining > 0 && remaining < total) return "partial";
  if (total != null || remaining != null) return "open";
  return "unknown";
}
