import { formatDatumNL, formatTijdstipNL } from "./opening-balance-utils";
import type { AuditTrailEntry } from "./platform/audit-trail";
import { looksLikeRawPostgres } from "./year-close-action";

/**
 * De boekingsblokkade op het scherm — de pure laag.
 *
 * DE GRENS, IN ÉÉN ZIN: deze module legt uit, de database beslist.
 *
 * `public.set_posting_lock(_client_id, _locked_through, _reason)` (PR C) is en
 * blijft de enige schrijver. Zij toetst onder de administratiegrendel de rol
 * (accountant, voor élke richting), de tenant, het datumbereik en de reden,
 * legt de wijziging vast in `posting_lock_events` en zet daarna
 * `clients.posting_locked_through` — in één transactie. Een trigger weigert
 * elke andere wijziging van die kolom. Er gaan hier precies drie waarden de
 * deur uit: administratie, datum (of `null` = opheffen) en een getrimde reden.
 *
 * WAT DE BLOKKADE BETEKENT (PR D): elke gedateerde financiële schrijver
 * weigert een boekingsdatum OP OF VÓÓR de blokkadedatum
 * (`posting_allowed()`: `_posting_date > posting_locked_through`). Een datum
 * erna blijft mogelijk, onder voorbehoud van alle andere controles.
 *
 * DE BOEKINGSBLOKKADE STAAT LOS VAN DE BOEKJAARSTATUS. Een boekjaar afsluiten
 * zet haar niet, heropenen heft haar niet op, en haar wijzigen raakt de
 * boekjaarstatus niet. Deze module kent de jaarafsluiting daarom niet: er
 * staat hier geen afsluit- of heropenaanroep en geen jaarwatermerk.
 */

// ── De leesmodellen ─────────────────────────────────────────────────────────

/** Eén rij van public.posting_lock_events. */
export interface PostingLockEvent {
  id: string;
  client_id: string;
  organization_id: string;
  previous_locked_through: string | null;
  new_locked_through: string | null;
  changed_at: string;
  changed_by: string;
  reason: string;
}

/** Wat `set_posting_lock()` teruggeeft. */
export interface SetPostingLockResult {
  client_id: string;
  organization_id: string;
  previous_locked_through: string | null;
  locked_through: string | null;
  /** Bij `changed = false` het tijdstip van de laatste gebeurtenis, of `null`. */
  changed_at: string | null;
  changed_by: string | null;
  /** `false` = de gevraagde waarde stond er al; er is niets vastgelegd. */
  changed: boolean;
}

// ── De datum ────────────────────────────────────────────────────────────────

/** Het bereik van `set_posting_lock()`: 2000-01-01 t/m 2100-12-31. */
export const LOCK_DATE_MIN = "2000-01-01";
export const LOCK_DATE_MAX = "2100-12-31";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Een echte kalenderdatum in `YYYY-MM-DD`? (31-02 is dat niet.) */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

/** De dag na een ISO-datum, als ISO-datum. Puur kalenderrekenen in UTC. */
export function nextDay(iso: string): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return d.toISOString().slice(0, 10);
}

export type LockDateValidation =
  | { ok: true; date: string }
  | { ok: false; message: string };

export function validateLockDate(raw: string): LockDateValidation {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "Kies een datum." };
  if (!isIsoDate(value)) return { ok: false, message: "Dit is geen geldige datum." };
  if (value < LOCK_DATE_MIN || value > LOCK_DATE_MAX) {
    return { ok: false, message: "De datum moet tussen 01-01-2000 en 31-12-2100 liggen." };
  }
  return { ok: true, date: value };
}

// ── De reden ────────────────────────────────────────────────────────────────

export const LOCK_REASON_MAX_LENGTH = 500;

export type LockReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; message: string };

/**
 * Dezelfde regel als `set_posting_lock()`: getrimd (spatie, tab, CR, LF),
 * 1–500 tekens. De database toetst hem hoe dan ook opnieuw.
 */
export function validateLockReason(raw: string): LockReasonValidation {
  const reason = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (reason.length === 0) return { ok: false, message: "Een reden is verplicht." };
  if (reason.length > LOCK_REASON_MAX_LENGTH) {
    return {
      ok: false,
      message: `De reden is te lang (${reason.length} van maximaal ${LOCK_REASON_MAX_LENGTH} tekens).`,
    };
  }
  return { ok: true, reason };
}

// ── De huidige stand in woorden ─────────────────────────────────────────────

export const NO_LOCK_LABEL = "Geen boekingsblokkade";
export const INDEPENDENCE_NOTE = "Deze boekingsblokkade staat los van de boekjaarstatus.";
export const REOPEN_DOES_NOT_CLEAR_NOTE = "Een boekjaar heropenen heft deze blokkade niet op.";
export const CLEAR_DOES_NOT_REOPEN_NOTE = "De blokkade opheffen opent geen afgesloten boekjaar.";

export function lockLabel(lockedThrough: string | null): string {
  return lockedThrough === null
    ? NO_LOCK_LABEL
    : `Boekingen geblokkeerd t/m ${formatDatumNL(lockedThrough)}`;
}

/** Wat de huidige stand betekent voor een boeking, in gewone woorden. */
export function lockExplanation(lockedThrough: string | null): string[] {
  if (lockedThrough === null) {
    return [
      "Er is geen boekingsblokkade ingesteld. Boeken wordt alleen begrensd door de overige boekhoudkundige controles, waaronder een afgesloten boekjaar.",
    ];
  }
  const d = formatDatumNL(lockedThrough);
  return [
    `Boekingen met een datum op of vóór ${d} worden geweigerd door elke financiële boeking, ook tegenboekingen.`,
    `Boekingen met een datum ná ${d} blijven mogelijk, onder voorbehoud van alle andere boekhoudkundige controles.`,
  ];
}

// ── Wat een wijziging doet ──────────────────────────────────────────────────

export type LockChangeKind =
  /** Van geen blokkade naar een datum. */
  | "set"
  /** Naar een latere datum: méér dicht. */
  | "extend"
  /** Naar een eerdere datum: een versoepeling van de bescherming. */
  | "relax"
  /** Naar geen blokkade. */
  | "clear"
  /** Dezelfde waarde; er zou niets gebeuren. */
  | "unchanged";

export function lockChangeKind(current: string | null, next: string | null): LockChangeKind {
  if (current === next) return "unchanged";
  if (next === null) return "clear";
  if (current === null) return "set";
  return next > current ? "extend" : "relax";
}

/** Versoepelt deze wijziging de bescherming? Dan hoort de knop rood. */
export function isRelaxation(kind: LockChangeKind): boolean {
  return kind === "relax" || kind === "clear";
}

/**
 * De gevolgen van één wijziging, precies: welke datums er bij komen of af gaan.
 * Nooit een uitspraak over de boekjaarstatus, behalve dat zij NIET verandert.
 */
export function lockChangeConsequences(current: string | null, next: string | null): string[] {
  const kind = lockChangeKind(current, next);
  const blijft = [
    "De boekjaarstatus en het afgesloten boekjaar van deze administratie veranderen hierdoor niet.",
    "Er wordt niets geboekt, verwijderd of herschreven. De wijziging en de reden worden onuitwisbaar vastgelegd.",
  ];
  switch (kind) {
    case "set":
      return [
        `Boekingen met een datum op of vóór ${formatDatumNL(next!)} worden geblokkeerd.`,
        `Boekingen met een datum vanaf ${formatDatumNL(nextDay(next!))} blijven mogelijk, onder voorbehoud van alle andere controles.`,
        ...blijft,
      ];
    case "extend":
      return [
        `De blokkade wordt uitgebreid: boekingen van ${formatDatumNL(nextDay(current!))} t/m ${formatDatumNL(next!)} worden voortaan óók geblokkeerd.`,
        `Daarna geldt: boekingen met een datum op of vóór ${formatDatumNL(next!)} worden geblokkeerd.`,
        ...blijft,
      ];
    case "relax":
      return [
        `De blokkade wordt versoepeld: boekingen van ${formatDatumNL(nextDay(next!))} t/m ${formatDatumNL(current!)} worden niet langer door deze blokkade tegengehouden.`,
        `Daarna geldt: boekingen met een datum op of vóór ${formatDatumNL(next!)} blijven geblokkeerd.`,
        "Een afgesloten boekjaar blijft afgesloten; boekingen in dat jaar blijven daardoor geweigerd.",
        ...blijft,
      ];
    case "clear":
      return [
        `De blokkade wordt opgeheven: boekingen met een datum op of vóór ${formatDatumNL(current!)} worden niet langer door deze blokkade tegengehouden.`,
        CLEAR_DOES_NOT_REOPEN_NOTE,
        "Een afgesloten boekjaar blijft afgesloten; boekingen in dat jaar blijven daardoor geweigerd.",
        ...blijft,
      ];
    case "unchanged":
      return [];
  }
}

export const LOCK_CHANGE_HEADLINE: Readonly<Record<Exclude<LockChangeKind, "unchanged">, string>> = {
  set: "Blokkade instellen",
  extend: "Blokkade uitbreiden",
  relax: "Blokkade versoepelen",
  clear: "Blokkade opheffen",
};

export const SET_ACTION_LABEL = "Boekingsblokkade instellen";
export const CHANGE_ACTION_LABEL = "Blokkade wijzigen";
export const CLEAR_ACTION_LABEL = "Blokkade opheffen";

// ── Consistentie van de stand met de geschiedenis ───────────────────────────

/**
 * Chronologisch, oudste eerst. Bij een gelijk tijdstip beslist het id — het
 * spiegelbeeld van de volgorde die `set_posting_lock()` zelf gebruikt
 * (`changed_at DESC, id DESC`).
 */
export function sortLockEventsChronologically(events: readonly PostingLockEvent[]): PostingLockEvent[] {
  return [...events].sort((a, b) => {
    const t = Date.parse(a.changed_at) - Date.parse(b.changed_at);
    if (t !== 0 && !Number.isNaN(t)) return t;
    if (a.changed_at !== b.changed_at) return a.changed_at < b.changed_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type LockConsistency =
  | { kind: "consistent" }
  | { kind: "inconsistent"; reason: string };

export const INCONSISTENT_LOCK_ADVICE =
  "Wijzigen is uitgeschakeld tot de stand is onderzocht. Controleer deze administratie voordat u verdergaat.";

/**
 * Draagt de geschiedenis de huidige stand?
 *
 * Zo hoort het (PR C): de kolom beweegt uitsluitend samen met een gebeurtenis
 * uit dezelfde transactie, en er is nooit gebackfilld. Dus: zonder
 * gebeurtenissen is de kolom `NULL`, en anders is zij gelijk aan de
 * `new_locked_through` van de laatste gebeurtenis. Wijkt dat af, dan kiest het
 * scherm GEEN kant: het toont een blokkerende melding en biedt niets aan.
 */
export function lockConsistency(
  lockedThrough: string | null,
  events: readonly PostingLockEvent[],
): LockConsistency {
  const sorted = sortLockEventsChronologically(events);
  const laatste = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const verwacht = laatste === null ? null : laatste.new_locked_through;
  if (verwacht === lockedThrough) return { kind: "consistent" };
  const volgensStand = lockedThrough === null ? "geen blokkade" : `t/m ${formatDatumNL(lockedThrough)}`;
  const volgensHistorie =
    laatste === null
      ? "geen enkele vastgelegde wijziging"
      : verwacht === null
        ? "opgeheven"
        : `t/m ${formatDatumNL(verwacht)}`;
  return {
    kind: "inconsistent",
    reason: `De administratie staat op ${volgensStand}, maar volgens de vastgelegde geschiedenis is dat ${volgensHistorie}. Het scherm kiest hier geen kant.`,
  };
}

// ── Mag er worden gewijzigd? ────────────────────────────────────────────────

export type LockAvailability =
  | { kind: "unknown"; reason: string }
  | { kind: "inconsistent"; reason: string }
  | { kind: "not_allowed"; reason: string }
  | { kind: "available" };

export interface LockAvailabilityInput {
  lockedThrough: string | null | undefined;
  stateUnavailable: boolean;
  events: readonly PostingLockEvent[] | undefined;
  eventsUnavailable: boolean;
  /** `undefined` = nog onbekend, en dat telt als niet toegestaan. */
  canSet: boolean | undefined;
  roleUnavailable: boolean;
  /** Een onbekende afloop wordt nog verzoend; er mag niets tegelijk. */
  reconciling: boolean;
}

/**
 * De volgorde is bewust: eerst "weet ik het wel zeker" (stand, geschiedenis,
 * lopende verzoening), dan de consistentie, en pas daarna de rol. Een
 * inconsistente stand biedt dus ook een accountant niets aan.
 */
export function lockAvailability(input: LockAvailabilityInput): LockAvailability {
  if (input.stateUnavailable) {
    return { kind: "unknown", reason: "De boekingsblokkade kon niet worden opgehaald. Ververs de pagina." };
  }
  if (input.eventsUnavailable) {
    return {
      kind: "unknown",
      reason: "De geschiedenis van de boekingsblokkade kon niet worden opgehaald; wijzigen is uitgeschakeld tot die bekend is.",
    };
  }
  if (input.lockedThrough === undefined || input.events === undefined) {
    return { kind: "unknown", reason: "De boekingsblokkade wordt opgehaald…" };
  }
  if (input.reconciling) {
    return { kind: "unknown", reason: "De uitkomst van de vorige wijziging wordt gecontroleerd…" };
  }
  const consistency = lockConsistency(input.lockedThrough, input.events);
  if (consistency.kind === "inconsistent") return consistency;
  if (input.roleUnavailable) {
    return { kind: "unknown", reason: "Rechten konden niet worden gecontroleerd; ververs de pagina." };
  }
  if (input.canSet === undefined) return { kind: "unknown", reason: "Rechten worden gecontroleerd…" };
  if (input.canSet !== true) {
    return { kind: "not_allowed", reason: "Alleen een accountant kan de boekingsblokkade wijzigen." };
  }
  return { kind: "available" };
}

// ── De geschiedenis ─────────────────────────────────────────────────────────

const lockValue = (value: string | null) => (value === null ? "Geen blokkade" : `t/m ${formatDatumNL(value)}`);

/**
 * De regels van één wijziging. De actor alleen als het de ingelogde gebruiker
 * zelf is: dit leesmodel kent geen gebruikersnamen, en een naam verzinnen of
 * een rauwe uuid tonen mag niet (dezelfde regel als het afsluitbewijs).
 */
export function lockEventEntries(event: PostingLockEvent, currentUserId: string | undefined): AuditTrailEntry[] {
  const kind = lockChangeKind(event.previous_locked_through, event.new_locked_through);
  const zelf = currentUserId !== undefined && currentUserId === event.changed_by;
  return [
    {
      label: "Wijziging",
      value: kind === "unchanged" ? "Wijziging" : LOCK_CHANGE_HEADLINE[kind],
      testId: "blokkade-gebeurtenis-soort",
    },
    {
      label: "Van",
      value: lockValue(event.previous_locked_through),
      valueClassName: "font-mono tabular-nums",
      testId: "blokkade-gebeurtenis-van",
    },
    {
      label: "Naar",
      value: lockValue(event.new_locked_through),
      valueClassName: "font-mono tabular-nums",
      testId: "blokkade-gebeurtenis-naar",
    },
    {
      label: "Tijdstip",
      value: formatTijdstipNL(event.changed_at),
      valueClassName: "font-mono tabular-nums",
      testId: "blokkade-gebeurtenis-tijdstip",
    },
    { label: "Door", value: zelf ? "U zelf" : null, testId: "blokkade-gebeurtenis-actor" },
    { label: "Reden", value: event.reason, testId: "blokkade-gebeurtenis-reden" },
  ];
}

// ── Serverfouten ────────────────────────────────────────────────────────────

export type PostingLockErrorKind =
  | "permission"
  | "unavailable"
  /** Datum of reden voldoet niet aan de regels van de schrijver. */
  | "validation"
  /** De stand spreekt een databaseregel tegen. Nooit automatisch herstellen. */
  | "inconsistent"
  /** Een andere grootboekactie liep tegelijk. */
  | "concurrent"
  /** De afloop is onbekend: eerst verzoenen, nooit automatisch herhalen. */
  | "network"
  | "schema"
  | "unknown";

export interface ClassifiedPostingLockError {
  kind: PostingLockErrorKind;
  code: string;
  message: string;
  advice?: string;
}

const SCHEMA_CODES = new Set(["PGRST002", "PGRST202", "PGRST204", "PGRST205", "42P01", "42883"]);

const GENERIC_FALLBACK = "Het wijzigen van de boekingsblokkade is niet gelukt. Probeer het opnieuw.";

export const UNKNOWN_LOCK_OUTCOME_MESSAGE =
  "De verbinding viel weg terwijl de wijziging liep. Het is niet bekend of de boekingsblokkade is gewijzigd; " +
  "de actuele stand wordt eerst opnieuw opgehaald.";

/**
 * De meldingen van `set_posting_lock()` zijn al Nederlands en precies; zij
 * komen LETTERLIJK op het scherm. Alleen tekst die eruitziet als onvertaalde
 * PostgreSQL wordt vervangen door een vaste zin.
 */
export function classifyPostingLockError(error: unknown): ClassifiedPostingLockError {
  const err = (error ?? {}) as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";
  const toonbaar = looksLikeRawPostgres(raw) ? "" : raw;

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return {
      kind: "schema",
      code,
      message: "Het wijzigen van de boekingsblokkade is nog niet beschikbaar in deze omgeving. Probeer het later opnieuw.",
    };
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return { kind: "network", code: code || "netwerk", message: UNKNOWN_LOCK_OUTCOME_MESSAGE };
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
    return { kind: "permission", code, message: "Alleen een accountant kan de boekingsblokkade wijzigen." };
  }
  if (code === "22004" || code === "22023" || code === "22007" || code === "22008") {
    return {
      kind: "validation",
      code,
      message: toonbaar || "De opgegeven datum of reden wordt niet geaccepteerd.",
    };
  }
  if (code === "23514") {
    return {
      kind: "inconsistent",
      code,
      message: toonbaar || "De boekingsblokkade kan in de huidige stand niet worden gewijzigd.",
      advice: "Controleer deze administratie voordat u verdergaat.",
    };
  }
  if (code === "25000" || code === "40001" || code === "40P01" || code === "55P03") {
    return {
      kind: "concurrent",
      code,
      message: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Controleer de stand en probeer het daarna opnieuw.",
    };
  }
  return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
}

/** Een al vertaalde fout niet nóg een keer vertalen. */
export function asClassifiedPostingLockError(error: unknown): ClassifiedPostingLockError {
  const err = (error ?? {}) as { kind?: unknown; code?: unknown; message?: unknown; advice?: unknown };
  if (typeof err.kind === "string" && typeof err.message === "string") {
    return {
      kind: err.kind as PostingLockErrorKind,
      code: typeof err.code === "string" ? err.code : "",
      message: err.message,
      advice: typeof err.advice === "string" ? err.advice : undefined,
    };
  }
  return classifyPostingLockError(error);
}

/** Alleen veilige metadata voor de console: nooit de melding zelf. */
export function safePostingLockErrorMetadata(error: unknown): { code: string; kind: PostingLockErrorKind } {
  const c = classifyPostingLockError(error);
  return { code: c.code || "onbekend", kind: c.kind };
}

/** Uitkomsten waarbij eerst de stand opnieuw moet worden opgehaald. */
export function needsLockReconciliation(kind: PostingLockErrorKind): boolean {
  return kind === "network" || kind === "unknown" || kind === "concurrent";
}
