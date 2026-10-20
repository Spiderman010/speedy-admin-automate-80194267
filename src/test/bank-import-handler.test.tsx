import { render, screen, fireEvent, getAllByText, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Mock state knobs ────────────────────────────────────────────────────────
const importState: { addTx: any; toast: any; supported: any; dialogProps: any } = {
  addTx: vi.fn(),
  toast: vi.fn(),
  supported: vi.fn(),
  dialogProps: null,
};

const state = {
  transactions: [] as any[],
  wholeSetLoading: false,
  wholeSetError: false,
  ledgerFacts: undefined as any,
};

const makeRow = (id: string, over: Partial<any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  transaction_date: "2026-01-10",
  description: `Rij ${id}`,
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount: -25,
  match_status: "niet_gematcht",
  match_confidence: null,
  matched_invoice_id: null,
  matched_invoice_type: null,
  grootboekrekening_id: null,
  ledger_account: null,
  notes: null,
  ...over,
});

// Bank-matching tests isolate rejection feedback from network and React Query.
vi.mock("@/hooks/useBankMatchRejections", () => ({
  useBankMatchRejections: () => ({ data: [], isSuccess: true, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [{ id: "c1", name: "Klant 1", btw_status: "btw_plichtig" }],
  }),
}));

vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: (s: string) =>
    ["all", "open", "gematcht", "handmatig"].includes(s),
  BANK_STATUS_MATCH_VALUES: {
    all: undefined,
    open: ["niet_gematcht", "suggestie"],
    gematcht: ["gematcht"],
    handmatig: ["handmatig_geboekt"],
  },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  useBankTransactions: () => ({
    data: state.wholeSetError || state.wholeSetLoading ? undefined : state.transactions,
    isLoading: state.wholeSetLoading,
    isError: state.wholeSetError,
    refetch: vi.fn(),
  }),
  usePaginatedBankTransactions: (opts: any) => ({
    data: {
      transactions: state.transactions.slice(
        (opts.page - 1) * 50,
        opts.page * 50,
      ),
      total: state.transactions.length,
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: importState.addTx }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [], refetch: vi.fn() }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [] }),
}));

vi.mock("@/hooks/useBookingTemplates", () => ({
  useBookingTemplates: () => ({ data: [] }),
}));

vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => ({ data: [] }),
  useCreateVraagpost: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn() }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/components/BankMatchDialog", () => ({
  BankMatchDialog: () => null,
  rankCandidates: () => [],
}));

vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: state.ledgerFacts }) }));
vi.mock("@/components/BankStatementUploadDialog", () => ({
  BankStatementUploadDialog: (props: any) => {
    importState.dialogProps = props;
    return null;
  },
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: importState.toast }),
  toast: (...a: any[]) => importState.toast(...a),
}));
vi.mock("@/hooks/bankImportFingerprint", () => ({
  importFingerprintSupported: () => importState.supported(),
  withImportFingerprint: (row: any, fp: any, source?: any, bankReference?: any) => ({
    ...row,
    ...(fp ? { import_fingerprint: fp } : {}),
    ...(source ? { import_source: source } : {}),
    ...(bankReference ? { bank_reference: bankReference } : {}),
  }),
  isImportFingerprintConflict: (e: any) => e?.code === "23505" && /import_fingerprint/.test(e?.message ?? ""),
}))
vi.mock("@/components/BankAfletteringDrawer", () => ({
  BankAfletteringDrawer: () => null,
}));
vi.mock("@/components/VerwerkingsScherm", () => ({
  VerwerkingsScherm: () => null,
}));
vi.mock("@/components/CreateVraagpostDialog", () => ({
  CreateVraagpostDialog: () => null,
}));
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: ({ value }: any) => (
    <span data-testid="client-select">client={value.selectedIds.join(",")}</span>
  ),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: () => null,
}));
vi.mock("@/components/OrganizationSelector", () => ({
  OrganizationSelector: () => null,
}));

import Bank from "@/pages/Bank";
import { act } from "@testing-library/react";

/**
 * De import in Bank.tsx: vingerafdruk alleen meesturen als de database hem
 * kent, een weigering door de unieke index telt als "stond er al" (niet als
 * fout, geen opnieuw-importeren-advies), en een onbekende capaciteit stopt.
 */

function renderBank(): void {
  render(
    (
      <MemoryRouter initialEntries={["/bank?client=c1"]}>
        <Bank />
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

const line = (n: number, over: Partial<any> = {}) => ({
  date: "2026-10-02",
  amount: -12.5,
  description: `Regel ${n}`,
  counterAccount: null,
  reference: `NONREF//B6J02XY000000${n}`,
  matchedInvoiceId: null,
  matchConfidence: null,
  matchStatus: "niet_gematcht",
  matchedInvoiceLabel: null,
  importFingerprint: String(n).repeat(64).slice(0, 64),
  importSource: "mt940",
  bankReference: `B6J02XY000000${n}`,
  ...over,
});

beforeEach(() => {
  state.transactions = [];
  importState.addTx = vi.fn(async (row: any) => ({ id: `new-${row.description}`, ...row }));
  importState.toast = vi.fn();
  importState.supported = vi.fn(async () => true);
  importState.dialogProps = null;
});

async function runImport(lines: any[]) {
  renderBank();
  expect(importState.dialogProps).not.toBeNull();
  await act(async () => {
    await importState.dialogProps.onImport("c1", lines);
  });
}

describe("Bank — import met importvingerafdruk", () => {
  it("database kent de kolom ⇒ elke regel gaat mét haar vingerafdruk naar de insert", async () => {
    await runImport([line(1), line(2)]);
    expect(importState.addTx.mock.calls.map((c: any[]) => c[0].import_fingerprint)).toEqual([line(1).importFingerprint, line(2).importFingerprint]);
    expect(importState.addTx.mock.calls.map((c: any[]) => c[0].import_source)).toEqual(["mt940", "mt940"]);
    expect(importState.addTx.mock.calls.map((c: any[]) => c[0].bank_reference)).toEqual(["B6J02XY0000001", "B6J02XY0000002"]);
  });

  it("migratie nog niet toegepast ⇒ insert zonder de kolom (geen PGRST204)", async () => {
    importState.supported = vi.fn(async () => false);
    await runImport([line(1)]);
    expect(importState.addTx.mock.calls[0][0]).not.toHaveProperty("import_fingerprint");
    expect(importState.addTx.mock.calls[0][0]).not.toHaveProperty("import_source");
    expect(importState.addTx.mock.calls[0][0]).not.toHaveProperty("bank_reference");
  });

  it("unieke index weigert ⇒ 'stond er al', geen fout en geen advies om opnieuw te importeren", async () => {
    importState.addTx = vi.fn(async (row: any) => {
      if (row.description === "Regel 2") {
        throw { code: "23505", message: 'duplicate key value violates unique constraint "bank_transactions_client_import_fingerprint_key"', details: "Key (client_id, import_fingerprint)" };
      }
      return { id: "x", ...row };
    });
    await runImport([line(1), line(2)]);
    const [arg] = importState.toast.mock.calls.at(-1);
    expect(arg.title).toBe("1 van 2 transacties geïmporteerd");
    expect(arg.variant).toBeUndefined();
    expect(arg.description).toMatch(/1 regel stond er intussen al/);
    expect(arg.description).not.toMatch(/Importeer het afschrift opnieuw/);
  });

  it("een echte fout blijft een fout, met het advies om opnieuw te importeren", async () => {
    importState.addTx = vi.fn(async () => {
      throw { code: "42501", message: "nieuw record schendt RLS" };
    });
    await runImport([line(1)]);
    const [arg] = importState.toast.mock.calls.at(-1);
    expect(arg.variant).toBe("destructive");
    expect(arg.description).toMatch(/Importeer het afschrift opnieuw/);
  });

  it("capaciteit onbekend (fout bij de controle) ⇒ er wordt niets geschreven", async () => {
    importState.supported = vi.fn(async () => {
      throw new Error("JWT expired");
    });
    await runImport([line(1)]);
    expect(importState.addTx).not.toHaveBeenCalled();
    expect(importState.toast.mock.calls.at(-1)[0]).toMatchObject({ title: "Importeren is niet gestart", variant: "destructive" });
  });
});
