---
name: boekassist-start
description: >
  Session-start verification for the BoekAssist repository. Use this skill at
  the beginning of ANY working session on this repo — before creating a
  branch, before writing code, and always before anything that touches the
  database — to verify the repository identity, git discipline and the
  production database guardrails. Also use it whenever a task mentions
  production SQL, Supabase, Lovable Cloud, or a project ref, to confirm the
  target is the correct production project.
---

# BoekAssist session start

BoekAssist pre-processes bookkeeping for the accounting firm Agio Finance and
feeds SnelStart. Mistakes reach real client financial data, and the single
most damaging mistake possible is running SQL against the wrong database.
Verify everything below before starting work. `AGENTS.md` and
`PROJECT_MAP.md` in the repository root are the source of truth — read both;
if anything here conflicts with them, they win.

## 1. Repository verification

Run `git remote -v` and confirm the remote is
`Spiderman010/speedy-admin-automate-80194267`. If it is anything else, stop
and report — do not "adapt" the workflow to a different repository.

## 2. Git discipline

- `git fetch origin main` and start from `origin/main` — never assume a
  previously seen commit is still the latest main.
- All work happens on a feature branch (`feature/<slug>` or `fix/<slug>`).
- Never commit directly to `main`, never merge a PR yourself, never
  force-push shared history.

## 3. Production database guardrails

| Item | Value |
|---|---|
| Production Supabase project ref | `alxlbdhpbwlehbdbfejw` |
| **Blocked** refs — never target these | `olumcwneiejjefhkzgmz`, `ycuofllsdssoezwwpqmv` |

- Production SQL is executed **only** through the visible Lovable Cloud SQL
  editor (Lovable → Cloud icon, or Cmd/Ctrl+K → "Cloud"), after confirming on
  screen that the active project is `alxlbdhpbwlehbdbfejw`. The full
  verification checklist (network tab, `sb-project-ref` header) is in
  `PROJECT_MAP.md`.
- **Never** use the personal Supabase dashboard (supabase.com/dashboard) for
  this project — production does not even appear there, and anything that
  does appear is the wrong database.
- **Never** use the Vercel Supabase Marketplace database — its environment
  variables exist in Vercel but do not belong to the running app.
- **Never** run a "Combined Fresh Install Schema" on production.
- If the project ref is unclear at any point: stop. Do not run SQL.

## 4. Generated files

Never hand-edit `src/integrations/supabase/types.ts` — it is generated from
the database schema; manual edits desync the types from reality and are
overwritten. `.claude/settings.json` denies edits to it as a backstop, but
the rule holds even where that enforcement is absent.

## 5. Before completing

Run the verification commands from `AGENTS.md` and note that the root
`tsconfig.json` is solution-style (`"files": []`), so also run
`npx tsc -p tsconfig.app.json --noEmit` — the root command alone type-checks
nothing.
