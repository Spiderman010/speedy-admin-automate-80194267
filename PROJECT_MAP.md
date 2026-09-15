# Project Map — BoekAssist

For future accounting phases, `BOOKASSIST_AI_BUILD_STRATEGY.md` (how to build
with AI on this repo) and `BOOKASSIST_ACCOUNTING_PATTERNS.md` (the reusable
posting/idempotency/security patterns proven in 6C-b1 through 6C-b5b) are
canonical supporting docs — read them before designing a new writer.

## Source of truth

| Item | Value |
|---|---|
| GitHub repository | `Spiderman010/speedy-admin-automate-80194267` |
| Default branch | `main` |
| Vercel project | `speedy-admin-automate` |
| Lovable project ID | `21f860ce-754f-4c09-b153-0e47d874bb93` |
| Production Supabase project ref | `alxlbdhpbwlehbdbfejw` |
| Production Supabase URL | `https://alxlbdhpbwlehbdbfejw.supabase.co` |
| Production preview / app URL | `https://id-preview--21f860ce-754f-4c09-b153-0e47d874bb93.lovable.app` |

---

## Production backend management

The production Supabase project (`alxlbdhpbwlehbdbfejw`) is **managed through Lovable Cloud**, not through the user's personal Supabase dashboard.

- It will **not** appear in the personal Supabase dashboard at `supabase.com/dashboard`.
- SQL, database tables, RLS policies, users, storage, edge functions, logs, and secrets must be managed via:
  - **Lovable → Cloud icon** (top toolbar), or
  - **Cmd/Ctrl+K → "Cloud"**

**Do not** attempt to manage production schema or data from the personal Supabase dashboard.

---

## Vercel clarification

Vercel contains additional Supabase/Postgres environment variables (added 16 Apr). These **likely belong to the Vercel Supabase Marketplace integration**, not the production Lovable Cloud backend, and should not be used for BoekAssist production SQL.

The running frontend uses these two variables, which point to the correct Lovable Cloud backend:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://alxlbdhpbwlehbdbfejw.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | _(set in Lovable Cloud secrets)_ |

---

## Do not use

The following Supabase project refs **must not** be used for BoekAssist production SQL or migrations:

| Ref | Reason |
|---|---|
| `olumcwneiejjefhkzgmz` | Not the database used by the running BoekAssist app |
| `ycuofllsdssoezwwpqmv` | Not the database used by the running BoekAssist app |

Also: the Vercel Supabase Marketplace database (separate from the Lovable Cloud backend) must not receive BoekAssist migrations.

---

## How to verify the correct database before running SQL

Before running any SQL or migration, complete **all** of the following steps:

1. Open the running BoekAssist app.
2. Open browser DevTools.
3. Go to the **Network** tab.
4. Filter requests on `supabase.co`.
5. Click any request, such as one for `bank_transactions`.
6. Confirm the **Request URL** host is:
   ```
   https://alxlbdhpbwlehbdbfejw.supabase.co
   ```
7. Confirm the response header **`sb-project-ref`** is:
   ```
   alxlbdhpbwlehbdbfejw
   ```
8. Open the **Lovable Cloud SQL editor** (Lovable → Cloud icon, or Cmd/Ctrl+K → "Cloud").
9. Confirm you are working in project `alxlbdhpbwlehbdbfejw`.

Only after all steps confirm `alxlbdhpbwlehbdbfejw` may SQL be run.

---

## SQL safety rules

- For production SQL, use the **Lovable Cloud SQL editor** — not the personal Supabase dashboard and not the Vercel Supabase Marketplace database.
- Never run SQL if the project ref is unclear.
- Never run SQL in `olumcwneiejjefhkzgmz`.
- Never run SQL in `ycuofllsdssoezwwpqmv`.
- Never run a "Combined Fresh Install Schema" on production.
- Only run one migration at a time.
- Prefer read-only verification queries before any mutation queries.

---

## Current migration status

### PR #21 — `bank_transaction_allocations`

Migration file:
```
supabase/migrations/20260515120000_add-bank-transaction-allocations.sql
```

**Purpose:** Adds `bank_transaction_allocations` — the foundation for many-to-many bank transaction / invoice allocations.

**Status: ✅ Applied.**
The migration has been run in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw`.
The verification query returned `bank_transaction_allocations`, confirming the table exists in the production database.

Verification query (for future reference):
```sql
select to_regclass('public.bank_transaction_allocations') as allocation_table;
```

Expected result:
```
allocation_table
─────────────────────────────────────
bank_transaction_allocations
```

---

### Phase 6C-b2 — `ledger_postings`

Migration file:
```
supabase/migrations/20260914120000_add_ledger_postings_foundation.sql
```

**Purpose:** Adds `ledger_postings` — the persisted, append-only accounting posting layer that future phases write to. It is the first table in the schema that expresses double entry at all: today `journal_entries` holds one signed amount on one account, `sales_invoices` is header-only, and the only two-sided artefact anywhere is the transient `boekingcode` pairing inside the SnelStart CSV.

Design rules that must not be broken by later work:

- **One row = one side** of a debit/credit entry. A complete entry is the set of rows sharing `posting_group_id`.
- **A posting group is one journaalpost**: at least two rows, exactly one organisation, client, currency, posting date and boekjaar, and `SUM(debit) = SUM(credit)` with both totals `> 0`. Enforced at COMMIT by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger.
- **A posting group is sealed to the transaction that created it.** Every row carries a trigger-assigned `created_xact_id`; a later transaction may not append to an existing group. A correction is always a *new* group, never an addition to an old one. Without this, any `assistant` could turn a committed entry of 100 into 150 through a plain PostgREST call, permanently.
- **Writes are only allowed under READ COMMITTED.** REPEATABLE READ *and* SERIALIZABLE are refused by the database before a row is accepted — both hold a transaction-wide snapshot that would blind the group check (SSI does not help, because it only arbitrates between serializable transactions).
- **Writer contract:** write one posting group per transaction. Writing several groups in one transaction is allowed but must order them consistently (e.g. by `posting_group_id`) or be prepared to retry on deadlock `40P01`.
- **Append-only.** Never `UPDATE`, `DELETE` or `TRUNCATE` a posting — correct with a new reversing entry instead. Enforced four ways: no UPDATE/DELETE RLS policy, explicit `REVOKE` (including `service_role`), a row trigger for UPDATE/DELETE, and a statement trigger for TRUNCATE. Both guards are `ENABLE ALWAYS`, so `session_replication_role = 'replica'` cannot switch them off; the INSERT-path triggers stay `ORIGIN` so a `pg_restore` remains possible.
- **`posting_group_id` must be random (uuid v4).** The seal makes a group id single-use, so a deterministically derived id would let anyone pre-commit a group under it and permanently block the legitimate writer.
- **Tenant-isolated** at row and group level. A ledger account must be in the posting's organisation *and* either organisation-wide (`client_id IS NULL`) or owned by the posting's own administratie — org-only checking would let one administratie post onto another's account.
- **`user_id` is the real creator**: FK to `auth.users` and bound to `auth.uid()` for authenticated callers, so a posting cannot be attributed to someone else.
- **Empty on purpose.** No historic invoice, transaction or journal entry is backfilled; no workflow writes to it yet.

Accepted operational consequences, deliberately not solved in this phase: a user who has posted cannot be hard-deleted (`ON DELETE RESTRICT`), and an organisation or client with accounting history cannot be deleted without DBA action. A future user-erasure/anonymisation request needs a deliberate accounting-retention design — do not weaken immutability to solve it.

### Phase 6C-b2a — client VAT ledger configuration

Migration file:
```
supabase/migrations/20260915120000_add_client_vat_ledger_config.sql
```

**Purpose:** adds the two BTW ledger accounts as explicit per-administratie configuration, so the posting writers can post VAT to a real account instead of guessing one:

| Column | Label | Used by |
|---|---|---|
| `clients.btw_te_vorderen_rekening_id` | BTW te vorderen / voorbelasting | debited on a purchase invoice (6C-b3) |
| `clients.btw_te_betalen_rekening_id` | BTW te betalen / af te dragen BTW | credited on a sales invoice (6C-b4) |

Rules:

- **No backfill, no default numbers.** Both start NULL for every administratie. Unlike 1300/1600 there is no unambiguous Dutch default — an administratie may use 1520/1530, one combined BTW account, or a per-rate split — and guessing would post VAT to the wrong account on an immutable ledger. `client-readiness` surfaces the absence as `config_ontbreekt`.
- **Account scope is stricter than debiteuren/crediteuren.** These two reuse `posting_account_ok()`: same organisation, and the account must be either organisation-wide (`client_id IS NULL`) or owned by this very administratie. That matches what `ledger_postings` enforces per row, so configuration cannot record an account that posting would later refuse. The older debiteuren/crediteuren columns keep their looser org-only check — tightening them would risk rejecting configuration production already holds, so it is a separate deliberate follow-up.
- FK `ON DELETE SET NULL` (optional configuration, not accounting identity), plus an index on each.

**Status: ⏳ Not yet applied.**
Apply in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw` after review.

Verification query:
```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='clients'
  and column_name in ('btw_te_vorderen_rekening_id','btw_te_betalen_rekening_id');
```

### Phase 6C-b3 — purchase ledger postings

Migration file:
```
supabase/migrations/20260915140000_add_purchase_ledger_posting.sql
```

**Purpose:** the first production accounting writer. `public.post_purchase_invoice(_invoice_id uuid)` posts one finalised purchase invoice into `ledger_postings` as a balanced, immutable group, exactly once.

**The entry**

```
DEBIT   each line.amount_excl   → purchase_invoice_lines.grootboekrekening_id
DEBIT   header.btw_amount       → clients.btw_te_vorderen_rekening_id   (only when > 0)
CREDIT  header.amount_incl      → clients.crediteuren_rekening_id
```

VAT is never folded into an expense line, no account number is ever invented, and there is no silent fallback — a missing account fails the whole posting.

**Contract**

- **Trigger point:** an explicit "Boeken in grootboek" action. Ordinary save never posts; `te_controleren` is refused. Only `gecontroleerd`, `betaald` or `geexporteerd` may post.
- **Source identity:** `source_type = 'purchase_invoice'`, `source_id` = the invoice id, `source_line_id` = **NULL**. Purchase line ids are *not* durable — `save_purchase_invoice_with_lines` deletes and re-inserts every line on each save — so `line_no` carries posting-line order only, never source identity.
- **Idempotency:** `public.purchase_invoice_postings`, whose PRIMARY KEY on `purchase_invoice_id` *is* the guarantee. Claim and ledger rows are written in one transaction, so an invoice is either fully posted or not posted. Under concurrency the index is the serialisation point: the second session blocks until the first commits, then fails as already posted. The earlier proposed partial unique index on `(source_id) WHERE line_no = 1` was rejected as bypassable.
- **Reconciliation is exact**, in NUMERIC: `SUM(line.amount_excl) = header.amount_excl` and `header.amount_excl + btw_amount = header.amount_incl`. The `lineTolerance()` in `purchase-line-validation.ts` is a UI editing affordance, **not** an accounting convention — the ledger's own group check is exact, so anything less would be rejected at COMMIT anyway. Discrepancies are refused, never repaired.
- **Date / boekjaar / currency:** `posting_date = invoice_date` (NULL fails closed); `boekjaar` = calendar year of that date — the product has no broken-fiscal-year support and its own tested year filter selects `invoice_date >= 'YYYY-01-01' AND < 'YYYY+1-01-01'`; `currency = 'EUR'` explicitly, the product being EUR-only (no currency column, EUR hard-coded in money formatting and both UBL generators).
- **Closed years:** posting into a year at or before `clients.afgesloten_boekjaar` is refused.
- **Security:** `SECURITY DEFINER` (required — the marker is deliberately not writable by `authenticated`), `SET search_path = public`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO authenticated` only. The only caller input is the invoice id; user, organisation, administratie, amounts, accounts, boekjaar and currency are all derived server-side, and `created_xact_id` is stamped by the ledger's own trigger. Role required: `assistant`, matching the ledger's own INSERT policy.
- **Marker privileges:** `SELECT` only for `authenticated`/`service_role`, nothing for `anon`. `INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` are explicitly revoked — Lovable Cloud defaults were observed to hand out more than the obvious three.

**Deliberately unsupported, refused rather than approximated**

- **Verlegde BTW (reverse charge) on purchases.** The purchase model has no field representing it, so the payable leg cannot be expressed. A verlegde invoice can only be stored as 0% VAT, which posts as a plain no-VAT purchase; the VAT-return legs are absent. Do not infer reverse charge from any other field.
- **Credit notes / negative amounts.** `ledger_postings` forbids negative amounts by design; a creditnota is a reversal and belongs to the correction workflow.
- **Corrections and reposting.** Once posted, an invoice cannot be posted again. If accounting-relevant source data changes afterwards this phase fails closed on purpose. Corrections require a future reversal workflow writing NEW immutable rows; nothing edits or deletes a posted row.
- **No historic backfill.** No existing purchase invoice is posted automatically.

**Status: ⏳ Not yet applied.**
Apply in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw` after review.

Verification query:
```sql
select to_regclass('public.purchase_invoice_postings') as marker_table,
       (select count(*) from pg_proc where proname = 'post_purchase_invoice') as rpc;
```

### Phase 6C-b4 — sales ledger postings

Migration file:
```
supabase/migrations/20260915160000_add_sales_ledger_posting.sql
```

**Purpose:** the second production accounting writer. `public.post_sales_invoice(_invoice_id uuid)` posts one finalised sales invoice into `ledger_postings` as a balanced, immutable group, exactly once. Mirrors the 6C-b3 architecture, adapted to a materially different source model (audited before writing any code, see below).

**The entry**

```
DEBIT   header.amount_incl (gross)  → clients.debiteuren_rekening_id
CREDIT  header.amount_excl (net)    → sales_invoices.grootboekrekening_id
CREDIT  header.btw_amount           → clients.btw_te_betalen_rekening_id   (only when > 0)
```

**Sales is header-only**, unlike purchase: no `sales_invoice_lines` table exists anywhere in the schema, so `sales_invoices.grootboekrekening_id` is the one and only revenue account per invoice, and `source_line_id` is always NULL. No account number is ever invented and there is no silent fallback.

**Contract**

- **Trigger point:** an explicit "Boeken in grootboek" action. Only `gecontroleerd` or `betaald` may post. `concept` and `verzonden` are refused — `verzonden` is a freely selectable dropdown value with no code path proving it means "reviewed", so it is treated as non-final. `geexporteerd` is not offered as a status at all: the live DB `CHECK` constraint on `sales_invoices.status` only permits `concept | gecontroleerd | verzonden | betaald`, even though some app code (`SALES_LEDGER_STATUSES`, `STATUS_ORDER`) references `geexporteerd` for sales — that reference is dead code inherited from the purchase pattern, not a reachable state.
- **Source identity:** `source_type = 'sales_invoice'`, `source_id` = the invoice id, `source_line_id` = NULL (no lines exist to carry one).
- **Idempotency:** `public.sales_invoice_postings`, identical design to the purchase marker — PRIMARY KEY on `sales_invoice_id` is the guarantee, claim and ledger rows are written in one transaction, and a `BEFORE INSERT` guard on `ledger_postings` (scoped strictly to `source_type = 'sales_invoice'`) makes the marker the single authority so a direct `authenticated` INSERT cannot create a second group.
- **Posted-source immutability:** once a marker exists, a `BEFORE UPDATE` trigger on `sales_invoices` freezes every accounting-relevant field (`client_id`, `organization_id`, `customer_name`, `invoice_number`, `invoice_date`, `amount_excl`, `btw_amount`, `amount_incl`, `btw_percentage`, `btw_verlegd`, `grootboekrekening_id`, `ledger_account_text`). `due_date`, `remaining_amount`, `notes` and `pdf_path` stay fully editable, because none of them changes what was booked. Sales had **no** existing posted-source guard before this phase (unlike purchase, which also needed one in 6C-b3) — invoices were previously fully mutable regardless of status.
- **Posted-status transition guard:** `status` is neither frozen nor fully free. On a posted invoice the only allowed transition is `gecontroleerd → betaald` (or staying put); every other change — back to `concept`, sideways to `verzonden`, or `betaald → gecontroleerd` — is rejected by the same trigger with `Deze verkoopfactuur is geboekt; status kan alleen nog van gecontroleerd naar betaald.` This is a second, independent condition in `prevent_posted_sales_invoice_mutation()`, not a special case of the accounting-field freeze above (which does not look at `status` at all). Without it, a posted invoice's status could be pushed back to a state `post_sales_invoice()` itself refuses to post from, leaving the row simultaneously "posted" and "not yet reviewed".
- **Save-vs-post concurrency:** the writer takes `SELECT ... FOR UPDATE` on the invoice row before reading it, the same row `useUpdateSalesInvoice` implicitly locks during its `UPDATE`. Whichever starts first finishes first; a mixed old/new snapshot is impossible.
- **Reconciliation is exact**, in NUMERIC: `header.amount_excl + header.btw_amount = header.amount_incl`. There is no line sum to check.
- **Date / boekjaar / currency:** identical contract to purchase. `invoice_date` is actually `NOT NULL` at the schema level for sales (unlike purchase), so the writer's NULL check is defensive rather than load-bearing. `currency = 'EUR'` explicitly.
- **Closed years:** posting into a year at or before `clients.afgesloten_boekjaar` is refused.
- **Security:** identical model to purchase — `SECURITY DEFINER`, `SET search_path = public`, `GRANT EXECUTE TO authenticated` only. `REVOKE ALL ON FUNCTION post_sales_invoice(uuid) FROM PUBLIC, anon, authenticated, service_role` names every application role explicitly, not just `PUBLIC` — Lovable Cloud has been observed granting privileges straight to individual roles, which a `PUBLIC`-only revoke does not strip. **`service_role` EXECUTE is explicitly revoked too** (not just omitted) — no edge function currently posts sales invoices, and that stays a deliberate, separately-reviewed grant rather than a default. Role required: `assistant`.
- **Marker privileges:** `REVOKE ALL ON public.sales_invoice_postings FROM anon, authenticated, service_role` followed by `GRANT SELECT ... TO authenticated, service_role` — a full reset-then-grant, not an enumerated revoke list. An enumeration (`INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, ...`) can always be one privilege short of whatever Lovable Cloud's defaults hand out next (e.g. `MAINTAIN`, PostgreSQL 17+); `REVOKE ALL` clears every privilege on the table for that role, known or not, before `GRANT SELECT` restores exactly the intended read access. Result: `authenticated` and `service_role` have exactly `SELECT`, `anon` has nothing.

**Deliberately unsupported, refused rather than approximated**

- **Verlegde BTW (`btw_verlegd = true`).** Unlike purchase, sales genuinely has a field for reverse charge — so silence was not available. A naive header posting of a verlegde invoice would balance (because `btw_amount` is forced to 0) while omitting the VAT-return legs entirely. The product has already made this exact call once: the SnelStart export refuses to export a `btw_verlegd` invoice ("de juiste SnelStart-exportcode is nog niet ingesteld"). The writer follows the same posture and refuses to post one, with its own explicit error, rather than booking an incomplete entry.
- **Credit notes / negative amounts.** Same refusal as purchase; nothing in the schema represents a sales credit note today.
- **Corrections and reposting.** Same as purchase: once posted, never again; corrections require a future reversal workflow.
- **No historic backfill.**

**Status: ⏳ Not yet applied.**
Apply in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw` after review.

Verification query:
```sql
select to_regclass('public.sales_invoice_postings') as marker_table,
       (select count(*) from pg_proc where proname = 'post_sales_invoice') as rpc;
```

### Phase 6C-b5a — client bank ledger configuration

Migration file:
```
supabase/migrations/20260916120000_add_client_bank_ledger_config.sql
```

**Purpose:** adds the bank general-ledger account as explicit per-administratie configuration, so the bank settlement writer of 6C-b5b has a provable account to post against.

| Column | Label | Used by |
|---|---|---|
| `clients.bank_rekening_id` | Bankrekening grootboek | bank settlement postings (6C-b5b) |

**Why it is needed.** Nothing in the schema identified a client's bank grootboekrekening before this phase: `clients.bank_dagboek` is a SnelStart *dagboek* integer (not a `grootboekrekeningen` FK, often NULL, with a `?? 1100` UI fallback), `bank_transactions.grootboekrekening_id` is the *contra* account of a mutation, `bank_transactions.ledger_account_id` points at the legacy `ledger_accounts` table, and `grootboekrekeningen.categorie` has no `bank` value. The account is therefore configured explicitly and **never inferred** from a number (least of all 1100), from `categorie`, or from `bank_dagboek`.

**Phase split:** 6C-b5a is **schema + application consumption**, split across two PRs so the rollout is safe; 6C-b5b (next) adds the bank settlement writer that actually posts against the account.

- **PR 1 — schema only** (#151, merged): the column, its FK, its index, and its validation. Deliberately *no* application code read or wrote the column, because PostgREST rejects an entire request that names an unknown column (`PGRST204`) rather than ignoring it — sending `bank_rekening_id` before the migration existed in production would have broken every ordinary client save.
- **PR 2 — UI + readiness** (this section, current): now that the migration is applied to production and `types.ts` is regenerated (`Row.bank_rekening_id: string | null` confirmed present), the client configuration screen gets the "Bankrekening grootboek" field and `client-readiness` gets the `configMissingBankRekening` flag/reason. No temporary type shim was needed for this PR — the generated type already had the column.

Rules:

- **No backfill, no default.** The column started NULL for every administratie and stays that way; nothing in either PR maps a number to it automatically. There is no unambiguous default: an administratie may use 1100, 1101, one account per bank/IBAN, or any other number, and guessing would silently post settlements to the wrong account on an immutable ledger. `client-readiness` surfaces the absence as `config_ontbreekt` on the dashboard (display only — it gates no posting and no export, and does not change the purchase/sales posting gates).
- **Account scope is the strict one.** The check in `enforce_client_ledger_org()` reuses `posting_account_ok()`: same organisation, and the account must be either organisation-wide (`client_id IS NULL`) or owned by this very administratie — the same predicate `ledger_postings` enforces per row, so configuration cannot record an account that posting would later refuse. NULL is explicitly allowed. The debiteuren/crediteuren columns keep their looser org-only check, untouched.
- **The trigger was recreated** with `bank_rekening_id` added to its `UPDATE OF` list (alongside the four pre-existing columns and `organization_id`); without that, an update touching only the new column would have skipped validation entirely.
- FK `ON DELETE SET NULL` (optional configuration, not accounting identity), plus an index on the column. No new SECURITY DEFINER function was introduced.
- **UI:** the "Bankrekening grootboek" field uses the same `GrootboekCombobox` id+label pattern as debiteuren/crediteuren/BTW, hydrates from `client.bank_rekening_id`, and saves `form.bank_rekening_id || null` — an empty selection persists as `null`, never a fallback account. The existing numeric "Bank-dagboek" field is untouched and independent.

**Status: ✅ Applied to production** (`alxlbdhpbwlehbdbfejw`). Generated types confirmed current.

Verification query:
```sql
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='clients' and column_name='bank_rekening_id';
```

### Phase 6C-b5b — bank settlement postings

Migration file:
```
supabase/migrations/20260917120000_add_bank_settlement_posting.sql
```

**Purpose:** the third production accounting writer. `public.post_bank_allocation(_allocation_id uuid)` posts one bank allocation (one `bank_transaction_allocations` row: "this bank transaction settles this much of this invoice") into `ledger_postings` as a balanced, immutable, two-leg group, exactly once. It moves the open item from debiteuren/crediteuren to the bank account and books **no** revenue, expense or VAT — those legs were booked by 6C-b3/6C-b4 and this writer requires that to have happened first.

**The entry** (amount = `allocation.amount`, used as-is — never recalculated, never clamped)

```
invoice_type = 'verkoop'  (requires bank_transactions.amount > 0)
  DEBIT   clients.bank_rekening_id
  CREDIT  clients.debiteuren_rekening_id

invoice_type = 'inkoop'   (requires bank_transactions.amount < 0)
  DEBIT   clients.crediteuren_rekening_id
  CREDIT  clients.bank_rekening_id
```

**Proven sign semantics.** `bank_transactions.amount` is signed: `>= 0` = money in = `verkoop`, `< 0` = money out = `inkoop` (`src/pages/Bank.tsx:111`, `src/lib/ledger-mutations.ts:345`, `src/lib/snelstart-export.ts:268`). `bank_transaction_allocations.amount` is always positive (`CHECK (amount > 0)`, derived from `Math.abs(tx.amount)` in the UI); direction is not stored on the allocation, it comes from `invoice_type` and is cross-checked against the transaction sign. A mismatch (or `amount = 0`) is refused.

**Contract**

- **Trigger point:** an explicit "Boeken in grootboek" action per allocation card in the Bankaflettering drawer. Nothing posts on save, match or import.
- **Idempotency key = the allocation id.** `public.bank_allocation_postings` has `allocation_id` as PRIMARY KEY and `posting_group_id UNIQUE`. Neither the transaction id nor the invoice id can be the key: one transaction may settle several invoices and one invoice may be settled by several transactions — both are one-to-many. The marker also records `bank_transaction_id`, `invoice_id`, `invoice_type` and `amount` as audit trail. A `BEFORE INSERT` guard on `ledger_postings`, scoped strictly to `source_type = 'bank_allocation'`, makes the marker the single authority so a direct `authenticated` INSERT cannot create a second group.
- **Source invoice must already be posted.** The writer requires a row in `purchase_invoice_postings` / `sales_invoice_postings` for the invoice (`invoice_id` has no FK; it is resolved per `invoice_type`). Invoice `status` proves nothing and is not consulted. The invoice row is locked `FOR SHARE` so a `post_*_invoice()` in flight finishes first (then the marker is visible) or rolls back (then "nog niet geboekt").
- **Bank account source:** `clients.bank_rekening_id` (6C-b5a), re-checked with `posting_account_ok()` at posting time, as are debiteuren/crediteuren. Never `bank_dagboek`, never 1100, never `bank_transactions.grootboekrekening_id` (the SnelStart contra account), never the legacy `ledger_account_id`, never `categorie`. No fallback account, ever.
- **Date source:** `posting_date = bank_transactions.transaction_date` (the day the money moved), `boekjaar` = its calendar year, `currency = 'EUR'` explicit. Closed years (`<= clients.afgesloten_boekjaar`) are refused.
- **Partial / multi semantics:** a partial receipt posts a partial settlement; several allocations on one transaction each post their own group; several transactions on one invoice each post their own group.
- **Over-allocation / overpayment refusals** (exact NUMERIC, no tolerance — the DB has no such constraint, only `Bank.tsx` checks it client-side): `allocation.amount > abs(tx.amount)`, `SUM(allocations on tx) > abs(tx.amount)`, `allocation.amount > invoice.amount_incl`, `SUM(allocations on invoice) > invoice.amount_incl` ("een overbetaling wordt nog niet ondersteund"). The writer refuses inconsistent state instead of posting it.
- **Security:** identical model to 6C-b3/b4 — `SECURITY DEFINER`, `SET search_path = public`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` then `GRANT EXECUTE TO authenticated` only; role required `assistant`; `organization_id IS NULL` on the allocation fails closed. Marker: `REVOKE ALL` then `GRANT SELECT TO authenticated, service_role`; `anon` has nothing.
- **Immutability, allocation:** once posted, `id, amount, bank_transaction_id, client_id, invoice_id, invoice_type, organization_id, user_id` are frozen and DELETE is refused (`prevent_posted_bank_allocation_mutation`, explicit `TG_OP` branches, never `COALESCE(NEW.x, OLD.x)`; re-pointing an unposted row onto a posted id is refused too). `created_at`/`updated_at` stay free.
- **Immutability, bank transaction:** once any allocation on it is posted, `id, amount, transaction_date, client_id, organization_id, user_id` are frozen and DELETE is refused — which also means the `ON DELETE CASCADE` on `bta_tx_user_client_fk` can never reach a posted allocation. `description, reference, counter_account, camt_*, match_status, match_confidence, matched_invoice_id, grootboekrekening_id (contra), ledger_account_id (legacy)` stay editable.
- **`clients.bank_rekening_id` is deliberately NOT frozen.** The ledger rows persist the actual `grootboekrekening_id` used, so a later configuration change only affects future settlements and can never rewrite history; freezing it would block legitimate re-configuration for every client that ever posted a settlement.
- **Claim guard on `ledger_postings` also pins the shape of the group.** Beyond marker/group/org/client, `enforce_bank_source_claim()` refuses any `bank_allocation` row with `line_no` outside `{1, 2}` and any leg that does not carry exactly the marker's `amount` on exactly one side. The foundation's group seal already stops a *later* transaction from appending to a group; this closes the remaining raw-SQL path where extra balanced legs (e.g. DR omzet / CR bank) could be added in the *same* transaction as the RPC and turn a settlement into a revenue booking. Unreachable via PostgREST — defence in depth, proven on a local cluster (extra legs, wrong amount and both-sided legs all refused; legitimate group still exactly two balanced rows).
- **Lock order:** allocation (`FOR UPDATE`) → bank transaction (`FOR UPDATE`) → source invoice (`FOR SHARE`) → marker read → client/account reads → claim INSERT → ledger INSERTs. The invoice writers only lock their own invoice row and never touch allocations/bank rows; the app's allocation/bank mutations are separate single-table transactions; so no *application* path can deadlock against the writer. A concurrent allocation INSERT on the same transaction takes `KEY SHARE` on the bank row for its FK, which conflicts with the writer's `FOR UPDATE` and waits — that serialisation is what makes the per-transaction SUM check sound. One **non-application** path can deadlock: a raw `DELETE FROM bank_transactions` (SQL editor only — the app has no bank-transaction delete) locks the transaction row first and then, via the cascade FK, the allocation rows, the reverse order. PostgreSQL detects it (`40P01`) and aborts one side; the posting either commits or is retried, and the delete is refused anyway once a posting exists. Availability edge on a manual path, never an accounting one.
- **Prerequisite guard.** The migration refuses to run (first statement, before any object is created) unless `ledger_postings`, `purchase_invoice_postings`, `sales_invoice_postings` and `clients.bank_rekening_id` already exist — plpgsql does not validate table references at `CREATE FUNCTION` time, so without this the file would apply cleanly on a database missing 6C-b3/b4 and only fail at first use. Required apply order: 6C-b2 → 6C-b2a → 6C-b3 → 6C-b4 → 6C-b5a → 6C-b5b. Run it as one batch in a runner that stops on error.
- **No historic backfill.** No existing allocation is posted automatically.

**Deliberately unsupported, refused rather than approximated:** overpayments / betalingsverschillen (no suspense or 1799 leg), sign mismatches, settlements of invoices that were never posted, corrections/reposting (future reversal workflow).

**Deploy window.** If the frontend ships before the migration is applied, the per-allocation marker query fails (PostgREST does not know `bank_allocation_postings`). The action treats "cannot know" as *not* "not posted": it renders a disabled button with "Boeken in het grootboek is nog niet beschikbaar voor bankkoppelingen." and never calls the RPC. Nothing can post or double-post in that window; once the migration is applied the same frontend works unchanged.

**Known follow-up (UX, not accounting):** the drawer's "Ontkoppelen" action deletes every allocation of a transaction in one statement; once any of them is posted the whole unlink is correctly refused by the database, but the action is still offered and surfaces the database message. Hide/disable it when the transaction has a posted allocation — needs a per-transaction marker lookup in `Bank.tsx`, deliberately kept out of this phase to keep the UI change minimal.

**Temporary type shim: removed.** `src/hooks/useBankAllocationPosting.ts` initially reached `bank_allocation_postings` / `post_bank_allocation` through a narrow structural cast (`UntypedPostingApi`), because `types.ts` did not yet know either object. Now that the generated types include both, the hook calls the typed `supabase` client directly — as #150 did for sales.

**Independent review.** A second-pass adversarial review (fresh context, own throwaway cluster, own probes incl. NULL-org allocation, tampered-org invoice, wrong `invoice_type` with a real id, `id` re-pointing, `service_role` bypass, FK-bypassed foreign-client transaction, and two races) found no P1. Its P2 (deploy-window UI) and three of its P3s (two-leg hardening, honest deadlock note, prerequisite guard) are resolved above; the unlink UX P3 is the recorded follow-up.

**Status: ⏳ Not yet applied.**
Apply in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw` after review.

Verification query:
```sql
select to_regclass('public.bank_allocation_postings') as marker_table,
       (select count(*) from pg_proc where proname = 'post_bank_allocation') as rpc,
       (select count(*) from pg_trigger where tgname in
         ('validate_bank_source_claim_trigger',
          'prevent_posted_bank_allocation_mutation_trigger',
          'prevent_posted_bank_transaction_mutation_trigger')) as triggers;
```

---

Future phases: 6C-b6 manual journal posting, 6C-b7 Grootboek reading from real postings. Source-level idempotency is deliberately deferred to those writers — see the migration header for why no universal uniqueness constraint is safe yet.

**Status: ⏳ Not yet applied.**
Apply in the Lovable Cloud SQL editor for project `alxlbdhpbwlehbdbfejw` after review.

Verification query (for future reference):
```sql
select to_regclass('public.ledger_postings') as postings_table;
```

Expected result:
```
postings_table
─────────────────────────────────────
ledger_postings
```

---

## Emergency rule

> **If the project ref is unclear, stop. Do not run SQL.**
> Open the Lovable Cloud SQL editor and confirm the project ref is `alxlbdhpbwlehbdbfejw` before proceeding.
