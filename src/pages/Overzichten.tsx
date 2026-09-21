import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  CalendarCheck,
  ClipboardCheck,
  Download,
  FileBarChart,
  Landmark,
  Loader2,
  Minus,
  ReceiptText,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { exportAllForClient } from "@/lib/snelstart-export";
import { useToast } from "@/hooks/use-toast";
import { formatEuro } from "@/lib/format";

const reportTypes = [
  {
    title: "Proef- en saldibalans",
    icon: FileBarChart,
    status: "Beschikbaar",
    href: "/overzichten/proef-saldibalans",
  },
  // Balans/W&V PR 4: beide zijn nu beschikbaar. De beginbalans (6C-b8) vult de
  // stand van vóór het eerste document, en de resultaatbestemming wordt als
  // presentatieregel afgeleid — er wordt geen boeking voor verzonnen.
  {
    title: "Balans",
    icon: Landmark,
    status: "Beschikbaar",
    href: "/grootboek/balans",
  },
  {
    title: "Winst-en-verliesrekening",
    icon: BarChart3,
    status: "Beschikbaar",
    href: "/grootboek/winst-verlies",
  },
  // Diagnostics v1: één controle per administratie en periode, die uitsluitend
  // bestaande oordelen samenvat — geen tweede boekhouding.
  {
    title: "Controle",
    icon: ClipboardCheck,
    status: "Beschikbaar",
    href: "/overzichten/controle",
  },
  // Year Close PR 1: alleen gereedheid; de afsluitmotor bestaat nog niet.
  {
    title: "Jaarafsluiting",
    icon: CalendarCheck,
    status: "Beschikbaar",
    href: "/overzichten/jaarafsluiting",
  },
  { title: "Grootboek", icon: BookOpen, status: "Nog niet beschikbaar" },
  { title: "BTW-overzicht", icon: ReceiptText, status: "Nog niet beschikbaar" },
] as const;

export default function Overzichten() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const {
    data: clients,
    isLoading: clientsLoading,
    isError: clientsError,
    refetch: refetchClients,
  } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const [selectedClient, setSelectedClient] = useState<string>(
    selectedClientId !== "all" ? selectedClientId : ""
  );
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setSelectedClient(selectedClientId !== "all" ? selectedClientId : "");
  }, [selectedClientId]);

  const {
    data: invoices,
    isLoading: invoicesLoading,
    isError: invoicesError,
    refetch: refetchInvoices,
  } = usePurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    clientId: selectedClient || undefined,
    enabled: orgEnabled,
  });
  const {
    data: entries,
    isLoading: entriesLoading,
    isError: entriesError,
    refetch: refetchEntries,
  } = useJournalEntries({
    organizationId: activeOrganizationId ?? undefined,
    clientId: selectedClient || undefined,
    enabled: orgEnabled,
  });
  const {
    data: transactions,
    isLoading: transactionsLoading,
    isError: transactionsError,
    refetch: refetchTransactions,
  } = useBankTransactions({
    organizationId: activeOrganizationId ?? undefined,
    clientId: selectedClient || undefined,
    enabled: orgEnabled,
  });
  const {
    data: grootboekrekeningen,
    isLoading: accountsLoading,
    isError: accountsError,
    refetch: refetchAccounts,
  } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const totalInvoices = invoices?.reduce((s, i) => s + (i.amount_incl ?? 0), 0) ?? 0;
  const totalBtw = invoices?.reduce((s, i) => s + (i.btw_amount ?? 0), 0) ?? 0;
  const totalEntries = entries?.reduce((s, e) => s + e.amount, 0) ?? 0;
  const isLoading = clientsLoading || invoicesLoading || entriesLoading || transactionsLoading || accountsLoading;
  const isError = clientsError || invoicesError || entriesError || transactionsError || accountsError;
  const hasFinancialData = Boolean(invoices?.length || entries?.length || transactions?.length);

  const handleRetry = () => {
    void Promise.all([
      refetchClients(),
      refetchInvoices(),
      refetchEntries(),
      refetchTransactions(),
      refetchAccounts(),
    ]);
  };

  const handleExportAll = async () => {
    if (!selectedClient) {
      toast({ title: "Selecteer eerst een klant", variant: "destructive" });
      return;
    }
    const clientRecord = clients?.find(c => c.id === selectedClient);
    const clientName = clientRecord?.name ?? "klant";
    const bankDagboek = clientRecord?.bank_dagboek ?? 1100;
    setExporting(true);
    try {
      await exportAllForClient(
        clientName,
        invoices?.filter(i => i.status === "gecontroleerd" || i.status === "betaald") ?? [],
        entries ?? [],
        transactions ?? [],
        grootboekrekeningen ?? [],
        bankDagboek,
      );
      toast({ title: "ZIP-bestand gedownload", description: `Export voor ${clientName} is klaar.` });
    } catch (e: any) {
      toast({ title: "Exportfout", description: e.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      <div className="[&>div]:mb-0 [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-4 sm:[&>div]:flex-row [&>div>div]:min-w-0 [&>div>div:last-child]:w-full sm:[&>div>div:last-child]:w-72">
        <PageHeader title="Rapportages" description="Financiële overzichten per administratie">
          <div className="min-w-0 w-full space-y-1.5">
            <Label htmlFor="administratie-filter">Administratie</Label>
            <Select value={selectedClient} onValueChange={(v) => { setSelectedClient(v); setSelectedClientId(v); }}>
              <SelectTrigger id="administratie-filter" aria-label="Administratie selecteren" className="h-9 min-w-0 w-full">
                <SelectValue placeholder="Selecteer administratie" />
              </SelectTrigger>
              <SelectContent>
                {clients?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PageHeader>
      </div>

      <section aria-labelledby="rapporttype-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 id="rapporttype-heading" className="font-display text-base font-semibold">Rapporttype</h2>
            <p className="text-sm text-muted-foreground">Kies het financiële overzicht dat u wilt raadplegen.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {reportTypes.map((rapport) => {
            const { title, icon: Icon, status } = rapport;
            const href = "href" in rapport ? rapport.href : undefined;
            const inhoud = (
              <CardContent className="flex min-h-32 flex-col justify-between p-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="rounded-md border bg-muted/50 p-2" aria-hidden="true">
                    <Icon className={`h-4 w-4 ${href ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <h3 className="min-w-0 break-words text-sm font-semibold leading-5">{title}</h3>
                </div>
                <Badge
                  variant="outline"
                  className={`mt-4 w-fit max-w-full whitespace-normal text-left font-normal ${href ? "" : "text-muted-foreground"}`}
                >
                  {status}
                </Badge>
              </CardContent>
            );
            // Alleen een beschikbaar rapport is aanklikbaar; de rest blijft een
            // inerte kaart, zodat niemand op een dood pad klikt.
            return href ? (
              <Card key={title} className="min-w-0 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30">
                <Link to={href} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${title}`}>
                  {inhoud}
                </Link>
              </Card>
            ) : (
              <Card key={title} className="min-w-0 shadow-sm">{inhoud}</Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="filters-heading" className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 id="filters-heading" className="mb-3 font-display text-base font-semibold">Filters</h2>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto] lg:items-end">
          {[
            ["Boekjaar", "Boekjaar nog niet beschikbaar"],
            ["Periode", "Periode nog niet beschikbaar"],
            ["Vergelijking", "Vergelijking nog niet beschikbaar"],
          ].map(([label, placeholder]) => (
            <div key={label} className="min-w-0 space-y-1.5">
              <Label>{label}</Label>
              <Select disabled>
                <SelectTrigger aria-label={placeholder} className="h-9 min-w-0 w-full">
                  <SelectValue placeholder={placeholder} />
                </SelectTrigger>
              </Select>
            </div>
          ))}
          <Button className="h-9 w-full whitespace-nowrap sm:col-span-2 lg:col-span-1 lg:w-auto" onClick={handleExportAll} disabled={exporting || !selectedClient}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Export alles (Snelstart)
          </Button>
        </div>
      </section>

      {!selectedClient ? (
        <Card className="shadow-sm">
          <CardContent className="flex min-h-48 flex-col items-center justify-center px-4 py-10 text-center">
            <FileBarChart className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="font-display text-base font-semibold">Geen administratie geselecteerd</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">Selecteer een administratie om rapportages te bekijken.</p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <section aria-label="Rapportages laden" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((item) => <Skeleton key={item} className="h-28 w-full" />)}
          </div>
          <Skeleton className="h-64 w-full" />
        </section>
      ) : isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">Rapportagegegevens konden niet worden geladen.</p>
              <p className="text-sm text-muted-foreground">Probeer het opnieuw. Uw gegevens zijn niet gewijzigd.</p>
            </div>
          </div>
          <Button type="button" variant="outline" className="h-9 shrink-0 whitespace-nowrap" onClick={handleRetry}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Opnieuw proberen
          </Button>
        </div>
      ) : !hasFinancialData ? (
        <Card className="shadow-sm">
          <CardContent className="flex min-h-48 flex-col items-center justify-center px-4 py-10 text-center">
            <ReceiptText className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="font-display text-base font-semibold">Geen financiële gegevens beschikbaar</h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">Er zijn geen financiële gegevens voor de geselecteerde administratie of periode.</p>
          </CardContent>
        </Card>
      ) : (
        <section aria-labelledby="huidig-overzicht-heading" className="space-y-4">
          <div>
            <h2 id="huidig-overzicht-heading" className="font-display text-base font-semibold">Brondocumenten van deze administratie</h2>
            <p className="text-sm text-muted-foreground">
              Tellingen uit de brondocumenten, niet uit het grootboek. Voor geboekte grootboekcijfers:
              zie de proef- en saldibalans hierboven.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-success" />
              <p className="text-sm text-muted-foreground">Inkoopfacturen</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold tabular-nums">{formatEuro(totalInvoices)}</p>
            <p className="text-xs text-muted-foreground">{invoices?.length ?? 0} facturen</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-destructive" />
              <p className="text-sm text-muted-foreground">BTW totaal</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold tabular-nums">{formatEuro(totalBtw)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Minus className="h-4 w-4 text-primary" />
              <p className="text-sm text-muted-foreground">Boekingen totaal</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold tabular-nums">{formatEuro(totalEntries)}</p>
            <p className="text-xs text-muted-foreground">{entries?.length ?? 0} boekingen</p>
          </CardContent>
        </Card>
          </div>

          <Card className="min-w-0 shadow-sm">
        <CardHeader>
          <CardTitle className="font-display text-lg">Recente inkoopfacturen</CardTitle>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {!invoices?.length ? (
            <div className="px-4 py-10 text-center sm:px-0">
              <p className="font-medium">Geen financiële gegevens beschikbaar</p>
              <p className="mt-1 text-sm text-muted-foreground">Er zijn geen financiële gegevens voor de geselecteerde administratie of periode.</p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table className="min-w-[760px]">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Leverancier</TableHead>
                  <TableHead>Factuurnummer</TableHead>
                  <TableHead>Datum</TableHead>
                  <TableHead className="text-right">Excl. BTW</TableHead>
                  <TableHead className="text-right">BTW</TableHead>
                  <TableHead className="text-right">Incl. BTW</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.slice(0, 10).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="max-w-56 truncate font-medium" title={inv.supplier}>{inv.supplier}</TableCell>
                    <TableCell className="font-mono text-sm tabular-nums">{inv.invoice_number || "—"}</TableCell>
                    <TableCell>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{inv.amount_excl != null ? formatEuro(inv.amount_excl) : "—"}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{inv.btw_amount != null ? formatEuro(inv.btw_amount) : "—"}</TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">{inv.amount_incl != null ? formatEuro(inv.amount_incl) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
