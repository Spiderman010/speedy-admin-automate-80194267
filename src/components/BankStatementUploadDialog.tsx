import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, FileText, Loader2, CheckCircle2, AlertCircle, X, AlertTriangle, Copy, Ban } from "lucide-react";
import {
  parseBankStatementFull,
  detectDuplicates,
  importFingerprints,
  statementImportBlockers,
  checkStatementAccount,
  accountCheckBlocker,
  type ParsedStatement,
  type ParsedTransaction,
  type DuplicateInfo,
  type ExistingBankTransactionForDuplicates,
  type StatementAccountCheck,
  type StatementAccountClient,
  type StatementImportBlocker,
} from "@/lib/bank-statement-parser";
import { gatedInvoiceCandidates, NO_REJECTIONS, preselectCandidate } from "@/lib/bank-candidate-gate";
import { applyBookingTemplatesToTransactions } from "@/lib/booking-template-utils";
import type { InvoiceCandidate } from "@/components/BankMatchDialog";
import type { Tables } from "@/integrations/supabase/types";
import type { BookingTemplate } from "@/hooks/useBookingTemplates";

type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The administraties of the active organisation, with their registered IBANs. */
  clients: StatementAccountClient[];
  /** Purchase invoices the page has loaded; only those of the import client are used. */
  invoices: PurchaseInvoice[];
  /** Sales invoices the page has loaded; only those of the import client are used. */
  salesInvoices?: SalesInvoice[];
  /** Resolves `false` when the import did not start at all: the preview then stays open. */
  onImport: (clientId: string, transactions: MatchedTransaction[]) => Promise<void | false>;
  /**
   * Loads every stored bank transaction of exactly this client, fresh from the
   * server. Duplicates are checked against this — never against whatever the
   * bank page happens to have loaded for its own client filter.
   */
  loadExistingTransactions: (clientId: string) => Promise<ExistingBankTransactionForDuplicates[]>;
  bookingTemplates?: BookingTemplate[];
  defaultClientId?: string;
}

export interface MatchedTransaction extends ParsedTransaction {
  matchedInvoiceId: string | null;
  matchConfidence: number | null;
  /**
   * Never "gematcht": the import only proposes an invoice. Linking a payment,
   * and with it the payment status and the open amount of the invoice, is a
   * separate, confirmed step that the database derives (D1).
   */
  matchStatus: "suggestie" | "niet_gematcht" | "handmatig_geboekt";
  matchedInvoiceLabel: string | null;
  grootboekrekeningId?: string | null;
  btwPercentage?: number | null;
  /** Database idempotency key (20261020120000), computed over the whole statement. */
  importFingerprint?: string | null;
  /** Stored as import_source (20261020120000), so the reference is read right later. */
  importSource?: "mt940" | "camt053" | null;
  grootboekText?: string | null;
  templateName?: string | null;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

function candidateLabel(c: InvoiceCandidate) {
  const amt = c.amount != null ? ` (${formatCurrency(c.amount)} open)` : "";
  return `${c.name} - ${c.invoiceNumber || "?"}${amt}`;
}

function withSuggestion(tx: ParsedTransaction, candidate: InvoiceCandidate | null): MatchedTransaction {
  return {
    ...tx,
    matchedInvoiceId: candidate?.id ?? null,
    matchConfidence: candidate ? Math.min(candidate.score, 100) : null,
    matchStatus: candidate ? "suggestie" : "niet_gematcht",
    matchedInvoiceLabel: candidate ? candidateLabel(candidate) : null,
  };
}

const ACCOUNT_CONFIRM_TEXT: Record<Extract<StatementAccountCheck, { status: "confirm" }>["reason"], (client: string, iban: string | null, others: string[]) => string> = {
  no_statement_iban: (client) =>
    `Het afschrift noemt geen herkenbaar IBAN. Er kan dus niet worden gecontroleerd of het bij ${client} hoort.`,
  no_client_iban: (client, iban) =>
    `${client} heeft geen IBAN vastgelegd, en rekening ${iban} is bij geen enkele administratie bekend.`,
  different_iban: (client, iban) =>
    `Rekening ${iban} is niet het vastgelegde IBAN van ${client}, en hoort ook niet bij een andere administratie.`,
  shared_iban: (client, iban, others) =>
    `Rekening ${iban} is vastgelegd bij ${client}, maar ook bij ${others.join(", ")}.`,
};

export const DUPLICATE_CHECK_FAILED_MESSAGE =
  "De bestaande banktransacties van deze klant konden niet worden geladen. Importeren is geblokkeerd, zodat er geen dubbele transacties ontstaan. Probeer het opnieuw.";

export function BankStatementUploadDialog({ open, onOpenChange, clients, invoices, salesInvoices = [], onImport, loadExistingTransactions, bookingTemplates = [], defaultClientId }: Props) {
  const [clientId, setClientId] = useState(defaultClientId ?? "");

  // Sync clientId whenever the dialog (re-)opens with a preselected client
  useEffect(() => {
    if (open) setClientId(defaultClientId ?? "");
  }, [open, defaultClientId]);
  // Only an administratie that is actually offered counts as chosen: a
  // preselection from a previous organisation (or a removed client) leaves the
  // choice empty and the drop zone closed (B2-10).
  const selectedClientId = clients.some((c) => c.id === clientId) ? clientId : "";
  const [parsed, setParsed] = useState<MatchedTransaction[] | null>(null);
  const [candidatesByRow, setCandidatesByRow] = useState<InvoiceCandidate[][]>([]);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [statementSummary, setStatementSummary] = useState<Pick<ParsedStatement, "openingBalance" | "closingBalance" | "sections"> | null>(null);
  const [importing, setImporting] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  // The client the preview was built for (duplicates, invoices, IBAN). The
  // import always writes to this client, never to a later dropdown change.
  const [previewClientId, setPreviewClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Everything that blocks this file: unreadable lines, a balance difference,
  // another currency, several accounts, an account of another administratie.
  const [blockers, setBlockers] = useState<StatementImportBlocker[]>([]);
  const [accountCheck, setAccountCheck] = useState<StatementAccountCheck | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Ignores a duplicate check that finishes after the user started over.
  const checkToken = useRef(0);

  const resetPreview = () => {
    setParsed(null);
    setCandidatesByRow([]);
    setPreviewClientId(null);
    setDuplicateInfos([]);
    setSelected([]);
    setStatementSummary(null);
    setAccountCheck(null);
    setAccountConfirmed(false);
  };

  const processFile = useCallback(async (
    statement: ParsedStatement,
    forClientId: string,
    account: StatementAccountCheck,
    token: number,
  ) => {
    if (token !== checkToken.current) return;

    // Fail closed: without the client's stored transactions there is no
    // duplicate check, so nothing may be offered for import.
    setCheckingDuplicates(true);
    let existing: ExistingBankTransactionForDuplicates[];
    try {
      existing = await loadExistingTransactions(forClientId);
    } catch {
      if (token === checkToken.current) {
        setCheckingDuplicates(false);
        setError(DUPLICATE_CHECK_FAILED_MESSAGE);
      }
      return;
    }
    if (token !== checkToken.current) return;

    // Over the whole statement, before any selection, so a line's position —
    // and with it its fingerprint — never depends on what the user ticks.
    let fingerprints: (string | null)[] = statement.transactions.map(() => null);
    try {
      fingerprints = await importFingerprints(statement, existing);
    } catch {
      // No Web Crypto: import as before; the duplicate check below still runs.
    }
    if (token !== checkToken.current) return;
    setCheckingDuplicates(false);
    setPreviewClientId(forClientId);
    setStatementSummary({
      openingBalance: statement.openingBalance,
      closingBalance: statement.closingBalance,
      sections: statement.sections,
    });
    setAccountCheck(account);
    setAccountConfirmed(false);

    // Invoice suggestions only through the safe-match gate: same direction,
    // same administratie, an open amount, identity evidence, and no
    // preselection on a tied top score. A reversal is never a payment.
    const clientPurchases = invoices.filter((i) => i.client_id === forClientId);
    const clientSales = salesInvoices.filter((i) => i.client_id === forClientId);
    const rowCandidates = statement.transactions.map((tx) =>
      tx.isReversal
        ? []
        : gatedInvoiceCandidates(
            { id: "", client_id: forClientId, amount: tx.amount, description: tx.description, reference: tx.reference },
            clientPurchases,
            clientSales,
            NO_REJECTIONS,
          ),
    );
    const suggested = statement.transactions.map((tx, i) => withSuggestion(tx, preselectCandidate(rowCandidates[i])));
    const withTemplates = applyBookingTemplatesToTransactions(suggested, bookingTemplates, forClientId)
      .map((t, i) => {
        // An invoice suggestion wins over a recognition rule: coding a payment
        // of an open invoice directly on an expense account books the cost twice.
        const row = suggested[i].matchStatus === "suggestie" ? suggested[i] : t;
        return { ...row, importFingerprint: fingerprints[i] ?? null, importSource: row.source ?? null };
      });
    setCandidatesByRow(rowCandidates);
    setParsed(withTemplates);

    const dupInfos = detectDuplicates(statement.transactions, existing);
    setDuplicateInfos(dupInfos);
    setSelected(dupInfos.map(d => !d.isDuplicate));
  }, [invoices, salesInvoices, loadExistingTransactions, bookingTemplates]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setBlockers([]);
    // The client is fixed the moment a file is chosen: the dropdown closes
    // before the file is even read, and everything below uses this value.
    const forClientId = selectedClientId;
    if (!forClientId) return;
    const token = ++checkToken.current;
    setCheckingDuplicates(true);
    try {
      const text = await file.text();
      if (token !== checkToken.current) return; // dialog closed or another file chosen
      const client = clients.find((c) => c.id === forClientId);
      if (!client) {
        setCheckingDuplicates(false);
        setError("Kies een administratie uit de lijst.");
        return;
      }
      const statement = parseBankStatementFull(text);
      if (!statement.transactions.length && !statement.errors.length) {
        setCheckingDuplicates(false);
        setError("Geen transacties gevonden in dit bestand. Controleer of het een geldig MT940 of CAMT.053 bestand is.");
        return;
      }

      // Nothing is offered for import while anything in the file is unreadable,
      // out of balance, not in euro, of several accounts, or of another
      // administratie.
      const account = checkStatementAccount(statement, client, clients);
      const found = statementImportBlockers(statement);
      const administration = accountCheckBlocker(account, client.name);
      if (administration) found.push(administration);
      if (found.length > 0) {
        setCheckingDuplicates(false);
        setBlockers(found);
        return;
      }

      await processFile(statement, forClientId, account, token);
    } catch (e: any) {
      if (token !== checkToken.current) return;
      setCheckingDuplicates(false);
      setError(`Fout bij verwerken: ${e.message}`);
    }
  }, [selectedClientId, clients, processFile]);

  const updateMatch = (index: number, invoiceId: string | null) => {
    if (!parsed) return;
    const row = parsed[index];
    // Only a candidate that passed the gate can become a suggestion.
    const candidate = invoiceId ? candidatesByRow[index]?.find((c) => c.id === invoiceId) ?? null : null;
    if (invoiceId && !candidate) return;
    // "No suggestion" leaves a row coded by a recognition rule as it is.
    if (!candidate && row.matchStatus !== "suggestie") return;
    const updated = [...parsed];
    updated[index] = {
      ...withSuggestion(row, candidate),
      importFingerprint: row.importFingerprint,
      importSource: row.importSource,
    };
    setParsed(updated);
  };

  const toggleSelected = (index: number) => {
    setSelected(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  const accountNeedsConfirmation = accountCheck?.status === "confirm";

  const handleImport = async () => {
    const importClientId = previewClientId;
    if (!importClientId || !parsed) return;
    if (!parsed.some((_, i) => selected[i])) return;
    // Fail closed: an account that is not tied to this administratie is only
    // imported after the explicit confirmation.
    if (accountCheck?.status !== "match" && !(accountCheck?.status === "confirm" && accountConfirmed)) return;
    setImporting(true);
    setError(null);
    try {
      // Check again right before writing: a colleague may have imported the
      // same statement since the preview. Rows the user deliberately selected
      // despite a duplicate warning stay their choice; rows that only became
      // duplicates now are never written unseen.
      let fresh: ExistingBankTransactionForDuplicates[];
      try {
        fresh = await loadExistingTransactions(importClientId);
      } catch {
        setError(DUPLICATE_CHECK_FAILED_MESSAGE);
        return;
      }
      const recheck = detectDuplicates(parsed, fresh);
      const newlyDuplicate = recheck
        .map((d, i) => (selected[i] && d.isDuplicate && !duplicateInfos[i]?.isDuplicate ? i : -1))
        .filter((i) => i >= 0);
      if (newlyDuplicate.length > 0) {
        setDuplicateInfos(recheck);
        setSelected((prev) => prev.map((s, i) => (newlyDuplicate.includes(i) ? false : s)));
        setError(
          `${newlyDuplicate.length} ${newlyDuplicate.length === 1 ? "transactie is" : "transacties zijn"} intussen al geïmporteerd en niet meer geselecteerd. Controleer de selectie en importeer opnieuw.`,
        );
        return;
      }

      const toImport = parsed.filter((_, i) => selected[i]);
      // Nothing was attempted (e.g. the pre-import check failed): keep the
      // reviewed preview, so the user can simply try again.
      if ((await onImport(importClientId, toImport)) === false) return;
      resetPreview();
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = selected.filter(Boolean).length;
  const suggestedCount = parsed?.filter((t, i) => selected[i] && t.matchStatus === "suggestie").length ?? 0;
  const templateCount = parsed?.filter((t, i) => selected[i] && t.matchStatus === "handmatig_geboekt").length ?? 0;
  const duplicateCount = duplicateInfos.filter(d => d.isDuplicate).length;
  const previewClientName = clients.find((c) => c.id === previewClientId)?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        checkToken.current++;
        setCheckingDuplicates(false);
        setError(null);
        setBlockers([]);
        resetPreview();
      }
      onOpenChange(o);
    }}>
      <DialogContent className="sm:max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bankafschrift importeren</DialogTitle>
        </DialogHeader>

        {!parsed ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Klant selecteren *</label>
              <Select value={selectedClientId} onValueChange={(v) => { setClientId(v); setBlockers([]); setError(null); }} disabled={checkingDuplicates}>
                <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant" /></SelectTrigger>
                <SelectContent>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors border-border"
              style={{ opacity: selectedClientId && !checkingDuplicates ? 1 : 0.5, pointerEvents: selectedClientId && !checkingDuplicates ? "auto" : "none" }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
            >
              <Upload className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-display text-lg font-semibold">Sleep een MT940 of CAMT.053 bestand hierheen</h3>
              <p className="mt-1 text-sm text-muted-foreground">Of klik om een bestand te selecteren</p>
              <input ref={fileRef} type="file" accept=".sta,.mt940,.940,.txt,.xml,.csv" className="hidden"
                disabled={!selectedClientId || checkingDuplicates}
                onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
              <Button className="mt-4" onClick={() => fileRef.current?.click()} disabled={!selectedClientId || checkingDuplicates}>
                <FileText className="mr-2 h-4 w-4" />Bestand selecteren
              </Button>
            </div>

            {checkingDuplicates && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />Bestaande transacties van deze klant controleren op duplicaten…
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm" role="alert">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}

            {blockers.length > 0 && (
              <div className="space-y-3 rounded-md border border-destructive/50 bg-destructive/5 p-3" role="alert" data-testid="import-blockers">
                <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
                  <Ban className="h-4 w-4" />Importeren geblokkeerd
                </p>
                {blockers.map((b, i) => (
                  <div key={`${b.kind}-${i}`} className="space-y-1" data-blocker={b.kind}>
                    <p className="text-sm text-destructive">{b.message}</p>
                    {b.details.length > 0 && (
                      <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded bg-background/60 p-2 font-mono text-xs">
                        {b.details.map((d, j) => <li key={j} className="break-all">{d}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm" role="alert">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}

            <p className="text-sm">
              <span className="text-muted-foreground">Importeren in: </span>
              <span className="font-semibold" data-testid="import-target">{previewClientName}</span>
            </p>

            {accountCheck?.status === "match" && (
              <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />Rekening {accountCheck.iban} hoort bij {previewClientName}.
              </div>
            )}
            {accountCheck?.status === "confirm" && (
              <div className="space-y-2 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/20" data-testid="account-confirm">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  {ACCOUNT_CONFIRM_TEXT[accountCheck.reason](previewClientName, accountCheck.iban, accountCheck.administrations)}
                </p>
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={accountConfirmed}
                    onCheckedChange={(v) => setAccountConfirmed(v === true)}
                    aria-label={`Ik heb gecontroleerd dat dit afschrift bij ${previewClientName} hoort`}
                  />
                  Ik heb gecontroleerd dat dit afschrift bij {previewClientName} hoort
                </label>
              </div>
            )}

            {/* Balance display: only a statement whose balances add up gets here. */}
            {statementSummary && (statementSummary.openingBalance !== null || statementSummary.closingBalance !== null) && (
              <div className="flex flex-wrap items-center gap-4 rounded-lg border p-3 bg-muted/30">
                {statementSummary.openingBalance !== null && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Beginsaldo: </span>
                    <span className="font-mono font-semibold">{formatCurrency(statementSummary.openingBalance)}</span>
                  </div>
                )}
                {statementSummary.closingBalance !== null && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Eindsaldo: </span>
                    <span className="font-mono font-semibold">{formatCurrency(statementSummary.closingBalance)}</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-sm font-medium ml-auto text-green-600">
                  <CheckCircle2 className="h-4 w-4" />Saldo-controle OK
                  {statementSummary.sections.length > 1 && ` (${statementSummary.sections.length} afschriften)`}
                </div>
              </div>
            )}

            {/* Summary badges */}
            <div className="flex gap-3 flex-wrap">
              <Badge variant="secondary">{suggestedCount} factuursuggesties</Badge>
              {templateCount > 0 && (
                <Badge variant="secondary" className="gap-1 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                  ⚡ {templateCount} via herkenningsregel
                </Badge>
              )}
              <Badge variant="outline">{selectedCount - suggestedCount - templateCount} onbekend</Badge>
              {duplicateCount > 0 && (
                <Badge variant="destructive" className="gap-1"><Copy className="h-3 w-3" />{duplicateCount} duplicaten</Badge>
              )}
              <span className="text-sm text-muted-foreground ml-auto">{selectedCount} van {parsed.length} geselecteerd</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Een factuursuggestie koppelt nog niets: bevestig haar daarna op de bankpagina.
            </p>

            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Datum</TableHead>
                      <TableHead>Omschrijving</TableHead>
                      <TableHead className="text-right">Bedrag</TableHead>
                      <TableHead>Factuursuggestie</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.map((tx, i) => {
                      const dup = duplicateInfos[i];
                      const options = candidatesByRow[i] ?? [];
                      return (
                        <TableRow key={i} className={dup?.isDuplicate ? "opacity-60" : ""}>
                          <TableCell>
                            <Checkbox
                              checked={selected[i] ?? false}
                              onCheckedChange={() => toggleSelected(i)}
                            />
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap">{tx.date.split("-").reverse().join("-")}</TableCell>
                          <TableCell className="text-sm max-w-[200px] truncate">{tx.description}</TableCell>
                          <TableCell className={`text-right font-mono text-sm whitespace-nowrap ${tx.amount < 0 ? "text-destructive" : "text-green-600"}`}>
                            {formatCurrency(tx.amount)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Select
                                value={tx.matchedInvoiceId || "none"}
                                onValueChange={(val) => updateMatch(i, val === "none" ? null : val)}
                                disabled={options.length === 0}
                              >
                                <SelectTrigger className={`w-[220px] h-8 text-xs ${
                                  tx.matchStatus === "suggestie" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20" : ""
                                }`} aria-label={`Factuursuggestie voor ${tx.description}`}>
                                  <SelectValue placeholder="— Geen suggestie —" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">{options.length === 0 ? "— Geen passende factuur —" : "— Geen suggestie —"}</SelectItem>
                                  {options.map(c => (
                                    <SelectItem key={c.id} value={c.id}>{candidateLabel(c)}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {tx.matchStatus === "suggestie" && (
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateMatch(i, null)} aria-label="Suggestie weghalen">
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {dup?.isDuplicate && (
                              <Badge variant="destructive" className="text-[10px] gap-1">
                                <Copy className="h-3 w-3" />
                                {dup.reason === "reference"
                                  ? "Duplicaat (referentie/bedrag)"
                                  : dup.reason === "possible"
                                    ? "Mogelijk duplicaat (datum/bedrag/tegenrekening) — controleer"
                                    : "Duplicaat (datum/bedrag/omschrijving)"}
                              </Badge>
                            )}
                            {!dup?.isDuplicate && tx.isReversal && (
                              <Badge variant="outline" className="text-[10px]">Storno</Badge>
                            )}
                            {!dup?.isDuplicate && tx.matchStatus === "handmatig_geboekt" && tx.templateName && (
                              <Badge variant="secondary" className="text-[10px] bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                                ⚡ {tx.grootboekText || tx.templateName}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        )}

        {parsed && (
          <DialogFooter>
            <Button variant="outline" disabled={importing} onClick={() => {
              setError(null);
              resetPreview();
            }}>Terug</Button>
            <Button
              onClick={handleImport}
              disabled={importing || selectedCount === 0 || (accountNeedsConfirmation && !accountConfirmed)}
            >
              {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {selectedCount} transacties importeren
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
