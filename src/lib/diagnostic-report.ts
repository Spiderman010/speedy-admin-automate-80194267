import type { DiagnosticSeverity } from "./accounting-diagnostics";
import { severityForIntegrityFinding } from "./accounting-diagnostics";
import type { LedgerIntegrityReport } from "./ledger-integrity";
import type { ReversalIntegrityReport } from "./reversal-integrity";
import type { TrialBalance, TrialBalanceFailure } from "./proef-saldibalans";
import type { LedgerSelfCheckFailure } from "./ledger-reporting";
import type { FinancialStatementsResult, UnclassifiedSummary } from "./financial-statements";
import type { LedgerCompleteness, OpeningBalanceCompleteness } from "./ledger-completeness";
import { UNASSIGNED_SUBGROUP_KEY, type StatementGroupSections } from "./financial-statements-subgroups";

/**
 * Controle-rapport — de compositielaag, niet een tweede boekhouding.
 *
 * DIT BESTAND BEDENKT GEEN ENKELE BOEKHOUDREGEL. Alles wat hier binnenkomt is
 * al geveld door bestaande logica, en die uitspraken worden hier uitsluitend
 * samengevat tot één controle per onderwerp:
 *
 *   • `buildTrialBalance()`            — de zelfcontrole van de kern, plus
 *                                        begin-, periode- en eindbalans;
 *   • `evaluateLedgerIntegrity()`      — de vier integriteitscontroles;
 *   • `buildFinancialStatements()`     — de zeven motorcontroles en de
 *                                        niet-geclassificeerde activiteit;
 *   • `computeOpeningBalanceCompleteness()` — de beginbalanstoestand;
 *   • `computeLedgerCompleteness()`    — openstaand werk per bron;
 *   • `subgroupSectionsFor…()`         — het tweede taxonomieniveau.
 *
 * ER IS ÉÉN ERNSTLADDER, en die staat in `accounting-diagnostics.ts`:
 * `ok` | `warning` | `error`. Die wordt hier hergebruikt en niet vertaald naar
 * een tweede woordenschat — het scherm mag andere wóórden kiezen, maar nooit
 * een andere indeling.
 *
 * FAIL CLOSED IS STRUCTUREEL, geen afspraak. Elke bron komt binnen als
 * `Source<T>`: beschikbaar mét waarde, of niet beschikbaar. Ontbreekt er één,
 * dan is de hele uitkomst `ok: false` en kan er per constructie geen "alles
 * akkoord" uit komen — ook niet wanneer alle overige controles slagen.
 */

/** Eén bron: geladen, of aantoonbaar niet geladen. Nooit stilzwijgend leeg. */
export type Source<T> = { available: true; value: T } | { available: false; label: string };

export function available<T>(value: T): Source<T> {
  return { available: true, value };
}

export function unavailable<T>(label: string): Source<T> {
  return { available: false, label };
}

export type DiagnosticCheckId =
  | "ledger_self_check"
  | "period_balance"
  | "opening_balance_totals"
  | "trial_balance"
  | "posting_groups"
  | "source_documents"
  | "reversal_integrity"
  | "integrity_other"
  | "opening_balance_status"
  | "statements"
  | "classification"
  | "subgroups"
  | "bank_outstanding";

/** Uitsluitend een bestaande route; een verzonnen bestemming is erger dan geen. */
export interface DiagnosticDrilldown {
  label: string;
  to: string;
}

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  title: string;
  severity: DiagnosticSeverity;
  summary: string;
  /** Hele centen, uitsluitend wanneer de onderliggende laag er een gaf. */
  amountCents?: number;
  count?: number;
  drilldown?: DiagnosticDrilldown;
}

export interface DiagnosticRunSummary {
  executed: number;
  passed: number;
  warnings: number;
  blocking: number;
}

export type DiagnosticRun =
  | { ok: true; checks: readonly DiagnosticCheck[]; summary: DiagnosticRunSummary }
  | {
      ok: false;
      /** Wat er niet geladen kon worden; de controle is hierdoor onvolledig. */
      unavailable: readonly string[];
      checks: readonly DiagnosticCheck[];
      summary: DiagnosticRunSummary;
    };

export interface DiagnosticRunInput {
  trialBalance: Source<TrialBalance>;
  integrity: Source<LedgerIntegrityReport>;
  /** De tegenboekingslineage; `unavailable` zodra de markertabel niet leesbaar is. */
  reversals: Source<ReversalIntegrityReport>;
  statements: Source<FinancialStatementsResult>;
  openingBalance: Source<OpeningBalanceCompleteness>;
  completeness: Source<LedgerCompleteness>;
  /** De secties van beide overzichten samen; leeg is een geldige uitkomst. */
  subgroupSections: Source<readonly StatementGroupSections[]>;
}

// ── Hulpjes ────────────────────────────────────────────────────────────────

function failuresOfKind<K extends TrialBalanceFailure["kind"]>(
  tb: TrialBalance,
  kind: K,
): Extract<TrialBalanceFailure, { kind: K }>[] {
  if (tb.ok === true) return [];
  return tb.failures.filter((f): f is Extract<TrialBalanceFailure, { kind: K }> => f.kind === kind);
}

/**
 * De zelfcontrole van de kern verpakt haar bevindingen in één
 * `{kind:"kernel"}`-fout. Een onbalans komt daar dus IN te zitten, niet naast:
 * faalt de kern, dan rekent `buildTrialBalance()` niet verder en zijn de losse
 * `period_unbalanced` / `opening_unbalanced` van de kolommenbalans nooit
 * gevuld. Wie alleen op dat buitenste niveau kijkt, mist elke echte onbalans —
 * en meldt "in balans" terwijl het grootboek scheef staat.
 */
function kernelFailures(tb: TrialBalance): LedgerSelfCheckFailure[] {
  return failuresOfKind(tb, "kernel").flatMap((f) => f.failures);
}

function telwoord(n: number, enkel: string, meervoud: string): string {
  return `${n} ${n === 1 ? enkel : meervoud}`;
}

// ── De controles, één per onderwerp ────────────────────────────────────────

/**
 * A1. De zelfcontrole van de rapportagekern.
 *
 * `buildTrialBalance()` draait die controle al; hier wordt alleen gelezen of
 * zij is doorstaan. Faalt zij, dan is elk cijfer eronder onbetrouwbaar — dat
 * is een blokkade, geen waarschuwing.
 */
export function ledgerSelfCheck(tb: TrialBalance): DiagnosticCheck {
  const kernel = failuresOfKind(tb, "kernel");
  const mismatch = failuresOfKind(tb, "kernel_mismatch");
  const aantal = kernel.reduce((n, f) => n + f.failures.length, 0) + mismatch.length;
  if (aantal === 0) {
    return {
      id: "ledger_self_check",
      title: "Zelfcontrole grootboek",
      severity: "ok",
      summary: "De rapportagekern controleert zichzelf en die controle is doorstaan.",
    };
  }
  return {
    id: "ledger_self_check",
    title: "Zelfcontrole grootboek",
    severity: "error",
    count: aantal,
    summary: `De zelfcontrole van de rapportagekern is niet doorstaan (${telwoord(aantal, "bevinding", "bevindingen")}). Zolang dit speelt zijn de cijfers niet betrouwbaar.`,
    // NIET naar /grootboek/integriteit: die pagina toont de vier
    // integriteitsregels en kan een gefaalde kernzelfcontrole niet laten zien.
    // De kolommenbalans doet dat wel.
    drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
  };
}

/**
 * A2. Debet en credit binnen de gekozen periode.
 *
 * Dit mag per periode worden gecontroleerd omdat de groepstrigger van 6C-b2
 * één `posting_date` per boekingsgroep afdwingt: een periodegrens kan nooit
 * een journaalpost doormidden knippen. Zie de kop van `ledger-reporting.ts`.
 */
export function periodBalance(tb: TrialBalance): DiagnosticCheck {
  const [kolommen] = failuresOfKind(tb, "period_unbalanced");
  const kern = kernelFailures(tb).find((f) => f.kind === "period_unbalanced");
  const onbalans = kolommen
    ? { debitCents: kolommen.debitCents, creditCents: kolommen.creditCents }
    : kern
      ? { debitCents: kern.periodDebitCents, creditCents: kern.periodCreditCents }
      : null;
  if (!onbalans) {
    return {
      id: "period_balance",
      title: "Debet en credit in de periode",
      severity: "ok",
      summary: "De periodemutaties zijn in balans: debet is gelijk aan credit.",
    };
  }
  return {
    id: "period_balance",
    title: "Debet en credit in de periode",
    severity: "error",
    amountCents: onbalans.debitCents - onbalans.creditCents,
    summary: "De periodemutaties zijn niet in balans; debet en credit lopen uiteen.",
    drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
  };
}

/** A3. De beginsaldi tellen op tot nul — alleen zinvol als er een beginpositie is. */
export function openingBalanceTotals(tb: TrialBalance): DiagnosticCheck {
  const [kolommen] = failuresOfKind(tb, "opening_unbalanced");
  const kern = kernelFailures(tb).find((f) => f.kind === "opening_unbalanced");
  const onbalans = kolommen
    ? { debitCents: kolommen.debitCents, creditCents: kolommen.creditCents }
    : kern
      ? { debitCents: kern.openingCents, creditCents: 0 }
      : null;
  if (!onbalans) {
    return {
      id: "opening_balance_totals",
      title: "Beginsaldi in balans",
      severity: "ok",
      summary: "De beginsaldi tellen op tot nul.",
    };
  }
  return {
    id: "opening_balance_totals",
    title: "Beginsaldi in balans",
    severity: "error",
    amountCents: onbalans.debitCents - onbalans.creditCents,
    summary: "De beginsaldi tellen niet op tot nul.",
    drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
  };
}

/** A4. Sluit de kolommenbalans als geheel? */
export function trialBalanceCloses(tb: TrialBalance): DiagnosticCheck {
  const [onbalans] = failuresOfKind(tb, "closing_unbalanced");
  // Kwam er helemaal geen kolommenbalans uit, dan sluit zij per definitie niet.
  if (!onbalans && tb.ok !== true) {
    return {
      id: "trial_balance",
      title: "Kolommenbalans",
      severity: "error",
      summary: "De kolommenbalans kon niet worden opgebouwd; er komen geen cijfers uit.",
      drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
    };
  }
  if (!onbalans) {
    // "Er viel niets te controleren" is iets anders dan "gecontroleerd en in
    // orde". Een lege administratie mag niet als geruststelling lezen.
    const leeg = tb.ok === true && tb.rows.length === 0;
    return {
      id: "trial_balance",
      title: "Kolommenbalans",
      severity: "ok",
      summary: leeg
        ? "Er is in deze periode niets geboekt; er viel op de kolommenbalans niets te controleren."
        : "Kolommenbalans sluit.",
      drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
    };
  }
  return {
    id: "trial_balance",
    title: "Kolommenbalans",
    severity: "error",
    amountCents: onbalans.debitCents - onbalans.creditCents,
    summary: "De kolommenbalans sluit niet: de eindsaldi tellen niet op tot nul.",
    drilldown: { label: "Naar de kolommenbalans", to: "/overzichten/proef-saldibalans" },
  };
}

/**
 * A5. De integriteitscontrole — ALLE bevindingen, niet een deelverzameling.
 *
 * `evaluateLedgerIntegrity()` levert vier soorten in twee families: die over
 * een boekingsgroep (grootboek) en die over een brondocument (inkoopfactuur).
 * Een eerdere versie filterde hier alleen op `soort === "boekingsgroep"` en
 * liet daarmee `factuur_zonder_regels` vallen — een BLOKKERENDE bevinding die
 * /grootboek/integriteit wél toont. Gevolg: dit rapport zei "alles akkoord"
 * terwijl er een gebroken invariant open stond. Precies wat een controle moet
 * voorkomen.
 *
 * Daarom wordt er nu PARTITIONEERD en niet gefilterd: elke bevinding landt in
 * precies één controle, en wat in geen familie past komt in de restcontrole
 * terecht. Verdwijnen kan niet meer. `integrityChecksCoverAll()` legt dat vast.
 */
const INTEGRITY_FAMILIES = [
  {
    id: "posting_groups" as const,
    title: "Boekingsgroepen",
    soort: "boekingsgroep" as const,
    schoon: "Elke boekingsgroep is sluitend en heeft grootboekregels.",
    onderwerp: { enkel: "boekingsgroep", meervoud: "boekingsgroepen" },
  },
  {
    id: "source_documents" as const,
    title: "Brondocumenten",
    soort: "inkoopfactuur" as const,
    schoon: "Elk goedgekeurd brondocument heeft boekingsregels met een echte grootboekrekening.",
    onderwerp: { enkel: "brondocument", meervoud: "brondocumenten" },
  },
];

function integrityCheck(
  familie: (typeof INTEGRITY_FAMILIES)[number],
  findings: readonly LedgerIntegrityReport["findings"][number][],
): DiagnosticCheck {
  const basis = { id: familie.id, title: familie.title };
  if (findings.length === 0) {
    return { ...basis, severity: "ok", summary: familie.schoon };
  }
  const fouten = findings.filter((f) => severityForIntegrityFinding(f) === "error");
  return {
    ...basis,
    severity: fouten.length > 0 ? "error" : "warning",
    count: findings.length,
    summary:
      (fouten.length > 0
        ? `${telwoord(fouten.length, familie.onderwerp.enkel, familie.onderwerp.meervoud)} met een gebroken invariant.`
        : `${telwoord(findings.length, "aandachtspunt", "aandachtspunten")} bij de ${familie.onderwerp.meervoud}.`) +
      " Deze controle geldt voor de hele administratie, niet alleen voor deze periode.",
    drilldown: { label: "Naar de integriteitscontrole", to: "/grootboek/integriteit" },
  };
}

export function integrityChecks(report: LedgerIntegrityReport): DiagnosticCheck[] {
  const checks = INTEGRITY_FAMILIES.map((familie) =>
    integrityCheck(familie, report.findings.filter((f) => f.reference.soort === familie.soort)),
  );
  // Het vangnet: een bevinding met een onbekende soort mag nooit wegvallen.
  const bekend = new Set(INTEGRITY_FAMILIES.map((f) => f.soort as string));
  const overig = report.findings.filter((f) => !bekend.has(f.reference.soort));
  if (overig.length > 0) {
    const fouten = overig.filter((f) => severityForIntegrityFinding(f) === "error");
    checks.push({
      id: "integrity_other",
      title: "Overige integriteitsbevindingen",
      severity: fouten.length > 0 ? "error" : "warning",
      count: overig.length,
      summary: `${telwoord(overig.length, "bevinding", "bevindingen")} die niet in een bekende categorie valt.`,
      drilldown: { label: "Naar de integriteitscontrole", to: "/grootboek/integriteit" },
    });
  }
  return checks;
}

/** Elke bevinding is precies één keer geteld. Bewijs voor de test. */
export function integrityChecksCoverAll(report: LedgerIntegrityReport): boolean {
  const geteld = integrityChecks(report).reduce((n, c) => n + (c.count ?? 0), 0);
  return geteld === report.findings.length;
}

/**
 * A6. De tegenboekingslineage.
 *
 * `evaluateReversalIntegrity()` velt het oordeel; hier wordt geteld en verder
 * niets. Er wordt NIET gefilterd — niet op soort, niet op referentie, niet op
 * wat dan ook — want elke bevinding is een gebroken invariant. Dat is ook de
 * ernst die `diagnosticsForReversals()` er al aan geeft: alle zes de soorten
 * zijn `error`, want een tegenboeking bestaat of bestaat niet; een "nog te
 * doen"-toestand is er niet.
 *
 * GEEN DOORKLIK, met opzet. De enige pagina die tegenboekingslineage evalueert
 * is de interne console /diagnostics/accounting, en die staat in `App.tsx`
 * gemarkeerd als "geen klantfunctie, geen nav-item". /grootboek/integriteit
 * evalueert tegenboekingen niet — daar zou een verwijzing doodlopen. Een
 * verzonnen bestemming is erger dan geen.
 */
export function reversalIntegrity(report: ReversalIntegrityReport): DiagnosticCheck {
  const basis = { id: "reversal_integrity" as const, title: "Tegenboekingen / correcties" };
  const aantal = report.findings.length;
  if (aantal === 0) {
    return {
      ...basis,
      severity: "ok",
      summary:
        report.reversalCount === 0
          ? "Er zijn in deze administratie geen tegenboekingen; er valt op de lineage niets aan te merken."
          : `Elke tegenboeking verwijst naar haar oorspronkelijke boeking en negeert die exact (${telwoord(report.reversalCount, "tegenboeking", "tegenboekingen")}).`,
    };
  }
  return {
    ...basis,
    severity: "error",
    count: aantal,
    summary:
      `${telwoord(aantal, "bevinding", "bevindingen")} in de tegenboekingslineage. ` +
      "Deze controle geldt voor de hele administratie, niet alleen voor deze periode.",
  };
}

/**
 * Elke bevinding van `evaluateReversalIntegrity()` is precies één keer geteld.
 *
 * Dezelfde belofte als `integrityChecksCoverAll()`, en om dezelfde reden: bij
 * de grootboekintegriteit liet een filter ooit een blokkerende bevinding
 * verdwijnen, waarna het rapport "alles akkoord" meldde. Hier kan dat niet,
 * en deze functie is het bewijs.
 */
export function reversalChecksCoverAll(report: ReversalIntegrityReport): boolean {
  return (reversalIntegrity(report).count ?? 0) === report.findings.length;
}

/**
 * D. De beginbalans. De toestand komt ongewijzigd uit
 * `computeOpeningBalanceCompleteness()`; er wordt hier niets herontworpen en
 * er wordt NOOIT een nihilverklaring afgedwongen. Een ontbrekende beginbalans
 * raakt de volledigheid, niet de juistheid — dus een waarschuwing.
 */
export function openingBalanceStatus(ob: OpeningBalanceCompleteness): DiagnosticCheck {
  const basis = { id: "opening_balance_status" as const, title: "Beginbalans" };
  if (ob.severity === "complete") {
    return { ...basis, severity: "ok", summary: `Beginbalans: ${ob.label.toLowerCase()}.` };
  }
  return {
    ...basis,
    severity: "warning",
    summary:
      ob.note ??
      `Beginbalans: ${ob.label.toLowerCase()}. De geboekte mutaties blijven zichtbaar; alleen de overloop uit eerdere jaren is nog niet vastgesteld.`,
    drilldown: { label: "Naar de beginbalans", to: "/grootboek/beginbalans" },
  };
}

/**
 * E. De jaarrekeningmotor. Faalt zij, dan toont het product zelf al geen
 * cijfers; dat is hier dus een blokkade en geen waarschuwing.
 */
export function statementsBuild(result: FinancialStatementsResult): DiagnosticCheck {
  const basis = { id: "statements" as const, title: "Jaarrekening kan worden opgebouwd" };
  if (result.ok === true) {
    return { ...basis, severity: "ok", summary: "Balans en winst-en-verliesrekening sluiten op het grootboek aan." };
  }
  return {
    ...basis,
    severity: "error",
    count: result.failures.length,
    summary: `De jaarrekening kan niet worden opgebouwd: ${telwoord(result.failures.length, "controle sluit", "controles sluiten")} niet aan.`,
    drilldown: { label: "Naar de balans", to: "/grootboek/balans" },
  };
}

/**
 * B. Rekeningen met beweging zonder volledige rapportageclassificatie.
 *
 * Open werk, geen bederf: de bedragen kloppen en blijven zichtbaar onder "Niet
 * geclassificeerd" — ze hebben alleen nog geen plaats in balans of W&V. Dat is
 * exact de ernst die `accounting-diagnostics.ts` er al aan geeft.
 *
 * Het bedrag komt ongewijzigd uit de motor en wordt hier niet herrekend.
 */
export function classification(unclassified: UnclassifiedSummary): DiagnosticCheck {
  const basis = { id: "classification" as const, title: "Rapportageclassificatie" };
  if (unclassified.withActivityCount === 0) {
    return { ...basis, severity: "ok", summary: "Elke rekening met beweging heeft een plaats in balans of W&V." };
  }
  return {
    ...basis,
    severity: "warning",
    count: unclassified.withActivityCount,
    amountCents: unclassified.closingCents,
    summary: `${telwoord(unclassified.withActivityCount, "rekening met mutaties is", "rekeningen met mutaties zijn")} niet volledig geclassificeerd. De bedragen blijven zichtbaar onder "Niet geclassificeerd".`,
    drilldown: { label: "Naar het rekeningschema", to: "/grootboek" },
  };
}

/**
 * B2. Het tweede taxonomieniveau: wél een categorie, nog geen groep.
 *
 * Alleen zinvol zodra iemand het niveau werkelijk gebruikt. Is er in deze
 * administratie nog geen enkele groep toegekend, dan is "ontbreekt" geen
 * bevinding maar een constatering dat het niveau nog niet in gebruik is — een
 * waarschuwing op elke rekening zou dan alleen ruis zijn.
 *
 * Een ontbrekende groep laat NOOIT een bedrag verdwijnen: de sectie "Nog niet
 * ingedeeld" toont ze gewoon. Daarom een waarschuwing, nooit een blokkade.
 */
export function subgroups(sections: readonly StatementGroupSections[]): DiagnosticCheck {
  const basis = { id: "subgroups" as const, title: "Groepsindeling" };
  const alleSecties = sections.flatMap((g) => g.sections);
  const ingedeeld = alleSecties.filter((s) => s.key !== UNASSIGNED_SUBGROUP_KEY);
  if (ingedeeld.length === 0) {
    return {
      ...basis,
      severity: "ok",
      summary: "Het groepsniveau is in deze administratie nog niet in gebruik.",
    };
  }
  const nietIngedeeld = alleSecties.filter((s) => s.key === UNASSIGNED_SUBGROUP_KEY);
  const regels = nietIngedeeld.reduce((n, s) => n + s.lines.length, 0);
  if (regels === 0) {
    return { ...basis, severity: "ok", summary: "Elke rekening met een categorie heeft ook een groep." };
  }
  return {
    ...basis,
    severity: "warning",
    count: regels,
    summary: `${telwoord(regels, "rekening heeft", "rekeningen hebben")} wel een categorie maar nog geen groep. De bedragen blijven zichtbaar onder "Nog niet ingedeeld".`,
    drilldown: { label: "Naar het rekeningschema", to: "/grootboek" },
  };
}

/**
 * C. Openstaand boekwerk per bron.
 *
 * Uit `computeLedgerCompleteness()`, dat per bron telt hoeveel postbare
 * documenten nog niet geboekt zijn. LET OP: die telling is per ADMINISTRATIE,
 * niet per periode — dat staat ook in de samenvatting, zodat niemand hem voor
 * een periodecijfer aanziet. Een periodegebonden variant vraagt om backend die
 * er nog niet is; zie het PR-verslag.
 */
export function outstandingWork(completeness: LedgerCompleteness): DiagnosticCheck {
  const basis = { id: "bank_outstanding" as const, title: "Nog te boeken documenten" };
  const onbekend = completeness.sources.filter((s) => s.status === "unknown");
  if (onbekend.length > 0) {
    return {
      ...basis,
      severity: "warning",
      count: onbekend.length,
      summary: `Van ${telwoord(onbekend.length, "bron", "bronnen")} is niet vast te stellen of alles geboekt is (hele administratie, niet alleen deze periode).`,
    };
  }
  if (completeness.totalOutstanding === 0) {
    return { ...basis, severity: "ok", summary: "Er staan geen postbare documenten open (hele administratie)." };
  }
  const bronnen = completeness.sources.filter((s) => s.outstanding > 0).map((s) => s.label).join(", ");
  return {
    ...basis,
    severity: "warning",
    count: completeness.totalOutstanding,
    summary: `${telwoord(completeness.totalOutstanding, "document vereist", "documenten vereisen")} nog verwerking (${bronnen}) — hele administratie, niet alleen deze periode.`,
    drilldown: { label: "Naar de inhaalslag", to: "/bank/inhaalslag" },
  };
}

// ── De run ─────────────────────────────────────────────────────────────────

function summarize(checks: readonly DiagnosticCheck[]): DiagnosticRunSummary {
  let passed = 0;
  let warnings = 0;
  let blocking = 0;
  for (const check of checks) {
    if (check.severity === "ok") passed++;
    else if (check.severity === "warning") warnings++;
    else blocking++;
  }
  return { executed: checks.length, passed, warnings, blocking };
}

/**
 * Alle controles die met de beschikbare bronnen uitgevoerd KUNNEN worden,
 * plus een eerlijke uitspraak of de controle volledig was.
 *
 * Ontbreekt één bron, dan is `ok: false`. De controles die wél konden draaien
 * blijven staan — verzwijgen helpt niemand — maar de uitkomst kan per
 * constructie nooit "alles akkoord" luiden.
 */
export function runDiagnostics(input: DiagnosticRunInput): DiagnosticRun {
  const checks: DiagnosticCheck[] = [];
  const ontbreekt: string[] = [];

  if (input.trialBalance.available === true) {
    const tb = input.trialBalance.value;
    checks.push(ledgerSelfCheck(tb), periodBalance(tb), openingBalanceTotals(tb), trialBalanceCloses(tb));
  } else {
    ontbreekt.push(input.trialBalance.label);
  }

  if (input.integrity.available === true) checks.push(...integrityChecks(input.integrity.value));
  else ontbreekt.push(input.integrity.label);

  if (input.reversals.available === true) checks.push(reversalIntegrity(input.reversals.value));
  else ontbreekt.push(input.reversals.label);

  if (input.openingBalance.available === true) checks.push(openingBalanceStatus(input.openingBalance.value));
  else ontbreekt.push(input.openingBalance.label);

  if (input.statements.available === true) {
    const result = input.statements.value;
    checks.push(statementsBuild(result));
    // De niet-geclassificeerde activiteit komt uit dezelfde uitkomst; faalt de
    // motor, dan is die lijst er niet en wordt er ook niets over beweerd.
    if (result.ok === true) checks.push(classification(result.unclassified));
  } else {
    ontbreekt.push(input.statements.label);
  }

  /*
   * De groepsindeling hangt aan de uitkomst van de motor. Faalde die om een
   * BOEKHOUDKUNDIGE reden, dan is de indeling niet te bepalen — maar dat is
   * geen technische storing, en het zou onjuist zijn om hem zo te melden. De
   * motorcontrole hierboven draagt die blokkade al. Er wordt dan dus niets
   * over de indeling beweerd, en de run wordt er niet onvolledig van.
   */
  const motorFaaldeInhoudelijk =
    input.statements.available === true && input.statements.value.ok !== true;
  if (input.subgroupSections.available === true) checks.push(subgroups(input.subgroupSections.value));
  else if (!motorFaaldeInhoudelijk) ontbreekt.push(input.subgroupSections.label);

  if (input.completeness.available === true) checks.push(outstandingWork(input.completeness.value));
  else ontbreekt.push(input.completeness.label);

  const summary = summarize(checks);
  if (ontbreekt.length > 0) return { ok: false, unavailable: ontbreekt, checks, summary };
  return { ok: true, checks, summary };
}

/** Blokkades eerst, dan waarschuwingen, dan wat in orde is. */
export const DIAGNOSTIC_SEVERITY_ORDER: readonly DiagnosticSeverity[] = ["error", "warning", "ok"];

export function checksBySeverity(
  checks: readonly DiagnosticCheck[],
  severity: DiagnosticSeverity,
): DiagnosticCheck[] {
  return checks.filter((c) => c.severity === severity);
}
