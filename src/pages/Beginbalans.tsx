import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ArrowUpRight, Info, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { OpeningBalanceTable } from "@/components/grootboek/OpeningBalanceTable";
import { OpeningBalanceSummary } from "@/components/grootboek/OpeningBalanceSummary";
import { OpeningBalancePostingAction } from "@/components/grootboek/OpeningBalancePostingAction";
import { OpeningBalanceNilAction } from "@/components/grootboek/OpeningBalanceNilAction";
import { useToast } from "@/hooks/use-toast";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClients } from "@/hooks/useClients";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import {
  useCreateOpeningBalance,
  useDeleteOpeningBalance,
  useOpeningBalance,
  useOpeningBalanceLines,
  useOpeningBalanceOverview,
  useSaveOpeningBalanceLines,
  useUpdateOpeningBalance,
} from "@/hooks/useOpeningBalances";
import { useCanAssertOpeningBalance, useOpeningBalanceMarker } from "@/hooks/useOpeningBalancePosting";
import {
  applyBoekjaarChange,
  areLinesDirty,
  buildSaveLinesPayload,
  classifyOpeningBalanceError,
  createEmptyLineRows,
  createHeaderForm,
  dbAmountToCents,
  defaultDescription,
  deriveOpeningBalanceState,
  DOUBLE_COUNT_WARNING,
  formatCentsEuro,
  formatDatumNL,
  formatTijdstipNL,
  headerIssues,
  isBlankLine,
  isCompetingStateError,
  isHeaderDirty,
  isNilHeader,
  lineBlocksSave,
  linesSnapshot,
  lineTotals,
  NIL_FINAL_NOTICE,
  NIL_NOTICE,
  parseBoekjaar,
  POSTED_FINAL_NOTICE,
  toHeaderForm,
  toLineRows,
  type OpeningBalanceAccountRef,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";
import { isUuid, OPENING_BALANCE_TARGET_PARAM } from "@/lib/ledger-reporting";

/**
 * Fase 6C-b8 (PR 2) — beginbalans (/grootboek/beginbalans).
 *
 * Vier toestanden, nooit samengevoegd: geen beginbalans → concept → geboekt
 * (claimrij) of bewust nihil (nil_declaration + nil_declared_at). Geboekt en
 * nihil zijn beide definitief en maken de pagina alleen-lezen.
 *
 * Kop via gewone PostgREST-rijen onder RLS; regels uitsluitend via
 * save_opening_balance_lines(); boeken via post_opening_balance(); nihil via
 * declare_opening_balance_nil(). De pagina implementeert de boekhoudregels
 * niet opnieuw: de knoppen gaan uit bij duidelijk kansloze invoer, de database
 * beslist. Bij meer dan één concept voor het gekozen jaar wordt er nooit
 * stilzwijgend gekozen. Na elke mutatie wordt de waarheid opnieuw opgehaald,
 * en het formulier volgt de database pas wanneer die aantoonbaar vers is.
 */

const CLIENT_BANNER = "Kies eerst een specifieke administratie om de beginbalans te bekijken.";

/** Expliciete keuze van dit tabblad, gebonden aan de administratie waarvoor hij gold. */
type Chosen = { clientId: string; id: string } | null;

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-sm tabular-nums" : "text-sm"}>{value || "—"}</dd>
    </div>
  );
}

function ReportLinks() {
  return (
    <div className="flex flex-wrap gap-2" data-testid="beginbalans-report-links">
      <Button variant="outline" asChild className="h-11 sm:h-9">
        <Link to="/overzichten/proef-saldibalans">
          <ArrowUpRight className="mr-2 h-4 w-4" />Proef- en saldibalans
        </Link>
      </Button>
      <Button variant="outline" asChild className="h-11 sm:h-9">
        <Link to="/grootboek/saldi">
          <ArrowUpRight className="mr-2 h-4 w-4" />Grootboeksaldi
        </Link>
      </Button>
    </div>
  );
}

function draftLabel(draft: OpeningBalanceRow): string {
  return `${formatDatumNL(draft.opening_date)} — ${draft.description || "zonder omschrijving"}`;
}

export default function Beginbalans() {
  const { toast } = useToast();
  const { selectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  // De volledige lijst (ook inactief): een later gedeactiveerde rekening op een
  // bestaande regel moet herkenbaar blijven en als fout worden gemeld.
  const { data: allAccounts } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const accountsById = useMemo(() => {
    const map = new Map<string, OpeningBalanceAccountRef>();
    for (const a of allAccounts ?? []) map.set(a.id, a);
    return map;
  }, [allAccounts]);

  const [selectedYear, setSelectedYear] = useState<number>(() => new Date().getFullYear());
  const [chosen, setChosen] = useState<Chosen>(null);
  // Alleen een keuze voor déze administratie telt; van een vorige administratie
  // mag geen kop of regel ook maar één render lang in beeld komen.
  const chosenId = chosen && chosen.clientId === clientId ? chosen.id : null;

  const overview = useOpeningBalanceOverview(clientId);

  // 6C-b8 PR 3 — direct doel vanuit een grootboekregel (?openingBalanceId=).
  // Alleen een goedgevormde uuid telt; het doel wordt uitsluitend gezocht in
  // de koppen van de GEKOZEN administratie (onder RLS opgehaald). Een id van
  // een andere administratie of organisatie, of een onbekende id, wordt
  // geweigerd en verandert niets aan de getoonde toestand.
  const [searchParams] = useSearchParams();
  const rawTarget = searchParams.get(OPENING_BALANCE_TARGET_PARAM);
  const targetId = isUuid(rawTarget) ? rawTarget.toLowerCase() : null;
  const targetMalformed = rawTarget !== null && targetId === null;
  const targetHeader = targetId && overview.data ? overview.data.headers.find((h) => h.id.toLowerCase() === targetId) ?? null : null;
  // De afwijzing wordt één keer vastgesteld, bij de eerste lezing van het
  // overzicht voor deze administratie + dit doel. Anders zou het verwijderen
  // van het (terecht geopende) doelconcept de melding "niet gevonden" oproepen.
  const [targetRejected, setTargetRejected] = useState(false);
  const resolvedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!clientId || !targetId || !overview.data) return;
    const key = `${clientId}:${targetId}`;
    if (resolvedTarget.current === key) return;
    resolvedTarget.current = key;
    setTargetRejected(!targetHeader);
  }, [clientId, targetId, overview.data, targetHeader]);
  const state = useMemo(
    () =>
      overview.data
        ? deriveOpeningBalanceState({
            headers: overview.data.headers,
            marker: overview.data.marker,
            boekjaar: selectedYear,
          })
        : null,
    [overview.data, selectedYear],
  );

  const editorId = useMemo(() => {
    if (!state) return null;
    switch (state.kind) {
      case "posted":
        return state.marker.opening_balance_id;
      case "nil":
        return state.header.id;
      case "draft":
        return chosenId && chosenId !== state.header.id ? chosenId : state.header.id;
      case "multiple-drafts":
        return chosenId && state.drafts.some((d) => d.id === chosenId) ? chosenId : null;
      case "none":
        return chosenId;
      default:
        return null;
    }
  }, [state, chosenId]);

  const headerQuery = useOpeningBalance(editorId ?? undefined);
  const linesQuery = useOpeningBalanceLines(editorId ?? undefined);
  const markerQuery = useOpeningBalanceMarker(editorId ?? undefined);
  const { data: canAssert } = useCanAssertOpeningBalance();

  const createHeader = useCreateOpeningBalance();
  const updateHeader = useUpdateOpeningBalance();
  const saveLines = useSaveOpeningBalanceLines();
  const deleteDraft = useDeleteOpeningBalance();
  const isSaving = createHeader.isPending || updateHeader.isPending || saveLines.isPending;

  const [form, setForm] = useState<OpeningBalanceHeaderForm>(() => createHeaderForm(selectedYear));
  const [lines, setLines] = useState<OpeningBalanceLineRow[]>(() => createEmptyLineRows());
  const [persistedForm, setPersistedForm] = useState<OpeningBalanceHeaderForm | null>(null);
  const [persistedLines, setPersistedLines] = useState<OpeningBalanceLineRow[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OpeningBalanceRow | null>(null);
  const [discardTarget, setDiscardTarget] = useState<OpeningBalanceRow | null>(null);
  const syncedKey = useRef<string | null>(null);
  // Na een opslag waarvan het opnieuw laden mislukte: pas synchroniseren zodra
  // de database precies de rijen teruggeeft die we opsloegen.
  const holdUntil = useRef<string | null>(null);

  const dbHeader = headerQuery.data ?? null;
  const dbLines = linesQuery.data;
  const marker = markerQuery.data ?? null;
  // Geboekt = claimrij (per id óf per administratie); nihil = kop. Nooit een
  // lokale status.
  const posted = !!marker || state?.kind === "posted";
  const nil = (dbHeader ? isNilHeader(dbHeader) : false) || state?.kind === "nil";
  const conflict = state?.kind === "conflict";
  const readOnly = posted || nil || conflict;

  const headerDirty = !!editorId && isHeaderDirty(form, persistedForm);
  const linesDirty = !!editorId && areLinesDirty(lines, persistedLines);
  const isDirty = headerDirty || linesDirty;
  const typedYear = parseBoekjaar(form.boekjaar);
  // Een nieuw, nog niet opgeslagen formulier met inhoud mag nooit stilzwijgend
  // worden vervangen.
  const formHasContent =
    lines.some((l) => !isBlankLine(l)) ||
    form.reference.trim() !== "" ||
    form.description.trim() !== (typedYear !== null ? defaultDescription(typedYear) : "");
  const hasUnsavedWork = editorId ? isDirty && !readOnly : formHasContent;

  // Andere administratie: alles terug naar het begin.
  useEffect(() => {
    setChosen(null);
    syncedKey.current = null;
    holdUntil.current = null;
    setForm(createHeaderForm(selectedYear));
    setLines(createEmptyLineRows());
    setPersistedForm(null);
    setPersistedLines(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Geen editor meer (concept verwijderd, keuze losgelaten): schoon formulier
  // voor het gekozen jaar. Typen in het nieuwe formulier verandert editorId
  // niet, dus dat wordt hier nooit overschreven.
  useEffect(() => {
    if (editorId) return;
    syncedKey.current = null;
    holdUntil.current = null;
    setForm(createHeaderForm(selectedYear));
    setLines(createEmptyLineRows());
    setPersistedForm(null);
    setPersistedLines(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorId]);

  // Het doel wordt NA de reset-effecten toegepast: op de eerste render zou de
  // administratie-reset een zojuist toegepast doel anders meteen weer wissen.
  const appliedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!clientId || !targetHeader) return;
    const key = `${clientId}:${targetHeader.id}`;
    if (appliedTarget.current === key) return;
    appliedTarget.current = key;
    // Een expliciet, geverifieerd doel: dezelfde keuze als "Openen" in de
    // conceptenlijst. Geboekt of nihil blijft alleen-lezen; bij meerdere
    // concepten blijft de lijst zichtbaar.
    syncedKey.current = null;
    holdUntil.current = null;
    setChosen({ clientId, id: targetHeader.id });
    setSelectedYear(targetHeader.boekjaar);
  }, [clientId, targetHeader]);

  // Formulier synchroniseren met de database. De sleutel bevat de inhoud, dus
  // een achtergrondrefetch met identieke data overschrijft niets waar je in
  // typt. Is de beginbalans inmiddels geboekt of nihil, dan wint de database
  // altijd: er blijft nooit een bewerkbaar formulier over een vastgelegde rij staan.
  useEffect(() => {
    if (!editorId || !dbHeader || !dbLines) return;
    if (!readOnly && persistedForm && persistedLines && isDirty) return;
    if (!readOnly && holdUntil.current !== null) {
      if (linesSnapshot(toLineRows(dbLines, accountsById)) !== holdUntil.current) return;
      holdUntil.current = null;
      syncedKey.current = null;
    }
    const key = [
      dbHeader.id,
      dbHeader.updated_at,
      dbHeader.nil_declared_at ?? "",
      marker?.posting_group_id ?? "",
      dbLines
        .map((l) => `${l.id}:${l.sort_order}:${l.debit_amount}:${l.credit_amount}:${l.grootboekrekening_id ?? ""}:${l.description ?? ""}`)
        .join("|"),
      accountsById.size,
    ].join("#");
    if (syncedKey.current === key) return;
    syncedKey.current = key;
    const nextForm = toHeaderForm(dbHeader);
    const nextLines = toLineRows(dbLines, accountsById);
    setForm(nextForm);
    setLines(nextLines);
    setPersistedForm(nextForm);
    setPersistedLines(nextLines);
  }, [editorId, dbHeader, dbLines, marker, accountsById, readOnly, persistedForm, persistedLines, isDirty]);

  // Niet-opgeslagen wijzigingen mogen niet ongemerkt verdwijnen.
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedWork]);

  const refetchTruth = () => {
    syncedKey.current = null;
    holdUntil.current = null;
    void overview.refetch();
    if (editorId) {
      void headerQuery.refetch();
      void linesQuery.refetch();
      void markerQuery.refetch();
    }
  };

  const openDraft = (draft: OpeningBalanceRow) => {
    if (!clientId) return;
    syncedKey.current = null;
    holdUntil.current = null;
    setPersistedForm(null);
    setPersistedLines(null);
    setChosen({ clientId, id: draft.id });
    setSelectedYear(draft.boekjaar);
  };

  /** Een ander concept openen is een expliciete keuze; werk weggooien ook. */
  const requestOpen = (draft: OpeningBalanceRow) => {
    if (hasUnsavedWork) {
      setDiscardTarget(draft);
      return;
    }
    openDraft(draft);
  };

  const handleBoekjaarChange = (raw: string) => {
    setForm((prev) => applyBoekjaarChange(prev, raw));
    // In het nieuwe formulier stuurt het boekjaar ook de zoektocht naar een
    // bestaand concept — maar nooit zolang er al iets getypt is: dan zou een
    // gevonden concept de invoer stilzwijgend vervangen. Bij een bestaand
    // concept volgt het jaar pas na opslaan.
    if (!editorId && !formHasContent) {
      const year = parseBoekjaar(raw);
      if (year !== null) setSelectedYear(year);
    }
  };

  const handleSave = async () => {
    if (!clientId || readOnly) return;
    const issues = headerIssues(form);
    if (issues.length > 0) {
      toast({ title: "Opslaan niet mogelijk", description: issues[0], variant: "destructive" });
      return;
    }
    const unreadable = lines.findIndex(lineBlocksSave);
    if (unreadable >= 0) {
      toast({
        title: "Opslaan niet mogelijk",
        description: `Regel ${unreadable + 1} bevat een onleesbaar bedrag.`,
        variant: "destructive",
      });
      return;
    }
    const wasNew = !editorId;
    if (wasNew) {
      // Basislijn vóór het aanmaken: de kop wordt zo meteen de waarheid en de
      // regels nog niet. Zolang die niet zijn opgeslagen telt het formulier
      // als gewijzigd, zodat een vroege refetch (het overzicht vindt de nieuwe
      // kop al) de getypte regels niet met lege databaserijen kan overschrijven.
      setPersistedForm(form);
      setPersistedLines([]);
    }
    let createdId: string | null = null;
    try {
      let id = editorId;
      if (id) {
        // De kop blijft de gekozen kop, ook als het boekjaar verandert: het
        // overzicht vindt hem dan niet meer onder het gekozen jaar, en zonder
        // expliciete keuze zou de editor midden in de opslag verdwijnen.
        setChosen({ clientId, id });
        await updateHeader.mutateAsync({ id, form });
        setPersistedForm(form);
      } else {
        id = (await createHeader.mutateAsync({ form, clientId })).id;
        createdId = id;
        // Meteen vastleggen: als het opslaan van de regels hierna faalt, werkt
        // een volgende poging deze kop bij in plaats van een tweede kop aan te
        // maken (anders blijft er per mislukte poging een leeg concept achter).
        setChosen({ clientId, id });
      }

      // Precies één aanroep; de database vervangt de hele regelset atomair.
      // De belofte lost pas op nadat kop en regels opnieuw zijn opgehaald.
      const result = await saveLines.mutateAsync({ openingBalanceId: id, lines: buildSaveLinesPayload(lines) });

      // De bewerkte kop blijft de gekozen kop, ook wanneer het boekjaar
      // veranderde en het overzicht voor dat jaar nog niet is bijgewerkt.
      setChosen({ clientId, id });
      const savedYear = parseBoekjaar(form.boekjaar);
      if (savedYear !== null) setSelectedYear(savedYear);
      setPersistedLines(lines);
      if (result.refreshed) {
        // De cache is vers: het effect neemt de databaseweergave over (zelfde
        // inhoud, genormaliseerd).
        holdUntil.current = null;
        syncedKey.current = null;
        toast({ title: "Beginbalans opgeslagen" });
      } else {
        // Opgeslagen, maar opnieuw laden mislukte. Niet op een mogelijk oude
        // cache synchroniseren: wachten tot de opgeslagen rijen terugkomen.
        holdUntil.current = linesSnapshot(lines);
        toast({
          title: "Beginbalans opgeslagen",
          description: "Het opnieuw laden is mislukt; ververs de pagina om de opgeslagen toestand te controleren.",
        });
      }
    } catch (e) {
      if (wasNew && !createdId) {
        // Er is niets aangemaakt: het formulier is weer gewoon "nieuw".
        setPersistedForm(null);
        setPersistedLines(null);
      }
      const classified = classifyOpeningBalanceError(e);
      toast({ title: "Opslaan niet gelukt", description: classified.message, variant: "destructive" });
      // Al geboekt, nihil of tussentijds gewijzigd: de waarheid opnieuw laden
      // en het formulier daaraan onderwerpen.
      if (isCompetingStateError(classified.kind)) refetchTruth();
    }
  };

  const handleDeleteConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!deleteTarget) return;
    try {
      await deleteDraft.mutateAsync(deleteTarget.id);
      if (chosenId === deleteTarget.id) setChosen(null);
      syncedKey.current = null;
      holdUntil.current = null;
      setDeleteTarget(null);
      toast({ title: "Concept verwijderd" });
    } catch (e) {
      setDeleteTarget(null);
      toast({
        title: "Verwijderen niet gelukt",
        description: classifyOpeningBalanceError(e).message,
        variant: "destructive",
      });
      refetchTruth();
    }
  };

  const selectedClient = clients?.find((c) => c.id === clientId);
  const totals = useMemo(() => lineTotals(lines), [lines]);
  const formIssues = headerIssues(form);
  const stateUncertain = overview.isPending || (!!editorId && (headerQuery.isPending || linesQuery.isPending));
  // Zonder overzicht valt er niets te beslissen; een mislukte verversing mét
  // eerdere data laat het scherm staan en meldt dat het verouderd kan zijn.
  const stateUnavailable = overview.isError && !overview.data;
  // Concept voor het getypte jaar terwijl de zoektocht (bewust) niet meeging.
  const typedYearDrafts =
    !editorId && overview.data && typedYear !== null && typedYear !== selectedYear
      ? overview.data.headers.filter((h) => h.boekjaar === typedYear)
      : [];
  const leftoverDrafts = state?.kind === "posted" || state?.kind === "nil" ? state.leftoverDrafts : [];

  const statusBadge = posted ? (
    <Badge variant="success" data-testid="beginbalans-status">Geboekt</Badge>
  ) : nil ? (
    <Badge variant="secondary" data-testid="beginbalans-status">Nihil</Badge>
  ) : editorId ? (
    <Badge variant="secondary" data-testid="beginbalans-status">Concept</Badge>
  ) : (
    <Badge variant="outline" data-testid="beginbalans-status">Nog geen beginbalans</Badge>
  );

  const draftChip = (draft: OpeningBalanceRow, label: string) => (
    <Button
      key={draft.id}
      type="button"
      variant="outline"
      size="sm"
      className="h-11 sm:h-8"
      onClick={() => requestOpen(draft)}
      aria-label={`Open concept ${label}`}
    >
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Beginbalans"
        description="De beginpositie van een administratie in het grootboek: één keer vastleggen, daarna definitief. Boeken en de nihil-verklaring zijn voorbehouden aan een accountant."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message={CLIENT_BANNER} />
      ) : overview.isPending ? (
        <Card>
          <CardContent className="pt-6">
            <LoadingBlock label="Beginbalans laden…" />
          </CardContent>
        </Card>
      ) : stateUnavailable ? (
        <Alert variant="destructive" data-testid="beginbalans-load-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Beginbalans kan niet worden geladen</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{classifyOpeningBalanceError(overview.error).message}</p>
            <Button variant="outline" size="sm" onClick={() => overview.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-6">
          {targetRejected && (
            <Alert variant="destructive" data-testid="beginbalans-target-rejected">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Beginbalans niet gevonden voor deze administratie</AlertTitle>
              <AlertDescription>
                De opgevraagde beginbalans bestaat niet of hoort niet bij de gekozen administratie. Hieronder staat
                de werkelijke toestand van deze administratie.
              </AlertDescription>
            </Alert>
          )}
          {targetMalformed && (
            <p className="text-sm text-muted-foreground" role="status" data-testid="beginbalans-target-ignored">
              De verwijzing in de link is ongeldig en is genegeerd.
            </p>
          )}
          {targetHeader &&
            ((state?.kind === "posted" && targetHeader.id !== state.marker.opening_balance_id) ||
              (state?.kind === "nil" && targetHeader.id !== state.header.id)) && (
              <Alert data-testid="beginbalans-target-leftover">
                <Info className="h-4 w-4" />
                <AlertTitle>De opgevraagde beginbalans is een achtergebleven concept</AlertTitle>
                <AlertDescription>
                  De {state.kind === "posted" ? "geboekte" : "op nihil gezette"} beginbalans van deze administratie
                  wordt hieronder getoond; het concept doet niets meer.
                </AlertDescription>
              </Alert>
            )}

          {overview.isError && (
            <Alert variant="destructive" data-testid="beginbalans-refresh-error">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Verversen mislukt</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <p>De laatste verversing is mislukt; de getoonde toestand kan verouderd zijn. De database blijft bij elke actie het laatste woord houden.</p>
                <Button variant="outline" size="sm" onClick={refetchTruth}>
                  Opnieuw laden
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {state?.kind === "conflict" && (
            <Alert variant="destructive" data-testid="beginbalans-conflict">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Tegenstrijdige toestand</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}

          {state?.kind === "multiple-drafts" && (
            <Alert variant="destructive" data-testid="beginbalans-multiple-drafts">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Meerdere concepten voor boekjaar {selectedYear}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  Er bestaan {state.drafts.length} concepten voor deze administratie en dit boekjaar. Er wordt
                  er niet automatisch één gekozen: open het juiste concept of verwijder de overbodige.
                  Concepten worden nooit samengevoegd.
                </p>
                <ul className="space-y-2">
                  {state.drafts.map((draft) => (
                    <li key={draft.id} className="flex flex-wrap items-center gap-2" data-testid="beginbalans-draft-option">
                      <span className="text-sm">
                        {draftLabel(draft)}{" "}
                        <span className="font-mono text-xs text-muted-foreground">({draft.id})</span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-11 sm:h-8"
                        onClick={() => requestOpen(draft)}
                        aria-label={`Open concept van ${formatDatumNL(draft.opening_date)}`}
                      >
                        Openen
                      </Button>
                      {canAssert === true && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11 text-muted-foreground hover:text-destructive sm:h-8"
                          onClick={() => setDeleteTarget(draft)}
                          aria-label={`Verwijder concept van ${formatDatumNL(draft.opening_date)}`}
                        >
                          <Trash2 className="mr-1 h-4 w-4" />Verwijderen
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {(state?.kind === "none" || state?.kind === "draft" || state?.kind === "multiple-drafts") &&
            state.otherDrafts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="beginbalans-other-drafts">
                <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Deze administratie heeft ook concepten voor een ander boekjaar:</span>
                {state.otherDrafts.map((d) => draftChip(d, `${d.boekjaar} (${formatDatumNL(d.opening_date)})`))}
              </div>
            )}

          {typedYearDrafts.length > 0 && (
            <Alert data-testid="beginbalans-typed-year-drafts">
              <Info className="h-4 w-4" />
              <AlertTitle>Er bestaat al een concept voor boekjaar {typedYear}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  Je invoer is bewaard. Opslaan maakt een tweede concept voor {typedYear} aan; open liever het
                  bestaande concept (je huidige invoer wordt dan weggegooid).
                </p>
                <div className="flex flex-wrap gap-2">
                  {typedYearDrafts.map((d) => draftChip(d, draftLabel(d)))}
                </div>
              </AlertDescription>
            </Alert>
          )}

          {leftoverDrafts.length > 0 && (
            <Alert data-testid="beginbalans-leftover-drafts">
              <Info className="h-4 w-4" />
              <AlertTitle>Achtergebleven concepten</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  De beginbalans van deze administratie is {posted ? "geboekt" : "op nihil gezet"}; deze concepten
                  doen niets meer en kunnen alleen nog worden verwijderd{canAssert === true ? "" : " (door een accountant)"}.
                </p>
                <ul className="space-y-2">
                  {leftoverDrafts.map((draft) => (
                    <li key={draft.id} className="flex flex-wrap items-center gap-2" data-testid="beginbalans-leftover-draft">
                      <span className="text-sm">
                        {draft.boekjaar} · {draftLabel(draft)}{" "}
                        <span className="font-mono text-xs text-muted-foreground">({draft.id})</span>
                      </span>
                      {canAssert === true && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11 text-muted-foreground hover:text-destructive sm:h-8"
                          onClick={() => setDeleteTarget(draft)}
                          aria-label={`Verwijder concept van ${formatDatumNL(draft.opening_date)}`}
                        >
                          <Trash2 className="mr-1 h-4 w-4" />Verwijderen
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {(editorId || state?.kind === "none") && !conflict && (
            <>
              <Card data-testid="beginbalans-header-card">
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <CardTitle className="font-display text-lg">
                    {selectedClient ? `Beginbalans — ${selectedClient.name}` : "Beginbalans"}
                  </CardTitle>
                  {statusBadge}
                </CardHeader>
                <CardContent className="space-y-5">
                  {editorId && !dbHeader && headerQuery.isPending && (
                    <LoadingBlock label="Beginbalans laden…" />
                  )}
                  {editorId && !headerQuery.isPending && !overview.isFetching && dbHeader === null && (
                    <Alert variant="destructive" data-testid="beginbalans-missing">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Dit concept bestaat niet meer</AlertTitle>
                      <AlertDescription className="flex flex-col items-start gap-3">
                        <p>Het is elders verwijderd. Laad de actuele toestand opnieuw.</p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setChosen(null);
                            refetchTruth();
                          }}
                        >
                          Opnieuw laden
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}

                  {posted && (
                    <p
                      className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                      role="status"
                      data-testid="beginbalans-posted-notice"
                    >
                      {POSTED_FINAL_NOTICE}
                    </p>
                  )}
                  {nil && (
                    <div
                      className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm"
                      role="status"
                      data-testid="beginbalans-nil-notice"
                    >
                      <p className="font-medium">
                        {NIL_NOTICE}
                        {dbHeader?.nil_declared_at ? ` op ${formatTijdstipNL(dbHeader.nil_declared_at)}` : ""}
                      </p>
                      <p className="text-muted-foreground">{NIL_FINAL_NOTICE}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="grid gap-2">
                      <Label htmlFor="ob-administratie">Administratie</Label>
                      <Input id="ob-administratie" value={selectedClient?.name ?? ""} readOnly disabled />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="ob-boekjaar">Boekjaar</Label>
                      <Input
                        id="ob-boekjaar"
                        type="number"
                        inputMode="numeric"
                        min={2000}
                        max={2100}
                        step={1}
                        value={form.boekjaar}
                        disabled={readOnly}
                        onChange={(e) => handleBoekjaarChange(e.target.value)}
                        aria-invalid={formIssues.length > 0 || undefined}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="ob-datum">Openingsdatum</Label>
                      <Input
                        id="ob-datum"
                        type="date"
                        value={form.opening_date}
                        disabled={readOnly}
                        onChange={(e) => setForm((prev) => ({ ...prev, opening_date: e.target.value }))}
                        aria-invalid={formIssues.length > 0 || undefined}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="ob-referentie">Referentie</Label>
                      <Input
                        id="ob-referentie"
                        placeholder="Optioneel"
                        value={form.reference}
                        disabled={readOnly}
                        onChange={(e) => setForm((prev) => ({ ...prev, reference: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="ob-omschrijving">Omschrijving</Label>
                    <Input
                      id="ob-omschrijving"
                      placeholder="Bijv. Beginbalans 2027"
                      value={form.description}
                      disabled={readOnly}
                      onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    />
                  </div>
                  {!readOnly && formIssues.length > 0 && (
                    <ul className="text-sm text-destructive" role="alert" data-testid="beginbalans-header-issues">
                      {formIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}

                  {posted && state?.kind === "posted" && (
                    <dl className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="beginbalans-posted-details">
                      <Detail label="Boekjaar" value={String(state.marker.boekjaar)} />
                      <Detail label="Openingsdatum" value={formatDatumNL(state.marker.opening_date)} />
                      <Detail label="Boekingstotaal (debet = credit)" value={formatCentsEuro(dbAmountToCents(state.marker.total_amount))} mono />
                      <Detail label="Aantal regels" value={String(state.marker.line_count)} />
                      <Detail label="Geboekt op" value={formatTijdstipNL(state.marker.created_at)} />
                      <Detail label="Boekingsgroep (audit)" value={state.marker.posting_group_id} mono />
                    </dl>
                  )}
                  {(posted || nil) && <ReportLinks />}
                </CardContent>
              </Card>

              {!nil && (
                <Card data-testid="beginbalans-lines-card">
                  <CardHeader>
                    <CardTitle className="font-display text-lg">Regels</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!readOnly && (
                      <p
                        className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
                        data-testid="beginbalans-double-count-warning"
                      >
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                        <span>{DOUBLE_COUNT_WARNING}</span>
                      </p>
                    )}
                    <OpeningBalanceTable
                      lines={lines}
                      clientId={clientId!}
                      accountsById={accountsById}
                      readOnly={readOnly}
                      onChange={setLines}
                    />
                    <OpeningBalanceSummary totals={totals} />
                  </CardContent>
                </Card>
              )}

              {!readOnly && (
                <div
                  className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-md sm:border"
                  data-testid="beginbalans-actions"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 sm:h-9"
                      onClick={handleSave}
                      disabled={isSaving}
                      data-testid="beginbalans-save"
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {isSaving ? "Opslaan…" : "Concept opslaan"}
                    </Button>
                    {editorId && dbHeader && canAssert === true && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11 text-muted-foreground hover:text-destructive sm:h-9"
                        onClick={() => setDeleteTarget(dbHeader)}
                        aria-label="Concept verwijderen"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />Concept verwijderen
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <OpeningBalanceNilAction
                      openingBalanceId={editorId}
                      header={form}
                      lines={lines}
                      savedLineCount={dbLines?.length ?? 0}
                      isHeaderDirty={headerDirty}
                      isSaving={isSaving}
                      stateUncertain={stateUncertain}
                      stateUnavailable={stateUnavailable}
                      onDeclared={refetchTruth}
                      onCompetingState={refetchTruth}
                    />
                    <OpeningBalancePostingAction
                      openingBalanceId={editorId}
                      clientId={clientId!}
                      header={form}
                      lines={lines}
                      accountsById={accountsById}
                      isDirty={isDirty}
                      isSaving={isSaving}
                      stateUncertain={stateUncertain}
                      stateUnavailable={stateUnavailable}
                      onPosted={refetchTruth}
                      onCompetingState={refetchTruth}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteDraft.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Concept verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Het concept van {deleteTarget ? formatDatumNL(deleteTarget.opening_date) : ""} en alle regels worden
              verwijderd. Een geboekte of op nihil verklaarde beginbalans kan niet worden verwijderd; dit is een
              concept. Deze actie kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDraft.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteDraft.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteConfirm}
            >
              {deleteDraft.isPending ? "Verwijderen…" : "Verwijderen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={discardTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Niet-opgeslagen wijzigingen</AlertDialogTitle>
            <AlertDialogDescription>
              Het huidige formulier heeft wijzigingen die nog niet zijn opgeslagen. Weggooien en het andere
              concept openen?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Terug</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                const next = discardTarget;
                setDiscardTarget(null);
                if (next) openDraft(next);
              }}
            >
              Wijzigingen weggooien
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
