import { describe, expect, it } from "vitest";
import {
  BANK_LEDGER_STATE_LABEL,
  codedNotPostedMessage,
  expectsLedgerPosting,
  resolveBankLedgerState,
  type BankLedgerFacts,
} from "@/lib/bank-ledger-status";
import {
  VAT_NOT_CHOSEN_REASON,
  applyVatChoiceGate,
  selectableCandidates,
  submittableIds,
  type BankBulkCandidate,
} from "@/lib/bank-bulk-posting";

const facts = (over: Partial<BankLedgerFacts> = {}): BankLedgerFacts => ({
  directlyPosted: new Set(),
  allocationsByTransaction: new Map(),
  postedAllocations: new Set(),
  ...over,
});

describe("grootboekstatus van een bankregel", () => {
  it("zonder feiten (laden of fout) is de status onbekend — nooit 'geboekt'", () => {
    expect(resolveBankLedgerState("tx-1", null)).toBe("onbekend");
  });

  it("een directe boekingsmarker ⇒ in grootboek", () => {
    expect(resolveBankLedgerState("tx-1", facts({ directlyPosted: new Set(["tx-1"]) }))).toBe("geboekt");
  });

  it("gecodeerd zonder marker en zonder koppelingen ⇒ nog niet in grootboek", () => {
    expect(resolveBankLedgerState("tx-1", facts())).toBe("niet_geboekt");
  });

  it("via facturen: alle koppelingen geboekt ⇒ geboekt; een deel ⇒ deels; geen ⇒ niet", () => {
    const allocationsByTransaction = new Map([["tx-1", ["a1", "a2"]]]);
    expect(resolveBankLedgerState("tx-1", facts({ allocationsByTransaction, postedAllocations: new Set(["a1", "a2"]) }))).toBe("geboekt");
    expect(resolveBankLedgerState("tx-1", facts({ allocationsByTransaction, postedAllocations: new Set(["a1"]) }))).toBe("deels_geboekt");
    expect(resolveBankLedgerState("tx-1", facts({ allocationsByTransaction }))).toBe("niet_geboekt");
  });

  it("een geboekte koppeling van een andere transactie telt niet mee", () => {
    const f = facts({
      allocationsByTransaction: new Map([["tx-1", ["a1"]], ["tx-2", ["a2"]]]),
      postedAllocations: new Set(["a2"]),
    });
    expect(resolveBankLedgerState("tx-1", f)).toBe("niet_geboekt");
    expect(resolveBankLedgerState("tx-2", f)).toBe("geboekt");
  });

  it("alleen verwerkte regels (gematcht, gecodeerd) krijgen een grootboekstatus", () => {
    expect(expectsLedgerPosting("gematcht")).toBe(true);
    expect(expectsLedgerPosting("handmatig_geboekt")).toBe(true);
    expect(expectsLedgerPosting("niet_gematcht")).toBe(false);
    expect(expectsLedgerPosting("suggestie")).toBe(false);
  });

  it("alleen de status 'geboekt' heeft een label dat 'in grootboek' belooft", () => {
    expect(BANK_LEDGER_STATE_LABEL.geboekt).toBe("In grootboek");
    expect(BANK_LEDGER_STATE_LABEL.niet_geboekt).toMatch(/^Nog niet/);
    expect(BANK_LEDGER_STATE_LABEL.onbekend).toMatch(/onbekend/);
  });

  it("de melding na coderen zegt nooit 'geboekt' en wijst de weg naar boeken", () => {
    for (const msg of [codedNotPostedMessage("4000 · Huisvesting"), codedNotPostedMessage(null)]) {
      expect(msg.title).not.toMatch(/geboekt/i);
      expect(msg.description).toMatch(/Nog niet in het grootboek/);
      expect(msg.description).toMatch(/Boeken in grootboek/);
    }
    expect(codedNotPostedMessage("4000 · Huisvesting").title).toBe("Gecodeerd op 4000 · Huisvesting");
  });
});

const candidate = (over: Partial<BankBulkCandidate>): BankBulkCandidate => ({
  transaction_id: "tx",
  transaction_date: "2026-03-02",
  amount: -121,
  description: "Kantoorartikelen",
  counter_account: null,
  match_status: "handmatig_geboekt",
  grootboekrekening_id: "gb-4100",
  btw_percentage: 21,
  is_posted: false,
  is_allocated: false,
  posting_group_id: null,
  workflow_state: "ready",
  reason: null,
  ...over,
});

describe("inhaalslag — geen stille BTW", () => {
  const rows = [
    candidate({ transaction_id: "met-21", btw_percentage: 21 }),
    candidate({ transaction_id: "geen-btw-gekozen", btw_percentage: 0 }),
    candidate({ transaction_id: "onbekend", btw_percentage: null }),
    candidate({ transaction_id: "al-geboekt", btw_percentage: null, workflow_state: "posted", is_posted: true }),
    candidate({ transaction_id: "geblokkeerd", btw_percentage: null, workflow_state: "blocked", reason: "Server zegt nee" }),
  ];

  it("een 'klare' regel zonder BTW-keuze wordt 'controle nodig' met een reden; 0 is een keuze", () => {
    const gated = applyVatChoiceGate(rows);
    const byId = new Map(gated.map((r) => [r.transaction_id, r]));
    expect(byId.get("onbekend")).toMatchObject({ workflow_state: "review_needed", reason: VAT_NOT_CHOSEN_REASON });
    expect(byId.get("met-21")?.workflow_state).toBe("ready");
    expect(byId.get("geen-btw-gekozen")?.workflow_state).toBe("ready");
    // Server-oordelen blijven onaangetast.
    expect(byId.get("al-geboekt")?.workflow_state).toBe("posted");
    expect(byId.get("geblokkeerd")).toMatchObject({ workflow_state: "blocked", reason: "Server zegt nee" });
    expect(selectableCandidates(gated).map((r) => r.transaction_id)).toEqual(["met-21", "geen-btw-gekozen"]);
    expect(submittableIds(gated, ["onbekend", "met-21"])).toEqual(["met-21"]);
  });

  it("muteert de serverrijen niet", () => {
    const copy = structuredClone(rows);
    applyVatChoiceGate(rows);
    expect(rows).toEqual(copy);
  });
});
