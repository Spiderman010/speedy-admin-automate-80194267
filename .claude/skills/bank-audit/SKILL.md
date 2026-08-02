---
name: bank-audit
description: >
  Strictly read-only audit of BoekAssist bank data in the production database
  via the Lovable Cloud SQL editor in the browser (Claude in Chrome). Use this
  skill whenever the user asks to check, verify, audit, or investigate bank
  transactions, matches, allocations or export blockers in production data —
  any phrasing like "controleer de bank", "klopt de data", "audit de
  transacties". Read-only: it never mutates data and stops before any
  database change.
---

# Bank data audit (read-only)

Answer questions about production bank data with evidence, without changing
anything. The audit runs in the browser against the Lovable Cloud SQL editor;
this skill exists because a wrong query target or an accidental mutation here
touches real client bookkeeping.

## Hard rules

- **SELECT only.** INSERT, UPDATE, DELETE, ALTER, DROP, TRUNCATE, CREATE,
  GRANT, or any other schema or data mutation are prohibited — including
  inside CTEs, `RETURNING` tricks, or "just one small fix". If a fix seems
  needed, that is a finding for the report, not an action.
- **Stop before any database mutation.** The audit ends with a proposed next
  action; executing that action is a separate, explicitly approved task.
- Run `boekassist-start` first if this session has not verified the project
  guardrails yet (production ref `alxlbdhpbwlehbdbfejw`; blocked refs and
  forbidden environments are listed there).

## Procedure

1. **Verify the project.** Open the Lovable Cloud SQL editor via Claude in
   Chrome and confirm on screen that the active project is
   `alxlbdhpbwlehbdbfejw`. If the ref is not visible or different, stop.
2. **Verify the tables.** Before querying, confirm each table exists and is
   the intended one, e.g.
   `select to_regclass('public.bank_transactions');` — this catches typos and
   wrong-project situations cheaply.
3. **Query read-only, scoped.** Select only the columns the question needs,
   scope by organization/client where applicable, and use LIMIT plus ORDER BY
   for deterministic samples. Prefer aggregate counts first, then drill into
   examples.
4. **Read results in the browser.** Read and analyse query output directly
   from the SQL editor's result grid (Claude in Chrome page reading). Avoid
   CSV export/import when the browser result is sufficient — exports create
   loose copies of client financial data that outlive the audit.
5. **Cross-check against the code** when a result looks wrong: the matching
   and export rules live in `src/pages/Bank.tsx`, `src/lib/snelstart-export.ts`
   and `src/hooks/useBankTransactions.ts` — a "wrong" record is only wrong
   relative to what the app intends.

## Report format

End with exactly this structure, keeping each section concrete (counts + a
few identifying examples, not full data dumps):

```
### Beoordeelde records
<what was queried, scope, counts>

### Veilige records
<count + why they are fine>

### Twijfelgevallen
<count + per case: what is ambiguous and what would resolve it>

### Onjuiste records
<count + per case: the evidence that it is wrong>

### Voorgestelde vervolgactie
<the single next action you recommend — NOT executed>
```

If any category is empty, say so explicitly ("Geen") rather than omitting it.
