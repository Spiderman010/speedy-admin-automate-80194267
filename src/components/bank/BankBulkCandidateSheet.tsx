import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { formatCents, formatDatumNL } from "@/lib/grootboek-saldi-utils";
import {
  WORKFLOW_BADGE_VARIANT,
  WORKFLOW_LABELS,
  type BankBulkCandidate,
} from "@/lib/bank-bulk-posting";

/**
 * Het auditpaneel van één bankregel.
 *
 * DIT PANEEL REKENT NIETS UIT. Er staat geen verwachte debet-/creditboeking
 * in, geen BTW-splitsing en geen afgeleide rekeningkeuze — die zijn van
 * `public.post_bank_transaction()` en zouden hier alleen maar van de echte
 * boeking kunnen gaan afwijken. Wat er staat, is de BRON (wat er in de
 * bankregel is vastgelegd) en de PREFLIGHT (wat de server erover zegt).
 */

export interface BankBulkCandidateSheetProps {
  candidate: BankBulkCandidate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Uitsluitend voor weergave: nummer en omschrijving van de gekozen rekening. */
  accountLabel?: string | null;
}

function Regel({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm break-words" data-testid={testId}>{children}</dd>
    </div>
  );
}

function euro(amount: number | string): string {
  const getal = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(getal)) return "—";
  // Dezelfde centenconventie als de rest van de app; er wordt niets herrekend,
  // alleen omgezet naar de weergave-eenheid.
  return formatCents(Math.round(getal * 100));
}

export function BankBulkCandidateSheet({
  candidate, open, onOpenChange, accountLabel,
}: BankBulkCandidateSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {candidate && (
          <>
            <SheetHeader>
              <SheetTitle>Bankregel</SheetTitle>
              <SheetDescription>
                Brongegevens en het oordeel van de server. De boeking zelf wordt door de database
                gemaakt; dit paneel toont geen berekende tegenboeking.
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-5">
              <section aria-label="Kop" className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge
                    variant={WORKFLOW_BADGE_VARIANT[candidate.workflow_state]}
                    data-testid="bulk-sheet-status"
                    data-state-label={candidate.workflow_state}
                  >
                    {WORKFLOW_LABELS[candidate.workflow_state]}
                  </Badge>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDatumNL(candidate.transaction_date)}
                  </span>
                </div>
                <p
                  className="mt-2 text-right font-mono text-lg tabular-nums"
                  data-testid="bulk-sheet-bedrag"
                >
                  {euro(candidate.amount)}
                </p>
              </section>

              <section aria-label="Bron">
                <h3 className="text-sm font-semibold">Bron</h3>
                <dl className="mt-1 divide-y">
                  <Regel label="Omschrijving">{candidate.description || "—"}</Regel>
                  <Regel label="Tegenrekening">{candidate.counter_account || "—"}</Regel>
                </dl>
              </section>

              <section aria-label="Boekhoudkundige invoer">
                <h3 className="text-sm font-semibold">Vastgelegde codering</h3>
                <dl className="mt-1 divide-y">
                  <Regel label="Grootboekrekening" testId="bulk-sheet-rekening">
                    {accountLabel ?? (candidate.grootboekrekening_id ? candidate.grootboekrekening_id : "Nog niet gekozen")}
                  </Regel>
                  <Regel label="BTW-percentage" testId="bulk-sheet-btw">
                    {candidate.btw_percentage === null || candidate.btw_percentage === undefined
                      ? "Geen"
                      : `${candidate.btw_percentage}%`}
                  </Regel>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  De BTW-splitsing, de debet-/creditzijde en de bankrekening worden bij het boeken
                  door de database bepaald.
                </p>
              </section>

              <section aria-label="Werkstroom">
                <h3 className="text-sm font-semibold">Beoordeling door de server</h3>
                <dl className="mt-1 divide-y">
                  <Regel label="Toestand">{WORKFLOW_LABELS[candidate.workflow_state]}</Regel>
                  <Regel label="Al geboekt">{candidate.is_posted ? "Ja" : "Nee"}</Regel>
                  <Regel label="Afgeletterd">{candidate.is_allocated ? "Ja" : "Nee"}</Regel>
                </dl>
                {candidate.reason && (
                  <Alert className="mt-3" data-testid="bulk-sheet-reden">
                    <AlertDescription>{candidate.reason}</AlertDescription>
                  </Alert>
                )}
              </section>

              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-11 w-full justify-between px-2 text-xs text-muted-foreground"
                    data-testid="bulk-sheet-technisch"
                  >
                    Technische gegevens
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <dl className="mt-1 divide-y text-muted-foreground">
                    <Regel label="Transactie-id">
                      <span className="font-mono text-xs break-all">{candidate.transaction_id}</span>
                    </Regel>
                    <Regel label="Boekingsgroep">
                      <span className="font-mono text-xs break-all">
                        {candidate.posting_group_id ?? "—"}
                      </span>
                    </Regel>
                    <Regel label="Ruwe status">
                      <span className="font-mono text-xs">{candidate.match_status}</span>
                    </Regel>
                    <Regel label="Servertoestand">
                      <span className="font-mono text-xs">{candidate.workflow_state}</span>
                    </Regel>
                  </dl>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
