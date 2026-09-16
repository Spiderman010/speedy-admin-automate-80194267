# BoekAssist AI Build Strategy

How BoekAssist should be built faster and more consistently with AI, based on
the patterns proven across phases 6C-b1 through 6C-b5b (ledger foundation,
client VAT/bank ledger configuration, purchase posting, sales posting, and
bank settlement — see `PROJECT_MAP.md` for each phase's detail). This
document is about *process*; `BOOKASSIST_ACCOUNTING_PATTERNS.md` is about
*the reusable accounting engineering patterns themselves*.

The goal is to reduce repeated design work: reuse a proven implementation or
pattern before inventing a new one, and only spend fresh design effort where
the problem is actually new.

---

## 1. Research first, build second

For a substantial module (a new writer, a new subsystem, a new integration),
research before implementation:

- Inspect existing BoekAssist patterns first. Phases 6C-b3/6C-b4/6C-b5b are
  the current reference implementations for a posting writer; a new writer
  should start by reading the most recent one in full, not by re-deriving
  the shape from scratch.
- Inspect mature open-source implementations when useful (accounting/ERP
  systems, PostgreSQL extensions, well-known libraries) for architecture
  ideas, edge cases already discovered by someone else, and test coverage
  patterns.
- Inspect relevant GitHub repositories/libraries for prior art on the
  specific problem (e.g. period-closing algorithms, reconciliation
  matching, VAT return calculation).
- Identify what is reusable — architecture, edge cases, tests — before
  writing a single line of BoekAssist-specific code.
- Only then design the BoekAssist implementation, adapted to BoekAssist's
  actual schema and constraints, not the source project's.

**Do not copy whole frameworks blindly.** The goal is reusing proven
patterns — a lock order, an idempotency shape, a test checklist — not
importing unnecessary architecture, dependencies, or abstractions that
BoekAssist's actual scale doesn't need.

---

## 2. Separate research/architecture from implementation

Preferred flow for anything non-trivial:

1. **Research / architecture pass** — audit the real schema and code (never
   assume), establish the facts a design must be built on (sign semantics,
   existing constraints, existing precedent), and produce a concrete,
   evidence-based contract.
2. **Short design decision** — a compact statement of the contract, checked
   against the evidence, before any code is written.
3. **Implementation pass** — build exactly what the design decided.
4. **Independent adversarial review** — a reviewer with fresh context (no
   memory of writing the code) actively tries to break it: double-posting,
   sign inversion, tenant leakage, missing immutability, race conditions.
5. **PR review** — human review, focused per section 9 below.
6. **Production rollout** — if the change includes schema, per section 7.

The implementation agent should not simultaneously invent the architecture
unless the task is genuinely trivial (a one-file cleanup, a copy-edit, a
narrow bugfix). For anything where getting the contract wrong is expensive —
especially anything touching `ledger_postings` — architecture and
implementation should be separated even when done in the same session, so
the design commitments are explicit and checkable before code is written
against them.

---

## 3. Model choice by task

Current preference, not a universal ranking — pick based on the shape of the
task, not habit:

| Task | Preferred |
|---|---|
| Accounting architecture, concurrency, reversals, journals, VAT/control design, difficult audits | Fable 5 / 5.1 |
| Complex but bounded implementation or architecture | Opus 5 |
| Isolated cleanup, UI, tests, typing, documentation | Sonnet 5 |
| UI/product work and generated Supabase type sync where appropriate | Lovable |

No model is universally best. A phase's audit-and-design step and its
mechanical shim-removal follow-up are different shapes of work and can
reasonably use different models, as has already happened across 6C-b3
through 6C-b5b's cleanup PRs.

---

## 4. Parallelism rules

**Allowed:**

- Researching the next phase while the current implementation is under
  review (e.g. auditing 6C-b6 while 6C-b5b's PR is open).
- An independent reviewer agent running in parallel with, or immediately
  after, implementation — as long as it reviews a fixed commit, not a
  moving target.
- Independent investigation of unrelated modules at the same time.

**Not allowed:**

- Two agents modifying the same files or module simultaneously.
- Parallel production SQL of any kind.
- Multiple schema migrations against production at once. Migrations are
  applied one at a time, in the Lovable Cloud SQL editor, by a human, after
  review — never concurrently, never automated.

---

## 5. Reuse before invention

Before building a large subsystem, actively check for:

- Existing BoekAssist precedents (the closest phase that solved a similar
  problem).
- Open-source accounting/ERP implementations for the general shape of the
  problem.
- PostgreSQL/Supabase patterns (RLS, SECURITY DEFINER hardening, constraint
  triggers, `DEFERRABLE` checks) already established in
  `supabase/migrations/`.
- shadcn/UI primitives already used elsewhere in the app, instead of adding
  new ones.
- Existing test utilities and conventions (the `sales-ledger-posting.test.ts`
  / `bank-ledger-posting.test.ts` style of static-SQL-assertion tests, the
  throwaway-PostgreSQL-cluster harness pattern for real concurrency proofs).

Examples of subsystems where this matters most: journal entries, reversal
engines, period closing, bank reconciliation, VAT reporting, financial
statements, import formats, UBL/OCR pipelines. Each of these has almost
certainly been solved before, publicly, by systems designed by people who
have already discovered the edge cases.

---

## 6. Small PR discipline

- One accounting concern per PR. A posting writer's accounting logic and an
  unrelated UI change do not belong in the same PR.
- Schema rollout separated from application consumption whenever a
  deploy-order risk exists — i.e. whenever the application could ship before
  the migration is applied to production and reference a column or object
  that doesn't exist yet. PostgREST rejects an entire request that names an
  unknown column rather than ignoring it, so this is not a style
  preference; it is what happened (and was caught and split) in 6C-b5a,
  where the schema PR and the UI/readiness PR were deliberately separate.
- A temporary type shim is used only when generated types genuinely cannot
  yet know about a production object — i.e. the migration hasn't been
  applied to production yet, so `types.ts` (never hand-edited) has nothing
  to generate from. The shim is a narrow, clearly-commented structural cast
  scoped to exactly the new table/RPC, never a broad reimplementation of the
  Supabase client's types.
- A tiny shim-removal PR follows once types are regenerated after the
  production apply — see PRs #148, #150, #154 for the pattern across
  purchase, sales, and bank settlement.

---

## 7. Production rollout pattern

For any change that includes a schema migration:

1. **Read-only preflight** — one SQL query verifying the assumed starting
   state (expected objects present, expected objects *absent*, no partial
   prior application, no unexpected existing data) before touching
   anything.
2. **One migration** — applied as a single batch in the Lovable Cloud SQL
   editor, never combined with another migration, never split into pieces
   that could be applied out of order.
3. **Read-only combined postcheck** — one SQL query verifying structure
   (tables/functions/triggers/indexes/constraints), data invariants (no
   unexpected backfill occurred), ACLs (exact grant grids for the new
   objects), and RLS, all in one pass.
4. **Generated type sync** — regenerate `src/integrations/supabase/types.ts`
   from the live production schema. Never hand-edit this file.
5. **Shim cleanup** — if a temporary type shim was used, remove it in its
   own tiny PR once step 4 is done.

**Production SQL is executed only through the Lovable Cloud SQL editor**,
after visually confirming the active project matches the documented
production ref in `AGENTS.md`/`PROJECT_MAP.md`. Never the personal Supabase
dashboard, never the Vercel Supabase Marketplace project, never a blocked
project ref.

---

## 8. Automation / efficiency

Whenever a phase includes a migration, produce the rollout material as
clearly separated, pasteable sections — conceptually `preflight.sql`,
`migration.sql`, `postcheck.sql`, even when delivered inline in a message
rather than as separate files. This lets a human paste and run each stage
independently without editing it first.

Postchecks should ideally collapse to **one result row of boolean/count
checks** (or a small, fixed-width grid) rather than a scroll of unrelated
query output — something a reviewer can scan in a few seconds and see
"everything is exactly what was expected" or "here is the one thing that
isn't."

---

## 9. Human review focus

Human review time is the scarcest resource in this process. It should focus
on the things a human is actually positioned to judge better than an
automated check:

- The accounting contract itself — is this genuinely what should be
  debited/credited, is the source-of-truth for each account correct.
- Irreversible schema decisions — a column that can't be cleanly dropped
  later, a constraint that will be expensive to loosen.
- Security/tenant boundaries — does this correctly stop one administratie
  from ever touching another's data or accounts.
- Concurrency/idempotency — is the claim key actually the right one, is the
  lock order actually deadlock-free against every other writer.
- Destructive operations — anything that deletes, truncates, or could lose
  data.
- Production rollout — is the apply order correct, is the preflight/postcheck
  actually sufficient.

**Avoid spending manual review time on purely mechanical changes that tests
or the type checker can already prove** — a shim removal that swaps one
typed call for an equivalent typed call, a rename, a formatting change. If
`tsc` and the test suite are green and the diff is mechanical, that is
already the proof; don't re-derive it by eye.

---

## 10. Definition of done

A phase is not done merely because code exists and a PR is open. Where
applicable, "done" includes:

- [ ] Merged code
- [ ] Production migration applied (via the Lovable Cloud SQL editor)
- [ ] Postcheck green
- [ ] Generated types synchronized
- [ ] Temporary shim removed (if one was used)
- [ ] `PROJECT_MAP.md` updated to reflect the actual, current state — not
      the state at the moment the PR was opened

A PR merged with a migration still "⏳ Not yet applied" is real progress, but
it is not the end state. Track it through to the checklist above, the same
way 6C-b3 through 6C-b5b were tracked through their own shim-removal and
status-update follow-ups.
