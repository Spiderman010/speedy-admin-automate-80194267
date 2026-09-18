import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Link2, PenLine, Plus } from "lucide-react";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useClients } from "@/hooks/useClients";
import { useLeveranciers } from "@/hooks/useLeveranciers";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import {
  usePurchaseInvoiceLines,
  useSavePurchaseInvoiceWithLines,
  type InvoiceLineInput,
  type PurchaseInvoiceHeaderSaveInput,
} from "@/hooks/usePurchaseInvoiceLines";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useToast } from "@/hooks/use-toast";
import {
  computeLineTotals,
  computeLineDiffs,
  countLinesMissingLedgerAccount,
  derivePrefillLine,
  isBlankLine,
  isPartiallyFilledLine,
} from "@/lib/purchase-line-validation";
import { aggregateInvoiceLines, evaluatePurchaseInvoice } from "@/lib/ledger-catchup";
import { deriveHeaderFromLines } from "@/lib/purchase-header-derivation";
import { parseAmountInput, formatAmountInput } from "@/lib/amount-input";
import { round2 } from "@/lib/btw-calc";
import { formatEuro } from "@/lib/format";
import type { Tables } from "@/integrations/supabase/types";
import { PurchaseInvoiceWorkspaceHeader } from "@/components/purchase/PurchaseInvoiceWorkspaceHeader";
import { usePurchaseInvoicePosting, usePostPurchaseInvoice } from "@/hooks/usePurchaseInvoicePosting";
import { PurchaseInvoiceDocumentPreview } from "@/components/purchase/PurchaseInvoiceDocumentPreview";
import {
  PurchaseInvoiceTotalsSummary,
  PurchaseInvoiceTotalsStatusPill,
} from "@/components/purchase/PurchaseInvoiceTotalsSummary";
import {
  PurchaseInvoiceLinesTable,
  type LineRow,
} from "@/components/purchase/PurchaseInvoiceLinesTable";
import { PurchaseInvoiceActionBar } from "@/components/purchase/PurchaseInvoiceActionBar";
import { PurchaseInvoicePostingReadiness } from "@/components/purchase/PurchaseInvoicePostingReadiness";

type PurchaseInvoice = Tables<"purchase_invoices">;

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

/** Small uppercase group label inside the Factuurgegevens card. */
function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * Routewrapper — de enige plek die de factuur-id uit de route leest.
 *
 * De route `/facturen/inkoop/:invoiceId` wisselt bij "Vorige"/"Volgende"
 * alleen de parameter; React Router houdt hetzelfde element gemonteerd. Zonder
 * ingreep blijft alle component-state van de vórige factuur staan terwijl de
 * query (en dus de documentviewer) al de nieuwe factuur toont.
 *
 * De `key` dwingt een verse montage per factuur, zodat er geen enkele
 * toestand — kop, regels, initialisatievlag, opslagvlag — kan overleven. De
 * id gaat als PROP naar binnen: de werkbank leest hem niet zelf nog eens uit
 * de route, zodat key en identiteit per constructie dezelfde waarde zijn en
 * niet uit elkaar kunnen lopen.
 *
 * Remounten alleen is geen afdoende bescherming — `handleSave` heeft daarom
 * óók een eigen identiteitscontrole. Zie daar.
 */
export default function PurchaseInvoiceWorkspaceRoute() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  return <PurchaseInvoiceWorkspace key={invoiceId ?? "geen-factuur"} invoiceId={invoiceId} />;
}

export function PurchaseInvoiceWorkspace({ invoiceId }: { invoiceId: string | undefined }) {
  const navigate = useNavigate();
  const { toast } = useToast();
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

  const saveInvoiceWithLines = useSavePurchaseInvoiceWithLines();

  const client = useMemo(
    () => clients?.find((c) => c.id === invoice?.client_id) ?? null,
    [clients, invoice?.client_id],
  );
  const isBtwVrijgesteld = !!client?.btw_vrijgesteld;

  const [header, setHeader] = useState<HeaderForm>(() => emptyHeader(invoice ?? null));
  const [lines, setLines] = useState<LineRow[]>([]);
  /**
   * VOOR WELKE factuur de kop en regels hieronder zijn ingevuld — geen kale
   * boolean. Een boolean kan alleen zeggen "er is ooit geïnitialiseerd" en
   * blijft `true` wanneer de route naar een andere factuur wijst; dan toont de
   * viewer factuur N+1 terwijl het formulier nog N bevat. Met de id erbij is
   * de vraag beantwoordbaar: hoort deze state bij DEZE factuur?
   */
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const initialized = !!invoiceId && initializedFor === invoiceId;
  const [saving, setSaving] = useState(false);
  const { data: posting } = usePurchaseInvoicePosting(invoiceId);
  const postInvoice = usePostPurchaseInvoice();

  // Deterministic initialization once invoice + lines are loaded, gebonden aan
  // de factuur-id: wisselt die, dan wordt er opnieuw geïnitialiseerd uit de
  // gegevens van díe factuur voordat er iets te bewerken of op te slaan valt.
  useEffect(() => {
    if (initializedFor === invoiceId) return;
    if (invoiceLoading || linesLoading) return;
    if (!invoice) return;
    // De query kan nog het antwoord van de vórige factuur vasthouden; dan is
    // dit niet de data waarop we mogen initialiseren.
    if (invoice.id !== invoiceId) return;

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

    let nextLines: LineRow[];
    if (storedLines && storedLines.length > 0) {
      nextLines = storedLines.map((l) => {
        const ledger = ledgers?.find((g) => g.id === l.grootboekrekening_id);
        return {
          omschrijving: l.omschrijving,
          amount_input: formatAmountInput(l.amount_excl),
          btw_percentage: l.btw_percentage != null ? String(l.btw_percentage) : "0",
          grootboekrekening_id: l.grootboekrekening_id,
          grootboek_label: ledger ? `${ledger.nummer} - ${ledger.omschrijving}` : "",
        };
      });
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
        nextLines = [{
          omschrijving: invoice.supplier || "Factuurregel",
          amount_input: formatAmountInput(prefill.amount_excl),
          btw_percentage: String(prefill.btw_percentage),
          grootboekrekening_id: invoice.ledger_account_id ?? null,
          grootboek_label: ledger ? `${ledger.nummer} - ${ledger.omschrijving}` : (invoice.ledger_account_text ?? ""),
        }];
      } else {
        nextLines = [];
      }
    }

    // Header normalisation: when the manually-entered header is incomplete
    // (btw missing, incl null or equal to excl) but the lines carry VAT,
    // derive header totals from the lines so there is no artificial gap.
    if (!isBtwVrijgesteld && nextLines.length > 0) {
      const parsed = nextLines
        .filter((l) => !isBlankLine({
          omschrijving: l.omschrijving,
          amount_input: l.amount_input,
          grootboekrekening_id: l.grootboekrekening_id,
        }))
        .map((l) => ({
          omschrijving: l.omschrijving,
          amount_excl: parseAmountInput(l.amount_input) ?? 0,
          btw_percentage: parseAmountInput(l.btw_percentage) ?? 0,
        }));
      const lineTotalsInit = computeLineTotals(parsed);
      const derived = deriveHeaderFromLines(
        {
          amount_excl: parseAmountInput(nextHeader.amount_excl),
          btw_amount: parseAmountInput(nextHeader.btw_amount),
          amount_incl: parseAmountInput(nextHeader.amount_incl),
        },
        lineTotalsInit,
      );
      if (derived.btw_amount != null) {
        nextHeader.amount_excl = formatAmountInput(derived.amount_excl);
        nextHeader.btw_amount = formatAmountInput(derived.btw_amount);
        nextHeader.amount_incl = formatAmountInput(derived.amount_incl);
      }
    }

    setHeader(nextHeader);
    setLines(nextLines);
    setInitializedFor(invoiceId ?? null);
  }, [invoice, storedLines, ledgers, invoiceLoading, linesLoading, initializedFor, invoiceId, isBtwVrijgesteld]);

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
  // Regels met inhoud maar zonder grootboekrekening. Opslaan mag nog — de
  // rekening opzoeken kost tijd — maar goedkeuren niet: de boekingsfunctie
  // weigert elke regel zonder rekening, dus een goedgekeurde factuur zou nooit
  // geboekt kunnen worden.
  const linesZonderRekening = useMemo(
    () => countLinesMissingLedgerAccount(lines.map((l) => ({
      omschrijving: l.omschrijving,
      amount_input: l.amount_input,
      grootboekrekening_id: l.grootboekrekening_id,
    }))),
    [lines],
  );
  const linesMatch = diffs.allOk;
  const headerComplete =
    !!header.client_id &&
    !!header.supplier.trim() &&
    !!header.invoice_number.trim() &&
    !!header.invoice_date &&
    headerTotals.amount_incl != null;

  // Een geboekte factuur is brongegeven geworden: de database weigert elke
  // boekhoudkundige wijziging, dus de UI biedt die ook niet meer aan. De
  // databasegrendel is leidend; dit voorkomt alleen een onvermijdelijke fout.
  const isPosted = !!posting;
  const canSave = initialized && !hasPartialLine && !saving && !isPosted;
  const canApprove =
    canSave && headerComplete && linesMatch && meaningfulLines.length > 0 && linesZonderRekening === 0;

  // De database boekt alleen een gecontroleerde factuur; de knop volgt die regel
  // zodat een nog te controleren factuur geen onvermijdelijke foutmelding geeft.
  const isPostableStatus = ["gecontroleerd", "betaald", "geexporteerd"].includes(header.status);

  /**
   * Boekbaarheid, met exact dezelfde beoordeling als de historische
   * grootboekvulling — `evaluatePurchaseInvoice()` volgt één-op-één de guards
   * van `post_purchase_invoice()`. Geen tweede regelset, geen eigen aannames.
   *
   * Bewust op de OPGESLAGEN factuur en de OPGESLAGEN regels: de writer leest de
   * database, dus dit is de enige toestand waarover een voorspelling iets waard
   * is. Onopgeslagen wijzigingen in het formulier tellen hier dus niet mee — de
   * kop van het paneel zegt dat er ook bij. De correctheid van wat er NU in het
   * formulier staat wordt bewaakt door `approveBlockers` hierboven.
   */
  const postingReadiness = useMemo(() => {
    if (!invoice || !client) return undefined;
    return evaluatePurchaseInvoice({
      invoice: {
        id: invoice.id,
        client_id: invoice.client_id,
        status: invoice.status,
        invoice_date: invoice.invoice_date,
        invoice_number: invoice.invoice_number,
        supplier: invoice.supplier,
        amount_excl: invoice.amount_excl,
        amount_incl: invoice.amount_incl,
        btw_amount: invoice.btw_amount,
      },
      config: {
        id: client.id,
        afgesloten_boekjaar: client.afgesloten_boekjaar ?? null,
        crediteuren_rekening_id: client.crediteuren_rekening_id ?? null,
        debiteuren_rekening_id: client.debiteuren_rekening_id ?? null,
        btw_te_vorderen_rekening_id: client.btw_te_vorderen_rekening_id ?? null,
        btw_te_betalen_rekening_id: client.btw_te_betalen_rekening_id ?? null,
      },
      lines: aggregateInvoiceLines(storedLines ?? []),
      postingGroupId: posting?.posting_group_id ?? null,
    });
  }, [invoice, client, storedLines, posting]);

  const readinessBlocked = !!postingReadiness && postingReadiness.state === "geblokkeerd";

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

  // "Waarom kan ik niet goedkeuren?" — read-only explanation derived ONLY from
  // the existing gate booleans above. It never changes canApprove itself.
  const approveBlockers = useMemo(() => {
    const reasons: string[] = [];
    if (!initialized || canApprove) return reasons;
    if (saving) reasons.push("Er wordt nog opgeslagen.");
    if (hasPartialLine) reasons.push("Een boekingsregel is niet compleet.");
    if (!headerComplete) reasons.push("De factuurgegevens zijn nog niet compleet.");
    if (meaningfulLines.length === 0) reasons.push("Er is nog geen boekingsregel.");
    else if (!linesMatch) reasons.push("De boekingsregels sluiten niet aan op de factuur.");
    if (linesZonderRekening > 0) reasons.push("Kies een grootboekrekening voor elke boekingsregel.");
    return reasons;
  }, [
    initialized, canApprove, saving, hasPartialLine, headerComplete,
    meaningfulLines.length, linesMatch, linesZonderRekening,
  ]);

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

  const buildHeaderUpdates = (approve = false): PurchaseInvoiceHeaderSaveInput => ({
    client_id: header.client_id || invoice?.client_id || undefined,
    leverancier_id: header.leverancier_id || null,
    supplier: header.supplier.trim(),
    invoice_number: header.invoice_number.trim() || null,
    invoice_date: header.invoice_date || null,
    amount_excl: parseAmountInput(header.amount_excl),
    btw_amount: parseAmountInput(header.btw_amount),
    amount_incl: parseAmountInput(header.amount_incl),
    btw_percentage: parseAmountInput(header.btw_percentage),
    // NOTE: ledger_account_id is intentionally NOT persisted here.
    // purchase_invoices.ledger_account_id has a FK to public.ledger_accounts,
    // but the workspace "Standaard grootboek" combobox picks IDs from
    // public.grootboekrekeningen. Writing that ID would trigger a FK error.
    // The per-line ledger is stored on purchase_invoice_lines.grootboekrekening_id.
    ledger_account_text: header.ledger_label || null,
    notes: header.notes.trim() || null,
    ...(approve ? { status: "gecontroleerd" } : {}),
  });

  const handleSave = async (approve = false) => {
    if (!invoiceId || !invoice) return;
    // Fail-closed identiteitscontrole. De remount hoort dit al onmogelijk te
    // maken, maar opslaan is het punt waarop een vergissing onherstelbaar
    // wordt: `save_purchase_invoice_with_lines` VERVANGT de regels van de
    // factuur waarnaar `invoiceId` wijst. Zou de kop- en regelstate ooit bij
    // een andere factuur horen, dan zouden de gegevens van factuur N stil over
    // factuur N+1 heen worden geschreven. Dus liever weigeren dan gokken.
    if (invoice.id !== invoiceId || initializedFor !== invoiceId) {
      toast({
        title: "Opslaan geweigerd",
        description:
          "De geopende factuur is gewisseld terwijl dit scherm nog de vorige factuur toonde. " +
          "Er is niets opgeslagen; open de factuur opnieuw.",
        variant: "destructive",
      });
      return;
    }
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
      await saveInvoiceWithLines.mutateAsync({
        invoiceId,
        headerUpdates: buildHeaderUpdates(approve),
        lines: buildLinesPayload(),
      });
      toast({ title: approve ? "Factuur goedgekeurd" : "Factuur opgeslagen" });
      if (approve && hasNext) goNext();
    } catch (e: any) {
      const raw = String(e?.message ?? "");
      toast({
        title: "Opslaan mislukt",
        description: "Opslaan mislukt. De bestaande factuur en boekingsregels zijn niet gewijzigd." + (raw ? ` (${raw})` : ""),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!invoiceId) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">Geen factuur geselecteerd.</p>
        <Button variant="outline" onClick={() => navigate("/facturen")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Terug naar inkoopoverzicht
        </Button>
      </div>
    );
  }
  // Render-flow order matters here:
  //  1. query still loading            → loading skeleton
  //  2. query done, no record          → not found (the init effect never runs
  //                                      for a missing invoice, so `initialized`
  //                                      stays false and must NOT gate this)
  //  3. record present, not initialised → loading skeleton. `initialized` geldt
  //     alleen voor DEZE factuur-id, dus zolang de kop en regels nog van een
  //     andere factuur zouden zijn, verschijnt hier het skelet en geen enkel
  //     bewerkbaar veld.
  const loadingState = (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Laden…</span>
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="ml-auto h-8 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
        <Skeleton className="h-[420px] w-full" />
      </div>
    </div>
  );

  if (invoiceLoading) {
    return loadingState;
  }
  if (!invoice) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <p className="font-medium">Factuur niet gevonden.</p>
          <p className="text-sm text-muted-foreground">
            De inkoopfactuur bestaat niet meer of hoort niet bij deze administratie.
          </p>
          <Button variant="outline" onClick={() => navigate("/facturen")}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Terug naar inkoopoverzicht
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!initialized) {
    return loadingState;
  }

  const amountInputClass = "h-9 text-right font-mono tabular-nums";

  return (
    <div className="space-y-4">
      <PurchaseInvoiceWorkspaceHeader
        supplier={header.supplier}
        invoiceNumber={header.invoice_number}
        invoiceDate={header.invoice_date}
        status={header.status}
        isBtwVrijgesteld={isBtwVrijgesteld}
        clientName={client?.name ?? null}
        totalIncl={headerTotals.amount_incl}
        hasPrev={hasPrev}
        hasNext={hasNext}
        currentIndex={currentIdx}
        totalCount={sortedInvoices.length}
        onBack={() => navigate("/facturen")}
        onPrev={goPrev}
        onNext={goNext}
      />

      <div
        data-testid="workspace-grid"
        className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]"
      >
        {/* Left column: processing */}
        <div className="min-w-0 space-y-4">
          {/* Factuurgegevens */}
          <Card>
            <CardContent className="space-y-5 pt-5">
              <h2 className="text-sm font-semibold">Factuurgegevens</h2>

              <FieldGroup title="Identificatie">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <Label>Administratie</Label>
                    <Select value={header.client_id} onValueChange={(v) => patchHeader({ client_id: v })}>
                      <SelectTrigger className="h-9" aria-label="Administratie">
                        <SelectValue placeholder="Selecteer klant" />
                      </SelectTrigger>
                      <SelectContent>
                        {(clients ?? []).map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="min-w-0">
                    <Label>Leverancier</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        value={header.leverancier_id || "__none__"}
                        onValueChange={(v) => {
                          if (v === "__none__") return patchHeader({ leverancier_id: "" });
                          const lev = leveranciers?.find((l) => l.id === v);
                          patchHeader({ leverancier_id: v, supplier: lev?.naam ?? header.supplier });
                        }}
                      >
                        <SelectTrigger className="h-9" aria-label="Bestaande leverancier">
                          <SelectValue placeholder="Bestaande leverancier" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— vrije invoer —</SelectItem>
                          {(leveranciers ?? []).map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.naam}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-9"
                        value={header.supplier}
                        onChange={(e) => patchHeader({ supplier: e.target.value })}
                        placeholder="Leverancier"
                        aria-label="Leveranciersnaam"
                      />
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                      {header.leverancier_id ? (
                        <>
                          <Link2 className="h-3 w-3" /> Gekoppeld aan bestaande leverancier
                        </>
                      ) : (
                        <>
                          <PenLine className="h-3 w-3" /> Vrije invoer — niet gekoppeld aan een leverancier
                        </>
                      )}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <Label>Factuurnummer</Label>
                    <Input
                      className="h-9 font-mono"
                      value={header.invoice_number}
                      onChange={(e) => patchHeader({ invoice_number: e.target.value })}
                      aria-label="Factuurnummer"
                    />
                  </div>
                  <div className="min-w-0">
                    <Label>Factuurdatum</Label>
                    <Input
                      className="h-9"
                      type="date"
                      value={header.invoice_date}
                      onChange={(e) => patchHeader({ invoice_date: e.target.value })}
                      aria-label="Factuurdatum"
                    />
                  </div>
                </div>
              </FieldGroup>

              <FieldGroup title="Bedragen">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="min-w-0">
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
                      aria-label="Bedrag excl."
                      className={amountInputClass}
                    />
                  </div>
                  <div className="min-w-0">
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
                      aria-label="BTW-bedrag"
                      className={amountInputClass}
                    />
                  </div>
                  <div className="min-w-0">
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
                      aria-label="Bedrag incl."
                      className={amountInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label>BTW %</Label>
                    <Select
                      value={header.btw_percentage}
                      onValueChange={(v) => patchHeader({ btw_percentage: v })}
                      disabled={isBtwVrijgesteld}
                    >
                      <SelectTrigger className="h-9" aria-label="BTW-percentage"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">0%</SelectItem>
                        <SelectItem value="9">9%</SelectItem>
                        <SelectItem value="21">21%</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {isBtwVrijgesteld && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Deze administratie is BTW-vrijgesteld: BTW staat vast op 0% en het bedrag incl. is gelijk aan excl.
                  </p>
                )}
              </FieldGroup>

              <FieldGroup title="Boekingscontext">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <Label>Standaard grootboek</Label>
                    <GrootboekCombobox
                      value={header.ledger_label}
                      onValueChange={(v) => patchHeader({ ledger_label: v })}
                      onIdChange={(id) => patchHeader({ ledger_id: id })}
                      noneOption
                      className="h-9"
                    />
                  </div>
                  <div className="min-w-0">
                    <Label>Notities</Label>
                    <Textarea
                      rows={2}
                      className="min-h-9"
                      value={header.notes}
                      onChange={(e) => patchHeader({ notes: e.target.value })}
                      aria-label="Notities"
                    />
                  </div>
                </div>
              </FieldGroup>
            </CardContent>
          </Card>

          {/* Boekingsregels + totalencontrole together, so the reason approve is
              blocked is visible right where the lines are edited. */}
          <Card>
            <CardContent className="space-y-4 pt-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">Boekingsregels</h2>
                <PurchaseInvoiceTotalsStatusPill state={totalsState} />
                {lines.length > 0 && (
                  <Button variant="outline" size="sm" className="ml-auto" onClick={addLine}>
                    <Plus className="mr-1 h-4 w-4" /> Regel toevoegen
                  </Button>
                )}
              </div>

              <PurchaseInvoiceLinesTable
                lines={lines}
                isBtwVrijgesteld={isBtwVrijgesteld}
                onPatchLine={patchLine}
                onRemoveLine={removeLine}
                onAddLine={addLine}
              />

              {hasPartialLine && (
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  role="alert"
                  data-testid="partial-line-warning"
                >
                  Één of meer regels zijn niet compleet. Vul bedrag en omschrijving in of verwijder de regel.
                </p>
              )}

              <PurchaseInvoiceTotalsSummary
                header={headerTotals}
                lineTotals={lineTotals}
                diffs={diffs}
                state={totalsState}
                message={totalsMessage}
              />
            </CardContent>
          </Card>
        </div>

        {/* Right column: original document */}
        <div className="min-w-0">
          <div
            data-testid="document-panel"
            className="h-[70vh] min-h-[420px] lg:sticky lg:top-[4.5rem] lg:h-[calc(100dvh-6.5rem)]"
          >
            <Card className="flex h-full flex-col overflow-hidden">
              <PurchaseInvoiceDocumentPreview filePath={invoice.file_path} />
            </Card>
          </div>
        </div>
      </div>

      <div className="mt-4" data-testid="purchase-posting-section">
        {posting ? (
          <p className="text-xs text-muted-foreground" data-testid="purchase-posting-done">
            Deze factuur is geboekt in het grootboek. Boekhoudkundige gegevens en
            boekingsregels liggen daarmee vast; een correctie vereist een tegenboeking.
          </p>
        ) : (
          <div className="space-y-3">
          {/* Eerst het oordeel, dan pas de knop: de gebruiker hoort te weten
              waaróm er niet geboekt kan worden vóór hij het probeert. */}
          <PurchaseInvoicePostingReadiness
            record={postingReadiness}
            onOpenSettings={() => navigate("/klanten")}
          />
          <div className="flex flex-wrap items-center gap-2">
          {!isPostableStatus && (
            <p className="text-xs text-muted-foreground" data-testid="purchase-posting-blocker">
              Keur de factuur eerst goed; daarna kan deze in het grootboek worden geboekt.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            data-testid="purchase-posting-button"
            disabled={!canApprove || !isPostableStatus || readinessBlocked || postInvoice.isPending || !invoiceId}
            onClick={async () => {
              if (!invoiceId) return;
              try {
                await postInvoice.mutateAsync(invoiceId);
                toast({ title: "Factuur geboekt" });
              } catch (e) {
                toast({
                  title: "Boeken niet gelukt",
                  description: e instanceof Error ? e.message : undefined,
                  variant: "destructive",
                });
              }
            }}
          >
            {postInvoice.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
          </Button>
          </div>
          </div>
        )}
      </div>

      <PurchaseInvoiceActionBar
        canSave={canSave}
        canApprove={canApprove}
        saving={saving}
        hasNext={hasNext}
        approveBlockers={approveBlockers}
        onCancel={() => navigate("/facturen")}
        onSave={() => handleSave(false)}
        onApprove={() => handleSave(true)}
        onNext={goNext}
      />
    </div>
  );
}
