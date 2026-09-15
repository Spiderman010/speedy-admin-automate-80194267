import type { Tables } from "@/integrations/supabase/types";
import { resolveBankExportGrootboek } from "@/lib/snelstart-export";

type Client = Tables<"clients">;
type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type Vraagpost = Tables<"vraagposten">;

export interface GrootboekSlim {
  id: string;
  nummer: number;
  omschrijving: string;
  client_id: string | null;
}

export type ReadinessStatus = "klaar" | "niet_klaar" | "config_ontbreekt";

export interface ClientReadiness {
  clientId: string;
  bankGeblokkeerd: number;
  inkoopTeControleren: number;
  openVraagposten: number;
  verkoopConcept: number;
  configMissingBankDagboek: boolean;
  configMissingInkoopDagboek: boolean;
  configMissingVerkoopDagboek: boolean;
  configMissingDebiteurenRekening: boolean;
  configMissingCrediteurenRekening: boolean;
  configMissingBtwTeVorderenRekening: boolean;
  configMissingBtwTeBetalenRekening: boolean;
  configMissingBankRekening: boolean;
  configMissing1799: boolean;
  /** Human-readable list of what is missing, for display next to the status. */
  configMissingReasons: string[];
  status: ReadinessStatus;
}

function has1799(accounts: GrootboekSlim[]): boolean {
  return accounts.some(g => String(g.nummer ?? "").trim() === "1799");
}

/**
 * Pure function: computes export-readiness metrics for a single client.
 * All data is passed in; no side effects, no DB calls.
 *
 * bankGeblokkeerd: transactions that resolveBankExportGrootboek classifies as
 * blocked (source starts with "blocked_").
 *
 * Sales invoices with status "concept" are counted informational-only and do
 * not affect the readiness status pill.
 */
export function computeClientReadiness(
  client: Client,
  bankTransactions: BankTransaction[],
  purchaseInvoices: PurchaseInvoice[],
  salesInvoices: SalesInvoice[],
  vraagposten: Vraagpost[],
  grootboekrekeningen: GrootboekSlim[],
): ClientReadiness {
  const clientAccounts = grootboekrekeningen.filter(
    g => g.client_id === client.id || g.client_id === null,
  );

  const bankGeblokkeerd = bankTransactions
    .filter(t => t.client_id === client.id)
    .filter(t => resolveBankExportGrootboek(t, clientAccounts).source.startsWith("blocked_"))
    .length;

  const inkoopTeControleren = purchaseInvoices.filter(
    i => i.client_id === client.id && i.status === "te_controleren",
  ).length;

  const openVraagposten = vraagposten.filter(
    v => v.client_id === client.id && v.status !== "opgelost" && v.status !== "genegeerd",
  ).length;

  const verkoopConcept = salesInvoices.filter(
    i => i.client_id === client.id && i.status === "concept",
  ).length;

  const configMissingBankDagboek = client.bank_dagboek == null;
  const configMissingInkoopDagboek = client.inkoop_dagboek == null;
  const configMissingVerkoopDagboek = client.verkoop_dagboek == null;
  const configMissingDebiteurenRekening = client.debiteuren_rekening_id == null;
  const configMissingCrediteurenRekening = client.crediteuren_rekening_id == null;
  const configMissingBtwTeVorderenRekening = client.btw_te_vorderen_rekening_id == null;
  const configMissingBtwTeBetalenRekening = client.btw_te_betalen_rekening_id == null;
  const configMissingBankRekening = client.bank_rekening_id == null;
  const configMissing1799 = !has1799(clientAccounts);

  const configMissingReasons: string[] = [];
  if (configMissingBankDagboek) configMissingReasons.push("Bank-dagboek ontbreekt");
  if (configMissingInkoopDagboek) configMissingReasons.push("Inkoop-dagboek ontbreekt");
  if (configMissingVerkoopDagboek) configMissingReasons.push("Verkoop-dagboek ontbreekt");
  if (configMissingDebiteurenRekening) configMissingReasons.push("Debiteurenrekening ontbreekt");
  if (configMissingCrediteurenRekening) configMissingReasons.push("Crediteurenrekening ontbreekt");
  if (configMissingBtwTeVorderenRekening) configMissingReasons.push("BTW te vorderen (voorbelasting) ontbreekt");
  if (configMissingBtwTeBetalenRekening) configMissingReasons.push("BTW te betalen (af te dragen BTW) ontbreekt");
  if (configMissingBankRekening) configMissingReasons.push("Bankrekening grootboek ontbreekt");

  const hasConfigWarning = configMissingReasons.length > 0;

  const hasBlockers = bankGeblokkeerd > 0 || inkoopTeControleren > 0 || openVraagposten > 0;

  let status: ReadinessStatus;
  if (hasConfigWarning) {
    status = "config_ontbreekt";
  } else if (hasBlockers) {
    status = "niet_klaar";
  } else {
    status = "klaar";
  }

  return {
    clientId: client.id,
    bankGeblokkeerd,
    inkoopTeControleren,
    openVraagposten,
    verkoopConcept,
    configMissingBankDagboek,
    configMissingInkoopDagboek,
    configMissingVerkoopDagboek,
    configMissingDebiteurenRekening,
    configMissingCrediteurenRekening,
    configMissingBtwTeVorderenRekening,
    configMissingBtwTeBetalenRekening,
    configMissingBankRekening,
    configMissing1799,
    configMissingReasons,
    status,
  };
}
