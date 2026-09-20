import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/financial-statements-presentation";
import {
  buildRunningBalance,
  type LedgerAccountLike,
  type LedgerPeriod,
} from "@/lib/ledger-reporting";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { GrootboekAccountMutations } from "@/components/grootboek/GrootboekAccountMutations";
import type { ReversalAccountRef } from "@/lib/ledger-reversal-ui";
import {
  accountReconciliation,
  accountRow,
  balanceOrientation,
  profitLossReconciliation,
  subgroupReconciles,
  subgroupView,
  type DrilldownAccountRow,
  type DrilldownGroupView,
  type DrilldownTarget,
  type ReportKind,
} from "@/lib/report-drilldown";

/**
 * Van een bedrag in het rapport naar de boeking eronder.
 *
 * Eén paneel voor de hele keten: categorie → groep → rekening → mutaties →
 * boekingsdetail. De gebruiker verlaat het rapport niet, en daarmee ook zijn
 * administratie, zijn periode en zijn plaats in het rapport niet.
 *
 * ER WORDT HIER NIETS HERREKEND. Elk rapportbedrag komt kant-en-klaar uit de
 * engine (via `report-drilldown.ts`), en de mutaties komen uit de kern
 * (`buildRunningBalance`) op exact dezelfde periode en administratie als het
 * rapport. Het laatste niveau is het bestaande `GrootboekAccountMutations`,
 * dat op zijn beurt het bestaande boekingspaneel opent — inclusief de
 * tegenboekingsfunctionaliteit.
 */

export interface ReportDrilldownSheetProps {
  target: DrilldownTarget | null;
  onTargetChange: (target: DrilldownTarget | null) => void;
  /** De categorie waarop is geklikt, al opgedeeld door de engine. */
  view: DrilldownGroupView | null;
  clientId: string;
  /** Exact de periode van het rapport; er wordt er nooit een andere gekozen. */
  period: LedgerPeriod;
  periodLabel: string;
  clientName: string;
  accountsById: ReadonlyMap<string, ReversalAccountRef>;
  /** Het rekeningschema, zoals de kern het verwacht (inclusief `categorie`). */
  accounts: readonly LedgerAccountLike[];
  /** Het soort rapport, alleen voor de context in de kop. */
  reportLabel: string;
  /**
   * EXPLICIET welk rapport dit is. Bepaalt hoe een rekeningbedrag wordt
   * uitgelegd; wordt nooit uit het label of uit de rekening afgeleid.
   */
  reportKind: ReportKind;
}

export function ReportDrilldownSheet({
  target,
  onTargetChange,
  view,
  clientId,
  period,
  periodLabel,
  clientName,
  accountsById,
  accounts,
  reportLabel,
  reportKind,
}: ReportDrilldownSheetProps) {
  const open = target !== null;
  const accountId = target?.level === "account" ? target.accountId : null;

  /*
   * Dezelfde query als het rapport zelf al doet: gelijke sleutel, dus
   * react-query deelt de cache en er komt geen tweede verzoek bij. Pas
   * ingeschakeld zodra er werkelijk een rekening is aangewezen — een dicht
   * paneel haalt niets op.
   */
  const postingsQuery = useLedgerPostings({
    clientId,
    period,
    enabled: open && accountId !== null,
  });

  const running = useMemo(() => {
    if (!accountId || !postingsQuery.data) return null;
    return buildRunningBalance({
      rows: postingsQuery.data,
      clientId,
      accountId,
      period,
      accounts,
    });
  }, [accountId, postingsQuery.data, clientId, period, accounts]);

  const sluiten = () => onTargetChange(null);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && sluiten()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="space-y-1 pb-1">
          <SheetTitle className="text-base">Toelichting</SheetTitle>
          <SheetDescription className="text-xs" data-testid="drilldown-context">
            {reportLabel} · {clientName} · {periodLabel}
          </SheetDescription>
        </SheetHeader>

        {view === null ? (
          <Alert className="mt-4" data-testid="drilldown-unavailable">
            <AlertDescription>
              De onderliggende gegevens van dit bedrag zijn niet beschikbaar.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-3 space-y-4">
            <Kruimelpad target={target!} view={view} onTargetChange={onTargetChange} />

            {target!.level === "group" && (
              <GroepNiveau view={view} onTargetChange={onTargetChange} />
            )}

            {target!.level === "subgroup" && (
              <GroepsNiveau
                view={view}
                subgroupKey={target!.subgroupKey}
                onTargetChange={onTargetChange}
              />
            )}

            {target!.level === "account" && (
              <RekeningNiveau
                view={view}
                accountId={accountId!}
                running={running}
                isPending={postingsQuery.isPending}
                isError={postingsQuery.isError}
                periodLabel={periodLabel}
                clientId={clientId}
                accountsById={accountsById}
                reportKind={reportKind}
              />
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Kruimelpad({
  target,
  view,
  onTargetChange,
}: {
  target: DrilldownTarget;
  view: DrilldownGroupView;
  onTargetChange: (t: DrilldownTarget | null) => void;
}) {
  const sub = target.level === "group" ? null : subgroupView(view, target.subgroupKey ?? "");
  const rekening = target.level === "account" ? accountRow(view, target.accountId) : null;
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Pad" data-testid="drilldown-breadcrumb">
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={() => onTargetChange({ level: "group", groupKey: view.groupKey })}
        data-testid="drilldown-crumb-group"
      >
        {view.label}
      </Button>
      {sub && (
        <>
          <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() =>
              onTargetChange({ level: "subgroup", groupKey: view.groupKey, subgroupKey: sub.key })
            }
            data-testid="drilldown-crumb-subgroup"
          >
            {sub.label}
          </Button>
        </>
      )}
      {rekening && (
        <>
          <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground" data-testid="drilldown-crumb-account">
            {rekening.accountNumber ?? "—"} {rekening.accountName}
          </span>
        </>
      )}
    </nav>
  );
}

function GroepNiveau({
  view,
  onTargetChange,
}: {
  view: DrilldownGroupView;
  onTargetChange: (t: DrilldownTarget) => void;
}) {
  return (
    <div className="space-y-3" data-testid="drilldown-group-level">
      <Totaalregel label={view.label} cents={view.totalCents} testId="drilldown-group-total" />
      {!view.reconciles && <AansluitingWaarschuwing />}

      <table className="w-full text-sm" data-testid="drilldown-subgroups">
        <caption className="sr-only">Groepen binnen {view.label}, met hun subtotaal</caption>
        <tbody>
          {view.subgroups.map((sub) => (
            <tr key={sub.key} className="border-b last:border-0" data-testid="drilldown-subgroup-row" data-subgroup={sub.key}>
              <td className="px-2 py-1.5">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-left text-sm"
                  onClick={() =>
                    onTargetChange({ level: "subgroup", groupKey: view.groupKey, subgroupKey: sub.key })
                  }
                  data-testid="drilldown-open-subgroup"
                >
                  {sub.label}
                </Button>
                {sub.isFallback && (
                  <Badge variant="outline" className="ml-2 font-normal">Nog niet ingedeeld</Badge>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">
                {formatCents(sub.subtotalCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.subgroups.length === 0 && <LeegBericht tekst="Geen onderliggende rekeningen in deze categorie." />}
    </div>
  );
}

function GroepsNiveau({
  view,
  subgroupKey,
  onTargetChange,
}: {
  view: DrilldownGroupView;
  subgroupKey: string;
  onTargetChange: (t: DrilldownTarget) => void;
}) {
  const sub = subgroupView(view, subgroupKey);
  if (!sub) return <LeegBericht tekst="Deze groep bestaat niet in dit rapport." />;

  return (
    <div className="space-y-3" data-testid="drilldown-subgroup-level">
      <Totaalregel label={sub.label} cents={sub.subtotalCents} testId="drilldown-subgroup-total" />
      {!subgroupReconciles(sub) && <AansluitingWaarschuwing />}

      <table className="w-full text-sm" data-testid="drilldown-accounts">
        <caption className="sr-only">Grootboekrekeningen binnen {sub.label}</caption>
        <tbody>
          {sub.accounts.map((a) => (
            <tr key={a.accountId} className="border-b last:border-0" data-testid="drilldown-account-row" data-account-id={a.accountId}>
              <td className="px-2 py-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                {a.accountNumber ?? "—"}
              </td>
              <td className="px-2 py-1.5">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-left text-sm"
                  onClick={() =>
                    onTargetChange({
                      level: "account",
                      groupKey: view.groupKey,
                      subgroupKey: sub.key,
                      accountId: a.accountId,
                    })
                  }
                  data-testid="drilldown-open-account"
                >
                  {a.accountName}
                </Button>
                {a.isContra && (
                  <Badge variant="outline" className="ml-2 font-normal">Tegenrekening</Badge>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">
                {formatCents(a.displayedCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sub.accounts.length === 0 && <LeegBericht tekst="Geen rekeningen in deze groep." />}
    </div>
  );
}

function RekeningNiveau({
  view,
  accountId,
  running,
  isPending,
  isError,
  periodLabel,
  clientId,
  accountsById,
  reportKind,
}: {
  view: DrilldownGroupView;
  accountId: string;
  running: ReturnType<typeof buildRunningBalance> | null;
  isPending: boolean;
  isError: boolean;
  periodLabel: string;
  clientId: string;
  accountsById: ReadonlyMap<string, ReversalAccountRef>;
  reportKind: ReportKind;
}) {
  const rapportRegel = accountRow(view, accountId);

  if (isError) {
    return (
      <Alert variant="destructive" data-testid="drilldown-error">
        <AlertDescription>
          De grootboekmutaties van deze rekening konden niet worden opgehaald. Ververs de pagina.
        </AlertDescription>
      </Alert>
    );
  }
  if (isPending || !running) {
    return (
      <div className="space-y-2" data-testid="drilldown-loading">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="drilldown-account-level">
      {rapportRegel && (
        <Totaalregel
          label={`${rapportRegel.accountNumber ?? "—"} ${rapportRegel.accountName}`}
          cents={rapportRegel.displayedCents}
          testId="drilldown-account-report-amount"
        />
      )}

      {reportKind === "profit_loss" && rapportRegel ? (
        <WinstVerliesUitleg row={rapportRegel} running={running} periodLabel={periodLabel} />
      ) : reportKind === "trial_balance" ? (
        <KolommenUitleg running={running} periodLabel={periodLabel} />
      ) : (
        <BalansUitleg row={rapportRegel} running={running} periodLabel={periodLabel} />
      )}

      {running.lines.length === 0 ? (
        <LeegBericht tekst={`Geen mutaties in ${periodLabel} op deze rekening.`} />
      ) : (
        <GrootboekAccountMutations
          running={running}
          periodLabel={periodLabel}
          clientId={clientId}
          accountsById={accountsById}
        />
      )}
    </div>
  );
}

/**
 * W&V: uitsluitend de gekozen periode.
 *
 * Er staat hier bewust GEEN beginsaldo en GEEN cumulatief eindsaldo. Een
 * resultaatrekening kan jaren historie dragen, en die historie verklaart het
 * rapportbedrag niet — de engine rekent voor een W&V-regel met de mutatie van
 * de periode, en dat is precies wat hier wordt uitgesplitst.
 */
function WinstVerliesUitleg({
  row,
  running,
  periodLabel,
}: {
  row: DrilldownAccountRow;
  running: ReturnType<typeof buildRunningBalance>;
  periodLabel: string;
}) {
  const a = profitLossReconciliation(row, running);
  return (
    <>
      <dl
        className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
        data-testid="drilldown-reconciliation"
        data-kind="profit_loss"
      >
        <dt className="text-muted-foreground">Debet in {periodLabel}</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-period-debit">
          {formatCents(a.periodDebitCents)}
        </dd>
        <dt className="text-muted-foreground">Credit in {periodLabel}</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-period-credit">
          {formatCents(a.periodCreditCents)}
        </dd>
        <dt className="text-muted-foreground">Netto mutatie (debet-positief)</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-net-movement">
          {formatCents(a.netMovementCents)}
        </dd>
        <dt className="font-medium">Bedrag in de winst-en-verliesrekening</dt>
        <dd className="text-right font-mono font-semibold tabular-nums" data-testid="drilldown-report-amount">
          {formatCents(a.reportCents)}
        </dd>
      </dl>

      {a.isMirrored && (
        <p className="text-xs text-muted-foreground" data-testid="drilldown-orientation-notice">
          Deze rekening staat aan de creditzijde van het rapport: het grootboek telt debet-positief,
          de winst-en-verliesrekening toont hem omgekeerd. Het is hetzelfde bedrag.
        </p>
      )}
      {!a.reconciles && <AansluitingWaarschuwing />}
    </>
  );
}

/** Balans: eindsaldo mét overloop, en de oriëntatie erbij wanneer die verschilt. */
function BalansUitleg({
  row,
  running,
  periodLabel,
}: {
  row: DrilldownAccountRow | null;
  running: ReturnType<typeof buildRunningBalance>;
  periodLabel: string;
}) {
  const a = accountReconciliation(running);
  const orientatie = row ? balanceOrientation(row, running) : null;
  return (
    <>
      <dl
        className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
        data-testid="drilldown-reconciliation"
        data-kind="balance_sheet"
      >
        <dt className="text-muted-foreground">Beginsaldo</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-opening">
          {formatCents(a.openingCents)}
        </dd>
        <dt className="text-muted-foreground">Mutaties {periodLabel}</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-movement">
          {formatCents(a.periodMovementCents)}
        </dd>
        <dt className="font-medium">Grootboeksaldo (debet-positief)</dt>
        <dd className="text-right font-mono font-semibold tabular-nums" data-testid="drilldown-closing">
          {formatCents(a.closingCents)}
        </dd>
        {/* Alleen tonen als het iets toevoegt: bij een debetzijde is het
            hetzelfde getal en zou een tweede regel alleen ruis zijn. */}
        {orientatie?.isMirrored && (
          <>
            <dt className="font-medium">Bedrag in Balans</dt>
            <dd className="text-right font-mono font-semibold tabular-nums" data-testid="drilldown-report-amount">
              {formatCents(orientatie.reportCents)}
            </dd>
          </>
        )}
      </dl>

      {orientatie?.isMirrored && (
        <p className="text-xs text-muted-foreground" data-testid="drilldown-orientation-notice">
          Deze rekening staat aan de creditzijde van de balans: het grootboek telt debet-positief,
          de balans toont hem omgekeerd. Het is hetzelfde saldo.
        </p>
      )}
      {a.hasOpeningContribution && (
        <p className="text-xs text-muted-foreground" data-testid="drilldown-opening-notice">
          Het eindsaldo bevat een overloop uit eerdere perioden; de mutaties hieronder verklaren
          alleen het deel van {periodLabel}.
        </p>
      )}
      {(!a.reconciles || orientatie?.reconciles === false) && <AansluitingWaarschuwing />}
    </>
  );
}

/** Kolommenbalans: dezelfde kolommen als de tabel, debet en credit apart. */
function KolommenUitleg({
  running,
  periodLabel,
}: {
  running: ReturnType<typeof buildRunningBalance>;
  periodLabel: string;
}) {
  const a = accountReconciliation(running);
  return (
    <>
      <dl
        className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm"
        data-testid="drilldown-reconciliation"
        data-kind="trial_balance"
      >
        <dt className="text-muted-foreground">Beginsaldo</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-opening">
          {formatCents(a.openingCents)}
        </dd>
        <dt className="text-muted-foreground">Periode debet</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-period-debit">
          {formatCents(a.periodDebitCents)}
        </dd>
        <dt className="text-muted-foreground">Periode credit</dt>
        <dd className="text-right font-mono tabular-nums" data-testid="drilldown-period-credit">
          {formatCents(a.periodCreditCents)}
        </dd>
        <dt className="font-medium">Eindsaldo (debet-positief)</dt>
        <dd className="text-right font-mono font-semibold tabular-nums" data-testid="drilldown-closing">
          {formatCents(a.closingCents)}
        </dd>
      </dl>
      {a.hasOpeningContribution && (
        <p className="text-xs text-muted-foreground" data-testid="drilldown-opening-notice">
          Het eindsaldo bevat een overloop uit eerdere perioden; de mutaties hieronder verklaren
          alleen het deel van {periodLabel}.
        </p>
      )}
      {!a.reconciles && <AansluitingWaarschuwing />}
    </>
  );
}

function Totaalregel({ label, cents, testId }: { label: string; cents: number; testId: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-3 py-2">
      <span className="text-sm font-medium">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums" data-testid={testId}>
        {formatCents(cents)}
      </span>
    </div>
  );
}

function AansluitingWaarschuwing() {
  return (
    <Alert variant="destructive" data-testid="drilldown-mismatch">
      <AlertDescription>
        De onderdelen tellen niet op tot het getoonde totaal. Meld dit; er wordt hier niets
        bijgeschat.
      </AlertDescription>
    </Alert>
  );
}

function LeegBericht({ tekst }: { tekst: string }) {
  return (
    <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground" data-testid="drilldown-empty">
      {tekst}
    </p>
  );
}
