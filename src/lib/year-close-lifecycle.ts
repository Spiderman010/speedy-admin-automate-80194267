import { formatTijdstipNL } from "./opening-balance-utils";
import type { AuditTrailEntry } from "./platform/audit-trail";
import {
  INCONSISTENT_CLOSURE_ADVICE,
  looksLikeRawPostgres,
  type YearClosure,
} from "./year-close-action";

/**
 * Jaarafsluiting PR F — de pure laag onder de levenscyclus op het scherm.
 *
 * DE GRENS, IN ÉÉN ZIN: deze module legt uit, de database beslist.
 *
 * `public.reopen_fiscal_year(_client_id, _fiscal_year, _reason)` (PR E) is en
 * blijft de autoriteit. Zij toetst onder de administratiegrendel de rol, de
 * tenant, de reden, of dit het hoogste afgesloten jaar is en of stand,
 * geschiedenis en watermerk elkaar dragen; zij schrijft de gebeurtenis en zet
 * het watermerk. Er gaan hier precies drie waarden de deur uit: een
 * administratie-id, een jaartal en een getrimde reden.
 *
 * Wat hier WEL staat: de status in woorden, wanneer de heropening mag worden
 * aangeboden, de toets op de reden (dezelfde regel als de database: getrimd,
 * 1–500 tekens), de woorden van de bevestiging, de vertaling van serverfouten
 * en de opmaak van de gebeurtenissen.
 *
 * WAT HIER NADRUKKELIJK NIET STAAT
 *   • niets over de boekingsblokkade — heropenen en afsluiten raken
 *     `posting_locked_through` niet, en deze module beweert daar ook niets over;
 *   • geen tweede rechtenladder — `has_min_role()` blijft de bron;
 *   • geen afleiding van een status uit boekingen, rekeningen of het watermerk
 *     alleen: de status komt uit `year_closures.status` en de historie uit
 *     `fiscal_year_events`.
 */

// ── De status ───────────────────────────────────────────────────────────────

export type FiscalYearLifecycleStatus = "open" | "closed" | "reopened";

/**
 * De status van één boekjaar, uitsluitend uit het afsluitbewijs.
 *
 * Geen bewijs = open. Een bewijs zonder `status` telt als `closed`: dat is de
 * databasedefault én wat het RPC-resultaat van `close_fiscal_year()` betekent.
 */
export function lifecycleStatus(closure: YearClosure | null | undefined): FiscalYearLifecycleStatus {
  if (!closure) return "open";
  return closure.status === "reopened" ? "reopened" : "closed";
}

export const LIFECYCLE_STATUS_PRESENTATION: Readonly<
  Record<FiscalYearLifecycleStatus, { label: string; variant: "info" | "success" | "warning" }>
> = {
  open: { label: "Open", variant: "info" },
  closed: { label: "Afgesloten", variant: "success" },
  reopened: { label: "Heropend", variant: "warning" },
};

// ── De gebeurtenissen ───────────────────────────────────────────────────────

export type FiscalYearEventType = "closed" | "reopened";

/** Eén rij van public.fiscal_year_events, zoals het scherm haar leest. */
export interface FiscalYearEvent {
  id: string;
  client_id: string;
  organization_id: string;
  fiscal_year: number;
  event_type: FiscalYearEventType;
  occurred_at: string;
  actor_id: string;
  reason: string | null;
}

/** Wat `reopen_fiscal_year()` teruggeeft. */
export interface ReopenResult {
  client_id: string;
  organization_id: string;
  fiscal_year: number;
  status: "closed" | "reopened";
  event_id: string;
  occurred_at: string;
  actor_id: string;
  reason: string | null;
  afgesloten_boekjaar: number | null;
  /** `false` = het jaar stond al heropend; dezelfde gebeurtenis is teruggegeven. */
  reopened: boolean;
}

export const EVENT_TYPE_LABEL: Readonly<Record<FiscalYearEventType, string>> = {
  closed: "Afgesloten",
  reopened: "Heropend",
};

/**
 * Chronologisch: oudste eerst. Bij een gelijk tijdstip beslist het id, zodat
 * de volgorde op het scherm nooit van de toevallige leesvolgorde afhangt.
 */
export function sortEventsChronologically(events: readonly FiscalYearEvent[]): FiscalYearEvent[] {
  return [...events].sort((a, b) => {
    const t = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
    if (t !== 0 && !Number.isNaN(t)) return t;
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** De laatste gebeurtenis van een soort, of `null`. */
export function latestEvent(
  events: readonly FiscalYearEvent[],
  type?: FiscalYearEventType,
): FiscalYearEvent | null {
  const sorted = sortEventsChronologically(events);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (type === undefined || sorted[i].event_type === type) return sorted[i];
  }
  return null;
}

/**
 * De regels van één gebeurtenis in het historieblok.
 *
 * OVER DE ACTOR. Dit leesmodel kent geen gebruikersnamen (zie
 * `closureReceiptEntries()`): er wordt geen naam verzonnen en geen rauwe uuid
 * getoond. Is het de ingelogde gebruiker zelf, dan staat dat er; anders valt
 * de regel weg. De reden staat er alleen als zij is vastgelegd — bij een
 * afsluiting is zij optioneel, bij een heropening verplicht (databaseregel).
 */
export function lifecycleEventEntries(
  event: FiscalYearEvent,
  currentUserId: string | undefined,
): AuditTrailEntry[] {
  const zelf = currentUserId !== undefined && currentUserId === event.actor_id;
  return [
    { label: "Gebeurtenis", value: EVENT_TYPE_LABEL[event.event_type], testId: "gebeurtenis-soort" },
    {
      label: "Boekjaar",
      value: String(event.fiscal_year),
      valueClassName: "font-mono tabular-nums",
      testId: "gebeurtenis-boekjaar",
    },
    {
      label: "Tijdstip",
      value: formatTijdstipNL(event.occurred_at),
      valueClassName: "font-mono tabular-nums",
      testId: "gebeurtenis-tijdstip",
    },
    { label: "Door", value: zelf ? "U zelf" : null, testId: "gebeurtenis-actor" },
    { label: "Reden", value: event.reason, testId: "gebeurtenis-reden" },
  ];
}

// ── De reden ────────────────────────────────────────────────────────────────

export const REASON_MAX_LENGTH = 500;

export type ReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; problem: "empty" | "too_long"; message: string };

/**
 * Dezelfde regel als `reopen_fiscal_year()`: getrimd, 1–500 tekens. Het scherm
 * toetst dit vooraf zodat de knop pas aangaat als de database het zou
 * accepteren; de database toetst het hoe dan ook opnieuw.
 */
export function validateReopenReason(raw: string): ReasonValidation {
  const reason = raw.trim();
  if (reason.length === 0) {
    return { ok: false, problem: "empty", message: "Een reden is verplicht." };
  }
  if (reason.length > REASON_MAX_LENGTH) {
    return {
      ok: false,
      problem: "too_long",
      message: `De reden is te lang (${reason.length} van maximaal ${REASON_MAX_LENGTH} tekens).`,
    };
  }
  return { ok: true, reason };
}

// ── Mag heropenen worden aangeboden? ────────────────────────────────────────

export type ReopenAvailability =
  /** Er is iets nog niet bekend. Nooit als "mag wel" behandelen. */
  | { kind: "unknown"; reason: string }
  /** Geen afsluitbewijs: er valt niets te heropenen. */
  | { kind: "not_closed" }
  /** Het jaar staat al heropend. */
  | { kind: "already_reopened" }
  /** Het watermerk draagt de afgesloten stand niet; de database zou weigeren. */
  | { kind: "inconsistent"; reason: string }
  /** Alleen het hoogste afgesloten jaar kan worden heropend. */
  | { kind: "not_highest"; reason: string }
  /** De rol is bekend en te laag. */
  | { kind: "not_allowed"; reason: string }
  /** De actie mag worden aangeboden. De RPC blijft de autoriteit. */
  | { kind: "available" };

export interface ReopenAvailabilityInput {
  fiscalYear: number;
  closure: YearClosure | null;
  closurePending: boolean;
  closureUnavailable: boolean;
  /** `clients.afgesloten_boekjaar`; `undefined` = nog onbekend. */
  watermark: number | null | undefined;
  /** `undefined` = nog onbekend, en dat telt als niet toegestaan. */
  canReopen: boolean | undefined;
  roleUnavailable: boolean;
}

export const CLOSED_BUT_UNLOCKED_REASON =
  "Dit boekjaar staat als afgesloten geregistreerd, maar de administratie staat niet als afgesloten t/m " +
  "dit boekjaar. De afsluitstand is inconsistent en kan niet automatisch worden hersteld.";

export function reopenAvailability(input: ReopenAvailabilityInput): ReopenAvailability {
  if (input.closureUnavailable) {
    return { kind: "unknown", reason: "Het afsluitbewijs kon niet worden opgehaald. Ververs de pagina." };
  }
  if (input.closurePending) {
    return { kind: "unknown", reason: "Afsluitstatus wordt opgehaald…" };
  }
  const status = lifecycleStatus(input.closure);
  if (status === "open") return { kind: "not_closed" };
  if (status === "reopened") return { kind: "already_reopened" };

  if (input.watermark === undefined) {
    return { kind: "unknown", reason: "De afsluitstand van de administratie wordt opgehaald…" };
  }
  if (input.watermark === null || input.watermark < input.fiscalYear) {
    return { kind: "inconsistent", reason: CLOSED_BUT_UNLOCKED_REASON };
  }
  // Het watermerk is per PR E altijd het hoogste nog afgesloten jaar. Staat
  // het hoger dan dit jaar, dan is er een jonger afgesloten jaar, en dat moet
  // eerst open. De database weigert dat ook; hier alleen de uitleg vooraf.
  if (input.watermark > input.fiscalYear) {
    return {
      kind: "not_highest",
      reason: `Alleen het laatst afgesloten boekjaar (${input.watermark}) kan worden heropend. Heropen eerst de jongere boekjaren.`,
    };
  }
  if (input.roleUnavailable) {
    return { kind: "unknown", reason: "Rechten konden niet worden gecontroleerd; ververs de pagina." };
  }
  if (input.canReopen === undefined) {
    return { kind: "unknown", reason: "Rechten worden gecontroleerd…" };
  }
  if (input.canReopen !== true) {
    return { kind: "not_allowed", reason: "Alleen een accountant kan een boekjaar heropenen." };
  }
  return { kind: "available" };
}

// ── De woorden ──────────────────────────────────────────────────────────────

export const REOPEN_ACTION_LABEL = "Boekjaar heropenen";
export const REOPEN_CONFIRM_LABEL = "Heropenen";
export const REOPEN_PENDING_LABEL = "Bezig met heropenen…";
export const REOPEN_DIALOG_TITLE = "Boekjaar heropenen";
export const RECLOSE_ACTION_LABEL = "Boekjaar opnieuw afsluiten";

export const REOPENED_HEADING = "Boekjaar heropend";
export const REOPENED_EXPLANATION =
  "Dit boekjaar is heropend. Verwerk de correctie, controleer de gereedheid opnieuw en sluit het boekjaar daarna opnieuw af.";

export const ALREADY_REOPENED_NOTICE =
  "Dit boekjaar was al heropend. De bestaande heropening is geladen.";

export function reopenDialogExplanation(clientName: string, fiscalYear: number): string {
  return (
    `U heropent boekjaar ${fiscalYear} van ${clientName}. De administratie staat daarna niet meer als ` +
    `afgesloten t/m ${fiscalYear}. De reden wordt onuitwisbaar vastgelegd in de historie.`
  );
}

/**
 * De gevolgen in gewone woorden. Bewust wél de zin over de boekingsblokkade:
 * de meest voor de hand liggende verkeerde aanname is dat heropenen "de
 * periode weer openzet", en dat doet het niet.
 */
export function reopenConsequences(fiscalYear: number): readonly string[] {
  return [
    `Boekjaar ${fiscalYear} krijgt de status Heropend; de eerdere afsluiting blijft in de historie staan.`,
    `Heropenen verandert niets aan wat er geboekt kan worden: dat bepaalt de afzonderlijke boekingsblokkade, en die blijft precies zoals zij staat.`,
    "De aparte boekingsblokkade van deze administratie verandert hierdoor niet; die staat los van de boekjaarstatus.",
    "Er wordt niets geboekt, verwijderd of herschreven.",
    `Na de correctie moet boekjaar ${fiscalYear} opnieuw worden gecontroleerd en afgesloten.`,
  ];
}

// ── Serverfouten ────────────────────────────────────────────────────────────

export type ReopenErrorKind =
  /** Geen afsluitbewijs; er valt niets te heropenen. */
  | "not_closed"
  /** Alleen het hoogste afgesloten jaar kan open. */
  | "not_highest"
  /** Stand, geschiedenis en watermerk spreken elkaar tegen. Fail closed. */
  | "inconsistent"
  /** De reden voldoet niet (leeg of te lang). */
  | "reason"
  | "permission"
  | "unavailable"
  | "schema"
  | "network"
  | "unknown";

export interface ClassifiedReopenError {
  kind: ReopenErrorKind;
  code: string;
  message: string;
  advice?: string;
}

const SCHEMA_CODES = new Set(["PGRST002", "PGRST204", "PGRST205", "42P01", "42883"]);

const GENERIC_FALLBACK = "Het heropenen is niet gelukt. Probeer het opnieuw.";

export const UNKNOWN_REOPEN_OUTCOME_MESSAGE =
  "De verbinding viel weg terwijl het heropenen liep. Het is nu niet bekend of het boekjaar is heropend; " +
  "de status wordt opnieuw opgehaald.";

/**
 * De meldingen van `reopen_fiscal_year()` zijn al Nederlands en precies; zij
 * worden LETTERLIJK getoond. Alleen tekst die eruitziet als onvertaalde
 * PostgreSQL komt niet op het scherm. De soort volgt uit de code en, voor de
 * 23514-weigeringen, uit de tekst.
 */
export function classifyReopenError(error: unknown): ClassifiedReopenError {
  const err = (error ?? {}) as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";
  const toonbaar = looksLikeRawPostgres(raw) ? "" : raw;

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return {
      kind: "schema",
      code,
      message: "Heropenen is nog niet beschikbaar in deze omgeving. Probeer het later opnieuw.",
    };
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return { kind: "network", code: code || "netwerk", message: UNKNOWN_REOPEN_OUTCOME_MESSAGE };
  }
  if (code === "PGRST301" || /jwt expired|invalid jwt/i.test(raw)) {
    return { kind: "permission", code: code || "PGRST301", message: "Uw sessie is verlopen. Log opnieuw in." };
  }
  if (code === "28000") {
    return { kind: "permission", code, message: "U bent niet meer ingelogd. Log opnieuw in." };
  }
  if (code === "42501") {
    if (/niet beschikbaar/i.test(raw)) {
      return {
        kind: "unavailable",
        code,
        message: "Deze administratie is niet beschikbaar. Controleer of u de juiste administratie hebt geopend.",
      };
    }
    return { kind: "permission", code, message: "Alleen een accountant kan een boekjaar heropenen." };
  }
  if (code === "22004" && /reden/i.test(raw)) {
    return { kind: "reason", code, message: "Een reden is verplicht." };
  }
  if (code === "22023") {
    return { kind: "reason", code, message: toonbaar || `De reden is te lang (maximaal ${REASON_MAX_LENGTH} tekens).` };
  }
  if (code === "23514") {
    if (/is niet afgesloten; er valt niets te heropenen/i.test(raw)) {
      return { kind: "not_closed", code, message: toonbaar };
    }
    if (/Alleen het laatst afgesloten boekjaar/i.test(raw)) {
      return { kind: "not_highest", code, message: toonbaar, advice: "Heropen eerst de jongere boekjaren." };
    }
    if (/moet handmatig worden onderzocht/i.test(raw)) {
      return { kind: "inconsistent", code, message: toonbaar, advice: INCONSISTENT_CLOSURE_ADVICE };
    }
    return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
  }
  if (code === "25000" || code === "40001" || code === "40P01" || code === "55000") {
    return {
      kind: "unknown",
      code,
      message: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer het opnieuw.",
    };
  }
  return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
}

/** Zie `asClassifiedYearCloseError()`: een al vertaalde fout niet nóg een keer vertalen. */
export function asClassifiedReopenError(error: unknown): ClassifiedReopenError {
  const err = (error ?? {}) as { kind?: unknown; code?: unknown; message?: unknown; advice?: unknown };
  if (typeof err.kind === "string" && typeof err.message === "string") {
    return {
      kind: err.kind as ReopenErrorKind,
      code: typeof err.code === "string" ? err.code : "",
      message: err.message,
      advice: typeof err.advice === "string" ? err.advice : undefined,
    };
  }
  return classifyReopenError(error);
}

/** Alleen veilige metadata voor de console: nooit de melding zelf. */
export function safeReopenErrorMetadata(error: unknown): { code: string; kind: ReopenErrorKind } {
  const classified = classifyReopenError(error);
  return { code: classified.code || "onbekend", kind: classified.kind };
}
