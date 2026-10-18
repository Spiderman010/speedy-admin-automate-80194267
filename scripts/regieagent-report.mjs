// Read-only GitHub snapshot for BoekAssist Regieagent v2.
// No GitHub write endpoints, merge calls, production API calls or background loop.
import { appendFile } from "node:fs/promises";

export const REPOSITORY = "Spiderman010/speedy-admin-automate-80194267";
export const CI_NAME = "Typecheck, lint, tests & build";
const MAX_PRS = 20;
const MAX_ISSUES = 20;

export function safeText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[|<>\[\]\\]/g, " ")
    .slice(0, 110);
}

export function classifyPr(pr, checks, combinedStatus) {
  const matching = (checks.check_runs ?? [])
    .filter((c) => c.name === CI_NAME && c.head_sha === pr.head.sha)
    .sort((a, b) => Number(b.id) - Number(a.id));
  const check = matching[0];
  const ci = !check ? "MISSING" : check.status !== "completed"
    ? "PENDING" : check.conclusion === "success" ? "GREEN" : "RED";
  // GitHub combined-status responses are paginated (30 statuses by default).
  // Treat incomplete or malformed coverage as STOP; never infer a clean Vercel status.
  const statuses = Array.isArray(combinedStatus?.statuses) ? combinedStatus.statuses : [];
  const statusesComplete = Number.isSafeInteger(combinedStatus?.total_count)
    && combinedStatus.total_count >= 0
    && combinedStatus.total_count <= statuses.length;
  const hasVercelFailure = statuses
    .some((s) => s.context === "Vercel" && ["failure", "error"].includes(s.state));
  const base = pr.base?.ref === "main";
  const state = !statusesComplete || !base || ci === "RED" ? "STOP"
    : pr.draft ? "DRAFT"
      : ci !== "GREEN" ? "WAIT_CI"
        : "REVIEW_REQUIRED";
  const next = !statusesComplete ? "Controleer alle GitHub commitstatussen (gepagineerd)"
    : !base ? "Controleer PR-basisbranch"
    : ci === "RED" ? "Onderzoek mislukte CI"
      : pr.draft ? "Concept afronden"
        : ci !== "GREEN" ? "Wacht op CI op exacte head"
          : "Controleer reviews, threads, mergevoorwaarden en vraag apart GO";
  return {
    number: pr.number,
    title: safeText(pr.title),
    url: pr.html_url,
    head: pr.head.sha,
    state, ci, next,
    vercel: !statusesComplete ? "ONVOLLEDIG: commitstatussen (STOP)"
      : hasVercelFailure ? "Afwijking: apart GO nodig" : "Geen bekende Vercel-fout",
  };
}

export function renderReport({ generatedAt, prs, issues, prTotal, issueTotal, incomplete = false }) {
  const lines = [
    "# BoekAssist — Regieagent v2 (read-only snapshot)",
    "",
    "Moment (UTC): " + safeText(generatedAt),
    "",
    "**Alle conclusies zijn adviserende signalen, nooit een merge- of productie-GO.**",
    "Deze rapportage controleert geen reviewthreads, Codex-verdicts of eigenaarsgoedkeuring.",
    "",
    "## Open PR's (maximaal 20, laatst bijgewerkt eerst)",
    "",
    "| PR | Gecontroleerde head-SHA | Status | CI exacte head | Afwijking | Volgende stap |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  if (!prs.length) lines.push("| — | — | Geen open PR's | — | — | — |");
  for (const pr of prs) {
    lines.push("| [#" + pr.number + "](" + pr.url + ") " + pr.title +
      " | `" + pr.head + "` | " + pr.state + " | " + pr.ci + " | " + pr.vercel +
      " | " + safeText(pr.next) + " |");
  }
  lines.push("", "## Open Issues (maximaal 20, laatst bijgewerkt eerst)", "");
  if (!issues.length) lines.push("Geen open Issues in de opgehaalde selectie.");
  for (const issue of issues) {
    lines.push("- [#" + issue.number + "](" + issue.html_url + ") " + safeText(issue.title));
  }
  lines.push("", "## Reikwijdte en veiligheid", "");
  lines.push("- Ontvangen: " + prTotal + " PR's en " + issueTotal + " Issues (voor selectie).");
  if (incomplete) lines.push("- **ONVOLLEDIG:** GitHub-resultaat is afgekapt; ontbrekende items zijn niet beoordeeld.");
  lines.push("- Geen SQL, Supabase, Lovable-deployment, PR-mutaties, automatische merges of write tokens.");
  lines.push("- Vercel-fouten worden alleen gesignaleerd: geen overgenomen waiver.");
  lines.push("- Reviewthreads, CI-skips, Codex en mergeability zijn **NIET GECONTROLEERD**.");
  return lines.join("\n") + "\n";
}

async function githubGet(path, token) {
  const prefix = "/repos/" + REPOSITORY + "/";
  if (!path.startsWith(prefix) || /[\r\n]/.test(path)) throw new Error("GitHub endpoint outside repository");
  const url = "https://api.github.com" + path;
  const response = await fetch(url, {
    method: "GET", redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "boekassist-regieagent-readonly",
    },
  });
  if (!response.ok) throw new Error("GitHub read failed (" + response.status + ") for " + path.split("?")[0]);
  return response.json();
}

export async function collectSnapshot(token) {
  const root = "/repos/" + REPOSITORY;
  const [rawPrs, rawIssues] = await Promise.all([
    githubGet(root + "/pulls?state=open&sort=updated&direction=desc&per_page=100", token),
    githubGet(root + "/issues?state=open&sort=updated&direction=desc&per_page=100", token),
  ]);
  const openPrs = rawPrs.slice(0, MAX_PRS);
  const issues = rawIssues.filter((i) => !i.pull_request).slice(0, MAX_ISSUES);
  const prs = [];
  // Sequential bounded reads: simpler rate-limit behavior and no write-capable API.
  for (const pr of openPrs) {
    const sha = pr.head.sha;
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Unexpected PR SHA");
    const [checks, statuses] = await Promise.all([
      githubGet(root + "/commits/" + sha + "/check-runs?per_page=100", token),
      githubGet(root + "/commits/" + sha + "/status?per_page=100", token),
    ]);
    prs.push(classifyPr(pr, checks, statuses));
  }
  return {
    generatedAt: new Date().toISOString(), prs, issues,
    prTotal: rawPrs.length,
    issueTotal: rawIssues.filter((i) => !i.pull_request).length,
    incomplete: rawPrs.length === 100 || rawIssues.length === 100 ||
      rawPrs.length > MAX_PRS || rawIssues.filter((i) => !i.pull_request).length > MAX_ISSUES,
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !token) {
    throw new Error("Expected exact BoekAssist repository and read-only GITHUB_TOKEN");
  }
  const report = renderReport(await collectSnapshot(token));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report, "utf8");
  }
  process.stdout.write(report);
}

if (process.argv[1]?.endsWith("/regieagent-report.mjs")) {
  main().catch((err) => {
    process.stderr.write("Regieagent STOP: " + err.message + "\n");
    process.exitCode = 1;
  });
}
