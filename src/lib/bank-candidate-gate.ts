/**
 * De veilige-matchpoort voor factuurKANDIDATEN: welke openstaande facturen
 * mogen bij een bankregel worden aangeboden, en welke mag vooraf worden
 * geselecteerd.
 *
 * Achtergrond (nulmeting A1-04, A1-11, C-04, C-14): PR #291 bracht de
 * veilige-matchcontrole alleen naar `handleConfirm` in Bank.tsx, een functie
 * zonder aanroeper. Het levende pad "Verwerken → Factuur koppelen" en de
 * suggesties bij de bankimport boden elke niet-gesloten factuur aan, van beide
 * soorten, zonder identiteit en zonder te kijken of er nog iets openstond.
 *
 * Een kandidaat moet hier aan ALLES voldoen:
 *   - zelfde richting: geld uit (negatief) ↔ inkoop, geld in (positief) ↔
 *     verkoop; een bedrag van nul heeft geen richting en krijgt niets;
 *   - zelfde administratie (client_id van de bankregel);
 *   - openstaand bedrag > 0, uit het restant en niet uit de status: een
 *     volledig betaalde inkoopfactuur houdt status "gecontroleerd";
 *   - niet afgewezen voor deze bankregel (fail-closed zonder afwijzingsdata);
 *   - identiteit volgens de bestaande matcher (`rankCandidates`, #286): een
 *     factuur die alleen op het bedrag lijkt, scoort 0 en valt af.
 * Voorselectie alleen bij precies één kandidaat met de hoogste score: bij
 * een gelijke topscore kiest de mens (C-04).
 *
 * Dit kiest en schrijft niets: wat er bij een koppeling met de factuur
 * gebeurt, is aan het schrijfpad (P5, D1: de database leidt de betaalstatus af).
 */
import { rankCandidates, type InvoiceCandidate } from "@/components/BankMatchDialog";
import { withoutRejectedCandidates } from "@/lib/bank-match-rejections";
import { getInvoiceRemainingAmount } from "@/lib/invoice-balances";
import type { Tables } from "@/integrations/supabase/types";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

export type GateInvoiceType = "inkoop" | "verkoop";

/** Wat de poort van een bankregel nodig heeft. Een nog niet opgeslagen importregel heeft id "". */
export type GateTransaction = Pick<BankTransaction, "id" | "client_id" | "amount" | "description" | "reference">;

/** Geld uit betaalt een inkoopfactuur, geld in een verkoopfactuur. Nul heeft geen richting. */
export function expectedInvoiceType(amount: number): GateInvoiceType | null {
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount < 0 ? "inkoop" : "verkoop";
}

/** Meer dan een halve cent open. Een onbekend bedrag telt als niet open (fail-closed). */
export function hasOpenAmount(invoice: Parameters<typeof getInvoiceRemainingAmount>[0]): boolean {
  const open = getInvoiceRemainingAmount(invoice);
  return open != null && Number.isFinite(open) && open > 0.005;
}

/**
 * De toegestane kandidaten, beste eerst (de volgorde van `rankCandidates`).
 * Zonder afwijzingsindex: geen enkele kandidaat.
 */
export function gatedInvoiceCandidates(
  tx: GateTransaction,
  purchases: readonly PurchaseInvoice[],
  sales: readonly SalesInvoice[],
  rejectionIndex: ReadonlySet<string> | undefined,
): InvoiceCandidate[] {
  if (!rejectionIndex) return [];
  const type = expectedInvoiceType(tx.amount);
  if (!type) return [];
  const sameAdministration = <T extends { client_id: string | null }>(invoice: T) => invoice.client_id === tx.client_id;
  const purchaseCandidates = type === "inkoop" ? purchases.filter((i) => sameAdministration(i) && hasOpenAmount(i)) : [];
  const salesCandidates = type === "verkoop" ? sales.filter((i) => sameAdministration(i) && hasOpenAmount(i)) : [];
  const ranked = rankCandidates(tx as BankTransaction, purchaseCandidates, salesCandidates);
  return withoutRejectedCandidates(rejectionIndex, tx.id, ranked).filter((c) => c.type === type && c.score > 0);
}

/**
 * De kandidaat die vooraf geselecteerd mag worden: de enige met de hoogste
 * score. Bij een gelijke topscore geen voorselectie.
 */
export function preselectCandidate(candidates: readonly InvoiceCandidate[]): InvoiceCandidate | null {
  const [first, second] = candidates;
  if (!first || first.score <= 0) return null;
  if (second && second.score === first.score) return null;
  return first;
}

/** True wanneer meerdere kandidaten de hoogste score delen. */
export function hasTiedTopCandidates(candidates: readonly InvoiceCandidate[]): boolean {
  const [first, second] = candidates;
  return !!first && !!second && first.score > 0 && first.score === second.score;
}

/** Een importregel heeft nog geen afwijzingen: er bestaat nog geen bankregel om af te wijzen. */
export const NO_REJECTIONS: ReadonlySet<string> = new Set<string>();
