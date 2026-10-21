// Pure beslislogica voor de inkoop-intake (process-invoice).
//
// Geen Deno-globals, geen URL-imports en geen I/O: index.ts (Deno) importeert
// dit bestand als "./intake-guards.ts" en Vitest test het rechtstreeks
// (src/test/intake-guards.test.ts, src/test/intake-edge-handlers.test.ts).
// Het staat bewust naast index.ts, net als ubl-parse.ts en ubl-extract.ts: dat
// is het importpad dat in deze repo aantoonbaar mee-deployt (een gedeelde map
// buiten de functiemap is hier nooit gedeployd; de mcp-functie wordt zelfs als
// één gebundeld bestand aangeleverd).
//
// Het blok "GEDEELD" staat ook in ../process-sales-invoice/intake-guards.ts.
// src/test/intake-guards.test.ts draait dezelfde gevallen tegen beide kopieën,
// zodat ze niet ongemerkt uit elkaar kunnen lopen.

// ── GEDEELD ──────────────────────────────────────────────────────────────────

export type AppRole = "read_only" | "assistant" | "accountant" | "owner";

/** Eén neutrale melding voor "klant niet zichtbaar" én "rol te laag": geen orakel. */
export const INTAKE_FORBIDDEN_MESSAGE =
  "Onvoldoende rechten om facturen voor deze administratie te verwerken.";

export const INTAKE_ROLE_CHECK_FAILED_MESSAGE =
  "De rechten konden niet worden gecontroleerd. Er is niets opgeslagen; probeer het later opnieuw.";

/** Het deel van de Supabase-client dat de rolcontrole nodig heeft. */
export interface RoleCheckClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type IntakeDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 500; error: string };

/**
 * Rolcontrole met de bestaande public.has_min_role(_user_id, _organization_id,
 * _min) (SECURITY DEFINER; EXECUTE voor authenticated en service_role sinds
 * 20260616005300). De edge function schrijft daarna met de service role en
 * omzeilt dus de RLS op de factuurtabel; daarom dwingt zij dezelfde vloer hier
 * zelf af. Fail-closed: alleen een expliciete `true` geeft toegang. Een fout,
 * een uitzondering of elk ander antwoord weigert, vóórdat er iets is opgeslagen.
 */
export async function authorizeIntakeWrite(
  client: RoleCheckClient,
  userId: string | null | undefined,
  organizationId: string | null | undefined,
  minRole: AppRole,
): Promise<IntakeDecision> {
  if (!userId || !organizationId) {
    return { allowed: false, status: 403, error: INTAKE_FORBIDDEN_MESSAGE };
  }
  let result: { data: unknown; error: unknown } | null | undefined;
  try {
    result = await client.rpc("has_min_role", {
      _user_id: userId,
      _organization_id: organizationId,
      _min: minRole,
    });
  } catch {
    return { allowed: false, status: 500, error: INTAKE_ROLE_CHECK_FAILED_MESSAGE };
  }
  if (!result || result.error) {
    return { allowed: false, status: 500, error: INTAKE_ROLE_CHECK_FAILED_MESSAGE };
  }
  return result.data === true
    ? { allowed: true }
    : { allowed: false, status: 403, error: INTAKE_FORBIDDEN_MESSAGE };
}

// Deterministische validatie van de extractie (AI of UBL). De intake blokkeert
// hier niet: wat niet klopt wordt gemarkeerd, en wat geen geldige waarde is
// wordt niet als waarde overgenomen.

export type IntakeIssueCode =
  | "bedrag_geen_getal"
  | "totalen_kloppen_niet"
  | "btw_tarief_afwijkend"
  | "datum_ongeldig"
  | "datum_onwaarschijnlijk";

export interface IntakeIssue {
  code: IntakeIssueCode;
  /** De kolom waar de bevinding over gaat. */
  veld: string;
  /** Nederlandse uitleg voor de beoordelaar. */
  melding: string;
}

export interface IntakeValidation {
  ok: boolean;
  issues: IntakeIssue[];
}

/** De Nederlandse btw-tarieven. Een ander percentage wordt gemarkeerd, niet weggegooid. */
export const STANDARD_VAT_RATES: readonly number[] = [0, 9, 21];

/** Vroegste factuurdatum die als plausibel geldt; de laatste is vandaag + 1 jaar. */
export const EARLIEST_PLAUSIBLE_DATE = "2000-01-01";

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const VELD_LABEL: Record<string, string> = {
  amount_excl: "Bedrag excl. btw",
  btw_amount: "Btw-bedrag",
  amount_incl: "Bedrag incl. btw",
  btw_percentage: "Btw-percentage",
  invoice_date: "Factuurdatum",
  due_date: "Vervaldatum",
};

function issue(code: IntakeIssueCode, veld: string, waarde?: unknown): IntakeIssue {
  const label = VELD_LABEL[veld] ?? veld;
  const melding: Record<IntakeIssueCode, string> = {
    bedrag_geen_getal: `${label} is geen geldig getal en is niet overgenomen.`,
    totalen_kloppen_niet:
      "Bedrag excl. btw plus btw-bedrag wijkt meer dan € 0,01 af van het bedrag incl. btw.",
    btw_tarief_afwijkend: `${label} ${String(waarde)} is geen Nederlands btw-tarief (0, 9 of 21).`,
    datum_ongeldig: `${label} is geen geldige datum (JJJJ-MM-DD) en is niet overgenomen.`,
    datum_onwaarschijnlijk:
      `${label} ligt buiten ${EARLIEST_PLAUSIBLE_DATE} tot een jaar na vandaag en is niet overgenomen.`,
  };
  return { code, veld, melding: melding[code] };
}

/** Tekst zoals aangeleverd (niet genormaliseerd); leeg of geen tekst wordt null. */
export function textOrNull(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() === "" ? null : raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * Een bedrag of percentage. 0 blijft 0 (dus geen `||`); afwezig wordt null; iets
 * wat wel is aangeleverd maar geen eindig getal is, wordt null én een bevinding.
 */
export function parseAmount(raw: unknown): { value: number | null; invalid: boolean } {
  if (raw === null || raw === undefined) return { value: null, invalid: false };
  if (typeof raw === "string" && raw.trim() === "") return { value: null, invalid: false };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw, invalid: false } : { value: null, invalid: true };
  }
  if (typeof raw === "string" && NUMERIC_STRING.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? { value: n, invalid: false } : { value: null, invalid: true };
  }
  return { value: null, invalid: true };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Een echte kalenderdatum in JJJJ-MM-DD (dus niet 2026-02-31). Met `plausible`
 * moet hij bovendien in [2000-01-01, vandaag + 1 jaar] liggen.
 */
export function parseIsoDate(
  raw: unknown,
  now: Date,
  plausible: boolean,
): { value: string | null; issue: IntakeIssueCode | null } {
  if (raw === null || raw === undefined) return { value: null, issue: null };
  if (typeof raw !== "string") return { value: null, issue: "datum_ongeldig" };
  const s = raw.trim();
  if (s === "") return { value: null, issue: null };
  const m = ISO_DATE.exec(s);
  if (!m) return { value: null, issue: "datum_ongeldig" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { value: null, issue: "datum_ongeldig" };
  }
  if (plausible) {
    const latest = new Date(now.getTime());
    latest.setUTCFullYear(latest.getUTCFullYear() + 1);
    if (s < EARLIEST_PLAUSIBLE_DATE || s > isoDay(latest)) {
      return { value: null, issue: "datum_onwaarschijnlijk" };
    }
  }
  return { value: s, issue: null };
}

function cents(n: number): number {
  return Math.round(n * 100);
}

export interface CheckedInvoice {
  amountExcl: number | null;
  btwAmount: number | null;
  amountIncl: number | null;
  btwPercentage: number | null;
  invoiceDate: string | null;
  validation: IntakeValidation;
  /** true zodra een bedrag ongeldig was of de totalen niet sluiten. */
  amountsUntrusted: boolean;
}

/** Valideert de bedragen en de factuurdatum van een extractie. */
export function checkExtractedInvoice(extracted: Record<string, unknown>, now: Date): CheckedInvoice {
  const issues: IntakeIssue[] = [];
  let amountsUntrusted = false;
  const amount = (veld: string): number | null => {
    const r = parseAmount(extracted[veld]);
    if (r.invalid) {
      issues.push(issue("bedrag_geen_getal", veld));
      amountsUntrusted = true;
    }
    return r.value;
  };
  const amountExcl = amount("amount_excl");
  const btwAmount = amount("btw_amount");
  const amountIncl = amount("amount_incl");
  const btwPercentage = amount("btw_percentage");

  if (amountExcl !== null && btwAmount !== null && amountIncl !== null
      && Math.abs(cents(amountExcl) + cents(btwAmount) - cents(amountIncl)) > 1) {
    issues.push(issue("totalen_kloppen_niet", "amount_incl"));
    amountsUntrusted = true;
  }
  if (btwPercentage !== null && !STANDARD_VAT_RATES.includes(btwPercentage)) {
    issues.push(issue("btw_tarief_afwijkend", "btw_percentage", btwPercentage));
  }

  const date = parseIsoDate(extracted.invoice_date, now, true);
  if (date.issue) issues.push(issue(date.issue, "invoice_date"));

  return {
    amountExcl,
    btwAmount,
    amountIncl,
    btwPercentage,
    invoiceDate: date.value,
    validation: { ok: issues.length === 0, issues },
    amountsUntrusted,
  };
}

/**
 * Het openstaande bedrag bij aanmaak. Nooit 0 als standaardwaarde en nooit het
 * bedrag excl. btw: alleen een bekend bedrag incl. btw uit een extractie
 * waarvan de bedragen kloppen. Anders NULL ("nog niet vastgesteld"); de UI
 * valt dan terug op het totaal of op "onbekend" (src/lib/invoice-balances.ts).
 */
export function openAmountAtIntake(checked: CheckedInvoice): number | null {
  return !checked.amountsUntrusted && checked.amountIncl !== null ? checked.amountIncl : null;
}

/** Een object als extractie; al het andere telt als "niets herkend". */
export function asExtraction(extracted: unknown): Record<string, unknown> {
  return extracted && typeof extracted === "object" && !Array.isArray(extracted)
    ? (extracted as Record<string, unknown>)
    : {};
}

// ── EINDE GEDEELD ────────────────────────────────────────────────────────────

/**
 * Minimale rol om via de intake een inkoopfactuur aan te maken. Gelijk aan de
 * INSERT-policy role_purchase_invoices_insert:
 * has_min_role(auth.uid(), organization_id, 'assistant')
 * (supabase/migrations/20260613001452_…sql r. 106-107; geen latere migratie
 * wijzigt haar).
 */
export const PURCHASE_WRITE_MIN_ROLE: AppRole = "assistant";

export interface PurchaseInsertContext {
  userId: string;
  clientId: string;
  organizationId: string;
  filePath: string;
  supplierBtwNumber: string | null;
  now: Date;
}

/** De rij voor purchase_invoices, met de validatie vastgelegd in ocr_data.validation. */
export function buildPurchaseInvoiceInsert(extracted: unknown, ctx: PurchaseInsertContext) {
  const data = asExtraction(extracted);
  const checked = checkExtractedInvoice(data, ctx.now);
  return {
    user_id: ctx.userId,
    client_id: ctx.clientId,
    organization_id: ctx.organizationId,
    supplier: textOrNull(data.supplier) ?? "Onbekend",
    invoice_number: textOrNull(data.invoice_number),
    invoice_date: checked.invoiceDate,
    amount_excl: checked.amountExcl,
    btw_amount: checked.btwAmount,
    amount_incl: checked.amountIncl,
    btw_percentage: checked.btwPercentage,
    supplier_btw_number: ctx.supplierBtwNumber,
    remaining_amount: openAmountAtIntake(checked),
    file_path: ctx.filePath,
    ocr_data: { ...data, validation: checked.validation },
    status: "te_controleren" as const,
  };
}
