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
    const result = classifyPr(makePr(), check(), { statuses: [], total_count: 0 });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.next).toContain("GO");
  });

  it("fails closed on red, missing, pending and wrong-head checks", () => {
    expect(classifyPr(makePr(), check("failure"), { statuses: [], total_count: 0 }).state).toBe("STOP");
    expect(classifyPr(makePr(), { check_runs: [] }, { statuses: [], total_count: 0 }).state).toBe("WAIT_CI");
    expect(classifyPr(makePr(), check(null as unknown as string, "in_progress"), { statuses: [], total_count: 0 }).state).toBe("WAIT_CI");
    const wrong = { check_runs: [{ ...check().check_runs[0], head_sha: "b".repeat(40) }] };
    expect(classifyPr(makePr(), wrong, { statuses: [], total_count: 0 }).ci).toBe("MISSING");
  });

  it("never treats draft or the wrong base branch as merge-ready", () => {
    expect(classifyPr(makePr({ draft: true }), check(), { statuses: [], total_count: 0 }).state).toBe("DRAFT");
    expect(classifyPr(makePr({ base: { ref: "dev" } }), check(), { statuses: [], total_count: 0 }).state).toBe("STOP");
  });

  it("reports Vercel failures for per-PR waiver, without inheriting approval", () => {
    const result = classifyPr(makePr(), check(), { statuses: [{ context: "Vercel", state: "failure" }], total_count: 1 });
    expect(result.vercel).toContain("apart GO");
    expect(result.state).toBe("REVIEW_REQUIRED");
    const integrationError = classifyPr(makePr(), check(), { statuses: [{ context: "Vercel", state: "error" }], total_count: 1 });
    expect(integrationError.vercel).toContain("apart GO");
  });

  it("fails closed when GitHub returns a truncated or unverifiable status page", () => {
    const visible = Array.from({ length: 30 }, (_, i) => ({
      context: "other-" + i, state: "success",
    }));
    const incomplete = classifyPr(makePr(), check(), { statuses: visible, total_count: 31 });
    expect(incomplete.state).toBe("STOP");
    expect(incomplete.vercel).toContain("ONVOLLEDIG");
    expect(incomplete.next).toContain("gepagineerd");
    expect(incomplete.vercel).not.toBe("Geen bekende Vercel-fout");
    expect(classifyPr(makePr(), check(), { statuses: visible }).state).toBe("STOP");

    const malformed = [
      { statuses: null, total_count: 0 },
      { statuses: "not-an-array", total_count: 0 },
      { statuses: [], total_count: -1 },
      { statuses: [], total_count: 1 },
      { statuses: [{ context: "Vercel", state: "success" }], total_count: 0 },
      { statuses: [], total_count: "0" },
    ];
    for (const value of malformed) {
      const pr = classifyPr(makePr(), check(), value);
      expect(pr.state).toBe("STOP");
      expect(pr.vercel).toContain("ONVOLLEDIG");
    }
  });

  it("detects Vercel errors beyond GitHub's default 30-status page", () => {
    const statuses = Array.from({ length: 31 }, (_, i) => ({
      context: "other-" + i, state: "success",
    }));
    statuses.push({ context: "Vercel", state: "error" });
    const complete = classifyPr(makePr(), check(), { statuses, total_count: statuses.length });
    expect(complete.vercel).toContain("apart GO");
    expect(complete.state).toBe("REVIEW_REQUIRED");
  });

  it("renders only advisory summaries and sanitizes issue/PR titles", () => {
    expect(safeText("danger|[x]<script>\nnext")).not.toMatch(/[|<>\[\]\n]/);
    const pr = classifyPr(makePr({ title: "PR | <unsafe>" }), check(), { statuses: [], total_count: 0 });
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
