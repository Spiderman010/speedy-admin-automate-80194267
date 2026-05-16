import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Plus, Download, FileText, CheckCircle2, Clock, Send, Upload, Loader2, Eye, ArrowUp, ArrowDown, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useSalesInvoices, useAddSalesInvoice, useUpdateSalesInvoice } from "@/hooks/useSalesInvoices";
import { exportSalesInvoicesCSV } from "@/lib/snelstart-export";
import { Skeleton } from "@/components/ui/skeleton";
import { SalesInvoiceDialog, type SalesInvoiceFormData } from "@/components/SalesInvoiceDialog";
import { SalesInvoiceEditDialog } from "@/components/SalesInvoiceEditDialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { useClientContext } from "@/hooks/useClientContext";
import { getInvoicePaymentState } from "@/lib/invoice-balances";

function Chip({
  label, active, count, onClick, activeClassName,
}: {
  label: string; active: boolean; count: number;
  onClick: () => void; activeClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? (activeClassName ?? "border-primary bg-primary text-primary-foreground")
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 text-[10px] font-semibold leading-tight ${active ? "bg-black/15" : "bg-muted"}`}>
        {count}
      </span>
    </button>
  );
}

const statusConfig: Record<string, { label: string; icon: typeof Clock; variant: "default" | "secondary" | "outline" }> = {
  concept: { label: "Concept", icon: Clock, variant: "secondary" },
  verzonden: { label: "Verzonden", icon: Send, variant: "default" },
  betaald: { label: "Betaald", icon: CheckCircle2, variant: "outline" },
  gecontroleerd: { label: "Gecontroleerd", icon: CheckCircle2, variant: "outline" },
};

const formatCurrency = (amount: number | null) =>
  amount != null ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount) : "—";

type SortField = "invoice_number" | "client" | "customer_name" | "date" | "due_date" | "amount" | "btw" | "status";
type SortDir = "asc" | "desc";

export default function Verkoop() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const [clientFilter, setClientFilter] = useState(selectedClientId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadClientId, setUploadClientId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { data: clients } = useClients();
  const { data: invoices, isLoading } = useSalesInvoices(clientFilter !== "all" ? clientFilter : undefined);
  const addInvoice = useAddSalesInvoice();
  const updateInvoice = useUpdateSalesInvoice();
  const [editInvoice, setEditInvoice] = useState<any>(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    setClientFilter(selectedClientId);
  }, [selectedClientId]);

  const getClientName = (id: string) => clients?.find(c => c.id === id)?.name ?? "—";

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ArrowUp className="inline h-3 w-3 ml-1" /> : <ArrowDown className="inline h-3 w-3 ml-1" />;
  };

  const searchFiltered = useMemo(() => {
    if (!invoices) return [];
    if (!searchQuery.trim()) return invoices;
    const q = searchQuery.toLowerCase();
    return invoices.filter(inv =>
      (inv.invoice_number || "").toLowerCase().includes(q) ||
      (inv.customer_name || "").toLowerCase().includes(q) ||
      (inv.status || "").toLowerCase().includes(q)
    );
  }, [invoices, searchQuery]);

  // Each count-base applies all OTHER active filters so chip numbers show "what you'd see if you clicked this"
  const forPaymentCounts = useMemo(() => {
    if (workflowFilter === "all") return searchFiltered;
    return searchFiltered.filter(inv => inv.status === workflowFilter);
  }, [searchFiltered, workflowFilter]);

  const forWorkflowCounts = useMemo(() => {
    if (paymentFilter === "all") return searchFiltered;
    return searchFiltered.filter(inv => {
      const state = getInvoicePaymentState(inv);
      if (paymentFilter === "paid") return state === "paid";
      if (paymentFilter === "partial") return state === "partial";
      return state === "open" || state === "unknown";
    });
  }, [searchFiltered, paymentFilter]);

  const filteredSorted = useMemo(() => {
    let list = [...searchFiltered];
    if (workflowFilter !== "all") list = list.filter(inv => inv.status === workflowFilter);
    if (paymentFilter !== "all") list = list.filter(inv => {
      const state = getInvoicePaymentState(inv);
      if (paymentFilter === "paid") return state === "paid";
      if (paymentFilter === "partial") return state === "partial";
      return state === "open" || state === "unknown";
    });
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "invoice_number": cmp = (a.invoice_number || "").localeCompare(b.invoice_number || ""); break;
        case "client": cmp = getClientName(a.client_id).localeCompare(getClientName(b.client_id)); break;
        case "customer_name": cmp = (a.customer_name || "").localeCompare(b.customer_name || ""); break;
        case "date": cmp = (a.invoice_date || "").localeCompare(b.invoice_date || ""); break;
        case "due_date": cmp = (a.due_date || "").localeCompare(b.due_date || ""); break;
        case "amount": cmp = (a.amount_incl ?? 0) - (b.amount_incl ?? 0); break;
        case "btw": cmp = (a.btw_amount ?? 0) - (b.btw_amount ?? 0); break;
        case "status": cmp = (a.status || "").localeCompare(b.status || ""); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [searchFiltered, workflowFilter, paymentFilter, sortField, sortDir, clients]);

  const handleManualSave = async (form: SalesInvoiceFormData, file: File | null) => {
    let pdfPath: string | null = null;
    if (file) {
      const ext = file.name.split(".").pop() || "pdf";
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const path = `${userId}/sales/${form.client_id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("invoices").upload(path, file);
      if (uploadErr) {
        toast({ title: "Upload mislukt", description: uploadErr.message, variant: "destructive" });
        return;
      }
      pdfPath = path;
    }
    await addInvoice.mutateAsync({
      client_id: form.client_id,
      customer_name: form.customer_name,
      invoice_number: form.invoice_number,
      invoice_date: form.invoice_date,
      due_date: form.due_date || null,
      amount_excl: form.amount_excl ? parseFloat(form.amount_excl) : null,
      btw_percentage: form.btw_percentage ? parseFloat(form.btw_percentage) : null,
      btw_amount: form.btw_amount ? parseFloat(form.btw_amount) : null,
      amount_incl: form.amount_incl ? parseFloat(form.amount_incl) : null,
      remaining_amount: form.amount_incl ? parseFloat(form.amount_incl) : form.amount_excl ? parseFloat(form.amount_excl) : null,
      notes: form.notes || null,
      pdf_path: pdfPath,
    });
    toast({ title: "Verkoopfactuur aangemaakt" });
  };

  const processFiles = useCallback(async (files: File[]) => {
    if (!uploadClientId) {
      toast({ title: "Selecteer eerst een klant", variant: "destructive" });
      return;
    }
    if (!session?.access_token) {
      toast({ title: "Niet ingelogd", variant: "destructive" });
      return;
    }

    const validFiles = files.filter(f =>
      ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type)
    );
    if (!validFiles.length) {
      toast({ title: "Geen geldige bestanden", description: "Gebruik PDF, JPG of PNG.", variant: "destructive" });
      return;
    }

    setUploading(true);
    setUploadProgress([]);
    let successCount = 0;
    let failCount = 0;

    for (const file of validFiles) {
      setUploadProgress(prev => [...prev, `⏳ ${file.name} wordt verwerkt...`]);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("client_id", uploadClientId);

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-sales-invoice`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: formData,
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Onbekende fout" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const ext = result.extracted;
        successCount++;
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `✅ ${file.name} → ${ext?.customer_name || "Verwerkt"} ${ext?.amount_incl ? formatCurrency(ext.amount_incl) : ""}`,
        ]);
      } catch (e: any) {
        failCount++;
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `❌ ${file.name}: ${e.message}`,
        ]);
      }
    }

    setUploading(false);
    queryClient.invalidateQueries({ queryKey: ["sales_invoices"] });

    if (failCount === 0) {
      toast({ title: "Verwerking voltooid", description: `${successCount} bestand(en) verwerkt.` });
    } else if (successCount === 0) {
      toast({ title: "Verwerking mislukt", description: `Geen bestanden konden worden verwerkt.`, variant: "destructive" });
    } else {
      toast({ title: "Gedeeltelijk verwerkt", description: `${successCount} geslaagd, ${failCount} mislukt.`, variant: "destructive" });
    }
  }, [uploadClientId, session, toast, queryClient]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  }, [processFiles]);

  return (
    <>
      <PageHeader title="Verkoopfacturen" description="Upload, verwerk en beheer verkoopfacturen">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Klant" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => {
          const exportable = invoices?.filter(i => i.status === "gecontroleerd" || i.status === "betaald") ?? [];
          if (!exportable.length) {
            toast({ title: "Geen exporteerbare verkoopfacturen", description: "Alleen gecontroleerde en betaalde facturen worden geëxporteerd.", variant: "destructive" });
            return;
          }
          const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
          exportSalesInvoicesCSV(exportable, clientName);
          toast({ title: `${exportable.length} verkoopfacturen geëxporteerd voor Snelstart` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export
        </Button>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />Handmatig toevoegen
        </Button>
      </PageHeader>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overzicht</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="mt-6 space-y-4">
          <Card>
            <CardContent className="p-6">
              <div className="mb-4">
                <label className="text-sm font-medium mb-2 block">Klant selecteren *</label>
                <Select value={uploadClientId} onValueChange={setUploadClientId}>
                  <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant voor upload" /></SelectTrigger>
                  <SelectContent>
                    {clients?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
                  dragActive ? "border-primary bg-primary/5" : "border-border"
                } ${!uploadClientId ? "opacity-50 pointer-events-none" : ""}`}
                onDragOver={e => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                  {uploading ? <Loader2 className="h-8 w-8 text-primary animate-spin" /> : <Upload className="h-8 w-8 text-primary" />}
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {uploading ? "Facturen worden verwerkt..." : "Sleep verkoopfacturen hierheen"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  PDF, JPG of PNG — AI herkent automatisch klantnaam, bedragen en BTW
                </p>
                <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple className="hidden" onChange={handleFileSelect} />
                <Button className="mt-4" onClick={() => fileInputRef.current?.click()} disabled={uploading || !uploadClientId}>
                  <FileText className="mr-2 h-4 w-4" />Bestanden selecteren
                </Button>
              </div>
            </CardContent>
          </Card>

          {uploadProgress.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h4 className="font-display text-sm font-semibold mb-2">Verwerkingsresultaten</h4>
                <div className="space-y-1 text-sm font-mono">
                  {uploadProgress.map((line, i) => (
                    <div key={i} className={line.startsWith("❌") ? "text-destructive" : ""}>{line}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="overview" className="mt-6">
          <div className="mb-5 space-y-2.5">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Zoeken op factuurnummer, klantnaam of status..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Betaalstatus</span>
              <Chip label="Alle" active={paymentFilter === "all"} count={forPaymentCounts.length}
                onClick={() => setPaymentFilter("all")} />
              <Chip label="Openstaand" active={paymentFilter === "open"}
                count={forPaymentCounts.filter(inv => { const s = getInvoicePaymentState(inv); return s === "open" || s === "unknown"; }).length}
                onClick={() => setPaymentFilter(paymentFilter === "open" ? "all" : "open")}
                activeClassName="border-orange-400 bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200" />
              <Chip label="Deelbetaling" active={paymentFilter === "partial"}
                count={forPaymentCounts.filter(inv => getInvoicePaymentState(inv) === "partial").length}
                onClick={() => setPaymentFilter(paymentFilter === "partial" ? "all" : "partial")}
                activeClassName="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" />
              <Chip label="Betaald" active={paymentFilter === "paid"}
                count={forPaymentCounts.filter(inv => getInvoicePaymentState(inv) === "paid").length}
                onClick={() => setPaymentFilter(paymentFilter === "paid" ? "all" : "paid")}
                activeClassName="border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200" />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Workflow</span>
              <Chip label="Alle" active={workflowFilter === "all"} count={forWorkflowCounts.length}
                onClick={() => setWorkflowFilter("all")} />
              <Chip label="Concept" active={workflowFilter === "concept"}
                count={forWorkflowCounts.filter(inv => inv.status === "concept").length}
                onClick={() => setWorkflowFilter(workflowFilter === "concept" ? "all" : "concept")} />
              <Chip label="Verzonden" active={workflowFilter === "verzonden"}
                count={forWorkflowCounts.filter(inv => inv.status === "verzonden").length}
                onClick={() => setWorkflowFilter(workflowFilter === "verzonden" ? "all" : "verzonden")} />
              <Chip label="Gecontroleerd" active={workflowFilter === "gecontroleerd"}
                count={forWorkflowCounts.filter(inv => inv.status === "gecontroleerd").length}
                onClick={() => setWorkflowFilter(workflowFilter === "gecontroleerd" ? "all" : "gecontroleerd")} />
              <Chip label="Betaald" active={workflowFilter === "betaald"}
                count={forWorkflowCounts.filter(inv => inv.status === "betaald").length}
                onClick={() => setWorkflowFilter(workflowFilter === "betaald" ? "all" : "betaald")} />
            </div>
          </div>
          <Card>
            <CardContent className="p-6">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !filteredSorted.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                    <FileText className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold">
                    {searchQuery ? "Geen facturen gevonden" : "Nog geen verkoopfacturen"}
                  </h3>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    {searchQuery ? "Probeer een andere zoekopdracht." : "Upload facturen via het Upload-tabblad of voeg handmatig toe."}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("invoice_number")}>Factuurnummer<SortIcon field="invoice_number" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("client")}>Klant<SortIcon field="client" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("customer_name")}>Klantnaam<SortIcon field="customer_name" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("due_date")}>Vervaldatum<SortIcon field="due_date" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("btw")}>BTW<SortIcon field="btw" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>Status<SortIcon field="status" /></TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSorted.map(inv => {
                      const sc = statusConfig[inv.status] || statusConfig.concept;
                      return (
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => { setEditInvoice(inv); setEditOpen(true); }}>
                          <TableCell className="font-mono text-sm font-medium">{inv.invoice_number}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{getClientName(inv.client_id)}</TableCell>
                          <TableCell className="font-medium">{inv.customer_name}</TableCell>
                          <TableCell>{new Date(inv.invoice_date).toLocaleDateString("nl-NL")}</TableCell>
                          <TableCell>{inv.due_date ? new Date(inv.due_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(inv.amount_incl)}</TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">{formatCurrency(inv.btw_amount)}</TableCell>
                          <TableCell>
                            <Badge variant={sc.variant} className="gap-1">
                              <sc.icon className="h-3 w-3" />{sc.label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setEditInvoice(inv); setEditOpen(true); }}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SalesInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        clients={clients?.map(c => ({ id: c.id, name: c.name, btw_vrijgesteld: c.btw_vrijgesteld })) ?? []}
        onSave={handleManualSave}
      />

      <SalesInvoiceEditDialog
        invoice={editInvoice}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSave={async (id, updates) => {
          try {
            await updateInvoice.mutateAsync({ id, ...updates } as any);
            toast({ title: "Factuur opgeslagen" });
          } catch (e: any) {
            toast({ title: "Opslaan mislukt", description: e.message, variant: "destructive" });
            throw e;
          }
        }}
        onApprove={async (id, updates) => {
          try {
            await updateInvoice.mutateAsync({ id, ...updates } as any);
            toast({ title: "Factuur goedgekeurd" });
          } catch (e: any) {
            toast({ title: "Goedkeuren mislukt", description: e.message, variant: "destructive" });
            throw e;
          }
        }}
      />
    </>
  );
}
