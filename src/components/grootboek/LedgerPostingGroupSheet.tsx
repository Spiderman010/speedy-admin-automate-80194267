import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatCents, formatDatumNL } from "@/lib/grootboek-saldi-utils";
// Eén centenconventie voor de hele app: die van de rapportagekern.
import { toCents } from "@/lib/ledger-reporting";
import {
  formatReversalAccountLabel,
  postingGroupLines,
  postingGroupWarnings,
  previewReversalLines,
  reversalAvailability,
  reversalAwareSourceLabel,
  summarizePostingGroup,
  isSettledElsewhere,
  WARNINGS_NOTICE,
  type ReversalAccountRef,
  type ReversalErrorKind,
} from "@/lib/ledger-reversal-ui";
import {
  useCanReversePostingGroup,
  usePostingGroupRows,
  useReversalRelation,
  useReversePostingGroup,
} from "@/hooks/useLedgerReversal";
import { ReversalConfirmDialog } from "./ReversalConfirmDialog";

/**
 * 6C-b9 PR 2 — één boekingsgroep in detail, met de correctieactie.
 *
 * Bewust een paneel en geen nieuwe route: het grootboek heeft al een plek waar
 * een boeking wordt aangewezen (de mutaties van een rekening), en een boeking
 * is daar een detail van — geen eigen bestemming met eigen navigatie.
 *
 * Alles wat hier staat is AFGELEZEN uit opgeslagen gegevens: de regels komen
 * uit ledger_postings, de tegenboekingsstatus uit ledger_reversal_postings.
 * Er wordt nooit een status geraden uit een omschrijving, een bronlabel of een
 * saldo van nul.
 */

export interface LedgerPostingGroupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  postingGroupId: string | null;
  accountsById: ReadonlyMap<string, ReversalAccountRef>;
}

export function LedgerPostingGroupSheet({
  open,
  onOpenChange,
  clientId,
  postingGroupId,
  accountsById,
}: LedgerPostingGroupSheetProps) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * De synchrone grendel. `reverse.isPending` en de `disabled` op de knop
   * worden pas na een render waar; drie klikken binnen één tick zien die dus
   * alle drie nog op "uit" staan en zouden drie tegenboekingen afvuren. Een ref
   * is meteen waar en sluit dat af — nog vóór de eerste render.
   */
  const inFlight = useRef(false);

  const rowsQuery = usePostingGroupRows({ clientId, postingGroupId: postingGroupId ?? undefined, enabled: open });
  const relationQuery = useReversalRelation({ postingGroupId: postingGroupId ?? undefined, enabled: open });
  const { data: canReverse, isError: roleError } = useCanReversePostingGroup();
  const reverse = useReversePostingGroup();

  // Eigen useMemo: een nieuwe [] bij elke render zou de drie afgeleiden
  // hieronder elke keer opnieuw laten rekenen.
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);
  const summary = useMemo(
    () => summarizePostingGroup(postingGroupId ?? "", rows),
    [postingGroupId, rows],
  );
  const lines = useMemo(() => postingGroupLines(postingGroupId ?? "", rows), [postingGroupId, rows]);
  const preview = useMemo(() => previewReversalLines(postingGroupId ?? "", rows), [postingGroupId, rows]);

  const availability = reversalAvailability({
    summary,
    existingReversalGroupId: relationQuery.data ? (relationQuery.data.asOriginal?.reversal_posting_group_id ?? null) : null,
    markerUnavailable: relationQuery.isError || rowsQuery.isError,
    markerPending: relationQuery.isPending || rowsQuery.isPending,
    canReverse,
    roleUnavailable: roleError,
  });

  const handleConfirm = async (input: { postingDate: string; reason: string | null }) => {
    if (!postingGroupId || inFlight.current || reverse.isPending) return;
    inFlight.current = true;
    try {
      const nieuweGroep = await reverse.mutateAsync({ postingGroupId, ...input });
      // Pas melden nadat de claim zichtbaar is: de RPC kan slagen terwijl de
      // cache nog de oude waarheid heeft, en dan is "gelukt" een bewering die
      // het scherm niet kan waarmaken.
      const bevestigd = await relationQuery.refetch();
      setConfirmOpen(false);
      if (bevestigd.data?.asOriginal) {
        toast({
          title: "Tegenboeking gemaakt",
          description: `Nieuwe boekingsgroep ${bevestigd.data.asOriginal.reversal_posting_group_id}.`,
        });
      } else {
        toast({
          title: "Tegenboeking niet bevestigd",
          description: nieuweGroep
            ? "De database gaf een tegenboeking terug, maar de claim is nog niet zichtbaar. Ververs de pagina."
            : "Ververs de pagina en controleer de status voordat je het opnieuw probeert.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setConfirmOpen(false);
      const kind = (e as { kind?: ReversalErrorKind })?.kind ?? "unknown";
      const description = e instanceof Error ? e.message : undefined;
      if (isSettledElsewhere(kind)) {
        // Een andere sessie was eerder. Dat is een eindtoestand, geen storing:
        // opnieuw ophalen, tonen wat er staat, en niet uit onszelf herhalen.
        const bevestigd = await relationQuery.refetch();
        if (bevestigd.data?.asOriginal) {
          toast({ title: "Deze boeking is al tegengeboekt." });
          return;
        }
      }
      toast({ title: "Tegenboeken niet gelukt", description, variant: "destructive" });
    } finally {
      inFlight.current = false;
    }
  };

  // Informatie, geen slot: opvallendheden in de opgeslagen regels worden
  // getoond, maar houden een accountant niet tegen. De database beslist.
  const warnings = useMemo(() => postingGroupWarnings(summary), [summary]);

  const bronLabel = summary.sourceType ? reversalAwareSourceLabel(summary.sourceType) : "Meerdere bronnen";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (reverse.isPending) return;
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-1 pb-1">
          <SheetTitle className="text-base">Boeking</SheetTitle>
          <SheetDescription className="text-xs">
            De vastgelegde grootboekregels van deze boeking. Grootboekregels worden nooit gewijzigd of verwijderd.
          </SheetDescription>
        </SheetHeader>

        {rowsQuery.isPending ? (
          <div className="mt-4 space-y-2" data-testid="posting-group-loading">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : rowsQuery.isError ? (
          <Alert variant="destructive" className="mt-4" data-testid="posting-group-error">
            <AlertDescription>
              De grootboekregels van deze boeking konden niet worden opgehaald. Ververs de pagina.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-3 space-y-4">
            {/* ── Samenvatting ─────────────────────────────────────────── */}
            <div className="rounded-md border bg-muted/30">
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <Badge variant="outline" className="bg-background font-normal" data-testid="posting-group-source">
                  {bronLabel}
                </Badge>
                {availability.kind === "already_reversed" ? (
                  <Badge variant="secondary" className="font-normal" data-testid="posting-group-status">
                    Tegengeboekt
                  </Badge>
                ) : relationQuery.data?.asReversal ? (
                  <Badge variant="secondary" className="font-normal" data-testid="posting-group-status">
                    Tegenboeking
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-background font-normal" data-testid="posting-group-status">
                    Geboekt
                  </Badge>
                )}
                <span className="ml-auto font-mono text-sm font-semibold tabular-nums">
                  {formatCents(summary.debitCents)}
                </span>
              </div>

              <dl
                className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2 text-sm sm:grid-cols-3"
                data-testid="posting-group-summary"
              >
                <Veld label="Boekingsdatum" value={summary.postingDate ? formatDatumNL(summary.postingDate) : "—"} mono />
                <Veld label="Boekjaar" value={summary.boekjaar === null ? "—" : String(summary.boekjaar)} mono />
                <Veld label="Totaal debet" value={formatCents(summary.debitCents)} mono />
                <Veld label="Totaal credit" value={formatCents(summary.creditCents)} mono />
                <Veld label="Aantal regels" value={String(summary.lineCount)} mono />
                <Veld label="Valuta" value={summary.currency ?? "—"} />
              </dl>
            </div>

            {/* ── De vastgelegde regels ────────────────────────────────── */}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[460px] text-sm" data-testid="posting-group-lines">
                <caption className="sr-only">Grootboekregels van deze boeking</caption>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">Rekening</th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">Omschrijving</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Debet</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((row) => (
                    <tr key={row.id} className="border-b last:border-0" data-testid="posting-group-line">
                      <td className="px-2 py-1.5 break-words font-medium">
                        {formatReversalAccountLabel(accountsById.get(row.grootboekrekening_id), row.grootboekrekening_id)}
                      </td>
                      <td className="px-2 py-1.5 break-words text-muted-foreground">{row.description || "—"}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">
                        {toCents(row.debit_amount) !== 0 ? formatCents(toCents(row.debit_amount)) : ""}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">
                        {toCents(row.credit_amount) !== 0 ? formatCents(toCents(row.credit_amount)) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t text-xs">
                    <td className="px-2 py-1.5 text-muted-foreground" colSpan={2}>Totaal</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono font-semibold tabular-nums">
                      {formatCents(summary.debitCents)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono font-semibold tabular-nums">
                      {formatCents(summary.creditCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ── Opvallendheden: informatie, nooit een blokkade ───────── */}
            {warnings.length > 0 && (
              <Alert data-testid="posting-group-warnings">
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">{WARNINGS_NOTICE}</p>
                </AlertDescription>
              </Alert>
            )}

            {/* ── De actie, of de reden waarom er geen is ──────────────── */}
            <ReversalArea
              availability={availability}
              relation={relationQuery.data ?? null}
              isPending={reverse.isPending}
              onOpenConfirm={() => setConfirmOpen(true)}
            />

            {/* ── Technische details ───────────────────────────────────── */}
            <details className="rounded-md border p-2 text-xs" data-testid="posting-group-technical">
              <summary className="cursor-pointer text-muted-foreground">Technische details</summary>
              <dl className="mt-2 space-y-1">
                <TechnischVeld label="Boekingsgroep" value={summary.postingGroupId} />
                {summary.sourceId && <TechnischVeld label="Bron-id" value={summary.sourceId} />}
                {relationQuery.data?.asOriginal && (
                  <>
                    <TechnischVeld
                      label="Tegenboeking"
                      value={relationQuery.data.asOriginal.reversal_posting_group_id}
                    />
                    <TechnischVeld
                      label="Vastgelegd op"
                      value={formatDatumNL(relationQuery.data.asOriginal.created_at.slice(0, 10))}
                    />
                  </>
                )}
                {relationQuery.data?.asReversal && (
                  <TechnischVeld
                    label="Tegenboeking van"
                    value={relationQuery.data.asReversal.original_posting_group_id}
                  />
                )}
              </dl>
            </details>
          </div>
        )}


        {postingGroupId && (
          <ReversalConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            summary={summary}
            previewLines={preview}
            accountsById={accountsById}
            isPending={reverse.isPending}
            onConfirm={handleConfirm}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReversalArea({
  availability,
  relation,
  isPending,
  onOpenConfirm,
}: {
  availability: ReturnType<typeof reversalAvailability>;
  relation: { asOriginal: { reversal_posting_group_id: string; posting_date: string; reason: string | null } | null } | null;
  isPending: boolean;
  onOpenConfirm: () => void;
}) {
  if (availability.kind === "already_reversed") {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm" data-testid="reversal-already">
        <p className="font-medium">Deze boeking is tegengeboekt.</p>
        <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <dt>Tegenboeking</dt>
            <dd className="font-mono break-all" data-testid="reversal-group-id">
              {availability.reversalPostingGroupId}
            </dd>
          </div>
          {relation?.asOriginal && (
            <div className="flex gap-2">
              <dt>Datum</dt>
              <dd className="font-mono">{formatDatumNL(relation.asOriginal.posting_date)}</dd>
            </div>
          )}
          {relation?.asOriginal?.reason && (
            <div className="flex gap-2">
              <dt>Toelichting</dt>
              <dd className="break-words">{relation.asOriginal.reason}</dd>
            </div>
          )}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          De oorspronkelijke boeking hierboven is ongewijzigd gebleven. Een boeking wordt hoogstens één keer
          tegengeboekt.
        </p>
      </div>
    );
  }

  if (availability.kind === "unsupported_source") {
    return (
      <Alert data-testid="reversal-unsupported">
        <AlertDescription>{availability.explanation}</AlertDescription>
      </Alert>
    );
  }

  if (availability.kind === "unknown" || availability.kind === "not_allowed") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="reversal-hint">
        {availability.reason}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="destructive"
        className="h-11 sm:h-9"
        disabled={isPending}
        onClick={onOpenConfirm}
        data-testid="reversal-open-button"
      >
        {isPending ? "Bezig met tegenboeken…" : "Tegenboeken"}
      </Button>
      <p className="text-xs text-muted-foreground">
        De oorspronkelijke boeking blijft staan; er komt een nieuwe boeking bij.
      </p>
    </div>
  );
}

function Veld({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono tabular-nums" : undefined}>{value}</dd>
    </div>
  );
}

function TechnischVeld({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );
}
