import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { MemoriaalLinesTable } from "@/components/memoriaal/MemoriaalLinesTable";
import { MemoriaalPostingAction } from "@/components/memoriaal/MemoriaalPostingAction";
import { useToast } from "@/hooks/use-toast";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClients } from "@/hooks/useClients";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import {
  useCreateManualJournal,
  useDeleteManualJournal,
  useManualJournal,
  useManualJournalLines,
  useManualJournals,
  useSaveManualJournalLines,
  useUpdateManualJournal,
  type ManualJournalListItem,
} from "@/hooks/useManualJournals";
import { useManualJournalPosting } from "@/hooks/useManualJournalPosting";
import { formatEuro } from "@/lib/format";
import {
  buildSaveLinesPayload,
  classifyManualJournalError,
  createEmptyHeaderForm,
  createEmptyLineRows,
  isManualJournalDirty,
  manualJournalListAmount,
  POSTED_NOTICE,
  toHeaderForm,
  toLineRows,
  type ManualJournalHeaderForm,
  type ManualJournalLineRow,
} from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — memoriaalboekingen (/grootboek/memoriaal).
 *
 * Concept → kop opslaan → regels atomair opslaan via save_manual_journal_lines()
 * → accountant boekt via post_manual_journal() → geboekt en alleen-lezen.
 *
 * De pagina implementeert de boekhoudregels niet opnieuw: de knop gaat uit bij
 * duidelijk kansloze invoer, maar de database beslist. Correcties op een
 * geboekte memoriaal kunnen alleen met een tegenboeking (nog niet gebouwd).
 */

type EditorState = { mode: "new" } | { mode: "existing"; id: string } | null;

function formatDatum(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}-${m}-${y}` : d;
}

function ListSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Memoriaalboekingen laden…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 shrink-0 md:block" />
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-5 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function Memoriaal() {
  const { toast } = useToast();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: accounts } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const listQuery = useManualJournals({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: orgEnabled && hasSpecificClient,
  });

  const [editor, setEditor] = useState<EditorState>(null);
  const editingId = editor?.mode === "existing" ? editor.id : null;

  const journalQuery = useManualJournal(editingId ?? undefined);
  const linesQuery = useManualJournalLines(editingId ?? undefined);
  const { data: marker } = useManualJournalPosting(editingId ?? undefined);
  // De lijst weet de status al, de claimquery is een tweede verzoek. Zonder
  // die tweede bron staat een geboekte memoriaal heel even bewerkbaar in beeld.
  const listedPosted = !!listQuery.data?.find((i) => i.journal.id === editingId)?.posted;
  const posted = !!marker || listedPosted;

  const createJournal = useCreateManualJournal();
  const updateJournal = useUpdateManualJournal();
  const saveLines = useSaveManualJournalLines();
  const deleteJournal = useDeleteManualJournal();
  const isSaving = createJournal.isPending || updateJournal.isPending || saveLines.isPending;

  const [form, setForm] = useState<ManualJournalHeaderForm>(() => createEmptyHeaderForm());
  const [lines, setLines] = useState<ManualJournalLineRow[]>([]);
  const [persistedForm, setPersistedForm] = useState<ManualJournalHeaderForm | null>(null);
  const [persistedLines, setPersistedLines] = useState<ManualJournalLineRow[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManualJournalListItem | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{ next: EditorState } | null>(null);
  const syncedKey = useRef<string | null>(null);

  const isDirty = isManualJournalDirty(form, lines, persistedForm, persistedLines);

  // Niet-opgeslagen wijzigingen mogen niet ongemerkt verdwijnen.
  useEffect(() => {
    if (!editor || !isDirty || posted) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editor, isDirty, posted]);

  // Formulier synchroniseren met de database. De sleutel bevat de inhoud, dus
  // een achtergrond-refetch met identieke data overschrijft niets waar je in typt.
  useEffect(() => {
    if (editor?.mode !== "existing") return;
    // Nooit typewerk overschrijven. Zodra er een basislijn is en het formulier
    // afwijkt, laten we de invoer met rust; na opslaan lost het zichzelf op.
    if (persistedForm && persistedLines && isDirty) return;
    const journal = journalQuery.data;
    const dbLines = linesQuery.data;
    if (!journal || !dbLines) return;
    const key = [
      journal.id,
      journal.updated_at,
      dbLines
        .map((l) => `${l.id}:${l.sort_order}:${l.debit_amount}:${l.credit_amount}:${l.grootboekrekening_id ?? ""}:${l.omschrijving ?? ""}`)
        .join("|"),
    ].join("#");
    if (syncedKey.current === key) return;
    syncedKey.current = key;
    const nextForm = toHeaderForm(journal);
    const nextLines = toLineRows(dbLines, accounts);
    setForm(nextForm);
    setLines(nextLines);
    setPersistedForm(nextForm);
    setPersistedLines(nextLines);
  }, [editor, journalQuery.data, linesQuery.data, accounts, persistedForm, persistedLines, isDirty]);

  const openEditor = (next: EditorState) => {
    syncedKey.current = null;
    if (next?.mode === "new") {
      const empty = createEmptyHeaderForm(hasSpecificClient ? selectedClientId : "");
      setForm(empty);
      setLines(createEmptyLineRows(2));
    } else {
      // Een andere boeking openen: eerst leegmaken. Anders staat de vorige
      // boeking nog in beeld terwijl de knop al de nieuwe id zou boeken.
      setForm(createEmptyHeaderForm(""));
      setLines([]);
    }
    // Nog geen basislijn uit de database: het formulier telt als "dirty", dus
    // boeken is geblokkeerd tot de opgeslagen toestand bekend is.
    setPersistedForm(null);
    setPersistedLines(null);
    setEditor(next);
  };

  const requestEditor = (next: EditorState) => {
    if (editor && isDirty && !posted) {
      setDiscardTarget({ next });
      return;
    }
    openEditor(next);
  };

  const handleSave = async () => {
    if (!form.client_id) {
      toast({ title: "Kies eerst een administratie.", variant: "destructive" });
      return;
    }
    if (!form.posting_date) {
      toast({ title: "Vul een boekingsdatum in.", variant: "destructive" });
      return;
    }
    try {
      let journalId = editingId;
      if (journalId) {
        await updateJournal.mutateAsync({ id: journalId, form });
      } else {
        journalId = (await createJournal.mutateAsync(form)).id;
        // Meteen vastleggen: als het opslaan van de regels hierna faalt, werkt
        // een volgende poging deze kop bij in plaats van een tweede kop aan te
        // maken (anders blijft er per mislukte poging een leeg concept achter).
        setEditor({ mode: "existing", id: journalId });
      }

      // Precies één aanroep; de database vervangt de hele regelset atomair.
      await saveLines.mutateAsync({ journalId, lines: buildSaveLinesPayload(lines) });

      // Bewust NIET syncedKey wissen: de cache bevat op dit moment nog de oude
      // rijen, en die zouden het zojuist opgeslagen formulier terugdraaien. De
      // sleutel van die oude rijen staat al geregistreerd, dus het effect laat
      // ze met rust en synchroniseert pas wanneer de verse rijen binnen zijn.
      setPersistedForm(form);
      setPersistedLines(lines);
      toast({ title: "Memoriaalboeking opgeslagen" });
    } catch (e) {
      toast({
        title: "Opslaan niet gelukt",
        description: classifyManualJournalError(e).message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!deleteTarget) return;
    try {
      await deleteJournal.mutateAsync(deleteTarget.journal.id);
      if (editingId === deleteTarget.journal.id) {
        setEditor(null);
        syncedKey.current = null;
      }
      setDeleteTarget(null);
      toast({ title: "Memoriaalboeking verwijderd" });
    } catch (e) {
      toast({
        title: "Verwijderen niet gelukt",
        description: classifyManualJournalError(e).message,
        variant: "destructive",
      });
    }
  };

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const listData = listQuery.data;
  const listRows = useMemo(
    () =>
      (listData ?? []).map((item) => ({
        item,
        amount: manualJournalListAmount(item.marker, toLineRows(item.lines, accounts)),
      })),
    [listData, accounts],
  );

  return (
    <>
      <PageHeader
        title="Memoriaalboekingen"
        description="Vrije journaalposten: zelf de debet- en creditregels kiezen. Boeken kan alleen in balans en alleen door een accountant."
      >
        <Button
          type="button"
          onClick={() => requestEditor({ mode: "new" })}
          disabled={!hasSpecificClient}
          data-testid="memoriaal-new"
        >
          <Plus className="mr-2 h-4 w-4" /> Nieuwe memoriaalboeking
        </Button>
      </PageHeader>

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om memoriaalboekingen te bekijken." />
      ) : (
        <div className="space-y-6">
          {editor && (
            <Card data-testid="memoriaal-editor">
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <CardTitle className="font-display text-lg">
                  {editor.mode === "new" ? "Nieuwe memoriaalboeking" : "Memoriaalboeking"}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {posted && <Badge variant="secondary">Geboekt</Badge>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => requestEditor(null)}
                  >
                    Sluiten
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {editingId && !persistedForm && (
                  <p
                    className="text-sm text-muted-foreground"
                    role="status"
                    aria-live="polite"
                    data-testid="memoriaal-editor-loading"
                  >
                    Memoriaalboeking laden…
                  </p>
                )}
                {posted && (
                  <p
                    className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                    data-testid="memoriaal-posted-notice"
                  >
                    {POSTED_NOTICE}
                  </p>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="mj-klant">Administratie</Label>
                    <Select
                      value={form.client_id}
                      disabled={posted}
                      onValueChange={(v) => {
                        setForm((prev) => ({ ...prev, client_id: v }));
                        setSelectedClientId(v);
                      }}
                    >
                      <SelectTrigger id="mj-klant" aria-label="Administratie">
                        <span className="truncate">
                          {clients?.find((c) => c.id === form.client_id)?.name ?? "Selecteer administratie"}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {clients?.map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="mj-datum">Boekingsdatum</Label>
                    <Input
                      id="mj-datum"
                      type="date"
                      value={form.posting_date}
                      disabled={posted}
                      onChange={(e) => setForm((prev) => ({ ...prev, posting_date: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="mj-omschrijving">Omschrijving</Label>
                    <Textarea
                      id="mj-omschrijving"
                      rows={2}
                      placeholder="Waar gaat deze boeking over?"
                      value={form.description}
                      disabled={posted}
                      onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="mj-referentie">Referentie</Label>
                    <Input
                      id="mj-referentie"
                      placeholder="Optioneel"
                      value={form.reference}
                      disabled={posted}
                      onChange={(e) => setForm((prev) => ({ ...prev, reference: e.target.value }))}
                    />
                  </div>
                </div>

                <MemoriaalLinesTable lines={lines} readOnly={posted} onChange={setLines} />

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {!posted && (
                      <Button type="button" onClick={handleSave} disabled={isSaving} variant="outline">
                        <Save className="mr-2 h-4 w-4" />
                        {isSaving ? "Opslaan…" : "Concept opslaan"}
                      </Button>
                    )}
                  </div>
                  <MemoriaalPostingAction
                    journalId={editingId}
                    header={form}
                    lines={lines}
                    isDirty={isDirty}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">
                {selectedClient ? `Memoriaalboekingen — ${selectedClient.name}` : "Memoriaalboekingen"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {listQuery.isLoading ? (
                <ListSkeleton />
              ) : listQuery.isError ? (
                <div className="flex flex-col items-start gap-3 py-6" role="alert">
                  <p className="text-sm text-muted-foreground">
                    Memoriaalboekingen laden is mislukt.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
                    Opnieuw proberen
                  </Button>
                </div>
              ) : listRows.length === 0 ? (
                <EmptyState message="Nog geen memoriaalboekingen voor deze administratie." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-28">Datum</TableHead>
                        <TableHead>Omschrijving</TableHead>
                        <TableHead className="hidden lg:table-cell">Referentie</TableHead>
                        <TableHead className="w-32 text-right">Bedrag</TableHead>
                        <TableHead className="w-28">Status</TableHead>
                        <TableHead className="w-24 text-right">Acties</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {listRows.map(({ item, amount }) => (
                        <TableRow key={item.journal.id} data-testid="memoriaal-list-row">
                          <TableCell className="whitespace-nowrap">
                            {formatDatum(item.journal.posting_date)}
                          </TableCell>
                          <TableCell className="max-w-[260px] truncate">
                            {item.journal.description || "—"}
                          </TableCell>
                          <TableCell className="hidden max-w-[160px] truncate lg:table-cell">
                            {item.journal.reference || "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {formatEuro(amount)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={item.posted ? "secondary" : "outline"}>
                              {item.posted ? "Geboekt" : "Concept"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => requestEditor({ mode: "existing", id: item.journal.id })}
                                aria-label={`Open memoriaalboeking van ${formatDatum(item.journal.posting_date)}`}
                                title="Openen"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              {/* Geboekt = geen verwijderactie: de database weigert hem toch. */}
                              {!item.posted && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  onClick={() => setDeleteTarget(item)}
                                  aria-label={`Verwijder memoriaalboeking van ${formatDatum(item.journal.posting_date)}`}
                                  title="Verwijderen"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteJournal.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Memoriaalboeking verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Het concept en alle regels worden verwijderd. Deze actie kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteJournal.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteJournal.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteConfirm}
            >
              {deleteJournal.isPending ? "Verwijderen…" : "Verwijderen"}
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
              Deze memoriaalboeking heeft wijzigingen die nog niet zijn opgeslagen. Weggooien?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Terug</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                const next = discardTarget?.next ?? null;
                setDiscardTarget(null);
                openEditor(next);
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
