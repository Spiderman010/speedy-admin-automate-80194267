import { formatTijdstipNL } from "./opening-balance-utils";
import type { AuditTrailEntry } from "./platform/audit-trail";
import type { YearCloseReadiness } from "./year-close-readiness";

/**
 * Jaarafsluiting PR 2b — de pure laag onder de afsluitknop.
 *
 * DE GRENS, IN ÉÉN ZIN: deze module legt uit, de database beslist.
 *
 * `public.close_fiscal_year(_client_id, _fiscal_year)` is en blijft de
 * autoriteit. Zij herkeurt onder de administratiegrendel de watermerk-
 * consistentie, de afsluitvolgorde, de boekingsgroepen, het openstaande
 * bronwerk en de ontbrekende boekhoudkundige datums, en zij schrijft het
 * onuitwisbare bewijs. Er gaan hier precies twee waarden de deur uit: een
 * administratie-id en een jaartal.
 *
 * Wat hier WEL staat: wanneer de actie mag worden aangeboden, de woorden van de
 * bevestiging, de vertaling van serverfouten naar leesbare tekst, en de opmaak
 * van het afsluitbewijs.
 *
 * WAT HIER NADRUKKELIJK NIET STAAT
 *   • geen resultaatberekening — de afsluiting kent geen bedrag, want er wordt
 *     geen resultaatboeking gemaakt en `year_closures` bewaart geen
 *     `result_cents`;
 *   • geen tweede rechtenladder — `has_min_role()` blijft de bron, deze laag
 *     bepaalt alleen wat er op het scherm wordt aangeboden;
 *   • geen eigen boekhoudkundige acceptatieregel — de gereedheid komt
 *     ongewijzigd uit `evaluateYearClose()` (PR 1).
 */

// ── Het afsluitbewijs ───────────────────────────────────────────────────────

/** Eén rij van public.year_closures. Geen `result_cents`: die bestaat niet. */
export interface YearClosure {
  client_id: string;
  organization_id: string;
  fiscal_year: number;
  closed_at: string;
  closed_by: string;
}

/** Wat `close_fiscal_year()` teruggeeft: het bewijs plus of deze aanroep het maakte. */
export interface YearCloseResult extends YearClosure {
  created: boolean;
}

// ── Mag de actie worden aangeboden? ─────────────────────────────────────────

export type CloseAvailability =
  /** Er is nog geen gereedheidscontrole gedraaid; er valt niets aan te bieden. */
  | { kind: "no_snapshot" }
  /** Er is iets nog niet bekend. Nooit als "mag wel" behandelen. */
  | { kind: "unknown"; reason: string }
  /** Er ligt een geldig afsluitbewijs: het jaar is dicht. */
  | { kind: "already_closed" }
  /** Watermerk zegt dicht, bewijs ontbreekt — de erfenis van vóór PR 2a. */
  | { kind: "inconsistent"; reason: string }
  /** De gereedheid is niet `ready`. */
  | { kind: "not_ready"; reason: string }
  /** De rol is bekend en te laag. */
  | { kind: "not_allowed"; reason: string }
  /** De actie mag worden aangeboden. De RPC blijft de autoriteit. */
  | { kind: "available" };

export interface CloseAvailabilityInput {
  fiscalYear: number;
  /** De vastgezette momentopname; `null` zolang er nog niets is gedraaid. */
  readiness: YearCloseReadiness | null;
  /** Het afsluitbewijs; `null` = aantoonbaar geen. */
  closure: YearClosure | null;
  closurePending: boolean;
  closureUnavailable: boolean;
  /** `clients.afgesloten_boekjaar`; `undefined` = nog onbekend. */
  watermark: number | null | undefined;
  /** `undefined` = nog onbekend, en dat telt als niet toegestaan. */
  canClose: boolean | undefined;
  roleUnavailable: boolean;
}

const NOT_READY_REASON: Record<YearCloseReadiness["status"], string> = {
  ready: "",
  warning:
    "Er staat nog open werk. Dit product kent geen regel die zegt dat een boekjaar met open werk toch mag worden afgesloten, dus afsluiten wordt hier niet aangeboden.",
  blocked: "Er is een blokkade. Los die eerst op; daarna kan de controle opnieuw.",
  incomplete:
    "De controle is niet volledig uitgevoerd, dus er is niet vastgesteld dát dit jaar afgesloten kan worden.",
};

export const INCONSISTENT_CLOSURE_REASON =
  "Dit boekjaar staat al als afgesloten geregistreerd, maar er ontbreekt een afsluitbewijs uit de nieuwe " +
  "jaarafsluiting. De administratie kan niet automatisch opnieuw worden afgesloten.";

export const INCONSISTENT_CLOSURE_ADVICE = "Controleer deze administratie voordat u verdergaat.";

/**
 * De volgorde is bewust.
 *
 * Eerst "weet ik het wel zeker", dan de toestand van het BOEKJAAR, en pas
 * daarna de gereedheid en de rol. Een jaar dat al dicht is, is dicht — ook als
 * iemand de gereedheidscontrole er daarna nog een keer overheen draait. Zou de
 * gereedheid eerst komen, dan kon een afgesloten jaar opnieuw een afsluitknop
 * krijgen zodra de controle toevallig `ready` opleverde.
 */
export function closeAvailability(input: CloseAvailabilityInput): CloseAvailability {
  if (input.closureUnavailable) {
    return { kind: "unknown", reason: "Het afsluitbewijs kon niet worden opgehaald. Ververs de pagina." };
  }
  if (input.closure !== null) {
    return { kind: "already_closed" };
  }
  // Geen bewijs, maar het watermerk zegt wél dicht. Dat is de productietoestand
  // van administraties waarvan `afgesloten_boekjaar` vóór PR 2a met de hand is
  // gezet. De database weigert hier fail-closed; het scherm zegt het vooraf.
  if (
    input.watermark !== undefined &&
    input.watermark !== null &&
    input.fiscalYear <= input.watermark
  ) {
    return { kind: "inconsistent", reason: INCONSISTENT_CLOSURE_REASON };
  }
  // Vóór de eerste gereedheidscontrole valt er niets aan te bieden en niets uit
  // te leggen. Dat staat hier bewust NA de toestand van het boekjaar zelf — een
  // al afgesloten jaar hoort ook zonder controle meteen zichtbaar te zijn — maar
  // vóór alles wat nog aan het laden is, zodat een leeg scherm niet volloopt met
  // "wordt opgehaald…" over een actie waar nog niemand om heeft gevraagd.
  if (input.readiness === null) {
    return { kind: "no_snapshot" };
  }
  if (input.closurePending) {
    return { kind: "unknown", reason: "Afsluitstatus wordt opgehaald…" };
  }
  if (input.readiness.status !== "ready") {
    return { kind: "not_ready", reason: NOT_READY_REASON[input.readiness.status] };
  }
  if (input.roleUnavailable) {
    return { kind: "unknown", reason: "Rechten konden niet worden gecontroleerd; ververs de pagina." };
  }
  if (input.canClose === undefined) {
    return { kind: "unknown", reason: "Rechten worden gecontroleerd…" };
  }
  if (input.canClose !== true) {
    return { kind: "not_allowed", reason: "Alleen een accountant kan een boekjaar definitief afsluiten." };
  }
  return { kind: "available" };
}

// ── De woorden ──────────────────────────────────────────────────────────────

export const CLOSE_ACTION_LABEL = "Boekjaar definitief afsluiten";
export const CLOSE_CONFIRM_LABEL = "Definitief afsluiten";
export const CLOSE_PENDING_LABEL = "Bezig met afsluiten…";
export const CLOSE_DIALOG_TITLE = "Boekjaar definitief afsluiten";

export const CLOSED_HEADING = "Boekjaar afgesloten";
export const CLOSED_EXPLANATION =
  "Dit boekjaar is afgesloten en staat vast. Correcties horen in een later, nog open boekjaar.";

export const ALREADY_CLOSED_NOTICE =
  "Dit boekjaar was al afgesloten. Het bestaande afsluitbewijs is geladen.";

/** Wat er ontbreekt, blijft ontbreken: er wordt nooit een waarde verzonnen. */
export const NOT_RECORDED = "Niet vastgelegd";

export function closeDialogExplanation(clientName: string, fiscalYear: number): string {
  return `U sluit boekjaar ${fiscalYear} van ${clientName} definitief af. Deze stap kan niet ongedaan worden gemaakt.`;
}

/**
 * De gevolgen in gewone woorden.
 *
 * Bewust geen architectuurtaal: geen watermerk, geen marker, geen
 * presentatieregel. Wat er staat is wat een accountant morgen merkt.
 */
export function closeConsequences(fiscalYear: number): readonly string[] {
  return [
    `Na afsluiten kunnen geen nieuwe boekingen of tegenboekingen meer worden gemaakt met een datum in boekjaar ${fiscalYear}.`,
    "Alle bestaande boekingen blijven ongewijzigd staan; er wordt niets verwijderd of herschreven.",
    "Er wordt geen resultaatboeking gemaakt: het resultaat blijft zoals de balans het al toont.",
    "Er wordt geen beginbalans voor het volgende boekjaar geboekt; die volgt uit het grootboek zelf.",
    "Correcties kunt u daarna alleen nog maken in een later boekjaar dat nog open staat.",
    `Boekjaar ${fiscalYear} kan hierna niet meer worden heropend.`,
  ];
}

// ── Het bewijs op het scherm ────────────────────────────────────────────────

export interface ReceiptInput {
  closure: YearClosure;
  clientName: string;
  /** De ingelogde gebruiker, om `closed_by` VEILIG te kunnen benoemen. */
  currentUserId: string | undefined;
}

/**
 * De regels van het afsluitbewijs.
 *
 * OVER `closed_by`. Dit leesmodel kent geen gebruikersnamen — er is geen
 * profieltabel die de app hier leest, en `auth.users` is voor de client
 * onzichtbaar. Een rauwe uuid tonen is geen informatie maar ruis, en een naam
 * verzinnen mag niet. Er blijft daarom precies één veilige uitspraak over: is
 * het de ingelogde gebruiker zelf, dan staat dat er; is het iemand anders, dan
 * valt de regel wég (geen `fallback` in het blok) in plaats van een halve
 * waarheid te tonen.
 *
 * Er staat GEEN bedrag op dit bewijs. `year_closures` bewaart geen
 * `result_cents`, dus er valt niets te tonen dat het afsluitresultaat zou
 * heten — en een berekening erbij verzinnen zou precies de tweede
 * boekhoudmotor opleveren die PR 2a bewust heeft vermeden.
 */
export function closureReceiptEntries(input: ReceiptInput): AuditTrailEntry[] {
  const { closure } = input;
  const eigenAfsluiting =
    input.currentUserId !== undefined && input.currentUserId === closure.closed_by;

  return [
    { label: "Administratie", value: input.clientName, testId: "afsluitbewijs-administratie" },
    {
      label: "Boekjaar",
      value: String(closure.fiscal_year),
      valueClassName: "font-mono tabular-nums",
      testId: "afsluitbewijs-boekjaar",
    },
    {
      label: "Afgesloten op",
      value: formatTijdstipNL(closure.closed_at),
      valueClassName: "font-mono tabular-nums",
      testId: "afsluitbewijs-tijdstip",
    },
    {
      label: "Afgesloten door",
      value: eigenAfsluiting ? "U zelf" : null,
      testId: "afsluitbewijs-actor",
    },
  ];
}

// ── Serverfouten ────────────────────────────────────────────────────────────

export type YearCloseErrorKind =
  /** Watermerk zegt dicht, bewijs ontbreekt. Fail closed; nooit automatisch herstellen. */
  | "inconsistent_closure"
  /** Bewijs bestaat, watermerk staat er niet op. Ook fail closed. */
  | "inconsistent_watermark"
  | "year_order"
  | "unbalanced_group"
  | "unposted_work"
  | "missing_date"
  | "permission"
  | "unavailable"
  | "schema"
  | "network"
  | "unknown";

export interface ClassifiedYearCloseError {
  kind: YearCloseErrorKind;
  code: string;
  message: string;
  /** Extra regel onder de melding, wanneer de gebruiker iets moet doen. */
  advice?: string;
}

const SCHEMA_CODES = new Set(["PGRST002", "PGRST204", "PGRST205", "42P01", "42883"]);

/** Ziet dit eruit als onvertaalde PostgreSQL-tekst in plaats van onze eigen melding? */
function looksLikeRawPostgres(message: string): boolean {
  return (
    message === "" ||
    /^(ERROR|FATAL):/i.test(message) ||
    /violates|constraint|relation ".*" does not exist|permission denied|null value in column/i.test(message)
  );
}

const GENERIC_FALLBACK = "Het afsluiten is niet gelukt. Probeer het opnieuw.";

export const UNKNOWN_OUTCOME_MESSAGE =
  "De verbinding viel weg terwijl het afsluiten liep. Het is nu niet bekend of het boekjaar is afgesloten; " +
  "probeer het niet opnieuw voordat dat is vastgesteld.";

/**
 * De meldingen van `close_fiscal_year()` zijn al Nederlands en precies. De zes
 * boekhoudkundige weigeringen delen echter allemaal SQLSTATE 23514, dus de
 * soort volgt uit de tekst.
 *
 * DE VOLGORDE IS LOAD-BEARING: "boekhoudkundige datum onbekend" bevat zélf de
 * woorden "postbaar brondocument", dus die test moet vóór het openstaande werk
 * komen. Andersom zou een datumloos document als "nog te boeken werk" worden
 * gepresenteerd en zou de accountant gaan zoeken naar iets wat hij niet vindt.
 */
export function classifyYearCloseError(error: unknown): ClassifiedYearCloseError {
  const err = (error ?? {}) as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";
  const toonbaar = looksLikeRawPostgres(raw) ? "" : raw;

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return {
      kind: "schema",
      code,
      message: "Afsluiten is nog niet beschikbaar in deze omgeving. Probeer het later opnieuw.",
    };
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return { kind: "network", code: code || "netwerk", message: UNKNOWN_OUTCOME_MESSAGE };
  }
  if (code === "PGRST301" || /jwt expired|invalid jwt/i.test(raw)) {
    return { kind: "permission", code: code || "PGRST301", message: "Uw sessie is verlopen. Log opnieuw in." };
  }
  if (code === "42501") {
    // De schrijver kent hier twee gevallen: "niet beschikbaar" (bestaat niet
    // óf niet van u — bewust niet te onderscheiden) en "accountant vereist".
    if (/niet beschikbaar/i.test(raw)) {
      return {
        kind: "unavailable",
        code,
        message: "Deze administratie is niet beschikbaar. Controleer of u de juiste administratie hebt geopend.",
      };
    }
    return {
      kind: "permission",
      code,
      message: "Alleen een accountant kan een boekjaar definitief afsluiten.",
    };
  }
  if (code === "23514") {
    if (/geen bijbehorend afsluitbewijs/i.test(raw)) {
      return {
        kind: "inconsistent_closure",
        code,
        message: INCONSISTENT_CLOSURE_REASON,
        advice: INCONSISTENT_CLOSURE_ADVICE,
      };
    }
    if (/watermerk staat op/i.test(raw)) {
      return {
        kind: "inconsistent_watermark",
        code,
        message:
          "Er ligt al een afsluitbewijs voor dit boekjaar, maar de administratie staat nog niet als afgesloten " +
          "geregistreerd. Deze administratie kan niet automatisch worden afgesloten.",
        advice: INCONSISTENT_CLOSURE_ADVICE,
      };
    }
    if (/oudere boekjaren met boekingen/i.test(raw)) {
      return {
        kind: "year_order",
        code,
        message: toonbaar,
        advice: "Sluit eerst het oudste nog open boekjaar met boekingen af.",
      };
    }
    if (/ongebalanceerde boekingsgroep/i.test(raw)) {
      return {
        kind: "unbalanced_group",
        code,
        message: toonbaar,
        advice: "Laat deze boeking eerst herstellen; afsluiten zou haar onherstelbaar maken.",
      };
    }
    // Vóór het openstaande werk: deze melding bevat zelf "postbaar brondocument".
    if (/boekhoudkundige datum onbekend/i.test(raw)) {
      return {
        kind: "missing_date",
        code,
        message: toonbaar,
        advice: "Vul de factuur-, transactie- of boekingsdatum aan en voer de controle opnieuw uit.",
      };
    }
    if (/postbaar brondocument/i.test(raw)) {
      return {
        kind: "unposted_work",
        code,
        message: toonbaar,
        advice: "Boek het openstaande werk eerst in via de inhaalslag.",
      };
    }
    return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
  }
  if (code === "25000" || code === "40001" || code === "40P01") {
    return {
      kind: "unknown",
      code,
      message: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer het opnieuw.",
    };
  }
  if (code === "28000") {
    return { kind: "permission", code, message: "U bent niet meer ingelogd. Log opnieuw in." };
  }
  return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
}

/**
 * De classificatie van een fout die de mutatiehook al heeft vertaald.
 *
 * WAAROM DIT BESTAAT. `useCloseFiscalYear()` gooit een `Error` waarvan de
 * melding al de vertaalde tekst is, met `kind` en `code` eraan geplakt. Die
 * nóg een keer door `classifyYearCloseError()` halen gaat mis, en stil: de
 * erfenismelding bevat de woorden "geen bijbehorend afsluitbewijs" niet meer —
 * dat is juist de ruwe tekst die zij vervángt — dus een tweede ronde zou
 * `inconsistent_closure` als `unknown` bestempelen en de gebruiker de
 * algemene "probeer het opnieuw" geven bij precies de toestand waarin opnieuw
 * proberen nooit helpt.
 */
export function asClassifiedYearCloseError(error: unknown): ClassifiedYearCloseError {
  const err = (error ?? {}) as { kind?: unknown; code?: unknown; message?: unknown; advice?: unknown };
  if (typeof err.kind === "string" && typeof err.message === "string") {
    return {
      kind: err.kind as YearCloseErrorKind,
      code: typeof err.code === "string" ? err.code : "",
      message: err.message,
      advice: typeof err.advice === "string" ? err.advice : undefined,
    };
  }
  return classifyYearCloseError(error);
}

/** Alleen veilige metadata voor de console: nooit de melding zelf. */
export function safeYearCloseErrorMetadata(error: unknown): { code: string; kind: YearCloseErrorKind } {
  const classified = classifyYearCloseError(error);
  return { code: classified.code || "onbekend", kind: classified.kind };
}

/**
 * Uitkomsten waarbij niet vaststaat wat de database heeft gedaan.
 *
 * Hier hoort precies één reactie bij: eerst het afsluitbewijs opnieuw ophalen
 * en tonen wat er staat, en pas daarna eventueel opnieuw proberen. Nooit
 * automatisch herhalen — de database is weliswaar idempotent, maar de
 * gebruiker mag niet hoeven gokken of er iets is gebeurd.
 */
export function needsReconciliation(kind: YearCloseErrorKind): boolean {
  return kind === "network" || kind === "unknown";
}

/**
 * Uitkomsten waarbij opnieuw proberen zinloos of onveilig is: de administratie
 * staat in een toestand die een mens moet bekijken.
 */
export function isTerminal(kind: YearCloseErrorKind): boolean {
  return kind === "inconsistent_closure" || kind === "inconsistent_watermark";
}
