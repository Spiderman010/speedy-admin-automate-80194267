import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type JournalEntry = Tables<"journal_entries">;
type BankTransaction = Tables<"bank_transactions">;
type Grootboek = { id: string; nummer: number; omschrijving: string };

/** Eén boekingsregel van een inkoopfactuur, zoals de inkoopexport hem leest. */
export type SnelstartPurchaseLine = Pick<
  Tables<"purchase_invoice_lines">,
  "id" | "purchase_invoice_id" | "omschrijving" | "amount_excl" | "btw_percentage" | "grootboekrekening_id" | "sort_order" | "organization_id"
>;

/** De velden van een grootboekrekening die de inkoopexport nodig heeft. */
export type SnelstartLedgerAccount = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "organization_id" | "client_id">;

/** Een factuur die niet in het bestand staat, met de reden. Zij is ook niet gemarkeerd. */
export interface SnelstartRefusal {
  invoiceId: string;
  label: string;
  reason: string;
}

/**
 * Een export die niet mag ontstaan: een gemengde of verkeerde administratie,
 * of een ontbrekende instelling (zoals het bankdagboek). Er is dan geen bestand
 * gemaakt en niets gemarkeerd.
 */
export class SnelstartExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnelstartExportError";
  }
}

/**
 * Build the SnelStart omschrijving for a bank transaction.
 *
 * Uses the stored description, but when it is empty or the generic
 * "Geen omschrijving" placeholder, falls back to the captured CAMT.053
 * fields (AddtlNtryInf → Ustrd → tegenpartijnaam) and finally to
 * reference / tegenrekening so SnelStart never receives a blank line.
 */
function buildBankOmschrijving(t: BankTransaction): string {
  const candidates = [
    t.description,
    t.camt_addtl_ntry_inf,
    t.camt_ustrd,
    t.camt_counterparty_name,
    t.reference,
    t.counter_account,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v.toLowerCase() !== "geen omschrijving") return v;
  }
  return "Geen omschrijving";
}

export type BankExportResolutionSource =
  | "own"                    // transaction has a resolvable grootboekrekening_id
  | "1799"                   // gematcht, no own ledger, 1799 fallback used
  | "blocked_manual_invalid" // handmatig_geboekt with missing or stale ledger id
  | "blocked_missing_1799"   // gematcht needing 1799 fallback, but 1799 absent
  | "blocked_unconfirmed"    // suggestie — not yet confirmed by user
  | "blocked_unprocessed";   // niet_gematcht / any other unprocessed status

export type BankExportMeta = {
  exportedTransactions: number;
  exportedCsvRows: number;
  bookedTo1799: number;
  skippedTransactions: number;
  skippedManualInvalidLedger: number;
  skippedMissingFallback1799: number;
  skippedUnconfirmed: number;
  skippedUnprocessed: number;
};

// Tolerant 1799 lookup: handles both number 1799 and string "1799" returned at
// runtime despite the TypeScript type saying nummer is a number.
function find1799(grootboekrekeningen: Grootboek[]): Grootboek | null {
  return grootboekrekeningen.find(
    g => String(g.nummer ?? (g as any).code ?? "").trim() === "1799"
  ) ?? null;
}

/**
 * Single source of truth for resolving which grootboekrekening a bank
 * transaction should be exported to.
 *
 * match_status is checked before grootboekrekening_id so that unconfirmed /
 * unprocessed statuses always block — even when a ledger id happens to exist.
 *
 * Rules (in priority order):
 * 1. suggestie                                     → blocked_unconfirmed (always)
 * 2. niet_gematcht / unknown status                → blocked_unprocessed (always)
 * 3. handmatig_geboekt, own id resolves            → source "own"
 * 4. handmatig_geboekt, no/stale id               → blocked_manual_invalid
 * 5. gematcht, own id resolves                     → source "own"
 * 6. gematcht, no/stale id, 1799 present           → source "1799"
 * 7. gematcht, no/stale id, 1799 absent            → blocked_missing_1799
 */
export function resolveBankExportGrootboek(
  transaction: BankTransaction,
  grootboekrekeningen: Grootboek[],
): { grootboek: Grootboek | null; source: BankExportResolutionSource } {
  if (transaction.match_status === "suggestie") {
    return { grootboek: null, source: "blocked_unconfirmed" };
  }

  if (transaction.match_status !== "gematcht" && transaction.match_status !== "handmatig_geboekt") {
    return { grootboek: null, source: "blocked_unprocessed" };
  }

  const resolvedGb = transaction.grootboekrekening_id
    ? (grootboekrekeningen.find(g => g.id === transaction.grootboekrekening_id) ?? null)
    : null;

  if (transaction.match_status === "handmatig_geboekt") {
    return resolvedGb
      ? { grootboek: resolvedGb, source: "own" }
      : { grootboek: null, source: "blocked_manual_invalid" };
  }

  // gematcht
  if (resolvedGb) return { grootboek: resolvedGb, source: "own" };
  const fallback = find1799(grootboekrekeningen);
  return fallback
    ? { grootboek: fallback, source: "1799" }
    : { grootboek: null, source: "blocked_missing_1799" };
}

const SEP = ";";
const STANDARD_HEADERS = ["Datum", "Omschrijving", "Grootboekrekening", "Bedrag", "Btw-code"];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const parts = dateStr.substring(0, 10).split("-");
  if (parts.length === 3) {
    const dd = parts[2].padStart(2, "0");
    const mm = parts[1].padStart(2, "0");
    return `${dd}-${mm}-${parts[0]}`;
  }
  return "";
}

function formatAmount(amount: number | null): string {
  if (amount == null) return "";
  return amount.toFixed(2).replace(".", ",");
}

function btwCode(percentage: number | null): string {
  if (percentage === 21) return "1";
  if (percentage === 9) return "2";
  if (percentage === 0) return "0";
  return "";
}

// ── B2-14: CSV- en formule-injectie ─────────────────────────────────────────
//
// Een tekstveld dat met `=`, `+`, `-`, `@`, een tab of een CR begint, wordt in
// een spreadsheet als formule gelezen. De omschrijving bevat tekst van derden:
// de leveranciersnaam uit de OCR van het leveranciersdocument, de klantnaam en
// de bankomschrijving die de betaler kiest. Zo'n tekstveld krijgt daarom een
// apostrof vooraan (de aanpak van OWASP, "CSV Injection"): de tekst blijft
// volledig leesbaar, en een spreadsheet behandelt de cel als tekst.
//
// Alleen tekstvelden. Bedrag-, datum- en codevelden (Datum, Grootboekrekening,
// Bedrag, Btw-code, fldDagboek, fldBoekingcode, fldDatum, fldGrootboeknummer,
// fldDebet, fldCredit) gaan hier nooit doorheen, zodat een negatief bedrag als
// `-121,00` exact blijft staan. Een spatie vooraan is geen betrouwbare
// neutralisatie (sommige spreadsheets negeren voorloopspaties), en het teken
// weghalen zou de inhoud stil veranderen.
const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeCsvText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function csvRow(fields: string[]): string {
  return fields.map(f => `"${(f ?? "").replace(/"/g, '""')}"`).join(SEP);
}

function downloadCSV(content: string, filename: string) {
  const bom = "﻿";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toStandardRow(datum: string | null, omschrijving: string | null, grootboek: string | null, bedrag: number | null, btwPerc: number | null): string {
  return csvRow([
    formatDate(datum),
    neutralizeCsvText(omschrijving ?? ""),
    grootboek ?? "",
    formatAmount(bedrag),
    btwCode(btwPerc),
  ]);
}

function buildStandardCSV(rows: string[]): string {
  return [csvRow(STANDARD_HEADERS), ...rows].join("\r\n");
}

// ── A2-05 / D-04 / B2-12 / C-11: één administratie per bestand ──────────────
//
// SnelStart importeert per administratie, en het bestand heeft geen kolom voor
// de administratie. Een bestand met rijen van twee administraties kan de
// gebruiker dus niet meer splitsen. De pagina's laten de export alleen toe bij
// precies één gekozen administratie; deze toets is de tweede laag, in de
// exportfunctie zelf, zodat ook een omzeilde knop of een server die het filter
// negeert geen gemengd bestand oplevert.

export const SNELSTART_ONE_ADMINISTRATIE =
  "Kies één administratie om naar SnelStart te exporteren. Een SnelStart-bestand hoort bij precies één administratie.";

export interface SnelstartExportScope {
  /** De gekozen administratie (`clients.id`). Leeg of "all" wordt geweigerd. */
  clientId: string;
  /** De actieve organisatie. Als zij is meegegeven, moet elke rij erbij horen. */
  organizationId?: string | null;
}

type ScopedRow = { client_id?: string | null; organization_id?: string | null };

function countAdministraties(rows: readonly ScopedRow[]): number {
  return new Set(rows.map((r) => r.client_id ?? null)).size;
}

/**
 * Gooit een `SnelstartExportError` als de rijen bij meer dan één administratie
 * horen, bij een andere dan de gekozen administratie, of bij een andere
 * organisatie. Er wordt dan geen bestand gemaakt.
 */
export function assertSnelstartExportScope(
  rows: readonly ScopedRow[],
  scope: SnelstartExportScope,
  soort: string,
): void {
  const gekozen = scope?.clientId;
  if (!gekozen || gekozen === "all") {
    throw new SnelstartExportError(`Export geweigerd: er is geen administratie gekozen. ${SNELSTART_ONE_ADMINISTRATIE}`);
  }
  const aantal = countAdministraties(rows);
  if (aantal > 1) {
    throw new SnelstartExportError(
      `Export geweigerd: de ${soort} horen bij ${aantal} administraties. ${SNELSTART_ONE_ADMINISTRATIE}`,
    );
  }
  if (rows.some((r) => r.client_id !== gekozen)) {
    throw new SnelstartExportError(
      `Export geweigerd: de ${soort} horen niet bij de gekozen administratie. Er is geen bestand gemaakt.`,
    );
  }
  if (scope.organizationId && rows.some((r) => r.organization_id !== scope.organizationId)) {
    throw new SnelstartExportError(
      `Export geweigerd: de ${soort} horen niet bij de actieve organisatie. Er is geen bestand gemaakt.`,
    );
  }
}

// ── A2-04: inkoop per boekingsregel, in lijn met het grootboek ──────────────
//
// Betekenis van "Bedrag" (ongewijzigd ten opzichte van de export per kop): het
// bedrag INCLUSIEF btw, met het teken zoals opgeslagen (positief voor een
// gewone inkoopfactuur). SnelStart leidt de btw af uit dat bedrag en de
// btw-code. Per boekingsregel is het bedrag daarom:
//
//   regel.amount_excl + btw van de regel, met btw = excl × tarief / 100,
//   in hele centen, half van nul af afgerond (zoals `round2` in btw-calc.ts en
//   PostgreSQL `round()`).
//
// De regels tellen dan op tot het factuurtotaal in dezelfde betekenis:
// Σ regels = kop `amount_incl`, tot op de cent. Dat wordt gecontroleerd via
// drie exacte gelijkheden in centen, dezelfde als `post_purchase_invoice`
// (20261002120000, r. 255-281) plus de btw:
//   Σ regel.excl = kop.excl,  kop.excl + kop.btw = kop.incl,  Σ regel.btw = kop.btw.
// Rondt de kop de btw over het totaal af (zoals de werkbank), en is het verschil
// met de afronding per regel binnen de werkbanktolerantie ±max(0,02; 0,01·n), dan
// wordt de kop-btw per tarief met de grootste-restmethode over de regels verdeeld
// (allocateVatCents, H6-01). Bij een groter verschil wordt de factuur geweigerd.
//
// Grootboekrekening = `grootboekrekeningen.nummer` van de regel (dezelfde rekening
// waarop `post_purchase_invoice` de regel debiteert), btw-code per regel volgens
// het percentage van de regel (codetabel `btwCode`, AGENTS.md).
//
// Fail-closed: een factuur zonder regels, met een regel zonder rekening, met een
// rekening buiten de administratie, met een regel zonder btw-percentage (NULL) of
// met een percentage zonder SnelStart-code komt niet in het bestand. Zij staat in
// `refused`, met de reden, en wordt niet gemarkeerd. 0% blijft code "0".

/** Bedrag in hele centen, of null als het geen eindig bedrag in hele centen is (subcenten: A3-16). */
function toCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  const tolerance = Math.max(1e-6, Math.abs(n * 100) * 1e-14);
  return Math.abs(n * 100 - cents) <= tolerance ? cents : null;
}

function toPercentage(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Btw van één regel in centen; `percentage` is 0, 9 of 21, dus `|excl| × percentage` is een geheel getal. */
function lineVatCents(exclCents: number, percentage: number): number {
  const vat = Math.floor((Math.abs(exclCents) * percentage + 50) / 100);
  return exclCents < 0 ? -vat : vat;
}

/**
 * De btw die SnelStart uit "bedrag incl. + btw-code" terugrekent (aanname, zoals
 * het grootboekharnas: round(incl × p / (100 + p)), half van nul af), in centen.
 */
export function snelstartDerivedVatCents(inclCents: number, percentage: number): number {
  if (percentage === 0) return 0;
  const v = Math.floor((2 * Math.abs(inclCents) * percentage + 100 + percentage) / (2 * (100 + percentage)));
  return inclCents < 0 ? -v : v;
}

/** Komt de toegewezen regel-btw ook teruggerekend uit het incl-bedrag terug? */
function vatSurvivesBackCalculation(exclCents: number, vatCents: number, percentage: number): boolean {
  return snelstartDerivedVatCents(exclCents + vatCents, percentage) === vatCents;
}

function subsets(order: readonly number[], k: number): number[][] {
  // Deelverzamelingen van grootte k, in de voorkeursvolgorde van `order` (lexicografisch).
  if (k === 0) return [[]];
  const out: number[][] = [];
  for (let i = 0; i <= order.length - k; i++) {
    for (const rest of subsets(order.slice(i + 1), k - 1)) out.push([order[i], ...rest]);
  }
  return out;
}

/**
 * H6-01/H6-01b — verdeelt de kop-btw (centen) met de grootste-restmethode, eerst
 * over de tarieven en dan binnen elk tarief over de regels; bij gelijke rest telt
 * de volgorde (tarief oplopend; regels in `sort_order, id`, de volgorde van
 * `planned`). Elke regel krijgt de naar beneden afgeronde exacte btw of één cent
 * meer (nooit meer dan één cent van exact), en Σ = `headerVat` exact.
 *
 * Fail-closed (H6-01b): elke regel moet ook TERUGGEREKEND uit zijn incl-bedrag
 * dezelfde btw opleveren (`snelstartDerivedVatCents`), anders zou de cent in
 * SnelStart stil wegvallen. Van de toewijzingen die dat halen wordt de eerste in
 * de grootste-restvolgorde gekozen; bestaat er geen, dan null (weigeren).
 */
function allocateVatCents(planned: readonly { exclCents: number; percentage: number }[], headerVat: number): number[] | null {
  const num = planned.map((p) => p.exclCents * p.percentage); // exacte btw × 100 (geheel getal)
  const base = num.map((n) => Math.floor(n / 100));
  const frac = num.map((n, i) => n - 100 * base[i]); // 0..99
  const ok = (i: number, v: number) => vatSurvivesBackCalculation(planned[i].exclCents, v, planned[i].percentage);
  const rates = [...new Set(planned.map((p) => p.percentage))].sort((a, b) => a - b);
  const groups = rates.map((rate) => {
    const idx = planned.map((p, i) => (p.percentage === rate ? i : -1)).filter((i) => i >= 0);
    const g = idx.reduce((s, i) => s + num[i], 0);
    const floor = Math.floor(g / 100);
    return { idx, floor, frac: g - 100 * floor };
  });
  // Binnen één tarief: kies welke regels de extra cent krijgen.
  const fillGroup = (gi: number, target: number, out: number[]): boolean => {
    const { idx } = groups[gi];
    const kr = target - idx.reduce((s, i) => s + base[i], 0);
    const order = idx.filter((i) => frac[i] > 0).sort((a, b) => frac[b] - frac[a] || a - b);
    if (kr < 0 || kr > order.length) return false;
    // Regels die alleen met +1 terugrekenen, moeten +1 krijgen; regels die alleen
    // zonder +1 terugrekenen, mogen het niet krijgen; de rest in restvolgorde.
    const must = order.filter((i) => ok(i, base[i] + 1) && !ok(i, base[i]));
    const can = order.filter((i) => ok(i, base[i] + 1) && ok(i, base[i]));
    if (idx.some((i) => !ok(i, base[i]) && !(order.includes(i) && ok(i, base[i] + 1)))) return false;
    if (must.length > kr || must.length + can.length < kr) return false;
    for (const i of idx) out[i] = base[i];
    for (const i of [...must, ...can.slice(0, kr - must.length)]) out[i] = base[i] + 1;
    return true;
  };
  // Over de tarieven: Σ doel per tarief = kop-btw; doelen in grootste-restvolgorde geprobeerd.
  const k = headerVat - groups.reduce((s, g) => s + g.floor, 0);
  const groupOrder = groups.map((_, i) => i).filter((i) => groups[i].frac > 0).sort((a, b) => groups[b].frac - groups[a].frac || a - b);
  if (k < 0 || k > groupOrder.length) return null;
  for (const plus of subsets(groupOrder, k)) {
    const out = [...base];
    if (groups.every((g, gi) => fillGroup(gi, g.floor + (plus.includes(gi) ? 1 : 0), out))) return out;
  }
  return null;
}

function euro(cents: number): string {
  return `€${formatAmount(cents / 100)}`;
}

function purchaseInvoiceLabel(inv: Pick<PurchaseInvoice, "supplier" | "invoice_number">): string {
  return inv.supplier + (inv.invoice_number ? ` - ${inv.invoice_number}` : "");
}

function byLineOrder(a: SnelstartPurchaseLine, b: SnelstartPurchaseLine): number {
  // Zelfde volgorde als post_purchase_invoice: ORDER BY sort_order, id.
  if (a.sort_order !== b.sort_order) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function plural(n: number, een: string, meer: string): string {
  return `${n} ${n === 1 ? een : meer}`;
}

type PlannedLine = { line: SnelstartPurchaseLine; exclCents: number; vatCents: number; percentage: number; nummer: number };

function planPurchaseInvoice(
  inv: PurchaseInvoice,
  lines: readonly SnelstartPurchaseLine[],
  accountById: ReadonlyMap<string, SnelstartLedgerAccount>,
  forMarking: boolean,
): { rows: string[] } | { reason: string } {
  if (!inv.invoice_date) return { reason: "de factuur heeft geen factuurdatum" };
  // D1: de exportmarkering mag de betaalstatus niet veranderen. Bij inkoop deelt
  // zij de kolom `status` met de oude waarde 'betaald'; een 'betaald'-factuur met
  // een openstaand bedrag dat geen 0 is, zou na het markeren als open tonen.
  if (forMarking && inv.status === "betaald" && toCents(inv.remaining_amount) !== 0) {
    return {
      reason:
        "de factuur staat op 'betaald' terwijl het openstaande bedrag niet 0 is; als geëxporteerd markeren zou de betaalstatus veranderen. Laat eerst de betaalstatus herstellen",
    };
  }
  if (lines.length === 0) return { reason: "de factuur heeft geen boekingsregels" };

  const reasons: string[] = [];
  let otherOrganization = 0;
  let invalidAmount = 0;
  let withoutAccount = 0;
  let foreignAccount = 0;
  let withoutVat = 0;
  const withoutCode = new Set<number>();
  const planned: PlannedLine[] = [];
  for (const line of lines) {
    if (line.organization_id !== inv.organization_id) { otherOrganization++; continue; }
    const exclCents = toCents(line.amount_excl);
    if (exclCents == null) { invalidAmount++; continue; }
    if (!line.grootboekrekening_id) { withoutAccount++; continue; }
    const account = accountById.get(line.grootboekrekening_id);
    // Zelfde rekeningtoets als posting_account_ok(): dezelfde organisatie, en
    // organisatiebreed of van deze administratie.
    if (
      !account ||
      account.organization_id !== inv.organization_id ||
      (account.client_id != null && account.client_id !== inv.client_id)
    ) { foreignAccount++; continue; }
    const percentage = toPercentage(line.btw_percentage);
    if (percentage == null) { withoutVat++; continue; }
    if (btwCode(percentage) === "") { withoutCode.add(percentage); continue; }
    planned.push({ line, exclCents, vatCents: lineVatCents(exclCents, percentage), percentage, nummer: account.nummer });
  }
  if (otherOrganization) reasons.push(`${plural(otherOrganization, "boekingsregel hoort", "boekingsregels horen")} bij een andere organisatie`);
  if (invalidAmount) reasons.push(`${plural(invalidAmount, "boekingsregel heeft", "boekingsregels hebben")} geen geldig bedrag in hele centen`);
  if (withoutAccount) reasons.push(`${plural(withoutAccount, "boekingsregel", "boekingsregels")} zonder grootboekrekening`);
  if (foreignAccount) reasons.push(`${plural(foreignAccount, "boekingsregel", "boekingsregels")} met een grootboekrekening die niet gevonden is of niet bij deze administratie hoort`);
  if (withoutVat) reasons.push(`${plural(withoutVat, "boekingsregel", "boekingsregels")} zonder btw-percentage (onbekende btw)`);
  if (withoutCode.size) {
    reasons.push(`btw-percentage ${[...withoutCode].sort((a, b) => a - b).join("%, ")}% heeft geen SnelStart-btw-code (alleen 21%, 9% en 0%)`);
  }
  if (reasons.length) return { reason: reasons.join("; ") };

  const headerExcl = toCents(inv.amount_excl);
  const headerIncl = toCents(inv.amount_incl);
  const headerVat = inv.btw_amount == null ? 0 : toCents(inv.btw_amount);
  if (headerExcl == null || headerIncl == null || headerVat == null) {
    return { reason: "de factuur mist een geldig bedrag excl. btw, btw of incl. btw" };
  }
  const sumExcl = planned.reduce((s, p) => s + p.exclCents, 0);
  if (sumExcl !== headerExcl) {
    return { reason: `de boekingsregels (excl. btw ${euro(sumExcl)}) sluiten niet aan op de factuur (excl. btw ${euro(headerExcl)})` };
  }
  if (headerExcl + headerVat !== headerIncl) {
    return { reason: `de factuur sluit niet: excl. btw ${euro(headerExcl)} plus btw ${euro(headerVat)} is niet het bedrag incl. btw ${euro(headerIncl)}` };
  }
  const sumVat = planned.reduce((s, p) => s + p.vatCents, 0);
  if (sumVat !== headerVat) {
    // H6-01: de werkbank rondt de btw over het totaal af en accepteert een
    // verschil van ±max(0,02; 0,01·n) (lineTolerance). Binnen precies die
    // tolerantie wordt de kop-btw per tarief over de regels verdeeld; daarbuiten
    // blijft het een weigering.
    const toleranceCents = Math.max(2, Math.max(1, lines.length));
    if (Math.abs(headerVat - sumVat) > toleranceCents) {
      return { reason: `de btw per boekingsregel (${euro(sumVat)}) wijkt af van de btw op de factuur (${euro(headerVat)})` };
    }
    const allocated = allocateVatCents(planned, headerVat);
    if (!allocated) {
      return { reason: `de btw op de factuur (${euro(headerVat)}) is niet zo over de regels te verdelen dat SnelStart uit elk bedrag incl. btw dezelfde btw terugrekent (per regel afgerond: ${euro(sumVat)})` };
    }
    allocated.forEach((v, i) => { planned[i].vatCents = v; });
  }
  // H6-01b: elke rij moet ook teruggerekend (SnelStart: btw uit incl + code) zijn
  // eigen regel-btw opleveren; anders weigeren in plaats van een stille cent.
  if (planned.some((p) => !vatSurvivesBackCalculation(p.exclCents, p.vatCents, p.percentage))) {
    return { reason: `de btw op de factuur (${euro(headerVat)}) is niet zo over de regels te verdelen dat SnelStart uit elk bedrag incl. btw dezelfde btw terugrekent` };
  }

  const label = purchaseInvoiceLabel(inv);
  const rows = planned.map((p) => {
    const regel = (p.line.omschrijving ?? "").trim();
    return toStandardRow(
      inv.invoice_date,
      regel ? `${label} - ${regel}` : label,
      String(p.nummer),
      (p.exclCents + p.vatCents) / 100,
      p.percentage,
    );
  });
  return { rows };
}

export interface PurchaseInvoiceExportPlan {
  /** CSV-regels zonder kop, in de volgorde van de facturen en hun boekingsregels. */
  rows: string[];
  /** Precies de facturen die volledig in `rows` staan. Alleen deze mogen gemarkeerd worden. */
  exportedInvoiceIds: string[];
  /** De facturen die niet in het bestand staan, met de reden. */
  refused: SnelstartRefusal[];
}

/**
 * Pure opbouw van de inkoopexport per boekingsregel. Geen download, geen
 * netwerk. `forMarking` zet de D1-toets aan voor een export die daarna markeert.
 */
export function buildPurchaseInvoiceExport(input: {
  invoices: readonly PurchaseInvoice[];
  lines: readonly SnelstartPurchaseLine[];
  accounts: readonly SnelstartLedgerAccount[];
  forMarking?: boolean;
}): PurchaseInvoiceExportPlan {
  const linesByInvoice = new Map<string, SnelstartPurchaseLine[]>();
  for (const line of input.lines) {
    const list = linesByInvoice.get(line.purchase_invoice_id);
    if (list) list.push(line);
    else linesByInvoice.set(line.purchase_invoice_id, [line]);
  }
  const accountById = new Map(input.accounts.map((a) => [a.id, a] as const));
  const rows: string[] = [];
  const exportedInvoiceIds: string[] = [];
  const refused: SnelstartRefusal[] = [];
  for (const inv of input.invoices) {
    const lines = [...(linesByInvoice.get(inv.id) ?? [])].sort(byLineOrder);
    const result = planPurchaseInvoice(inv, lines, accountById, input.forMarking ?? false);
    if ("reason" in result) {
      refused.push({ invoiceId: inv.id, label: purchaseInvoiceLabel(inv), reason: result.reason });
    } else {
      rows.push(...result.rows);
      exportedInvoiceIds.push(inv.id);
    }
  }
  return { rows, exportedInvoiceIds, refused };
}

export interface PurchaseInvoiceExportResult {
  exportedInvoiceIds: string[];
  refused: SnelstartRefusal[];
  rowCount: number;
  /** De naam van het gedownloade bestand, of null als er niets te exporteren was. */
  filename: string | null;
}

/**
 * Inkoopexport voor SnelStart, per boekingsregel. Toetst eerst de administratie
 * (gooit bij gemengde of vreemde rijen), bouwt dan het bestand en start de
 * download. Gooit de download, dan gooit deze functie ook: de aanroeper
 * markeert pas na een geslaagde terugkeer, en alleen `exportedInvoiceIds`.
 * Is er niets exporteerbaar, dan is er geen download (`filename` = null).
 */
export function exportPurchaseInvoicesCSV(input: {
  invoices: readonly PurchaseInvoice[];
  lines: readonly SnelstartPurchaseLine[];
  accounts: readonly SnelstartLedgerAccount[];
  clientId: string;
  organizationId?: string | null;
  clientName?: string;
  year?: number;
}): PurchaseInvoiceExportResult {
  assertSnelstartExportScope(input.invoices, { clientId: input.clientId, organizationId: input.organizationId }, "inkoopfacturen");
  const plan = buildPurchaseInvoiceExport({ invoices: input.invoices, lines: input.lines, accounts: input.accounts, forMarking: true });
  if (!plan.exportedInvoiceIds.length) {
    return { exportedInvoiceIds: [], refused: plan.refused, rowCount: 0, filename: null };
  }
  const prefix = input.clientName ? `${input.clientName.replace(/\s+/g, "_")}_` : "";
  const yearSuffix = input.year != null ? `_${input.year}` : "";
  const filename = `${prefix}inkoopfacturen_snelstart${yearSuffix}.csv`;
  downloadCSV(buildStandardCSV(plan.rows), filename);
  return { exportedInvoiceIds: plan.exportedInvoiceIds, refused: plan.refused, rowCount: plan.rows.length, filename };
}

export function exportJournalEntriesCSV(entries: JournalEntry[], clientName?: string) {
  const rows = entries.map(e =>
    toStandardRow(e.entry_date, e.description, e.ledger_account_text, e.amount, e.btw_percentage)
  );
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}boekingen_snelstart.csv`);
}

/**
 * Verkoopexport voor SnelStart. Toetst eerst de administratie (A2-05): bij
 * rijen van meer dan één of van een andere administratie gooit zij, en is er
 * geen bestand.
 */
export function exportSalesInvoicesCSV(
  invoices: readonly SalesInvoice[],
  opts: SnelstartExportScope & { clientName?: string },
) {
  assertSnelstartExportScope(invoices, opts, "verkoopfacturen");
  const rows = invoices.map(inv =>
    toStandardRow(inv.invoice_date, inv.customer_name + (inv.invoice_number ? ` - ${inv.invoice_number}` : ""), inv.ledger_account_text, inv.amount_incl, inv.btw_percentage)
  );
  const prefix = opts.clientName ? `${opts.clientName.replace(/\s+/g, "_")}_` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}verkoopfacturen_snelstart.csv`);
  return invoices.map(i => i.id);
}

// SnelStart 12 boekingen import formaat
const SNELSTART_HEADERS = [
  "fldDagboek",
  "fldBoekingcode",
  "fldDatum",
  "fldGrootboeknummer",
  "fldDebet",
  "fldCredit",
  "fldOmschrijving",
];

function snelstartRow(fields: (string | number)[]): string {
  return fields.map(f => String(f ?? "")).join(SEP);
}

function buildSnelstartCSV(rows: string[]): string {
  return [SNELSTART_HEADERS.join(SEP), ...rows].join("\r\n");
}

function downloadSnelstartCSV(content: string, filename: string) {
  // SnelStart 12 verwacht GEEN BOM marker
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── C-11: het bankdagboek is verplicht en expliciet ingesteld ───────────────
//
// De bron is `clients.bank_dagboek` (Klanten → "Bank-dagboek"; client-readiness
// meldt een ontbrekend dagboek al als `config_ontbreekt`). Er is geen standaard:
// 1100 is een gok, en het dagboeknummer staat in de SnelStart 12-bankregel ook
// als grootboeknummer van de bank. Ontbreekt het, dan is er geen bankbestand.

export const SNELSTART_BANKDAGBOEK_ONTBREEKT =
  "Geen SnelStart-bankdagboek ingesteld voor deze administratie. Stel het bankdagboek in bij Klanten (veld 'Bank-dagboek'); BoekAssist valt niet terug op 1100.";

/** Het ingestelde bankdagboek (een positief geheel getal), of een `SnelstartExportError`. */
export function requireSnelstartBankDagboek(bankDagboek: number | null | undefined): number {
  if (typeof bankDagboek !== "number" || !Number.isInteger(bankDagboek) || bankDagboek <= 0) {
    throw new SnelstartExportError(SNELSTART_BANKDAGBOEK_ONTBREEKT);
  }
  return bankDagboek;
}

/**
 * Pure SnelStart 12 bank row builder — shared by exportBankTransactionsCSV
 * (standalone download) and exportAllForClient (ZIP entry) so both paths
 * produce identical CSV content and cannot diverge.
 *
 * Uses resolveBankExportGrootboek to determine exportability; blocked
 * transactions are silently skipped. Does not produce a BOM (SnelStart 12
 * rejects BOM). Requires an explicitly configured bank dagboek (no 1100
 * fallback); the omschrijving is neutralised against formula injection (B2-14).
 *
 * Exported so it can be unit-tested without a browser.
 */
export function buildBankSnelstartRows(
  transactions: BankTransaction[],
  grootboekrekeningen: Grootboek[],
  bankDagboek: number,
): {
  rows: string[];
  exportedTransactions: number;
  bookedTo1799: number;
  skippedTransactions: number;
  skippedManualInvalidLedger: number;
  skippedMissingFallback1799: number;
  skippedUnconfirmed: number;
  skippedUnprocessed: number;
} {
  const dagboek = requireSnelstartBankDagboek(bankDagboek);
  const rows: string[] = [];
  let boekingcode = 1;
  let exportedTransactions = 0;
  let bookedTo1799 = 0;
  let skippedTransactions = 0;
  let skippedManualInvalidLedger = 0;
  let skippedMissingFallback1799 = 0;
  let skippedUnconfirmed = 0;
  let skippedUnprocessed = 0;

  for (const t of transactions) {
    const { grootboek: gb, source } = resolveBankExportGrootboek(t, grootboekrekeningen);

    if (!gb) {
      skippedTransactions++;
      if (source === "blocked_manual_invalid") skippedManualInvalidLedger++;
      if (source === "blocked_missing_1799") skippedMissingFallback1799++;
      if (source === "blocked_unconfirmed") skippedUnconfirmed++;
      if (source === "blocked_unprocessed") skippedUnprocessed++;
      continue;
    }

    const datum = formatDate(t.transaction_date);
    // Eerst `;` en regeleinden vervangen (1 op 1), dan neutraliseren, dan pas
    // inkorten tot 100 tekens: voor gewone tekst exact het oude resultaat.
    const omschrijving = neutralizeCsvText(buildBankOmschrijving(t).replace(/[\r\n;]/g, " ")).substring(0, 100);
    const bedrag = Math.abs(t.amount);
    const isPositief = t.amount >= 0;

    // Positief bedrag (inkomend) → bank debet, tegenrekening credit
    // Negatief bedrag (uitgaand) → bank credit, tegenrekening debet
    rows.push(snelstartRow([
      dagboek,
      boekingcode,
      datum,
      dagboek,
      isPositief ? formatAmount(bedrag) : "0",
      isPositief ? "0" : formatAmount(bedrag),
      omschrijving,
    ]));

    rows.push(snelstartRow([
      dagboek,
      boekingcode,
      datum,
      gb.nummer,
      isPositief ? "0" : formatAmount(bedrag),
      isPositief ? formatAmount(bedrag) : "0",
      omschrijving,
    ]));

    exportedTransactions++;
    if (source === "1799") bookedTo1799++;
    boekingcode++;
  }

  return {
    rows,
    exportedTransactions,
    bookedTo1799,
    skippedTransactions,
    skippedManualInvalidLedger,
    skippedMissingFallback1799,
    skippedUnconfirmed,
    skippedUnprocessed,
  };
}

/**
 * Bankexport (SnelStart 12). Het bankdagboek is verplicht: zonder ingesteld
 * dagboek gooit deze functie en is er geen bestand. Een bestand hoort bij één
 * administratie; rijen van meer administraties worden geweigerd (de pagina toetst
 * daarnaast de gekozen administratie, #290).
 */
export function exportBankTransactionsCSV(
  transactions: BankTransaction[],
  grootboekrekeningen: Grootboek[],
  clientName: string | undefined,
  bankDagboek: number | null | undefined,
): BankExportMeta {
  const aantal = countAdministraties(transactions);
  if (aantal > 1) {
    throw new SnelstartExportError(
      `Export geweigerd: de banktransacties horen bij ${aantal} administraties. ${SNELSTART_ONE_ADMINISTRATIE}`,
    );
  }
  const dagboek = requireSnelstartBankDagboek(bankDagboek);
  const result = buildBankSnelstartRows(transactions, grootboekrekeningen, dagboek);
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadSnelstartCSV(buildSnelstartCSV(result.rows), `${prefix}banktransacties_snelstart.csv`);
  return {
    exportedTransactions: result.exportedTransactions,
    exportedCsvRows: result.rows.length,
    bookedTo1799: result.bookedTo1799,
    skippedTransactions: result.skippedTransactions,
    skippedManualInvalidLedger: result.skippedManualInvalidLedger,
    skippedMissingFallback1799: result.skippedMissingFallback1799,
    skippedUnconfirmed: result.skippedUnconfirmed,
    skippedUnprocessed: result.skippedUnprocessed,
  };
}

export interface ExportAllForClientResult {
  /** De inkoopfacturen die in `<prefix>_inkoopfacturen.csv` staan. De ZIP markeert niets. */
  purchaseExportedInvoiceIds: string[];
  /** De inkoopfacturen die niet in de ZIP staan, met de reden. */
  purchaseRefused: SnelstartRefusal[];
  bankExportedTransactions: number;
}

/**
 * ZIP-export per administratie. Structuur en bestandsnamen zijn ongewijzigd:
 * `<prefix>_inkoopfacturen.csv`, `<prefix>_boekingen.csv`,
 * `<prefix>_banktransacties.csv` (SnelStart 12, zonder BOM) in
 * `<prefix>_snelstart_export.zip`; een deel zonder regels wordt weggelaten.
 *
 * Vóór er iets wordt gebouwd: alle rijen horen bij de gekozen administratie
 * (anders een `SnelstartExportError`), de inkoop gaat per boekingsregel
 * (`buildPurchaseInvoiceExport`), en zijn er exporteerbare bankregels, dan is
 * het bankdagboek verplicht.
 */
export async function exportAllForClient(input: {
  clientId: string;
  organizationId?: string | null;
  clientName: string;
  invoices: readonly PurchaseInvoice[];
  lines: readonly SnelstartPurchaseLine[];
  accounts: readonly SnelstartLedgerAccount[];
  entries: readonly JournalEntry[];
  transactions: BankTransaction[];
  grootboekrekeningen: Grootboek[];
  bankDagboek: number | null | undefined;
}): Promise<ExportAllForClientResult> {
  const scope: SnelstartExportScope = { clientId: input.clientId, organizationId: input.organizationId };
  assertSnelstartExportScope(input.invoices, scope, "inkoopfacturen");
  assertSnelstartExportScope(input.entries, scope, "boekingen");
  assertSnelstartExportScope(input.transactions, scope, "banktransacties");
  const { transactions, grootboekrekeningen } = input;

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const prefix = input.clientName.replace(/\s+/g, "_");
  const bom = "﻿";

  const purchase = buildPurchaseInvoiceExport({ invoices: input.invoices, lines: input.lines, accounts: input.accounts });
  if (purchase.rows.length) {
    zip.file(`${prefix}_inkoopfacturen.csv`, bom + buildStandardCSV(purchase.rows));
  }

  if (input.entries.length) {
    const rows = input.entries.map(e =>
      toStandardRow(e.entry_date, e.description, e.ledger_account_text, e.amount, e.btw_percentage)
    );
    zip.file(`${prefix}_boekingen.csv`, bom + buildStandardCSV(rows));
  }

  let bankExportedTransactions = 0;
  if (transactions.length) {
    const exportable = transactions.filter(t => resolveBankExportGrootboek(t, grootboekrekeningen).grootboek).length;
    if (exportable > 0) {
      const dagboek = requireSnelstartBankDagboek(input.bankDagboek);
      const { rows, exportedTransactions } = buildBankSnelstartRows(transactions, grootboekrekeningen, dagboek);
      bankExportedTransactions = exportedTransactions;
      // SnelStart 12 verwacht GEEN BOM marker
      zip.file(`${prefix}_banktransacties.csv`, buildSnelstartCSV(rows));
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}_snelstart_export.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return {
    purchaseExportedInvoiceIds: purchase.exportedInvoiceIds,
    purchaseRefused: purchase.refused,
    bankExportedTransactions,
  };
}
