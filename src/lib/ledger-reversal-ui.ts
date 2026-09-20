import { toCents, LEDGER_SOURCE_LABELS, type LedgerPostingLike } from "./ledger-reporting";

/**
 * 6C-b9 PR 2 — de correctieflow, pure laag.
 *
 * DE GRENS, IN ÉÉN ZIN: deze module legt uit, de database beslist.
 *
 * `public.reverse_posting_group(_posting_group_id, _posting_date, _reason)` is
 * en blijft de enige autoriteit. Zij bepaalt de tegenregels, verwisselt debet
 * en credit, neemt rekening, valuta, organisatie en administratie over uit de
 * reeds vastgelegde grootboekregels, en toetst opnieuw op rol, afgesloten
 * boekjaar, beginbalans, tegenboeking-van-tegenboeking, al tegengeboekt en een
 * kapotte groep. Niets hier berekent een boeking; er gaan drie waarden de deur
 * uit: een id, een datum en een toelichting.
 *
 * Wat hier WEL staat: de samenvatting van wat er ís geboekt (afgelezen uit de
 * opgeslagen regels), een uitlegvoorbeeld van het effect, de vormcontroles op
 * het formulier, en de vertaling van serverfouten naar leesbare tekst — zonder
 * de betekenis van die fouten te verbergen.
 */

// ── Bronsoorten ─────────────────────────────────────────────────────────────

export const REVERSAL_SOURCE_TYPE = "reversal";
export const OPENING_BALANCE_SOURCE_TYPE = "opening_balance";

/**
 * Bronsoorten waarvoor de motor bewust géén tegenboeking maakt. Exact de twee
 * die `reverse_posting_group()` zelf weigert — niet afgeleid uit een
 * rekeningnummer, een label of een omschrijving, maar uit de opgeslagen
 * `source_type`.
 */
export const UNSUPPORTED_REVERSAL_SOURCE_TYPES: readonly string[] = [
  REVERSAL_SOURCE_TYPE,
  OPENING_BALANCE_SOURCE_TYPE,
];

export const UNSUPPORTED_REVERSAL_EXPLANATION: Readonly<Record<string, string>> = {
  [REVERSAL_SOURCE_TYPE]:
    "Dit is zelf een tegenboeking. Een tegenboeking van een tegenboeking wordt niet ondersteund; " +
    "boek in plaats daarvan de juiste boeking opnieuw.",
  [OPENING_BALANCE_SOURCE_TYPE]:
    "Dit is de beginbalans. Die kan niet worden tegengeboekt, omdat deze administratie daarna geen " +
    "nieuwe beginbalans zou kunnen vastleggen. Corrigeer met een memoriaalboeking.",
};

/**
 * Presentatielabel van een bronsoort.
 *
 * De centrale kaart in `ledger-reporting.ts` kent `reversal` (nog) niet en is
 * byte-voor-byte bevroren door bestaande bewakingen; die kaart blijft leidend
 * voor alles wat zij wél kent. Dit is uitsluitend een vangnet voor de
 * schermen van deze fase, zodat er geen ruwe `reversal` op de pagina staat.
 * Zodra de kaart zelf een label krijgt, kan dit weg.
 */
export function reversalAwareSourceLabel(sourceType: string): string {
  if (sourceType === REVERSAL_SOURCE_TYPE) return "Tegenboeking";
  return LEDGER_SOURCE_LABELS[sourceType] ?? (sourceType || "Onbekende bron");
}

/**
 * Het minimum dat nodig is om een rekening te tónen. Bewust niet de
 * `LedgerAccountRef` van de rapportagekern: die draagt een geclassificeerde
 * categorie en een resolved-vlag die hier niets toevoegen, en het koppelen van
 * deze schermen aan die vorm zou ze afhankelijk maken van de rapportagelaag.
 */
export interface ReversalAccountRef {
  id: string;
  nummer: number | null;
  omschrijving: string;
}

/** Nooit een leeg vakje: een onbekende rekening toont haar eigen id. */
export function formatReversalAccountLabel(
  account: ReversalAccountRef | undefined,
  fallbackId: string,
): string {
  if (!account) return `Onbekende rekening (${fallbackId})`;
  const nummer = account.nummer === null ? "—" : String(account.nummer);
  return `${nummer} · ${account.omschrijving}`;
}

// ── De samenvatting van een boekingsgroep ───────────────────────────────────

export interface PostingGroupSummary {
  postingGroupId: string;
  /** `null` zodra de regels het oneens zijn; alleen voor weergave. */
  sourceType: string | null;
  /**
   * ÁLLE opgeslagen bronsoorten in de groep, ontdubbeld en gesorteerd. De
   * poort voor niet-ondersteunde bronsoorten kijkt hiernaar en niet naar
   * `sourceType`: een gemengde groep die ergens een tegenboekingsregel bevat
   * zou anders door de mazen glippen.
   */
  sourceTypes: string[];
  sourceId: string | null;
  postingDate: string | null;
  boekjaar: number | null;
  currency: string | null;
  lineCount: number;
  debitCents: number;
  creditCents: number;
  /** Debet en credit zijn gelijk en groter dan nul. */
  balanced: boolean;
}

/**
 * Leest af wat er is geboekt. Telt in hele centen, precies zoals de
 * rapportagekern, zodat scherm en rapport niet uit elkaar kunnen lopen. Een
 * groep die het over meerdere datums, valuta of bronsoorten heeft, levert
 * `null` op die velden op — dat is een WAARNEMING, geen oordeel: of er
 * tegengeboekt mag worden beslist `reverse_posting_group()`.
 */
export function summarizePostingGroup(
  postingGroupId: string,
  rows: readonly LedgerPostingLike[],
): PostingGroupSummary {
  const eigen = rows.filter((r) => r.posting_group_id === postingGroupId);
  const uniek = <T,>(waarden: readonly T[]): T | null => {
    const set = new Set(waarden);
    return set.size === 1 ? [...set][0] : null;
  };

  let debitCents = 0;
  let creditCents = 0;
  for (const row of eigen) {
    debitCents += toCents(row.debit_amount);
    creditCents += toCents(row.credit_amount);
  }

  return {
    postingGroupId,
    sourceType: uniek(eigen.map((r) => r.source_type)),
    sourceTypes: [...new Set(eigen.map((r) => r.source_type))].sort(),
    sourceId: uniek(eigen.map((r) => r.source_id ?? null)),
    postingDate: uniek(eigen.map((r) => r.posting_date)),
    boekjaar: uniek(eigen.map((r) => r.boekjaar)),
    currency: uniek(eigen.map((r) => r.currency)),
    lineCount: eigen.length,
    debitCents,
    creditCents,
    balanced: debitCents === creditCents && debitCents > 0,
  };
}

/** De regels van één groep, in de vaste volgorde van het grootboek. */
export function postingGroupLines(
  postingGroupId: string,
  rows: readonly LedgerPostingLike[],
): LedgerPostingLike[] {
  return rows
    .filter((r) => r.posting_group_id === postingGroupId)
    .slice()
    .sort((a, b) => a.line_no - b.line_no || a.id.localeCompare(b.id));
}

// ── Het uitlegvoorbeeld ─────────────────────────────────────────────────────

export interface ReversalPreviewLine {
  /** De id van de ORIGINELE regel; uitsluitend om de rijen te kunnen koppelen. */
  originalRowId: string;
  grootboekrekeningId: string;
  /** Wat er op de tegenregel zou komen te staan. Alleen ter uitleg. */
  debitCents: number;
  creditCents: number;
}

/**
 * VOORBEELD, GEEN BOEKING.
 *
 * Dit verwisselt debet en credit zodat een mens kan zien wat er staat te
 * gebeuren. Deze waarden worden NERGENS naar de database gestuurd: de RPC
 * krijgt alleen een id, een datum en een toelichting, en leidt haar eigen
 * regels af uit de opgeslagen grootboekregels. Zou dit voorbeeld ooit afwijken
 * van wat de database doet, dan is het voorbeeld fout en de database goed.
 */
export function previewReversalLines(
  postingGroupId: string,
  rows: readonly LedgerPostingLike[],
): ReversalPreviewLine[] {
  return postingGroupLines(postingGroupId, rows).map((row) => ({
    originalRowId: row.id,
    grootboekrekeningId: row.grootboekrekening_id,
    debitCents: toCents(row.credit_amount),
    creditCents: toCents(row.debit_amount),
  }));
}

export const PREVIEW_NOTICE =
  "Voorbeeld ter uitleg. De tegenboeking wordt door de database gemaakt uit de opgeslagen grootboekregels.";

export const ORIGINAL_REMAINS_NOTICE =
  "De oorspronkelijke boeking blijft bestaan. Er wordt een nieuwe tegenboeking gemaakt.";

export const REVERSAL_CONFIRM_TITLE = "Tegenboeking bevestigen";
export const REVERSAL_CONFIRM_BUTTON = "Tegenboeking bevestigen";

// ── Mag er een actie worden aangeboden? ─────────────────────────────────────

export type ReversalAvailability =
  /** Er is nog niet genoeg bekend; nooit als "mag wel" behandelen. */
  | { kind: "unknown"; reason: string }
  /** Al tegengeboekt — de marker zegt het, niet een saldo of een omschrijving. */
  | { kind: "already_reversed"; reversalPostingGroupId: string }
  /** Deze opgeslagen bronsoort wordt bewust niet ondersteund. */
  | { kind: "unsupported_source"; sourceType: string; explanation: string }
  /** De rol is bekend en te laag. */
  | { kind: "not_allowed"; reason: string }
  /** De actie mag worden aangeboden. De RPC blijft de autoriteit. */
  | { kind: "available" };

export interface ReversalAvailabilityInput {
  summary: PostingGroupSummary;
  /** De claim waarin DEZE groep het origineel is; `null` = aantoonbaar geen. */
  existingReversalGroupId: string | null;
  /** De markers konden niet worden opgehaald: dan weet je het niet. */
  markerUnavailable: boolean;
  markerPending: boolean;
  /** `undefined` = nog onbekend, en dat telt als niet toegestaan. */
  canReverse: boolean | undefined;
  roleUnavailable: boolean;
}

/**
 * De volgorde is bewust: eerst "weet ik het wel zeker", dan de toestand van de
 * boeking, dan pas de rol. Een onzekere toestand mag nooit als "mag wel"
 * eindigen, en een tweede tegenboeking mag zelfs niet worden aangeboden.
 */
/**
 * WAT HIER BEWUST NIET STAAT
 *
 * Geen enkele boekhoudkundige acceptatieregel. Of een boeking sluit, of zij
 * één valuta heeft, of haar boekjaar bij haar datum hoort, of zij uit één
 * bronsoort bestaat — dat zijn oordelen van `reverse_posting_group()`, en die
 * functie velt ze opnieuw bij élke aanroep. Ze hier herhalen zou een tweede
 * regelset opleveren die van de echte kan gaan afwijken, en dan wint stilletjes
 * de verkeerde: de UI zou een accountant tegenhouden bij een boeking die de
 * database wél zou accepteren, of andersom een valse geruststelling geven.
 *
 * Zulke afwijkingen worden daarom getoond als WAARSCHUWING
 * (`postingGroupWarnings()`), niet als slot. De accountant mag de RPC
 * aanroepen; weigert de database, dan komt de reden van de database.
 *
 * Wat hier wél mag blokkeren is alles wat géén boekhoudkundig oordeel is:
 * een onbekende of mislukte toestand, een reeds vastgelegde claim, een
 * opgeslagen bronsoort die de motor per definitie niet aanneemt, en een rol
 * die aantoonbaar te laag is.
 */
export function reversalAvailability(input: ReversalAvailabilityInput): ReversalAvailability {
  const { summary } = input;

  if (input.markerUnavailable) {
    return { kind: "unknown", reason: "De tegenboekingsstatus kon niet worden opgehaald. Ververs de pagina." };
  }
  if (input.markerPending) {
    return { kind: "unknown", reason: "Tegenboekingsstatus wordt opgehaald…" };
  }
  if (summary.lineCount === 0) {
    return { kind: "unknown", reason: "De grootboekregels van deze boeking zijn niet beschikbaar." };
  }
  if (input.existingReversalGroupId) {
    return { kind: "already_reversed", reversalPostingGroupId: input.existingReversalGroupId };
  }
  // De twee bronsoorten die de motor per definitie weigert. Afgelezen uit de
  // OPGESLAGEN source_type van de regels, nooit uit een rekeningnummer of een
  // label — en uit álle regels, zodat een gemengde groep die ergens een
  // tegenboekingsregel bevat evenmin wordt aangeboden.
  const nietOndersteund = summary.sourceTypes.find((t) => UNSUPPORTED_REVERSAL_SOURCE_TYPES.includes(t));
  if (nietOndersteund) {
    return {
      kind: "unsupported_source",
      sourceType: nietOndersteund,
      explanation: UNSUPPORTED_REVERSAL_EXPLANATION[nietOndersteund],
    };
  }
  if (input.roleUnavailable) {
    return { kind: "unknown", reason: "Rechten konden niet worden gecontroleerd; ververs de pagina." };
  }
  if (input.canReverse === undefined) {
    return { kind: "unknown", reason: "Rechten worden gecontroleerd…" };
  }
  if (input.canReverse !== true) {
    return { kind: "not_allowed", reason: "Alleen een accountant kan een tegenboeking maken." };
  }
  return { kind: "available" };
}

/**
 * Opvallendheden in de opgeslagen regels, als INFORMATIE — nooit als slot.
 *
 * Dit vertelt een accountant wat hij zelf ook uit de regels zou aflezen, zodat
 * hij niet verrast wordt door een serverweigering. Het spreekt geen oordeel
 * uit over de vraag óf er mag worden tegengeboekt: dat doet de database.
 */
export function postingGroupWarnings(summary: PostingGroupSummary): string[] {
  const warnings: string[] = [];
  if (summary.lineCount === 0) return warnings;

  if (!summary.balanced) {
    warnings.push("Debet en credit van deze boeking zijn niet gelijk of zijn nul.");
  }
  if (!summary.currency) {
    warnings.push("Deze boeking bevat meerdere valuta.");
  }
  if (!summary.postingDate || !summary.boekjaar) {
    warnings.push("Deze boeking bevat meerdere boekingsdatums of boekjaren.");
  }
  if (summary.sourceTypes.length > 1) {
    warnings.push("Deze boeking bevat meerdere bronsoorten.");
  }
  return warnings;
}

export const WARNINGS_NOTICE =
  "De database beoordeelt bij het tegenboeken opnieuw of deze boeking daarvoor in aanmerking komt, en weigert met een reden als dat niet zo is.";

// ── Het formulier ───────────────────────────────────────────────────────────

export const MAX_REVERSAL_REASON_LENGTH = 500;

/** Lege of alleen-witruimte toelichting is géén toelichting. */
export function normalizeReversalReason(raw: string): string | null {
  // String.prototype.trim() haalt élke witruimte weg, inclusief de
  // non-breaking space die uit een plakactie komt.
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Uitsluitend VORMcontroles op het formulier. Bewust niet: afgesloten boekjaar,
 * datum vóór het origineel, rol, bronsoort, balans — die kent de database, en
 * ze hier herhalen zou twee regelsets opleveren die uit elkaar kunnen lopen.
 */
export function firstReversalFormIssue(input: { postingDate: string; reason: string }): string | null {
  const datum = input.postingDate.trim();
  if (datum === "") return "Kies een boekingsdatum voor de tegenboeking.";
  if (!ISO_DATE_RE.test(datum) || Number.isNaN(Date.parse(datum))) {
    return "De boekingsdatum is geen geldige datum.";
  }
  if (input.reason.trim().length > MAX_REVERSAL_REASON_LENGTH) {
    return `De toelichting mag maximaal ${MAX_REVERSAL_REASON_LENGTH} tekens bevatten.`;
  }
  return null;
}

// ── Serverfouten ────────────────────────────────────────────────────────────

export type ReversalErrorKind =
  | "already_reversed"
  | "reversal_of_reversal"
  | "opening_balance"
  | "closed_year"
  | "permission"
  | "unavailable"
  | "corrupt"
  | "date"
  | "schema"
  | "network"
  | "unknown";

export interface ClassifiedReversalError {
  kind: ReversalErrorKind;
  code: string;
  message: string;
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

const GENERIC_FALLBACK = "De tegenboeking is niet gelukt. Probeer het opnieuw.";

/**
 * De meldingen van `reverse_posting_group()` zijn al Nederlands en precies —
 * "Deze boekingsgroep is al tegengeboekt", "Boekjaar 2027 is afgesloten voor
 * deze administratie". Die worden daarom BEWAARD, niet vervangen: ze
 * verbergen zou de betekenis wegpoetsen. Wat hier wordt toegevoegd is de
 * `kind`, zodat het scherm weet wat het met die uitkomst moet doen (opnieuw
 * ophalen, de actie weghalen, of alleen melden).
 */
export function classifyReversalError(error: unknown): ClassifiedReversalError {
  const err = (error ?? {}) as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";
  const toonbaar = looksLikeRawPostgres(raw) ? "" : raw;

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return {
      kind: "schema",
      code,
      message: "Tegenboeken is nog niet beschikbaar in deze omgeving. Probeer het later opnieuw.",
    };
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return {
      kind: "network",
      code: code || "netwerk",
      message: "Geen verbinding met de server. Controleer je verbinding en probeer het opnieuw.",
    };
  }
  if (code === "PGRST301" || /jwt expired|invalid jwt/i.test(raw)) {
    return { kind: "permission", code: code || "PGRST301", message: "Je sessie is verlopen. Log opnieuw in." };
  }
  if (code === "23505") {
    return {
      kind: "already_reversed",
      code,
      message: toonbaar || "Deze boekingsgroep is al tegengeboekt.",
    };
  }
  if (code === "42501") {
    // De schrijver kent hier twee gevallen: "niet beschikbaar" (bestaat niet
    // óf niet van jou — bewust niet te onderscheiden) en "accountant vereist".
    if (/niet beschikbaar/i.test(raw)) {
      return {
        kind: "unavailable",
        code,
        message: "Deze boeking is niet beschikbaar. Controleer of je de juiste administratie hebt geopend.",
      };
    }
    return {
      kind: "permission",
      code,
      message: toonbaar || "Je hebt geen rechten om een tegenboeking te maken.",
    };
  }
  if (code === "22023" || code === "22004") {
    if (/zelf een tegenboeking/i.test(raw)) return { kind: "reversal_of_reversal", code, message: raw };
    if (/beginbalans/i.test(raw)) return { kind: "opening_balance", code, message: raw };
    if (/afgesloten/i.test(raw)) return { kind: "closed_year", code, message: raw };
    if (/datum|boekingsdatum|bereik/i.test(raw)) return { kind: "date", code, message: raw };
    return { kind: "corrupt", code, message: toonbaar || GENERIC_FALLBACK };
  }
  if (code === "23514") {
    return {
      kind: "corrupt",
      code,
      message: toonbaar || "Deze boeking is door de database geweigerd omdat zij niet consistent is.",
    };
  }
  if (code === "25000" || code === "40001" || code === "40P01") {
    return {
      kind: "unknown",
      code,
      message: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer het opnieuw.",
    };
  }
  return { kind: "unknown", code, message: toonbaar || GENERIC_FALLBACK };
}

/** Alleen veilige metadata voor de console: nooit de melding zelf. */
export function safeReversalErrorMetadata(error: unknown): { code: string; kind: ReversalErrorKind } {
  const classified = classifyReversalError(error);
  return { code: classified.code || "onbekend", kind: classified.kind };
}

/**
 * Uitkomsten waarbij de waarheid elders al is veranderd: eerst opnieuw ophalen
 * en tonen wat er staat, nooit automatisch opnieuw proberen.
 */
export function isSettledElsewhere(kind: ReversalErrorKind): boolean {
  return kind === "already_reversed";
}
