# BoekAssist Accounting Engineering Patterns

The reusable accounting engineering patterns already proven in BoekAssist's
ledger writers, so a future writer starts from what's known to work instead
of redesigning it from scratch. Concrete references throughout point at
`supabase/migrations/20260914120000_add_ledger_postings_foundation.sql`
(the `ledger_postings` foundation), `20260915140000_add_purchase_ledger_posting.sql`
(purchase), `20260915160000_add_sales_ledger_posting.sql` (sales), and
`20260917120000_add_bank_settlement_posting.sql` (bank settlement) — read
the most recent of these in full before designing a new writer.

This document is about *the patterns*; `BOOKASSIST_AI_BUILD_STRATEGY.md` is
about the *process* for building with them.

---

## 1. Canonical posting flow

Every writer built so far follows the same shape:

```
source row
  → lock authoritative source (FOR UPDATE / FOR SHARE)
    → validate auth / tenant / client
      → validate accounting config (accounts exist, are configured)
        → validate accounting state (already posted? closed year? consistent amounts?)
          → durable claim / idempotency marker (written first)
            → balanced ledger_postings group (written in the same transaction)
              → immutable source / marker (enforced by triggers, from then on)
                → explicit correction only via a future reversal (never an edit)
```

A new writer's design review should walk through this list explicitly and
state, for each step, what the concrete check is — not just confirm the
shape is present.

---

## 2. `ledger_postings` rules

`ledger_postings` (the append-only foundation) enforces, and every writer
must respect:

- **Append-only** historical accounting — no `UPDATE`, `DELETE`, or
  `TRUNCATE` from application roles, enforced at the database level, not
  just by convention.
- **Balanced posting groups** — `SUM(debit) = SUM(credit)` per
  `posting_group_id`, checked by a `DEFERRABLE INITIALLY DEFERRED`
  constraint trigger so a multi-statement write can still be atomic.
- **Explicit debit/credit** — every row states which side it's on; no
  signed-amount-on-one-account model.
- **Persisted account ids** — the actual `grootboekrekening_id` used is
  stored on the row. A later change to a client's configured account (e.g.
  `clients.bank_rekening_id`) never rewrites history; it only affects future
  postings.
- **Persisted posting date / boekjaar** — derived once, at posting time,
  from the authoritative source, and stored — never recomputed later.
- **`source_type` + `source_id`** — every row traces back to exactly the
  business event that produced it. `source_id` is the writer's claim key
  (pattern 4) — for purchase and sales, the invoice id; for bank
  settlement, the allocation id.
- **`source_line_id` is optional and writer-specific — it is not "the line
  id whenever the source has child rows".** It may only be persisted when
  the source line's identity is itself durable and stable for the lifetime
  of the posting. As of 6C-b5b, **every writer passes `NULL`**:
  - Purchase posting iterates `purchase_invoice_lines` to produce one ledger
    row per line, but still writes `source_line_id = NULL` for every row
    (`20260915140000_add_purchase_ledger_posting.sql`). Purchase invoice
    line ids are **not** treated as durable, because
    `save_purchase_invoice_with_lines` deletes and recreates a purchase
    invoice's lines on every save — a line's id does not survive an edit,
    so it cannot safely identify "the same line" after posting.
  - Sales posting is header-only (no line table exists), so there is no
    line identity to record.
  - Bank settlement's durable source identity is
    `bank_transaction_allocations.id`, and that is what goes in `source_id`
    — an allocation has no child rows, so `source_line_id` stays `NULL`.

  A future writer must not populate `source_line_id` merely because its
  source has child rows. Only do so if a specific line's id is proven to be
  stable across every subsequent edit path the source document supports —
  and if it isn't, follow the existing precedent and use `NULL`.
- **No silent recalculation after posting.** Once a group exists, nothing
  about it is ever recomputed — a correction is a new group, never a
  mutation of an old one.

---

## 3. Writer API pattern

The RPC receives **the minimum durable identifier only** — one uuid, the id
of the business event being posted (an invoice id, an allocation id). It
never receives amounts, account ids, dates, or tenant identifiers from the
caller.

The server derives, from stored data, inside the function:

- `organization_id`, `client_id`, `user_id`
- amounts
- accounts
- posting date
- direction (debit/credit)
- currency
- bookkeeping year (`boekjaar`)

**Never trust a client-supplied accounting payload.** If a value affects
what gets posted or how, it comes from a row the server reads and locks —
never from a function argument.

---

## 4. Idempotency marker pattern

Already in use: `purchase_invoice_postings`, `sales_invoice_postings`,
`bank_allocation_postings`.

**Rule: choose the smallest durable business event identity as the claim
key** — not the most obvious identifier. Purchase and sales use the
invoice id, because one invoice produces exactly one posting group. Bank
settlement uses the *allocation* id (`bank_transaction_allocations.id`),
**not** the bank transaction id and **not** the invoice id, because both of
those are one-to-many with settlements (one transaction can settle several
invoices; one invoice can be settled by several transactions) and neither
can be a `PRIMARY KEY`-style claim without breaking a legitimate case.

The marker table's `PRIMARY KEY` on the claim key **is** the idempotency
guarantee — not a partial unique index, not an application-level check. A
partial unique index is bypassable by a direct `authenticated` INSERT into
`ledger_postings`; the marker's PK plus a source-scoped `BEFORE INSERT`
claim trigger on `ledger_postings` (see pattern 5's sibling, the claim
trigger) is what actually closes that path.

**Claim and ledger writes occur in the same SQL transaction** — the claim
INSERT happens first (it is the serialisation point: a concurrent second
call blocks on it, then fails with `unique_violation`), and the ledger rows
are written immediately after, in the same transaction, so a later failure
rolls back both.

---

## 5. SECURITY DEFINER hardening

**Authorization and integrity are different concerns, enforced at different
points, by different kinds of function.** Do not apply the RPC's auth
requirements to a trigger function, or vice versa — they exist for
different reasons and, in BoekAssist today, none of the trigger functions
check `auth.uid()` or a role at all.

### A. Posting RPCs (`post_purchase_invoice`, `post_sales_invoice`,
`post_bank_allocation`) — the access boundary

This is where a request is authorized. Every posting RPC needs:

- `SECURITY DEFINER` when required — it is required here because the
  marker table is deliberately not writable by `authenticated`, so an
  INVOKER function couldn't claim anything.
- `SET search_path = public` — pinned, always.
- `auth.uid()` required — `NULL` is refused immediately (`28000`).
- Explicit role check — `has_min_role(auth.uid(), organization_id, '<role>')`,
  not an assumption based on RLS.
- Tenant derived from the **stored source row** (read and locked inside the
  function), never from a caller-passed value.
- `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated, service_role`
  — name every application role explicitly. `REVOKE ... FROM PUBLIC` alone
  is not sufficient: Lovable Cloud has been observed granting privileges
  directly to individual roles, and a grant made straight to `anon` or
  `service_role` survives a PUBLIC-only revoke.
- `GRANT EXECUTE ... TO authenticated` only — nothing wider, unless there is
  a proven, separately-reviewed need (there has not been one yet for any
  writer's RPC).

**Do not rely on RLS alone inside a definer function** — `SECURITY DEFINER`
bypasses RLS by design, so every check RLS would normally have performed
must be done explicitly in the function body.

### B. Claim / immutability trigger functions (`enforce_*_source_claim`,
`prevent_posted_*_mutation`) — integrity, not authorization

These functions (checked directly in
`20260915140000_add_purchase_ledger_posting.sql`,
`20260915160000_add_sales_ledger_posting.sql`, and
`20260917120000_add_bank_settlement_posting.sql`) enforce a row/database
invariant — "this `ledger_postings` row matches its claimed marker", "this
posted invoice's accounting fields haven't changed" — regardless of *who*
is making the change or *why*. None of them reference `auth.uid()` or
`has_min_role()`, and that is correct, not an oversight:

- **They do not automatically require request-level `auth.uid()`.** A
  trigger fires on every `INSERT`/`UPDATE`/`DELETE` against the table,
  including ones made through paths where `auth.uid()` is legitimately
  `NULL` — a service-role job, a maintenance script, an internal
  administrative correction. Requiring a session user here would make the
  invariant enforceable only for ordinary user requests, which is not what
  an integrity guard is for.
- **They do not automatically require `has_min_role()`.** Role is an
  authorization concept — it belongs to "may this caller start this
  action", which the RPC already decided before the trigger ever runs.
  Re-checking a role inside the trigger conflates the two concerns and adds
  a check that has no correct answer for a legitimate internal DML path.
- They **must remain valid for legitimate internal/admin DML paths** where
  `auth.uid()` can be `NULL` — that is the actual reason `has_min_role`
  never appears in any of them.
- They still pin `SECURITY DEFINER` and `SET search_path = public` (so they
  run with a fixed, predictable search path and can read the marker table
  regardless of the caller's own privileges), and are still
  `REVOKE ALL ... FROM PUBLIC` — the same house pattern as the RPCs, applied
  for a different reason: not to gate *who* can call them (nothing calls a
  trigger function directly; it only runs as a trigger), but to keep the
  function's own name off `PUBLIC`'s default privilege surface, consistent
  with every other function in the schema.

**In short: authorization belongs at the RPC/access boundary; integrity
belongs in the trigger.** A trigger that started requiring `auth.uid()` or a
role would either break legitimate non-interactive DML or silently do
nothing useful, since the RPC already enforced authorization before the
trigger's invariant check ever runs.

---

## 6. Tenant / account validation

Use authoritative **stored** organization/client values — read them from
the locked source row and its client record, never accept them as
arguments.

Every posting account must pass the house scope predicate,
`posting_account_ok(account_id, organization_id, client_id)` where
applicable: same organisation, and either organisation-wide
(`client_id IS NULL`) or owned by this specific administratie. This is the
same predicate `ledger_postings` itself enforces per row, so configuration
can never record an account that posting would later refuse — closing that
gap is precisely why 6C-b2a's client ledger config columns use this
predicate rather than the looser org-only `ledger_link_org_ok`.

**Never infer an account id from:**

- a label or free-text field
- an account number (a "1100 fallback" has been explicitly rejected every
  time it was proposed)
- a UI default
- `bank_dagboek` (a SnelStart *dagboek* integer, not a `grootboekrekeningen`
  foreign key)
- a legacy account link (e.g. `ledger_account_id`, a table being phased out)

If the correct account cannot be proven to exist and be in scope, the writer
refuses to post — it does not guess. This is exactly why 6C-b5a (bank ledger
account configuration) existed as its own phase before 6C-b5b could be
written at all: 6C-b5's own audit proved there was no safe way to identify a
bank account, and the honest response was to add explicit configuration
first, not to approximate one.

---

## 7. Closed-year pattern

Posting date determines `boekjaar` (`EXTRACT(YEAR FROM posting_date)`).
Reject posting when that year is at or before `clients.afgesloten_boekjaar`.

**Do not silently move the posting to another year** — a rejected post stays
rejected; there is no fallback year.

---

## 8. Source immutability

Once a source has produced ledger postings:

- Accounting-relevant source fields freeze (identity, amounts, dates,
  accounts, VAT flags — whatever the specific writer's contract says
  determines *what* was posted or *whether* it could post).
- Deletion of the source (or of the claimed row, e.g. a bank allocation) is
  refused.
- Descriptive, non-accounting fields may remain editable if genuinely safe
  (e.g. a bank transaction's `description`/`reference`/`match_status` after
  a settlement is posted, or a sales invoice's `due_date`/`notes` after
  posting) — freeze only what accounting integrity actually requires, not
  everything on the row.

**Use explicit `TG_OP` branching** (`IF TG_OP = 'INSERT' ...`,
`IF TG_OP IN ('UPDATE', 'DELETE') ...`) and check `OLD` and `NEW`
independently where both are relevant.

**Do not use `COALESCE(NEW.x, OLD.x)` as a posted-source identity test.**
This exact bug class was found and fixed in 6C-b3: a `COALESCE` guard never
examined `OLD` on `UPDATE`, so a line could be moved *off* a posted invoice
undetected, because the guard only ever looked at whichever of `NEW`/`OLD`
happened to be non-null rather than checking both sides of the change.

---

## 9. Reversal principle

**Never edit or delete historical ledger rows to correct accounting.** The
append-only guarantee exists precisely so that "what was posted" is never in
question.

The correction model, once a reversal engine exists (not yet built as of
6C-b5b):

```
original immutable posting
  → reversal posting (references the original, in a new group)
    → corrected new posting (if applicable)
```

`ledger_postings.reversal_of_posting_id` already exists in the foundation
schema for this purpose, unused by any writer so far — a future reversal
engine is the first consumer.

---

## 10. Concurrency pattern

For every critical writer:

- **Deterministic row lock order**, documented explicitly in the migration
  and consistent with every other writer that could plausibly run
  concurrently against overlapping rows. Bank settlement's order — allocation
  (`FOR UPDATE`) → bank transaction (`FOR UPDATE`) → source invoice
  (`FOR SHARE`) — was chosen specifically so it can never deadlock against
  the purchase/sales writers, which only ever lock their own invoice row.
- **Source locked before reading the accounting facts** that decide what
  gets posted — a `SELECT ... FOR UPDATE` (or `FOR SHARE` for a read-only
  dependency, like checking that another writer's source is posted) before
  any check that depends on the row's current state.
- **Idempotency enforced by a `PRIMARY KEY`/`UNIQUE` claim**, not by an
  application-level "check then insert" — the database is the arbiter, and
  the second concurrent caller gets `unique_violation`, not a race.
- **Concurrent duplicate calls must produce exactly one posting** — proven
  with two real, concurrent database sessions, not just a unit test that
  can't observe true concurrency.
- **Mutation-vs-posting races must end in one fully committed state**: if
  the mutation commits first, the posting sees the new value; if the posting
  commits first, the later mutation is refused by the immutability guard.
  There is no window where a partially-applied mutation is reflected in a
  posting, and no window where a posting silently uses a stale value that
  the user believes has already changed.

Prove this with a real local PostgreSQL cluster and two genuinely concurrent
sessions using `clock_timestamp()` logging — not only static assertions.
Every writer through 6C-b5b has been proven this way; treat that as the
minimum bar, not an optional extra.

---

## 11. Deploy-order / generated types pattern

If a migration's schema is not yet in production:

- **Do not hand-edit `types.ts`.** It is generated; a hand edit desyncs it
  from reality the moment anyone regenerates it, silently.
- Use a narrow, local, clearly-marked temporary shim only if the
  application genuinely needs to reference the not-yet-typed table/RPC
  before production catches up — scoped to exactly the calls needed, with
  a comment stating why it exists and when to remove it.
- **Application code that would send a not-yet-existing column to
  PostgREST must not ship before the migration is applied** — PostgREST
  rejects the entire request when it names an unknown column (`PGRST204`),
  it does not ignore it. If there's any risk of that deploy ordering, split
  the schema PR from the consuming PR (see build-strategy document, §6).

After the production migration is applied:

- Sync generated types from the live schema.
- Remove the shim in a tiny, dedicated PR — see PRs #148 (purchase), #150
  (sales), #154 (bank settlement) for the exact pattern: one file changed,
  no behavior change, same query keys/invalidations/error handling.

---

## 12. Test contract template

Every new accounting writer should consider tests for, as applicable:

- Success debit/credit (the correct legs, correct amounts, correct
  accounts)
- Balancing (`SUM(debit) = SUM(credit)`, correct row count)
- Partial amounts, where the domain supports partial settlement
- Duplicate call (posts exactly once, second call refused)
- Rollback atomicity (a forced failure after the claim leaves nothing
  behind — no orphaned marker, no orphaned ledger rows)
- Missing config (a required account not configured → refused, no
  fallback)
- Wrong account scope (an account from another organisation/administratie
  → refused)
- Cross-client (source and claim disagree on `client_id` → refused)
- Cross-org (source and claim disagree on `organization_id` → refused)
- Unauthorized role (below the minimum required role → refused)
- Unauthenticated (`auth.uid()` is `NULL` → refused)
- Closed year (posting year at or before `afgesloten_boekjaar` → refused)
- Source mutation after posting (refused for accounting-relevant fields)
- Source deletion after posting (refused)
- Direct marker mutation (an `authenticated` INSERT/UPDATE/DELETE straight
  into the marker table → refused by ACL, not just by convention)
- Direct ledger bypass (an `authenticated` INSERT straight into
  `ledger_postings` with the writer's `source_type` → refused by the
  source-scoped claim trigger)
- Exact RPC ACLs (EXECUTE granted only to `authenticated`; explicitly
  absent for `anon`, `service_role`, `PUBLIC` — even under simulated
  platform default-privilege leakage)
- `SECURITY DEFINER` / `search_path` (present and pinned)
- Concurrency duplicate (two real sessions, one winner)
- Mutation-vs-posting race (both orderings, both end correctly)

**Only include the tests that apply to the actual writer** — sales has no
lines, so there is no "line reassignment" test for it; bank settlement has
no VAT leg, so there is no VAT-scope test for it. Use this list as the
default checklist to consciously include or exclude from, not a template to
copy verbatim.

---

## 13. Migration rollout checklist

1. Start from latest `main`.
2. Fresh feature branch.
3. Exactly one migration file for the phase.
4. Read-only preflight query.
5. Human review.
6. Merge.
7. Apply in the Lovable Cloud SQL editor — one production apply, nothing
   combined with it.
8. Read-only postcheck query.
9. Generated type sync.
10. Shim cleanup PR, if a shim was used.
11. `PROJECT_MAP.md` status update, reflecting the actual current state
    (not "not yet applied" once it has been).

---

## 14. Existing proven writer patterns

- **Purchase posting** (`20260915140000_add_purchase_ledger_posting.sql`) —
  the first writer; establishes the marker/claim/immutability/security shape
  for a source with line items.
- **Sales posting** (`20260915160000_add_sales_ledger_posting.sql`) —
  adapts the same shape to a header-only source with no lines, and to a
  materially different VAT model (including the deliberate refusal to post
  `btw_verlegd` invoices rather than approximate them).
- **Bank settlement** (`20260917120000_add_bank_settlement_posting.sql`) —
  adapts the same shape again to a many-to-many source (one transaction can
  settle several invoices; one invoice can be settled by several
  transactions), which is why its claim key is the allocation id rather than
  either parent id, and why its lock order includes a third table.

**A new writer should start by reading the most recent of these in full**,
not by re-deriving the pattern from the general description above — the
general description is a summary for orientation, the migrations themselves
are the actual, currently-correct reference implementation.
