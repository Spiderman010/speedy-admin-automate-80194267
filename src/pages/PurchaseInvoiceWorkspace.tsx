import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft, ChevronLeft, ChevronRight, Plus, Trash2, Save, CheckCircle2, Loader2, FileText, ExternalLink,
} from "lucide-react";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useClients } from "@/hooks/useClients";
import { useLeveranciers } from "@/hooks/useLeveranciers";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useUpdatePurchaseInvoice, usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { usePurchaseInvoiceLines, useReplacePurchaseInvoiceLines, type InvoiceLineInput } from "@/hooks/usePurchaseInvoiceLines";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useToast } from "@/hooks/use-toast";
import {
  computeLineTotals,
  computeLineDiffs,
  derivePrefillLine,
  isBlankLine,
  isPartiallyFilledLine,
} from "@/lib/purchase-line-validation";
import { parseAmountInput, formatAmountInput } from "@/lib/amount-input";
import { round2 } from "@/lib/btw-calc";
import { formatEuro } from "@/lib/format";
import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;

interface LineRow {
  omschrijving: string;
  amount_input: string;
  btw_percentage: string;
  grootboekrekening_id: string | null;
  grootboek_label: string;
}

interface HeaderForm {
  client_id: string;
  leverancier_id: string;
  supplier: string;
  invoice_number: string;
  invoice_date: string;
  amount_excl: string;
  btw_amount: string;
  amount_incl: string;
  btw_percentage: string;
  ledger_label: string;
  ledger_id: string | null;
  notes: string;
  status: string;
}

function usePurchaseInvoice(invoiceId: string | undefined) {
  return useQuery({
    queryKey: ["purchase_invoice", invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const { data, error } = await supabase
        .from("purchase_invoices")
        .select("*")
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) throw error;
      return data as PurchaseInvoice | null;
    },
    enabled: !!invoiceId,
  });
}

function InvoicePreview({ filePath }: { filePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) { setUrl(null); setError(null); return; }
    setLoading(true); setError(null); setUrl(null);
    supabase.storage.from("invoices").createSignedUrl(filePath, 3600)
      .then(({ data, error }) => {
        if (error) setError("Document niet beschikbaar");
        else setUrl(data?.signedUrl ?? null);
      })
      .catch(() => setError("Document niet beschikbaar"))
      .finally(() => setLoading(false));
  }, [filePath]);

  if (!filePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-muted-foreground bg-muted/30 rounded-lg">
        <FileText className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm">Geen bestand beschikbaar</p>
      </div>
    );
  }
  if (loading) {
    return <div className="flex items-center justify-center h-full min-h-[400px] text-muted-foreground text-sm">Document laden…</div>;
  }
  if (error || !url) {
    return <div className="flex items-center justify-center h-full min-h-[400px] text-muted-foreground text-sm">{error ?? "Document niet beschikbaar"}</div>;
  }
  const isPdf = filePath.toLowerCase().endsWith(".pdf");
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2 pb-2 border-b">
        <span className="text-xs font-medium text-muted-foreground">Origineel document</span>
        <Button variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          title="Open in nieuw tabblad">
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto rounded-lg bg-muted/20 border min-h-[500px]">
        {isPdf ? (
          <iframe src={url} className="w-full h-full min-h-[500px]" title="Factuur PDF" />
        ) : (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={url} alt="Factuur" className="w-full h-auto" />
        )}
      </div>
    </div>
  );
}

function emptyHeader(inv: PurchaseInvoice | null): HeaderForm {
  return {
    client_id: inv?.client_id ?? "",
    leverancier_id: inv?.leverancier_id ?? "",
    supplier: inv?.supplier ?? "",
    invoice_number: inv?.invoice_number ?? "",
    invoice_date: inv?.invoice_date ?? "",
    amount_excl: formatAmountInput(inv?.amount_excl ?? null),
    btw_amount: formatAmountInput(inv?.btw_amount ?? null),
    amount_incl: formatAmountInput(inv?.amount_incl ?? null),
    btw_percentage: inv?.btw_percentage != null ? String(inv.btw_percentage) : "21",
    ledger_label: inv?.ledger_account_text ?? "",
    ledger_id: inv?.ledger_account_id ?? null,
    notes: inv?.notes ?? "",
    status: inv?.status ?? "te_controleren",
  };
}

export default function PurchaseInvoiceWorkspace() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const { data: invoice, isLoading: invoiceLoading } = usePurchaseInvoice(invoiceId);
  const { data: storedLines, isLoading: linesLoading } = usePurchaseInvoiceLines(invoiceId ?? null);
  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: leveranciers } = useLeveranciers({
    organizationId: activeOrganizationId ?? undefined,
    clientId: invoice?.client_id,
    enabled: orgEnabled && !!invoice?.client_id,
  });
  const { data: ledgers } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const { data: allInvoices } = usePurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    clientId: invoice?.client_id,
    enabled: orgEnabled && !!invoice?.client_id,
  });

  const updateInvoice = useUpdatePurchaseInvoice();
  const replaceLines = useReplacePurchaseInvoiceLines();

  const client = useMemo(
    () => clients?.find((c) => c.id === invoice?.client_id) ?? null,
    [clients, invoice?.client_id],
  );
  const isBtwVrijgesteld = !!client?.btw_vrijgesteld;

  const [header, setHeader] = useState<HeaderForm>(() => emptyHeader(invoice ?? null));
  const [lines, setLines] = useState<LineRow[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);

  // Deterministic initialization once invoice + lines are loaded.
  useEffect(() => {
    if (initialized) return;
    if (invoiceLoading || linesLoading) return;
    if (!invoice) return;

    const nextHeader = emptyHeader(invoice);
    // BTW-vrijgesteld coherence: force pct=0 and incl=excl.
    if (isBtwVrijgesteld) {
      nextHeader.btw_percentage = "0";
      nextHeader.btw_amount = formatAmountInput(0);
      const excl = parseAmountInput(nextHeader.amount_excl);
      const incl = parseAmountInput(nextHeader.amount_incl);
      const chosen = excl ?? incl;
      if (chosen != null) {
        nextHeader.amount_excl = formatAmountInput(chosen);
        nextHeader.amount_incl = formatAmountInput(chosen);
      }
    }
    setHeader(nextHeader);

    if (storedLines && storedLines.length > 0) {
      setLines(storedLines.map((l) => {
        const ledger = ledgers?.find((g) => g.id === l.grootboekrekening_id);
        return {
          omschrijving: l.omschrijving,
          amount_input: formatAmountInput(l.amount_excl),
          btw_percentage: l.btw_percentage != null ? String(l.btw_percentage) : "0",
          grootboekrekening_id: l.grootboekrekening_id,
          grootboek_label: ledger ? `${ledger.nummer} - ${ledger.omschrijving}` : "",
        };
      }));
    } else {
      // Derive prefill from header totals — one line only, never a hidden default.
      const prefill = derivePrefillLine({
        amount_excl: parseAmountInput(nextHeader.amount_excl),
        amount_incl: parseAmountInput(nextHeader.amount_incl),
        btw_percentage: parseAmountInput(nextHeader.btw_percentage),
        isBtwVrijgesteld,
      });
      if (prefill) {
        const ledger = ledgers?.find((g) => g.id === invoice.ledger_account_id);
        setLines([{
          omschrijving: invoice.supplier || "Factuurregel",
          amount_input: formatAmountInput(prefill.amount_excl),
          btw_percentage: String(prefill.btw_percentage),
          grootboekrekening_id: invoice.ledger_account_id ?? null,
          grootboek_label: ledger ? `${ledger.nummer} - ${ledger.omschrijving}` : (invoice.ledger_account_text ?? ""),
        }]);
      } else {
        setLines([]);
      }
    }
    setInitialized(true);
  }, [invoice, storedLines, ledgers, invoiceLoading, linesLoading, initialized, isBtwVrijgesteld]);

  // Header field mutators
  const patchHeader = (patch: Partial<HeaderForm>) => setHeader((h) => ({ ...h, ...patch }));

  // Line helpers
  const emptyLine = (btwPct: string): LineRow => ({
    omschrijving: "",
    amount_input: "",
    btw_percentage: btwPct,
    grootboekrekening_id: null,
    grootboek_label: "",
  });

  const patchLine = (idx: number, patch: Partial<LineRow>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    const pct = isBtwVrijgesteld ? "0" : header.btw_percentage || "21";
    setLines((prev) => [...prev, emptyLine(pct)]);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  // Derived: meaningful (non-blank) lines only.
  const meaningfulLines = useMemo(
    () => lines.filter((l) => !isBlankLine({
      omschrijving: l.omschrijving,
      amount_input: l.amount_input,
      grootboekrekening_id: l.grootboekrekening_id,
    })),
    [lines],
  );

  const parsedLines = useMemo(
    () => meaningfulLines.map((l) => ({
      omschrijving: l.omschrijving,
      amount_excl: parseAmountInput(l.amount_input) ?? 0,
      btw_percentage: parseAmountInput(l.btw_percentage) ?? 0,
    })),
    [meaningfulLines],
  );

  const lineTotals = useMemo(() => computeLineTotals(parsedLines), [parsedLines]);

  const headerTotals = useMemo(() => ({
    amount_excl: parseAmountInput(header.amount_excl),
    btw_amount: parseAmountInput(header.btw_amount),
    amount_incl: parseAmountInput(header.amount_incl),
  }), [header.amount_excl, header.btw_amount, header.amount_incl]);

  const diffs = useMemo(() => computeLineDiffs(parsedLines, headerTotals), [parsedLines, headerTotals]);

  const partialLines = lines.filter((l) => isPartiallyFilledLine({
    omschrijving: l.omschrijving,
    amount_input: l.amount_input,
    grootboekrekening_id: l.grootboekrekening_id,
  }));

  const hasPartialLine = partialLines.length > 0;
  const linesMatch = diffs.allOk;
  const headerComplete =
    !!header.client_id &&
    !!header.supplier.trim() &&
    !!header.invoice_number.trim() &&
    !!header.invoice_date &&
    headerTotals.amount_incl != null;

  const canSave = initialized && !hasPartialLine && !saving;
  const canApprove = canSave && headerComplete && linesMatch && meaningfulLines.length > 0;

  // Totals color state
  const totalsState: "green" | "amber" | "red" =
    (headerTotals.amount_incl == null && meaningfulLines.length > 0) ? "red"
      : (hasPartialLine || (meaningfulLines.length > 0 && !linesMatch)) ? "amber"
      : (meaningfulLines.length > 0 && linesMatch) ? "green"
      : "amber";

  const totalsMessage =
    totalsState === "green" ? "De boekingsregels sluiten aan op de factuur."
      : totalsState === "red" ? "Factuurtotalen ontbreken."
      : hasPartialLine ? "Een regel is nog niet compleet."
      : meaningfulLines.length === 0 ? "Voeg minstens één boekingsregel toe."
      : (() => {
          const d = diffs.incl ?? diffs.excl ?? diffs.btw ?? 0;
          return `Er resteert nog een verschil van ${formatEuro(Math.abs(d))}.`;
        })();

  // Previous / next invoice navigation (within same client)
  const sortedInvoices = useMemo(() => {
    return (allInvoices ?? []).slice().sort((a, b) =>
      (b.invoice_date ?? "").localeCompare(a.invoice_date ?? ""),
    );
  }, [allInvoices]);
  const currentIdx = sortedInvoices.findIndex((i) => i.id === invoiceId);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < sortedInvoices.length - 1;

  const goPrev = () => hasPrev && navigate(`/facturen/inkoop/${sortedInvoices[currentIdx - 1].id}`);
  const goNext = () => hasNext && navigate(`/facturen/inkoop/${sortedInvoices[currentIdx + 1].id}`);

  const buildLinesPayload = (): InvoiceLineInput[] =>
    meaningfulLines.map((l) => ({
      omschrijving: l.omschrijving.trim(),
      amount_excl: round2(parseAmountInput(l.amount_input) ?? 0),
      btw_percentage: parseAmountInput(l.btw_percentage),
      grootboekrekening_id: l.grootboekrekening_id,
    }));

  const buildHeaderUpdates = (): Partial<PurchaseInvoice> => ({
    client_id: header.client_id || undefined,
    leverancier_id: header.leverancier_id || null,
    supplier: header.supplier.trim(),
    invoice_number: header.invoice_number.trim() || null,
    invoice_date: header.invoice_date || null,
    amount_excl: parseAmountInput(header.amount_excl),
    btw_amount: parseAmountInput(header.btw_amount),
    amount_incl: parseAmountInput(header.amount_incl),
    btw_percentage: parseAmountInput(header.btw_percentage),
    ledger_account_id: header.ledger_id,
    ledger_account_text: header.ledger_label || null,
    notes: header.notes.trim() || null,
  });

  const handleSave = async (approve = false) => {
    if (!invoiceId || !invoice) return;
    if (hasPartialLine) {
      toast({
        title: "Regel is niet compleet",
        description: "Vul bedrag én omschrijving in, of verwijder de lege regel.",
        variant: "destructive",
      });
      return;
    }
    if (approve && !linesMatch) {
      toast({
        title: "Boekingsregels sluiten nog niet aan",
        description: totalsMessage,
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const updates = buildHeaderUpdates();
      if (approve) updates.status = "gecontroleerd";
      await updateInvoice.mutateAsync({ id: invoiceId, ...updates });
      await replaceLines.mutateAsync({ invoiceId, lines: buildLinesPayload() });
      queryClient.invalidateQueries({ queryKey: ["purchase_invoice", invoiceId] });
      toast({ title: approve ? "Factuur goedgekeurd" : "Factuur opgeslagen" });
      if (approve && hasNext) goNext();
    } catch (e: any) {
      toast({ title: "Opslaan mislukt", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!invoiceId) {
    return <div className="p-8 text-muted-foreground">Geen factuur geselecteerd.</div>;
  }
  if (invoiceLoading || !initialized) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Laden…
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-muted-foreground">Factuur niet gevonden.</p>
        <Button variant="outline" onClick={() => navigate("/facturen")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Terug naar inkoopoverzicht
        </Button>
      </div>
    );
  }

  return (
    <div className="pb-24">
      {/* Page header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate("/facturen")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Inkoopoverzicht
        </Button>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold">{header.supplier || "Onbekende leverancier"}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{header.invoice_number || "geen nummer"}</span>
          <span className="text-muted-foreground">·</span>
          <span>{header.invoice_date ? new Date(header.invoice_date).toLocaleDateString("nl-NL") : "geen datum"}</span>
          <Badge variant="outline" className="ml-2">
            {header.status === "gecontroleerd" ? "Gecontroleerd" : header.status === "geexporteerd" ? "Geëxporteerd" : "Te controleren"}
          </Badge>
          {isBtwVrijgesteld && <Badge variant="secondary">BTW-vrijgesteld</Badge>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={goPrev} disabled={!hasPrev} title="Vorige factuur">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-16 text-center">
            {currentIdx >= 0 ? `${currentIdx + 1} / ${sortedInvoices.length}` : "—"}
          </span>
          <Button variant="outline" size="icon" onClick={goNext} disabled={!hasNext} title="Volgende factuur">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_65fr)_minmax(0,_35fr)] gap-6">
        {/* Left column */}
        <div className="space-y-6 min-w-0">
          {/* Factuurgegevens */}
          <Card>
            <CardContent className="pt-6">
              <h2 className="text-sm font-semibold text-muted-foreground mb-4">Factuurgegevens</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="col-span-2">
                  <Label>Klant</Label>
                  <Select value={header.client_id} onValueChange={(v) => patchHeader({ client_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecteer klant" /></SelectTrigger>
                    <SelectContent>
                      {(clients ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>Leverancier</Label>
                  <div className="flex gap-2">
                    <div className="w-1/2">
                      <Select
                        value={header.leverancier_id || "__none__"}
                        onValueChange={(v) => {
                          if (v === "__none__") return patchHeader({ leverancier_id: "" });
                          const lev = leveranciers?.find((l) => l.id === v);
                          patchHeader({ leverancier_id: v, supplier: lev?.naam ?? header.supplier });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="Bestaande leverancier" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— vrije invoer —</SelectItem>
                          {(leveranciers ?? []).map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.naam}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      className="w-1/2"
                      value={header.supplier}
                      onChange={(e) => patchHeader({ supplier: e.target.value })}
                      placeholder="Leverancier"
                    />
                  </div>
                </div>

                <div>
                  <Label>Factuurnummer</Label>
                  <Input
                    value={header.invoice_number}
                    onChange={(e) => patchHeader({ invoice_number: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Factuurdatum</Label>
                  <Input
                    type="date"
                    value={header.invoice_date}
                    onChange={(e) => patchHeader({ invoice_date: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Bedrag excl.</Label>
                  <Input
                    inputMode="decimal"
                    value={header.amount_excl}
                    onChange={(e) => patchHeader({ amount_excl: e.target.value })}
                    onBlur={() => {
                      const n = parseAmountInput(header.amount_excl);
                      patchHeader({ amount_excl: formatAmountInput(n) });
                    }}
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <Label>BTW-bedrag</Label>
                  <Input
                    inputMode="decimal"
                    value={header.btw_amount}
                    disabled={isBtwVrijgesteld}
                    onChange={(e) => patchHeader({ btw_amount: e.target.value })}
                    onBlur={() => {
                      const n = parseAmountInput(header.btw_amount);
                      patchHeader({ btw_amount: formatAmountInput(n) });
                    }}
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <Label>Bedrag incl.</Label>
                  <Input
                    inputMode="decimal"
                    value={header.amount_incl}
                    onChange={(e) => patchHeader({ amount_incl: e.target.value })}
                    onBlur={() => {
                      const n = parseAmountInput(header.amount_incl);
                      patchHeader({ amount_incl: formatAmountInput(n) });
                    }}
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <Label>BTW %</Label>
                  <Select
                    value={header.btw_percentage}
                    onValueChange={(v) => patchHeader({ btw_percentage: v })}
                    disabled={isBtwVrijgesteld}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0%</SelectItem>
                      <SelectItem value="9">9%</SelectItem>
                      <SelectItem value="21">21%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 md:col-span-4">
                  <Label>Standaard grootboek</Label>
                  <GrootboekCombobox
                    value={header.ledger_label}
                    onValueChange={(v) => patchHeader({ ledger_label: v })}
                    onIdChange={(id) => patchHeader({ ledger_id: id })}
                    noneOption
                  />
                </div>
                <div className="col-span-2 md:col-span-4">
                  <Label>Notities</Label>
                  <Textarea
                    rows={2}
                    value={header.notes}
                    onChange={(e) => patchHeader({ notes: e.target.value })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Totals summary */}
          <Card>
            <CardContent className="pt-6">
              <TotalsSummary
                header={headerTotals}
                lineTotals={lineTotals}
                diffs={diffs}
                state={totalsState}
                message={totalsMessage}
              />
            </CardContent>
          </Card>

          {/* Line table */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-muted-foreground">Boekingsregels</h2>
                <Button variant="outline" size="sm" onClick={addLine}>
                  <Plus className="h-4 w-4 mr-1" /> {lines.length === 0 ? "Eerste boekingsregel toevoegen" : "Regel toevoegen"}
                </Button>
              </div>
              {lines.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Nog geen boekingsregels. Voeg er één toe om te beginnen.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[180px]">Omschrijving</TableHead>
                        <TableHead className="min-w-[220px]">Grootboek</TableHead>
                        <TableHead className="text-right w-[110px]">Excl.</TableHead>
                        <TableHead className="w-[80px]">BTW %</TableHead>
                        <TableHead className="text-right w-[100px]">BTW</TableHead>
                        <TableHead className="text-right w-[110px]">Incl.</TableHead>
                        <TableHead className="w-[40px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line, idx) => {
                        const excl = parseAmountInput(line.amount_input) ?? 0;
                        const pct = parseAmountInput(line.btw_percentage) ?? 0;
                        const btw = round2(excl * pct / 100);
                        const incl = round2(excl + btw);
                        const partial = isPartiallyFilledLine({
                          omschrijving: line.omschrijving,
                          amount_input: line.amount_input,
                          grootboekrekening_id: line.grootboekrekening_id,
                        });
                        return (
                          <TableRow key={idx} className={partial ? "bg-amber-50/50 dark:bg-amber-950/20" : undefined}>
                            <TableCell>
                              <Input
                                value={line.omschrijving}
                                onChange={(e) => patchLine(idx, { omschrijving: e.target.value })}
                                placeholder="Omschrijving"
                                className="h-9"
                              />
                            </TableCell>
                            <TableCell>
                              <GrootboekCombobox
                                value={line.grootboek_label}
                                onValueChange={(v) => patchLine(idx, { grootboek_label: v })}
                                onIdChange={(id) => patchLine(idx, { grootboekrekening_id: id })}
                                noneOption
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                inputMode="decimal"
                                value={line.amount_input}
                                onChange={(e) => patchLine(idx, { amount_input: e.target.value })}
                                onBlur={() => {
                                  const n = parseAmountInput(line.amount_input);
                                  patchLine(idx, { amount_input: n === null ? line.amount_input : formatAmountInput(n) });
                                }}
                                placeholder="0,00"
                                className="h-9 text-right font-mono"
                              />
                            </TableCell>
                            <TableCell>
                              <Select
                                value={line.btw_percentage}
                                onValueChange={(v) => patchLine(idx, { btw_percentage: v })}
                                disabled={isBtwVrijgesteld}
                              >
                                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="0">0%</SelectItem>
                                  <SelectItem value="9">9%</SelectItem>
                                  <SelectItem value="21">21%</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">
                              {formatEuro(btw)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatEuro(incl)}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => removeLine(idx)}
                                aria-label="Regel verwijderen"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {hasPartialLine && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  Één of meer regels zijn niet compleet. Vul bedrag en omschrijving in of verwijder de regel.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: preview */}
        <div className="min-w-0">
          <div className="lg:sticky lg:top-4">
            <Card>
              <CardContent className="pt-6">
                <InvoicePreview filePath={invoice.file_path} />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Fixed action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur px-4 py-3">
        <div className="mx-auto max-w-[1600px] flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/facturen")}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Annuleren
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={() => handleSave(false)} disabled={!canSave}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Opslaan
            </Button>
            <Button onClick={() => handleSave(true)} disabled={!canApprove}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Goedkeuren
            </Button>
            {hasNext && (
              <Button variant="secondary" onClick={goNext}>
                Volgende <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TotalsSummary({
  header, lineTotals, diffs, state, message,
}: {
  header: { amount_excl: number | null; btw_amount: number | null; amount_incl: number | null };
  lineTotals: { sumExcl: number; sumBtw: number; sumIncl: number };
  diffs: { excl: number | null; btw: number | null; incl: number | null };
  state: "green" | "amber" | "red";
  message: string;
}) {
  const color =
    state === "green" ? "border-green-500/50 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
    : state === "amber" ? "border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    : "border-destructive/50 bg-destructive/10 text-destructive";

  const fmt = (n: number | null) => n == null ? "—" : formatEuro(n);
  const fmtDiff = (n: number | null) => n == null ? "—" : formatEuro(n);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-sm">
        <div className="text-muted-foreground"></div>
        <div className="text-right font-medium text-muted-foreground">Excl.</div>
        <div className="text-right font-medium text-muted-foreground">BTW</div>
        <div className="text-right font-medium text-muted-foreground">Incl.</div>

        <div className="text-muted-foreground">Factuur</div>
        <div className="text-right font-mono">{fmt(header.amount_excl)}</div>
        <div className="text-right font-mono">{fmt(header.btw_amount)}</div>
        <div className="text-right font-mono">{fmt(header.amount_incl)}</div>

        <div className="text-muted-foreground">Boekingsregels</div>
        <div className="text-right font-mono">{formatEuro(lineTotals.sumExcl)}</div>
        <div className="text-right font-mono">{formatEuro(lineTotals.sumBtw)}</div>
        <div className="text-right font-mono">{formatEuro(lineTotals.sumIncl)}</div>

        <div className="text-muted-foreground">Verschil</div>
        <div className="text-right font-mono">{fmtDiff(diffs.excl)}</div>
        <div className="text-right font-mono">{fmtDiff(diffs.btw)}</div>
        <div className="text-right font-mono">{fmtDiff(diffs.incl)}</div>
      </div>
      <div className={`rounded-md border px-3 py-2 text-sm ${color}`}>{message}</div>
    </div>
  );
}
