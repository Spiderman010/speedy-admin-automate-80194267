# Claude Code workflow — BoekAssist

Minimal map of the Claude Code configuration in this repository and when each
piece applies. The underlying rules live in `AGENTS.md` (workflow, checks,
migrations, UBL/SnelStart) and `PROJECT_MAP.md` (production database
verification); this configuration only encodes and enforces them.

## Components

| Path | What it is | When it applies |
|---|---|---|
| `.claude/settings.json` | Permission guardrails | Always. Denies edits to `src/integrations/supabase/types.ts` and `.lovable/plan.md`, and denies `git push` to `main`. |
| `.claude/skills/boekassist-start/` | Session-start verification skill | Start of any working session, and before anything that touches the database. Verifies repo identity, latest-main discipline, production ref `alxlbdhpbwlehbdbfejw`, blocked refs, and the SQL-editor-only rule. |
| `.claude/skills/bank-audit/` | Read-only bank data audit skill | When asked to check/audit production bank data. SELECT-only via the Lovable Cloud SQL editor in the browser; fixed report format; stops before any mutation. |
| `.claude/agents/database-auditor.md` | Read-only subagent | For evidence-based verification of schema/RLS/migration/data claims. Read-only tools; reports Verified / Uncertain / Refuted. |

## Ground rules the configuration assumes

- Never commit directly to `main`; all work goes through a PR from a
  `feature/` or `fix/` branch created from the latest `origin/main`.
- Production SQL only through the visible Lovable Cloud SQL editor on project
  `alxlbdhpbwlehbdbfejw` — never the personal Supabase dashboard, never the
  Vercel Supabase Marketplace database, never the blocked refs
  (`olumcwneiejjefhkzgmz`, `ycuofllsdssoezwwpqmv`), never a "Combined Fresh
  Install Schema".
- Verification before completion: `npx tsc --noEmit`,
  `npx tsc -p tsconfig.app.json --noEmit` (the root config is solution-style
  and checks nothing on its own), `npm run lint`, `npm run test`.

## Out of scope of this configuration

No Lovable MCP database tools or Supabase MCP are configured here; database
access in these workflows is deliberately limited to the human-visible SQL
editor in the browser.
