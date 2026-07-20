import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type Grootboekrekening = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "omschrijving">;
type LegacyJournalEntry = Tables<"journal_entries">;
type LegacyJournalEntryInsert = TablesInsert<"journal_entries">;

export type JournalEntryRecord = LegacyJournalEntry & {
  grootboekrekening_id: string | null;
};

export type JournalEntryInsertPayload = Omit<LegacyJournalEntryInsert, "user_id"> & {
  grootboekrekening_id?: string | null;
};

export interface JournalEntryFormState {
  client_id: string;
  entry_date: string;
  grootboekrekening_id: string | null;
  ledger_account_text: string;
  btw_percentage: number;
  amount: string;
  invoice_number: string;
  description: string;
}

function formatLedgerLabel(account: Grootboekrekening) {
  return `${account.nummer} - ${account.omschrijving}`;
}

export function createEmptyJournalEntryFormState(clientId = "", entryDate = new Date().toISOString().split("T")[0]): JournalEntryFormState {
  return {
    client_id: clientId,
    entry_date: entryDate,
    grootboekrekening_id: null,
    ledger_account_text: "",
    btw_percentage: 21,
    amount: "",
    invoice_number: "",
    description: "",
  };
}

export function resolveJournalEntryLedgerLabel(
  entry: Pick<JournalEntryRecord, "grootboekrekening_id" | "ledger_account_text">,
  accounts?: Grootboekrekening[],
) {
  if (entry.grootboekrekening_id && accounts) {
    const account = accounts.find((item) => item.id === entry.grootboekrekening_id);
    if (account) return formatLedgerLabel(account);
  }

  return entry.ledger_account_text ?? "";
}

export function toJournalEntryFormState(
  entry: JournalEntryRecord,
  accounts?: Grootboekrekening[],
): JournalEntryFormState {
  return {
    client_id: entry.client_id,
    entry_date: entry.entry_date,
    grootboekrekening_id: entry.grootboekrekening_id ?? null,
    ledger_account_text: resolveJournalEntryLedgerLabel(entry, accounts),
    btw_percentage: entry.btw_percentage ?? 21,
    amount: entry.amount != null ? String(entry.amount) : "",
    invoice_number: entry.invoice_number ?? "",
    description: entry.description ?? "",
  };
}

export function buildJournalEntryInsertPayload(
  form: JournalEntryFormState,
  amountIncl: number,
  btwAmount: number,
): JournalEntryInsertPayload {
  return {
    client_id: form.client_id,
    entry_date: form.entry_date,
    ledger_account_id: null,
    grootboekrekening_id: form.grootboekrekening_id || null,
    ledger_account_text: form.ledger_account_text || null,
    btw_percentage: form.btw_percentage,
    amount: amountIncl,
    btw_amount: btwAmount,
    invoice_number: form.invoice_number || null,
    description: form.description || null,
    entry_type: "handmatig",
  };
}
