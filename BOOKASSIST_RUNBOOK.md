# BOOKASSIST_RUNBOOK.md — Autonomous Development Runbook

This runbook defines how Claude Code should execute BoekAssist development phases with minimal operator intervention while preserving accounting, database, tenancy, migration and production safety.

It supplements `AGENTS.md` and `PROJECT_MAP.md`. If there is any conflict, the stricter rule wins. Production changes still require explicit human approval.

---

## 1. Mandatory startup sequence

Every implementation session must begin with:

```text
Read AGENTS.md and PROJECT_MAP.md first.
```

Then confirm all of the following before changing anything:

1. Repository is `Spiderman010/speedy-admin-automate-80194267`.
2. Base branch is the latest `origin/main`.
3. Work is on a new scoped feature branch.
4. No direct commit to `main`.
5. Production backend is Lovable Cloud-managed Supabase.
6. Production project ref is `alxlbdhpbwlehbdbfejw`.
7. Do not use refs `olumcwneiejjefhkzgmz` or `ycuofllsdssoezwwpqmv`.
8. Do not use the user's personal Supabase dashboard for production.
9. Do not use the Vercel Supabase Marketplace database for production.
10. Never hand-edit `src/integrations/supabase/types.ts`.

If any of these cannot be verified: **STOP**.

---

## 2. Autonomous execution boundary

Claude Code may autonomously:

- inspect the repository;
- inspect existing migrations and tests;
- create a scoped branch;
- implement one roadmap phase;
- add one scoped migration where required;
- build local PostgreSQL test/probe harnesses;
- run tests, type checks, build and lint;
- perform an adversarial review;
- open a pull request;
- amend that pull request after review feedback.

Claude Code must **not** autonomously:

- merge its own PR;
- run production SQL;
- apply production migrations;
- modify production data;
- deploy destructive schema changes;
- weaken RLS, immutability, tenant isolation or accounting controls just to get tests green;
- modify unrelated files;
- continue after discovering a genuine accounting-contract ambiguity.

A phase ends at **PR ready for independent review**, not at merge.

---

## 3. One phase at a time

Never combine roadmap phases in one PR.

Current accounting sequence:

1. 6C-b3 — purchase postings
2. 6C-b4 — sales postings
3. 6C-b5 — bank settlement postings
4. 6C-b6 — manual journal postings
5. 6C-b7 — true Grootboek reading from `ledger_postings`
6. Trial balance
7. Balance sheet / P&L
8. Period comparisons
9. Fiscal-year close/opening balance

Do not skip ahead when an earlier phase supplies invariants required by the next phase.

---

## 4. Standard implementation loop

For each phase, execute this loop without waiting for routine confirmation.

### Step A — Preflight

Inspect the actual current code and schema before designing anything.

Document:

- authoritative source tables;
- current save/update lifecycle;
- current status transitions;
- tenant ownership fields;
- configured ledger accounts;
- date, currency and fiscal-year semantics;
- whether source identifiers are durable;
- whether source rows can still mutate after posting;
- existing RLS, grants and helper functions;
- existing writer/RPC conventions.

Do not infer a contract from naming alone.

### Step B — STOP-condition check

Stop before implementation when any required accounting fact is not safely derivable, including:

- missing balancing account;
- ambiguous VAT treatment;
- missing source identity;
- ambiguous sign convention;
- undefined fiscal-year logic;
- undefined currency contract;
- insufficient tenant ownership information;
- unsupported correction/reversal semantics that would be required for correctness.

Report the smallest missing foundation instead of inventing behaviour.

### Step C — Design the database contract first

For financial writers, the database is authoritative.

Prefer a controlled RPC/function that derives values from stored source data rather than caller input.

Caller should normally provide only the immutable source identifier.

Derive server-side:

- organization;
- client/administration;
- user via `auth.uid()`;
- accounts;
- amounts;
- posting date;
- fiscal year;
- currency;
- posting group id.

No financial writer may rely on a frontend-only validation for correctness.

### Step D — Implement durable idempotency

Every source type must have database-enforced exactly-once semantics.

Do not rely on:

- frontend checks;
- SELECT-before-INSERT;
- line numbers;
- mutable source-line ids;
- advisory locks without durable uniqueness.

Preferred pattern:

- dedicated source-claim table;
- unique/primary source id;
- unique posting group id;
- claim and ledger rows in the same transaction;
- source-specific ledger INSERT guard that requires ledger rows to match the claim.

Each source writer gets its own proven source guard. Do not create a universal abstraction before all source contracts are known.

### Step E — Freeze posted source facts

Once a source document has produced immutable ledger rows, accounting-relevant source data must not silently diverge.

Protect at database level:

- accounting-relevant header fields;
- source lines;
- account assignments;
- posting date inputs;
- monetary values.

Allow only explicitly safe workflow/non-accounting fields where justified.

Corrections must eventually create new reversing/correcting ledger rows, never mutate posted history.

### Step F — Close save-vs-post races

When the source can be saved concurrently with posting, serialize both paths on the same durable row lock.

Typical pattern:

```sql
SELECT ... FOR UPDATE
```

The posting writer must then read all source facts only after acquiring the lock.

Prove both orderings with two independent PostgreSQL sessions.

---

## 5. Accounting writer invariants

Every writer into `ledger_postings` must preserve the 6C-b2 foundation:

- append-only;
- no UPDATE;
- no DELETE;
- no TRUNCATE;
- one positive side per row;
- balanced group;
- at least two rows per group;
- same organization/client/date/currency/fiscal year per group;
- random UUID v4 `posting_group_id`;
- group created in one transaction;
- `created_xact_id` set only by the database trigger;
- tenant-safe account scope;
- real `auth.uid()` attribution;
- READ COMMITTED writer contract.

Never weaken these invariants for a new source writer.

---

## 6. Migration rules

For one phase, prefer exactly one new scoped migration.

Rules:

- never edit previously merged migration files;
- additive/non-destructive by default;
- include rollback comments;
- no historical backfill unless explicitly approved;
- no Combined Fresh Install Schema;
- do not run migration on production;
- explicitly inspect final grants/ACL assumptions;
- account for Lovable Cloud default privileges instead of assuming PostgreSQL defaults are the final state.

If the new table must be read-only to app users, explicitly revoke write/admin-style privileges and grant only the intended surface.

---

## 7. Security review checklist

Before marking any financial phase ready, actively try to break:

- tenant isolation;
- role enforcement;
- direct table bypass around the RPC;
- source idempotency;
- duplicate groups;
- wrong organization/client/account;
- stale configuration;
- partial transaction rollback;
- concurrent duplicate calls;
- source mutation after posting;
- save-vs-post race;
- source-type spoofing;
- posting-group spoofing;
- caller-supplied user id;
- caller-supplied accounting amounts;
- privilege/default-ACL surprises.

Do not call the PR merge-ready if the database can still be bypassed even when the normal UI path is safe.

---

## 8. Real PostgreSQL proof requirement

Static SQL-string tests are necessary but insufficient for financial writers.

Use a real local PostgreSQL instance and apply the relevant real migration stack.

For every writer, prove at minimum:

1. happy-path balanced posting;
2. VAT path where applicable;
3. multi-line posting;
4. duplicate attempt;
5. missing required account;
6. wrong tenant;
7. unauthorized role;
8. reconciliation failure;
9. atomic rollback after a failure occurring after source claim;
10. direct table bypass attempt;
11. source mutation after posting;
12. exact final ACLs;
13. two-session duplicate-post concurrency;
14. two-session save-vs-post concurrency when applicable.

For concurrency tests, use two independent connections/sessions and record the observed ordering/result.

If two attempts can both create valid source postings: **BLOCKED**.

---

## 9. App integration rule

Keep UI integration minimal.

The app may:

- call the controlled RPC;
- show posted/not-posted state;
- display safe database error messages;
- disable accounting edits already blocked by database rules.

The app must not:

- construct arbitrary ledger rows;
- calculate authoritative journal entries client-side;
- become the only enforcement layer;
- redesign unrelated workflows during a financial-core phase.

---

## 10. Generated Supabase types

Never hand-edit:

```text
src/integrations/supabase/types.ts
```

If a PR introduces schema/RPC objects not yet present in generated types:

1. use the smallest documented temporary narrow type/cast needed for compilation;
2. clearly mark it temporary;
3. after the production migration is explicitly approved and applied, regenerate types from the actual Lovable Cloud production schema;
4. remove the temporary workaround in a tiny cleanup PR.

Do not fabricate generated RPC/table definitions manually.

---

## 11. Required validation

Before opening or updating the PR, run:

```bash
npx tsc --noEmit
npx tsc -p tsconfig.app.json --noEmit
npm run test
npm run build
npm run lint
```

Also run:

- targeted tests for the phase;
- ledger-foundation tests for any writer change;
- real PostgreSQL semantic/concurrency probes for financial writers.

Known pre-existing baseline issues may be reported but must not be silently fixed outside scope.

Never claim a check passed if it did not run.

---

## 12. Independent-review handoff

Every completed phase must end with this exact structure:

```text
## Preflight
- latest main SHA
- branch
- production ref confirmed
- source model summary

## Contract
- trigger/finalization point
- source identity
- debit/credit construction
- VAT treatment
- date
- fiscal year
- currency

## Idempotency
- source claim
- direct-ledger bypass protection
- concurrency guarantee
- rollback guarantee

## Source immutability
- protected source fields/rows
- explicitly allowed post-booking changes
- correction limitation

## Security
- function security model
- role requirement
- tenant checks
- RLS/grants/ACLs

## PostgreSQL proofs
- happy-path cases
- fail-closed cases
- adversarial cases
- concurrency results

## Reviewed files

## Changed files

## Migrations
- filename + purpose, or None

## Validation
- tsc
- app tsc
- targeted tests
- full tests
- build
- lint

## PR
- link

## Head SHA

## Adversarial verdict
MERGE READY or BLOCKED
```

Do not merge automatically.

---

## 13. Fast review-fix cycle

When an independent reviewer identifies a blocker:

1. stay on the same unmerged feature branch;
2. verify the blocker independently;
3. if valid, fix only that issue;
4. add a regression test/probe reproducing the bypass;
5. rerun the full relevant proof suite, not only the new test;
6. push the new head to the same PR;
7. return the new head SHA and updated adversarial verdict.

Never dismiss a valid blocker because the normal UI cannot trigger it. Database invariants must survive direct authenticated access permitted by the schema.

---

## 14. Phase-specific templates

### 6C-b4 — Sales posting

Expected entry shape, subject to preflight verification:

```text
DEBIT   debtor                     gross invoice amount
CREDIT  revenue account(s)         net amount(s)
CREDIT  VAT payable                VAT amount
```

Must verify before implementation:

- authoritative sales amount model;
- durable sales line/source identity;
- `sales_invoices.grootboekrekening_id` semantics;
- `clients.debiteuren_rekening_id`;
- `clients.btw_te_betalen_rekening_id`;
- credit-note handling;
- posting/final status;
- source editability;
- whether sales lines even exist and how revenue splits work.

If sales is header-only and cannot safely represent revenue allocation: STOP and propose the smallest missing foundation.

### 6C-b5 — Bank settlement posting

Do not treat matching/allocation as revenue or expense recognition.

Bank posting should settle balance-sheet positions where source invoices already recognized the P&L/VAT.

Must verify:

- sign convention of `bank_transactions`;
- bank ledger account configuration;
- `bank_transaction_allocations` semantics;
- partial settlements;
- one bank transaction allocated to multiple invoices;
- over/underpayments;
- unmatched bank transactions / vraagpost workflow;
- source idempotency and allocation mutation rules.

Do not duplicate invoice revenue/expense/VAT through bank settlement.

### 6C-b6 — Manual journal posting

Do not map the legacy one-sided signed `journal_entries` model directly into immutable double entry unless a safe balanced-line contract exists.

Must verify or create the smallest foundation for:

- explicit balanced journal lines;
- debit/credit side;
- posting group identity;
- author;
- date/year;
- corrections/reversals;
- source immutability.

No synthetic contra account guessing.

### 6C-b7 — True Grootboek

Only after b3-b6 writers are structurally complete.

Read from `ledger_postings`, not legacy source tables, for accounting balances.

Must preserve:

- tenant isolation;
- account/client scoping;
- fiscal year filters;
- debit/credit presentation;
- drill-down to source identity;
- reversal visibility;
- deterministic totals.

Do not hide imbalance or unsupported legacy data by combining old and new ledgers without an explicit transition contract.

---

## 15. Production boundary

A merged migration is still **not production-applied**.

Production migration flow remains:

1. independent PR review;
2. human-authorized merge;
3. read-only production preflight in Lovable Cloud SQL editor;
4. explicit human approval to apply the single migration;
5. execute in Lovable Cloud SQL editor only;
6. read-only postcheck;
7. regenerate generated types from actual production schema if required;
8. remove temporary type workarounds in a separate tiny PR.

Claude Code must stop before step 3 unless explicitly given a new task to prepare verification SQL. It must never apply production SQL on its own.

---

## 16. Definition of done

A roadmap phase is technically ready for independent review only when:

- scope is one phase;
- database contract is explicit;
- accounting entry balances exactly;
- idempotency is database-enforced;
- direct write bypasses are closed;
- posted source facts cannot diverge;
- concurrency has been proven;
- tenant/role boundaries are proven;
- rollback is atomic;
- no historical data was silently backfilled;
- generated types were not hand-edited;
- all required validation has run;
- the PR is open and unmerged;
- the completion report is complete.

If any item is not proven, verdict must be **BLOCKED**, with the smallest concrete next step.