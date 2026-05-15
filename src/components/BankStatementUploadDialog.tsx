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
import { parseBankStatementFull, detectDuplicates, type ParsedTransaction, type DuplicateInfo } from "@/lib/bank-statement-parser";
import type { Tables } from "@/integrations/supabase/types";
import type { BookingTemplate } from "@/hooks/useBookingTemplates";

type PurchaseInvoice = Tables<"purchase_invoices">;
type BankTransaction = Tables<"bank_transactions">;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: { id: string; name: string; ibans?: string[] | null }[];
  invoices: PurchaseInvoice[];
  onImport: (clientId: string, transactions: MatchedTransaction[]) => Promise<void>;
  existingTransactions?: BankTransaction[];
  bookingTemplates?: BookingTemplate[];
  defaultClientId?: string;
}

export interface MatchedTransaction extends ParsedTransaction {
  matchedInvoiceId: string | null;
  matchConfidence: number | null;
  matchStatus: "gematcht" | "suggestie" | "niet_gematcht" | "handmatig_geboekt";
  matchedInvoiceLabel: string | null;
  grootboekrekeningId?: string | null;
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

    for (const inv of invoices) {
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

// Pas herkenningsregels toe op transacties die nog niet gematcht zijn
function applyTemplates(
  transactions: MatchedTransaction[],
  templates: BookingTemplate[],
  clientId: string
): MatchedTransaction[] {
  const activeTemplates = templates
    .filter(t => t.actief && t.zoekterm)
    .filter(t => !t.client_id_filter || t.client_id_filter === clientId)
    .sort((a, b) => (b.prioriteit ?? 0) - (a.prioriteit ?? 0));

  if (!activeTemplates.length) return transactions;

  return transactions.map(tx => {
    // Factuurmatches niet overschrijven
    if (tx.matchStatus === "gematcht") return tx;

    const desc = (tx.description || "").toLowerCase();
    const ref = (tx.reference || "").toLowerCase();
    const counter = (tx.counterAccount || "").toLowerCase();

    for (const template of activeTemplates) {
      const zoekterm = (template.zoekterm || "").toLowerCase();
      const zoekIn = template.zoek_in || "alles";

      let found = false;
      if (zoekIn === "alles" || zoekIn === "omschrijving") {
        if (desc.includes(zoekterm)) found = true;
      }
      if (zoekIn === "alles" || zoekIn === "referentie") {
        if (ref.includes(zoekterm)) found = true;
      }
      if (zoekIn === "alles" || zoekIn === "naam") {
        if (counter.includes(zoekterm)) found = true;
      }

      if (found) {
        return {
          ...tx,
          matchStatus: "handmatig_geboekt" as const,
          matchConfidence: 100,
          grootboekrekeningId: template.ledger_account_id ?? null,
          grootboekText: template.ledger_account_text ?? null,
          templateName: template.zoekterm || template.name,
        };
      }
    }

    return tx;
  });
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

function invoiceLabel(inv: PurchaseInvoice) {
  const amt = inv.amount_incl != null ? ` (€${inv.amount_incl.toFixed(2)})` : "";
  return `${inv.supplier} - ${inv.invoice_number || "?"}${amt}`;
}

export function BankStatementUploadDialog({ open, onOpenChange, clients, invoices, onImport, existingTransactions, bookingTemplates = [], defaultClientId }: Props) {
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
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // IBAN mismatch warning state
  const [ibanWarning, setIbanWarning] = useState<{ fileIban: string; clientName: string } | null>(null);
  const [pendingFileText, setPendingFileText] = useState<string | null>(null);

  const processFile = useCallback((text: string) => {
    const statement = parseBankStatementFull(text);
    if (!statement.transactions.length) {
      setError("Geen transacties gevonden in dit bestand. Controleer of het een geldig MT940 of CAMT.053 bestand is.");
      return;
    }

    setOpeningBalance(statement.openingBalance);
    setClosingBalance(statement.closingBalance);

    // Only match against invoices for the selected client
    const clientInvoices = clientId ? invoices.filter(i => i.client_id === clientId) : invoices;
    const matched = autoMatch(statement.transactions, clientInvoices);
    const withTemplates = applyTemplates(matched, bookingTemplates, clientId);
    setParsed(withTemplates);

    const dupInfos = detectDuplicates(
      statement.transactions,
      (existingTransactions ?? []).map(t => ({
        transaction_date: t.transaction_date,
        amount: t.amount,
        description: t.description,
        counter_account: t.counter_account,
        reference: t.reference,
      }))
    );
    setDuplicateInfos(dupInfos);
    setSelected(dupInfos.map(d => !d.isDuplicate));
  }, [invoices, existingTransactions, clientId, bookingTemplates]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const statement = parseBankStatementFull(text);

      // Check IBAN match
      if (statement.accountIban && clientId) {
        const client = clients.find(c => c.id === clientId);
        const clientIbans = (client?.ibans || []).map(i => i.replace(/\s/g, "").toUpperCase());
        const fileIban = statement.accountIban.replace(/\s/g, "").toUpperCase();

        if (clientIbans.length > 0 && !clientIbans.includes(fileIban)) {
          setIbanWarning({ fileIban: statement.accountIban, clientName: client?.name || "" });
          setPendingFileText(text);
          return;
        }
      }

      processFile(text);
    } catch (e: any) {
      setError(`Fout bij verwerken: ${e.message}`);
    }
  }, [invoices, existingTransactions, clientId, clients, processFile]);

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
      const inv = invoices.find(i => i.id === invoiceId);
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
    if (!clientId || !parsed) return;
    const toImport = parsed.filter((_, i) => selected[i]);
    if (!toImport.length) return;
    setImporting(true);
    await onImport(clientId, toImport);
    setImporting(false);
    setParsed(null);
    setDuplicateInfos([]);
    setSelected([]);
    setOpeningBalance(null);
    setClosingBalance(null);
    onOpenChange(false);
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
        setParsed(null);
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
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant" /></SelectTrigger>
                <SelectContent>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div
              className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors border-border"
              style={{ opacity: clientId ? 1 : 0.5, pointerEvents: clientId ? "auto" : "none" }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
            >
              <Upload className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-display text-lg font-semibold">Sleep een MT940 of CAMT.053 bestand hierheen</h3>
              <p className="mt-1 text-sm text-muted-foreground">Of klik om een bestand te selecteren</p>
              <input ref={fileRef} type="file" accept=".sta,.mt940,.940,.txt,.xml,.csv" className="hidden"
                onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
              <Button className="mt-4" onClick={() => fileRef.current?.click()} disabled={!clientId}>
                <FileText className="mr-2 h-4 w-4" />Bestand selecteren
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
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
                                  {invoices.filter(i => !clientId || i.client_id === clientId).map(inv => (
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
                                {dup.reason === "reference" ? "Duplicaat (TransactionID)" : "Duplicaat (datum/bedrag/omschrijving)"}
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
            <Button variant="outline" onClick={() => {
              setParsed(null);
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
            if (pendingFileText) processFile(pendingFileText);
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
