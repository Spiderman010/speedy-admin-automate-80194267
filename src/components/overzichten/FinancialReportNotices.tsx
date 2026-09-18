import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Info } from "lucide-react";
import {
  COMPLETENESS_PRESENTATION,
  UNCLASSIFIED_REASON_LABELS,
  UNCLASSIFIED_WARNING,
  accountLabel,
  formatCents,
} from "@/lib/financial-statements-presentation";
import type { StatementCompleteness, UnclassifiedAccount } from "@/lib/financial-statements";

/**
 * Balans/W&V PR 4 — de waarschuwingen die bij een jaarrekeningrapport horen.
 *
 * Niet-geclassificeerde activiteit wordt nooit verborgen: ze krijgt een eigen,
 * volledig zichtbare sectie met rekening, bedrag en reden, plus een link naar
 * het rekeningschema waar de classificatie wordt ingevuld.
 */

export function StatementCompletenessNotice({ completeness }: { completeness: StatementCompleteness }) {
  const presentation = COMPLETENESS_PRESENTATION[completeness];
  if (completeness === "complete") return null;
  return (
    <Alert
      variant={presentation.tone === "warning" ? "destructive" : "default"}
      data-testid="statement-completeness-notice"
      data-completeness={completeness}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{presentation.label}</AlertTitle>
      <AlertDescription>{presentation.description}</AlertDescription>
    </Alert>
  );
}

export function OpeningBalanceContributionNotice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <Alert data-testid="statement-opening-contribution">
      <Info className="h-4 w-4" />
      <AlertTitle>Beginbalans in deze periode</AlertTitle>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );
}

export interface UnclassifiedSectionProps {
  accounts: readonly UnclassifiedAccount[];
  /** Welk bedrag telt voor dit rapport: eindsaldo (balans) of mutatie (W&V). */
  amountOf: (account: UnclassifiedAccount) => number;
  testId?: string;
}

export function UnclassifiedSection({ accounts, amountOf, testId = "statement-unclassified" }: UnclassifiedSectionProps) {
  if (accounts.length === 0) return null;
  // Rekeningen zonder enige beweging maken het rapport niet onvolledig — de
  // engine rekent ze ook niet mee voor de volledigheidsstatus. Ze blijven wel
  // zichtbaar (ze wachten op classificatie), maar dan zonder alarm, zodat een
  // groene badge en een rode waarschuwing elkaar nooit tegenspreken.
  const heeftActiviteit = accounts.some((a) => a.hasActivity);
  return (
    <div className="space-y-3" data-testid={testId}>
      <Alert
        variant={heeftActiviteit ? "destructive" : "default"}
        data-testid="statement-unclassified-warning"
        data-has-activity={heeftActiviteit ? "true" : "false"}
      >
        {heeftActiviteit ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
        <AlertTitle>Niet geclassificeerd</AlertTitle>
        <AlertDescription>
          <p>
            {heeftActiviteit
              ? UNCLASSIFIED_WARNING
              : "Deze rekeningen zijn nog niet geclassificeerd. Ze hebben in deze periode geen beweging, dus het rapport blijft volledig."}
          </p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link to="/grootboek">Naar het rekeningschema</Link>
          </Button>
        </AlertDescription>
      </Alert>

      {/* Altijd uitgeklapt: deze rijen mogen niet weg te klikken zijn. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <Table className="min-w-[620px]">
          <caption className="sr-only">
            Grootboekrekeningen met activiteit die geen plaats in dit rapport hebben, met reden.
          </caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="px-3 py-1.5 w-20">Rekening</TableHead>
              <TableHead scope="col" className="px-3 py-1.5 min-w-[180px]">Omschrijving</TableHead>
              <TableHead scope="col" className="px-3 py-1.5 w-36 text-right">Bedrag</TableHead>
              <TableHead scope="col" className="px-3 py-1.5 min-w-[200px]">Reden</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow
                key={a.accountId}
                data-testid="statement-unclassified-row"
                data-account-id={a.accountId}
                className="focus-within:bg-muted/40 hover:bg-muted/40"
              >
                <TableCell className="px-3 py-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {a.accountNumber ?? "—"}
                </TableCell>
                {/* Bewust géén truncate: dit is de tabel die zegt wat er nog
                    moet gebeuren, dus de omschrijving moet leesbaar zijn — ook
                    op een touchscreen, waar een title-tooltip niet bestaat. */}
                <TableCell className="px-3 py-1.5">
                  <Link
                    to={`/grootboek/saldi/${a.accountId}`}
                    className="rounded-sm break-words underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Open mutaties van ${accountLabel(a.accountNumber, a.accountName)}`}
                  >
                    {a.accountName}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-sm tabular-nums">
                  {formatCents(amountOf(a))}
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  <Badge variant="outline" className="whitespace-normal text-left text-xs font-normal" data-reason={a.reason}>
                    {UNCLASSIFIED_REASON_LABELS[a.reason]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Fail-closed: de kern of de engine sluit niet, dus er komen geen cijfers. */
export function StatementFailureNotice({ failures }: { failures: readonly string[] }) {
  return (
    <Alert variant="destructive" data-testid="statement-failed">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Rapport kan niet worden opgebouwd</AlertTitle>
      <AlertDescription>
        <p>
          De boekingscontrole sluit niet, dus de cijfers zijn niet betrouwbaar. Er wordt daarom geen
          balans of resultaat getoond.
        </p>
        <ul className="mt-2 list-disc pl-5 text-xs">
          {failures.map((f) => (
            <li key={f}>{FAILURE_LABELS[f] ?? f}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

const FAILURE_LABELS: Record<string, string> = {
  kernel_not_ok: "De zelfcontrole van de rapportagekern is niet doorstaan.",
  coverage_mismatch: "Niet elke rekening is precies één keer ingedeeld.",
  ledger_closing_sum_not_zero: "De eindsaldi over alle rekeningen tellen niet op tot nul.",
  pnl_net_result_mismatch: "Het nettoresultaat komt niet overeen met de periodemutatie.",
  balance_identity_broken: "De balans sluit niet in de tekenconventie van het grootboek.",
  presented_identity_broken: "Het gepresenteerde balansverschil klopt niet met het niet-geclassificeerde deel.",
  current_year_result_mismatch: "De resultaatregel komt niet overeen met de winst-en-verliesrekening.",
};
