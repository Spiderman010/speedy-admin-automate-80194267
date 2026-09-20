/**
 * Bank-inhaalslag — de zuivere laag.
 *
 * WAT DIT WEL DOET
 * De uitkomst van twee server-side functies leesbaar maken: tellen, groeperen,
 * een te grote lijst in aanvaardbare partijen knippen, en een onverwachte
 * driverfout vertalen naar iets dat een mens kan lezen.
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen enkel boekhoudkundig oordeel. Er wordt hier geen bedrag berekend, geen
 * BTW gesplitst, geen debet- of creditzijde gekozen, geen rekening gekozen,
 * geen boekjaar afgeleid en geen datum bepaald. Er staat ook geen enkel
 * rekeningNUMMER in dit bestand en er wordt er nooit een verondersteld.
 *
 * De werkstroomtoestand van een bankregel komt uit
 * `public.bank_bulk_posting_candidates()`; de uitkomst van een boeking uit
 * `public.post_bank_transactions_bulk()`, die per regel
 * `public.post_bank_transaction()` aanroept. Die laatste is en blijft de enige
 * autoriteit over wat er in het grootboek belandt. Zegt de preflight `ready`
 * en weigert de schrijver alsnog, dan heeft de schrijver gelijk.
 */

/**
 * Vier WERKSTROOMtoestanden. Zij beantwoorden "heeft het zin dit aan te
 * bieden?", niet "mag dit geboekt worden?".
 */
export type BankBulkWorkflowState = "ready" | "review_needed" | "blocked" | "posted";

export interface BankBulkCandidate {
  transaction_id: string;
  transaction_date: string;
  amount: number | string;
  description: string | null;
  counter_account: string | null;
  match_status: string;
  grootboekrekening_id: string | null;
  btw_percentage: number | string | null;
  is_posted: boolean;
  is_allocated: boolean;
  posting_group_id: string | null;
  workflow_state: BankBulkWorkflowState;
  /** Gevuld zodra de toestand niet `ready` of `posted` is. */
  reason: string | null;
}

/** Drie uitkomsten, meer zijn er niet. */
export type BankBulkOutcome = "posted" | "already_posted" | "rejected";

export interface BankBulkResult {
  ordinal: number;
  transaction_id: string;
  outcome: BankBulkOutcome;
  posting_group_id: string | null;
  error_code: string | null;
  message: string | null;
}

/**
 * Dezelfde bovengrens als in de migratie (20260922120000). Staat hier zodat de
 * frontend een te lange lijst zélf in partijen aanbiedt in plaats van een
 * voorspelbare serverweigering te incasseren. Wijkt hij ooit af van de
 * database, dan wint de database: die weigert met 54000.
 */
export const BANK_BULK_MAX_BATCH = 500;

export interface BankBulkCandidateSummary {
  total: number;
  ready: number;
  reviewNeeded: number;
  blocked: number;
  posted: number;
}

export function summariseCandidates(rows: readonly BankBulkCandidate[]): BankBulkCandidateSummary {
  return {
    total: rows.length,
    ready: rows.filter((r) => r.workflow_state === "ready").length,
    reviewNeeded: rows.filter((r) => r.workflow_state === "review_needed").length,
    blocked: rows.filter((r) => r.workflow_state === "blocked").length,
    posted: rows.filter((r) => r.workflow_state === "posted").length,
  };
}

/** De id's die de server zelf `ready` noemt — nooit een eigen selectie. */
export function readyTransactionIds(rows: readonly BankBulkCandidate[]): string[] {
  return rows.filter((r) => r.workflow_state === "ready").map((r) => r.transaction_id);
}

/**
 * Een lijst in partijen knippen die de database aanvaardt. Dit is geen
 * herkansing: elke id wordt precies één keer aangeboden, in de opgegeven
 * volgorde.
 */
export function chunkTransactionIds(
  ids: readonly string[],
  size: number = BANK_BULK_MAX_BATCH,
): string[][] {
  const limit = Math.max(1, Math.min(size, BANK_BULK_MAX_BATCH));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += limit) {
    chunks.push(ids.slice(i, i + limit));
  }
  return chunks;
}

export interface BankBulkRunSummary {
  total: number;
  posted: number;
  alreadyPosted: number;
  rejected: number;
}

export function summariseBulkResults(results: readonly BankBulkResult[]): BankBulkRunSummary {
  return {
    total: results.length,
    posted: results.filter((r) => r.outcome === "posted").length,
    alreadyPosted: results.filter((r) => r.outcome === "already_posted").length,
    rejected: results.filter((r) => r.outcome === "rejected").length,
  };
}

/** De geweigerde regels, met de reden die de database zelf gaf. */
export function rejectedResults(results: readonly BankBulkResult[]): BankBulkResult[] {
  return results.filter((r) => r.outcome === "rejected");
}

/**
 * Bestaan de nieuwe functies nog niet in de database waar deze frontend tegen
 * praat, dan is dat een deploy-venster — geen storing en zeker geen "er is
 * niets te boeken". De aanroeper hoort dat verschil te kunnen zien.
 */
const DEPLOY_WINDOW_CODES = new Set(["PGRST202", "PGRST203", "PGRST204", "PGRST205", "42883", "42P01"]);

export function isDeployWindowError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return !!code && DEPLOY_WINDOW_CODES.has(code);
}

/**
 * De database geeft nette Nederlandse meldingen. Alleen wanneer er tóch iets
 * onverwachts doorkomt, tonen we een neutrale tekst in plaats van een ruwe
 * driverfout — dezelfde lijn als `useBankTransactionPosting`.
 */
export function bulkErrorMessage(error: unknown): string {
  if (isDeployWindowError(error)) {
    return "Bulkboeken is nog niet beschikbaar voor deze omgeving.";
  }
  const message = (error as { message?: string } | null)?.message?.trim();
  if (!message) return "Boeken is niet gelukt. Probeer het opnieuw.";
  if (/^[A-Z0-9]{5}\b/.test(message) || message.includes("stack depth")) {
    return "Boeken is niet gelukt. Probeer het opnieuw.";
  }
  return message;
}

// ── Presentatie ─────────────────────────────────────────────────────────────
//
// Alles hieronder is weergave en selectie. Er wordt nog steeds geen enkel
// boekhoudkundig oordeel geveld: de toestanden komen van de server en worden
// hier alleen van een Nederlands label voorzien, gefilterd en geteld.

/** Nederlandse labels. Zij veranderen de betekenis van de servertoestand niet. */
export const WORKFLOW_LABELS: Record<BankBulkWorkflowState, string> = {
  ready: "Gereed",
  review_needed: "Controle nodig",
  blocked: "Geblokkeerd",
  posted: "Geboekt",
};

/**
 * Status wordt nooit alleen met kleur verteld: elke badge draagt haar label,
 * en de rij draagt de servertoestand ook als data-attribuut.
 */
export const WORKFLOW_BADGE_VARIANT: Record<
  BankBulkWorkflowState,
  "default" | "secondary" | "destructive" | "outline"
> = {
  ready: "default",
  review_needed: "outline",
  blocked: "destructive",
  posted: "secondary",
};

/**
 * Wat langs de gewone weg aangeboden mag worden: uitsluitend `ready`.
 *
 * `review_needed` is bewust NIET selecteerbaar. Die rijen blijven volledig
 * inspecteerbaar, maar ze meesturen zou suggereren dat ze geldig zijn terwijl
 * de server juist zegt dat er nog iets aan moet gebeuren — en de weigering zou
 * dan pas ná de bulkactie zichtbaar worden. `blocked` en `posted` evenmin.
 */
export function isSelectable(row: BankBulkCandidate): boolean {
  return row.workflow_state === "ready";
}

export function selectableCandidates(rows: readonly BankBulkCandidate[]): BankBulkCandidate[] {
  return rows.filter(isSelectable);
}

export interface CandidateFilter {
  /** Vrije tekst over omschrijving, tegenrekening en bedrag. */
  search?: string;
  /** `null` = alle toestanden. */
  state?: BankBulkWorkflowState | null;
  /** Alleen wat aandacht vraagt: controle nodig of geblokkeerd. */
  onlyDeviations?: boolean;
}

export function filterCandidates(
  rows: readonly BankBulkCandidate[],
  filter: CandidateFilter,
): BankBulkCandidate[] {
  const naald = (filter.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.state && row.workflow_state !== filter.state) return false;
    if (filter.onlyDeviations && row.workflow_state !== "review_needed" && row.workflow_state !== "blocked") {
      return false;
    }
    if (!naald) return true;
    const hooiberg = [
      row.description ?? "",
      row.counter_account ?? "",
      String(row.amount),
      row.transaction_date,
    ]
      .join(" ")
      .toLowerCase();
    return hooiberg.includes(naald);
  });
}

/**
 * De selectie opnieuw naast de server leggen. Na een boekingsronde is een
 * geboekte regel niet langer `ready`; die valt er hier vanzelf uit. Een id die
 * de server helemaal niet meer teruggeeft, verdwijnt eveneens — de selectie
 * mag nooit id's bevatten die niemand meer kan zien.
 */
export function reconcileSelection(
  selected: Iterable<string>,
  rows: readonly BankBulkCandidate[],
): string[] {
  const nogSelecteerbaar = new Set(selectableCandidates(rows).map((r) => r.transaction_id));
  return [...selected].filter((id) => nogSelecteerbaar.has(id));
}

export interface SelectionBreakdown {
  selected: number;
  ready: number;
  reviewNeeded: number;
  blocked: number;
  posted: number;
  /** Geselecteerd maar niet meer in de geladen gegevens aanwezig. */
  unknown: number;
}

/**
 * Wat er werkelijk in de selectie zit, geteld tegen de GELADEN servergegevens
 * — nooit tegen een aanname. Zo kan de actiebalk niet iets anders beweren dan
 * wat er staat.
 */
export function selectionBreakdown(
  rows: readonly BankBulkCandidate[],
  selected: Iterable<string>,
): SelectionBreakdown {
  const perId = new Map(rows.map((r) => [r.transaction_id, r]));
  const uitkomst: SelectionBreakdown = {
    selected: 0, ready: 0, reviewNeeded: 0, blocked: 0, posted: 0, unknown: 0,
  };
  for (const id of selected) {
    uitkomst.selected += 1;
    const row = perId.get(id);
    if (!row) { uitkomst.unknown += 1; continue; }
    if (row.workflow_state === "ready") uitkomst.ready += 1;
    else if (row.workflow_state === "review_needed") uitkomst.reviewNeeded += 1;
    else if (row.workflow_state === "blocked") uitkomst.blocked += 1;
    else uitkomst.posted += 1;
  }
  return uitkomst;
}

/**
 * Wat er daadwerkelijk wordt aangeboden. Ook als er op een andere manier iets
 * in de selectie zou belanden, gaat er nooit meer dan `ready` de deur uit:
 * deze functie is de laatste zeef vóór de RPC.
 */
export function submittableIds(
  rows: readonly BankBulkCandidate[],
  selected: Iterable<string>,
): string[] {
  const selectie = new Set(selected);
  return selectableCandidates(rows)
    .filter((r) => selectie.has(r.transaction_id))
    .map((r) => r.transaction_id);
}

/**
 * Een mislukking halverwege een reeks partijen.
 *
 * De hook knipt meer dan `BANK_BULK_MAX_BATCH` id's in opeenvolgende
 * verzoeken. Breekt een later verzoek af, dan zijn de eerdere partijen wél
 * geboekt. Die uitkomsten weggooien zou de gebruiker laten geloven dat er
 * niets is gebeurd; ze als succes tellen zou nog erger zijn. Daarom draagt de
 * fout de reeds ontvangen resultaten mee.
 */
export class BankBulkPartialError extends Error {
  readonly results: BankBulkResult[];
  /** Hoeveel id's er in deze ronde nooit zijn aangeboden. */
  readonly notSubmitted: number;

  constructor(message: string, results: BankBulkResult[], notSubmitted: number) {
    super(message);
    this.name = "BankBulkPartialError";
    this.results = results;
    this.notSubmitted = notSubmitted;
  }
}

/** De resultaten die ondanks een afgebroken ronde al vaststaan. */
export function resultsFromError(error: unknown): BankBulkResult[] {
  return error instanceof BankBulkPartialError ? error.results : [];
}
