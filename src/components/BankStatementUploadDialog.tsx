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
import { Upload, FileText, Loader2, CheckCircle2, AlertCircle, X, AlertTriangle, Copy } from "lucide-react";
import {
  parseBankStatementFull,
  detectDuplicates,
  importFingerprints,
  type ParsedTransaction,
  type DuplicateInfo,
  type ExistingBankTransactionForDuplicates,
} from "@/lib/bank-statement-parser";
import { applyBookingTemplatesToTransactions } from "@/lib/booking-template-utils";
import type { Tables } from "@/integrations/supabase/types";
import type { BookingTemplate } from "@/hooks/useBookingTemplates";

type PurchaseInvoice = Tables<"purchase_invoices">;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: { id: string; name: string; ibans?: string[] | null }[];
  invoices: PurchaseInvoice[];
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
  matchStatus: "gematcht" | "suggestie" | "niet_gematcht" | "handmatig_geboekt";
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

function autoMatch(
  transactions: ParsedTransaction[],
  invoices: PurchaseInvoice[]
): MatchedTransaction[] {
  return transactions.map((tx) => {
    let bestMatch: PurchaseInvoice | null = null;
    let bestScore = 0;

    for (const inv of tx.isReversal ? [] : invoices) {
      let score = 0;
      if (inv.amount_incl != null && Math.abs(Math.abs(tx.amount) - inv.amount_incl) < 0.02) {
        score += 60;
      } else if (inv.amount_incl != null && Math.abs(Math.abs(tx.amount) - inv.amount_incl) < 1) {
        score += 30;
      }
      if (inv.invoice_number && tx.description) {
        const invNum = inv.invoice_number.toLowerCase().replace(/\s/g, "");
        const desc = tx.description.toLowerCase().replace(/\s/g, "");
        if (desc.includes(invNum)) score += 30;
      }
      if (inv.invoice_number && tx.reference) {
        const invNum = inv.invoice_number.toLowerCase().replace(/\s/g, "");
        const ref = tx.reference.toLowerCase().replace(/\s/g, "");
        if (ref.includes(invNum)) score += 25;
      }
      if (inv.supplier && tx.description) {
        const supplier = inv.supplier.toLowerCase();
        const desc = tx.description.toLowerCase();
        if (desc.includes(supplier)) score += 20;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = inv;
      }
    }

    const isMatch = bestScore >= 70;
    const isSuggestion = bestScore >= 40 && bestScore < 70;

    return {
      ...tx,
      matchedInvoiceId: isMatch || isSuggestion ? bestMatch!.id : null,
      matchConfidence: bestScore > 0 ? Math.min(bestScore, 100) : null,
      matchStatus: isMatch ? "gematcht" : isSuggestion ? "suggestie" : "niet_gematcht",
      matchedInvoiceLabel: isMatch || isSuggestion
        ? `${bestMatch!.supplier} - ${bestMatch!.invoice_number || "?"}`
        : null,
    };
  });
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

function invoiceLabel(inv: PurchaseInvoice) {
  const amt = inv.amount_incl != null ? ` (€${inv.amount_incl.toFixed(2)})` : "";
  return `${inv.supplier} - ${inv.invoice_number || "?"}${amt}`;
}

export const DUPLICATE_CHECK_FAILED_MESSAGE =
  "De bestaande banktransacties van deze klant konden niet worden geladen. Importeren is geblokkeerd, zodat er geen dubbele transacties ontstaan. Probeer het opnieuw.";

export function BankStatementUploadDialog({ open, onOpenChange, clients, invoices, onImport, loadExistingTransactions, bookingTemplates = [], defaultClientId }: Props) {
  const [clientId, setClientId] = useState(defaultClientId ?? "");

  // Sync clientId whenever the dialog (re-)opens with a preselected client
  useEffect(() => {
    if (open) setClientId(defaultClientId ?? "");
  }, [open, defaultClientId]);
  const [parsed, setParsed] = useState<MatchedTransaction[] | null>(null);
  const [duplicateInfos, setDuplicateInfos] = useState<DuplicateInfo[]>([]);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [openingBalance, setOpeningBalance] = useState<number | null>(null);
  const [closingBalance, setClosingBalance] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  // The client the preview was built for (duplicates, invoices, IBAN). The
  // import always writes to this client, never to a later dropdown change.
  const [previewClientId, setPreviewClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Ignores a duplicate check that finishes after the user started over.
  const checkToken = useRef(0);

  // IBAN mismatch warning state
  const [ibanWarning, setIbanWarning] = useState<{ fileIban: string; clientName: string } | null>(null);
  const [pendingFileText, setPendingFileText] = useState<string | null>(null);
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);

  const processFile = useCallback(async (text: string, forClientId: string, startedToken?: number) => {
    // One token per user action, taken before anything is awaited; closing the
    // dialog or choosing another file invalidates it.
    const token = startedToken ?? ++checkToken.current;
    if (token !== checkToken.current) return;
    const statement = parseBankStatementFull(text);
    if (!statement.transactions.length) {
      setCheckingDuplicates(false);
      setError("Geen transacties gevonden in dit bestand. Controleer of het een geldig MT940 of CAMT.053 bestand is.");
      return;
    }
    if (!forClientId) {
      setCheckingDuplicates(false);
      return;
    }

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

    setOpeningBalance(statement.openingBalance);
    setClosingBalance(statement.closingBalance);

    // Only match against invoices for the selected client
    const clientInvoices = invoices.filter(i => i.client_id === forClientId);
    const matched = autoMatch(statement.transactions, clientInvoices);
    const withTemplates = applyBookingTemplatesToTransactions(matched, bookingTemplates, forClientId)
      .map((t, i) => ({ ...t, importFingerprint: fingerprints[i] ?? null, importSource: t.source ?? null }));
    setParsed(withTemplates);

    const dupInfos = detectDuplicates(statement.transactions, existing);
    setDuplicateInfos(dupInfos);
    setSelected(dupInfos.map(d => !d.isDuplicate));
  }, [invoices, loadExistingTransactions, bookingTemplates]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    // The client is fixed the moment a file is chosen: the dropdown closes
    // before the file is even read, and everything below uses this value.
    const forClientId = clientId;
    if (!forClientId) return;
    const token = ++checkToken.current;
    setCheckingDuplicates(true);
    try {
      const text = await file.text();
      if (token !== checkToken.current) return; // dialog closed or another file chosen
      const statement = parseBankStatementFull(text);

      // Check IBAN match
      if (statement.accountIban) {
        const client = clients.find(c => c.id === forClientId);
        const clientIbans = (client?.ibans || []).map(i => i.replace(/\s/g, "").toUpperCase());
        const fileIban = statement.accountIban.replace(/\s/g, "").toUpperCase();

        if (clientIbans.length > 0 && !clientIbans.includes(fileIban)) {
          setCheckingDuplicates(false);
          setIbanWarning({ fileIban: statement.accountIban, clientName: client?.name || "" });
          setPendingFileText(text);
          setPendingClientId(forClientId);
          return;
        }
      }

      await processFile(text, forClientId, token);
    } catch (e: any) {
      if (token !== checkToken.current) return;
      setCheckingDuplicates(false);
      setError(`Fout bij verwerken: ${e.message}`);
    }
  }, [clientId, clients, processFile]);

  const updateMatch = (index: number, invoiceId: string | null) => {
    if (!parsed) return;
    const updated = [...parsed];
    if (!invoiceId) {
      updated[index] = {
        ...updated[index],
        matchedInvoiceId: null,
        matchConfidence: null,
        matchStatus: "niet_gematcht",
        matchedInvoiceLabel: null,
      };
    } else {
      if (updated[index].isReversal) return;
      const inv = invoices.find(i => i.id === invoiceId && i.client_id === previewClientId);
      if (!inv) return;
      updated[index] = {
        ...updated[index],
        matchedInvoiceId: invoiceId,
        matchConfidence: 100,
        matchStatus: "gematcht",
        matchedInvoiceLabel: inv ? invoiceLabel(inv) : null,
      };
    }
    setParsed(updated);
  };

  const toggleSelected = (index: number) => {
    setSelected(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  const handleImport = async () => {
    const importClientId = previewClientId;
    if (!importClientId || !parsed) return;
    if (!parsed.some((_, i) => selected[i])) return;
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
      setParsed(null);
      setPreviewClientId(null);
      setDuplicateInfos([]);
      setSelected([]);
      setOpeningBalance(null);
      setClosingBalance(null);
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = selected.filter(Boolean).length;
  const matchedCount = parsed?.filter((t, i) => selected[i] && t.matchStatus === "gematcht").length ?? 0;
  const suggestedCount = parsed?.filter((t, i) => selected[i] && t.matchStatus === "suggestie").length ?? 0;
  const templateCount = parsed?.filter((t, i) => selected[i] && t.matchStatus === "handmatig_geboekt").length ?? 0;
  const duplicateCount = duplicateInfos.filter(d => d.isDuplicate).length;

  // Balance check
  const balanceCheck = (() => {
    if (openingBalance === null || closingBalance === null || !parsed) return null;
    const sum = parsed.reduce((acc, tx) => acc + tx.amount, 0);
    const diff = Math.abs(openingBalance + sum - closingBalance);
    return diff <= 0.01;
  })();

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        checkToken.current++;
        setCheckingDuplicates(false);
        setError(null);
        setParsed(null);
        setPreviewClientId(null);
        setDuplicateInfos([]);
        setSelected([]);
        setOpeningBalance(null);
        setClosingBalance(null);
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
              <Select value={clientId} onValueChange={setClientId} disabled={checkingDuplicates}>
                <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant" /></SelectTrigger>
                <SelectContent>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors border-border"
              style={{ opacity: clientId && !checkingDuplicates ? 1 : 0.5, pointerEvents: clientId && !checkingDuplicates ? "auto" : "none" }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
            >
              <Upload className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-display text-lg font-semibold">Sleep een MT940 of CAMT.053 bestand hierheen</h3>
              <p className="mt-1 text-sm text-muted-foreground">Of klik om een bestand te selecteren</p>
              <input ref={fileRef} type="file" accept=".sta,.mt940,.940,.txt,.xml,.csv" className="hidden"
                onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
              <Button className="mt-4" onClick={() => fileRef.current?.click()} disabled={!clientId || checkingDuplicates}>
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
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm" role="alert">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}
            {/* Balance display */}
            {(openingBalance !== null || closingBalance !== null) && (
              <div className="flex flex-wrap items-center gap-4 rounded-lg border p-3 bg-muted/30">
                {openingBalance !== null && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Beginsaldo: </span>
                    <span className="font-mono font-semibold">{formatCurrency(openingBalance)}</span>
                  </div>
                )}
                {closingBalance !== null && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Eindsaldo: </span>
                    <span className="font-mono font-semibold">{formatCurrency(closingBalance)}</span>
                  </div>
                )}
                {balanceCheck !== null && (
                  <div className={`flex items-center gap-1.5 text-sm font-medium ml-auto ${balanceCheck ? "text-green-600" : "text-destructive"}`}>
                    {balanceCheck ? (
                      <><CheckCircle2 className="h-4 w-4" />Saldo-controle OK</>
                    ) : (
                      <><AlertTriangle className="h-4 w-4" />Saldo-controle verschil!</>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Summary badges */}
            <div className="flex gap-3 flex-wrap">
              <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />{matchedCount} gematcht</Badge>
              <Badge variant="secondary">{suggestedCount} suggesties</Badge>
              {templateCount > 0 && (
                <Badge variant="secondary" className="gap-1 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                  ⚡ {templateCount} via herkenningsregel
                </Badge>
              )}
              <Badge variant="outline">{(parsed?.length ?? 0) - matchedCount - suggestedCount - templateCount} onbekend</Badge>
              {duplicateCount > 0 && (
                <Badge variant="destructive" className="gap-1"><Copy className="h-3 w-3" />{duplicateCount} duplicaten</Badge>
              )}
              <span className="text-sm text-muted-foreground ml-auto">{selectedCount} van {parsed.length} geselecteerd</span>
            </div>

            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Datum</TableHead>
                      <TableHead>Omschrijving</TableHead>
                      <TableHead className="text-right">Bedrag</TableHead>
                      <TableHead>Factuur koppelen</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.map((tx, i) => {
                      const dup = duplicateInfos[i];
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
                              >
                                <SelectTrigger className={`w-[220px] h-8 text-xs ${
                                  tx.matchStatus === "gematcht" ? "border-green-500 bg-green-50 dark:bg-green-950/20" :
                                  tx.matchStatus === "suggestie" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20" : ""
                                }`}>
                                  <SelectValue placeholder="— Geen match —" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">— Geen match —</SelectItem>
                                  {invoices.filter(i => i.client_id === previewClientId).map(inv => (
                                    <SelectItem key={inv.id} value={inv.id}>
                                      {invoiceLabel(inv)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {tx.matchedInvoiceId && (
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateMatch(i, null)}>
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
              setParsed(null);
              setPreviewClientId(null);
              setDuplicateInfos([]);
              setSelected([]);
              setOpeningBalance(null);
              setClosingBalance(null);
            }}>Terug</Button>
            <Button onClick={handleImport} disabled={importing || selectedCount === 0}>
              {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {selectedCount} transacties importeren
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>

    {/* IBAN mismatch warning dialog */}
    <Dialog open={!!ibanWarning} onOpenChange={(o) => { if (!o) { setIbanWarning(null); setPendingFileText(null); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            IBAN komt niet overeen
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Let op: dit bankafschrift lijkt niet bij {ibanWarning?.clientName} te horen.
          Het IBAN in het bestand ({ibanWarning?.fileIban}) komt niet overeen met het bekende
          zakelijke IBAN van deze klant. Wil je toch importeren?
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setIbanWarning(null); setPendingFileText(null); }}>
            Annuleren
          </Button>
          <Button onClick={() => {
            if (pendingFileText && pendingClientId) void processFile(pendingFileText, pendingClientId);
            setIbanWarning(null);
            setPendingFileText(null);
          }}>
            Toch importeren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
