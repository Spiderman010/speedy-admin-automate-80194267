import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Upload, CheckCircle2, HelpCircle, Link2, Download, Info, Unlink, ArrowUp, ArrowDown, Search, Zap, RefreshCw, Plus, FileSearch, AlertTriangle, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Landmark } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { parseMT940Description, getDisplayDescription } from "@/lib/mt940-description-parser";
import { ClientMultiSelect, type ClientMultiSelectValue } from "@/components/ClientMultiSelect";
import { useToast } from "@/hooks/use-toast";
import {
  useBankTransactions,
  usePaginatedBankTransactions,
  useAddBankTransaction,
  useUpdateBankTransaction,
  isServerFilterableBankStatus,
  BANK_TRANSACTIONS_PAGE_SIZE,
} from "@/hooks/useBankTransactions";
import { usePurchaseInvoices, useUpdatePurchaseInvoice } from "@/hooks/usePurchaseInvoices";
import { useSalesInvoices, useUpdateSalesInvoice } from "@/hooks/useSalesInvoices";
import { exportBankTransactionsCSV, resolveBankExportGrootboek } from "@/lib/snelstart-export";
import { exportAfletterrapportCSV } from "@/lib/afletterrapport-export";
import { useClients } from "@/hooks/useClients";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useBookingTemplates } from "@/hooks/useBookingTemplates";
import { useCreateVraagpost } from "@/hooks/useVraagposten";
import { useVraagposten } from "@/hooks/useVraagposten";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { BankStatementUploadDialog, type MatchedTransaction } from "@/components/BankStatementUploadDialog";
import { BankMatchDialog, rankCandidates, type InvoiceCandidate } from "@/components/BankMatchDialog";
import { BankAfletteringDrawer } from "@/components/BankAfletteringDrawer";
import { VerwerkingsScherm } from "@/components/VerwerkingsScherm";
import type { Tables } from "@/integrations/supabase/types";
import { getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { useBankTransactionAllocations, useUpsertBankTransactionAllocation, useDeleteAllocationsForTransaction } from "@/hooks/useBankTransactionAllocations";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

type BlockerSource =
  | "blocked_unconfirmed"
  | "blocked_unprocessed"
  | "blocked_manual_invalid"
  | "blocked_missing_1799";

type BlockerRow = { tx: Tables<"bank_transactions">; source: BlockerSource };

const BLOCKER_REASON: Record<BlockerSource, string> = {
  blocked_unconfirmed: "Suggestie nog niet bevestigd",
  blocked_unprocessed: "Nog niet verwerkt",
  blocked_manual_invalid: "Handmatige boeking zonder geldige grootboekrekening",
  blocked_missing_1799: "1799 ontbreekt voor gematchte transactie zonder grootboek",
};

const MATCH_STATUS_NL: Record<string, string> = {
  suggestie: "Suggestie",
  niet_gematcht: "Open",
  gematcht: "Gematcht",
  handmatig_geboekt: "Handmatig geboekt",
};

type SortField = "date" | "amount" | "description" | "status";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

const isOpenTransactionStatus = (matchStatus: string) =>
  matchStatus === "niet_gematcht" || matchStatus === "suggestie";

function expectedInvoiceTypeForTx(tx: Tables<"bank_transactions">): "inkoop" | "verkoop" {
  return tx.amount >= 0 ? "verkoop" : "inkoop";
}

/**
 * Single source of truth for safe auto-confirm criteria. Returns the best
 * invoice candidate iff ALL of the following hold:
 *   - match_status === "suggestie"
 *   - match_confidence >= 90
 *   - candidate has correct direction (inkoop/verkoop)
 *   - candidate is not a partial payment
 *   - |tx_amount − invoice_amount| <= €0.01 (exact match only; ≤€0.50 is NOT safe)
 * Returns null when any criterion fails — caller must fall back to manual review.
 */
function getSafeSuggestionCandidate(
  tx: Tables<"bank_transactions">,
  purchaseInvoices: Tables<"purchase_invoices">[],
  salesInvoices: Tables<"sales_invoices">[],
): InvoiceCandidate | null {
  if (tx.match_status !== "suggestie") return null;
  if ((tx.match_confidence ?? 0) < 90) return null;
  const expectedType = expectedInvoiceTypeForTx(tx);
  const candidates = rankCandidates(
    tx,
    purchaseInvoices.filter(i => i.client_id === tx.client_id),
    salesInvoices.filter(i => i.client_id === tx.client_id),
  );
  const best = candidates.find(c => c.score > 0 && c.type === expectedType && !c.isPartialPayment);
  if (!best) return null;
  const txAmt = Math.abs(tx.amount);
  const invAmt = best.amount != null ? Math.abs(best.amount) : null;
  if (invAmt == null || Math.abs(txAmt - invAmt) > 0.01) return null;
  return best;
}

type SuggestionDetail = {
  best: InvoiceCandidate | null;
  bestIsWrongDirection: boolean; // true when best came from bestAny (no correct-direction candidate)
  isSafe: boolean;
  unsafeReasons: string[];
};

export default function Bank() {
  const [searchParams] = useSearchParams();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  // Klantselectie: standaard leeg. Gebruiker moet eerst kiezen voordat bankdata laadt.
  const [clientSelection, setClientSelection] = useState<ClientMultiSelectValue>(() => {
    const fromUrl = searchParams.get("client");
    const initial = fromUrl ?? selectedClientId;
    if (initial && initial !== "all") {
      return { allMode: false, selectedIds: [initial] };
    }
    return { allMode: false, selectedIds: [] };
  });
  const [statusFilter, setStatusFilter] = useState("all");
  const [vraagpostFilter, setVraagpostFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "high" | "medium" | "low" | "none">("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [matchTx, setMatchTx] = useState<Tables<"bank_transactions"> | null>(null);
  const [matchDialogMode, setMatchDialogMode] = useState<"primary" | "additional">("primary");
  const [additionalMaxAmount, setAdditionalMaxAmount] = useState<number | undefined>(undefined);
  const [additionalExcludedIds, setAdditionalExcludedIds] = useState<string[]>([]);
  const [verwerkingOpen, setVerwerkingOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLedger, setBulkLedger] = useState("");
  const [bulkLedgerId, setBulkLedgerId] = useState("");
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  const [afletteringTx, setAfletteringTx] = useState<Tables<"bank_transactions"> | null>(null);
  const [showExportBlockers, setShowExportBlockers] = useState(true);

  type ExportPreflightData = {
    exportCandidates: Tables<"bank_transactions">[];
    countExported: number;
    countTo1799: number;
    countBlocked: number;
    blockedUnconfirmed: number;
    blockedUnprocessed: number;
    blockedManualInvalid: number;
    blockedMissing1799: number;
    clientName: string | undefined;
    bankDagboek: number;
  };
  const [exportPreflightOpen, setExportPreflightOpen] = useState(false);
  const [exportPreflightData, setExportPreflightData] = useState<ExportPreflightData | null>(null);

  // Sync van sidebar/context naar lokale multiselect: enkel als de context een
  // concrete klant aanwijst overrulen we de huidige selectie. "all" via sidebar
  // wordt bewust genegeerd — gebruiker moet "Alle klanten" expliciet kiezen.
  useEffect(() => {
    if (selectedClientId && selectedClientId !== "all") {
      setClientSelection((prev) => {
        if (!prev.allMode && prev.selectedIds.length === 1 && prev.selectedIds[0] === selectedClientId) {
          return prev;
        }
        return { allMode: false, selectedIds: [selectedClientId] };
      });
    }
  }, [selectedClientId]);

  useEffect(() => {
    setConfidenceFilter("all");
  }, [statusFilter]);

  const { toast } = useToast();

  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);

  // ─ Afgeleide klantselectie voor data-laden ─
  const hasSelection = clientSelection.allMode || clientSelection.selectedIds.length > 0;
  const singleClientId =
    !clientSelection.allMode && clientSelection.selectedIds.length === 1
      ? clientSelection.selectedIds[0]
      : undefined;
  const subsetIdSet = useMemo(
    () => new Set(clientSelection.selectedIds),
    [clientSelection.selectedIds],
  );

  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const { data: bookingTemplates } = useBookingTemplates({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  // Server-side scope: bij "Alle klanten" geen clientIds meegeven (RLS scope = org),
  // bij subset altijd .in(client_id, [...]) op de server toepassen zodat er nooit
  // bankgegevens binnenkomen zonder expliciete klantkeuze.
  const clientIdsForQuery = clientSelection.allMode
    ? undefined
    : clientSelection.selectedIds;
  // Whole-dataset query — powers stats, suggestions, blockers, automatic
  // matching, processing and exports. These must wait for this to load.
  const {
    data: rawTransactions,
    isLoading: wholeSetLoading,
    isError: wholeSetError,
    refetch: refetchWholeSet,
  } = useBankTransactions({
    organizationId: activeOrganizationId ?? undefined,
    clientId: singleClientId,
    clientIds: singleClientId ? undefined : clientIdsForQuery,
    enabled: orgEnabled && hasSelection,
  });
  // Whole-dataset is "ready" only after a successful load; gate all
  // whole-set-dependent UI on this.
  const wholeSetReady = hasSelection && !wholeSetLoading && !wholeSetError && !!rawTransactions;
  const { data: invoices, refetch: refetchPurchase } = usePurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  // Gate the whole-dataset sales fetch the same way as bank transactions:
  // empty selection ⇒ no query; subset ⇒ server-scoped; all-mode ⇒ only after
  // an explicit "all clients" selection.
  const {
    data: salesInvs,
    isLoading: salesLoading,
    isError: salesError,
    refetch: refetchSales,
  } = useSalesInvoices({
    clientId: singleClientId,
    clientIds: singleClientId ? undefined : clientIdsForQuery,
    enabled: orgEnabled && hasSelection,
  });
  // Sales invoices are "ready" only on a successful load. An error must NOT be
  // treated as an empty successful result (which would silently hide matches).
  const salesReady = hasSelection && !salesLoading && !salesError && !!salesInvs;
  // Invoice-dependent matching / reconciliation / afletter-report actions need
  // BOTH the bank transactions and the sales invoices successfully loaded.
  const matchingReady = wholeSetReady && salesReady;
  const addTx = useAddBankTransaction();
  const updateTx = useUpdateBankTransaction();
  const updatePurchase = useUpdatePurchaseInvoice();
  const updateSales = useUpdateSalesInvoice();
  const createVraagpost = useCreateVraagpost();
  const { data: rawVraagposten } = useVraagposten({
    organizationId: activeOrganizationId ?? undefined,
    clientId: singleClientId,
    clientIds: singleClientId ? undefined : clientIdsForQuery,
    enabled: orgEnabled && hasSelection,
  });
  const upsertAllocation = useUpsertBankTransactionAllocation();
  const deleteAllocationsForTx = useDeleteAllocationsForTransaction();
  const { data: rawAllocations } = useBankTransactionAllocations({
    organizationId: activeOrganizationId ?? undefined,
    clientId: singleClientId,
    clientIds: singleClientId ? undefined : clientIdsForQuery,
    enabled: orgEnabled && hasSelection,
  });

  // ─ Subset-filter (meerdere klanten geselecteerd, maar geen "Alle klanten") ─
  const transactions = useMemo(() => {
    if (!rawTransactions) return rawTransactions;
    if (!hasSelection) return [];
    if (clientSelection.allMode || singleClientId) return rawTransactions;
    return rawTransactions.filter((t) => subsetIdSet.has(t.client_id));
  }, [rawTransactions, hasSelection, clientSelection.allMode, singleClientId, subsetIdSet]);

  const vraagposten = useMemo(() => {
    if (!rawVraagposten) return rawVraagposten;
    if (!hasSelection) return [];
    if (clientSelection.allMode || singleClientId) return rawVraagposten;
    return rawVraagposten.filter((v) => subsetIdSet.has(v.client_id));
  }, [rawVraagposten, hasSelection, clientSelection.allMode, singleClientId, subsetIdSet]);

  const allAllocations = useMemo(() => {
    if (!rawAllocations) return rawAllocations;
    if (!hasSelection) return [];
    if (clientSelection.allMode || singleClientId) return rawAllocations;
    return rawAllocations.filter((a) => subsetIdSet.has(a.client_id));
  }, [rawAllocations, hasSelection, clientSelection.allMode, singleClientId, subsetIdSet]);

  const handleClientSelectionChange = useCallback(
    (next: ClientMultiSelectValue) => {
      setClientSelection(next);
      // Houd de sidebar/context in sync: alleen bij precies één klant of "Alle klanten".
      if (next.allMode) {
        setSelectedClientId("all");
      } else if (next.selectedIds.length === 1) {
        setSelectedClientId(next.selectedIds[0]);
      }
    },
    [setSelectedClientId],
  );


  const matched = transactions?.filter((t) => t.match_status === "gematcht").length ?? 0;

  // Compute which niet_gematcht transactions have candidate matches (= suggestions)
  const suggestionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!transactions) return ids;

    for (const t of transactions) {
      if (t.match_status === "suggestie") {
        ids.add(t.id);
        continue;
      }

      if (!invoices || !salesInvs) continue;
      if (t.match_status !== "niet_gematcht") continue;
      const candidates = rankCandidates(
        t,
        invoices.filter(i => i.client_id === t.client_id),
        salesInvs.filter(i => i.client_id === t.client_id),
      );
      if (candidates.some(c => c.score > 0)) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [transactions, invoices, salesInvs]);

  const suggested = suggestionIds.size;
  const unmatched = (transactions?.filter((t) => t.match_status === "niet_gematcht").length ?? 0)
    - (transactions?.filter((t) => t.match_status === "niet_gematcht" && suggestionIds.has(t.id)).length ?? 0);

  // Alle openstaande transacties (niet_gematcht + suggesties) voor de verwerkingsknop
  const openCount = transactions?.filter((t) => isOpenTransactionStatus(t.match_status)).length ?? 0;

  const grootboekrekeningById = useMemo(() => {
    const m = new Map<string, { nummer: number; omschrijving: string }>();
    for (const g of grootboekrekeningen ?? []) m.set(g.id, g);
    return m;
  }, [grootboekrekeningen]);

  const purchaseInvoiceById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof invoices>[number]>();
    for (const i of invoices ?? []) m.set(i.id, i);
    return m;
  }, [invoices]);

  const salesInvoiceById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof salesInvs>[number]>();
    for (const i of salesInvs ?? []) m.set(i.id, i);
    return m;
  }, [salesInvs]);

  const allocationsByTxId = useMemo(() => {
    const m = new Map<string, typeof allAllocations[number][]>();
    for (const a of allAllocations ?? []) {
      const existing = m.get(a.bank_transaction_id);
      if (existing) existing.push(a);
      else m.set(a.bank_transaction_id, [a]);
    }
    return m;
  }, [allAllocations]);

  const vraagpostByBankTransactionId = useMemo(() => {
    const m = new Map<string, NonNullable<typeof vraagposten>[number]>();
    for (const vp of vraagposten ?? []) {
      if (vp.source_type === "bank_transaction" && vp.source_id) {
        m.set(vp.source_id, vp);
      }
    }
    return m;
  }, [vraagposten]);

  // Resolves invoice, checks client consistency, queries live allocation state, and upserts
  // one allocation row. Throws on any error so callers can surface it via toast.
  // explicitAllocationAmount — when provided (manual match dialog), bypasses the auto-cap
  // calculation and uses the user-supplied value, subject to hard safety caps.
  const upsertSingleAllocationForMatch = useCallback(async (
    tx: Tables<"bank_transactions">,
    invoiceId: string,
    explicitAllocationAmount?: number,
  ) => {
    const purchaseInv = invoices?.find(i => i.id === invoiceId);
    const salesInv = salesInvs?.find(i => i.id === invoiceId);
    const inv = purchaseInv ?? salesInv;
    if (!inv) throw new Error(`Factuur ${invoiceId} niet gevonden voor allocatie`);

    if (inv.client_id !== tx.client_id) {
      throw new Error("Factuur en transactie hebben verschillende klanten; allocatie geweigerd");
    }

    const invoiceType: "inkoop" | "verkoop" = purchaseInv ? "inkoop" : "verkoop";
    const txAmount = Math.abs(tx.amount);

    // Fresh query so that concurrent calls inside the same bulk/import loop each see
    // the rows written by the previous iteration — React query cache is not updated
    // synchronously between await calls in the same loop.
    const { data: liveRows, error: fetchError } = await supabase
      .from("bank_transaction_allocations")
      .select("bank_transaction_id, amount")
      .eq("invoice_id", invoiceId);
    if (fetchError) throw fetchError;

    const alreadyAllocated = (liveRows ?? [])
      .filter(r => r.bank_transaction_id !== tx.id)
      .reduce((sum, r) => sum + (r.amount as number), 0);
    const invoiceTotal = Math.abs(getInvoiceTotalAmount(inv) ?? txAmount);
    const allocationOpen = Math.max(0, invoiceTotal - alreadyAllocated);
    const autoAmount = Math.min(txAmount, allocationOpen);

    let allocationAmount: number;
    if (explicitAllocationAmount !== undefined) {
      if (explicitAllocationAmount <= 0)
        throw new Error("Allocatiebedrag moet groter zijn dan 0");
      if (explicitAllocationAmount > txAmount + 0.001)
        throw new Error("Allocatiebedrag is hoger dan het banktransactiebedrag");
      if (explicitAllocationAmount > allocationOpen + 0.001)
        throw new Error("Allocatiebedrag is hoger dan het openstaande factuurbedrag");
      allocationAmount = Math.min(explicitAllocationAmount, txAmount, allocationOpen);
    } else {
      allocationAmount = autoAmount;
      if (allocationAmount <= 0) return; // auto mode: nothing to allocate, skip silently
    }

    await upsertAllocation.mutateAsync({
      bank_transaction_id: tx.id,
      invoice_type: invoiceType,
      invoice_id: invoiceId,
      client_id: tx.client_id,
      amount: allocationAmount,
    });
  }, [invoices, salesInvs, upsertAllocation]);

  // After deleting allocation rows for one or more bank transactions, recalculate
  // remaining_amount for every affected invoice.
  //
  // deletedTxIds  — IDs of bank transactions whose allocation rows were just deleted.
  //                 Their rows are filtered out of allAllocations when summing survivors.
  // extraInvoiceIds — additional invoice IDs to include (e.g. tx.matched_invoice_id) that
  //                   may not appear in bank_transaction_allocations for the deleted txs.
  //                   Invoice type is resolved via purchaseInvoiceById / salesInvoiceById.
  //
  // Uses the in-memory allAllocations cache with the deleted tx IDs filtered out,
  // so no extra round-trip is needed and bulk deletions are handled correctly in one pass.
  const recalculateRemainingAfterDeletions = useCallback(async (
    deletedTxIds: string[],
    extraInvoiceIds: string[] = [],
  ) => {
    if (deletedTxIds.length === 0 && extraInvoiceIds.length === 0) return;
    const deletedSet = new Set(deletedTxIds);

    // Collect unique (invoiceId → invoiceType) from allocation rows of deleted txs
    const affectedInvoices = new Map<string, "inkoop" | "verkoop">();
    for (const txId of deletedTxIds) {
      for (const alloc of allocationsByTxId.get(txId) ?? []) {
        if (!affectedInvoices.has(alloc.invoice_id)) {
          affectedInvoices.set(alloc.invoice_id, alloc.invoice_type);
        }
      }
    }

    // Also include extra invoice IDs (e.g. matched_invoice_id); determine type by lookup
    for (const invoiceId of extraInvoiceIds) {
      if (affectedInvoices.has(invoiceId)) continue; // already covered by allocation rows
      if (purchaseInvoiceById.has(invoiceId)) {
        affectedInvoices.set(invoiceId, "inkoop");
      } else if (salesInvoiceById.has(invoiceId)) {
        affectedInvoices.set(invoiceId, "verkoop");
      }
    }

    for (const [invoiceId, invoiceType] of affectedInvoices.entries()) {
      // Sum surviving allocations for this invoice, excluding all deleted txs
      const allocatedSum = (allAllocations ?? [])
        .filter(a => a.invoice_id === invoiceId && !deletedSet.has(a.bank_transaction_id))
        .reduce((sum, a) => sum + a.amount, 0);

      if (invoiceType === "inkoop") {
        const inv = invoices?.find(i => i.id === invoiceId);
        if (!inv) continue;
        const total = getInvoiceTotalAmount(inv);
        if (total == null) continue;
        const newRemaining = Math.max(0, total - allocatedSum);
        await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
      } else {
        const inv = salesInvs?.find(i => i.id === invoiceId);
        if (!inv) continue;
        const total = getInvoiceTotalAmount(inv);
        if (total == null) continue;
        const newRemaining = Math.max(0, total - allocatedSum);
        if (newRemaining < 0.01) {
          await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
        } else if (inv.status === "betaald") {
          // Allocation removed — invoice is no longer fully paid; reset status
          await updateSales.mutateAsync({ id: invoiceId, status: "gecontroleerd", remaining_amount: newRemaining });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
        }
      }
    }
  }, [allocationsByTxId, allAllocations, purchaseInvoiceById, salesInvoiceById, invoices, salesInvs, updatePurchase, updateSales]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "date" ? "desc" : "asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 inline ml-1" /> : <ArrowDown className="h-3 w-3 inline ml-1" />;
  };

  // Blocker queue: all transactions that prevent a clean SnelStart export,
  // grouped with counts per category and sorted by priority then date desc.
  const blockerQueue = useMemo(() => {
    const gb = grootboekrekeningen ?? [];
    const rows: BlockerRow[] = [];
    let unconfirmed = 0, unprocessed = 0, manualInvalid = 0, missing1799 = 0;
    for (const t of transactions ?? []) {
      const { source } = resolveBankExportGrootboek(t, gb);
      if (source === "blocked_unconfirmed") { rows.push({ tx: t, source }); unconfirmed++; }
      else if (source === "blocked_unprocessed") { rows.push({ tx: t, source }); unprocessed++; }
      else if (source === "blocked_manual_invalid") { rows.push({ tx: t, source }); manualInvalid++; }
      else if (source === "blocked_missing_1799") { rows.push({ tx: t, source }); missing1799++; }
    }
    const priorityOf = (s: BlockerSource) =>
      s === "blocked_unconfirmed" ? 0
      : s === "blocked_unprocessed" ? 1
      : s === "blocked_manual_invalid" ? 2
      : 3;
    rows.sort((a, b) => {
      const pd = priorityOf(a.source) - priorityOf(b.source);
      if (pd !== 0) return pd;
      return new Date(b.tx.transaction_date).getTime() - new Date(a.tx.transaction_date).getTime();
    });
    return { rows, unconfirmed, unprocessed, manualInvalid, missing1799 };
  }, [transactions, grootboekrekeningen]);

  // IDs of transactions that will be exported to 1799 Onbekende betalingen.
  const to1799Ids = useMemo(() => {
    const gb = grootboekrekeningen ?? [];
    const ids = new Set<string>();
    for (const t of transactions ?? []) {
      if (resolveBankExportGrootboek(t, gb).source === "1799") ids.add(t.id);
    }
    return ids;
  }, [transactions, grootboekrekeningen]);

  // Pre-computed display details for each suggestie row.
  // Calls rankCandidates once per suggestion — safeSuggestionIds is then a cheap
  // derived set, avoiding a second rankCandidates pass.
  const suggestionDetailMap = useMemo(() => {
    const map = new Map<string, SuggestionDetail>();
    if (!transactions || !invoices || !salesInvs) return map;
    for (const t of transactions) {
      if (t.match_status !== "suggestie") continue;
      const expectedType = expectedInvoiceTypeForTx(t);
      const candidates = rankCandidates(
        t,
        invoices.filter(i => i.client_id === t.client_id),
        salesInvs.filter(i => i.client_id === t.client_id),
      );
      const bestCorrectDir = candidates.find(c => c.score > 0 && c.type === expectedType) ?? null;
      const bestAny = candidates.find(c => c.score > 0) ?? null;

      const conf = t.match_confidence ?? 0;
      const txAmt = Math.abs(t.amount);
      const invAmt = bestCorrectDir?.amount != null ? Math.abs(bestCorrectDir.amount) : null;
      const isSafe =
        conf >= 90 &&
        bestCorrectDir !== null &&
        !bestCorrectDir.isPartialPayment &&
        invAmt != null &&
        Math.abs(txAmt - invAmt) <= 0.01;

      const unsafeReasons: string[] = [];
      if (!isSafe) {
        if (conf < 90) unsafeReasons.push(`Betrouwbaarheid ${conf}% (minimaal 90% vereist)`);
        if (!bestCorrectDir) {
          unsafeReasons.push(bestAny ? "Verkeerde richting (inkoop/verkoop)" : "Geen factuurkandidaat gevonden");
        } else {
          if (bestCorrectDir.isPartialPayment) unsafeReasons.push("Deelbetaling");
          if (invAmt != null && Math.abs(txAmt - invAmt) > 0.01) {
            unsafeReasons.push(`Bedragverschil ${formatCurrency(Math.abs(txAmt - invAmt))} (max. €0,01)`);
          }
        }
      }

      map.set(t.id, {
        best: bestCorrectDir ?? bestAny,
        bestIsWrongDirection: bestCorrectDir === null && bestAny !== null,
        isSafe,
        unsafeReasons,
      });
    }
    return map;
  }, [transactions, invoices, salesInvs]);

  // Derived from suggestionDetailMap — no extra rankCandidates calls needed.
  const safeSuggestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, detail] of suggestionDetailMap.entries()) {
      if (detail.isSafe) ids.add(id);
    }
    return ids;
  }, [suggestionDetailMap]);

  // Voorspelling van wat één klik op "Automatisch voorstellen" zou doen:
  // - autoConfirm: veilige matches (exacte richting + bedrag, geen deelbetaling) → direct bevestigd
  // - toReview: onzekere kandidaten → als suggestie klaargezet ter beoordeling
  const autoScanPreview = useMemo(() => {
    if (!transactions || !invoices || !salesInvs) return { autoConfirm: 0, toReview: 0 };
    let autoConfirm = 0;
    let toReview = 0;
    for (const t of transactions) {
      if (t.match_status !== "niet_gematcht" && t.match_status !== "suggestie") continue;
      const expectedType = expectedInvoiceTypeForTx(t);
      const candidates = rankCandidates(
        t,
        invoices.filter(i => i.client_id === t.client_id),
        salesInvs.filter(i => i.client_id === t.client_id),
      );
      const best = candidates.find(c => c.score > 0 && c.type === expectedType);
      if (!best) continue;
      const txAmt = Math.abs(t.amount);
      const invAmt = best.amount != null ? Math.abs(best.amount) : null;
      const isExact = invAmt != null && Math.abs(txAmt - invAmt) <= 0.01;
      if (isExact && !best.isPartialPayment) {
        // Alleen tellen als "auto-bevestigen" wanneer het nog niet gematcht is.
        if (t.match_status === "niet_gematcht" || (t.match_status === "suggestie" && (t.match_confidence ?? 0) < 100)) {
          autoConfirm++;
        }
      } else if (t.match_status === "niet_gematcht") {
        toReview++;
      }
    }
    return { autoConfirm, toReview };
  }, [transactions, invoices, salesInvs]);

  const filteredSorted = useMemo(() => {
    if (!transactions) return [];
    let result = [...transactions];

    // Status filter
    if (statusFilter === "open") result = result.filter(t => t.match_status === "niet_gematcht" || t.match_status === "suggestie");
    else if (statusFilter === "gematcht") result = result.filter(t => t.match_status === "gematcht");
    else if (statusFilter === "handmatig") result = result.filter(t => t.match_status === "handmatig_geboekt");
    else if (statusFilter === "blokkeert_export") {
      const gb = grootboekrekeningen ?? [];
      result = result.filter(t => {
        const { source } = resolveBankExportGrootboek(t, gb);
        return source === "blocked_manual_invalid" || source === "blocked_missing_1799" ||
               source === "blocked_unconfirmed" || source === "blocked_unprocessed";
      });
    }
    else if (statusFilter === "niet_in_bankexport") {
      const gb = grootboekrekeningen ?? [];
      result = result.filter(t => resolveBankExportGrootboek(t, gb).source === "1799");
    }

    // Vraagpost filter
    if (vraagpostFilter !== "all") {
      result = result.filter(t => {
        const vp = vraagpostByBankTransactionId.get(t.id);
        if (vraagpostFilter === "without") return !vp;
        if (vraagpostFilter === "with") return !!vp;
        if (vraagpostFilter === "open") return !!vp && (vp.status === "open" || vp.status === "in_behandeling");
        if (vraagpostFilter === "opgelost") return !!vp && vp.status === "opgelost";
        if (vraagpostFilter === "genegeerd") return !!vp && vp.status === "genegeerd";
        return true;
      });
    }

    // Confidence subfilter (only applies when showing open/suggestie rows)
    if (statusFilter === "open" && confidenceFilter !== "all") {
      result = result.filter(t => {
        if (t.match_status !== "suggestie") {
          return confidenceFilter === "none";
        }
        const conf = t.match_confidence ?? -1;
        if (confidenceFilter === "high") return conf >= 90;
        if (confidenceFilter === "medium") return conf >= 60 && conf < 90;
        if (confidenceFilter === "low") return conf >= 0 && conf < 60;
        return false; // "none" only shows niet_gematcht, handled above
      });
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t => {
        const desc = (t.description || "").toLowerCase();
        const ref = (t.reference || "").toLowerCase();
        const counter = (t.counter_account || "").toLowerCase();
        const parsed = parseMT940Description(t.description);
        const name = (parsed.name || "").toLowerCase();
        return desc.includes(q) || ref.includes(q) || counter.includes(q) || name.includes(q);
      });
    }

    // Sort
    result.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      let cmp = 0;
      switch (sortField) {
        case "date": cmp = new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime(); break;
        case "amount": cmp = a.amount - b.amount; break;
        case "description": cmp = (a.description || "").localeCompare(b.description || "", "nl"); break;
        case "status": cmp = a.match_status.localeCompare(b.match_status, "nl"); break;
      }
      if (cmp !== 0) return dir * cmp;
      // Secondary sort: confidence DESC so high-confidence suggestions surface first
      if (statusFilter === "open") {
        const confA = a.match_confidence ?? -1;
        const confB = b.match_confidence ?? -1;
        return confB - confA;
      }
      return 0;
    });

    return result;
  }, [transactions, statusFilter, confidenceFilter, vraagpostFilter, vraagpostByBankTransactionId, searchQuery, sortField, sortDir, grootboekrekeningen]);

  const openTransactions = filteredSorted.filter((t) => isOpenTransactionStatus(t.match_status));

  // Derived filters (blokkeert_export / niet_in_bankexport, confidence,
  // vraagpost) depend on computed values PostgREST cannot express, so those
  // views paginate the whole in-memory set client-side. Everything else uses
  // the server-paginated query below.
  const computedFilterActive =
    !isServerFilterableBankStatus(statusFilter) ||
    (statusFilter === "open" && confidenceFilter !== "all") ||
    vraagpostFilter !== "all";

  const {
    data: pagedData,
    isLoading: isPageLoading,
    isFetching: isPageFetching,
    isError: isPageError,
    refetch: refetchPage,
  } = usePaginatedBankTransactions({
    organizationId: activeOrganizationId ?? undefined,
    clientId: singleClientId,
    clientIds: singleClientId ? undefined : clientIdsForQuery,
    enabled: orgEnabled && hasSelection && !computedFilterActive,
    page,
    search: debouncedSearch,
    status: statusFilter,
    sortField,
    sortDir,
  });

  // Refresh both the whole-dataset query (stats/matching) and the current page.
  const refetch = useCallback(async () => {
    await Promise.all([refetchWholeSet(), refetchPage()]);
  }, [refetchWholeSet, refetchPage]);

  // Table rows + total: server page for simple filters, client-paginated whole
  // set for computed filters.
  const tableRows = computedFilterActive
    ? filteredSorted.slice((page - 1) * BANK_TRANSACTIONS_PAGE_SIZE, page * BANK_TRANSACTIONS_PAGE_SIZE)
    : (pagedData?.transactions ?? []);
  const tableTotal = computedFilterActive ? filteredSorted.length : (pagedData?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(tableTotal / BANK_TRANSACTIONS_PAGE_SIZE));

  // Page-data readiness is independent of whole-dataset matching readiness:
  // simple filters wait only for the paginated query; derived filters depend
  // on the whole dataset, so they follow its loading/error state.
  const tableLoading = computedFilterActive ? wholeSetLoading : isPageLoading;
  const tableError = computedFilterActive ? wholeSetError : isPageError;
  const retryTable = computedFilterActive ? refetchWholeSet : refetchPage;

  // Reset to page 1 when filters, search, sorting or client selection change
  // (not on mount).
  const filterSignature = JSON.stringify([
    debouncedSearch, statusFilter, confidenceFilter, vraagpostFilter, sortField, sortDir,
    clientSelection.allMode, [...subsetIdSet].sort(), activeOrganizationId,
  ]);
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return; }
    setPage(1);
  }, [filterSignature]);

  const handleConfirm = useCallback(async (id: string) => {
    try {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) return;

      // If the transaction already carries a matched_invoice_id (set during import),
      // simply promote the status — do not lose the existing link.
      if (tx.matched_invoice_id) {
        await updateTx.mutateAsync({ id, match_status: "gematcht" });
        await upsertSingleAllocationForMatch(tx, tx.matched_invoice_id);
        toast({ title: "Transactie bevestigd" });
        return;
      }

      // No existing link — try to rank candidates and use the best scoring one.
      const candidates =
        invoices && salesInvs
          ? rankCandidates(
              tx,
              invoices.filter(i => i.client_id === tx.client_id),
              salesInvs.filter(i => i.client_id === tx.client_id),
            )
          : [];
      const expectedType = expectedInvoiceTypeForTx(tx);
      const best = candidates.find(c => c.score > 0 && c.type === expectedType);

      if (best) {
        const exactMatch =
          best.reasons.includes("Exact bedrag") ||
          best.reasons.includes("Bedrag ≈ gelijk (≤€0,50)");
        await updateTx.mutateAsync({
          id,
          match_status: "gematcht",
          matched_invoice_id: best.id,
          match_confidence:
            exactMatch && !best.isPartialPayment ? 100 : best.isPartialPayment ? 60 : 80,
        });
        if (exactMatch && !best.isPartialPayment) {
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
          }
          await upsertSingleAllocationForMatch(tx, best.id);
          toast({ title: "Transactie bevestigd", description: "Factuur status → Betaald" });
        } else {
          await upsertSingleAllocationForMatch(tx, best.id);
          toast({ title: "Transactie bevestigd" });
        }
        return;
      }

      // Open BankMatchDialog so the user picks manually.
      setMatchTx(tx);
      if (candidates.some(c => c.score > 0)) {
        toast({
          title: "Geen veilige match gevonden",
          description: "Alle gevonden matches hebben tegengestelde richting. Koppel handmatig als dit klopt.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Geen automatische factuurkoppeling",
          description: "Selecteer een factuur of boek handmatig.",
          variant: "destructive",
        });
      }
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [transactions, invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, toast]);

  const closeMatchDialog = useCallback(() => {
    setMatchTx(null);
    setMatchDialogMode("primary");
    setAdditionalMaxAmount(undefined);
    setAdditionalExcludedIds([]);
  }, []);

  const handleMatch = useCallback(async (
    transactionId: string,
    invoiceId: string,
    invoiceType: "inkoop" | "verkoop",
    exactMatch: boolean,
    isPartialPayment: boolean,
    remainingAmount: number | null,
    allocationAmount?: number,
  ) => {
    try {
      const tx = transactions?.find(t => t.id === transactionId);

      // Additional mode: only write the new allocation row and update the invoice's remaining_amount.
      // Do NOT overwrite the tx record (matched_invoice_id is already set for the primary invoice).
      if (matchDialogMode === "additional") {
        if (tx && allocationAmount != null && allocationAmount > 0) {
          // Safety guard: block if this invoice is already allocated to the same tx.
          const alreadyAllocated = (allAllocations ?? []).some(
            a => a.bank_transaction_id === transactionId && a.invoice_id === invoiceId,
          );
          if (alreadyAllocated) {
            throw new Error("Deze factuur is al gekoppeld aan deze banktransactie");
          }
          await upsertSingleAllocationForMatch(tx, invoiceId, allocationAmount);

          const purchaseInv = invoices?.find(i => i.id === invoiceId);
          const salesInv = salesInvs?.find(i => i.id === invoiceId);
          if (purchaseInv) {
            const currentRemaining = getInvoiceRemainingAmount(purchaseInv) ?? getInvoiceTotalAmount(purchaseInv) ?? 0;
            const newRemaining = Math.max(0, currentRemaining - allocationAmount);
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          } else if (salesInv) {
            const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? getInvoiceTotalAmount(salesInv) ?? 0;
            const newRemaining = Math.max(0, currentRemaining - allocationAmount);
            if (newRemaining < 0.01) {
              await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
            } else {
              await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
            }
          }

          toast({ title: "Extra factuur gekoppeld" });
        }
        closeMatchDialog();
        return;
      }

      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "gematcht",
        matched_invoice_id: invoiceId,
        match_confidence: exactMatch ? 100 : isPartialPayment ? 60 : 80,
      });

      // Upsert the allocation row first so bank_transaction_allocations is invalidated
      // before the invoice update, allowing the Plus button to appear on next render.
      if (tx) await upsertSingleAllocationForMatch(tx, invoiceId, allocationAmount);

      // Update the invoice's remaining_amount.
      // When the user supplied an explicit allocationAmount, derive newRemaining from it
      // so the stored value matches the actual allocation and not the full tx amount.
      // Fall back to candidate-derived values only when no explicit amount is given
      // (automatic confirm / bulk flows that call handleMatch without allocationAmount).
      let toastRemaining: number | null = remainingAmount;
      if (allocationAmount != null) {
        const purchaseInv = invoices?.find(i => i.id === invoiceId);
        const salesInv = salesInvs?.find(i => i.id === invoiceId);
        if (purchaseInv) {
          const currentRemaining = getInvoiceRemainingAmount(purchaseInv) ?? getInvoiceTotalAmount(purchaseInv) ?? 0;
          const newRemaining = Math.max(0, currentRemaining - allocationAmount);
          toastRemaining = newRemaining;
          await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
        } else if (salesInv) {
          const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? getInvoiceTotalAmount(salesInv) ?? 0;
          const newRemaining = Math.max(0, currentRemaining - allocationAmount);
          toastRemaining = newRemaining;
          if (newRemaining < 0.01) {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          }
        }
      } else if (exactMatch && !isPartialPayment) {
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
        }
      } else if (isPartialPayment && remainingAmount != null) {
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: remainingAmount });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, remaining_amount: remainingAmount });
        }
      }

      if (toastRemaining != null && toastRemaining >= 0.01) {
        toast({ title: "Deelbetaling gekoppeld", description: `Resterend: ${formatCurrency(toastRemaining)}` });
      } else if (allocationAmount != null) {
        toast({ title: "Transactie gekoppeld", description: "Factuur status → Betaald" });
      } else if (exactMatch && !isPartialPayment) {
        toast({ title: "Transactie gekoppeld", description: "Factuur status → Betaald" });
      } else {
        toast({ title: "Transactie gekoppeld" });
      }

      closeMatchDialog();
    } catch (e: any) {
      toast({ title: "Fout bij koppelen", description: e.message, variant: "destructive" });
    }
  }, [matchDialogMode, allAllocations, transactions, invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, closeMatchDialog, toast]);

  const handleUnlink = useCallback(async (tx: Tables<"bank_transactions">) => {
    try {
      // Always include matched_invoice_id as an extra affected invoice so mixed
      // legacy+modern cases (primary via matched_invoice_id, extras via allocation rows)
      // are all recalculated — not just the ones found in allocation rows.
      const extraIds = tx.matched_invoice_id ? [tx.matched_invoice_id] : [];

      await deleteAllocationsForTx.mutateAsync(tx.id);

      await updateTx.mutateAsync({
        id: tx.id,
        match_status: "niet_gematcht",
        matched_invoice_id: null,
        match_confidence: null,
      });

      await recalculateRemainingAfterDeletions([tx.id], extraIds);

      await refetchPurchase();
      await refetchSales();
      toast({ title: "Koppeling verwijderd", description: "Transactie is weer open." });
    } catch (e: any) {
      toast({ title: "Fout bij ontkoppelen", description: e.message, variant: "destructive" });
    }
  }, [recalculateRemainingAfterDeletions, deleteAllocationsForTx, updateTx, refetchPurchase, refetchSales, toast]);

  const handleManualBook = useCallback(async (transactionId: string, ledgerAccount: string, description: string, grootboekrekeningId?: string) => {
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "handmatig_geboekt",
        description: description || undefined,
        grootboekrekening_id: grootboekrekeningId || undefined,
      });
      toast({ title: "Transactie geboekt", description: `Grootboek: ${ledgerAccount}` });
      closeMatchDialog();
    } catch (e: any) {
      toast({ title: "Fout bij boeken", description: e.message, variant: "destructive" });
    }
  }, [updateTx, closeMatchDialog, toast]);

  const handleMaakVraagpost = useCallback(async (tx: Tables<"bank_transactions">) => {
    try {
      const { data: existing } = await supabase
        .from("vraagposten")
        .select("id")
        .eq("source_type", "bank_transaction")
        .eq("source_id", tx.id)
        .maybeSingle();

      if (!existing) {
        const [y, m, d] = tx.transaction_date.split("-");
        const formattedDate = y && m && d ? `${d}-${m}-${y}` : tx.transaction_date;
        const formattedAmount = new Intl.NumberFormat("nl-NL", {
          style: "currency",
          currency: "EUR",
        }).format(tx.amount);

        await createVraagpost.mutateAsync({
          source_type: "bank_transaction",
          source_id: tx.id,
          client_id: tx.client_id,
          titel: tx.description || "Banktransactie zonder factuur",
          omschrijving: `${formattedDate} · ${formattedAmount}`,
          categorie: "bank_zonder_factuur",
        });
        // createVraagpost.mutateAsync throws on failure, so updateTx below is
        // only reached when the vraagpost was successfully created (or already existed).
      }

      const account1605 = grootboekrekeningen?.find(a => a.nummer === 1605);
      await updateTx.mutateAsync({
        id: tx.id,
        match_status: "handmatig_geboekt",
        grootboekrekening_id: account1605?.id ?? undefined,
      });

      toast({ title: existing ? "Vraagpost bestaat al" : "Vraagpost aangemaakt" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [createVraagpost, updateTx, grootboekrekeningen, toast]);

  const handleBulkBook = useCallback(async () => {
    if (selectedIds.size === 0 || !bulkLedger) return;

    const ids = Array.from(selectedIds);
    let success = 0;
    const errors: string[] = [];
    const deletedTxIds: string[] = [];
    const extraInvoiceIds: string[] = [];

    for (const id of ids) {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) continue;

      try {
        // Delete allocation rows before overwriting the link; collect affected invoice IDs
        if (tx.matched_invoice_id) {
          await deleteAllocationsForTx.mutateAsync(id);
          deletedTxIds.push(id);
          extraInvoiceIds.push(tx.matched_invoice_id);
        }

        await updateTx.mutateAsync({
          id,
          match_status: "handmatig_geboekt",
          grootboekrekening_id: bulkLedgerId || undefined,
          matched_invoice_id: null,
          match_confidence: null,
        });
        success++;
      } catch (e: any) {
        console.error("Bulk boeken error:", e);
        errors.push(e.message || "Onbekende fout");
      }
    }

    // Recalculate all affected invoices; wrapped so cleanup always runs
    try {
      await recalculateRemainingAfterDeletions(deletedTxIds, extraInvoiceIds);
    } catch (e: any) {
      errors.push(e.message || "Fout bij herberekenen openstaand bedrag");
    }

    setSelectedIds(new Set());
    setBulkLedger("");
    setBulkLedgerId("");
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (success > 0) {
      toast({ title: `${success} transactie(s) geboekt naar ${bulkLedger}` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij boeken", description: `${errors.length} transactie(s) mislukt: ${errors[0]}`, variant: "destructive" });
    }
  }, [selectedIds, bulkLedger, bulkLedgerId, transactions, deleteAllocationsForTx, updateTx, recalculateRemainingAfterDeletions, toast, refetch, refetchPurchase, refetchSales]);

  const handleBulkUnlink = useCallback(async () => {
    if (selectedIds.size === 0) return;

    const ids = Array.from(selectedIds);
    let success = 0;
    const errors: string[] = [];
    const deletedTxIds: string[] = [];
    const extraInvoiceIds: string[] = [];

    for (const id of ids) {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) continue;

      try {
        await deleteAllocationsForTx.mutateAsync(tx.id);

        await updateTx.mutateAsync({
          id: tx.id,
          match_status: "niet_gematcht",
          matched_invoice_id: null,
          match_confidence: null,
          grootboekrekening_id: null,
        });

        // Always collect the tx ID and its primary invoice so both allocation-backed
        // and legacy-primary invoices are recalculated in the single pass below.
        deletedTxIds.push(tx.id);
        if (tx.matched_invoice_id) extraInvoiceIds.push(tx.matched_invoice_id);

        success++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    // Recalculate all affected invoices in one pass; wrapped so cleanup always runs
    try {
      await recalculateRemainingAfterDeletions(deletedTxIds, extraInvoiceIds);
    } catch (e: any) {
      errors.push(e.message || "Fout bij herberekenen openstaand bedrag");
    }

    setSelectedIds(new Set());
    setConfirmUnlinkOpen(false);
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (success > 0) {
      toast({ title: `${success} transactie(s) ontkoppeld` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij ontkoppelen", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, deleteAllocationsForTx, updateTx, recalculateRemainingAfterDeletions, toast, refetch, refetchPurchase, refetchSales]);

  const handleRepairAflettering = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions) return;

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Step 1: collect eligible tx ids — gematcht, has matched_invoice_id,
    // and the linked invoice still appears unreconciled (remaining ≈ total or null).
    // Group them by matched_invoice_id so each invoice is written only once.
    const groups = new Map<string, { invoiceId: string; txIds: string[] }>();

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx || tx.match_status !== "gematcht" || !tx.matched_invoice_id) continue;

      const inv =
        invoices?.find(i => i.id === tx.matched_invoice_id) ??
        salesInvs?.find(i => i.id === tx.matched_invoice_id);
      if (!inv) { skipped++; continue; }

      const totalAmount = getInvoiceTotalAmount(inv);
      if (totalAmount == null) { skipped++; continue; }

      // Only eligible when remaining_amount is null (never set) or ≈ total (never subtracted)
      const isUnreconciled =
        inv.remaining_amount == null ||
        Math.abs((inv.remaining_amount) - totalAmount) < 0.02;

      if (!isUnreconciled) { skipped++; continue; }

      const existing = groups.get(tx.matched_invoice_id);
      if (existing) {
        existing.txIds.push(id);
      } else {
        groups.set(tx.matched_invoice_id, { invoiceId: tx.matched_invoice_id, txIds: [id] });
      }
    }

    // Step 2: process each invoice group with a single write.
    for (const { invoiceId, txIds } of groups.values()) {
      const purchaseInv = invoices?.find(i => i.id === invoiceId);
      const salesInv = salesInvs?.find(i => i.id === invoiceId);
      const inv = purchaseInv ?? salesInv;
      if (!inv) { skipped += txIds.length; continue; }

      const totalAmount = getInvoiceTotalAmount(inv);
      if (totalAmount == null) { skipped += txIds.length; continue; }

      const startingRemaining = inv.remaining_amount ?? totalAmount;

      // Sum all selected payment amounts for this invoice in one pass
      const totalPayment = txIds.reduce((sum, id) => {
        const tx = transactions.find(t => t.id === id);
        return sum + (tx ? Math.abs(tx.amount) : 0);
      }, 0);

      const newRemaining = Math.max(0, startingRemaining - totalPayment);

      try {
        if (newRemaining < 0.02) {
          if (purchaseInv) {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
          }
        } else {
          if (purchaseInv) {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          }
        }
        updated += txIds.length;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
        skipped += txIds.length;
      }
    }

    await refetchPurchase();
    await refetchSales();

    if (updated > 0) {
      toast({ title: `${updated} aflettering(en) bijgewerkt${skipped > 0 ? `, ${skipped} overgeslagen` : ""}` });
    } else if (skipped > 0) {
      toast({ title: `${skipped} transactie(s) overgeslagen (al afgeletterd of factuur niet gevonden)` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij herberekening", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, invoices, salesInvs, updatePurchase, updateSales, toast, refetchPurchase, refetchSales]);

  const handleBulkConfirmSuggestions = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions || !invoices || !salesInvs) return;

    let confirmed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx) { skipped++; continue; }

      // Use the shared helper — enforces confidence >= 90, correct direction,
      // !isPartialPayment, and amount diff <= €0.01 in one place.
      const best = getSafeSuggestionCandidate(tx, invoices, salesInvs);
      if (!best) { skipped++; continue; }

      try {
        await updateTx.mutateAsync({
          id: tx.id,
          match_status: "gematcht",
          matched_invoice_id: best.id,
          match_confidence: 100,
        });
        if (best.type === "inkoop") {
          await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
        } else {
          await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
        }
        await upsertSingleAllocationForMatch(tx, best.id);
        confirmed++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (confirmed > 0 || skipped > 0) {
      if (skipped > 0) {
        toast({
          title: "Suggesties deels bevestigd",
          description: `${confirmed} suggesties bevestigd. ${skipped} suggesties overgeslagen omdat ze niet veilig genoeg waren.`,
        });
      } else {
        toast({ title: `${confirmed} suggestie(s) bevestigd` });
      }
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij bevestigen", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, toast, refetch, refetchPurchase, refetchSales]);

  const handleBulkRejectSuggestions = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions) return;
    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx || tx.match_status !== "suggestie") { skipped++; continue; }
      try {
        await updateTx.mutateAsync({
          id: tx.id,
          match_status: "niet_gematcht",
          matched_invoice_id: null,
          match_confidence: null,
        });
        processed++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    await refetch();

    if (processed > 0 || skipped > 0) {
      toast({
        title: `${processed} suggestie(s) afgewezen${skipped > 0 ? `. ${skipped} overgeslagen (geen suggestie).` : ""}`,
      });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij afwijzen", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, updateTx, toast, refetch]);

  const handleBulkVraagpost = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions) return;
    const gb = grootboekrekeningen ?? [];
    let created = 0;
    let alreadyExisted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx) { skipped++; continue; }
      const { source } = resolveBankExportGrootboek(tx, gb);
      const eligible = tx.match_status === "niet_gematcht" || source === "blocked_unprocessed";
      if (!eligible) { skipped++; continue; }

      try {
        const { data: existing } = await supabase
          .from("vraagposten")
          .select("id")
          .eq("source_type", "bank_transaction")
          .eq("source_id", tx.id)
          .maybeSingle();

        if (existing) {
          alreadyExisted++;
          continue;
        }

        const [y, m, d] = tx.transaction_date.split("-");
        const formattedDate = y && m && d ? `${d}-${m}-${y}` : tx.transaction_date;
        const formattedAmount = new Intl.NumberFormat("nl-NL", {
          style: "currency",
          currency: "EUR",
        }).format(tx.amount);

        await createVraagpost.mutateAsync({
          source_type: "bank_transaction",
          source_id: tx.id,
          client_id: tx.client_id,
          titel: tx.description || "Banktransactie zonder factuur",
          omschrijving: `${formattedDate} · ${formattedAmount}`,
          categorie: "bank_zonder_factuur",
        });

        created++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    await refetch();

    const parts: string[] = [];
    if (created > 0) parts.push(`${created} vraagpost(en) aangemaakt`);
    if (alreadyExisted > 0) parts.push(`${alreadyExisted} bestonden al`);
    if (skipped > 0) parts.push(`${skipped} overgeslagen (niet in aanmerking)`);
    if (parts.length > 0) {
      toast({ title: parts.join(". ") });
    }
    if (errors.length > 0) {
      toast({
        title: `${errors.length} vraagpost(en) konden niet worden aangemaakt`,
        description: errors[0],
        variant: "destructive",
      });
    }
  }, [selectedIds, transactions, grootboekrekeningen, createVraagpost, toast, refetch]);

  // Automatische stap-na-klantselectie: scan alle open transacties, bevestig veilige
  // matches direct (exact bedrag + juiste richting + geen deelbetaling) en zet
  // onzekere kandidaten klaar als "suggestie" ter beoordeling. Eén klik — de rest
  // hoeft de gebruiker alleen te bevestigen.
  const [autoScanRunning, setAutoScanRunning] = useState(false);
  const [undoingBatch, setUndoingBatch] = useState(false);
  type UndoEntry = {
    txBefore: { id: string; match_status: string; matched_invoice_id: string | null; match_confidence: number | null };
    invoiceBefore?:
      | { type: "inkoop"; id: string; remaining_amount: number | null }
      | { type: "verkoop"; id: string; remaining_amount: number | null; status: string };
    allocation?:
      | { kind: "created"; invoiceId: string }
      | { kind: "existed"; invoiceId: string; amount: number };
  };
  const [lastBatch, setLastBatch] = useState<UndoEntry[] | null>(null);

  const handleAutoScan = useCallback(async () => {
    if (!transactions || !invoices || !salesInvs || autoScanRunning) return;
    setAutoScanRunning(true);
    let confirmed = 0;
    let proposed = 0;
    const errors: string[] = [];
    const undoLog: UndoEntry[] = [];
    for (const t of transactions) {
      if (t.match_status !== "niet_gematcht" && t.match_status !== "suggestie") continue;
      try {
        const expectedType = expectedInvoiceTypeForTx(t);
        const candidates = rankCandidates(
          t,
          invoices.filter(i => i.client_id === t.client_id),
          salesInvs.filter(i => i.client_id === t.client_id),
        );
        const best = candidates.find(c => c.score > 0 && c.type === expectedType);
        if (!best) continue;
        const txAmt = Math.abs(t.amount);
        const invAmt = best.amount != null ? Math.abs(best.amount) : null;
        const isExact = invAmt != null && Math.abs(txAmt - invAmt) <= 0.01;

        if (isExact && !best.isPartialPayment) {
          // Veilig: direct bevestigen + factuur op betaald + allocatie schrijven.
          if (t.match_status === "suggestie" && t.matched_invoice_id === best.id && (t.match_confidence ?? 0) >= 100) continue;

          // Snapshot vóór mutaties voor undo.
          const entry: UndoEntry = {
            txBefore: {
              id: t.id,
              match_status: t.match_status,
              matched_invoice_id: t.matched_invoice_id,
              match_confidence: t.match_confidence,
            },
          };
          if (best.type === "inkoop") {
            const inv = invoices.find(i => i.id === best.id);
            entry.invoiceBefore = { type: "inkoop", id: best.id, remaining_amount: inv?.remaining_amount ?? null };
          } else {
            const inv = salesInvs.find(i => i.id === best.id);
            entry.invoiceBefore = { type: "verkoop", id: best.id, remaining_amount: inv?.remaining_amount ?? null, status: inv?.status ?? "openstaand" };
          }
          const existingAlloc = (allocationsByTxId.get(t.id) ?? []).find(a => a.invoice_id === best.id);
          entry.allocation = existingAlloc
            ? { kind: "existed", invoiceId: best.id, amount: existingAlloc.amount }
            : { kind: "created", invoiceId: best.id };

          await updateTx.mutateAsync({
            id: t.id,
            match_status: "gematcht",
            matched_invoice_id: best.id,
            match_confidence: 100,
          });
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
          }
          await upsertSingleAllocationForMatch(t, best.id);
          undoLog.push(entry);
          confirmed++;
        } else if (t.match_status === "niet_gematcht") {
          // Onzeker: als suggestie klaarzetten voor menselijke controle.
          const conf = best.isPartialPayment ? 60 : 80;
          const entry: UndoEntry = {
            txBefore: {
              id: t.id,
              match_status: t.match_status,
              matched_invoice_id: t.matched_invoice_id,
              match_confidence: t.match_confidence,
            },
          };
          await updateTx.mutateAsync({
            id: t.id,
            match_status: "suggestie",
            matched_invoice_id: best.id,
            match_confidence: conf,
          });
          undoLog.push(entry);
          proposed++;
        }
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }
    setAutoScanRunning(false);
    setLastBatch(undoLog.length > 0 ? undoLog : null);
    await refetch();
    await refetchPurchase();
    await refetchSales();

    const parts: string[] = [];
    if (confirmed > 0) parts.push(`${confirmed} automatisch bevestigd`);
    if (proposed > 0) parts.push(`${proposed} klaargezet ter bevestiging`);
    if (parts.length === 0) parts.push("Geen nieuwe voorstellen gevonden");
    toast({
      title: "Automatisch voorstellen klaar",
      description: parts.join(" · ") + (errors.length ? ` · ${errors.length} fout(en)` : ""),
    });
  }, [transactions, invoices, salesInvs, autoScanRunning, allocationsByTxId, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, refetch, refetchPurchase, refetchSales, toast]);

  const handleUndoLastBatch = useCallback(async () => {
    if (!lastBatch || lastBatch.length === 0 || undoingBatch) return;
    setUndoingBatch(true);
    let reverted = 0;
    const errors: string[] = [];
    // In omgekeerde volgorde terugdraaien.
    for (let i = lastBatch.length - 1; i >= 0; i--) {
      const entry = lastBatch[i];
      try {
        // Allocatie eerst terugdraaien.
        if (entry.allocation) {
          if (entry.allocation.kind === "created") {
            const { error } = await supabase
              .from("bank_transaction_allocations")
              .delete()
              .eq("bank_transaction_id", entry.txBefore.id)
              .eq("invoice_id", entry.allocation.invoiceId);
            if (error) throw error;
          } else {
            const { error } = await supabase
              .from("bank_transaction_allocations")
              .update({ amount: entry.allocation.amount })
              .eq("bank_transaction_id", entry.txBefore.id)
              .eq("invoice_id", entry.allocation.invoiceId);
            if (error) throw error;
          }
        }
        // Factuur terugzetten.
        if (entry.invoiceBefore) {
          if (entry.invoiceBefore.type === "inkoop") {
            await updatePurchase.mutateAsync({
              id: entry.invoiceBefore.id,
              remaining_amount: entry.invoiceBefore.remaining_amount,
            });
          } else {
            await updateSales.mutateAsync({
              id: entry.invoiceBefore.id,
              remaining_amount: entry.invoiceBefore.remaining_amount,
              status: entry.invoiceBefore.status,
            });
          }
        }
        // Transactie terugzetten.
        await updateTx.mutateAsync({
          id: entry.txBefore.id,
          match_status: entry.txBefore.match_status,
          matched_invoice_id: entry.txBefore.matched_invoice_id,
          match_confidence: entry.txBefore.match_confidence,
        });
        reverted++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }
    setUndoingBatch(false);
    setLastBatch(null);
    await refetch();
    await refetchPurchase();
    await refetchSales();
    toast({
      title: "Laatste batch teruggedraaid",
      description: `${reverted} transactie(s) hersteld` + (errors.length ? ` · ${errors.length} fout(en)` : ""),
      variant: errors.length ? "destructive" : undefined,
    });
  }, [lastBatch, undoingBatch, updateTx, updatePurchase, updateSales, refetch, refetchPurchase, refetchSales, toast]);



  // Safe one-click confirm path. Re-evaluates all safe criteria at mutation time
  // so the UI label and the actual write are always in sync. Falls back to opening
  // BankMatchDialog when the criteria are not met (unsafe suggestion or stale data).
  const handleSafeSuggestionConfirm = useCallback(async (t: Tables<"bank_transactions">) => {
    const best = getSafeSuggestionCandidate(t, invoices ?? [], salesInvs ?? []);
    if (!best) {
      setMatchTx(t);
      return;
    }
    try {
      await updateTx.mutateAsync({
        id: t.id,
        match_status: "gematcht",
        matched_invoice_id: best.id,
        match_confidence: 100,
      });
      if (best.type === "inkoop") {
        await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
      } else {
        await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
      }
      await upsertSingleAllocationForMatch(t, best.id);
      toast({ title: "Transactie bevestigd", description: "Factuur status → Betaald" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, toast]);

  const handleRejectSuggestion = useCallback(async (t: Tables<"bank_transactions">) => {
    try {
      await updateTx.mutateAsync({
        id: t.id,
        match_status: "niet_gematcht",
        matched_invoice_id: null,
        match_confidence: null,
      });
      toast({ title: "Suggestie afgewezen" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [updateTx, toast]);

  const handleImport = useCallback(async (importClientId: string, txs: MatchedTransaction[]) => {
    let success = 0;
    let allocationErrors = 0;
    let firstAllocationError = "";
    for (const tx of txs) {
      try {
        const newTx = await addTx.mutateAsync({
          client_id: importClientId,
          transaction_date: tx.date,
          amount: tx.amount,
          description: tx.description,
          counter_account: tx.counterAccount,
          reference: tx.reference,
          camt_ustrd: tx.ustrd ?? null,
          camt_addtl_ntry_inf: tx.addtlNtryInf ?? null,
          camt_counterparty_name: tx.counterpartyName ?? null,
          match_status: tx.matchStatus,
          match_confidence: tx.matchConfidence,
          matched_invoice_id: tx.matchedInvoiceId,
          grootboekrekening_id: tx.grootboekrekeningId ?? undefined,
        });

        // Aflettering: update the linked purchase invoice after a confirmed match
        if (tx.matchedInvoiceId && tx.matchStatus === "gematcht") {
          const purchaseInv = invoices?.find(i => i.id === tx.matchedInvoiceId);
          if (purchaseInv) {
            const txAmount = Math.abs(tx.amount);
            const totalAmount = getInvoiceTotalAmount(purchaseInv);
            const remainingAmount = getInvoiceRemainingAmount(purchaseInv);
            const effectiveRemaining = remainingAmount ?? totalAmount ?? txAmount;
            const isExact = Math.abs(effectiveRemaining - txAmount) < 0.02;
            if (isExact) {
              await updatePurchase.mutateAsync({ id: purchaseInv.id, remaining_amount: 0 });
            } else if (totalAmount != null) {
              const newRemaining = Math.max(0, effectiveRemaining - txAmount);
              await updatePurchase.mutateAsync({ id: purchaseInv.id, remaining_amount: newRemaining });
            }
          }
          if (newTx) {
            try {
              await upsertSingleAllocationForMatch(newTx, tx.matchedInvoiceId);
            } catch (allocErr: any) {
              allocationErrors++;
              if (!firstAllocationError) firstAllocationError = allocErr?.message || "Onbekende fout";
              console.error("Allocation write failed during import:", allocErr);
            }
          }
        }

        success++;
      } catch (e: any) {
        console.error("Import error:", e);
      }
    }
    await refetchPurchase();
    if (allocationErrors > 0) {
      toast({
        title: "Bankafschrift geïmporteerd met waarschuwing",
        description: `${success} transacties geïmporteerd. ${allocationErrors} afletteringen konden niet worden bijgewerkt. Controleer openstaande bedragen.`,
        variant: "destructive",
      });
    } else {
      toast({ title: `${success} van ${txs.length} transacties geïmporteerd` });
    }
  }, [addTx, invoices, salesInvs, updatePurchase, upsertSingleAllocationForMatch, refetchPurchase, toast]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (tableRows.length > 0 && tableRows.every(t => selectedIds.has(t.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tableRows.map(t => t.id)));
    }
  };

  const handleRefreshMatching = useCallback(() => {
    refetch();
    refetchPurchase();
    refetchSales();
  }, [refetch, refetchPurchase, refetchSales]);

  return (
    <>
      <PageHeader title="Bankafschriften" description="Upload en match bankafschriften met facturen">
        <ClientMultiSelect
          clients={clients ?? []}
          value={clientSelection}
          onChange={handleClientSelectionChange}
        />
        <Button variant="outline" disabled={!hasSelection || !wholeSetReady} onClick={() => {
          const exportCandidates = transactions ?? [];
          if (!exportCandidates.length) { toast({ title: "Geen bankregels om te exporteren", variant: "destructive" }); return; }
          const gb = grootboekrekeningen ?? [];
          const sources = exportCandidates.map(t => resolveBankExportGrootboek(t, gb).source);
          const countTo1799 = sources.filter(s => s === "1799").length;
          const countExported = sources.filter(s => s === "own" || s === "1799").length;
          const blockedUnconfirmed = sources.filter(s => s === "blocked_unconfirmed").length;
          const blockedUnprocessed = sources.filter(s => s === "blocked_unprocessed").length;
          const blockedManualInvalid = sources.filter(s => s === "blocked_manual_invalid").length;
          const blockedMissing1799 = sources.filter(s => s === "blocked_missing_1799").length;
          const countBlocked = blockedUnconfirmed + blockedUnprocessed + blockedManualInvalid + blockedMissing1799;
          const clientRecord = singleClientId ? clients?.find(c => c.id === singleClientId) : undefined;
          const clientName = clientRecord?.name;
          const bankDagboek = clientRecord?.bank_dagboek ?? 1100;
          setExportPreflightData({ exportCandidates, countExported, countTo1799, countBlocked, blockedUnconfirmed, blockedUnprocessed, blockedManualInvalid, blockedMissing1799, clientName, bankDagboek });
          setExportPreflightOpen(true);
        }}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
        </Button>
        <Button variant="outline" disabled={!hasSelection || !matchingReady} onClick={() => {
          const clientName = singleClientId ? clients?.find(c => c.id === singleClientId)?.name : undefined;
          const rowCount = exportAfletterrapportCSV(
            allAllocations ?? [],
            transactions ?? [],
            invoices ?? [],
            salesInvs ?? [],
            grootboekrekeningen ?? [],
            clientName,
          );
          if (rowCount === 0) {
            toast({
              title: "Geen afletteringen gevonden",
              description: "Er zijn geen definitief gekoppelde bankregels om te rapporteren.",
              variant: "destructive",
            });
          } else {
            toast({ title: "Afletterrapport aangemaakt", description: `${rowCount} regel(s) geëxporteerd.` });
          }
        }}>
          <Download className="mr-2 h-4 w-4" />Afletterrapport CSV
        </Button>
        <Button
          variant="default"
          onClick={() => setVerwerkingOpen(true)}
          disabled={!hasSelection || !matchingReady || openCount === 0}
        >
          <Zap className="mr-2 h-4 w-4" />
          Verwerken {openCount > 0 && `(${openCount})`}
        </Button>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />Upload afschrift
        </Button>
      </PageHeader>

      {!hasSelection ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <div className="rounded-full bg-primary/10 p-3">
              <Landmark className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <h3 className="font-display text-lg font-semibold">Kies eerst één of meer klanten</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                Bankafschriften worden pas geladen nadat je een klantselectie hebt gemaakt.
                Kies één klant, meerdere klanten, of selecteer expliciet alle klanten.
              </p>
            </div>
            <ClientMultiSelect
              clients={clients ?? []}
              value={clientSelection}
              onChange={handleClientSelectionChange}
              triggerClassName="w-72"
            />
          </CardContent>
        </Card>
      ) : (
      <>
      {(wholeSetError || salesError) && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          <p className="text-sm text-destructive flex-1">
            {wholeSetError && salesError
              ? "Bank- en verkoopgegevens voor matching, statistieken en export laden mislukt."
              : wholeSetError
                ? "Bankgegevens voor matching, statistieken en export laden mislukt."
                : "Verkoopfacturen voor matching en aflettering laden mislukt — matching is uitgeschakeld tot dit is opgelost."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { if (wholeSetError) refetchWholeSet(); if (salesError) refetchSales(); }}
          >
            Opnieuw laden
          </Button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <Card><CardContent className="flex items-center gap-3 p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div><p className="font-display text-xl font-bold">{wholeSetReady ? matched : "–"}</p><p className="text-xs text-muted-foreground">Gematcht</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <Link2 className="h-5 w-5 text-warning" />
          <div><p className="font-display text-xl font-bold">{wholeSetReady ? suggested : "–"}</p><p className="text-xs text-muted-foreground">Suggesties</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <Download className="h-5 w-5 text-muted-foreground" />
          <div><p className="font-display text-xl font-bold">{wholeSetReady ? (transactions?.filter(t => t.match_status === "handmatig_geboekt").length ?? 0) : "–"}</p><p className="text-xs text-muted-foreground">Handmatig geboekt</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <HelpCircle className="h-5 w-5 text-destructive" />
          <div><p className="font-display text-xl font-bold">{wholeSetReady ? unmatched : "–"}</p><p className="text-xs text-muted-foreground">Niet gematcht</p></div>
        </CardContent></Card>
      </div>

      {matchingReady && (autoScanPreview.autoConfirm > 0 || autoScanPreview.toReview > 0 || (lastBatch && lastBatch.length > 0)) && (
        <div className="mb-4 rounded-lg border border-primary/40 bg-primary/5 p-4 flex flex-wrap items-center gap-3">
          <Zap className="h-5 w-5 text-primary shrink-0" />
          <div className="flex-1 min-w-[200px]">
            <p className="text-sm font-medium">Automatisch afletteren</p>
            <p className="text-xs text-muted-foreground">
              {autoScanPreview.autoConfirm > 0 && <>{autoScanPreview.autoConfirm} veilige match{autoScanPreview.autoConfirm !== 1 ? "es" : ""} → direct bevestigen</>}
              {autoScanPreview.autoConfirm > 0 && autoScanPreview.toReview > 0 && " · "}
              {autoScanPreview.toReview > 0 && <>{autoScanPreview.toReview} kandidaat/kandidaten → klaarzetten ter beoordeling</>}
              {autoScanPreview.autoConfirm === 0 && autoScanPreview.toReview === 0 && lastBatch && (
                <>Laatste batch: {lastBatch.length} transactie(s) — herstelbaar</>
              )}
            </p>
          </div>
          {lastBatch && lastBatch.length > 0 && (
            <Button size="sm" variant="outline" onClick={handleUndoLastBatch} disabled={undoingBatch || autoScanRunning}>
              {undoingBatch ? (
                <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Terugdraaien…</>
              ) : (
                <><Unlink className="mr-2 h-4 w-4" />Undo laatste batch ({lastBatch.length})</>
              )}
            </Button>
          )}
          {(() => {
            const safeAvailableCount = safeSuggestionIds.size;
            if (safeAvailableCount === 0) return null;
            let safeUnselectedCount = 0;
            for (const id of safeSuggestionIds) {
              if (!selectedIds.has(id)) safeUnselectedCount++;
            }
            const busy = autoScanRunning || undoingBatch;
            const nothingToAdd = safeUnselectedCount === 0;
            const label = !matchingReady
              ? "Selecteer veilige suggesties…"
              : nothingToAdd
                ? `Alle veilige suggesties geselecteerd (${safeAvailableCount})`
                : `Selecteer alle veilige suggesties (${safeUnselectedCount})`;
            return (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const next = new Set(selectedIds);
                  for (const id of safeSuggestionIds) next.add(id);
                  setSelectedIds(next);
                  toast({
                    title: `${safeUnselectedCount} veilige suggestie(s) geselecteerd`,
                    description: "Klik op 'Veilige suggesties bevestigen' in de balk onderaan om te verwerken.",
                  });
                }}
                disabled={!matchingReady || busy || nothingToAdd}
                aria-label={label}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {label}
              </Button>
            );
          })()}
          {(autoScanPreview.autoConfirm > 0 || autoScanPreview.toReview > 0) && (
            <Button size="sm" onClick={handleAutoScan} disabled={autoScanRunning || undoingBatch}>
              {autoScanRunning ? (
                <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Bezig…</>
              ) : (
                <><Zap className="mr-2 h-4 w-4" />Automatisch voorstellen</>
              )}
            </Button>
          )}
        </div>
      )}



      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoeken op omschrijving, naam, referentie, tegenrekening..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle statussen</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="gematcht">Gematcht</SelectItem>
            <SelectItem value="handmatig">Handmatig geboekt</SelectItem>
            <SelectItem value="blokkeert_export">Blokkeert export</SelectItem>
            <SelectItem value="niet_in_bankexport" title="Betalingen die tijdelijk op tussenrekening 1799 staan.">Onbekende betalingen</SelectItem>
          </SelectContent>
        </Select>
        <Select value={vraagpostFilter} onValueChange={setVraagpostFilter}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle vraagposten</SelectItem>
            <SelectItem value="with">Met vraagpost</SelectItem>
            <SelectItem value="open">Vraagpost open</SelectItem>
            <SelectItem value="opgelost">Vraagpost opgelost</SelectItem>
            <SelectItem value="genegeerd">Vraagpost genegeerd</SelectItem>
            <SelectItem value="without">Zonder vraagpost</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {statusFilter === "open" && (
        <div className="flex flex-wrap gap-2 mb-4">
          {([
            ["all", "Alle"],
            ["high", "≥90%"],
            ["medium", "60–89%"],
            ["low", "<60%"],
            ["none", "Geen suggestie"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setConfidenceFilter(value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                confidenceFilter === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Export blocker queue — only meaningful once the whole dataset loaded.
          Never claim "Geen bankblokkades" while loading or after a failure. */}
      {(() => {
        if (wholeSetError) return null; // the error banner above covers this
        if (!wholeSetReady) {
          return (
            <div className="mb-4 rounded-lg border bg-muted/30 p-3 flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
              <p className="text-sm text-muted-foreground">Bankblokkades controleren…</p>
            </div>
          );
        }
        const { rows, unconfirmed, unprocessed, manualInvalid, missing1799 } = blockerQueue;
        const DISPLAY_LIMIT = 20;
        const shown = rows.slice(0, DISPLAY_LIMIT);
        const remaining = rows.length - shown.length;

        if (rows.length === 0) {
          return (
            <div className="mb-4 rounded-lg border border-green-500/40 bg-green-50 dark:bg-green-950/30 p-3 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-800 dark:text-green-300">Geen bankblokkades voor export</p>
            </div>
          );
        }

        return (
          <div className="mb-4 rounded-lg border border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 flex items-start gap-3 border-b border-amber-500/30">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  {rows.length} bankregel{rows.length !== 1 ? "s" : ""} blokkeren export
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                  {unconfirmed > 0 && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      {unconfirmed} suggestie{unconfirmed !== 1 ? "s" : ""}
                    </span>
                  )}
                  {unprocessed > 0 && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      {unprocessed} niet verwerkt
                    </span>
                  )}
                  {manualInvalid > 0 && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      {manualInvalid} handmatig zonder grootboek
                    </span>
                  )}
                  {missing1799 > 0 && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      {missing1799} 1799 ontbreekt
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowExportBlockers(v => !v)}
                className="shrink-0 text-amber-800 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              >
                {showExportBlockers ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" />
                    Inklappen
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" />
                    Uitklappen
                  </>
                )}
              </Button>
            </div>
            {/* Blocker list */}
            {showExportBlockers && (
              <div>
                {shown.map(({ tx, source }) => (
                  <div key={tx.id} className="px-4 py-2 flex items-start gap-3 border-b border-amber-500/20 last:border-0">
                    <span className="text-xs text-muted-foreground w-20 shrink-0 pt-0.5">
                      {new Date(tx.transaction_date).toLocaleDateString("nl-NL")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-xs font-medium text-foreground truncate max-w-[200px]"
                          title={getDisplayDescription(tx.description, { counterAccount: tx.counter_account, reference: tx.reference })}
                        >
                          {getDisplayDescription(tx.description, { counterAccount: tx.counter_account, reference: tx.reference })}
                        </span>
                        <span className={`text-xs font-mono shrink-0 ${tx.amount < 0 ? "text-destructive" : "text-success"}`}>
                          {formatCurrency(tx.amount)}
                        </span>
                        <Badge variant="outline" className="text-xs shrink-0 px-1.5 py-0">
                          {MATCH_STATUS_NL[tx.match_status] ?? tx.match_status}
                        </Badge>
                      </div>
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                        {BLOCKER_REASON[source]}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {showExportBlockers && remaining > 0 && (
              <div className="px-4 py-2 border-t border-amber-500/30">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Nog {remaining} blokkade{remaining !== 1 ? "s" : ""} niet getoond
                </p>
              </div>
            )}
          </div>
        );
      })()}

      <Card>
        <CardContent className="overflow-x-auto p-6">
          {tableLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : tableError ? (
            <div className="py-12 text-center text-muted-foreground space-y-3">
              <p className="text-destructive">Banktransacties laden mislukt.</p>
              <Button variant="outline" size="sm" onClick={() => retryTable()}>Opnieuw proberen</Button>
            </div>
          ) : !tableRows.length ? (
            <div className="py-12 text-center text-muted-foreground">
              {tableTotal || transactions?.length ? "Geen transacties gevonden met deze filters." : "Nog geen transacties. Upload een bankafschrift om te beginnen."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={tableRows.length > 0 && tableRows.every(t => selectedIds.has(t.id))}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("description")}>Omschrijving<SortIcon field="description" /></TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                  <TableHead>Betrouwbaarheid</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("status")}>Status<SortIcon field="status" /></TableHead>
                  <TableHead>Gekoppeld aan</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.map((t) => {
                  const isOpen = isOpenTransactionStatus(t.match_status);
                  const isSuggestion = suggestionIds.has(t.id);
                  const txAbsAmt = Math.abs(t.amount);
                  const allocationsForTx = allocationsByTxId.get(t.id) ?? [];
                  const hasAllocationRows = allocationsForTx.length > 0;
                  const allocatedForTx = allocationsForTx.reduce((sum, a) => sum + a.amount, 0);
                  const unallocatedAmount = Math.max(0, txAbsAmt - allocatedForTx);
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(t.id)}
                          onCheckedChange={() => toggleSelect(t.id)}
                        />
                      </TableCell>
                      <TableCell>{new Date(t.transaction_date).toLocaleDateString("nl-NL")}</TableCell>
                      <TableCell className="max-w-xs">
                        <div className="flex items-center gap-1">
                          <span className="truncate">{getDisplayDescription(t.description, { counterAccount: t.counter_account, reference: t.reference })}</span>
                          {t.description && (() => {
                            const p = parseMT940Description(t.description);
                            return (p.name || p.iban || p.reference) ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom" align="start" className="max-w-sm text-xs space-y-1">
                                    {p.name && <div><span className="text-muted-foreground">Naam:</span> {p.name}</div>}
                                    {p.iban && <div><span className="text-muted-foreground">Tegenrekening:</span> {p.iban}</div>}
                                    {p.reference && <div><span className="text-muted-foreground">Referentie:</span> {p.reference}</div>}
                                    <div className="pt-1 border-t text-muted-foreground break-all">{p.raw}</div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : null;
                          })()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={`font-mono ${t.amount < 0 ? "text-destructive" : "text-success"}`}>
                          {formatCurrency(t.amount)}
                        </span>
                        {t.matched_invoice_id && (() => {
                          const inv =
                            invoices?.find(i => i.id === t.matched_invoice_id) ??
                            salesInvs?.find(i => i.id === t.matched_invoice_id);
                          if (!inv) return null;
                          const total = getInvoiceTotalAmount(inv);
                          const remaining = getInvoiceRemainingAmount(inv);
                          if (total == null) return null;

                          const fullyPaid = remaining != null && Math.abs(remaining) < 0.01;
                          const isPartial = remaining != null && remaining > 0.01 && remaining < total - 0.01;
                          const notAfgeletterd = remaining != null && remaining >= total - 0.01 && !fullyPaid;
                          const paidAmount = remaining != null ? Math.max(0, total - remaining) : 0;

                          return (
                            <div className="mt-0.5 space-y-0.5">
                              {fullyPaid ? (
                                <p className="text-xs text-success">Volledig betaald</p>
                              ) : isPartial ? (
                                <>
                                  <p className="text-xs font-medium text-amber-600">Deelbetaling</p>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(paidAmount)}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining)}
                                  </p>
                                </>
                              ) : notAfgeletterd ? (
                                <>
                                  <p className="text-xs font-medium text-destructive">Nog niet afgeletterd</p>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(0)}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining ?? total)}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(total - (remaining ?? total))}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining ?? total)}
                                  </p>
                                </>
                              )}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        {t.match_confidence != null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 rounded-full bg-secondary">
                              <div className="h-full rounded-full bg-primary" style={{ width: `${t.match_confidence}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground">{t.match_confidence}%</span>
                          </div>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 items-start">
                          <Badge variant={
                            t.match_status === "gematcht" ? "default"
                            : t.match_status === "handmatig_geboekt" ? "secondary"
                            : isSuggestion ? "secondary"
                            : "destructive"
                          }>
                            {t.match_status === "gematcht" ? "Gematcht"
                             : t.match_status === "handmatig_geboekt" ? "Handmatig geboekt"
                             : isSuggestion ? "Suggestie"
                             : "Open"}
                          </Badge>
                          {t.match_status === "handmatig_geboekt" && !t.grootboekrekening_id && (
                            <Badge variant="outline" className="text-xs w-fit border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                              Blokkeert export
                            </Badge>
                          )}
                          {t.match_status === "suggestie" && (
                            <Badge variant="outline" className="text-xs w-fit border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                              Blokkeert export
                            </Badge>
                          )}
                          {to1799Ids.has(t.id) && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className="text-xs w-fit cursor-default">
                                    → 1799
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Wordt geëxporteerd op 1799 Onbekende betalingen. Gebruik het Afletterrapport CSV om dit in SnelStart af te letteren.
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          // Determine the booking/link label
                          let label = "—";
                          let isOrphanMatch = false;
                          if (t.matched_invoice_id) {
                            const pi = purchaseInvoiceById.get(t.matched_invoice_id);
                            if (pi) {
                              label = `Inkoopfactuur: ${pi.supplier}${pi.invoice_number ? ` · ${pi.invoice_number}` : ""}`;
                            } else {
                              const si = salesInvoiceById.get(t.matched_invoice_id);
                              if (si) label = `Verkoopfactuur: ${si.customer_name} · ${si.invoice_number}`;
                            }
                          } else if (t.match_status === "gematcht") {
                            // Gematcht but no invoice id stored — flag as orphan so user knows
                            label = "Gematcht zonder factuurkoppeling";
                            isOrphanMatch = true;
                          } else if (t.match_status === "handmatig_geboekt" && t.grootboekrekening_id) {
                            const gb = grootboekrekeningById.get(t.grootboekrekening_id);
                            if (gb) label = `${gb.nummer} - ${gb.omschrijving}`;
                          }
                          const vp = vraagpostByBankTransactionId.get(t.id);
                          const vpBadge = (() => {
                            if (!vp) return null;
                            if (vp.status === "opgelost") {
                              return (
                                <Badge variant="outline" className="text-xs w-fit border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200">
                                  Vraagpost opgelost
                                </Badge>
                              );
                            }
                            if (vp.status === "genegeerd") {
                              return (
                                <Badge variant="secondary" className="text-xs w-fit">
                                  Vraagpost genegeerd
                                </Badge>
                              );
                            }
                            return (
                              <Badge variant="outline" className="text-xs w-fit border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                                Vraagpost open
                              </Badge>
                            );
                          })();
                          return (
                            <div className="flex flex-col gap-1 min-w-0">
                              {t.match_status !== "suggestie" && (
                                <span
                                  className={`text-sm truncate max-w-[200px] block ${isOrphanMatch ? "text-amber-600 dark:text-amber-400" : ""}`}
                                  title={label}
                                >{label}</span>
                              )}
                              {t.match_status === "suggestie" && (() => {
                                const detail = suggestionDetailMap.get(t.id);
                                if (!detail) return <span className="text-sm text-muted-foreground">—</span>;
                                const { best, bestIsWrongDirection, isSafe, unsafeReasons } = detail;
                                return (
                                  <div className="space-y-1">
                                    {isSafe ? (
                                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
                                        <CheckCircle2 className="h-3 w-3" /> Veilig te bevestigen
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                                        <AlertTriangle className="h-3 w-3" /> Controle nodig
                                      </span>
                                    )}
                                    {best && !bestIsWrongDirection && (
                                      <div className="text-xs space-y-0.5">
                                        <div
                                          className="font-medium truncate max-w-[200px]"
                                          title={`${best.type === "inkoop" ? "Inkoop" : "Verkoop"} · ${best.name}${best.invoiceNumber ? ` · ${best.invoiceNumber}` : ""}`}
                                        >
                                          {best.type === "inkoop" ? "Inkoop" : "Verkoop"} · {best.name}
                                          {best.invoiceNumber ? ` · ${best.invoiceNumber}` : ""}
                                        </div>
                                        <div className="text-muted-foreground">
                                          {best.date && `${new Date(best.date).toLocaleDateString("nl-NL")} · `}
                                          {best.amount != null ? formatCurrency(Math.abs(best.amount)) : "—"}
                                          {best.amount != null && (() => {
                                            const diff = Math.abs(Math.abs(t.amount) - Math.abs(best.amount));
                                            return diff > 0.005
                                              ? <span className="text-amber-600 dark:text-amber-400"> (Δ {formatCurrency(diff)})</span>
                                              : null;
                                          })()}
                                        </div>
                                        {best.reasons.length > 0 && (
                                          <div className="text-muted-foreground italic">
                                            {best.reasons.slice(0, 2).join(" · ")}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {best && bestIsWrongDirection && (
                                      <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                                        Afgewezen kandidaat: verkeerde richting
                                      </div>
                                    )}
                                    {!isSafe && unsafeReasons.length > 0 && (
                                      <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                                        {unsafeReasons.map((r, i) => <div key={i}>• {r}</div>)}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {vpBadge}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button size="sm" variant="ghost" onClick={() => setAfletteringTx(t)}>
                                  <FileSearch className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Bekijk aflettering</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          {t.match_status === "gematcht" || t.match_status === "handmatig_geboekt" ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => {
                                    if (t.match_status === "handmatig_geboekt") {
                                      updateTx.mutateAsync({
                                        id: t.id,
                                        match_status: "niet_gematcht",
                                        grootboekrekening_id: null,
                                      }).then(() => {
                                        toast({ title: "Handmatige boeking verwijderd", description: "Transactie is weer open." });
                                      });
                                    } else {
                                      handleUnlink(t);
                                    }
                                  }}>
                                    <Unlink className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Ontkoppelen</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : t.match_status === "suggestie" ? (
                            <>
                              <Button
                                size="sm"
                                variant={safeSuggestionIds.has(t.id) ? "default" : "outline"}
                                onClick={() => safeSuggestionIds.has(t.id)
                                  ? handleSafeSuggestionConfirm(t)
                                  : setMatchTx(t)
                                }
                              >
                                {safeSuggestionIds.has(t.id) ? "✓ Bevestig" : "Controleer"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground text-xs"
                                onClick={() => handleRejectSuggestion(t)}
                              >
                                Afwijzen
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setMatchTx(t)}>
                              Koppel
                            </Button>
                          )}
                          {t.match_status === "gematcht" && hasAllocationRows && unallocatedAmount >= 0.01 && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => {
                                    const alreadyIds = allocationsForTx.map(a => a.invoice_id);
                                    setAdditionalExcludedIds(alreadyIds);
                                    setMatchDialogMode("additional");
                                    setAdditionalMaxAmount(unallocatedAmount);
                                    setMatchTx(t);
                                  }}>
                                    <Plus className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Extra factuur koppelen ({formatCurrency(unallocatedAmount)} resterend)</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {isOpen && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => handleMaakVraagpost(t)}>
                                    <HelpCircle className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Maak vraagpost</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {!tableLoading && !tableError && tableTotal > 0 && (
            <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t pt-4">
              <span className="text-sm text-muted-foreground">
                {(page - 1) * BANK_TRANSACTIONS_PAGE_SIZE + 1}–{Math.min(page * BANK_TRANSACTIONS_PAGE_SIZE, tableTotal)} van {tableTotal} transacties
                {computedFilterActive ? " · afgeleide filter binnen huidige selectie" : ""}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 1 || isPageFetching}
                  onClick={() => setPage(p => Math.max(1, p - 1))}>
                  <ChevronLeft className="h-4 w-4 mr-1" />Vorige
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || isPageFetching}
                  onClick={() => setPage(p => p + 1)}>
                  Volgende<ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bulk boeken toolbar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-background border rounded-lg shadow-lg px-6 py-3 flex items-center gap-4 flex-wrap max-w-5xl">
          <span className="text-sm font-medium">{selectedIds.size} transactie(s) geselecteerd</span>
          {(() => {
            const safeCount = Array.from(selectedIds).filter(id => safeSuggestionIds.has(id)).length;
            return safeCount > 0 ? (
              <Button size="sm" variant="default" onClick={handleBulkConfirmSuggestions}>
                <CheckCircle2 className="mr-1 h-4 w-4" />
                Veilige suggesties bevestigen ({safeCount})
              </Button>
            ) : null;
          })()}
          {(() => {
            const rejectCount = Array.from(selectedIds).filter(id => {
              const tx = transactions?.find(t => t.id === id);
              return tx?.match_status === "suggestie";
            }).length;
            return rejectCount > 0 ? (
              <Button size="sm" variant="outline" onClick={handleBulkRejectSuggestions}>
                Suggesties afwijzen ({rejectCount})
              </Button>
            ) : null;
          })()}
          {(() => {
            const gb = grootboekrekeningen ?? [];
            const vraagpostCount = Array.from(selectedIds).filter(id => {
              const tx = transactions?.find(t => t.id === id);
              if (!tx) return false;
              const { source } = resolveBankExportGrootboek(tx, gb);
              return tx.match_status === "niet_gematcht" || source === "blocked_unprocessed";
            }).length;
            return vraagpostCount > 0 ? (
              <Button size="sm" variant="outline" onClick={handleBulkVraagpost}>
                <HelpCircle className="mr-1 h-4 w-4" />
                Naar vraagpost ({vraagpostCount})
              </Button>
            ) : null;
          })()}
          <div className="w-64">
            <GrootboekCombobox value={bulkLedger} onValueChange={setBulkLedger} onIdChange={setBulkLedgerId} />
          </div>
          {(() => {
            const repairCount = Array.from(selectedIds).filter(id => {
              const tx = transactions?.find(t => t.id === id);
              return tx?.match_status === "gematcht" && tx.matched_invoice_id != null;
            }).length;
            return repairCount > 0 ? (
              <Button size="sm" variant="outline" onClick={handleRepairAflettering}>
                <RefreshCw className="mr-1 h-4 w-4" />
                Herbereken aflettering ({repairCount})
              </Button>
            ) : null;
          })()}
          <Button size="sm" onClick={handleBulkBook} disabled={!bulkLedger}>
            Boek geselecteerde transacties
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (selectedIds.size > 1) {
                setConfirmUnlinkOpen(true);
              } else {
                handleBulkUnlink();
              }
            }}
          >
            <Unlink className="mr-1 h-4 w-4" />
            Ontkoppel geselecteerde
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelectedIds(new Set()); setBulkLedger(""); setBulkLedgerId(""); }}>
            Annuleren
          </Button>
        </div>
      )}
      </>
      )}



      <AlertDialog open={confirmUnlinkOpen} onOpenChange={setConfirmUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transacties ontkoppelen</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je {selectedIds.size} transacties wilt ontkoppelen? Dit reset ze naar "Niet gematcht" en keert eventuele factuurwijzigingen terug.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkUnlink}>Ontkoppelen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <VerwerkingsScherm
        open={verwerkingOpen}
        onOpenChange={setVerwerkingOpen}
        transactions={transactions ?? []}
        purchaseInvoices={invoices ?? []}
        salesInvoices={salesInvs ?? []}
        onBookPrivate={async (id) => {
          await updateTx.mutateAsync({ id, match_status: "handmatig_geboekt", grootboekrekening_id: undefined });
          toast({ title: "Privé geboekt" });
          refetch();
        }}
        onBookLedger={async (id, ledgerText, ledgerId) => {
          await updateTx.mutateAsync({ id, match_status: "handmatig_geboekt", grootboekrekening_id: ledgerId || undefined });
          toast({ title: `Geboekt: ${ledgerText}` });
          refetch();
        }}
        onMatchInvoice={async (id, invoiceId, invoiceType) => {
          await updateTx.mutateAsync({ id, match_status: "gematcht", matched_invoice_id: invoiceId, match_confidence: 100 });
          if (invoiceType === "inkoop") {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
          }
          const matchedTx = transactions?.find(t => t.id === id);
          if (matchedTx) {
            try {
              await upsertSingleAllocationForMatch(matchedTx, invoiceId);
            } catch (e: any) {
              toast({ title: "Allocatierij niet aangemaakt", description: e.message, variant: "destructive" });
            }
          }
          toast({ title: "Factuur gekoppeld" });
          refetch();
          refetchPurchase();
          refetchSales();
        }}
        onSkip={(id) => {
          toast({ title: "Transactie overgeslagen" });
        }}
      />

      <BankStatementUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        clients={clients ?? []}
        invoices={invoices ?? []}
        onImport={handleImport}
        existingTransactions={transactions ?? []}
        bookingTemplates={bookingTemplates ?? []}
        defaultClientId={singleClientId}
      />

      <BankAfletteringDrawer
        open={!!afletteringTx}
        onOpenChange={(v) => { if (!v) setAfletteringTx(null); }}
        transaction={afletteringTx}
        allocations={afletteringTx ? (allocationsByTxId.get(afletteringTx.id) ?? []) : []}
        allAllocations={allAllocations ?? []}
        purchaseInvoices={
          afletteringTx?.client_id
            ? (invoices ?? []).filter(i => i.client_id === afletteringTx.client_id)
            : []
        }
        salesInvoices={
          afletteringTx?.client_id
            ? (salesInvs ?? []).filter(i => i.client_id === afletteringTx.client_id)
            : []
        }
      />

      <BankMatchDialog
        open={!!matchTx}
        onOpenChange={(v) => { if (!v) closeMatchDialog(); }}
        transaction={matchTx}
        purchaseInvoices={
          matchTx?.client_id
            ? (invoices ?? []).filter(i => i.client_id === matchTx.client_id)
            : []
        }
        salesInvoices={
          matchTx?.client_id
            ? (salesInvs ?? []).filter(i => i.client_id === matchTx.client_id)
            : []
        }
        onConfirm={handleMatch}
        onManualBook={handleManualBook}
        onRefresh={handleRefreshMatching}
        maxAllocationAmount={matchDialogMode === "additional" ? additionalMaxAmount : undefined}
        alreadyAllocatedAmount={matchDialogMode === "additional" && matchTx
          ? (allocationsByTxId.get(matchTx.id) ?? []).reduce((s, a) => s + a.amount, 0)
          : undefined}
        excludedInvoiceIds={matchDialogMode === "additional" ? additionalExcludedIds : undefined}
      />

      <Dialog open={exportPreflightOpen} onOpenChange={setExportPreflightOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Bankexport controleren</DialogTitle>
          </DialogHeader>
          {exportPreflightData && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Wordt geëxporteerd</span>
                  <span className="font-medium">{exportPreflightData.countExported}</span>
                </div>
                {exportPreflightData.countTo1799 > 0 && (
                  <div className="flex justify-between text-sm text-amber-700 dark:text-amber-400">
                    <span>Tijdelijk op 1799</span>
                    <span className="font-medium">{exportPreflightData.countTo1799}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className={exportPreflightData.countBlocked > 0 ? "text-destructive font-medium" : ""}>
                    Blokkeert export
                  </span>
                  <span className={`font-medium ${exportPreflightData.countBlocked > 0 ? "text-destructive" : ""}`}>
                    {exportPreflightData.countBlocked}
                  </span>
                </div>
              </div>

              {exportPreflightData.countBlocked > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-sm font-medium text-destructive">
                    Los eerst de blokkerende bankregels op. Gebruik filter 'Blokkeert export'.
                  </p>
                  <ul className="text-xs text-destructive/80 space-y-1">
                    {exportPreflightData.blockedUnconfirmed > 0 && (
                      <li>• {exportPreflightData.blockedUnconfirmed} suggestie(s)</li>
                    )}
                    {exportPreflightData.blockedUnprocessed > 0 && (
                      <li>• {exportPreflightData.blockedUnprocessed} niet gematcht/open</li>
                    )}
                    {exportPreflightData.blockedManualInvalid > 0 && (
                      <li>• {exportPreflightData.blockedManualInvalid} handmatig zonder geldige grootboekrekening</li>
                    )}
                    {exportPreflightData.blockedMissing1799 > 0 && (
                      <li>• {exportPreflightData.blockedMissing1799} ontbrekende 1799</li>
                    )}
                  </ul>
                </div>
              )}

              {exportPreflightData.countBlocked === 0 && exportPreflightData.countTo1799 > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3">
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    Deze bankregels worden tijdelijk geboekt op 1799 Onbekende betalingen. Download ook het Afletterrapport CSV om ze in SnelStart sneller af te letteren.
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportPreflightOpen(false)}>Annuleren</Button>
            <Button
              disabled={!exportPreflightData || exportPreflightData.countBlocked > 0}
              onClick={() => {
                if (!exportPreflightData) return;
                const meta = exportBankTransactionsCSV(
                  exportPreflightData.exportCandidates,
                  grootboekrekeningen ?? [],
                  exportPreflightData.clientName,
                  exportPreflightData.bankDagboek,
                );
                setExportPreflightOpen(false);
                let description = `${meta.exportedTransactions} bankregel(s) geëxporteerd.`;
                if (meta.bookedTo1799 > 0) {
                  description += ` ${meta.bookedTo1799} afgeletterde bankregel(s) geboekt op 1799 Onbekende betalingen.`;
                }
                toast({ title: "Bankexport aangemaakt", description });
              }}
            >
              <Download className="mr-2 h-4 w-4" />Download bankexport
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
