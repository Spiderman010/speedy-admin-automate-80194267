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
import { Upload, FileText, Download, CheckCircle2, Clock, AlertCircle, Loader2, ArrowUp, ArrowDown, Search, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { usePurchaseInvoices, useUpdatePurchaseInvoice, useDeletePurchaseInvoice } from "@/hooks/usePurchaseInvoices";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { exportPurchaseInvoicesCSV } from "@/lib/snelstart-export";
import { useClients } from "@/hooks/useClients";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { InvoiceEditDialog } from "@/components/InvoiceEditDialog";
import type { Tables } from "@/integrations/supabase/types";
import { getDocumentRouteLabel } from "@/lib/document-route";
import { getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";

const statusConfig = {
  te_controleren: { label: "Te controleren", icon: Clock, variant: "secondary" as const },
  gecontroleerd: { label: "Gecontroleerd", icon: CheckCircle2, variant: "default" as const },
  betaald: { label: "Betaald", icon: CheckCircle2, variant: "default" as const },
  geexporteerd: { label: "Geëxporteerd", icon: Download, variant: "outline" as const },
};

const formatCurrency = (amount: number | null) =>
  amount != null ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount) : "—";

type SortField = "supplier" | "invoice_number" | "date" | "amount" | "btw" | "status";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";

export default function Facturen() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const [clientFilter, setClientFilter] = useState(selectedClientId);
  const [uploadClientId, setUploadClientId] = useState<string>(
    selectedClientId !== "all" ? selectedClientId : ""
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const { toast } = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: clients } = useClients();
  const { data: invoices, isLoading } = usePurchaseInvoices(clientFilter !== "all" ? clientFilter : undefined);
  const updateInvoice = useUpdatePurchaseInvoice();
  const deleteInvoice = useDeletePurchaseInvoice();
  const [dragActive, setDragActive] = useState(false);
  const [editInvoice, setEditInvoice] = useState<Tables<"purchase_invoices"> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tables<"purchase_invoices"> | null>(null);

  useEffect(() => {
    setClientFilter(selectedClientId);
    setUploadClientId(selectedClientId !== "all" ? selectedClientId : "");
  }, [selectedClientId]);

  const handleSaveInvoice = async (id: string, updates: Partial<Tables<"purchase_invoices">>) => {
    await updateInvoice.mutateAsync({ id, ...updates });
    toast({ title: "Factuur opgeslagen" });
  };

  const handleApproveInvoice = async (id: string, updates: Partial<Tables<"purchase_invoices">>) => {
    await updateInvoice.mutateAsync({ id, ...updates });
    toast({ title: "Factuur goedgekeurd" });
  };

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

  const filteredSorted = useMemo(() => {
    if (!invoices) return [];
    let list = [...invoices];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(inv =>
        (inv.supplier || "").toLowerCase().includes(q) ||
        (inv.invoice_number || "").toLowerCase().includes(q) ||
        (inv.ledger_account_text || "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "supplier": cmp = (a.supplier || "").localeCompare(b.supplier || ""); break;
        case "invoice_number": cmp = (a.invoice_number || "").localeCompare(b.invoice_number || ""); break;
        case "date": cmp = (a.invoice_date || "").localeCompare(b.invoice_date || ""); break;
        case "amount": cmp = (a.amount_incl ?? 0) - (b.amount_incl ?? 0); break;
        case "btw": cmp = (a.btw_amount ?? 0) - (b.btw_amount ?? 0); break;
        case "status": cmp = (a.status || "").localeCompare(b.status || ""); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [invoices, searchQuery, sortField, sortDir]);

  const duplicateIds = useMemo(() => {
    const result = new Set<string>();
    if (!invoices) return result;
    const normBtw = (s: string | null | undefined) =>
      (s || "").toUpperCase().replace(/[\s.\-]/g, "");
    const normName = (s: string | null | undefined) =>
      (s || "").toLowerCase().trim().replace(/\s+/g, " ");
    const groups = new Map<string, typeof invoices>();
    for (const inv of invoices) {
      const num = (inv.invoice_number || "").trim();
      if (!num || !inv.client_id) continue;
      const key = `${inv.client_id}|${num}`;
      if (!groups.has(key)) groups.set(key, [] as any);
      groups.get(key)!.push(inv);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        const aBtw = normBtw(a.supplier_btw_number);
        const aName = normName(a.supplier);
        const aHasIdentity = !!a.leverancier_id || !!aBtw || !!aName;
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          const bBtw = normBtw(b.supplier_btw_number);
          const bName = normName(b.supplier);
          const bHasIdentity = !!b.leverancier_id || !!bBtw || !!bName;
          let match = false;
          if (a.leverancier_id && b.leverancier_id && a.leverancier_id === b.leverancier_id) match = true;
          else if (aBtw && bBtw && aBtw === bBtw) match = true;
          else if (aName && bName && aName === bName) match = true;
          else if (!aHasIdentity || !bHasIdentity) match = true;
          if (match) {
            result.add(a.id);
            result.add(b.id);
          }
        }
      }
    }
    return result;
  }, [invoices]);

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
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-invoice`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            body: formData,
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Onbekende fout" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const ext = result.extracted;

        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `✅ ${file.name} → ${ext?.supplier || "Verwerkt"} ${ext?.amount_incl ? formatCurrency(ext.amount_incl) : ""}`,
        ]);
        successCount++;
      } catch (e: any) {
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `❌ ${file.name}: ${e.message}`,
        ]);
        failCount++;
      }
    }

    setUploading(false);
    queryClient.invalidateQueries({ queryKey: ["purchase_invoices"] });
    if (failCount > 0 && successCount === 0) {
      toast({ title: "Verwerking mislukt", description: `${failCount} bestand(en) niet verwerkt.`, variant: "destructive" });
    } else if (failCount > 0) {
      toast({ title: "Gedeeltelijk verwerkt", description: `${successCount} gelukt, ${failCount} mislukt.`, variant: "destructive" });
    } else {
      toast({ title: "Verwerking voltooid", description: `${successCount} bestand(en) verwerkt.` });
    }
  }, [uploadClientId, session, toast, queryClient]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  }, [processFiles]);

  const getClientName = (clientId: string) => clients?.find((c) => c.id === clientId)?.name ?? "—";

  return (
    <>
      <PageHeader title="Inkoopfacturen" description="Upload, verwerk en exporteer inkoopfacturen">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Klant" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => {
          const exportable = invoices?.filter(i => i.status === "gecontroleerd" || i.status === "betaald") ?? [];
          if (!exportable.length) { toast({ title: "Geen gecontroleerde of betaalde facturen om te exporteren", variant: "destructive" }); return; }
          const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
          const ids = exportPurchaseInvoicesCSV(exportable, clientName);
          ids.forEach(id => updateInvoice.mutateAsync({ id, status: "geexporteerd" }));
          toast({ title: `${ids.length} facturen geëxporteerd voor Snelstart` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
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
                <Select value={uploadClientId} onValueChange={(v) => { setUploadClientId(v); setSelectedClientId(v); }}>
                  <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant voor upload" /></SelectTrigger>
                  <SelectContent>
                    {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
                  dragActive ? "border-primary bg-primary/5" : "border-border"
                } ${!uploadClientId ? "opacity-50 pointer-events-none" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                  {uploading ? (
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                  ) : (
                    <Upload className="h-8 w-8 text-primary" />
                  )}
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {uploading ? "Facturen worden verwerkt..." : "Sleep facturen hierheen"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  PDF, JPG of PNG bestanden — AI herkent automatisch leverancier, bedragen en BTW
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  className="mt-4"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !uploadClientId}
                >
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
          <div className="mb-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoeken op leverancier, factuurnummer of grootboek..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 max-w-md"
            />
          </div>
          <Card>
            <CardContent className="p-6">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !filteredSorted.length ? (
                <div className="py-12 text-center text-muted-foreground">
                  {searchQuery ? "Geen facturen gevonden voor deze zoekopdracht." : "Nog geen facturen. Upload je eerste facturen via het Upload-tabblad."}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("supplier")}>Leverancier<SortIcon field="supplier" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("invoice_number")}>Factuurnummer<SortIcon field="invoice_number" /></TableHead>
                      <TableHead>Klant</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                      <TableHead className="text-right">Openstaand</TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("btw")}>BTW<SortIcon field="btw" /></TableHead>
                      <TableHead>Grootboek</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>Status<SortIcon field="status" /></TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSorted.map((inv) => {
                      const sc = statusConfig[inv.status as keyof typeof statusConfig] || statusConfig.te_controleren;
                      return (
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setEditInvoice(inv)}>
                          <TableCell className="font-medium">{inv.supplier}</TableCell>
                          <TableCell className="font-mono text-sm">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span>{inv.invoice_number || "—"}</span>
                              {duplicateIds.has(inv.id) && (
                                <Badge variant="outline" className="border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-xs font-normal">
                                  Mogelijk dubbel
                                </Badge>
                              )}
                              {(inv as any).snelstart_package_downloaded_at && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  Pakket gedownload{((inv as any).snelstart_package_download_count ?? 0) > 1 ? ` (${(inv as any).snelstart_package_download_count}×)` : ""}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{getClientName(inv.client_id)}</TableCell>
                          <TableCell>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(inv.amount_incl)}</TableCell>
                          <TableCell className="text-right">
                            {(() => {
                              const total = getInvoiceTotalAmount(inv);
                              const remaining = getInvoiceRemainingAmount(inv);
                              if (remaining === 0 || inv.status === "betaald") {
                                return <span className="font-mono text-sm text-green-600">€0,00</span>;
                              }
                              if (total != null && remaining != null && remaining < total) {
                                return (
                                  <div>
                                    <Badge variant="secondary" className="text-[10px] mb-0.5">Deelbetaling</Badge>
                                    <div className="font-mono text-sm text-amber-600">{formatCurrency(remaining)}</div>
                                  </div>
                                );
                              }
                              const openstaand = remaining ?? total;
                              if (openstaand != null) {
                                return <span className="font-mono text-sm text-amber-600">{formatCurrency(openstaand)}</span>;
                              }
                              return <span className="text-muted-foreground text-sm">—</span>;
                            })()}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">{formatCurrency(inv.btw_amount)}</TableCell>
                          <TableCell className="text-sm">{inv.ledger_account_text || "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {getDocumentRouteLabel((inv as any).document_route)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={sc.variant} className="gap-1">
                              <sc.icon className="h-3 w-3" />{sc.label}
                            </Badge>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteTarget(inv)}
                              aria-label="Verwijderen"
                            >
                              <Trash2 className="h-4 w-4" />
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

      <InvoiceEditDialog
        invoice={editInvoice}
        open={!!editInvoice}
        onOpenChange={(open) => !open && setEditInvoice(null)}
        onSave={handleSaveInvoice}
        onApprove={handleApproveInvoice}
        client={editInvoice ? clients?.find(c => c.id === editInvoice.client_id) ?? null : null}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Inkoopfactuur verwijderen</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je deze inkoopfactuur wilt verwijderen? Dit kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteInvoice.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteInvoice.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                try {
                  await deleteInvoice.mutateAsync({ id: deleteTarget.id, file_path: deleteTarget.file_path });
                  toast({ title: "Inkoopfactuur verwijderd" });
                  if (editInvoice?.id === deleteTarget.id) setEditInvoice(null);
                  setDeleteTarget(null);
                } catch (err: any) {
                  toast({ title: "Verwijderen mislukt", description: err?.message, variant: "destructive" });
                }
              }}
            >
              Verwijderen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
