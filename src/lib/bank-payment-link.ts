/**
 * De betaalschrijver vanuit de app: pure hulp rond link_bank_payment en
 * unlink_bank_payment (P5, besluit D1 "de database leidt af").
 *
 * De app rekent geen openstaand bedrag en geen betaalstatus meer uit en schrijft
 * die ook niet: één RPC legt de koppeling, het restant, bij verkoop `betaald`
 * en de matchvelden van de banktransactie atomair vast. Hier staat alleen wat de
 * app daarvoor nodig heeft: het bedrag exact op twee decimalen, een
 * request_id per handeling, en een betrouwbare melding bij een weigering.
 */

export type BankPaymentInvoiceType = "inkoop" | "verkoop";

/** Een fout van PostgREST of de RPC zelf. */
export interface BankPaymentRpcError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Codes waarmee PostgREST meldt dat de functie (nog) niet bestaat: de app staat
 * al live, de migratie nog niet. Dan schrijft de app NIETS (fail-closed).
 */
const DEPLOY_WINDOW_CODES = new Set(["PGRST202", "PGRST203", "PGRST204", "PGRST205", "42883", "42P01"]);

/** De SQLSTATE's waarvan de RPC een nette Nederlandse melding meegeeft. */
const OWN_REFUSAL_CODES = new Set(["28000", "25000", "22004", "22023", "23505", "23514", "42501", "55000", "P0002"]);

export const BANK_PAYMENT_NOT_AVAILABLE =
  "Betalingen koppelen is nog niet beschikbaar: de database-update ontbreekt. Er is niets gewijzigd.";

export class BankPaymentError extends Error {
  readonly code: string | undefined;
  readonly deployWindow: boolean;

  constructor(message: string, code?: string, deployWindow = false) {
    super(message);
    this.name = "BankPaymentError";
    this.code = code;
    this.deployWindow = deployWindow;
  }
}

export function isBankPaymentDeployWindowError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return !!code && DEPLOY_WINDOW_CODES.has(code);
}

/** Zet een RPC-fout om in een BankPaymentError met een melding die je de gebruiker kunt tonen. */
export function toBankPaymentError(
  error: BankPaymentRpcError | null | undefined,
  action: "link" | "unlink" = "link",
): BankPaymentError {
  const verb = action === "unlink" ? "Ontkoppelen" : "Koppelen";
  if (isBankPaymentDeployWindowError(error)) {
    return new BankPaymentError(BANK_PAYMENT_NOT_AVAILABLE, error?.code, true);
  }
  const code = error?.code;
  const message = error?.message?.trim();
  if (code && OWN_REFUSAL_CODES.has(code) && message) {
    return new BankPaymentError(message, code);
  }
  return new BankPaymentError(
    message ? `${verb} is niet gelukt: ${message}` : `${verb} is niet gelukt. Er is niets gewijzigd; probeer het opnieuw.`,
    code,
  );
}

/** De melding voor een toast, voor elke fout (ook een netwerkfout of een eigen controle). */
export function bankPaymentErrorMessage(error: unknown): string {
  if (error instanceof BankPaymentError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Koppelen is niet gelukt. Er is niets gewijzigd; probeer het opnieuw.";
}

/**
 * Een bedrag in hele centen. Een bedrag uit de database (numeric(12,2)) heeft
 * hooguit twee decimalen; de vermenigvuldiging met 100 geeft dan hooguit
 * zwevendekommaruis, die hier wordt weggerond. Meer dan twee decimalen wordt
 * NIET afgerond maar geweigerd: de database rekent exact.
 */
export function amountToCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new BankPaymentError("Ongeldig bedrag");
  const scaled = amount * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 1e-6) {
    throw new BankPaymentError("Een bedrag heeft hooguit twee decimalen");
  }
  return cents;
}

/** Het bedrag voor de RPC: een exacte decimale tekst ("1234.50"), nooit een float. */
export function amountToRpc(amount: number): string {
  const cents = amountToCents(amount);
  if (cents <= 0) throw new BankPaymentError("Het koppelingsbedrag moet groter dan nul zijn");
  const euros = Math.floor(cents / 100);
  return `${euros}.${String(cents % 100).padStart(2, "0")}`;
}

/** Het kleinste van een aantal bedragen, op hele centen; null als iets onbekend is. */
export function minAmount(...amounts: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const a of amounts) {
    if (a == null || !Number.isFinite(a)) return null;
    const cents = Math.round(a * 100);
    if (best == null || cents < best) best = cents;
  }
  return best == null ? null : best / 100;
}

/** Eén request_id per handeling: een herhaling daarvan geeft exact hetzelfde antwoord. */
export function newPaymentRequestId(): string {
  return crypto.randomUUID();
}

export interface LinkBankPaymentResult {
  allocationId: string;
  outcome: "created" | "unchanged";
  invoiceRemaining: number | null;
  invoiceStatus: string;
  txMatchStatus: string;
  replayed: boolean;
}

export interface UnlinkBankPaymentResult {
  outcome: "unlinked" | "unchanged";
  removedCount: number;
  txMatchStatus: string;
  replayed: boolean;
}

/** De rij van link_bank_payment, zoals PostgREST haar teruggeeft. */
export function parseLinkResult(data: unknown): LinkBankPaymentResult {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row.allocation_id !== "string" || (row.outcome !== "created" && row.outcome !== "unchanged")) {
    throw new BankPaymentError("Koppelen gaf geen bruikbaar antwoord; ververs de pagina en controleer de koppeling.");
  }
  const remaining = row.invoice_remaining;
  return {
    allocationId: row.allocation_id,
    outcome: row.outcome,
    invoiceRemaining: remaining == null ? null : Number(remaining),
    invoiceStatus: String(row.invoice_status ?? ""),
    txMatchStatus: String(row.tx_match_status ?? ""),
    replayed: row.replayed === true,
  };
}

/** De rij van unlink_bank_payment. */
export function parseUnlinkResult(data: unknown): UnlinkBankPaymentResult {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || (row.outcome !== "unlinked" && row.outcome !== "unchanged")) {
    throw new BankPaymentError("Ontkoppelen gaf geen bruikbaar antwoord; ververs de pagina en controleer de koppeling.");
  }
  return {
    outcome: row.outcome,
    removedCount: Number(row.removed_count ?? 0),
    txMatchStatus: String(row.tx_match_status ?? ""),
    replayed: row.replayed === true,
  };
}

const formatEuro = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

/**
 * Eén melding na een geslaagde koppeling, uit het antwoord van de database
 * (niet uit een eigen berekening): deelbetaling, volledig betaald, of al
 * vastgelegd.
 */
export function linkResultMessage(
  result: LinkBankPaymentResult,
  invoiceType: BankPaymentInvoiceType,
): { title: string; description?: string } {
  if (result.outcome === "unchanged") {
    return { title: "Al gekoppeld", description: "Deze betaling was al met dit bedrag aan de factuur gekoppeld." };
  }
  if (result.invoiceRemaining != null && result.invoiceRemaining > 0) {
    return { title: "Deelbetaling gekoppeld", description: `Nog open: ${formatEuro(result.invoiceRemaining)}` };
  }
  if (invoiceType === "verkoop" && result.invoiceStatus !== "betaald") {
    return {
      title: "Betaling gekoppeld",
      description: "De factuur is volledig betaald, maar nog niet goedgekeurd; de status blijft staan.",
    };
  }
  return { title: "Betaling gekoppeld", description: "De factuur is volledig betaald." };
}

/** Eén samenvatting voor een reeks koppelingen of ontkoppelingen (één toast, FD-N1). */
export function batchResultMessage(
  done: number,
  failures: readonly string[],
  labels: { done: string; failed: string },
): { title: string; description?: string; variant?: "destructive" } {
  if (failures.length === 0) return { title: `${done} ${labels.done}` };
  const first = failures[0];
  return {
    title: done > 0 ? `${done} ${labels.done}, ${failures.length} ${labels.failed}` : `${failures.length} ${labels.failed}`,
    description: failures.length > 1 ? `${first} (en ${failures.length - 1} andere)` : first,
    variant: "destructive",
  };
}
