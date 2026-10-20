import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const action = readFileSync("src/components/bank/BankTransactionCorrectionAction.tsx", "utf8");
const posting = readFileSync("src/components/bank/BankTransactionPostingAction.tsx", "utf8");
const bank = readFileSync("src/pages/Bank.tsx", "utf8");

describe("bank correction frontend regression boundaries", () => {
  it("reads current persisted VAT before opening, never trusting stale detail VAT", () => {
    expect(action).toContain('.select("btw_percentage")');
    expect(action).toContain('setVat(String(data.btw_percentage ?? 0))');
  });
  it("snapshots posting group and uses only snapshot as the RPC concurrency token", () => {
    expect(action).toContain("setOpenedPostingGroupId(groupId)");
    expect(action).toContain("expectedPostingGroupId: openedPostingGroupId");
    expect(action).not.toContain("expectedPostingGroupId: posting.posting_group_id");
    expect(action).toContain("confirmed.data?.posting_group_id !== groupId");
  });
  it("fails closed on concurrent edits and requires accountant access", () => {
    expect(action).toContain('canCorrect !== true');
    expect(action).toContain("posting?.posting_group_id !== openedPostingGroupId");
  });
  it("prevents form state crossing transaction identities", () => {
    expect(posting).toContain("key={transaction.id}");
  });
  it("keeps current correction results visible, with 500-character reason limit", () => {
    expect(action).toContain('maxLength={500}');
    expect(action).toContain("bookassist:bank-correction-success");
    expect(bank).toContain("bookassist:bank-correction-success");
  });
});
