/**
 * Fase 6C-b8 (PR 2) — pure logica voor de beginbalans-UI (/grootboek/beginbalans).
 *
 * Alles hier is presentatie- en invoerlogica: exacte centen uit tekstinvoer,
 * totalen en verschil, de afleiding van de toestand (geen kop / concept /
 * geboekt / bewust nihil), de payloads voor de RPC's en de eerste blokkerende
 * reden voor de boek- en nihilknop. Het is nadrukkelijk GEEN tweede
 * implementatie van de boekhoudregels: public.post_opening_balance() en
 * public.declare_opening_balance_nil() keuren server-side alles opnieuw
 * (rekeningbereik, niet-actieve rekeningen, afgesloten boekjaar, rechten,
 * balans, eerdere grootboekfeiten, NaN, decimalen) en zijn de enige autoriteit.
 * De hints hier voorkomen alleen een kansloze klik.
 *
 * Geld: hele centen, exact uit de tekst geparsed — nergens float-gelijkheid.
 * Bedragen worden bewust NIET client-side afgerond: 0,005 gaat als 0.005 de
 * deur uit, zodat de RPC hem kan weigeren ("Bedragen mogen maximaal twee
 * decimalen hebben") in plaats van dat de frontend er stilletjes 0,01 van
 * maakt (de memoriaal-decimalenles).
 *
 * Geboekt is uitsluitend het bestaan van een rij in opening_balance_postings;
 * nihil is uitsluitend nil_declaration = true én nil_declared_at gevuld. Er is
 * geen lokale statuskolom en die komt er ook niet.
 */

import { formatEuro } from "@/lib/format";
import type { Tables } from "@/integrations/supabase/types";

export type OpeningBalanceRow = Tables<"opening_balances">;
export type OpeningBalanceLineRecord = Tables<"opening_balance_lines">;
export type OpeningBalanceMarker = Tables<"opening_balance_postings">;

/** Het deel van een grootboekrekening dat de UI nodig heeft. */
export interface OpeningBalanceAccountRef {
  id: string;
  nummer: number;
  omschrijving: string;
  categorie: string;
  actief: boolean;
  client_id: string | null;
}

/** Eén bewerkbare regel in het formulier. `id` is null zolang de regel nieuw is. */
export interface OpeningBalanceLineRow {
  /** Stabiele React-key; overleeft verwijderen/toevoegen. */
  key: string;
  id: string | null;
  description: string;
  grootboekrekening_id: string | null;
  grootboek_label: string;
  /** Exacte tekstinvoer, nooit afgerond. */
  debit_input: string;
  credit_input: string;
}

export interface OpeningBalanceHeaderForm {
  /** Als tekst, zodat een leeg of half getypt veld niet stilletjes 0 wordt. */
  boekjaar: string;
  opening_date: string;
  description: string;
  reference: string;
}

/** Eén element van het `_lines` jsonb-argument van save_opening_balance_lines(). */
export interface OpeningBalanceLinePayload {
  sort_order: number;
  grootboekrekening_id: string | null;
  description: string | null;
  debit_amount: number;
  credit_amount: number;
}

// ── Vaste teksten ───────────────────────────────────────────────────────────

export const DOUBLE_COUNT_WARNING =
  "Let op: neem openstaande debiteuren en crediteuren niet dubbel op wanneer de bijbehorende facturen ook in BoekAssist worden geboekt.";

export const POSTED_FINAL_NOTICE =
  "Deze beginbalans is geboekt in het grootboek en is definitief zolang er geen tegenboekingsfunctie bestaat. Een correctie vereist tot die tijd een compenserende boeking.";

export const NIL_NOTICE = "Beginbalans bewust op nihil gezet";

export const NIL_FINAL_NOTICE =
  "Een accountant heeft vastgelegd dat deze administratie bewust geen beginbalans heeft. Deze verklaring kan niet worden ingetrokken; er zijn geen regels en er wordt niets in het grootboek geboekt.";

export const POST_CONFIRM_TITLE = "Beginbalans boeken in het grootboek?";

/** De waarschuwing wordt bewust niet verzacht. */
export const POST_CONFIRM_POINTS = [
  "Dit legt de beginpositie van deze administratie vast in het grootboek.",
  "De boeking is na het boeken onveranderbaar: regels kunnen niet meer worden gewijzigd of verwijderd.",
  "Er is op dit moment geen functie om een geboekte beginbalans terug te draaien.",
  "Een correctie vereist tot er een tegenboekingsfunctie bestaat een compenserende boeking.",
] as const;

export const NIL_CONFIRM_TITLE = "Vastleggen dat er geen beginbalans nodig is?";

export const NIL_CONFIRM_POINTS = [
  "Je legt vast dat deze administratie bewust geen beginbalans heeft. Dit is een boekhoudkundige verklaring, geen instelling.",
  "Er wordt niets in het grootboek geboekt en er kunnen daarna geen regels meer worden toegevoegd.",
  "Deze verklaring kan niet ongedaan worden gemaakt.",
] as const;

export const SCHEMA_UNAVAILABLE_MESSAGE =
  "Beginbalansen zijn nog niet beschikbaar in deze omgeving (het databaseschema ontbreekt).";

export const DEADLOCK_MESSAGE =
  "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw.";

export const STALE_MESSAGE =
  "De beginbalans is tussentijds gewijzigd. De actuele toestand is opnieuw geladen; controleer en probeer opnieuw.";

// ── Geld: exacte centen uit tekst ───────────────────────────────────────────

export type AmountProblem = "unparseable" | "negative" | "decimals" | "too-large";

export type ParsedAmount =
  | { kind: "empty" }
  | { kind: "ok"; cents: number }
  | {
      kind: "invalid";
      reason: AmountProblem;
      /** De waarde zoals de RPC hem zou zien; null als er geen getal van te maken is. */
      value: number | null;
    };

const AMOUNT_RE = /^(-)?(\d*)(?:[.,](\d*))?$/;

/** numeric(12,2): hoogstens 9.999.999.999,99 — daarboven weigert de database (22003). */
export const MAX_AMOUNT_CENTS = 999_999_999_999;

/**
 * nl-NL of technische invoer ("1234,56", "1234.56", "12") → exacte centen.
 * Geen float-omweg: de tekst wordt cijfer voor cijfer gelezen. Meer dan twee
 * betekenisvolle decimalen, een negatief of een te groot bedrag is `invalid`,
 * mét de waarde die naar de RPC gaat zodat de database het laatste woord houdt.
 */
export function parseExactAmount(raw: string | null | undefined): ParsedAmount {
  const text = (raw ?? "").replace(/\s+/g, "");
  if (text === "") return { kind: "empty" };
  const m = AMOUNT_RE.exec(text);
  const intPart = m?.[2] ?? "";
  const fracPart = m?.[3] ?? "";
  if (!m || (intPart === "" && fracPart === "")) {
    return { kind: "invalid", reason: "unparseable", value: null };
  }
  const negative = m[1] === "-";
  const value = Number(`${negative ? "-" : ""}${intPart || "0"}.${fracPart || "0"}`);
  // Boven de kolomgrens is een exacte centenwaarde zinloos (en Number() zou
  // precisie verliezen); de database weigert het bedrag toch.
  if (intPart.replace(/^0+/, "").length > 10) return { kind: "invalid", reason: "too-large", value };
  const cents = Number(intPart || "0") * 100 + Number((fracPart + "00").slice(0, 2));
  // "-0" is gewoon nul; alles wat echt onder nul ligt is negatief.
  if (negative && value < 0) return { kind: "invalid", reason: "negative", value };
  if (fracPart.length > 2 && /[1-9]/.test(fracPart.slice(2))) {
    return { kind: "invalid", reason: "decimals", value };
  }
  if (cents > MAX_AMOUNT_CENTS) return { kind: "invalid", reason: "too-large", value };
  return { kind: "ok", cents };
}

/** Hele centen → nl-NL invoertekst zonder duizendtalscheiding ("1234,56"). */
export function formatCentsInput(cents: number): string {
  const abs = Math.abs(cents);
  const euros = Math.trunc(abs / 100);
  const rest = abs % 100;
  return `${cents < 0 ? "-" : ""}${euros},${String(rest).padStart(2, "0")}`;
}

/** Hele centen → nl-NL eurotekst voor weergave. */
export function formatCentsEuro(cents: number): string {
  return formatEuro(cents / 100);
}

/**
 * numeric(12,2) uit de database (als number of string) → hele centen. Strings
 * worden exact gelezen; een number is de float-weergave van een tweedecimaal
 * getal en wordt met Math.round hersteld (0.29 * 100 = 28.999999… → 29).
 */
export function dbAmountToCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") {
    const parsed = parseExactAmount(value);
    return parsed.kind === "ok" ? parsed.cents : Math.round(Number(value) * 100) || 0;
  }
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/**
 * De waarde die voor dit veld naar de RPC gaat. Geldig → exact tweedecimaal
 * getal; ongeldig maar wel een getal (0,005, -5) → dat getal, onafgerond, zodat
 * de database weigert; leeg → 0; onleesbaar → null (de aanroeper blokkeert dan
 * het opslaan, want null zou server-side stilletjes 0 worden).
 */
export function amountForRpc(raw: string): number | null {
  const parsed = parseExactAmount(raw);
  if (parsed.kind === "empty") return 0;
  if (parsed.kind === "ok") return parsed.cents / 100;
  return parsed.value;
}

// ── Regels ──────────────────────────────────────────────────────────────────

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `ob-line-${keyCounter}`;
}

export function createEmptyLineRow(): OpeningBalanceLineRow {
  return {
    key: nextKey(),
    id: null,
    description: "",
    grootboekrekening_id: null,
    grootboek_label: "",
    debit_input: "",
    credit_input: "",
  };
}

/** Een nieuw concept begint met twee lege regels: debet en credit. */
export function createEmptyLineRows(count = 2): OpeningBalanceLineRow[] {
  return Array.from({ length: Math.max(0, count) }, () => createEmptyLineRow());
}

export const MIN_LINE_ROWS = 2;

export function formatAccountLabel(account: Pick<OpeningBalanceAccountRef, "nummer" | "omschrijving">): string {
  return `${account.nummer} - ${account.omschrijving}`;
}

/** Een regel zonder omschrijving, rekening en bedragen is een UI-hulpmiddel, geen gegeven. */
export function isBlankLine(line: OpeningBalanceLineRow): boolean {
  return (
    line.description.trim() === "" &&
    !line.grootboekrekening_id &&
    line.debit_input.trim() === "" &&
    line.credit_input.trim() === ""
  );
}

/**
 * Databaseregels → formulierregels, aangevuld tot minimaal twee rijen. Labels
 * komen uit de volledige rekeninglijst (ook inactieve), zodat een later
 * gedeactiveerde rekening nog herkenbaar is in plaats van "—".
 */
export function toLineRows(
  lines: readonly OpeningBalanceLineRecord[] | undefined,
  accountsById: ReadonlyMap<string, OpeningBalanceAccountRef>,
): OpeningBalanceLineRow[] {
  const rows = (lines ?? []).map((line) => {
    const account = line.grootboekrekening_id ? accountsById.get(line.grootboekrekening_id) : undefined;
    const debitCents = dbAmountToCents(line.debit_amount);
    const creditCents = dbAmountToCents(line.credit_amount);
    return {
      key: `ob-line-db-${line.id}`,
      id: line.id,
      description: line.description ?? "",
      grootboekrekening_id: line.grootboekrekening_id ?? null,
      grootboek_label: account ? formatAccountLabel(account) : "",
      debit_input: debitCents === 0 ? "" : formatCentsInput(debitCents),
      credit_input: creditCents === 0 ? "" : formatCentsInput(creditCents),
    };
  });
  while (rows.length < MIN_LINE_ROWS) rows.push(createEmptyLineRow());
  return rows;
}

export interface OpeningBalanceTotals {
  debitCents: number;
  creditCents: number;
  /** debet − credit, in centen; getekend. */
  differenceCents: number;
  /** Regels met een bedrag dat niet in centen uit te drukken is. */
  invalidLineCount: number;
  /** Alleen bij gelijke, niet-nul totalen zonder ongeldige regels. */
  isBalanced: boolean;
}

export function lineTotals(lines: readonly OpeningBalanceLineRow[]): OpeningBalanceTotals {
  let debitCents = 0;
  let creditCents = 0;
  let invalidLineCount = 0;
  for (const line of lines) {
    const debit = parseExactAmount(line.debit_input);
    const credit = parseExactAmount(line.credit_input);
    if (debit.kind === "invalid" || credit.kind === "invalid") invalidLineCount += 1;
    if (debit.kind === "ok") debitCents += debit.cents;
    if (credit.kind === "ok") creditCents += credit.cents;
  }
  const differenceCents = debitCents - creditCents;
  return {
    debitCents,
    creditCents,
    differenceCents,
    invalidLineCount,
    isBalanced: invalidLineCount === 0 && debitCents === creditCents && debitCents > 0,
  };
}

export type LineIssueCode =
  | AmountProblem
  | "both-sides"
  | "unknown-account"
  | "inactive-account"
  | "out-of-scope-account";

export interface LineIssue {
  code: LineIssueCode;
  message: string;
}

const AMOUNT_ISSUE_MESSAGES: Record<AmountProblem, string> = {
  unparseable: "Ongeldig bedrag; gebruik cijfers met een komma voor de decimalen.",
  negative: "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde.",
  decimals: "Maximaal twee decimalen; het bedrag wordt niet afgerond.",
  "too-large": "Bedrag is te groot (maximaal 9.999.999.999,99).",
};

/**
 * Zichtbare invoerfouten per regel. Een ontbrekende rekening of een ontbrekend
 * bedrag is hier bewust GEEN fout: dat is een normaal, opslaanbaar concept —
 * de boekknop noemt het wel.
 */
export function lineIssues(
  line: OpeningBalanceLineRow,
  accountsById: ReadonlyMap<string, OpeningBalanceAccountRef>,
  clientId: string,
): LineIssue[] {
  const issues: LineIssue[] = [];
  const debit = parseExactAmount(line.debit_input);
  const credit = parseExactAmount(line.credit_input);
  const seen = new Set<LineIssueCode>();
  for (const parsed of [debit, credit]) {
    if (parsed.kind === "invalid" && !seen.has(parsed.reason)) {
      seen.add(parsed.reason);
      issues.push({ code: parsed.reason, message: AMOUNT_ISSUE_MESSAGES[parsed.reason] });
    }
  }
  const debitFilled = debit.kind === "ok" ? debit.cents !== 0 : debit.kind === "invalid";
  const creditFilled = credit.kind === "ok" ? credit.cents !== 0 : credit.kind === "invalid";
  if (debitFilled && creditFilled) {
    issues.push({ code: "both-sides", message: "Een regel kan niet tegelijk debet en credit zijn." });
  }
  if (line.grootboekrekening_id) {
    const account = accountsById.get(line.grootboekrekening_id);
    if (!account) {
      issues.push({
        code: "unknown-account",
        message: "Deze grootboekrekening is niet (meer) bekend; kies een andere rekening.",
      });
    } else {
      if (!account.actief) {
        issues.push({
          code: "inactive-account",
          message: "Deze grootboekrekening is inactief; kies een actieve rekening.",
        });
      }
      if (account.client_id !== null && account.client_id !== clientId) {
        issues.push({
          code: "out-of-scope-account",
          message: "Deze grootboekrekening hoort bij een andere administratie.",
        });
      }
    }
  }
  return issues;
}

/** Alleen invoer die geen getal oplevert kan niet worden opgeslagen (null zou server-side 0 worden). */
export function lineBlocksSave(line: OpeningBalanceLineRow): boolean {
  const debit = parseExactAmount(line.debit_input);
  const credit = parseExactAmount(line.credit_input);
  return (
    (debit.kind === "invalid" && debit.reason === "unparseable") ||
    (credit.kind === "invalid" && credit.reason === "unparseable")
  );
}

const CATEGORY_NOTES: Record<string, string> = {
  omzet: "Omzetrekening in een beginbalans: toegestaan, maar controleer of dit bedoeld is.",
  kosten: "Kostenrekening in een beginbalans: toegestaan, maar controleer of dit bedoeld is.",
  "privé": "Privérekening in een beginbalans: toegestaan, maar controleer of dit bedoeld is.",
  prive: "Privérekening in een beginbalans: toegestaan, maar controleer of dit bedoeld is.",
};

/**
 * Niet-blokkerende opmerking bij omzet-, kosten- en privérekeningen. Er wordt
 * geen boekhoudregel uit `categorie` afgeleid; dit is uitsluitend een hint.
 */
export function accountCategoryNote(categorie: string | null | undefined): string | null {
  if (!categorie) return null;
  return CATEGORY_NOTES[categorie.trim().toLowerCase()] ?? null;
}

/**
 * Payload voor save_opening_balance_lines(). Bevat uitsluitend regelgegevens
 * (geen organization_id, client_id of user_id — die leidt de database af);
 * volledig lege rijen worden niet opgeslagen. Bedragen gaan onafgerond mee.
 */
export function buildSaveLinesPayload(lines: readonly OpeningBalanceLineRow[]): OpeningBalanceLinePayload[] {
  return lines
    .filter((line) => !isBlankLine(line))
    .map((line, index) => ({
      sort_order: index,
      grootboekrekening_id: line.grootboekrekening_id || null,
      description: line.description.trim() || null,
      debit_amount: amountForRpc(line.debit_input) ?? Number.NaN,
      credit_amount: amountForRpc(line.credit_input) ?? Number.NaN,
    }));
}

// ── Kop ─────────────────────────────────────────────────────────────────────

export function defaultOpeningDate(year: number): string {
  return `${String(year).padStart(4, "0")}-01-01`;
}

export function defaultDescription(year: number): string {
  return `Beginbalans ${year}`;
}

export function createHeaderForm(year: number): OpeningBalanceHeaderForm {
  return {
    boekjaar: String(year),
    opening_date: defaultOpeningDate(year),
    description: defaultDescription(year),
    reference: "",
  };
}

export function toHeaderForm(header: OpeningBalanceRow): OpeningBalanceHeaderForm {
  return {
    boekjaar: String(header.boekjaar),
    opening_date: header.opening_date,
    description: header.description ?? "",
    reference: header.reference ?? "",
  };
}

/** Jaar uit een ISO-datum ("2027-01-01" → 2027), zonder tijdzone-omweg. */
export function yearOfDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? Number(m[1]) : null;
}

export function parseBoekjaar(raw: string): number | null {
  const m = /^\d{4}$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[0]);
  return year >= 2000 && year <= 2100 ? year : null;
}

/**
 * Bij een ander boekjaar: openingsdatum terug naar 1 januari en de
 * standaardomschrijving mee laten lopen zolang de gebruiker die niet aanpaste.
 */
export function applyBoekjaarChange(
  form: OpeningBalanceHeaderForm,
  rawYear: string,
): OpeningBalanceHeaderForm {
  const previous = parseBoekjaar(form.boekjaar);
  const next = parseBoekjaar(rawYear);
  const description =
    previous !== null && next !== null && form.description === defaultDescription(previous)
      ? defaultDescription(next)
      : form.description;
  return {
    ...form,
    boekjaar: rawYear,
    opening_date: next !== null ? defaultOpeningDate(next) : form.opening_date,
    description,
  };
}

/** Kopfouten die opslaan én boeken blokkeren; de database weigert ze ook (CHECK). */
export function headerIssues(form: OpeningBalanceHeaderForm): string[] {
  const issues: string[] = [];
  const year = parseBoekjaar(form.boekjaar);
  if (year === null) issues.push("Vul een boekjaar in tussen 2000 en 2100.");
  const dateYear = yearOfDate(form.opening_date);
  if (dateYear === null) issues.push("Vul een openingsdatum in.");
  if (year !== null && dateYear !== null && year !== dateYear) {
    issues.push(
      `Openingsdatum ${formatDatumNL(form.opening_date)} valt niet in boekjaar ${year}; v1 ondersteunt alleen kalenderjaren.`,
    );
  }
  return issues;
}

export function formatDatumNL(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}-${m}-${y}` : iso;
}

export function formatTijdstipNL(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  return new Intl.DateTimeFormat("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Kop-payload voor de gewone PostgREST insert. `organization_id` gaat bewust
 * niet mee (public.set_organization_id() leidt hem af uit client_id); de drie
 * nihil-kolommen nooit (geen kolomrecht; alleen de RPC schrijft ze).
 */
export function buildHeaderInsertPayload(
  form: OpeningBalanceHeaderForm,
  clientId: string,
): {
  client_id: string;
  boekjaar: number;
  opening_date: string;
  description: string | null;
  reference: string | null;
} {
  return {
    client_id: clientId,
    boekjaar: parseBoekjaar(form.boekjaar) ?? Number.NaN,
    opening_date: form.opening_date,
    description: form.description.trim() || null,
    reference: form.reference.trim() || null,
  };
}

/** Update-payload: alleen de kolommen waarop authenticated UPDATE-recht heeft. */
export function buildHeaderUpdatePayload(form: OpeningBalanceHeaderForm): {
  boekjaar: number;
  opening_date: string;
  description: string | null;
  reference: string | null;
} {
  const { client_id: _clientId, ...rest } = buildHeaderInsertPayload(form, "");
  return rest;
}

export function headerSnapshot(form: OpeningBalanceHeaderForm): string {
  return JSON.stringify(buildHeaderUpdatePayload(form));
}

export function linesSnapshot(lines: readonly OpeningBalanceLineRow[]): string {
  // De payload is de vergelijkingsbasis: twee lege rijen en géén rij zijn
  // hetzelfde concept, en "100" en "100,00" zijn hetzelfde bedrag.
  return JSON.stringify(
    buildSaveLinesPayload(lines).map((l) => ({
      ...l,
      debit_amount: String(l.debit_amount),
      credit_amount: String(l.credit_amount),
    })),
  );
}

export function isHeaderDirty(
  form: OpeningBalanceHeaderForm,
  persisted: OpeningBalanceHeaderForm | null,
): boolean {
  if (!persisted) return true;
  return headerSnapshot(form) !== headerSnapshot(persisted);
}

export function areLinesDirty(
  lines: readonly OpeningBalanceLineRow[],
  persisted: readonly OpeningBalanceLineRow[] | null,
): boolean {
  if (!persisted) return true;
  return linesSnapshot(lines) !== linesSnapshot(persisted);
}

// ── Toestand ────────────────────────────────────────────────────────────────

export type OpeningBalanceState =
  | { kind: "none"; otherDrafts: OpeningBalanceRow[] }
  | { kind: "draft"; header: OpeningBalanceRow; otherDrafts: OpeningBalanceRow[] }
  | { kind: "multiple-drafts"; drafts: OpeningBalanceRow[]; otherDrafts: OpeningBalanceRow[] }
  | {
      kind: "posted";
      header: OpeningBalanceRow | null;
      marker: OpeningBalanceMarker;
      /** Concepten die na het boeken zijn achtergebleven; alleen nog te verwijderen. */
      leftoverDrafts: OpeningBalanceRow[];
    }
  | { kind: "nil"; header: OpeningBalanceRow; leftoverDrafts: OpeningBalanceRow[] }
  | { kind: "conflict"; message: string };

export function isNilHeader(header: Pick<OpeningBalanceRow, "nil_declaration" | "nil_declared_at">): boolean {
  return header.nil_declaration === true && header.nil_declared_at !== null;
}

export const CONFLICT_POSTED_AND_NIL =
  "Deze administratie heeft zowel een geboekte beginbalans als een nihil-verklaring. Dat kan niet naast elkaar bestaan; de pagina is uit veiligheid alleen-lezen. Neem contact op met de beheerder.";

export const CONFLICT_TWO_NIL =
  "Deze administratie heeft meer dan één nihil-verklaring voor de beginbalans. Dat kan niet; de pagina is uit veiligheid alleen-lezen. Neem contact op met de beheerder.";

export const CONFLICT_HALF_NIL =
  "Een beginbalans van deze administratie heeft een onvolledige nihil-verklaring. De pagina is uit veiligheid alleen-lezen. Neem contact op met de beheerder.";

/**
 * De toestand van de beginbalans van één administratie, uitsluitend afgeleid
 * uit de claimtabel en de kop. "Geen beginbalans" en "bewust nihil" worden
 * nooit samengevoegd; een geboekte of nihil-bewering geldt voor de hele
 * administratie (ongeacht het gekozen jaar), concepten worden per boekjaar
 * gezocht en bij meer dan één concept wordt er nooit stilzwijgend gekozen.
 * Concepten die naast een geboekte of nihil-bewering zijn blijven staan,
 * blijven zichtbaar zodat ze opgeruimd kunnen worden.
 */
export function deriveOpeningBalanceState(input: {
  headers: readonly OpeningBalanceRow[];
  marker: OpeningBalanceMarker | null;
  boekjaar: number | null;
}): OpeningBalanceState {
  const { headers, marker, boekjaar } = input;
  const halfNil = headers.filter(
    (h) => (h.nil_declaration === true) !== (h.nil_declared_at !== null),
  );
  if (halfNil.length > 0) return { kind: "conflict", message: CONFLICT_HALF_NIL };
  const nilHeaders = headers.filter(isNilHeader);
  if (marker && nilHeaders.length > 0) return { kind: "conflict", message: CONFLICT_POSTED_AND_NIL };
  if (nilHeaders.length > 1) return { kind: "conflict", message: CONFLICT_TWO_NIL };
  if (marker) {
    return {
      kind: "posted",
      header: headers.find((h) => h.id === marker.opening_balance_id) ?? null,
      marker,
      leftoverDrafts: headers.filter((h) => h.id !== marker.opening_balance_id),
    };
  }
  if (nilHeaders.length === 1) {
    return {
      kind: "nil",
      header: nilHeaders[0],
      leftoverDrafts: headers.filter((h) => h.id !== nilHeaders[0].id),
    };
  }
  const drafts = headers.filter((h) => h.boekjaar === boekjaar);
  const otherDrafts = headers.filter((h) => h.boekjaar !== boekjaar);
  if (drafts.length === 0) return { kind: "none", otherDrafts };
  if (drafts.length === 1) return { kind: "draft", header: drafts[0], otherDrafts };
  return { kind: "multiple-drafts", drafts, otherDrafts };
}

// ── Poorten (UX, nooit autoriteit) ──────────────────────────────────────────

export interface OpeningBalancePostingGateInput {
  openingBalanceId: string | null;
  /** Claimtabel is niet bevraagbaar (deploy-venster of schemafout). */
  markerUnavailable: boolean;
  /** Claim of overzicht nog aan het laden: de toestand is onzeker. */
  stateUncertain: boolean;
  /** Rolcontrole: undefined = nog onbekend. */
  canPost: boolean | undefined;
  isDirty: boolean;
  isSaving: boolean;
  header: OpeningBalanceHeaderForm;
  lines: readonly OpeningBalanceLineRow[];
  accountsById: ReadonlyMap<string, OpeningBalanceAccountRef>;
  clientId: string;
}

/**
 * De eerste reden waarom boeken nu niet kan, of null. Puur UX — elke regel
 * hieronder wordt server-side opnieuw gecontroleerd, en de database kent
 * bovendien regels die de client niet kan zien (afgesloten boekjaar, eerdere
 * grootboekfeiten, de echte rol). Een lege uitkomst betekent "niet kansloos",
 * niet "gegarandeerd goed".
 */
export function firstPostingBlockingReason(input: OpeningBalancePostingGateInput): string | null {
  if (input.markerUnavailable) return SCHEMA_UNAVAILABLE_MESSAGE;
  if (input.stateUncertain) return "Boekingsstatus wordt geladen…";
  if (!input.openingBalanceId) return "Sla de beginbalans eerst op.";
  if (input.isSaving) return "Opslaan is nog bezig…";
  if (input.isDirty) return "Er zijn niet-opgeslagen wijzigingen. Sla eerst op.";
  if (input.canPost === undefined) return "Rechten worden gecontroleerd…";
  if (!input.canPost) return "Alleen een accountant kan een beginbalans boeken.";
  const header = headerIssues(input.header);
  if (header.length > 0) return header[0];
  if (!input.header.description.trim()) return "Vul een omschrijving in.";

  const lines = input.lines.filter((l) => !isBlankLine(l));
  if (lines.length < 2) return "Een beginbalans heeft minimaal twee regels: een debet- en een creditregel.";
  for (const line of lines) {
    const issues = lineIssues(line, input.accountsById, input.clientId);
    if (issues.length > 0) return issues[0].message;
  }
  if (lines.some((l) => !l.grootboekrekening_id)) return "Elke regel heeft een grootboekrekening nodig.";
  for (const line of lines) {
    const debit = parseExactAmount(line.debit_input);
    const credit = parseExactAmount(line.credit_input);
    const debitCents = debit.kind === "ok" ? debit.cents : 0;
    const creditCents = credit.kind === "ok" ? credit.cents : 0;
    if (debitCents === 0 && creditCents === 0) return "Elke regel heeft een bedrag nodig.";
  }
  const totals = lineTotals(lines);
  if (totals.debitCents <= 0 || totals.creditCents <= 0) {
    return "Een beginbalans heeft zowel een debet- als een creditbedrag groter dan nul nodig.";
  }
  if (totals.differenceCents !== 0) {
    return `Debet en credit zijn niet gelijk (verschil ${formatCentsEuro(totals.differenceCents)}).`;
  }
  return null;
}

export interface OpeningBalanceNilGateInput {
  openingBalanceId: string | null;
  markerUnavailable: boolean;
  stateUncertain: boolean;
  canDeclare: boolean | undefined;
  isHeaderDirty: boolean;
  isSaving: boolean;
  header: OpeningBalanceHeaderForm;
  /** Regels zoals ze in de database staan — die telt de RPC. */
  savedLineCount: number;
  lines: readonly OpeningBalanceLineRow[];
}

export function firstNilBlockingReason(input: OpeningBalanceNilGateInput): string | null {
  if (input.markerUnavailable) return SCHEMA_UNAVAILABLE_MESSAGE;
  if (input.stateUncertain) return "Boekingsstatus wordt geladen…";
  if (!input.openingBalanceId) return "Sla de beginbalans eerst op (zonder regels).";
  if (input.isSaving) return "Opslaan is nog bezig…";
  if (input.isHeaderDirty) return "Er zijn niet-opgeslagen wijzigingen aan de kop. Sla eerst op.";
  if (input.canDeclare === undefined) return "Rechten worden gecontroleerd…";
  if (!input.canDeclare) return "Alleen een accountant kan vastleggen dat er geen beginbalans nodig is.";
  const header = headerIssues(input.header);
  if (header.length > 0) return header[0];
  if (input.savedLineCount > 0) {
    return `Deze beginbalans heeft ${input.savedLineCount} opgeslagen regel(s); verwijder ze en sla op voordat je op nihil verklaart.`;
  }
  if (input.lines.some((l) => !isBlankLine(l))) {
    return "Er staan nog regels in het formulier; verwijder ze eerst.";
  }
  return null;
}

// ── Fouten ──────────────────────────────────────────────────────────────────

export type OpeningBalanceErrorKind =
  | "schema"
  | "duplicate"
  | "permission"
  | "stale"
  | "deadlock"
  | "validation"
  | "unknown";

export interface ClassifiedOpeningBalanceError {
  kind: OpeningBalanceErrorKind;
  code: string;
  message: string;
}

const SCHEMA_CODES = new Set(["PGRST202", "PGRST204", "PGRST205", "42P01", "42883"]);
const VALIDATION_CODES = new Set(["22023", "23514", "22004", "22P02", "P0002", "28000", "25000"]);

export const NETWORK_MESSAGE =
  "Netwerkfout: de server is niet bereikbaar. Controleer de verbinding en probeer opnieuw.";
export const SESSION_EXPIRED_MESSAGE = "Je sessie is verlopen. Log opnieuw in en probeer het nog eens.";
export const AMOUNT_OVERFLOW_MESSAGE = "Een bedrag is te groot voor de database (maximaal 9.999.999.999,99).";

const CHECK_CONSTRAINT_MESSAGES: Record<string, string> = {
  opening_balances_boekjaar_matches_date_check:
    "Boekjaar en openingsdatum horen niet bij elkaar; v1 ondersteunt alleen kalenderjaren.",
  opening_balances_boekjaar_check: "Boekjaar moet tussen 2000 en 2100 liggen.",
  opening_balances_opening_date_check: "Openingsdatum moet tussen 2000 en 2100 liggen.",
  opening_balance_lines_debit_amount_check: "Negatieve bedragen worden niet ondersteund.",
  opening_balance_lines_credit_amount_check: "Negatieve bedragen worden niet ondersteund.",
  opening_balance_lines_single_side_check: "Een regel kan niet tegelijk debet en credit zijn.",
  opening_balance_lines_no_nan_check: "Bedragen moeten getallen zijn.",
};

const UNIQUE_INDEX_MESSAGES: Record<string, string> = {
  uniq_opening_balance_postings_client: "Deze administratie heeft al een geboekte beginbalans.",
  uniq_opening_balance_nil_per_client: "Deze administratie heeft al een nihil-verklaring voor de beginbalans.",
  opening_balance_postings_pkey: "Deze beginbalans is al geboekt.",
};

function looksLikeRawPostgres(raw: string): boolean {
  return (
    raw === "" ||
    /^[A-Z]{2}\d{3}/.test(raw) ||
    /violates|constraint|relation|syntax error|permission denied|stack depth|null value in column/i.test(raw)
  );
}

/**
 * Vertaal een fout naar iets dat we kunnen tonen én waarop de UI kan
 * beslissen. De RPC's geven nette Nederlandse meldingen; alleen rauwe
 * PostgreSQL-/driver-/schemafouten worden vervangen door een neutrale tekst.
 * Er wordt nooit een SQLSTATE letterlijk getoond.
 */
export function classifyOpeningBalanceError(error: unknown): ClassifiedOpeningBalanceError {
  const err = (error ?? {}) as { code?: string; message?: string; kind?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return { kind: "schema", code, message: SCHEMA_UNAVAILABLE_MESSAGE };
  }
  // Een mislukte fetch is een TypeError zonder code, geen PostgREST-fout.
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return { kind: "unknown", code: code || "netwerk", message: NETWORK_MESSAGE };
  }
  if (code === "PGRST301" || /jwt expired|invalid jwt/i.test(raw)) {
    return { kind: "permission", code: code || "PGRST301", message: SESSION_EXPIRED_MESSAGE };
  }
  if (code === "22003") {
    return { kind: "validation", code, message: AMOUNT_OVERFLOW_MESSAGE };
  }
  if (code === "40P01" || /deadlock detected/i.test(raw)) {
    return { kind: "deadlock", code: "40P01", message: DEADLOCK_MESSAGE };
  }
  if (code === "40001") {
    return { kind: "stale", code, message: STALE_MESSAGE };
  }
  if (code === "23505") {
    const index = Object.keys(UNIQUE_INDEX_MESSAGES).find((name) => raw.includes(name));
    const message = index
      ? UNIQUE_INDEX_MESSAGES[index]
      : looksLikeRawPostgres(raw)
        ? "Deze beginbalans is al vastgelegd, of deze administratie heeft er al een."
        : raw;
    return { kind: "duplicate", code, message };
  }
  if (code === "42501") {
    return {
      kind: "permission",
      code,
      message: looksLikeRawPostgres(raw)
        ? "Je hebt geen rechten voor deze actie, of de beginbalans is niet meer te wijzigen."
        : raw,
    };
  }
  if (code === "23503") {
    return {
      kind: "validation",
      code,
      message: "De beginbalans verwijst naar een record dat niet (meer) bestaat. Ververs de pagina.",
    };
  }
  if (code === "23514" && /violates check constraint/i.test(raw)) {
    const name = Object.keys(CHECK_CONSTRAINT_MESSAGES).find((n) => raw.includes(n));
    return {
      kind: "validation",
      code,
      message: name
        ? CHECK_CONSTRAINT_MESSAGES[name]
        : "De beginbalans voldoet niet aan een databaseregel en is geweigerd.",
    };
  }
  if (VALIDATION_CODES.has(code)) {
    return {
      kind: "validation",
      code,
      message: looksLikeRawPostgres(raw) ? "De beginbalans is geweigerd door de database." : raw,
    };
  }
  if (looksLikeRawPostgres(raw)) {
    return { kind: "unknown", code, message: "De actie is niet gelukt. Probeer het opnieuw." };
  }
  return { kind: "unknown", code, message: raw };
}

/** Alleen veilige metadata: nooit de melding zelf (die kan bedragen bevatten). */
export function safeErrorMetadata(error: unknown): { code: string; kind: OpeningBalanceErrorKind } {
  const classified = classifyOpeningBalanceError(error);
  return { code: classified.code || "onbekend", kind: classified.kind };
}

/** Een competerende toestand: eerst opnieuw ophalen en de waarheid tonen. */
export function isCompetingStateError(kind: OpeningBalanceErrorKind): boolean {
  return kind === "duplicate" || kind === "stale" || kind === "permission";
}
