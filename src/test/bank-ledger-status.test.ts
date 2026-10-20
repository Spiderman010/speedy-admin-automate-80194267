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
  directPostingGroup: new Map(),
  allocationPostings: new Map(),
  reversedGroups: new Set(),
  ...over,
});
const tx = (id: string, amount = -100) => ({ id, amount });

describe("grootboekstatus van een bankregel", () => {
  it("zonder feiten (laden of fout) is de status onbekend — nooit 'geboekt'", () => {
    expect(resolveBankLedgerState(tx("tx-1"), null)).toBe("onbekend");
  });

  it("een directe boekingsmarker ⇒ in grootboek", () => {
    expect(resolveBankLedgerState(tx("tx-1"), facts({ directPostingGroup: new Map([["tx-1", "g1"]]) }))).toBe("geboekt");
  });

  it("een teruggedraaide directe boeking staat niet meer in het grootboek, ook al staat de marker er nog", () => {
    const f = facts({ directPostingGroup: new Map([["tx-1", "g1"]]), reversedGroups: new Set(["g1"]) });
    expect(resolveBankLedgerState(tx("tx-1"), f)).toBe("teruggedraaid");
  });

  it("gecodeerd zonder marker en zonder geboekte koppelingen ⇒ nog niet in grootboek", () => {
    expect(resolveBankLedgerState(tx("tx-1"), facts())).toBe("niet_geboekt");
  });

  it("via facturen telt het geboekte bedrag: alles ⇒ geboekt, een deel ⇒ deels (ook als elke koppeling geboekt is)", () => {
    const vol = facts({ allocationPostings: new Map([["tx-1", [{ postingGroupId: "a", amount: 60 }, { postingGroupId: "b", amount: 40 }]]]) });
    expect(resolveBankLedgerState(tx("tx-1", -100), vol)).toBe("geboekt");
    const deel = facts({ allocationPostings: new Map([["tx-1", [{ postingGroupId: "a", amount: 60 }]]]) });
    expect(resolveBankLedgerState(tx("tx-1", -100), deel)).toBe("deels_geboekt");
    // Afronding op centen.
    const afgerond = facts({ allocationPostings: new Map([["tx-1", [{ postingGroupId: "a", amount: 33.33 }, { postingGroupId: "b", amount: 66.67 }]]]) });
    expect(resolveBankLedgerState(tx("tx-1", 100), afgerond)).toBe("geboekt");
  });

  it("een teruggedraaide koppeling telt niet mee; alles teruggedraaid ⇒ teruggedraaid", () => {
    const postings = [{ postingGroupId: "a", amount: 60 }, { postingGroupId: "b", amount: 40 }];
    const een = facts({ allocationPostings: new Map([["tx-1", postings]]), reversedGroups: new Set(["b"]) });
    expect(resolveBankLedgerState(tx("tx-1", -100), een)).toBe("deels_geboekt");
    const alle = facts({ allocationPostings: new Map([["tx-1", postings]]), reversedGroups: new Set(["a", "b"]) });
    expect(resolveBankLedgerState(tx("tx-1", -100), alle)).toBe("teruggedraaid");
  });

  it("een geboekte koppeling van een andere transactie telt niet mee", () => {
    const f = facts({ allocationPostings: new Map([["tx-2", [{ postingGroupId: "a", amount: 100 }]]]) });
    expect(resolveBankLedgerState(tx("tx-1"), f)).toBe("niet_geboekt");
    expect(resolveBankLedgerState(tx("tx-2"), f)).toBe("geboekt");
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
    expect(BANK_LEDGER_STATE_LABEL.teruggedraaid).toMatch(/niet in grootboek/);
    for (const [state, label] of Object.entries(BANK_LEDGER_STATE_LABEL)) {
      if (state !== "geboekt") expect(label, state).not.toBe("In grootboek");
    }
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
