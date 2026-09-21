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
 * bestaande controle (`runDiagnostics`). LET OP: die uitkomst is NIET in haar
 * geheel jaargebonden — zie `CHECK_SCOPE` hieronder. Wat over het gekozen jaar
 * (of de periode ervóór) gaat, bepaalt de gereedheid:
 * zelfcontrole van de kern, de kolommenbalans, de integriteit van
 * boekingsgroepen en brondocumenten, de tegenboekingslineage, de
 * jaarrekeningmotor, de classificatie en de beginbalans. Wat administratiebreed
 * is — de integriteitscontrole, de tegenboekingslineage en het openstaande werk
 * per bron — blijft zichtbaar maar bepaalt niets, want een bevinding uit een
 * later boekjaar bewijst niets over dit boekjaar.
 *
 * Daar komen de dingen bij die uitsluitend over een BOEKJAAR gaan en die de
 * controle niet kent: is dit jaar al afgesloten, mag het in deze volgorde, is
 * er in dit jaar überhaupt geboekt, en — het onomkeerbare — blijft er postbaar
 * bronwerk achter dat door het afsluiten onboekbaar wordt.
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

/**
 * DE SCOPE VAN ELKE CONTROLE, één keer vastgelegd.
 *
 * Dit is de correctie op een fout in PR 1: daar werd de héle uitkomst van
 * `runDiagnostics()` behandeld alsof zij over het gekozen boekjaar ging. Dat is
 * niet zo, en het gevolg was onzin — een openstaande factuur uit 2027 of een
 * tegenboekingsbevinding uit een later jaar maakte 2026 "niet gereed", terwijl
 * daar geen enkele boekhoudkundige regel voor bestaat.
 *
 *   selected_year       — uitsluitend [1 jan, 1 jan volgend jaar) van het
 *                         gekozen boekjaar.
 *   cumulative          — alles tot en met het einde van het gekozen boekjaar.
 *                         De rijen komen uit `useLedgerPostings({period})`, dat
 *                         filtert op `posting_date < toExclusive`; een later
 *                         boekjaar kan er dus per constructie niet in zitten.
 *   administration_wide — alle jaren, zonder jaartoerekening.
 *
 * Alleen de eerste twee bepalen de gereedheid van het gekozen jaar. De derde
 * blijft volledig zichtbaar — verzwijgen zou erger zijn — maar bepaalt niets,
 * want een bevinding uit een later jaar bewijst niets over dit jaar.
 */
export type CheckScope = "selected_year" | "cumulative" | "administration_wide";

export const CHECK_SCOPE: Readonly<Record<string, CheckScope>> = {
  // A — uitsluitend het gekozen boekjaar.
  period_balance: "selected_year",
  opening_balance_status: "selected_year",
  year_already_closed: "selected_year",
  year_order: "selected_year",
  year_activity: "selected_year",
  unposted_work: "selected_year",

  // B — tot en met het einde van het gekozen boekjaar. Dit is de juiste scope
  //     voor een afsluiting: wat vóór of in dit jaar ligt telt mee, wat erna
  //     komt niet, en de kern controleert daarbinnen ook de boekingsgroepen.
  ledger_self_check: "cumulative",
  opening_balance_totals: "cumulative",
  trial_balance: "cumulative",
  statements: "cumulative",
  classification: "cumulative",
  subgroups: "cumulative",

  // C — administratiebreed, zonder jaartoerekening.
  //
  //     `posting_groups`, `source_documents` en `integrity_other` komen uit
  //     `evaluateLedgerIntegrity()`, dat geen periode kent en waarvan de
  //     bevindingen geen boekjaar dragen: `factuur_zonder_regels` verwijst naar
  //     een factuur en niet naar een boekingsgroep, dus er bestaat geen
  //     uniforme toerekening.
  //
  //     `reversal_integrity` is bewust over alle jaren (een tegenboeking mag in
  //     een ander jaar landen dan haar origineel) en een bevinding beslaat vaak
  //     juist twee boekjaren tegelijk. Toerekenen aan één jaar zou een keuze
  //     zijn die de gegevens niet dragen.
  //
  //     Wat dit NIET betekent: dat een kapotte boekingsgroep binnen dit
  //     boekjaar ongemerkt blijft. De zelfcontrole van de kern draait over
  //     precies de afsluitscope en meldt `group_unbalanced` daar wél — die
  //     controle is `cumulative` en blokkeert dus gewoon.
  posting_groups: "administration_wide",
  source_documents: "administration_wide",
  integrity_other: "administration_wide",
  reversal_integrity: "administration_wide",
  bank_outstanding: "administration_wide",
};

export function scopeOf(checkId: string): CheckScope {
  // Onbekend? Dan telt hij mee voor de gereedheid. Een nieuwe controle die
  // hier niet is ingedeeld moet opvallen door te streng te zijn, niet door
  // stilletjes buiten de beoordeling te vallen.
  return CHECK_SCOPE[checkId] ?? "cumulative";
}

export function scopeGates(scope: CheckScope): boolean {
  return scope !== "administration_wide";
}

// ── Openstaand bronwerk, met zijn ECHTE boekhoudkundige datum ──────────────

export type UnpostedWorkSource =
  | "purchase_invoice"
  | "sales_invoice"
  | "bank_allocation"
  | "manual_journal";

export interface UnpostedWorkItem {
  source: UnpostedWorkSource;
  id: string;
  /**
   * Boekjaar uit de boekhoudkundige datum van de bron — factuurdatum,
   * transactiedatum of boekingsdatum. NOOIT uit `created_at`: wanneer een rij
   * is aangemaakt zegt niets over het jaar waarin zij hoort. `null` betekent
   * dat de datum ontbreekt en het jaar dus niet is vast te stellen.
   */
  boekjaar: number | null;
}

export interface UnpostedWorkBuckets {
  /** Postbaar, nog niet geboekt, met een boekjaar t/m het gekozen jaar. */
  throughYear: number;
  /** Idem, maar ná het gekozen boekjaar: raakt deze afsluiting niet. */
  afterYear: number;
  /** Geen boekhoudkundige datum: niet in te delen. */
  unknownYear: number;
}

export function bucketUnpostedWork(
  items: readonly UnpostedWorkItem[],
  fiscalYear: number,
): UnpostedWorkBuckets {
  let throughYear = 0;
  let afterYear = 0;
  let unknownYear = 0;
  for (const item of items) {
    if (item.boekjaar === null || item.boekjaar === undefined) unknownYear++;
    else if (item.boekjaar <= fiscalYear) throughYear++;
    else afterYear++;
  }
  return { throughYear, afterYear, unknownYear };
}

export type YearCloseStatus = "ready" | "warning" | "blocked" | "incomplete";

export type YearCloseCheckId =
  | "year_already_closed"
  | "year_order"
  | "year_activity"
  | "unposted_work";

/** Dezelfde vorm als een diagnostische controle, met een eigen sleutelruimte. */
export interface YearCloseCheck extends Omit<DiagnosticCheck, "id"> {
  id: YearCloseCheckId;
}

export type ReadinessCheck = DiagnosticCheck | YearCloseCheck;

export interface YearCloseReadiness {
  clientId: string;
  fiscalYear: number;
  status: YearCloseStatus;
  /** De controles die de gereedheid van DIT boekjaar bepalen. */
  checks: readonly ReadinessCheck[];
  /**
   * Administratiebrede bevindingen: volledig zichtbaar, maar zonder
   * jaartoerekening en dus zonder invloed op de status van dit boekjaar.
   */
  administrationWide: readonly ReadinessCheck[];
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
  /** Postbaar, nog niet geboekt bronwerk mét zijn boekhoudkundige datum. */
  unpostedWork: Source<readonly UnpostedWorkItem[]>;
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

/**
 * G. Postbaar bronwerk dat door dít afsluiten onboekbaar zou worden.
 *
 * Dit is GEEN nieuwe boekhoudregel maar het gevolg van een bestaande: elke
 * schrijver weigert met `v_boekjaar <= v_client.afgesloten_boekjaar`. Zet het
 * watermerk op het gekozen jaar, dan is elk postbaar-maar-nog-niet-geboekt
 * document met een boekjaar t/m dat jaar voorgoed onboekbaar — en dat is
 * precies het soort onomkeerbaarheid dat een afsluitcontrole hoort te
 * voorkomen. Daarom een blokkade, en niet de waarschuwing die `outstandingWork`
 * (administratiebreed, zonder jaar) voor hetzelfde werk geeft.
 *
 * Werk ná het gekozen boekjaar raakt deze afsluiting niet en blokkeert dus
 * niets; het wordt alleen benoemd zodat niemand denkt dat het is meegewogen.
 *
 * Kan het boekjaar van een document niet worden vastgesteld, dan wordt er geen
 * uitspraak gedaan: de beller maakt daar `incomplete` van.
 */
export function unpostedWorkThroughYear(
  fiscalYear: number,
  buckets: UnpostedWorkBuckets,
): YearCloseCheck {
  const basis = { id: "unposted_work" as const, title: "Nog te boeken brondocumenten" };
  const achteraf =
    buckets.afterYear > 0
      ? ` (${telwoord(buckets.afterYear, "document", "documenten")} valt in een later boekjaar en telt hier niet mee)`
      : "";

  if (buckets.throughYear === 0) {
    return {
      ...basis,
      severity: "ok",
      summary: `Er staat geen postbaar brondocument meer open met boekjaar t/m ${fiscalYear}${achteraf}.`,
    };
  }
  return {
    ...basis,
    severity: "error",
    count: buckets.throughYear,
    summary:
      `${telwoord(buckets.throughYear, "postbaar brondocument is", "postbare brondocumenten zijn")} nog niet geboekt ` +
      `met boekjaar t/m ${fiscalYear}. Afsluiten maakt ${buckets.throughYear === 1 ? "dat document" : "die documenten"} ` +
      `voorgoed onboekbaar, want elke schrijver weigert een boekjaar t/m het afsluitjaar${achteraf}.`,
    drilldown: { label: "Naar de inhaalslag", to: "/bank/inhaalslag" },
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
  /*
   * De uitkomst van `runDiagnostics()` wordt hier GESPLITST en niet in haar
   * geheel als jaarscope behandeld. Wat over alle jaren gaat, bepaalt niets
   * over dít boekjaar — maar het verdwijnt evenmin van het scherm.
   */
  const checks: ReadinessCheck[] = [];
  const administrationWide: ReadinessCheck[] = [];
  for (const check of input.diagnostics.checks) {
    (scopeGates(scopeOf(check.id)) ? checks : administrationWide).push(check);
  }

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

  if (input.unpostedWork.available === true) {
    const buckets = bucketUnpostedWork(input.unpostedWork.value, input.fiscalYear);
    // FAIL CLOSED: een document waarvan het boekjaar niet is vast te stellen
    // kan niet worden ingedeeld, en dan is de controle onvolledig — niet
    // "gereed". Een datumloos document stilletjes bij "later" rekenen zou
    // precies de fout zijn die deze hele correctie moet wegnemen.
    if (buckets.unknownYear > 0) {
      ontbreekt.push(`Boekjaar van ${buckets.unknownYear} brondocument(en)`);
    }
    checks.push(unpostedWorkThroughYear(input.fiscalYear, buckets));
  } else {
    ontbreekt.push(input.unpostedWork.label);
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
    administrationWide,
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
