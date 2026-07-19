import { describe, expect, it } from "vitest";

import {
  applyBookingTemplatesToTransactions,
  getBookingTemplateLedgerLabel,
  resolveBookingTemplateLedger,
  toBookingTemplateFormState,
} from "@/lib/booking-template-utils";
import {
  buildBookingTemplateInsertPayload,
  buildBookingTemplateUpdatePayload,
  type BookingTemplate,
} from "@/hooks/useBookingTemplates";

const accounts = [
  { id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten", organization_id: "org-1" },
  { id: "gb-7000", nummer: 7000, omschrijving: "Overige kosten", organization_id: "org-1" },
  { id: "gb-4400-other", nummer: 4400, omschrijving: "Kantoorkosten", organization_id: "org-2" },
];

const bookingTemplate: BookingTemplate = {
  id: "tpl-1",
  user_id: "user-1",
  name: "Regel",
  description: null,
  default_amount: null,
  btw_percentage: null,
  grootboekrekening_id: "gb-4400",
  ledger_account_text: "4400 - Kantoorkosten",
  ledger_account_id: "legacy-4400",
  client_id: null,
  zoekterm: "huur",
  zoek_in: "omschrijving",
  actie: "grootboek",
  geldt_voor: "alle",
  client_id_filter: null,
  prioriteit: 10,
  actief: true,
  created_at: "2026-07-18T00:00:00Z",
  organization_id: "org-1",
};

function findSafeBackfillMatch(
  template: Pick<BookingTemplate, "organization_id" | "ledger_account_text" | "grootboekrekening_id">,
  ledgerRows: Array<{ id: string; nummer: number; omschrijving: string; organization_id: string | null }>,
) {
  if (template.grootboekrekening_id) return null;
  if (!template.ledger_account_text || !template.ledger_account_text.trim()) return null;

  const normalizedTemplateLabel = template.ledger_account_text.trim().toLowerCase();
  const matches = ledgerRows.filter((row) => {
    const normalizedLedgerLabel = `${row.nummer} - ${row.omschrijving}`.trim().toLowerCase();
    return row.organization_id === (template.organization_id ?? null) && normalizedLedgerLabel === normalizedTemplateLabel;
  });

  return matches.length === 1 ? matches[0].id : null;
}

describe("booking template grootboekrekening flow", () => {
  it("builds create and update payloads without ledger_account_id", () => {
    const insertPayload = buildBookingTemplateInsertPayload(bookingTemplate);
    const updatePayload = buildBookingTemplateUpdatePayload({
      id: bookingTemplate.id,
      grootboekrekening_id: bookingTemplate.grootboekrekening_id,
      ledger_account_id: bookingTemplate.ledger_account_id,
      ledger_account_text: bookingTemplate.ledger_account_text,
    });

    expect(insertPayload.grootboekrekening_id).toBe("gb-4400");
    expect("ledger_account_id" in insertPayload).toBe(false);
    expect(updatePayload.grootboekrekening_id).toBe("gb-4400");
    expect("ledger_account_id" in updatePayload).toBe(false);
  });

  it("loads a template into the edit form using grootboekrekening_id", () => {
    const form = toBookingTemplateFormState(bookingTemplate, accounts);

    expect(form.grootboekrekening_id).toBe("gb-4400");
    expect(form.ledger_account_text).toBe("4400 - Kantoorkosten");
    expect(getBookingTemplateLedgerLabel(bookingTemplate, accounts)).toBe("4400 - Kantoorkosten");
    expect(resolveBookingTemplateLedger(bookingTemplate, accounts)?.id).toBe("gb-4400");
  });

  it("applies booking templates to bank import using grootboekrekening_id", () => {
    const [applied] = applyBookingTemplatesToTransactions(
      [
        {
          description: "Kantoor huur juli",
          reference: "",
          counterAccount: "Verhuurder BV",
          matchConfidence: null,
          matchStatus: "niet_gematcht" as const,
        },
      ],
      [bookingTemplate],
      "client-1",
    );

    expect(applied.matchStatus).toBe("handmatig_geboekt");
    expect(applied.grootboekrekeningId).toBe("gb-4400");
    expect(applied.grootboekText).toBe("4400 - Kantoorkosten");
  });

  it("keeps legacy text-only templates safe without guessing an id", () => {
    const legacyTemplate: BookingTemplate = {
      ...bookingTemplate,
      grootboekrekening_id: null,
      ledger_account_text: "7000 - Overige kosten",
      ledger_account_id: "legacy-7000",
    };

    expect(() => toBookingTemplateFormState(legacyTemplate, accounts)).not.toThrow();
    expect(getBookingTemplateLedgerLabel(legacyTemplate, accounts)).toBe("7000 - Overige kosten");
    expect(resolveBookingTemplateLedger(legacyTemplate, accounts)).toBeNull();

    const [applied] = applyBookingTemplatesToTransactions(
      [
        {
          description: "Kantoor huur juli",
          reference: "",
          counterAccount: "Verhuurder BV",
          matchConfidence: null,
          matchStatus: "niet_gematcht" as const,
        },
      ],
      [legacyTemplate],
      "client-1",
    );

    expect(applied.matchStatus).toBe("niet_gematcht");
    expect(applied.grootboekrekeningId).toBeUndefined();
  });

  it("backfill only matches a unique normalized label within the same organization", () => {
    const templateForBackfill: BookingTemplate = {
      ...bookingTemplate,
      grootboekrekening_id: null,
      ledger_account_text: " 4400 - Kantoorkosten ",
    };

    expect(findSafeBackfillMatch(templateForBackfill, accounts)).toBe("gb-4400");
  });

  it("backfill leaves templates without text or without a unique match untouched", () => {
    const noTextTemplate: BookingTemplate = {
      ...bookingTemplate,
      grootboekrekening_id: null,
      ledger_account_text: null,
    };
    const duplicateAccounts = [
      { id: "gb-7000-a", nummer: 7000, omschrijving: "Overige kosten", organization_id: "org-1" },
      { id: "gb-7000-b", nummer: 7000, omschrijving: "Overige kosten", organization_id: "org-1" },
    ];
    const duplicateTemplate: BookingTemplate = {
      ...bookingTemplate,
      grootboekrekening_id: null,
      ledger_account_text: "7000 - Overige kosten",
    };

    expect(findSafeBackfillMatch(noTextTemplate, accounts)).toBeNull();
    expect(findSafeBackfillMatch(duplicateTemplate, duplicateAccounts)).toBeNull();
  });
});
