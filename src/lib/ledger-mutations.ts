// Pure normalisation layer for the read-only "Grootboekmutaties" overview.
//
// This module contains NO React, NO hooks and NO Supabase access so the
// double-counting rules can be unit-tested in isolation.
//
// SCOPE — deliberately limited (see the 6C0 architecture audit):
//   • This is NOT a general ledger. There is no debet/credit, no counter
//     account and no closing balance, because the current data model does not
//     express those for every source.
//   • The inclusion/exclusion rules below are NOT new accounting rules. They
//     mirror the semantics that already exist in the application:
//       - purchase/sales export gating  → EXPORTABLE_STATUSES + geexporteerd
//       - bank export gating            → resolveBankExportGrootboek
//       - settlement bookkeeping        → bank_transaction_allocations
//
// The core invariant: a paid invoice must appear exactly once (as the invoice),
// never a second time as the bank payment that settles it.

import { getDisplayDescription } from "@/lib/mt940-description-parser";

export type LedgerMutationSource = "purchase" | "sales" | "bank" | "journal";

/**
 * Visual source direction only — NOT a debit/credit derivation.
 * It says "money out / money in / not directional", nothing more.
 */
export type LedgerMutationDirection = "in" | "out" | "neutral";

export interface LedgerMutation {
  /** Stable composite key, unique across sources (e.g. "purchase:<uuid>"). */
  id: string;
  source: LedgerMutationSource;
  /** Primary key of the underlying row, for drill-down. */
  sourceId: string;
  clientId: string;
  /** ISO yyyy-mm-dd, taken from the source's own booking date. */
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  direction: LedgerMutationDirection;
  /** Only set when a real grootboekrekeningen FK exists on the source row. */
  ledgerAccountId: string | null;
  /** Resolved "nummer - omschrijving", or the stored free text. */
  ledgerAccountLabel: string | null;
  vatAmount: number | null;
}

export const LEDGER_SOURCE_LABELS: Record<LedgerMutationSource, string> = {
  purchase: "Inkoop",
  sales: "Verkoop",
  bank: "Bank",
  journal: "Handmatig",
};

/**
 * Invoice statuses that count as a financial mutation.
 *
 * Mirrors the existing export gate: usePurchaseInvoices.EXPORTABLE_STATUSES is
 * ["gecontroleerd", "betaald"], and "geexporteerd" is the terminal state those
 * invoices move to after markPurchaseInvoicesExported. "te_controleren"
 * (purchase) and "concept"/"verzonden" (sales) are not yet approved and are
 * therefore excluded.
 */
export const PURCHASE_LEDGER_STATUSES = ["gecontroleerd", "betaald", "geexporteerd"] as const;
export const SALES_LEDGER_STATUSES = ["gecontroleerd", "betaald", "geexporteerd"] as const;

// ── Structural input types ──────────────────────────────────────────────────
// Intentionally minimal (structural) so both real Supabase rows and small test
// fixtures satisfy them.

export interface LedgerAccountLike {
  id: string;
  nummer: number;
  omschrijving: string;
}

export interface PurchaseInvoiceLike {
  id: string;
  client_id: string;
  status: string;
  invoice_date: string | null;
  supplier: string | null;
  invoice_number: string | null;
  amount_incl: number | null;
  amount_excl: number | null;
  btw_amount: number | null;
  grootboekrekening_id?: string | null;
  ledger_account_text: string | null;
}

export interface SalesInvoiceLike {
  id: string;
  client_id: string;
  status: string;
  invoice_date: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  amount_incl: number | null;
  amount_excl: number | null;
  btw_amount: number | null;
  ledger_account_text: string | null;
}

export interface JournalEntryLike {
  id: string;
  client_id: string;
  entry_date: string;
  amount: number;
  btw_amount: number | null;
  description: string | null;
  invoice_number: string | null;
  grootboekrekening_id: string | null;
  ledger_account_text: string | null;
}

export interface BankTransactionLike {
  id: string;
  client_id: string;
  transaction_date: string;
  amount: number;
  match_status: string;
  description: string | null;
  reference?: string | null;
  counter_account?: string | null;
  camt_counterparty_name?: string | null;
  grootboekrekening_id: string | null;
}

export interface AllocationLike {
  bank_transaction_id: string;
}

export interface BuildLedgerMutationsInput {
  purchaseInvoices?: readonly PurchaseInvoiceLike[];
  salesInvoices?: readonly SalesInvoiceLike[];
  journalEntries?: readonly JournalEntryLike[];
  bankTransactions?: readonly BankTransactionLike[];
  /**
   * Settlement rows. Never produce a mutation themselves — they are used
   * exclusively to recognise (and exclude) bank transactions that settle an
   * already-counted invoice.
   */
  allocations?: readonly AllocationLike[];
  /**
   * Chart of accounts used to resolve ledger labels and to validate that a
   * bank transaction's grootboekrekening_id is not stale — mirroring
   * resolveBankExportGrootboek. When omitted, a non-empty id counts as valid
   * and labels fall back to the stored free text.
   */
  accounts?: readonly LedgerAccountLike[];
}

/** Why bank transactions were left out, so the UI can be transparent about it. */
export interface BankExclusionSummary {
  total: number;
  /** niet_gematcht or any unknown status — not processed yet. */
  unmatched: number;
  /** suggestie — an unconfirmed automatic suggestion. */
  suggested: number;
  /** gematcht, or carrying allocation rows: settles an invoice already counted. */
  settled: number;
  /** handmatig_geboekt without a resolvable grootboekrekening. */
  invalidManual: number;
}

export interface LedgerMutationsResult {
  mutations: LedgerMutation[];
  excludedBank: BankExclusionSummary;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatAccountLabel(account: LedgerAccountLike): string {
  // Same shape the rest of the app uses (GrootboekCombobox,
  // resolveJournalEntryLedgerLabel).
  return `${account.nummer} - ${account.omschrijving}`;
}

function resolveAccount(
  accountId: string | null | undefined,
  accounts: readonly LedgerAccountLike[] | undefined,
): LedgerAccountLike | null {
  if (!accountId || !accounts) return null;
  return accounts.find((a) => a.id === accountId) ?? null;
}

/**
 * Ledger label: the resolved account when the FK points at a known account,
 * otherwise the stored free text, otherwise null.
 */
function resolveLedgerLabel(
  accountId: string | null | undefined,
  freeText: string | null | undefined,
  accounts: readonly LedgerAccountLike[] | undefined,
): string | null {
  const account = resolveAccount(accountId, accounts);
  if (account) return formatAccountLabel(account);
  const text = freeText?.trim();
  return text ? text : null;
}

/** Invoice total, mirroring getInvoiceTotalAmount (incl. before excl.). */
function invoiceAmount(row: { amount_incl: number | null; amount_excl: number | null }): number {
  return row.amount_incl ?? row.amount_excl ?? 0;
}

function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

// ── Core normalisation ──────────────────────────────────────────────────────

/**
 * Normalise every financial source into one list, applying the double-counting
 * rules. Returns the mutations plus a summary of the bank transactions that
 * were deliberately left out.
 *
 * Sorted newest first (date desc), with the composite id as a deterministic
 * tie-break.
 */
export function buildLedgerMutations(input: BuildLedgerMutationsInput): LedgerMutationsResult {
  const { accounts } = input;
  const mutations: LedgerMutation[] = [];

  // ── Inkoop ────────────────────────────────────────────────────────────────
  // Approved purchase invoices are the cost + VAT mutation. The header's
  // ledger_account_text is what the SnelStart export actually uses; per-line
  // grootboekrekening_id is coding detail and is deliberately NOT promoted to
  // a posting source here (flagged as a separate open question in the audit).
  for (const inv of input.purchaseInvoices ?? []) {
    if (!(PURCHASE_LEDGER_STATUSES as readonly string[]).includes(inv.status)) continue;
    if (!inv.invoice_date) continue;
    mutations.push({
      id: `purchase:${inv.id}`,
      source: "purchase",
      sourceId: inv.id,
      clientId: inv.client_id,
      date: inv.invoice_date,
      description: inv.supplier?.trim() || "Inkoopfactuur",
      reference: isNonEmpty(inv.invoice_number) ? inv.invoice_number!.trim() : null,
      amount: invoiceAmount(inv),
      direction: "out",
      ledgerAccountId: inv.grootboekrekening_id ?? null,
      ledgerAccountLabel: resolveLedgerLabel(inv.grootboekrekening_id, inv.ledger_account_text, accounts),
      vatAmount: inv.btw_amount ?? null,
    });
  }

  // ── Verkoop ───────────────────────────────────────────────────────────────
  // sales_invoices has no grootboekrekening_id column at all, so ledgerAccountId
  // is always null. The free text is shown as-is; it is never fuzzy-matched
  // back onto an account number.
  for (const inv of input.salesInvoices ?? []) {
    if (!(SALES_LEDGER_STATUSES as readonly string[]).includes(inv.status)) continue;
    if (!inv.invoice_date) continue;
    mutations.push({
      id: `sales:${inv.id}`,
      source: "sales",
      sourceId: inv.id,
      clientId: inv.client_id,
      date: inv.invoice_date,
      description: inv.customer_name?.trim() || "Verkoopfactuur",
      reference: isNonEmpty(inv.invoice_number) ? inv.invoice_number!.trim() : null,
      amount: invoiceAmount(inv),
      direction: "in",
      ledgerAccountId: null,
      ledgerAccountLabel: isNonEmpty(inv.ledger_account_text) ? inv.ledger_account_text!.trim() : null,
      vatAmount: inv.btw_amount ?? null,
    });
  }

  // ── Handmatige boekingen ──────────────────────────────────────────────────
  // journal_entries only ever holds entry_type "handmatig"; nothing else in the
  // app writes to it, so there is no double-counting risk here.
  for (const entry of input.journalEntries ?? []) {
    mutations.push({
      id: `journal:${entry.id}`,
      source: "journal",
      sourceId: entry.id,
      clientId: entry.client_id,
      date: entry.entry_date,
      description: entry.description?.trim() || "Handmatige boeking",
      reference: isNonEmpty(entry.invoice_number) ? entry.invoice_number!.trim() : null,
      amount: entry.amount,
      direction: "neutral",
      ledgerAccountId: entry.grootboekrekening_id ?? null,
      ledgerAccountLabel: resolveLedgerLabel(entry.grootboekrekening_id, entry.ledger_account_text, accounts),
      vatAmount: entry.btw_amount ?? null,
    });
  }

  // ── Bank ──────────────────────────────────────────────────────────────────
  // A bank transaction is an independent mutation ONLY when it is manually
  // booked to its own ledger account and settles nothing. Everything else is
  // either unprocessed, unconfirmed, or the payment side of an invoice that is
  // already counted above.
  const allocatedTxIds = new Set((input.allocations ?? []).map((a) => a.bank_transaction_id));
  const excludedBank: BankExclusionSummary = {
    total: 0,
    unmatched: 0,
    suggested: 0,
    settled: 0,
    invalidManual: 0,
  };

  for (const tx of input.bankTransactions ?? []) {
    // Precedence mirrors resolveBankExportGrootboek: an unconfirmed suggestion
    // always blocks first, then anything that is not gematcht/handmatig_geboekt.
    if (tx.match_status === "suggestie") {
      excludedBank.total++;
      excludedBank.suggested++;
      continue;
    }
    if (tx.match_status !== "gematcht" && tx.match_status !== "handmatig_geboekt") {
      excludedBank.total++;
      excludedBank.unmatched++;
      continue;
    }
    // gematcht = matched against an invoice → settlement, never a mutation.
    // handmatig_geboekt WITH allocation rows also settles an invoice.
    if (tx.match_status === "gematcht" || allocatedTxIds.has(tx.id)) {
      excludedBank.total++;
      excludedBank.settled++;
      continue;
    }
    // handmatig_geboekt, no allocations: requires a usable ledger account.
    const account = resolveAccount(tx.grootboekrekening_id, accounts);
    const hasUsableLedger = accounts ? !!account : !!tx.grootboekrekening_id;
    if (!hasUsableLedger) {
      excludedBank.total++;
      excludedBank.invalidManual++;
      continue;
    }

    mutations.push({
      id: `bank:${tx.id}`,
      source: "bank",
      sourceId: tx.id,
      clientId: tx.client_id,
      date: tx.transaction_date,
      // Signed amount is preserved: the bank is the one source that already
      // carries a direction (+ incoming, − outgoing).
      amount: tx.amount,
      direction: tx.amount > 0 ? "in" : tx.amount < 0 ? "out" : "neutral",
      description:
        getDisplayDescription(tx.description ?? null, {
          reference: tx.reference ?? null,
          counterAccount: tx.counter_account ?? null,
        }) || "Banktransactie",
      reference: isNonEmpty(tx.reference)
        ? tx.reference!.trim()
        : isNonEmpty(tx.camt_counterparty_name)
          ? tx.camt_counterparty_name!.trim()
          : isNonEmpty(tx.counter_account)
            ? tx.counter_account!.trim()
            : null,
      ledgerAccountId: tx.grootboekrekening_id ?? null,
      ledgerAccountLabel: account ? formatAccountLabel(account) : null,
      // Bank transactions carry no VAT field.
      vatAmount: null,
    });
  }

  mutations.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));

  return { mutations, excludedBank };
}

// ── Filtering ───────────────────────────────────────────────────────────────

export type LedgerYearFilter = number | "all";

/**
 * Half-open year range, mirroring getYearDateRange in usePurchaseInvoices:
 * >= YYYY-01-01 and < (YYYY+1)-01-01. Re-implemented here (rather than
 * imported) to keep this module free of React/Supabase imports.
 */
export function getLedgerYearRange(year: LedgerYearFilter | undefined): { from: string; to: string } | null {
  if (year === undefined || year === "all" || !Number.isFinite(year as number)) return null;
  const y = year as number;
  return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
}

export interface LedgerMutationFilters {
  source?: LedgerMutationSource | "all";
  year?: LedgerYearFilter;
  /** Only matches mutations that carry a real account FK. */
  ledgerAccountId?: string | "all";
  search?: string;
}

export function filterLedgerMutations(
  mutations: readonly LedgerMutation[],
  filters: LedgerMutationFilters = {},
): LedgerMutation[] {
  const { source = "all", ledgerAccountId = "all", search = "" } = filters;
  const range = getLedgerYearRange(filters.year);
  const q = search.trim().toLowerCase();

  return mutations.filter((m) => {
    if (source !== "all" && m.source !== source) return false;
    // ISO dates compare correctly lexicographically.
    if (range && !(m.date >= range.from && m.date < range.to)) return false;
    // Account filtering is only honest for sources with a real FK; rows without
    // one (all of sales) are excluded rather than fuzzy-matched on free text.
    if (ledgerAccountId !== "all" && m.ledgerAccountId !== ledgerAccountId) return false;
    if (!q) return true;
    return (
      m.description.toLowerCase().includes(q) ||
      (m.reference?.toLowerCase().includes(q) ?? false) ||
      (m.ledgerAccountLabel?.toLowerCase().includes(q) ?? false)
    );
  });
}

/** Years present in the data, newest first — for the year dropdown. */
export function collectLedgerYears(mutations: readonly LedgerMutation[]): number[] {
  const years = new Set<number>();
  for (const m of mutations) {
    const year = Number(m.date.slice(0, 4));
    if (Number.isFinite(year) && year > 0) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}
