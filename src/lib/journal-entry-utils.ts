import type { Tables } from "@/integrations/supabase/types";

/**
 * Legacy `journal_entries` — alleen nog gelezen (zie useJournalEntries.ts).
 * De formulier- en insertbouwers van de oude snelle invoer zijn verwijderd:
 * de app maakt deze regels niet meer aan.
 */

type Grootboekrekening = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "omschrijving">;
type LegacyJournalEntry = Tables<"journal_entries">;

export type JournalEntryRecord = LegacyJournalEntry & {
  grootboekrekening_id: string | null;
};

function formatLedgerLabel(account: Grootboekrekening) {
  return `${account.nummer} - ${account.omschrijving}`;
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
