/**
 * Fase 6C-b6 (PR 2) — pure logica voor memoriaalboekingen.
 *
 * Alles wat hier staat is presentatie- en invoerlogica: totalen, zijde-exclusieve
 * invoer, de payload voor save_manual_journal_lines() en de eerste blokkerende
 * reden voor de boekknop. Het is nadrukkelijk GEEN tweede implementatie van de
 * boekhoudregels: public.post_manual_journal() keurt server-side alles opnieuw
 * (rekeningbereik, niet-actieve rekeningen, afgesloten boekjaar, rechten,
 * balans, NaN, decimalen) en is de enige autoriteit. De hints hier voorkomen
 * alleen een kansloze klik.
 *
 * Bedragen worden bewust NIET client-side afgerond: 0,005 gaat als 0.005 de
 * deur uit, zodat de RPC hem kan weigeren ("Bedragen mogen maximaal twee
 * decimalen hebben") in plaats van dat de frontend er stilletjes 0,01 van maakt.
 */

import { round2 } from "@/lib/btw-calc";
import { formatAmountInput, parseAmountInput, parseAmountInputOrZero } from "@/lib/amount-input";
import type { Tables } from "@/integrations/supabase/types";

export { round2 };
/** nl-NL invoer → number. Hergebruikt de bestaande app-conventie (komma én punt). */
export const parseAmount = parseAmountInput;
export const parseAmountOrZero = parseAmountInputOrZero;
/** number → nl-NL invoerstring (komma, twee decimalen, geen duizendtalscheiding). */
export const formatAmount = formatAmountInput;

type Grootboekrekening = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "omschrijving">;
export type ManualJournalRow = Tables<"manual_journals">;
export type ManualJournalLineRecord = Tables<"manual_journal_lines">;
export type ManualJournalMarker = Tables<"manual_journal_postings">;

/** Eén bewerkbare regel in het formulier. `id` is null zolang de regel nieuw is. */
export interface ManualJournalLineRow {
  /** Stabiele React-key; overleeft verwijderen/toevoegen. */
  key: string;
  id: string | null;
  omschrijving: string;
  grootboekrekening_id: string | null;
  grootboek_label: string;
  debit_input: string;
  credit_input: string;
}

export interface ManualJournalHeaderForm {
  client_id: string;
  posting_date: string;
  description: string;
  reference: string;
}

/** Eén element van het `_lines` jsonb-argument van save_manual_journal_lines(). */
export interface ManualJournalLinePayload {
  sort_order: number;
  grootboekrekening_id: string | null;
  omschrijving: string | null;
  debit_amount: number;
  credit_amount: number;
}

export interface ManualJournalTotals {
  debit: number;
  credit: number;
  /** debet − credit, afgerond op centen zodat 0 ook echt 0 toont. */
  difference: number;
  isBalanced: boolean;
}

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `mj-line-${keyCounter}`;
}

export function createEmptyLineRow(): ManualJournalLineRow {
  return {
    key: nextKey(),
    id: null,
    omschrijving: "",
    grootboekrekening_id: null,
    grootboek_label: "",
    debit_input: "",
    credit_input: "",
  };
}

/** Een nieuw concept begint met twee lege regels: debet en credit. */
export function createEmptyLineRows(count = 2): ManualJournalLineRow[] {
  return Array.from({ length: Math.max(0, count) }, () => createEmptyLineRow());
}

export function createEmptyHeaderForm(
  clientId = "",
  postingDate = new Date().toISOString().split("T")[0],
): ManualJournalHeaderForm {
  return { client_id: clientId, posting_date: postingDate, description: "", reference: "" };
}

export function formatAccountLabel(account: Grootboekrekening): string {
  return `${account.nummer} - ${account.omschrijving}`;
}

/** Label voor een opgeslagen regel; leeg wanneer de rekening (nog) onbekend is. */
export function resolveAccountLabel(
  accountId: string | null | undefined,
  accounts: Grootboekrekening[] | undefined,
): string {
  if (!accountId || !accounts) return "";
  const account = accounts.find((a) => a.id === accountId);
  return account ? formatAccountLabel(account) : "";
}

export function toLineRows(
  lines: ManualJournalLineRecord[] | undefined,
  accounts: Grootboekrekening[] | undefined,
): ManualJournalLineRow[] {
  return (lines ?? []).map((line) => ({
    key: `mj-line-db-${line.id}`,
    id: line.id,
    omschrijving: line.omschrijving ?? "",
    grootboekrekening_id: line.grootboekrekening_id ?? null,
    grootboek_label: resolveAccountLabel(line.grootboekrekening_id, accounts),
    debit_input: Number(line.debit_amount) === 0 ? "" : formatAmount(Number(line.debit_amount)),
    credit_input: Number(line.credit_amount) === 0 ? "" : formatAmount(Number(line.credit_amount)),
  }));
}

export function toHeaderForm(journal: ManualJournalRow): ManualJournalHeaderForm {
  return {
    client_id: journal.client_id,
    posting_date: journal.posting_date,
    description: journal.description ?? "",
    reference: journal.reference ?? "",
  };
}

/**
 * Zijde-exclusieve invoer: een bedrag op debet wist credit en omgekeerd.
 * Wissen (leeg of 0) raakt de andere zijde nooit, anders kun je een typefout
 * niet meer corrigeren zonder de regel weg te gooien.
 */
export function applyDebitInput(row: ManualJournalLineRow, raw: string): ManualJournalLineRow {
  const value = parseAmount(raw);
  const clearsOther = value !== null && value !== 0;
  return { ...row, debit_input: raw, credit_input: clearsOther ? "" : row.credit_input };
}

export function applyCreditInput(row: ManualJournalLineRow, raw: string): ManualJournalLineRow {
  const value = parseAmount(raw);
  const clearsOther = value !== null && value !== 0;
  return { ...row, credit_input: raw, debit_input: clearsOther ? "" : row.debit_input };
}

export function lineTotals(lines: ManualJournalLineRow[]): ManualJournalTotals {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += parseAmountOrZero(line.debit_input);
    credit += parseAmountOrZero(line.credit_input);
  }
  const roundedDebit = round2(debit);
  const roundedCredit = round2(credit);
  return {
    debit: roundedDebit,
    credit: roundedCredit,
    difference: round2(roundedDebit - roundedCredit),
    // "In balans" alleen wanneer er ook echt iets geboekt wordt: 0 = 0 is geen boeking.
    isBalanced: roundedDebit === roundedCredit && roundedDebit > 0,
  };
}

/**
 * Bedrag voor de lijst. Geboekt → het bedrag uit de claimtabel (de waarheid).
 * Concept → de debetzijde, of, zolang die leeg is, de creditzijde: het bedrag
 * dat de gebruiker aan het invoeren is.
 */
export function manualJournalListAmount(
  marker: Pick<ManualJournalMarker, "total_amount"> | null | undefined,
  lines: ManualJournalLineRow[],
): number {
  if (marker) return Number(marker.total_amount);
  const totals = lineTotals(lines);
  return totals.debit > 0 ? totals.debit : totals.credit;
}

/**
 * Payload voor save_manual_journal_lines(). Bevat uitsluitend regelgegevens:
 * geen organization_id, geen user_id, geen client_id — die leidt de database af
 * (organisatie via trigger uit de kop, gebruiker via auth.uid()).
 */
export function buildSaveLinesPayload(lines: ManualJournalLineRow[]): ManualJournalLinePayload[] {
  return lines.map((line, index) => ({
    sort_order: index,
    grootboekrekening_id: line.grootboekrekening_id || null,
    omschrijving: line.omschrijving.trim() || null,
    debit_amount: parseAmountOrZero(line.debit_input),
    credit_amount: parseAmountOrZero(line.credit_input),
  }));
}

/**
 * Kop-payload voor de gewone PostgREST insert/update. `organization_id` gaat
 * bewust niet mee: public.set_organization_id() leidt hem af uit client_id.
 * `user_id` wél — het INSERT-beleid eist `user_id = auth.uid()`.
 */
export function buildHeaderPayload(form: ManualJournalHeaderForm): {
  client_id: string;
  posting_date: string;
  description: string | null;
  reference: string | null;
} {
  return {
    client_id: form.client_id,
    posting_date: form.posting_date,
    description: form.description.trim() || null,
    reference: form.reference.trim() || null,
  };
}

/**
 * Vergelijkbare momentopname van het formulier. Wordt gebruikt om te bepalen of
 * er niet-opgeslagen wijzigingen zijn: boeken op een verouderde opgeslagen
 * toestand is de fout die in 6C-b4 op de verkoopdialoog is gevonden.
 */
export function manualJournalSnapshot(
  header: ManualJournalHeaderForm,
  lines: ManualJournalLineRow[],
): string {
  return JSON.stringify({
    header: buildHeaderPayload(header),
    lines: buildSaveLinesPayload(lines),
  });
}

export function isManualJournalDirty(
  header: ManualJournalHeaderForm,
  lines: ManualJournalLineRow[],
  persistedHeader: ManualJournalHeaderForm | null,
  persistedLines: ManualJournalLineRow[] | null,
): boolean {
  if (!persistedHeader || !persistedLines) return true;
  return (
    manualJournalSnapshot(header, lines) !== manualJournalSnapshot(persistedHeader, persistedLines)
  );
}

export interface PostingGateInput {
  /** Kop is opgeslagen en heeft een id. */
  journalId: string | null;
  /** Claimtabel is (nog) niet bevraagbaar — deploy-venster. */
  markerUnavailable: boolean;
  markerPending: boolean;
  /** Rolcontrole: undefined = nog onbekend. */
  canPost: boolean | undefined;
  isDirty: boolean;
  header: ManualJournalHeaderForm;
  lines: ManualJournalLineRow[];
}

/**
 * De eerste reden waarom boeken nu niet kan, of null. Puur UX — elke regel
 * hieronder wordt server-side opnieuw gecontroleerd, en de database kent
 * bovendien regels die de client niet kan zien (rekeningbereik, niet-actieve
 * rekening, afgesloten boekjaar). Een lege uitkomst betekent dus "niet
 * kansloos", niet "gegarandeerd goed".
 */
export function firstBlockingReason(input: PostingGateInput): string | null {
  if (input.markerUnavailable) {
    return "Boeken in het grootboek is nog niet beschikbaar voor memoriaalboekingen.";
  }
  if (input.markerPending) return "Boekingsstatus wordt geladen…";
  if (!input.journalId) return "Sla de memoriaalboeking eerst op.";
  if (input.isDirty) return "Er zijn niet-opgeslagen wijzigingen. Sla eerst op.";
  if (input.canPost === undefined) return "Rechten worden gecontroleerd…";
  if (!input.canPost) return "Alleen een accountant kan een memoriaalboeking boeken.";
  if (!input.header.posting_date) return "Vul een boekingsdatum in.";
  if (!input.header.description.trim()) return "Vul een omschrijving in.";

  const lines = input.lines;
  if (lines.length < 2) return "Een memoriaalboeking heeft minimaal twee regels.";
  if (lines.some((l) => !l.grootboekrekening_id)) {
    return "Elke regel heeft een grootboekrekening nodig.";
  }

  for (const line of lines) {
    const debit = parseAmountOrZero(line.debit_input);
    const credit = parseAmountOrZero(line.credit_input);
    if (debit < 0 || credit < 0) {
      return "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde.";
    }
    if (debit !== 0 && credit !== 0) return "Een regel kan niet tegelijk debet en credit zijn.";
    if (debit === 0 && credit === 0) return "Elke regel heeft een bedrag nodig.";
  }

  const totals = lineTotals(lines);
  if (totals.debit <= 0 || totals.credit <= 0) {
    return "Een memoriaalboeking heeft zowel een debet- als een creditbedrag nodig.";
  }
  if (!totals.isBalanced) return "Debet en credit zijn niet gelijk.";
  return null;
}

export type ManualJournalErrorKind =
  | "duplicate"
  | "permission"
  | "validation"
  | "schema"
  | "unknown";

export interface ClassifiedManualJournalError {
  kind: ManualJournalErrorKind;
  message: string;
}

const SCHEMA_CODES = new Set(["PGRST204", "PGRST205", "42P01", "42883"]);
const VALIDATION_CODES = new Set(["22023", "23514", "22004", "P0002", "28000"]);

/**
 * Vertaal een RPC-fout naar iets dat we kunnen tonen én waarop de UI kan
 * beslissen. De database geeft nette Nederlandse meldingen terug; alleen
 * rauwe driver-/schemafouten worden vervangen door een neutrale tekst.
 */
export function classifyManualJournalError(error: unknown): ClassifiedManualJournalError {
  const err = (error ?? {}) as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : "";
  const raw = typeof err.message === "string" ? err.message.trim() : "";

  if (SCHEMA_CODES.has(code) || /schema cache/i.test(raw)) {
    return {
      kind: "schema",
      message: "Boeken in het grootboek is nog niet beschikbaar voor memoriaalboekingen.",
    };
  }
  if (code === "23505" || /al geboekt/i.test(raw)) {
    return { kind: "duplicate", message: "Deze memoriaalboeking is al geboekt." };
  }
  if (code === "42501") {
    return {
      kind: "permission",
      message: raw || "Je hebt geen rechten voor deze actie, of de boeking is niet meer te wijzigen.",
    };
  }
  if (code === "23503") {
    // Een FK-schending komt als Engelse PostgreSQL-tekst met constraintnamen
    // binnen; die tonen we nooit letterlijk.
    return {
      kind: "validation",
      message: "De boeking verwijst naar een record dat niet (meer) bestaat. Ververs de pagina.",
    };
  }
  if (VALIDATION_CODES.has(code)) {
    return { kind: "validation", message: raw || "De boeking is geweigerd door de database." };
  }
  if (!raw || /^[A-Z]{2}\d{3}/.test(raw) || raw.includes("stack depth")) {
    return { kind: "unknown", message: "Boeken is niet gelukt. Probeer het opnieuw." };
  }
  return { kind: "unknown", message: raw };
}

/** Vaste tekst na een geslaagde boeking; correctie kan alleen met een tegenboeking. */
export const POSTED_NOTICE =
  "Deze memoriaalboeking is geboekt. Een correctie vereist een tegenboeking.";

/** Vaste, terughoudende hint: BTW is in v1 gewoon een regel. */
export const VAT_HINT = "BTW boek je als aparte regel op de BTW-rekening.";
