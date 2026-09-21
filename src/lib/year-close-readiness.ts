import type { DiagnosticSeverity } from "./accounting-diagnostics";
import type { DiagnosticCheck, DiagnosticDrilldown, DiagnosticRun, Source } from "./diagnostic-report";

/**
 * Jaarafsluiting — gereedheid. LEZEN, en verder niets.
 *
 * Deze laag sluit geen boekjaar af, boekt geen resultaat en rolt geen
 * beginbalans door. Zij beantwoordt één vraag: *kan dit boekjaar verantwoord
 * worden afgesloten?* — en zij doet dat met bestaande oordelen.
 *
 * ER KOMT GEEN TWEEDE BOEKHOUDING BIJ. Het leeuwendeel van de gereedheid is de
 * bestaande controle (`runDiagnostics`) over precies dit boekjaar: de
 * zelfcontrole van de kern, de kolommenbalans, de integriteit van
 * boekingsgroepen en brondocumenten, de tegenboekingslineage, de
 * jaarrekeningmotor, de classificatie, de beginbalans en het openstaande werk.
 * Daar komen alleen de dingen bij die uitsluitend over een BOEKJAAR gaan en die
 * de controle dus niet kent: is dit jaar al afgesloten, mag het in deze
 * volgorde, en is er in dit jaar überhaupt geboekt.
 *
 * ÉÉN ERNSTLADDER, de bestaande: `ok` | `warning` | `error` uit
 * `accounting-diagnostics.ts`. De status hieronder is geen tweede ladder maar
 * een samenvatting ervan.
 *
 * KALENDERJAAR. Boekjaar N is in dit product kalenderjaar N, en dat is geen
 * aanname: elke schrijver leidt `boekjaar` af als `EXTRACT(YEAR FROM <datum>)`,
 * `clients` kent geen begin van een boekjaar, en de beginbalansmigratie zegt
 * het met zoveel woorden ("Broken fiscal years are NOT supported in v1").
 * Zolang dat zo is, rekent deze laag met kalenderjaren en beweert zij niets
 * anders.
 */

export type YearCloseStatus = "ready" | "warning" | "blocked" | "incomplete";

export type YearCloseCheckId = "year_already_closed" | "year_order" | "year_activity";

/** Dezelfde vorm als een diagnostische controle, met een eigen sleutelruimte. */
export interface YearCloseCheck extends Omit<DiagnosticCheck, "id"> {
  id: YearCloseCheckId;
}

export type ReadinessCheck = DiagnosticCheck | YearCloseCheck;

export interface YearCloseReadiness {
  clientId: string;
  fiscalYear: number;
  status: YearCloseStatus;
  checks: readonly ReadinessCheck[];
  /** Bronnen die niet geladen konden worden; vult `status: "incomplete"`. */
  unavailable: readonly string[];
  summary: { executed: number; passed: number; warnings: number; blocking: number };
}

export interface YearCloseInput {
  clientId: string;
  fiscalYear: number;
  /** De bestaande controle, gedraaid over exact dit boekjaar. */
  diagnostics: DiagnosticRun;
  /**
   * `clients.afgesloten_boekjaar`: het WATERMERK, niet één specifiek jaar.
   * Elke schrijver weigert met `boekjaar <= afgesloten_boekjaar`, dus alles tot
   * en met dit jaar is dicht. `null` = er is nog niets afgesloten.
   */
  closedThrough: Source<number | null>;
  /** Aantal grootboekregels per boekjaar, over de hele administratie. */
  activityByYear: Source<ReadonlyMap<number, number>>;
}

/** Waar een boekjaar wordt afgesloten staat vandaag één plek: de administratie. */
const NAAR_ADMINISTRATIE: DiagnosticDrilldown = {
  label: "Naar de administratiegegevens",
  to: "/klanten",
};

function telwoord(n: number, enkel: string, meervoud: string): string {
  return `${n} ${n === 1 ? enkel : meervoud}`;
}

/**
 * E1. Is dit boekjaar al afgesloten?
 *
 * Het watermerk sluit ALLES tot en met dat jaar. Een al afgesloten jaar nog
 * eens afsluiten kan niet en hoort dus niet als "gereed" te lezen.
 */
export function yearAlreadyClosed(fiscalYear: number, closedThrough: number | null): YearCloseCheck {
  const basis = { id: "year_already_closed" as const, title: "Afsluitstatus" };
  if (closedThrough !== null && fiscalYear <= closedThrough) {
    return {
      ...basis,
      severity: "error",
      summary: `Boekjaar ${fiscalYear} is al afgesloten; de administratie is dicht tot en met ${closedThrough}.`,
      drilldown: NAAR_ADMINISTRATIE,
    };
  }
  return {
    ...basis,
    severity: "ok",
    summary:
      closedThrough === null
        ? `Boekjaar ${fiscalYear} is nog niet afgesloten; er is voor deze administratie nog geen boekjaar afgesloten.`
        : `Boekjaar ${fiscalYear} is nog niet afgesloten; de administratie is dicht tot en met ${closedThrough}.`,
  };
}

/**
 * E2. Mag dit boekjaar in deze volgorde dicht?
 *
 * `afgesloten_boekjaar` is één integer en elke schrijver toetst met `<=`. Het
 * watermerk op 2026 zetten sluit dus ook 2024 en 2025 — stilzwijgend, en
 * onomkeerbaar voor een append-only grootboek. Liggen er vóór dit jaar nog
 * niet-afgesloten boekjaren MET boekingen, dan is dat geen nette afsluiting
 * maar een sprong, en dat is een blokkade.
 *
 * Een leeg tussenliggend jaar is geen bezwaar: daar valt niets af te sluiten.
 */
export function yearOrder(
  fiscalYear: number,
  closedThrough: number | null,
  activityByYear: ReadonlyMap<number, number>,
): YearCloseCheck {
  const basis = { id: "year_order" as const, title: "Volgorde van afsluiten" };
  const eerdereOpenJaren = [...activityByYear.entries()]
    .filter(([jaar, aantal]) => aantal > 0 && jaar < fiscalYear && (closedThrough === null || jaar > closedThrough))
    .map(([jaar]) => jaar)
    .sort((a, b) => a - b);

  if (eerdereOpenJaren.length === 0) {
    return {
      ...basis,
      severity: "ok",
      summary: `Er liggen geen oudere boekjaren met boekingen meer open vóór ${fiscalYear}.`,
    };
  }
  return {
    ...basis,
    severity: "error",
    count: eerdereOpenJaren.length,
    summary:
      `${telwoord(eerdereOpenJaren.length, "ouder boekjaar", "oudere boekjaren")} met boekingen ` +
      `${eerdereOpenJaren.length === 1 ? "is" : "zijn"} nog niet afgesloten (${eerdereOpenJaren.join(", ")}). ` +
      `Het afsluitveld is één jaartal en sluit alles tot en met dat jaar, dus ${fiscalYear} afsluiten zou ` +
      `${eerdereOpenJaren.length === 1 ? "dat jaar" : "die jaren"} ongemerkt meenemen.`,
    drilldown: NAAR_ADMINISTRATIE,
  };
}

/**
 * F. Is er in dit boekjaar geboekt?
 *
 * "Geen boekingen" is nadrukkelijk NIET "gecontroleerd en compleet". Er is dan
 * niets vastgesteld, en dat hoort een waarschuwing te zijn in plaats van een
 * geruststelling. Dat een bron niet geladen kon worden is weer iets anders en
 * wordt hier niet afgehandeld: dan is er geen `activityByYear` en telt de
 * uitkomst als onvolledig.
 */
export function yearActivity(
  fiscalYear: number,
  activityByYear: ReadonlyMap<number, number>,
): YearCloseCheck {
  const basis = { id: "year_activity" as const, title: "Boekingen in dit boekjaar" };
  const aantal = activityByYear.get(fiscalYear) ?? 0;
  if (aantal > 0) {
    return {
      ...basis,
      severity: "ok",
      count: aantal,
      summary: `Er ${aantal === 1 ? "staat" : "staan"} ${telwoord(aantal, "grootboekregel", "grootboekregels")} in boekjaar ${fiscalYear}.`,
    };
  }
  return {
    ...basis,
    severity: "warning",
    count: 0,
    summary: `Er staat geen enkele grootboekregel in boekjaar ${fiscalYear}. Er is dus niets vastgesteld — dat is iets anders dan een gecontroleerd en compleet jaar.`,
  };
}

/** Blokkades eerst, dan waarschuwingen, dan wat in orde is. */
export const READINESS_SEVERITY_ORDER: readonly DiagnosticSeverity[] = ["error", "warning", "ok"];

export function readinessChecksBySeverity(
  checks: readonly ReadinessCheck[],
  severity: DiagnosticSeverity,
): ReadinessCheck[] {
  return checks.filter((c) => c.severity === severity);
}

/**
 * De gereedheid van één boekjaar.
 *
 * FAIL CLOSED. Kon één verplichte bron niet worden gelezen — of was de
 * onderliggende controle zelf al onvolledig — dan is de status `incomplete` en
 * kan er per constructie nooit "gereed voor afsluiten" uit komen. Pas daarna
 * telt het zwaarste oordeel: een blokkade maakt `blocked`, een waarschuwing
 * maakt `warning`, en alleen een volledig schone uitslag is `ready`.
 *
 * Een waarschuwing is hier BEWUST geen gereedheid. Er bestaat in dit product
 * geen regel die zegt dat open werk of een onvolledige beginbalans een
 * afsluiting toestaat, en die zou ik hier niet moeten verzinnen.
 */
export function evaluateYearClose(input: YearCloseInput): YearCloseReadiness {
  const checks: ReadinessCheck[] = [...input.diagnostics.checks];
  const ontbreekt: string[] =
    input.diagnostics.ok === false ? [...input.diagnostics.unavailable] : [];

  const closedThrough = input.closedThrough.available === true ? input.closedThrough.value : null;
  if (input.closedThrough.available === true) {
    checks.push(yearAlreadyClosed(input.fiscalYear, closedThrough));
  } else {
    ontbreekt.push(input.closedThrough.label);
  }

  if (input.activityByYear.available === true) {
    // De volgordecontrole heeft BEIDE bronnen nodig: zonder watermerk is niet
    // vast te stellen welk ouder jaar nog open staat, en dan wordt er niets
    // over beweerd.
    if (input.closedThrough.available === true) {
      checks.push(yearOrder(input.fiscalYear, closedThrough, input.activityByYear.value));
    }
    checks.push(yearActivity(input.fiscalYear, input.activityByYear.value));
  } else {
    ontbreekt.push(input.activityByYear.label);
  }

  let passed = 0;
  let warnings = 0;
  let blocking = 0;
  for (const check of checks) {
    if (check.severity === "ok") passed++;
    else if (check.severity === "warning") warnings++;
    else blocking++;
  }

  const status: YearCloseStatus =
    ontbreekt.length > 0 ? "incomplete"
      : blocking > 0 ? "blocked"
        : warnings > 0 ? "warning"
          : "ready";

  return {
    clientId: input.clientId,
    fiscalYear: input.fiscalYear,
    status,
    checks,
    unavailable: ontbreekt,
    summary: { executed: checks.length, passed, warnings, blocking },
  };
}

/**
 * Elke boekjaar met minstens één grootboekregel, geteld uit de opgeslagen
 * `boekjaar`-kolom — niet uit `posting_date`, want het grootboek draagt het
 * boekjaar expliciet en dát is het veld waarop elke schrijver toetst.
 */
export function activityByBoekjaar(
  rows: readonly { boekjaar: number | null }[],
): Map<number, number> {
  const per = new Map<number, number>();
  for (const row of rows) {
    if (row.boekjaar === null || row.boekjaar === undefined) continue;
    per.set(row.boekjaar, (per.get(row.boekjaar) ?? 0) + 1);
  }
  return per;
}
