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
import { unclassifiedRelevanceFor } from "@/lib/unclassified-attribution";
import type { OpeningBalanceCompleteness } from "@/lib/ledger-completeness";

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

const STATEMENT_WORD: Record<"balans" | "winst_verlies", string> = {
  balans: "balans",
  winst_verlies: "winst-en-verliesrekening",
};

function rekeningen(n: number) {
  return n === 1 ? "één rekening" : `${n} rekeningen`;
}

/**
 * Het overzicht is leeg terwijl er wél grootboekactiviteit is die er thuis
 * hoort of kán horen. Dat is precies de toestand van elke administratie vlak
 * na de classificatiemigratie — die deed bewust geen backfill — en zonder deze
 * melding lijkt het rapport kapot in plaats van onvolledig.
 *
 * De melding is nooit stelliger dan de metadata toestaat: kan de code bewijzen
 * dat de betrokken rekeningen voor dít overzicht bedoeld zijn, dan zegt zij
 * dat; kan zij dat niet, dan noemt zij de activiteit zonder een oorzaak te
 * claimen. Staat álle niet-geclassificeerde activiteit aantoonbaar bij het
 * ándere overzicht, dan verschijnt hier niets.
 *
 * De bedragen zijn niet verdwenen: ze staan verderop onder "Niet
 * geclassificeerd". Deze melding zegt dat, en wijst de weg.
 */
export function NothingClassifiedNotice({
  accounts,
  what,
}: {
  accounts: readonly UnclassifiedAccount[];
  what: "balans" | "winst_verlies";
}) {
  const { relevantCount, undeterminedCount, any } = unclassifiedRelevanceFor(accounts, what);
  if (!any) return null;
  const zeker = relevantCount > 0;
  const woord = STATEMENT_WORD[what];
  // Bewust GEEN bedrag in deze tekst. Het enige totaal dat hier beschikbaar is,
  // is de getekende nettosom van de niet-geclassificeerde rekeningen — en juist
  // in het geval waarvoor deze melding bestaat (niets geclassificeerd) is die
  // per definitie € 0,00: de kern garandeert dat alle eindsaldi optellen tot
  // nul. "3 rekeningen met activiteit (€ 0,00)" leest als "er is niets", het
  // tegenovergestelde van wat hier gezegd moet worden. Het aantal is eerlijk,
  // de bedragen staan per rekening in de tabel hieronder.
  return (
    <Alert
      variant="destructive"
      data-testid="statement-nothing-classified"
      data-statement={what}
      data-relevant={relevantCount}
      data-undetermined={undeterminedCount}
      data-certainty={zeker ? "specifiek" : "onbepaald"}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{zeker ? "Nog geen rekeningen geclassificeerd" : "Activiteit zonder classificatie"}</AlertTitle>
      <AlertDescription>
        {zeker ? (
          <p>
            Geen enkele grootboekrekening met beweging heeft een plaats in deze {woord} gekregen; daarom is dit
            overzicht leeg. {rekeningen(relevantCount)} met beweging {relevantCount === 1 ? "is" : "zijn"} voor
            deze {woord} bedoeld maar nog niet volledig geclassificeerd
            {undeterminedCount > 0
              ? `, en bij ${rekeningen(undeterminedCount)} is nog niet vast te stellen bij welk overzicht ${undeterminedCount === 1 ? "zij" : "ze"} hoort`
              : ""}
            . Alles staat hieronder onder “Niet geclassificeerd”, mét bedrag — de cijfers zijn dus niet verdwenen,
            ze hebben alleen nog geen groep.
          </p>
        ) : (
          <p>
            Dit overzicht is leeg. Er is wel beweging op {rekeningen(undeterminedCount)} zonder
            rapportageclassificatie; zonder ingevuld overzicht of groep is niet vast te stellen of{" "}
            {undeterminedCount === 1 ? "die rekening in deze" : "die rekeningen in deze"} {woord}{" "}
            {undeterminedCount === 1 ? "thuishoort" : "thuishoren"}. De bedragen staan hieronder onder
            “Niet geclassificeerd”.
          </p>
        )}
        <p className="mt-2">
          Ken in het rekeningschema per rekening een rapport en een groep toe; daarna vult dit overzicht zichzelf.
        </p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link to="/grootboek">Rekeningen classificeren</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * De beginbalans is een volledigheidsgegeven, geen zichtbaarheidsvoorwaarde.
 * Ontbreekt hij, dan zijn de getoonde bedragen gewoon de geboekte mutaties —
 * alleen de overloop uit eerdere jaren is dan niet vastgesteld. Dat zeggen we,
 * en we verbergen niets.
 */
export function OpeningBalanceCarryForwardNotice({
  completeness,
}: {
  completeness: OpeningBalanceCompleteness | undefined;
}) {
  if (!completeness) return null;
  if (completeness.severity === "complete") return null;
  return (
    <Alert data-testid="statement-carry-forward" data-ob-state={completeness.state}>
      <Info className="h-4 w-4" />
      <AlertTitle>Beginbalans: {completeness.label}</AlertTitle>
      <AlertDescription>
        {/* De geruststelling staat er ALTIJD. `note` is voor elke niet-complete
            toestand gevuld, dus als fallback zou deze zin nooit verschijnen —
            en juist die zin is de kern: een ontbrekende beginbalans raakt de
            volledigheid, niet de zichtbaarheid. */}
        <p>
          De bedragen in dit overzicht komen uit de geboekte grootboekmutaties en blijven gewoon zichtbaar;
          alleen de overloop uit eerdere jaren is nog niet vastgesteld.
        </p>
        {completeness.note && <p className="mt-1">{completeness.note}</p>}
      </AlertDescription>
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
