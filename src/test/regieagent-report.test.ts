import { describe, expect, it } from "vitest";
import { classifyPr, renderReport, safeText, CI_NAME } from "../../scripts/regieagent-report.mjs";

const sha = "a".repeat(40);
const makePr = (overrides: Record<string, unknown> = {}) => ({
  number: 250, title: "Regieagent v2", html_url: "https://github.com/Spiderman010/speedy-admin-automate-80194267/pull/250",
  head: { sha }, base: { ref: "main" }, draft: false, ...overrides,
});
const check = (conclusion = "success", status = "completed") => ({
  check_runs: [{ id: 10, name: CI_NAME, head_sha: sha, status, conclusion }],
});

describe("Regieagent v2 — read-only advisory contracts", () => {
  it("never treats a green CI as merge permission", () => {
    const result = classifyPr(makePr(), check(), { statuses: [] });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.next).toContain("GO");
  });

  it("fails closed on red, missing, pending and wrong-head checks", () => {
    expect(classifyPr(makePr(), check("failure"), { statuses: [] }).state).toBe("STOP");
    expect(classifyPr(makePr(), { check_runs: [] }, { statuses: [] }).state).toBe("WAIT_CI");
    expect(classifyPr(makePr(), check(null as unknown as string, "in_progress"), { statuses: [] }).state).toBe("WAIT_CI");
    const wrong = { check_runs: [{ ...check().check_runs[0], head_sha: "b".repeat(40) }] };
    expect(classifyPr(makePr(), wrong, { statuses: [] }).ci).toBe("MISSING");
  });

  it("never treats draft or the wrong base branch as merge-ready", () => {
    expect(classifyPr(makePr({ draft: true }), check(), { statuses: [] }).state).toBe("DRAFT");
    expect(classifyPr(makePr({ base: { ref: "dev" } }), check(), { statuses: [] }).state).toBe("STOP");
  });

  it("reports Vercel failures for per-PR waiver, without inheriting approval", () => {
    const result = classifyPr(makePr(), check(), { statuses: [{ context: "Vercel", state: "failure" }] });
    expect(result.vercel).toContain("apart GO");
    expect(result.state).toBe("REVIEW_REQUIRED");
    const integrationError = classifyPr(makePr(), check(), { statuses: [{ context: "Vercel", state: "error" }] });
    expect(integrationError.vercel).toContain("apart GO");
  });

  it("renders only advisory summaries and sanitizes issue/PR titles", () => {
    expect(safeText("danger|[x]<script>\nnext")).not.toMatch(/[|<>\[\]\n]/);
    const pr = classifyPr(makePr({ title: "PR | <unsafe>" }), check(), { statuses: [] });
    const report = renderReport({
      generatedAt: "2026-10-19T00:00:00Z", prs: [pr],
      issues: [{ number: 45, html_url: "https://github.com/Spiderman010/speedy-admin-automate-80194267/issues/45", title: "Test | issue" }],
      prTotal: 1, issueTotal: 1, incomplete: false,
    });
    expect(report).toContain("nooit een merge- of productie-GO");
    expect(report).toContain(sha);
    expect(report).toContain("Gecontroleerde head-SHA");
    expect(report).toContain("NIET GECONTROLEERD");
    expect(report).not.toContain("PR | <unsafe>");
  });
});
