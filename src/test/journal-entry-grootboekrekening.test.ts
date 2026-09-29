import { describe, expect, it } from "vitest";

import * as journalEntryUtils from "@/lib/journal-entry-utils";
import { resolveJournalEntryLedgerLabel, type JournalEntryRecord } from "@/lib/journal-entry-utils";

const accounts = [
  { id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten", organization_id: "org-1" },
  { id: "gb-4400-other", nummer: 4400, omschrijving: "Kantoorkosten", organization_id: "org-2" },
  { id: "gb-7000", nummer: 7000, omschrijving: "Overige kosten", organization_id: "org-1" },
];

const journalEntry: JournalEntryRecord = {
  id: "je-1",
  user_id: "user-1",
  client_id: "client-1",
  organization_id: "org-1",
  entry_date: "2026-07-19",
  description: "Handmatige boeking",
  amount: 121,
  btw_percentage: 21,
  btw_amount: 21,
  ledger_account_id: null,
  grootboekrekening_id: "gb-4400",
  ledger_account_text: "4400 - Kantoorkosten",
  invoice_number: "INV-1",
  entry_type: "handmatig",
  created_at: "2026-07-19T00:00:00Z",
  updated_at: "2026-07-19T00:00:00Z",
};

function findSafeBackfillMatch(
  entry: Pick<JournalEntryRecord, "organization_id" | "ledger_account_text" | "grootboekrekening_id">,
  ledgerRows: Array<{ id: string; nummer: number; omschrijving: string; organization_id: string | null }>,
) {
  if (entry.grootboekrekening_id) return null;
  if (!entry.ledger_account_text || !entry.ledger_account_text.trim()) return null;

  const normalizedEntryLabel = entry.ledger_account_text.trim().toLowerCase();
  const matches = ledgerRows.filter((row) => {
    const normalizedLedgerLabel = `${row.nummer} - ${row.omschrijving}`.trim().toLowerCase();
    return row.organization_id === (entry.organization_id ?? null) && normalizedLedgerLabel === normalizedEntryLabel;
  });

  return matches.length === 1 ? matches[0].id : null;
}

describe("journal entry grootboekrekening flow", () => {
  it("the legacy create/edit builders are gone — the app no longer writes journal_entries", () => {
    // Snelle invoer is alleen-lezen: nieuwe boekingen lopen via het memoriaal.
    expect(Object.keys(journalEntryUtils).sort()).toEqual(["resolveJournalEntryLedgerLabel"]);
  });

  it("resolves a stored journal entry's account from grootboekrekening_id", () => {
    expect(resolveJournalEntryLedgerLabel(journalEntry, accounts)).toBe("4400 - Kantoorkosten");
  });

  it("falls back safely to ledger_account_text when no grootboekrekening_id is linked", () => {
    const textOnlyEntry: JournalEntryRecord = {
      ...journalEntry,
      grootboekrekening_id: null,
      ledger_account_text: "7000 - Overige kosten",
    };

    expect(resolveJournalEntryLedgerLabel(textOnlyEntry, accounts)).toBe("7000 - Overige kosten");
  });

  it("backfill only matches a unique normalized label within the same organization", () => {
    const backfillEntry: JournalEntryRecord = {
      ...journalEntry,
      grootboekrekening_id: null,
      ledger_account_text: " 4400 - Kantoorkosten ",
    };
    const blankTextEntry: JournalEntryRecord = {
      ...journalEntry,
      grootboekrekening_id: null,
      ledger_account_text: "",
    };

    expect(findSafeBackfillMatch(backfillEntry, accounts)).toBe("gb-4400");
    expect(findSafeBackfillMatch(blankTextEntry, accounts)).toBeNull();
  });
});
