import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
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
  deriveOpeningBalanceState,
  DOUBLE_COUNT_WARNING,
  formatCentsEuro,
  formatDatumNL,
  formatTijdstipNL,
  headerIssues,
  isCompetingStateError,
  isHeaderDirty,
  isNilHeader,
  lineBlocksSave,
  lineTotals,
  NIL_FINAL_NOTICE,
  NIL_NOTICE,
  parseBoekjaar,
  POSTED_FINAL_NOTICE,
  toHeaderForm,
  toLineRows,
  dbAmountToCents,
  type OpeningBalanceAccountRef,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";

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
 * stilzwijgend gekozen. Na elke mutatie wordt de waarheid opnieuw opgehaald.
 */

const CLIENT_BANNER = "Kies eerst een specifieke administratie om de beginbalans te bekijken.";

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
  /** Expliciete keuze van dit tabblad: zojuist aangemaakt of uit de conceptenlijst geopend. */
  const [chosenId, setChosenId] = useState<string | null>(null);

  const overview = useOpeningBalanceOverview(clientId);
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
  const syncedKey = useRef<string | null>(null);

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

  // Andere administratie: alles terug naar het begin.
  useEffect(() => {
    setChosenId(null);
    syncedKey.current = null;
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
    setForm(createHeaderForm(selectedYear));
    setLines(createEmptyLineRows());
    setPersistedForm(null);
    setPersistedLines(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorId]);

  // Formulier synchroniseren met de database. De sleutel bevat de inhoud, dus
  // een achtergrondrefetch met identieke data overschrijft niets waar je in
  // typt. Is de beginbalans inmiddels geboekt of nihil, dan wint de database
  // altijd: er blijft nooit een bewerkbaar formulier over een vastgelegde rij staan.
  useEffect(() => {
    if (!editorId || !dbHeader || !dbLines) return;
    if (!readOnly && persistedForm && persistedLines && isDirty) return;
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
    if (!editorId || !isDirty || readOnly) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editorId, isDirty, readOnly]);

  const refetchTruth = () => {
    syncedKey.current = null;
    void overview.refetch();
    if (editorId) {
      void headerQuery.refetch();
      void linesQuery.refetch();
      void markerQuery.refetch();
    }
  };

  const handleBoekjaarChange = (raw: string) => {
    setForm((prev) => applyBoekjaarChange(prev, raw));
    // In het nieuwe formulier stuurt het boekjaar ook de zoektocht naar een
    // bestaand concept; bij een bestaand concept volgt het pas na opslaan.
    if (!editorId) {
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
    try {
      let id = editorId;
      if (id) {
        await updateHeader.mutateAsync({ id, form });
      } else {
        id = (await createHeader.mutateAsync({ form, clientId })).id;
        // Meteen vastleggen: als het opslaan van de regels hierna faalt, werkt
        // een volgende poging deze kop bij in plaats van een tweede kop aan te
        // maken (anders blijft er per mislukte poging een leeg concept achter).
        // De kop is nu de basislijn en de regels nog niet: het formulier telt
        // als gewijzigd, zodat de getypte regels niet door de (lege) databaserijen
        // worden overschreven zolang ze niet zijn opgeslagen.
        setChosenId(id);
        setPersistedLines([]);
      }
      setPersistedForm(form);

      // Precies één aanroep; de database vervangt de hele regelset atomair.
      await saveLines.mutateAsync({ openingBalanceId: id, lines: buildSaveLinesPayload(lines) });

      // Bewust NIET syncedKey wissen: de cache bevat op dit moment nog de oude
      // rijen en die zouden het zojuist opgeslagen formulier terugdraaien.
      setPersistedLines(lines);
      const savedYear = parseBoekjaar(form.boekjaar);
      if (savedYear !== null) setSelectedYear(savedYear);
      toast({ title: "Beginbalans opgeslagen" });
    } catch (e) {
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
      if (chosenId === deleteTarget.id) setChosenId(null);
      syncedKey.current = null;
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
  const stateUnavailable = overview.isError;

  const statusBadge = posted ? (
    <Badge variant="success" data-testid="beginbalans-status">Geboekt</Badge>
  ) : nil ? (
    <Badge variant="secondary" data-testid="beginbalans-status">Nihil</Badge>
  ) : editorId ? (
    <Badge variant="secondary" data-testid="beginbalans-status">Concept</Badge>
  ) : (
    <Badge variant="outline" data-testid="beginbalans-status">Nog geen beginbalans</Badge>
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
      ) : overview.isError ? (
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
                        {formatDatumNL(draft.opening_date)} — {draft.description || "zonder omschrijving"}{" "}
                        <span className="font-mono text-xs text-muted-foreground">({draft.id})</span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-11 sm:h-8"
                        onClick={() => {
                          syncedKey.current = null;
                          setChosenId(draft.id);
                        }}
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
              <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="beginbalans-other-drafts">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Deze administratie heeft ook concepten voor een ander boekjaar:{" "}
                  {state.otherDrafts.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => {
                          syncedKey.current = null;
                          setChosenId(d.id);
                          setSelectedYear(d.boekjaar);
                        }}
                      >
                        {d.boekjaar} ({formatDatumNL(d.opening_date)})
                      </button>
                    </span>
                  ))}
                  .
                </span>
              </p>
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
                            setChosenId(null);
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
    </>
  );
}
