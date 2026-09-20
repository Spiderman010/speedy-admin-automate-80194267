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

### Phase 6C-b6 — manual journals (memoriaal)

Migration file:
```
supabase/migrations/20260918120000_add_manual_journal_posting.sql
```

**Purpose:** the fourth production accounting writer, and the first whose source is authored by hand. A memoriaalboeking is a free-form journal entry (header `public.manual_journals` + N lines `public.manual_journal_lines`, each line DEBIT or CREDIT on one grootboekrekening) that is prepared as a draft and then posted, exactly once, by `public.post_manual_journal(_journal_id uuid)` as one balanced, immutable, tenant-safe group in `ledger_postings`. **PR 1 (this section) is schema + writer + tests only — no UI, no hooks, no routes, no generated types.** The consuming UI follows in a separate PR once the migration is applied (deploy-order rule, build strategy §6).

**Why new tables, not `journal_entries`.** `journal_entries` holds one signed amount on one account per row, has no header/group identity, no debit/credit sides and no posting marker, and its consumers (`Boekingen.tsx`, `useJournalEntries.ts`, `snelstart-export.ts`) rely on exactly that shape. It is not touched, not read and not migrated.

**The entry** (one ledger row per line, exactly as stored, `ORDER BY sort_order, id`)

```
line.debit_amount  > 0  →  DEBIT   line.grootboekrekening_id   line.debit_amount
line.credit_amount > 0  →  CREDIT  line.grootboekrekening_id   line.credit_amount
```

No implicit legs: no automatic VAT line, no contra account, no rounding or suspense line. `posting_date = manual_journals.posting_date`, `boekjaar` = its calendar year, `currency = 'EUR'` explicit, ledger `description` = the line's `omschrijving` or else the header's `description`.

**Contract**

- **Draft vs posted is derived** from the existence of a `manual_journal_postings` row. The header has no `status`, `boekjaar`, `currency`, number, VAT or reversal column.
- **Idempotency key = `manual_journals.id`.** `public.manual_journal_postings` has `manual_journal_id` as PRIMARY KEY and `posting_group_id UNIQUE`, and records `posting_date`, `line_count` and `total_amount` (debit total) as audit trail. Claim INSERT first, ledger rows after, same transaction; the second concurrent caller blocks on the key and fails with `23505`. No `EXISTS` pre-check.
- **Atomic line save:** `public.save_manual_journal_lines(_journal_id uuid, _lines jsonb)` — SECURITY INVOKER (RLS is the authorization), locks the header `FOR UPDATE` (the same lock the poster takes first), refuses once a marker exists (`42501`), validates every element (uuid/text/integer/numeric shape, **no NaN** ("Bedragen moeten getallen zijn", checked first), no negatives, not both-sided, max two decimals — checked on an unconstrained `numeric` **before** the `numeric(12,2)` cast, so this RPC is the only path that refuses `0.005` instead of rounding it; `0/0` and a missing account are allowed in a draft), normalises a whitespace-only `omschrijving` (spaces, tabs, CR, LF) to NULL, then DELETE + INSERT in one function transaction, with a post-DELETE guard so an RLS-skipped row can never survive next to a new set. `organization_id` of a line is always derived from the header by trigger; `user_id` is the caller.
- **Posting floor = accountant** (owner decision): `post_manual_journal` requires `has_min_role(auth.uid(), organization_id, 'accountant')`. Assistants prepare and edit drafts (INSERT/UPDATE at `assistant` on both draft tables, `user_id = auth.uid()` on both INSERT policies), but cannot post. Stricter than the purchase/sales/bank writers, deliberately.
- **Documented exception — `manual_journal_lines` DELETE floor = assistant** (every other table: accountant). Required because the save RPC performs its atomic delete + replace under the caller's own RLS; an accountant DELETE floor would make every assistant save fail. Draft lines only: the freeze trigger refuses INSERT/UPDATE/DELETE on posted lines for every role without consulting roles at all. The header keeps the normal `accountant` DELETE floor.
- **Balancing rules (exact NUMERIC, no tolerance, no rounding, no line-count cap):** at least two lines; every line has an account; no `0/0` line; no both-sided line; no negatives; **no NaN** (refused before the balance check — `'NaN'::numeric` passes `>= 0`, `> 0`, `= round(x, 2)` and even `SUM(debit) <> SUM(credit)`, because `NaN = NaN` is TRUE in PostgreSQL, and one NaN line would turn every SUM over that account into NaN); max two decimals (filter kept, unreachable through the column type); every line in the header's organisation; `SUM(debit) > 0 AND SUM(credit) > 0`; `SUM(debit) = SUM(credit)`. Each refusal has its own Dutch message. Table CHECKs refuse negatives, both-sided lines and NaN (`manual_journal_lines_no_nan_check`; the marker's `total_amount` CHECK refuses NaN too) at the draft level; **direct writes are rounded to 2 decimals by the column type `numeric(12,2)`** (a direct INSERT of `0.005` stores `0.01` — there is deliberately no "two decimals" table CHECK, it could never fail), while the save RPC — the application path — refuses >2 decimals before the cast; `0/0` and a missing account are draft-only states the poster refuses. Known foundation gap, out of scope here: `ledger_postings` and the purchase/sales/bank marker tables have no NaN CHECK (follow-up on 6C-b2).
- **Scope + actief:** every account must pass `posting_account_ok(account, organization_id, client_id)` (same org, shared or owned by this administratie — an account with `organization_id IS NULL` or owned by another administratie is refused), and must be `actief`.
- **Closed year:** `boekjaar <= clients.afgesloten_boekjaar` is refused; no fallback year. A blank `description` is refused (it is the ledger fallback text); "blank" is whitespace-aware — `btrim(x, E' \t\r\n')` in the poster's refusal, in the ledger `description` fallback (a tab-only line `omschrijving` falls back to the header) and in the save RPC's normalisation, because plain `btrim()` trims spaces only. The administratie must belong to the header's organisation (checked at INSERT/UPDATE by `enforce_manual_journal_client_org` via `posting_client_org_ok`, and again by the poster from stored data).
- **Immutability, header** (`prevent_posted_manual_journal_mutation`, BEFORE UPDATE OR DELETE, explicit `TG_OP` branches, never `COALESCE(NEW.x, OLD.x)`): once posted `id, organization_id, client_id, user_id, posting_date, description, reference` are frozen, DELETE is refused (so the lines' cascade can never fire), re-pointing another header onto a posted `id` is refused; `created_at`/`updated_at` stay free. Additionally, `client_id` cannot change while lines exist (unposted too), and `manual_journal_id` of a line can never change.
- **Immutability, lines** (`prevent_posted_manual_journal_line_mutation`, BEFORE INSERT OR UPDATE OR DELETE): INSERT/UPDATE refused when a marker exists for `NEW.manual_journal_id`, UPDATE/DELETE refused when one exists for `OLD.manual_journal_id`. On INSERT the trigger first takes `FOR KEY SHARE` on the header, because a BEFORE INSERT trigger runs before the FK's own KEY SHARE lock — without it a raw line INSERT racing a post could pass the marker check and land after the post committed (proven in C5).
- **Source mapping:** `source_type = 'manual_journal'`, `source_id = manual_journals.id`, **`source_line_id = manual_journal_lines.id`** — the first writer to persist a line id. Patterns §2 forbids that unless the id is durable; here it is durable by construction: save is refused after post, every line mutation is refused after post, lines cannot be re-parented, the poster locks header **and** lines before reading, and the marker is written before the first ledger row. (Purchase stays `NULL` because its lines are replaced on every save with ledger rows present.)
- **Claim trigger on `ledger_postings`** (`enforce_manual_journal_source_claim`, BEFORE INSERT, scoped strictly to `source_type = 'manual_journal'`): requires a marker for `source_id`; `posting_group_id`, org, client and `posting_date` must equal the marker; `1 <= line_no <= marker.line_count`; `reversal_of_posting_id` must be NULL ("Een tegenboeking gebruikt een eigen bronsoort"); `source_line_id` must be a line of that journal and the row's account and both amounts must equal the frozen line. Plus a partial unique index `idx_ledger_postings_manual_journal_line ON ledger_postings (posting_group_id, source_line_id) WHERE source_type = 'manual_journal'` so one line can never be mirrored twice even inside the posting transaction (only reachable if the claim trigger were disabled — proven as defence in depth).
- **Lock order:** header `FOR UPDATE` → lines `ORDER BY sort_order, id FOR UPDATE` → reads → claim INSERT → ledger INSERTs. Both RPCs lock the header first, so save-vs-post always serialises: post after save reads the committed new line set; save after post is refused. App writes are single statements or these RPCs. Two **non-application** paths can deadlock: (a) a raw multi-row line statement in the SQL editor (heap-order row locks) against the poster's `(sort_order, id)` line locks; (b) a single raw transaction that first UPDATEs/DELETEs a line (line lock) and then INSERTs a line — the INSERT takes `FOR KEY SHARE` on the header inside the freeze trigger and waits behind the poster's header `FOR UPDATE`, while the poster waits at LOCK 2 on the updated line (line → header inverts the documented order). In both cases PostgreSQL detects it (`40P01`) and aborts one side; nothing partial is committed, and once the post committed the mutation is refused anyway (path (b) proven with two real sessions: the raw transaction got `40P01` inside the KEY SHARE, the post committed, its edit was rolled back). Availability edge, never an accounting one.
- **Reversal compatibility:** no reversal columns here; a future reversal engine writes a new group with `reversal_of_posting_id` set under its **own** `source_type`, which the claim trigger forces (a `'manual_journal'` row with `reversal_of_posting_id` is refused).
- **Security:** poster `SECURITY DEFINER` + `SET search_path = public`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`, `GRANT EXECUTE TO authenticated` only (same for the save RPC, which is INVOKER). Marker: `REVOKE ALL` then `GRANT SELECT TO authenticated, service_role`. Draft tables: `REVOKE ALL` then `GRANT SELECT, INSERT, UPDATE, DELETE TO authenticated`, `GRANT SELECT TO service_role`, nothing for `anon`. All five trigger functions are `SECURITY DEFINER`, `REVOKE ALL FROM PUBLIC`, and contain no `auth.uid()`/`has_min_role()` (integrity, not authorization — patterns §5B).
- **FKs:** 10× `ON DELETE RESTRICT`; exactly one `ON DELETE CASCADE` (`manual_journal_lines.manual_journal_id → manual_journals`, so deleting a **draft** removes its lines; a posted header cannot be deleted). `posting_date` is CHECK-bounded to 2000..2100, matching the ledger's `boekjaar` CHECK.
- **Prerequisite guard:** refuses to run unless `ledger_postings`, `posting_account_ok(uuid,uuid,uuid)`, `posting_client_org_ok(uuid,uuid)`, `has_min_role(uuid,uuid,app_role)` and `clients.afgesloten_boekjaar` exist. Required apply order: 6C-b2 → … → 6C-b5b → 6C-b6.
- **No historic backfill.** Nothing existing is posted or converted; `journal_entries` is untouched.
- **Rollback precondition:** the migration's `-- rollback:` block is only safe **before the first posting**. `ledger_postings` is append-only, so after a post, dropping the tables would orphan its `source_type = 'manual_journal'` rows permanently. Check `SELECT count(*) FROM public.ledger_postings WHERE source_type = 'manual_journal'` = 0 first; after a posting the only correction path is the future reversal engine.

**Deliberately unsupported:** journal numbering (no number column; header carries a free-text `reference`), automatic VAT (VAT is an ordinary line — nothing reads `clients.btw_*`), reversal engine, SnelStart export of memoriaal postings, recurring journals, templates, attachments, approvals and opening-balance handling. Unchanged in PR 2.

#### PR 2 — application layer (UI)

The consuming UI, added once the migration was applied and the generated types contained the three tables and both RPCs.

```
src/pages/Memoriaal.tsx                              route /grootboek/memoriaal
src/lib/manual-journal-utils.ts                      pure logic (totals, gate, payloads)
src/hooks/useManualJournals.ts                       drafts: header rows + the save RPC
src/hooks/useManualJournalPosting.ts                 marker, role check, post RPC
src/components/memoriaal/MemoriaalLinesTable.tsx     debit/credit line editor
src/components/memoriaal/MemoriaalPostingAction.tsx  "Boeken in grootboek"
```

- **Route:** `/grootboek/memoriaal`, one line in `App.tsx` next to the existing `/grootboek/mutaties`. **No new nav item** — `nav.ts` is untouched; `isNavItemActive`/`parentNavItemForPath` already resolve any `/grootboek/*` path to the existing "Grootboek" item, so the header title and breadcrumb work by themselves. Reachable through a "Memoriaalboekingen" link button in the Grootboek action bar, mirroring "Mutaties bekijken".
- **Draft flow:** header through a normal single-row PostgREST insert/update (`client_id`, `posting_date`, `description`, `reference`, plus `user_id` because the INSERT policy requires `user_id = auth.uid()`); **`organization_id` is never sent** — `set_organization_id()` derives it from `client_id`. The lines go exclusively through **one** call to `save_manual_journal_lines(_journal_id, _lines)`; there is no client-side header-update → delete-lines → insert-lines sequence anywhere. Unbalanced and incomplete drafts may be saved; a new journal starts with two empty lines.
- **Posting flow:** one call to `post_manual_journal(_journal_id)` with nothing but the id. The button is offered only at `accountant` level, established by calling `has_min_role(auth.uid(), org, 'accountant')` — the ladder stays in the database, the client does not rank roles. Unknown ("still loading") is treated as "not allowed", never as allowed. **Success is only reported after the claim row is re-read**: if the marker is not visible after the RPC returns, the UI says the posting is unconfirmed instead of claiming success.
- **UI gate is advisory only.** `firstBlockingReason()` disables the button for deploy-window/loading, unsaved changes, missing role, missing date/description, fewer than two lines, a line without an account, a `0/0` line, a both-sided line, a negative amount, a zero total and an out-of-balance total. Everything the database alone can know — account scope, inactive accounts, closed boekjaar, the real role, NaN, >2 decimals — is deliberately *not* re-implemented; the RPC refuses and its Dutch message is shown. Amounts are sent unrounded so `0,005` is refused by the RPC rather than silently becoming `0,01`.
- **Posted state:** derived from the marker, never from a status column. All header fields and lines become read-only, the draft delete action disappears, and the page shows "Deze memoriaalboeking is geboekt. Een correctie vereist een tegenboeking." No reversal is implemented.
- **Error handling:** `23505` → re-read and switch to the posted view (informational, not an error); `42501` → permission/immutability message; `22023`/`23514`/`22004`/`P0002`/`28000` → the server's own Dutch message; `PGRST204`/`PGRST205`/`42P01`/`42883` → the neutral deploy-window text, following the `BankAllocationPostingAction` precedent. A raw SQLSTATE is never shown.
- **List:** Datum, Omschrijving, Referentie, Bedrag, Status, Acties. Status is derived (marker → Geboekt, else Concept); the amount is `marker.total_amount` when posted and the filled-in side of the draft otherwise.
- **VAT:** no automatic logic, only the hint "BTW boek je als aparte regel op de BTW-rekening."
- **Untouched:** `journal_entries`, `Boekingen.tsx`, `useJournalEntries.ts`, `ledger-mutations.ts`, `GrootboekMutaties.tsx`, `snelstart-export.ts`, `GrootboekCombobox.tsx` (used as-is, no `postableOnly` prop), `nav.ts`, the migration, RLS, the RPCs and the generated types.

**Status: ✅ Applied to production** (`alxlbdhpbwlehbdbfejw`), postcheck verified, and the generated `src/integrations/supabase/types.ts` contains `manual_journals`, `manual_journal_lines`, `manual_journal_postings`, `post_manual_journal` and `save_manual_journal_lines`. The application layer (PR 2) is implemented on top of it.

Verification query:
```sql
select to_regclass('public.manual_journals') as header_table,
       to_regclass('public.manual_journal_lines') as lines_table,
       to_regclass('public.manual_journal_postings') as marker_table,
       (select count(*) from pg_proc where proname in ('post_manual_journal','save_manual_journal_lines')) as rpcs,
       (select count(*) from pg_trigger where tgname in
         ('validate_manual_journal_source_claim_trigger',
          'prevent_posted_manual_journal_mutation_trigger',
          'prevent_posted_manual_journal_line_mutation_trigger',
          'validate_manual_journal_client_org_trigger',
          'set_manual_journal_line_org_trigger')) as own_triggers;
```

### Phase 6C-b7 — true Grootboek: reporting from `ledger_postings`

**Research decisions (final):** `ledger_postings` is the sole source for the new Grootboek/reporting layer; `journal_entries` is never summed into ledger figures; no historical backfill; no migrations; no Balans/W&V and no opening-balance logic until an opening-balance mechanism exists; no category schema change. The 6C-b7 research pass established that before this phase **nothing read `ledger_postings` at all** — it was write-only, and the `["ledger-postings"]` query key the four posting hooks invalidate had no consumer.

#### PR 1 — ledger reporting core (no UI)

```
src/lib/ledger-reporting.ts      pure, framework-free reporting kernel
src/hooks/useLedgerPostings.ts   the first reader of ledger_postings
```

- **Query contract:** plain `SELECT` under RLS (read floor `read_only`); no view, no RPC, no `SECURITY DEFINER`. `client_id` is mandatory — RLS is organisation-wide and does **not** replace the administratie predicate, so the hook refuses to run without one and the pure layer re-asserts it on the result. Optional half-open period: the query fetches everything with `posting_date < toExclusive` so opening balance and period come from one set. Batched at 1000 rows in the fixed order `posting_date, posting_group_id, line_no, id` (PostgREST's cap; mirrors `fetchAllBankTransactions`). Never filters on `reversal_of_posting_id`, `actief`, `currency` or `boekjaar`. Uses the reserved `["ledger-postings", clientId, from, toExclusive]` key, so the existing invalidations from the four posting hooks are now live.
- **Money:** integer cents at the boundary (`toCents`: exact string parse, `Math.round(n*100)` for the float form of a two-decimal value). Every invariant is compared in cents; no float equality anywhere.
- **Sign:** `signed = debit − credit`, debit-positive. **No sign-flip by category** — a credit balance is a negative number, as in a proef- en saldibalans.
- **Period convention: half-open `[from, toExclusive)` on `posting_date`**, ISO strings compared lexicographically — the existing app convention (`getLedgerYearRange`, `getYearDateRange`). `boekjaar` is carried but never filters. Because the 6C-b2 group trigger enforces one `posting_date` per group, a period boundary can never split a journaalpost.
- **Account rollup:** per account `opening = Σ(debit − credit) before from`, `periodDebit`, `periodCredit`, `closing = opening + periodDebit − periodCredit`. Accounts are resolved from the **all-accounts** list, never the active-only hook: an inactive account keeps its postings and balance. An unresolvable id becomes `Onbekende rekening` (`resolved: false`, `categorie: "onbekend"`) and keeps its postings; it sorts last.
- **Self-check:** `Σ periodDebit === Σ periodCredit` and `Σ opening === 0`, in cents. On failure the result is `{ ok: false, failures }` with **no rollups at all** — numbers from an unbalanced set are never returned.
- **Currency guard:** EUR only. One non-EUR row anywhere in the set (period or not) is a hard `LedgerReportingError("currency")`; rows are never silently dropped and currencies are never summed together.
- **Classification:** stored `categorie` → `activa | passiva | omzet | kosten | privé | onbekend` (trimmed, case-insensitive; the column is unconstrained text). `privé` is recognised but deliberately has **no** statement placement — the module exports no category→Balans/W&V map, and a test asserts that. Unknown text maps to `onbekend` and stays visible.
- **Running balance:** one account, opening + chronological lines + debit-positive running balance, in the fixed order above, independent of input order.
- **Reversals:** never filtered. A future reversal group (`reversal_of_posting_id` set, its own `source_type`) participates in normal summation and nets the original to zero — tested with a fixture.
- **Source drill-down:** `purchase_invoice → /facturen/inkoop/:id`, `sales_invoice → /verkoop`, `bank_allocation → /bank`, `manual_journal → /grootboek/memoriaal` (all existing routes in `App.tsx`); unknown `source_type` or a missing id → an explicit `unresolved` result, never an invented route.
- **Double-counting invariant (static test):** neither file queries or imports `journal_entries`, the document tables, their totals (`amount_incl`/`amount_excl`/`btw_amount`) or the legacy helpers; the only table read is `ledger_postings`.

**No UI in PR 1.** Balans/W&V wait for an opening-balance phase and the owner decisions on `privé` and the equity/liability split inside `passiva`.

#### PR 2 — Grootboek saldilijst + mutaties per rekening (UI)

```
src/pages/GrootboekSaldi.tsx                              /grootboek/saldi and /grootboek/saldi/:accountId
src/components/grootboek/GrootboekSaldiTable.tsx          saldilijst (presentation only)
src/components/grootboek/GrootboekAccountMutations.tsx    one account, running balance
src/components/grootboek/LedgerCompletenessNotice.tsx     "is this ledger complete?" metadata
src/lib/ledger-completeness.ts                            pure completeness counts
src/hooks/useLedgerCompleteness.ts                        head-counts + id lists per client
src/lib/grootboek-saldi-utils.ts                          period selection, labels, cents formatting
```

- **Routes:** two lines in `App.tsx`, nested under `/grootboek`; `nav.ts` untouched — the existing prefix matching keeps "Grootboek" the active/parent item. Entry point: a "Grootboeksaldi" button in the Grootboek action bar (next to "Bronmutaties").
- **Only accounting source: `ledger_postings`** via `useLedgerPostings`; all arithmetic via `buildAccountReport` / `buildRunningBalance` (PR 1). The page sums nothing itself and never reads `journal_entries`, invoice or bank totals (static tests). Accounts come from the **all-accounts** hook, so inactive accounts with activity stay visible (badge "Inactief"); an unresolvable id stays visible as "Onbekende rekening"; free-text `categorie` shows badge "Onbekend"; `privé` shows "Privé" with no Balans/W&V placement.
- **Saldilijst columns:** nummer, omschrijving, categorie, beginsaldo, debet, credit, eindsaldo — debit-positive, `closing = opening + debit − credit`, **no sign-flip by category**, so credit balances are negative. Totals row from the report totals. Each account name links to `/grootboek/saldi/:accountId`.
- **Period:** year chips (current year and four before), "Alle jaren" (`2000-01-01`..`2101-01-01`, the ledger's `boekjaar` CHECK bounds), or a "Van / Tot en met" range. The user's inclusive end date is converted **once**, in `inclusiveEndToExclusive`, to PR 1's half-open `[from, toExclusive)`. `posting_date` is the filter; `boekjaar` never is.
- **Account page:** header (nummer, omschrijving, categorie, period), summary (begin/debet/credit/eind), table (datum, omschrijving, bron, debet, credit, lopend saldo, actie) in PR 1's fixed order — the component contains no `.sort(`. Drill-down via `resolveLedgerSource`; an unknown `source_type` or a missing id renders "Bron niet beschikbaar" with no link.
- **Report integrity:** a failed self-check renders a blocking `role="alert"` ("Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit.") and **no figures**; a `LedgerReportingError` (non-EUR, foreign client) likewise; no fallback to source totals. An empty ledger shows "Nog geen geboekte grootboekmutaties voor deze periode." — never a table of zeros.
- **Completeness (mandatory, metadata only):** per source, posted / postable, from `count(head)` queries and id lists scoped by `client_id`; **never a monetary column**. Purchase: status in `gecontroleerd|betaald|geexporteerd` (reverse charge is not detectable on purchase — stated honestly in a note, not counted). Sales: status in `gecontroleerd|betaald` **and** `btw_verlegd = false`; `btw_verlegd = true` invoices are counted separately as **"geweigerd (BTW verlegd)"**, never as "nog niet geboekt", because `post_sales_invoice()` refuses them. Bank: an allocation is postable only once its invoice is posted (6C-b5b requires it); the rest are "wachten op het boeken van de factuur". Manual: posted / total. If counts cannot be fetched the notice says "Volledigheid onbekend" rather than inventing numbers.
- **Bronmutaties:** the old `GrootboekMutaties` page keeps its source-derived logic byte-for-byte (`ledger-mutations.ts` untouched, asserted via `git diff` in a test) but is retitled **"Bronmutaties"** with the sentence "Dit overzicht is afgeleid uit brondocumenten en is niet het officiële grootboek." so nobody compares it with `/grootboek/saldi` as if they were the same source.
- **Mobile:** both tables scroll horizontally inside their container (`min-w`), never the page.
- **A11y:** one `h1` per page (PageHeader), `<caption>` + `scope="col"`, status by badge text not colour, account links and source links have accessible names, `role="alert"` on every blocking state.

#### PR 3 — proef- en saldibalans

```
src/pages/ProefSaldibalans.tsx                            /overzichten/proef-saldibalans
src/components/overzichten/ProefSaldibalansTable.tsx      negen kolommen, presentatie only
src/lib/proef-saldibalans.ts                              splitsing, verzoening, CSV — puur
```

- **Route:** one line in `App.tsx`, nested under `/overzichten`. `nav.ts` untouched. Entry point: the "Proef- en saldibalans" card on Overzichten is now a link; Balans and W&V stay inert with the truthful status **"Beschikbaar na openingsbalans"**.
- **Source:** `ledger_postings` only, through `useLedgerPostings` → `buildAccountReport()` (PR 1) → `buildTrialBalance()`. The page adds no arithmetic of its own; static tests assert no `journal_entries`, no document totals, no table query in any of the three new files.
- **Nine columns:** Rekening, Omschrijving, Categorie, Beginsaldo Dr/Cr, Periode Dr/Cr, Eindsaldo Dr/Cr. The kernel stays debit-positive; the split is **presentation only** (`balance > 0` → debet, `< 0` → credit as a positive number, `= 0` → 0/0). No sign flip by category.
- **Reconciliation, in two honest layers.** The kernel's own self-check stays authoritative. On top of it: **(a)** the six column totals are re-summed from the visible rows and must be pairwise equal (opening Dr = Cr, period Dr = Cr, closing Dr = Cr) — this is defence in depth and is *not* independent, because it follows mathematically from the kernel's invariants and the visibility filter can only ever drop rows whose six figures are all zero; it stands as a net for a future bug in that filter. **(b)** the summed columns are compared against `report.totals` from the kernel itself, and that one *is* independent: a systematically flipped split would leave (a) perfectly balanced — the two totals merely swap places — while (b) catches it immediately, as it would a mis-copied period column or a row lost in filtering. Any failure ⇒ `role="alert"`, no figures, CSV disabled, never a fallback to document totals.
- **The export gate follows the screen.** React Query keeps `data` when a background refetch fails, so a valid-looking report can coexist with a load error. The CSV button is therefore gated on the postings query's error state, the accounts query's error *and* pending state, and a non-empty row set — and `exporteer()` re-checks that same gate, so a keyboard or scripted path cannot bypass a disabled button. A failed `grootboekrekeningen` query fails closed with its own alert instead of rendering every row as "Onbekende rekening" with an empty account number.
- **Period:** exactly PR 2's helpers and half-open `[from, toExclusive)` on `posting_date`; year chips, "Alle jaren", or Van/Tot-en-met with the same single inclusive→exclusive conversion. `boekjaar` never filters.
- **Zero accounts:** hidden by default (a row is shown when it has a non-zero opening, period movement or non-zero closing). The "Toon nulrekeningen" switch also brings in chart-of-account rows that have no postings at all, marked "Geen boekingen" — nothing is fabricated, and they never move a total. **An unresolved account that carries postings stays visible even when all six figures are zero**, so a posting on an unidentifiable account can never drop out of sight.
- **Sorting:** account number, then description, then id. Unresolved accounts (no number) sort last. Never by balance, never grouped by category.
- **Drilldown:** the account name links to the existing `/grootboek/saldi/:accountId` from PR 2; no second mutations implementation.
- **CSV:** UTF-8 BOM (written as an explicit escape, never an invisible character in the source), `;` delimiter, Dutch decimal comma, no `€`, every field quoted with `""` escaping. Same rows, same order and same totals as the screen, because both render through `formatAmountNl` and the same model. Disabled while the report is invalid, and the handler re-checks validity so a keyboard path cannot bypass the button. Filename `proef-en-saldibalans-<client>-<period>.csv`.
- **Completeness:** `LedgerCompletenessNotice` reused unchanged in meaning; it is metadata and touches no amount. One minimal fix to that component: an all-unknown completeness now renders `data-status="unknown"` with the title "Volledigheid onbekend" instead of being reported as merely "incomplete".
- **Explicitly out of scope:** Balans, W&V, opening-balance engine, result transfer, equity/liability split, the `privé` classification decision, year closing.

### Phase 6C-b8 — opening balances (beginbalans)

**Migration:** `supabase/migrations/20260919120000_add_opening_balance_posting.sql` — **✅ Applied to production** (`alxlbdhpbwlehbdbfejw`). Evidence: the generated `src/integrations/supabase/types.ts` on `main` contains `opening_balances`, `opening_balance_lines`, `opening_balance_postings`, `save_opening_balance_lines`, `post_opening_balance`, `declare_opening_balance_nil` and `lock_ledger_client`.

#### PR 1 — schema, writer and invariants (no UI)

Creates `public.opening_balances` (draft header), `public.opening_balance_lines` (draft lines), `public.opening_balance_postings` (claim marker), and the three RPCs `save_opening_balance_lines(uuid, jsonb)`, `post_opening_balance(uuid)` and `declare_opening_balance_nil(uuid)`, plus the `ledger_postings` claim guard for `source_type = 'opening_balance'` and the freeze triggers. Built on the 6C-b6 manual-journal architecture.

- **The accounting entry is ordinary `ledger_postings`.** One balanced group, one ledger row per line exactly as stored, `source_type = 'opening_balance'`, `source_id` = header, `source_line_id` = line, `posting_date` = `opening_date`, `boekjaar` = stored boekjaar, `currency = 'EUR'`, random `posting_group_id`, `line_no` 1..n by `(sort_order, id)`. **No report-only balances, no auto-balancing account, no invented suspense or equity leg, no backfill.** An unbalanced beginbalans is refused with the debit total, the credit total and the difference in the message.
- **Owner decisions, v1:** calendar-year fiscal model only (a table CHECK enforces `boekjaar = EXTRACT(YEAR FROM opening_date)`; broken fiscal years are unsupported); posting floor **accountant**, draft floor **assistant**; revenue, expense and privé accounts are allowed and **no accounting rule is derived from `categorie`**; no equity account is created; no CSV import and no reversal in this PR.
- **Earliest fact, from both sides, and genuinely serialised.** Posting is refused when the administratie already has any `ledger_postings` row before `opening_date`; a trigger on `ledger_postings` refuses the mirror image, any row dated before a **posted** beginbalans, whatever its source. Two checks alone would not close the race — under READ COMMITTED each transaction can miss the other's uncommitted work — so **every** INSERT into `ledger_postings` first takes a per-administratie advisory lock (`public.lock_ledger_client`), through a trigger that fires before 6C-b2's posting-group lock, and both assertion RPCs take that same lock as their first step. After acquiring it every path re-reads under a fresh snapshot, so whichever transaction gets there second sees the first one's committed result and is refused. The check is inert for administraties without a posted beginbalans (today: all of them); the lock is per administratie, so unrelated administraties never block each other.
- **Lock order within one administratie:** client advisory lock → posting-group advisory lock → row locks. The client lock's trigger name (`lock_ledger_client_trigger`) sorts before `lock_ledger_posting_group_trigger`, which is what makes the order hold on every path including a direct `authenticated` INSERT; a proof reads `pg_trigger` and asserts it is the first `BEFORE INSERT` row trigger on the table, and a test asserts no trigger this migration adds sorts before it. The four existing writers take every document row lock strictly before their first ledger insert, so those locks are always on the near side of the client lock.
- **Writer contract, because "no deadlock" would be false.** A per-administratie lock held to COMMIT creates a cycle wherever one transaction touches two administraties — reproduced on PostgreSQL 16, and reachable from any multi-statement caller or a bulk `INSERT` spanning two administraties. The contract is therefore the same shape as 6C-b2's for its posting-group lock: **one administratie per transaction**, or insert ordered by `client_id`, or retry on `40P01`. This is availability, not correctness: PostgreSQL aborts one side, nothing partial commits, and the earliest-fact invariant holds either way. The harness reproduces the cycle and asserts exactly that.
- **Nil declaration.** "Deliberately no opening balance" is an audited assertion, not a checkbox: a zero opening balance is unrepresentable in `ledger_postings` (a group needs debit = credit > 0 over ≥ 2 rows). `declare_opening_balance_nil()` is accountant-only, requires a lineless draft, an open year and no competing assertion, and stamps `nil_declaration` / `nil_declared_at` / `nil_declared_by` as one CHECK-enforced unit. The three nil columns are **excluded from the column-level INSERT/UPDATE grants**, so no PostgREST call can set them; the RPC is the only writer. It writes no marker and no ledger row.
- **Domain uniqueness — draft / posted / nil.** Several drafts per administratie are fine (a draft asserts nothing); at most **one effective assertion** exists. Enforced by a unique index on `opening_balance_postings (client_id)`, a **partial** unique index on `opening_balances (client_id) WHERE nil_declared_at IS NOT NULL`, and — for the cross-kind rule, which no single index can cover — a transaction-scoped advisory lock on the administratie taken by **both** RPCs before either reads the other's state, plus standing triggers in both directions. Because a header id can be re-created for a different administratie while a caller waits on that lock, both RPCs re-check after locking the header that the lock still covers it, and abort with `40001` if it does not. Both RPCs also refuse any isolation level other than READ COMMITTED, because a snapshot-preserving level would read stale state across the lock. The per-administratie rule is deliberately an **index** and not a primary key, so the future reversal phase can swap it for a partial one in a single statement pair; the exact migration is written out in the file header.
- **Freeze.** A header is always born a draft (an INSERT carrying a nil declaration is refused outright, for every caller including an owner-level statement). Once a marker exists **or** `nil_declared_at` is set, header and lines are immutable for every role: no UPDATE, no DELETE, no adding or replacing lines, and a nil declaration cannot be withdrawn. Drafts stay editable. **Posting is final until the reversal engine exists.**
- **Rollback is valid ONLY before the first opening balance has been posted.** `ledger_postings` is append-only, so after a posting the ledger rows would be left pointing at a `source_id` / `source_line_id` that no longer exists. The migration states the precondition and the check query; run it first.
- **Tests:** `src/test/opening-balance-posting.test.ts` (52 structural assertions over the migration text, comments stripped first) plus a real-PostgreSQL proof under `supabase/tests/opening-balance/` (`run-proof.sh`, **134 proofs** including 20 two- and three-session concurrency races, among them both directions of the earliest-fact race via the RPC and via a direct `authenticated` INSERT, cross-client independence, lock release on rollback, and a global assertion that PostgreSQL's deadlock counter never moved). Single-row INSERT, multi-row INSERT, `INSERT ... SELECT` and `COPY` are all proved to be covered; the one bypass, `session_replication_role = replica`, is superuser-only (proved unreachable for the application role) and the triggers stay ORIGIN deliberately, so a restore can still carry history back in. The proof is deliberately **not** part of `npm run test`: CI has no PostgreSQL. It creates and drops a throwaway database and must never be pointed at a BoekAssist database.
- **Explicitly out of scope:** UI (PR 2, below), reporting labels and completeness states (later PRs), CSV import, the reversal engine, Balans/W&V, year-end closing, result allocation and the equity/liability split inside `passiva`.

#### PR 2 — Beginbalans UI

The application layer on top of the applied PR 1 schema. **No migration, no SQL, no schema change, no edit to the generated types, no dependency change.**

```
src/pages/Beginbalans.tsx                                   route /grootboek/beginbalans
src/lib/opening-balance-utils.ts                            pure: exacte centen, toestand, poorten, payloads, foutvertaling
src/hooks/useOpeningBalances.ts                             overzicht + kop + regels + save-RPC (concept-kant)
src/hooks/useOpeningBalancePosting.ts                       claim, rolcontrole, post-RPC, nihil-RPC
src/components/grootboek/OpeningBalanceTable.tsx            dichte regeltabel (omschrijving, rekening, debet, credit, verwijderen)
src/components/grootboek/OpeningBalanceSummary.tsx          totaal debet / totaal credit / getekend verschil
src/components/grootboek/OpeningBalancePostingAction.tsx    "Boeken in grootboek" + AlertDialog
src/components/grootboek/OpeningBalanceNilAction.tsx        "Geen beginbalans nodig" + AlertDialog
```

- **Route:** `/grootboek/beginbalans`, one line in `App.tsx`. `nav.ts` untouched — the existing prefix matching keeps "Grootboek" the active/parent item. Entry point: a "Beginbalans" button in the Grootboek action bar, next to "Memoriaalboekingen".
- **Administratie and year:** a specific administratie is mandatory (`NoClientBanner` otherwise); it comes from the sidebar and is shown read-only in the header — the draft's `client_id` is never editable (the database refuses the change anyway). Boekjaar and openingsdatum are both visible and editable on a draft; the date defaults to 1 January of the boekjaar and follows a boekjaar change; a mismatch (`year(opening_date) ≠ boekjaar`) is shown inline and blocks save and post client-side, while the table CHECK and the RPC stay authoritative. Calendar years only; no fiscal-calendar logic.
- **State model, derived only:** `none` (no header for this administratie and year) → `draft` → `posted` (a row in `opening_balance_postings`) or `nil` (`nil_declaration = true AND nil_declared_at IS NOT NULL`). Posted and nil apply to the whole administratie regardless of the chosen year; drafts are looked up per boekjaar. "No opening balance" and "deliberately nil" are never collapsed (badges "Nog geen beginbalans" / "Concept" / "Geboekt" / "Nihil"). Posted **and** nil, or a half nil row, renders a `conflict` alert with nothing editable. There is no local status field.
- **Multiple drafts:** exactly one draft for the administratie and year opens automatically; more than one fails closed with an alert that lists date, description and id per draft and offers "Openen" (an explicit choice) and, for an accountant, "Verwijderen" with confirmation. Nothing is chosen, merged or deleted automatically. Drafts of other years are listed as a note with a link.
- **Draft flow:** header via a normal PostgREST insert/update under RLS (`client_id`, `boekjaar`, `opening_date`, `description`, `reference`, plus `user_id` on insert because the INSERT policy requires it; `organization_id` is derived by `set_organization_id()`; the three nil columns are never sent — they have no column grant). Lines go **only** through one call to `save_opening_balance_lines(_opening_balance_id, _lines)`; there is no client-side delete/insert of lines. A newly created header id is retained immediately, so a failed first line-save is retried as an update on the same header — no orphan headers, no duplicates — and the typed lines survive the failure. Fully blank rows are never persisted; the form always shows at least two rows.
- **Line editor:** dense grid, existing `GrootboekCombobox` with a new optional `clientId` prop that limits the list to active accounts that are organisation-wide or owned by this administratie (the same scope `ledger_postings` enforces per row; the RPC re-checks). Inactive or out-of-scope accounts on an already saved line are flagged and block posting. Debet and credit are two independent fields; nothing is auto-filled or auto-cleared; both filled → inline error. Negative → error. More than two significant decimals → error **without rounding**: blur only re-formats a valid two-decimal amount, `0,005` stays `0,005` and is sent as `0.005` so the RPC refuses it. Omzet, kosten and privé accounts are allowed with a non-blocking note only; no accounting rule is derived from `categorie`.
- **Totals:** exact integer cents parsed from the text (no float equality anywhere); totaal debet, totaal credit and the signed verschil (with "debet is hoger" / "credit is hoger") are always visible and announced via `aria-live`. "In balans" only for equal, non-zero totals with no invalid line. **No auto-balancing line, ever** (no 9998, 2010, equity or suspense leg).
- **Posting:** one call to `post_opening_balance(id)` with nothing but the id, behind an `AlertDialog` that states plainly that the starting position is recorded in the general ledger, becomes immutable, has no reversal UI yet, and that a correction meanwhile requires a compensating entry. The button is offered only when `has_min_role(auth.uid(), org, 'accountant')` returns true — unknown counts as not allowed and shows no button. Client-side the button is also off for unbalanced or zero totals, invalid lines, missing accounts, missing header fields, unsaved changes, pending save, or an uncertain/unavailable state. **Success is only reported after the claim row is re-read**; an RPC that returns without a visible marker yields "Boeking niet bevestigd". After posting: header, lines, marker and overview are refetched, the page is read-only (no edit, no remove, no save, no second post), shows boekjaar, date, description/reference, boekingstotaal, line count, `posting_group_id` (audit), the lines, the "final until reversal" note and links to Proef- en saldibalans and Grootboeksaldi. No report figures are calculated here.
- **Nil declaration:** a separate "Geen beginbalans nodig" action (accountant only, never a checkbox) with its own `AlertDialog`; one call to `declare_opening_balance_nil(id)`. Enabled only for a saved, lineless draft with no unsaved header changes and a valid year/date; the hint names what is missing. Success requires the re-read header to show `nil_declaration = true` and `nil_declared_at` set. Afterwards the page shows "Beginbalans bewust op nihil gezet op <tijdstip>", is entirely read-only and offers no undo.
- **Error mapping** (`classifyOpeningBalanceError`): `42501` → rechten/immutability (server text when Dutch); `22023` / `23514` / `22004` / `P0002` / `28000` / `25000` → validation with the server's own Dutch message (the earliest-fact refusal and the balance refusal come through literally; an English CHECK violation is translated per constraint name); `23505` → duplicate (per unique index or the RPC text); `40001` → stale; `40P01` → "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw." with **no automatic retry**; `PGRST2xx` / `42P01` / `42883` → neutral deploy-window text; anything raw → neutral text. A SQLSTATE is never shown; console logging carries only `{ code, kind }`.
- **Concurrency / stale UI:** every mutation invalidates the whole opening-balance query family (`onSettled`, so failures refresh too) plus `ledger-postings` after a post. On `23505` / `40001` / `42501` the marker and overview are refetched **before** anything is said: a marker for this header becomes the posted view without an error toast; a competing assertion elsewhere shows the server message and switches to the authoritative view. The form sync re-applies database state whenever the record turned out to be posted or nil, so no editable form is ever kept over a settled row (two tabs posting, nil-vs-post, save-after-post are all covered by tests). Typing is never overwritten by a background refetch while the draft is still a draft.
- **UI / a11y:** header card, lines card, dense grid with horizontal scrolling inside the card on small screens, totals below right, sticky action bar (save = outline, nil = secondary, post = primary), 44 px targets on mobile (`h-11 sm:h-8/9`). One `h1`, labels on every field, debet/credit inputs carry the account in their accessible name, issues in `role="alert"` lists linked via `aria-describedby`, status by badge text, confirmation dialogs are Radix `AlertDialog`s. No dashboard KPI cards.
- **Post-save freshness.** Every invalidation returns its refetch promise and the mutation callbacks return it, so `mutateAsync` resolves only once the cache has been re-read *after* the RPC (an older in-flight refetch is cancelled by `invalidateQueries`). The save RPC additionally reports `refreshed: false` when that re-read errored; the page then holds the form on what it saved until the database returns exactly those rows, instead of syncing to a possibly stale cache. On the create path the baseline (`persistedForm = form`, `persistedLines = []`) is set *before* the insert, so the overview refetch that finds the new header cannot wipe typed lines with empty database rows; the edited header is pinned as the chosen one before an update, so a boekjaar change cannot make the editor vanish mid-save. Independent review found this stale-sync window (P2) and it is closed here; `Memoriaal.tsx` carries the same latent pattern and is deliberately untouched in this PR (recorded follow-up).
- **Tests:** `opening-balance-utils.test.ts` (63), `beginbalans-page.test.tsx` (47, hooks mocked with a re-render store so refetches are observable; includes the post-save freshness cases, the `refreshed: false` hold, boekjaar changes with typed content, leftover drafts and a failed background refresh), `opening-balance-posting-action.test.tsx` (27, real QueryClient + mocked Supabase: exactly one RPC per action, no success without the marker/header re-read, invalidation keys, no table write of any kind during post or nil, 23505/40001/40P01/42501/22023/PGRST paths, a failed role check), `grootboek-combobox-client-scope.test.tsx` (2, real combobox) and `opening-balance-ui-scope.test.ts` (13, static: no `journal_entries`, no document totals, no direct ledger/marker/nil writes, lines only via the save RPC, no migration/SQL/types/package change on the branch — skipped rather than vacuous when `origin/main` is unavailable — route nested under Grootboek, `nav.ts` untouched).
- **Independent review** (fresh context, read-only, own reproductions): no P1. P2-1 (stale post-save sync) and P2-2 (a vacuous "no nil-column write" test) fixed as above. P3s fixed: the edited header stays chosen across a boekjaar change; drafts left behind after a post or nil stay visible and deletable; a typed new form is never replaced when its boekjaar is changed to a year with a draft (note + explicit open with discard confirmation); `chosenId` is scoped to the administratie; `22003`, network failures and an expired session get their own Dutch text and the UI enforces the `numeric(12,2)` ceiling; the branch-scope test skips without `origin/main`; two nil rows get their own conflict text; blur keeps a typed zero as `0,00`; a failed role check says so instead of "checking…" forever; a failed *background* refresh keeps the editor and shows a warning; the other-year draft links are 44 px chips and the grid inputs are 32 px on every desktop breakpoint.
- **Deviation from the expected file list, deliberate:** `src/components/GrootboekCombobox.tsx` gained the optional `clientId` prop (one filter line, default behaviour unchanged) because "do not allow selecting another client's account" cannot be met by any existing prop; memoriaal keeps using the combobox without it.
- **Untouched:** migrations, `ledger_postings`, the four writers and the memoriaal UI, `ledger-reporting.ts`, `proef-saldibalans.ts`, `ledger-completeness.ts`, `nav.ts`, `types.ts`, `package.json`, `VITE_SUPABASE_URL`.

#### PR 3 — reporting integration (label, drilldown, completeness)

Presentation, traceability and context only — **no change to any financial arithmetic, no migration, no SQL, no types change, no dependency change.** The reporting kernel already sums `source_type = 'opening_balance'` rows like any other row; this PR adds no second calculation path and never reads `opening_balance_lines` amounts.

- **Source label:** `LEDGER_SOURCE_LABELS.opening_balance = "Beginbalans"` in the existing central map (`ledger-reporting.ts`); the raw `opening_balance` never reaches the screen. Other labels unchanged.
- **Drilldown:** `resolveLedgerSource("opening_balance", source_id)` → `/grootboek/beginbalans?openingBalanceId=<id>`. `source_id` **is** `opening_balances.id` — verified against the writer (`post_opening_balance()` inserts `'opening_balance', v_header.id, v_line.id`) and the claim trigger (`WHERE opening_balance_id = NEW.source_id`); a static test pins that. Only a well-formed uuid is passed as target (`openingBalanceRoute()`); anything else lands on the page itself. The mutations table (`GrootboekAccountMutations`) gets label and link automatically with the accessible name `Open bron (Beginbalans) van …`; the ledger row stays the financial fact (date, description, amounts from `ledger_postings`).
- **Direct targeting on `Beginbalans.tsx`:** `?openingBalanceId=` is parsed with a uuid check (malformed → ignored with a note). The id is looked up **only** in the overview headers of the *selected* administratie (fetched under RLS with `client_id` filter) — never by a separate by-id query — so an id of another administratie or organisation is rejected with an alert and the page shows the real state; nothing of the foreign row is rendered. A matching header is applied as an explicit choice (same path as "Openen"): posted/nil stay read-only, a draft among several opens while the multiple-drafts alert stays visible, a leftover draft beside a posted assertion shows the posted view with an explanation. No mutation behaviour changed (a static test asserts the page diff adds no RPC/mutation call).
- **Completeness dimension** (`ledger-completeness.ts`, `computeOpeningBalanceCompleteness`, reusing `deriveOpeningBalanceState`): states `not_set | draft | posted | nil | posted_prior | nil_prior | other_year | conflict | ambiguous | unknown`, labels "Niet ingesteld / Concept / Geboekt / Nihil / Geboekt (eerder boekjaar) / Nihil (eerder boekjaar) / Later boekjaar / Conflict / Niet te bepalen voor meerdere boekjaren / Onbekend". `posted`, `nil`, `posted_prior` and `nil_prior` are `complete`; `not_set`, `draft` and `other_year` are `incomplete`; `conflict`, `ambiguous` and `unknown` are `unknown`. `not_set` and `nil` are never collapsed. The state comes from the domain tables (`opening_balances` + `opening_balance_postings`), never from `source_type` rows and never from an amount.
- **Report year:** `reportYearForPeriod([from, toExclusive))` — the calendar year when the period lies within one year (a year chip or any range inside a year), otherwise `null` → `ambiguous` ("Niet te bepalen voor meerdere boekjaren", never green). Because an administratie has at most one assertion ever, an assertion for an **earlier** boekjaar is the starting position of every later year — the ledger carries it forward through ordinary arithmetic — so it is `posted_prior`/`nil_prior` (complete, own label, never reported as `posted`/`nil` of the report year); an assertion for a **later** boekjaar says nothing about the report year and is `other_year` (incomplete). No fiscal-calendar logic.
- **Headline verdict:** the notice's `data-status` is `complete` only when documents are complete **and** the opening balance is `complete`; `incomplete` when either is incomplete; `unknown` when the opening-balance status cannot be determined (error, conflict, multi-year) — never disguised as "onvolledig", never green.
- **Independent review** (fresh context, read-only): no P1. P2-1 — a prior-year posted/nil assertion made every later report year "onvolledig" forever — fixed with `posted_prior`/`nil_prior` (direction-aware). P3s fixed: the target rejection is latched at first resolution (deleting the targeted draft no longer triggers "niet gevonden"); a leftover-draft target beside a **nil** assertion is explained like the posted case; the notice link's accessible name starts with its visible text (WCAG 2.5.3); `unknown` is a distinct headline verdict; the page test asserts no by-id query is ever issued with a foreign id and the Proef- en saldibalans test renders the row. Deliberately left: a disabled query reporting `isPending` before auth resolves is the same pattern as the existing completeness hook and is gated by `hasSpecificClient`.
- **Query shape:** `useOpeningBalanceCompleteness(clientId, period)` in `useLedgerCompleteness.ts` reuses `useOpeningBalanceOverview(clientId)` — the same single per-administratie query (headers + marker) the Beginbalans page uses, so every mutation there invalidates it here too. One query per client; nothing per ledger row. A query error yields `unknown` ("Kon beginbalansstatus niet controleren"), never `not_set`.
- **Presentation:** `LedgerCompletenessNotice` gains an optional opening-balance row (`completeness-opening_balance`, `data-ob-state`) with the label as text and badge (success / warning / outline — never colour only), a "Naar beginbalans" link, and the note. The overall verdict now includes it: a report is only "complete" when the documents are posted **and** the opening balance is posted or nil; callers that omit the prop see exactly the old notice. Wired into Proef- en saldibalans and Grootboeksaldi (both already showed the notice).
- **Tests:** `opening-balance-reporting.test.tsx` (30: labels, routes, the writer relationship pinned in the migration text, the mutations row and its accessible link, all completeness states and severities, report-year derivation incl. multi-year, hook error → unknown, one query per client, double-counting proofs — the account report and the trial balance contain an opening-balance group exactly once and are byte-identical to the same rows labelled `manual_journal`, a prior-year opening balance arrives only as the ledger's opening balance — and static guards: no `opening_balance_lines`, `journal_entries` or document totals in the reporting files, the kernel unchanged before the source block, no migration/types/package/nav/App/writer change) plus 6 direct-targeting cases in `beginbalans-page.test.tsx`.

### Balans/W&V PR 1 — reporting classification schema

**Migration:** `supabase/migrations/20260920120000_add_reporting_classification.sql` — **✅ Applied to production** (`alxlbdhpbwlehbdbfejw`), through the Lovable Cloud SQL editor, after PR #164 was merged. Evidence: the generated `src/integrations/supabase/types.ts` on `main` carries `statement_type`, `report_group`, `normal_side` and `report_sort` on `grootboekrekeningen` in `Row`, `Insert` and `Update`. Independent of 6C-b8 (it only touches `public.grootboekrekeningen`, created 20260412). Stamped `20260920120000` — the next day-granular noon stamp after `20260919120000`, following the chain's convention — so repository history stays in order (the CLI's real-time stamp would have sorted before an already-applied migration; renamed before merge). **Apply it through the Lovable Cloud SQL editor**, as every migration in this chain; the remote `schema_migrations` history does not track the hand-applied migrations, so `supabase db push` is not a usable path in this repository.

Schema only — **no Balans, no W&V, no classification UI, no report engine, no backfill, no comparatives, no year-end closing, no RGS, no automatic classification.** The read-only research that preceded it established that `grootboekrekeningen.categorie` is free `TEXT` (default `'kosten'`, no CHECK/enum/FK) in which `passiva` mixes equity, liabilities, VAT, suspense and result accounts, `activa` mixes fixed and current assets and `kosten` mixes cost of sales, depreciation, financial and operating expense — so `categorie` cannot be the authoritative statement classification.

- **Four additive, nullable columns on `public.grootboekrekeningen`, no defaults:** `statement_type text` (`balans` | `winst_verlies`), `report_group text` (balans: `vaste_activa`, `vlottende_activa`, `eigen_vermogen`, `voorzieningen`, `langlopende_schulden`, `kortlopende_schulden`, `prive`; winst_verlies: `netto_omzet`, `kostprijs_omzet`, `personeelskosten`, `afschrijvingen`, `overige_bedrijfskosten`, `financiele_baten_lasten`, `belastingen`, `overig_resultaat`), `normal_side text` (`debet` | `credit`, presentation side only), `report_sort integer` (≥ 0).
- **Five named CHECK constraints:** `grootboekrekeningen_statement_type_check`, `grootboekrekeningen_report_group_check` (the fifteen-value domain), `grootboekrekeningen_reporting_pair_check` (both NULL, or `balans` + a balans group, or `winst_verlies` + a winst_verlies group), `grootboekrekeningen_normal_side_check`, `grootboekrekeningen_report_sort_check`. The pair check is a `CASE` on `statement_type` with `IS NOT NULL` guards: a CHECK passes when its expression is NULL, and the naive `OR` form accepted NULL + group and `balans` + NULL group on a real cluster; the proof asserts every refused case evaluates to exactly FALSE. **Owner decision, recorded (independent review P2-2):** the pair check reads rules C/D strictly — a `statement_type` without a `report_group` is refused, so "classified" is never half a statement (the requirement relaxes `normal_side` explicitly and `report_group` not at all). The lenient form is a one-line change per branch and is written out in the migration header. `normal_side` and `report_sort` are independent and never forced, even on a classified account; whether the engine requires them is decided in the UI/engine phase.
- **Existing rows stay valid immediately:** every constraint accepts NULL and every existing row has NULL in all four columns. **No backfill**, no UPDATE/INSERT/DELETE, no account-number ranges, no derivation from `categorie`/`omschrijving`/seed position. `categorie` is untouched: not read, not rewritten, not constrained, default unchanged; seed and Grootboek UI unchanged. No trigger, function, policy, grant or index; the existing role policies (accountant INSERT/UPDATE, read_only SELECT) already cover the new columns. `ADD COLUMN` of a nullable column without default is catalog-only (no rewrite); each constraint is added only when absent, so the file is idempotent.
- **Classification is not authoritative until it has been filled in.** Until then every account is "niet geclassificeerd" and the future statement engine must treat it as such. The classification UI and the Balans/W&V engine follow in later PRs, after the migration has been applied and the types regenerated.
- **Rollback (documented in the file, not executed):** drop the five constraints, then the four columns. This loses any classification values entered since application; with no UI and no production application yet, the risk is currently low.
- **Tests:** `src/test/reporting-classification-schema.test.ts` (structural, comments stripped: the four columns, nullability, no default, the exact value sets per constraint, the pair check's three branches and nothing else, no UPDATE/DELETE/INSERT/COPY, no `categorie`, no policy/grant/trigger/function/index/DROP/ALTER COLUMN, only `public.grootboekrekeningen`, no numbers except `>= 0`, no project refs, rollback order and loss statement, exactly one migration and no `src/` / seed / types / package change on the branch — skipped rather than vacuous without `origin/main`) plus a real-PostgreSQL proof under `supabase/tests/reporting-classification/` (`run-proof.sh`: bootstrap double with the role ladder, `has_min_role()` and `prevent_org_user_rebind()` copied verbatim → the real 20260412222343 → every later production change on the table replayed as the exact repository statements (nullable `client_id`, `UNIQUE (nummer)`, `organization_id` + index, the four `role_grootboekrekeningen_*` policies and the rebind trigger from 20260613001452 §3A.11) → "existing" rows incl. free-text `categorie` → the migration **twice** → **70 proofs**: unchanged `relfilenode`, rows byte-identical, all new columns NULL, `categorie` value/default/freedom untouched, no trigger/index/policy/function added, exactly +4 columns and +5 constraints after the second application, the six valid and six invalid examples plus `balans` without group, `'foo'` group, case variant, update paths, each constraint's catalog expression evaluated in isolation to exactly TRUE/FALSE (never NULL), the production policies for real — `accountant` may insert/update the columns, `read_only` may only read them, a foreign organisation is refused — and the pre-existing rows still identical after every probe). Not part of `npm run test`: CI has no PostgreSQL; the proof creates and drops a throwaway database and must never be pointed at a BoekAssist database.
- **Deviation from the expected file list, deliberate (6C-b8):** the PR 2 and PR 3 branch-scope tests (`opening-balance-ui-scope.test.ts` 54, `opening-balance-reporting.test.tsx` 25/26/27/33/34) asserted "no `supabase/` change in this branch" — a scope statement of those PRs, not an invariant, which any later migration branch trips. They now assert what they were protecting: the beginbalans/ledger migrations and proof are untouched and no added SQL references `opening_balance`, `ledger_postings` or `journal_entries`.


### Balans/W&V PR 2 — rapportageclassificatie-UI (rekeningschema)

The application layer on top of the applied PR 1 schema. **No migration, no SQL, no schema change, no edit to the generated types, no dependency change, no reporting engine and no change to any financial arithmetic.**

```
src/lib/reporting-classification.ts        puur: labels, toestandsregels, validatie, payload, foutvertaling
src/hooks/useGrootboekrekeningen.ts        type + payloads uitgebreid, recht via has_min_role
src/pages/Grootboek.tsx                    sectie "Rapportageclassificatie", badge, groepslabel, filter
```

- **Section "Rapportageclassificatie"** in the existing account dialog: **Rapport** (`Niet geclassificeerd` / `Balans` / `Winst-en-verliesrekening`), **Groep** (only the seven balance or the eight P&L groups of the chosen statement — the other list is never rendered), **Normale zijde** (`Debet` / `Credit`, optional) and **Sortering** (integer ≥ 0, optional). Groep, zijde en sortering only exist once a statement is chosen. `categorie` keeps its own field, its own five values and its own meaning; the two are never coupled.
- **State rules live in one pure module.** Switching the statement clears an incompatible group (never translates it — an equivalent group does not exist); choosing `Niet geclassificeerd` clears the whole classification including side and sort; a group can never exist without a statement, and a statement without a group is refused rather than saved half. `buildClassificationPayload` re-checks the pair and emits four explicit `null`s for anything not fully valid, so an invalid combination cannot reach PostgREST even if the form state were corrupted. Save is disabled while the classification is invalid. Sorting: empty is `null`, **0 is a value and not a synonym for empty**, negative and non-integer are refused client-side (the CHECK stays authoritative).
- **Never derived.** The module does not contain the words `categorie`, `nummer` or `omschrijving` at all; no account-number ranges, no heuristics, no suggestion. A new account starts unclassified and stays that way until someone fills it in; the seed list (`DEFAULT_ACCOUNTS`) carries no classification field (a test asserts it).
- **Stored values outside the domain are not silently reused:** an unknown `statement_type`, or a group that does not belong to its statement, loads as empty instead of being offered back for saving, and counts as "niet geclassificeerd" in the overview.
- **Data layer unchanged in shape:** the existing `useAddGrootboekrekening` / `useUpdateGrootboekrekening` mutations carry the four fields; all four invalidations of `["grootboekrekeningen"]` stay exactly as they were; no second API layer, no direct Supabase call from the page (tests assert both).
- **Permissions:** one call to the existing `public.has_min_role(auth.uid(), org, 'accountant')` — the same ladder and the same threshold as the `UPDATE` policy on `grootboekrekeningen` itself, the same pattern as `useCanAssertOpeningBalance`. Unknown counts as not allowed. For a read-only user the section is a `disabled` fieldset **and** the classification fields are left out of the payload entirely, so the form can never overwrite what is stored. RLS remains the real gate; this only decides what is shown.
- **Overview:** a `Geclassificeerd` / `Niet geclassificeerd` badge (text, never colour alone) with the group label (`Balans · Vaste activa`) underneath, and a third filter row `Alle` / `Geclassificeerd` / `Niet geclassificeerd` next to the existing status and category chips. Half-filled rows count as not classified. No redesign of Grootboek.
- **Errors:** `classificationErrorMessage()` maps the five CHECK constraints, `42501` and `23505` to Dutch text; anything else gets a neutral message. A constraint name, a SQLSTATE or a PostgreSQL sentence never reaches the screen.
- **Tests:** `src/test/reporting-classification-ui.test.tsx` (49: the pure rules incl. both switch directions, the payload for every combination, 0 vs empty sorting, negative refused, unknown stored values, badges, both filters, the read-only and accountant paths, the payload without classification for read-only, no auto-classification on number or category, the error mapping proved not to leak, and static guards for invalidation, no second API layer, no arithmetic, no migration/types/package change).
- **Two pre-existing test files were adjusted, deliberately:** `grootboek-chart-of-accounts.test.tsx` gained the new hook in its module mock plus a `scrollIntoView` stub (test infrastructure; no assertion changed) and the four classification fields in three payload assertions — all `null`, which *pins* that nothing is auto-classified. In `reporting-classification-schema.test.ts` two PR 1 scope statements ("Grootboek.tsx and the hooks are untouched", "this branch adds exactly one migration") were replaced by their invariants: the seed carries no classification field, and no *existing* migration is ever modified.


### Balans/W&V PR 3 — statement-engine (balans + winst-en-verliesrekening)

Pure rekenlaag boven de bestaande rapportagekern. **No migration, no SQL, no schema change, no UI page, no edit to the generated types, no dependency change.** The financial truth stays `public.ledger_postings`: the engine consumes the rollups of `buildAccountReport()` (6C-b7 PR 1) and regroups them — it never reads a document total, `opening_balance_lines` or `journal_entries`, and it never touches the kernel's arithmetic.

```
src/lib/financial-statements.ts      puur: classificatie, presentatiezijde, groepen, resultaatregels, zelfcontroles
```

- **Classification is explicit only.** `statement_type`, `report_group`, `normal_side` and `report_sort` from PR 1/PR 2 are authoritative; `categorie` is **not** financial truth and appears only as a diagnostic field. Anything that cannot be presented reliably lands in `unclassified` with a reason (`missing_statement_type`, `missing_report_group`, `invalid_group_for_statement`, `missing_normal_side`, `unresolved_account`) and never disappears. No account-number ranges, no derivation from `categorie` or description.
- **Sign convention untouched.** Every line carries the kernel's `rawSignedCents` next to a `displayedCents`, so a profit and a revenue read positive without anything being flipped inside `ledger-reporting.ts`. When an account carries no `normal_side`, a fixed group map supplies its nature; `financiele_baten_lasten` and `overig_resultaat` are deliberately **absent** from that map (they genuinely run both ways) and fall to `unclassified` unless an explicit side exists.
- **The presentation sign comes from the COLUMN, not from the account** (`presentationSideFor`). This matters: normalising each line to its *own* `normal_side` and then summing a column flips a line that runs against its column twice, so it adds where it should subtract. That breaks exactly the two cases every Dutch set of books contains — **privé** (debit by nature, but it belongs on the credit side and must come *off* capital) and a **cumulative depreciation** inside the fixed assets (credit by nature, must come *off* book value). With column orientation both appear as negative deduction lines, every column total foots, and `differenceCents` is by construction exactly the unclassified gap. `normal_side` is kept as the account's *nature* and surfaces as `isContra` when it differs from its column. The independent review found both of these as P1 (an eenmanszaak's equity read €2.000 too high on a €1.000 withdrawal, and a €700 book value read €1.300); this is the fix.
- **The balance closes without writing a single posting.** The kernel guarantees `Σ opening = 0` and `Σ periodDebit = Σ periodCredit`, hence `Σ closing = 0`. Splitting accounts into balance (B), P&L (P) and unclassified (U): `Σ_B closing + Σ_P closing + Σ_U closing = 0`, and `Σ_P closing = Σ_P opening + Σ_P movement`. Those two sums move to the equity side as **presentation-only system lines** — `Onverdeeld resultaat voorgaande jaren` and `Resultaat lopend boekjaar` — which have no account id, no account number and are typed `synthetic: true`. No synthetic `ledger_postings` row, no account 9998, no result appropriation that does not exist yet. The proof is written out in the file header.
- **The closing check lives in the kernel's sign convention** (`rawReconciliationCents`), not in the presentation. An account may legitimately carry a deviating `normal_side` (a cumulative depreciation inside the fixed assets is credit-normal); that changes what a reader adds up (`differenceCents`, `ok`), never whether the set itself is sound.
- **Opening balances are ordinary ledger rows** and are counted exactly once — the same rows produce the same figures whether their `source_type` is `opening_balance` or `manual_journal`. Their contribution to **P&L** accounts (a mid-year cutover can legitimately carry YTD result) is neither silently included as ordinary operating result nor silently dropped: `openingBalanceContributionFromRows()` derives it from the *same* rows with the kernel's own `signedAmountCents`, and the model exposes `openingCents` / `movementCents` / `totalCents` plus a per-line contribution. Omit it and the model reports **unknown**, not zero.
- **Period semantics reused**: half-open `[from, toExclusive)`; balance = point-in-time closing, P&L = period movement. The current/prior split is only called a *boekjaar* split when the period is **exactly one full calendar year**; for a quarter or a month the earlier months sit in the P&L opening, which is not a "result of previous years", so the lines are relabelled period-relative and `completeness` is `ambiguous`. A multi-year period is ambiguous for the same reason.
- **Known limitation, made visible instead of guessed at:** there is no year-end closing engine yet, so a hand-booked closing entry dated on the first day of the period puts last year's result both in the P&L opening and in this period's movement, which misattributes the split (the totals stay correct). `movementOnPeriodStartFromRows()` feeds `diagnostics.profitLossOnPeriodStartCents` so a caller can see it rather than be misled.
- **Completeness is its own judgement.** `complete | incomplete | unknown | ambiguous`; mathematically balanced is explicitly *not* the same as financially complete, and unclassified activity alone makes a report incomplete. A failing kernel makes the engine fail closed with no figures at all.
- **Tests:** `src/test/financial-statements.test.ts` (70; every fixture runs through the real `buildAccountReport`, so kernel and engine are proved to agree). Covers the full 50-point matrix plus adversarial fixtures: unknown `report_group`, both cross-statement pairs, contra balances, privé coming off capital, a cumulative depreciation coming off book value, a credit-side tax refund that must not read as revenue, a mid-year cutover carrying YTD revenue, prior-year residue with no year-end close, a closing entry dated on the period start, a sub-year period, multi-year ambiguity, a stray diagnostic key, exact coverage, integer-only amounts, and static guards that the engine references no `opening_balance_lines`, `journal_entries`, document totals, React, Supabase or routing — and that `ledger-reporting.ts` and `proef-saldibalans.ts` are byte-identical to `origin/main`.
- **Independent review** (fresh context, own probes through the real kernel): no hidden second source, no double counting, no input mutation, no float. Three P1s — the two column-sum sign errors above and `completeness: "complete"` on a sub-year period — and four P2s (revenue/expense split taken from the account's nature instead of its column, an unvalidated diagnostic map, the closing-entry split, a meaningless `profitLoss.ok`) are all fixed here. The review also showed that most self-checks are unreachable while the kernel gates the input; they are kept as a vangnet for a hand-built report and for a future change in the group layout, and the comment now says so instead of calling them the real check.
- **Out of scope, deliberately:** the Balans and W&V pages, cards, tables, filters, CSV, print and charts — PR 4 consumes this engine. Legal-form logic (`rechtsvorm`) stays out; `prive` is simply an equity-side balance group here.


### Balans/W&V PR 4 — zichtbare balans en winst-en-verliesrekening

De rapporten die de engine van PR 3 aan de gebruiker tonen. **No migration, no SQL, no schema change, no edit to the generated types, no dependency change, no new arithmetic in React.**

```
src/pages/Balans.tsx                                      /grootboek/balans
src/pages/WinstVerlies.tsx                                /grootboek/winst-verlies
src/hooks/useFinancialStatements.ts                       de enige plek die de kern en de engine aanroept
src/lib/financial-statements-presentation.ts              puur: labels, statusduiding, CSV
src/components/overzichten/FinancialReportHeader.tsx      administratie + boekjaar + periode
src/components/overzichten/FinancialStatementTable.tsx    gegroepeerde regels, subtotalen, systeemregels
src/components/overzichten/FinancialCompletenessBadge.tsx volledigheidsstatus
src/components/overzichten/FinancialReportNotices.tsx     waarschuwingen + de sectie "Niet geclassificeerd"
```

- **De datastroom blijft één lijn:** `ledger_postings` → `useLedgerPostings` → `buildAccountReport()` → `buildFinancialStatements()` → scherm. `useFinancialStatements()` is de enige plek die de kern en de engine aanroept; geen pagina en geen component telt op, klapt een teken om of berekent een verschil. Een statische test bewaakt dat per bestand (geen `reduce` over bedragen, geen centenrekenwerk, geen `buildAccountReport`/`buildFinancialStatements` buiten de hook).
- **Routes onder Grootboek**, net als memoriaal, beginbalans en saldi: twee regels in `App.tsx`, twee knoppen in de Grootboek-actiebalk, `nav.ts` onaangeraakt (prefix-matching houdt "Grootboek" het actieve item). De kaarten op Overzichten stonden op *"Beschikbaar na openingsbalans"* en linken nu naar het rapport.
- **Balans:** activa en passiva naast elkaar, per groep de rekeningen met hun bedrag en een subtotaal, daarna "Totaal activa" / "Totaal passiva" en het verschil. De twee resultaatregels staan aan de passivakant, cursief, met een badge **Berekend**, zonder rekeningnummer en **zonder drilldown** — het zijn geen grootboekrekeningen. Een verschil ≠ 0 geeft een waarschuwing die zegt wat het is: precies het nog niet geclassificeerde deel.
- **W&V:** de acht groepen met hun rekeningen, daaronder opbrengsten, kosten en het resultaat. Het resultaat is `netResultCents` van de engine — niet een eigen som van de groepen — met "winst"/"verlies" als tekst erbij.
- **Niet geclassificeerd wordt nooit verborgen:** een eigen sectie met rekeningnummer, naam, bedrag en reden per rij, plus de waarschuwing *"Dit rapport is niet volledig zolang actieve grootboekrekeningen niet zijn geclassificeerd."* en een link naar het rekeningschema. De balans toont daar het eindsaldo, de W&V de periodemutatie.
- **Volledigheid is tekst, geen kleur:** `complete` → "Volledig", `incomplete` → "Onvolledig", `unknown` → "Niet vastgesteld", `ambiguous` → "Controle vereist". "Controle vereist" krijgt bewust geen groen, en bij alles behalve `complete` verschijnt er ook een toelichting.
- **Fail-closed:** faalt de kern of de engine, dan verschijnen er geen tabellen, geen totalen en geen verschil — alleen de reden, en de export staat uit. Hetzelfde geldt bij een mislukte grootboek- of rekeningschemaquery.
- **Beginbalansdiagnose:** draagt de W&V bedragen uit beginbalansposten, dan staat dat er compact bij. De melding hangt aan `diagnostics.openingBalanceInsidePeriod`, niet aan het saldo: €700 opbrengst tegenover €700 kosten geeft saldo 0 terwijl er wél €1.400 aan cutover in het rapport zit, en dat mag niet stilzwijgend verdwijnen. Is de bijdrage **niet vastgesteld** (`null`), dan zegt de melding dat — er wordt nooit een nul getoond alsof die geverifieerd is.
- **CSV-export** voor beide rapporten: exact de regels van het scherm (groepen, subtotalen, systeemregels, totalen, verschil en de niet-geclassificeerde sectie), met dezelfde scheidings- en quoteconventie als de proef- en saldibalans. Het scherm gebruikt de bestaande `formatCents` (zoals de grootboeksaldi), de CSV `formatAmountNl` (de exportconventie, zonder valutateken); beide lezen dezelfde centen uit de engine, dus scherm en export kunnen niet uit elkaar lopen.
- **Referentie-UI-kit:** de opdracht verwees naar een gelicentieerde Shadcnblocks Admin Kit op `C:\AI\references\shadcn-admin-2.3.0`. Dat is een Windows-pad; in de Linux-container van deze sessie bestaat het niet en het is dus **niet geïnspecteerd**. De UI is opgebouwd uit de bestaande BoekAssist-patronen (de proef- en saldibalans als model: `PageHeader`, `FilterChip`, `Card`, `Table`, `Alert`, `Badge`, `EmptyState`, `NoClientBanner`, `Skeleton`). **Geen enkele regel licentiecode is overgenomen en er is geen afhankelijkheid toegevoegd.**
- **Tests:** `src/test/financial-statements-ui.test.tsx` (37; de fixtures lopen door de échte kern en engine, alleen de datahooks zijn gemockt, zodat elke test bewijst dat het scherm toont wat de engine teruggeeft). Dekt beide pagina's, bedragen tegen de engine geijkt, systeemregels zonder drilldown, drilldown op echte regels, totalen en verschil, waarschuwing bij verschil ≠ 0, winst en verlies, privé aan de passivakant, tegenrekening, `report_sort`-volgorde, de niet-geclassificeerde sectie, alle vier de volledigheidsstatussen, fail-closed, beginbalansmelding, lege staat, jaarkeuze, en dat er geen andere administratie doorlekt.
- **Onafhankelijke review** (fresh context, eigen probes): geen P1. Vijf P2's verholpen — een eigen euro-formatter die het minteken anders plaatste dan de rest van de app, de beginbalansmelding die verdween bij een saldo van nul, een statische bewaking die member-expressies (`line.displayedCents`) niet ving, het rekeningschema zonder organisatiescope, en een groene "Volledig" naast een rode waarschuwing bij een ongeclassificeerde rekening zónder beweging. Bevestigd correct: elk getoond bedrag is een engineveld, geen dubbeltelling, geen kruisbesmetting tussen administraties, systeemregels niet aanklikbaar, niet-geclassificeerde rijen nooit weggefilterd, `ambiguous` nooit groen, fail-closed sluitend.
- **Vier bestaande tests zijn bijgewerkt, bewust:** `overzichten-rapporttypen.test.tsx` ("Balans en W&V blijven dicht") en `rapportages-ui.test.tsx` (de statustelling) legden vast dat deze twee rapporten *nog niet bestonden*. Dat was waar tot deze PR. Ze bewaken nu de invariant: een kaart is aanklikbaar precies dan wanneer het rapport werkelijk bestaat, en een rapport dat er niet is blijft een inerte kaart. Daarnaast waren twee scope-asserties van eerdere PR's aan vervanging toe: PR 3's "geen UI in deze branch" bewaakt nu dat de **engine zelf** vrij van UI blijft (geen React, geen JSX, geen route), en 6C-b8 PR 3 verbood elke `App.tsx`-wijziging maar bewaakt nu dat de **beginbalansroute** ongemoeid blijft.
- **Bekend, niet door deze PR veroorzaakt:** `src/test/bank-select-all-filtered.test.tsx` heeft één tijdsgevoelige test (5 s timeout op een zware render) die onder belasting omvalt. Op `origin/main` zonder deze branch faalt hij in een volledige suite-run net zo goed (tweemaal geverifieerd); los draaiend slaagt hij 8 van de 9 keer met deze branch.


### Balans/W&V PR 5 — visuele polish van de jaarrekeningrapporten

**Uitsluitend presentatie.** Geen engine-, kern- of rekenwijziging, geen migratie, geen SQL, geen schemawijziging, geen typewijziging, geen afhankelijkheid, geen route. `financial-statements.ts`, `ledger-reporting.ts`, `proef-saldibalans.ts`, `financial-statements-presentation.ts` en `useFinancialStatements.ts` zijn **byte-voor-byte gelijk aan `origin/main`**, en een test bewaakt dat. De 40 bestaande UI-tests uit PR 4 slagen **ongewijzigd** — de polish is gedragsneutraal.

- **Tabel:** dichtere regels (`px-3 py-1.5` in plaats van de standaard `p-4`), met een duidelijke hiërarchie rekeningregel → subtotaal → eindtotaal. **Elke groep is een eigen `<tbody>` met een `<th scope="rowgroup">` als kop**, zodat een schermlezer die kop werkelijk aan de regels eronder koppelt; `colgroup` zou naar een `<colgroup>`-element verwijzen dat hier niet bestaat. Bedragen blijven rechts uitgelijnd, `font-mono`, `tabular-nums` en `whitespace-nowrap`. **Lange rekeningnamen worden niet afgeknipt maar breken over meerdere regels af** (`break-words`): een `title`-tooltip als enige uitweg bestaat niet op een touchscreen en is onbetrouwbaar voor toetsenbordgebruikers. De volledige naam staat daarnaast in het `aria-label` van de link.
- **Balans:** Activa en Passiva elk in een eigen omkaderd blok met kopbalk, zodat ze ook gestapeld op een smal scherm herkenbaar twee kanten van dezelfde balans blijven. Het verschil is rustig wanneer het nul is en onmiskenbaar wanneer het dat niet is — met icoon **én** tekst, nooit kleur alleen.
- **W&V:** opbrengsten en kosten als opmaat, het resultaat als conclusie met de meeste nadruk. "winst" / "verlies" / "neutraal" blijft een **woord**, geen kleurcode.
- **Toolbar:** administratie, boekjaar, periode, volledigheid en export staan nu in één balk in plaats van verspreid over de pagina. De knopnaam "Periode toepassen" blijft voluit staan: dat is de toegankelijke naam van die knop, en compactheid komt uit de hoogte, niet uit een half woord.
- **Ongewijzigd in betekenis:** systeemregels houden hun badge "Berekend", hebben geen rekeningnummer en krijgen **nooit** een drilldown. Hun band en cursieve label zijn rustig gehouden, maar **het bedrag staat in de normale tekstkleur**: "Resultaat lopend boekjaar" is een echt onderdeel van totaal passiva en mag niet zwakker ogen dan een willekeurige kostenregel. "Niet geclassificeerd" blijft **altijd uitgeklapt**, met focus- en hoverstaten op de doorklikbare rijen. De vier volledigheidsstatussen houden hun tekst en toon; alleen "Volledig" is groen.
- **Toegankelijkheid en contrast, na de review:** het verschilbedrag is bij een verschil ≠ 0 een massieve `bg-destructive`-chip met bijbehorende foreground — `text-destructive` op een destructive-tint haalde in donker thema de 4,5:1 niet. De exportknop heet voluit "CSV exporteren" (gelijk aan de proef- en saldibalans) en de volledigheidsbadge heeft zijn zichtbare label "Volledigheid" terug; de balk heet `Rapportinstellingen en status`. Het decoratieve streepje draagt `aria-hidden` op de span en niet op de cel, de focusring heeft een onderstreping ernaast voor forced-colors, en de `dl` van de W&V-samenvatting volgt het geldige contentmodel (`dl > div > dt/dd`).
- **Tests:** `src/test/financial-statements-ui-polish.test.tsx` (16) pint de engine-waarden per regel en per totaal vast, de vier statustonen, de scrollcontainers, de rechtsuitlijning met tabulaire cijfers, **de semantische tabelstructuur (`thead`/`tbody`/`tfoot`, meerdere `tbody`'s en de `rowgroup`-kop)** en de scope (rekenlagen ongewijzigd, geen dependency/migratie/types/route). De bewaking tegen rekenwerk in de UI is case-insensitive op `cents` — élk bedrag reist hier door de prop `cents`, dus een patroon dat alleen `Cents` met hoofdletter zag, keek langs de enige variabele waar het mis zou gaan — en dekt ook `Math.*`, `toFixed`, `Intl.NumberFormat` en `filter`/`slice`/`sort`; een eigen test bewijst dat die patronen twaalf realistische overtredingen vangen. De scope-tests slaan zichtbaar over (`ctx.skip()`) wanneer `origin/main` ontbreekt, in plaats van stilzwijgend groen te worden.
- **Onafhankelijke review** (fresh context): geen P1 — geen enkel bedrag gewijzigd, geen verborgen waarschuwing, geen paginabrede overflow (doorgerekend op 360 px). Zes P2's verwerkt: het dark-mode-contrast van het verschilbedrag, de in deze PR geïntroduceerde afknipping van rekeningnamen, het te stil gezette bedrag op systeemregels, de tot "CSV" gekrompen knopnaam, de verdwenen zichtbare statuslabel, en de te smalle bewaking tegen rekenwerk. P3's: `rowgroup` in plaats van `colgroup`, `aria-hidden` op de span, forced-colors-focus, geldig `dl`-model, badges van 10 px naar `text-xs`, "Rek." weer "Rekening", kloppende min-breedte en een groepsband die lichter is dan de totaalregel.
- **Referentie-UI-kit:** opnieuw niet bereikbaar. `C:\AI\references\shadcn-admin-2.3.0` is een Windows-pad en deze sessie draait in een Linux-container; gezocht in `/mnt`, `/` en de WSL-variant. Niets geïnspecteerd, niets overgenomen, geen afhankelijkheid toegevoegd — de polish komt volledig uit de bestaande BoekAssist-bouwstenen en Tailwind-conventies.

---

Future phases: 6C-b6 manual journal posting is the section above (PR 1 schema + writer, PR 2 application layer — both done), 6C-b7 is the section above (PR 1 reporting core, PR 2 Grootboeksaldi and PR 3 proef- en saldibalans done; Balans/W&V wait for an opening-balance phase), and 6C-b8 is the section above (PR 1 schema + writer applied to production, PR 2 Beginbalans UI done; CSV import and the reversal engine remain future work). Source-level idempotency is handled per writer (purchase, sales, bank and manual journal each guard their own `source_type` on `ledger_postings`) — see the 6C-b2 migration header for why no universal uniqueness constraint is safe.

**Status of the 6C-b2 … 6C-b5b chain: ✅ Applied to production** (`alxlbdhpbwlehbdbfejw`). Evidence: the generated `src/integrations/supabase/types.ts` contains `bank_allocation_postings` and `post_bank_allocation`, which only exist once the whole chain (6C-b2 foundation → 6C-b2a → 6C-b3 → 6C-b4 → 6C-b5a → 6C-b5b) has been applied; the 6C-b5b prerequisite guard would have refused otherwise.

Verification query (for future reference):
```sql
select to_regclass('public.ledger_postings') as postings_table,
       to_regclass('public.purchase_invoice_postings') as purchase_marker,
       to_regclass('public.sales_invoice_postings') as sales_marker,
       to_regclass('public.bank_allocation_postings') as bank_marker;
```

Expected result: all four names, none NULL.


### Fix — rapportage zonder beginbalans (Balans, W&V, proef- en saldibalans)

Melding: "de rapporten tonen geen cijfers zolang er geen beginbalans is". **Diagnose eerst**, met probes door de échte keten (kern → proef- en saldibalans → statement-engine) vóór er één regel werd aangeraakt.

**Wat NIET de oorzaak was.** De beginbalans blokkeert nergens iets:
- Met boekingen in de periode en **zonder één beginbalansrij** geeft `buildAccountReport()` `ok`, levert `buildTrialBalance()` gewoon rijen (begin 0, debet/credit/saldo gevuld) en geeft `buildFinancialStatements()` een kloppende balans en W&V met `completeness: "complete"`.
- Ook het **schrijfpad** eist geen beginbalans: geen van de vier documentschrijvers noemt `opening_balance`, en de trigger `enforce_no_posting_before_opening_balance()` keert meteen terug zodra er geen beginbalans is (`v_opening IS NULL`). Er is dus ook geen indirecte keten "geen beginbalans → niets te boeken → leeg rapport".
- De pagina's kennen geen beginbalans-gate: die status is er uitsluitend als *melding*.

**Wat een lege Balans/W&V wél verklaart: de ontbrekende classificatie.** De migratie `20260920120000_add_reporting_classification.sql` voegde `statement_type`/`report_group` toe **zonder backfill** — bewust, want niets mag uit `categorie` of een rekeningnummer worden geraden. Gevolg: in elke bestaande administratie zijn die velden NULL, plaatst de engine élke rekening in `unclassified`, en tonen Balans en W&V **nul groepsregels en totalen van € 0,00** terwijl er wél grootboekactiviteit is. Dat is correct gedrag (de engine weigert te raden) dat er als een kapot rapport uitziet.

**Geen universele oorzaak.** Dit verklaart uitsluitend een lege **Balans of W&V bij bestaande ledger-activiteit**. De proef- en saldibalans hangt níet van classificatie af; is díe óók leeg, dan zegt de classificatie daar niets over en is aparte vaststelling nodig of er überhaupt `ledger_postings` in de gekozen periode bestaan (documenten kunnen opgeslagen zijn zonder ooit geboekt te zijn). Daarom verschijnt bij een werkelijk leeg rapport de bestaande documentvolledigheidsmeter en niet de classificatiemelding.

**De fix — uitsluitend presentatie, geen boekhoudlogica:**
- `NothingClassifiedNotice` bovenaan Balans en W&V zodra er activiteit is die op dít overzicht thuishoort of kán horen, maar er géén enkele geclassificeerde regel staat: legt uit dát dit de reden is, noemt het **aantal rekeningen** (bewust **géén bedrag**: bij "niets geclassificeerd" is de getekende nettosom per definitie € 0,00 en zou "3 rekeningen (€ 0,00)" lezen als "er is niets") en linkt naar het rekeningschema. De bedragen stonden er al onder "Niet geclassificeerd", maar ónder twee lege tabellen en dus onvindbaar.
- **Per overzicht, nooit globaal.** `attributeUnclassifiedAccount()` leidt uitsluitend uit de twee expliciete velden af voor welk overzicht een niet-geclassificeerde rekening bedoeld was: een geldig `statement_type` is bepalend; ontbreekt dat maar staat er een geldige `report_group`, dan wijst die groep het overzicht aan (de groepsverzamelingen van balans en W&V zijn disjunct); spreken beide velden elkaar tegen (`invalid_group_for_statement`) of zijn ze allebei leeg, dan is het antwoord **onbepaald**. Nooit een afleiding uit rekeningnummer, naam of `categorie`. `unclassifiedRelevanceFor()` telt dat per overzicht, zodat balansactiviteit de W&V nooit laat beweren dat zíj leeg is door ongeclassificeerde W&V-rekeningen (en omgekeerd), en zodat een onbepaalde toestand een voorzichtige formulering krijgt in plaats van een onjuiste oorzaak.
- **Documentvolledigheid alleen bij een leeg rapport.** `useLedgerCompleteness(clientId, { enabled })` — de optie is nieuw, de default (`true`) houdt elke bestaande aanroeper ongewijzigd. `fetchLedgerCompletenessCounts()` doet negen parallelle tellingen met gepagineerde id-lijsten; Balans en W&V zetten de query pas aan zodra ná het laden vaststaat dát het rapport leeg is. De hook wordt altijd aangeroepen (React-regel), de query niet.
- `OpeningBalanceCarryForwardNotice` op de Balans, gevoed door de bestaande `useOpeningBalanceCompleteness`: de beginbalansstatus als **volledigheidsmelding, nooit als blokkade**. Ontbreekt de beginbalans, dan is de overloop uit eerdere jaren onbekend — de geboekte mutaties blijven onverkort zichtbaar.
- `financial-statements.ts`, `ledger-reporting.ts`, `proef-saldibalans.ts`, `financial-statements-presentation.ts` en `useFinancialStatements.ts` zijn **byte-voor-byte ongewijzigd**; er is geen migratie, SQL, schema-, types- of dependencywijziging.

**Tests:** `src/test/reporting-without-opening-balance.test.tsx` (31, door de échte kern/PSB/engine): W&V-mutaties, balans-eindsaldi en PSB-debet/credit/saldo zonder beginbalans; geldige lege staat zonder activiteit; een ontbrekende beginbalans is nooit een enginefout en raakt alleen de volledigheid; geclassificeerde balans- en W&V-rekeningen verschijnen; ongeclassificeerde activiteit blijft zichtbaar mét bedrag en krijgt de uitleg; de melding noemt géén bedrag; de synthetische resultaatregel klopt; er wordt geen beginbalansbedrag verzonnen (`openingBalanceContributionCents` blijft `null` = niet vastgesteld, nooit een geverifieerde nul); administratiescheiding; werking mét een geboekte beginbalans; geen dubbeltelling; periodefiltering. Plus de statement-specifieke regressies: alleen-balansactiviteit → de balans meldt het en de W&V zwijgt; alleen-W&V-activiteit → spiegelbeeld; gemengd → elke pagina noemt alleen haar eigen aantal; volledig onbekende classificatie → geen stellige oorzaak, bedragen blijven zichtbaar; toewijzing uit de expliciete velden en nooit uit het rekeningnummer; een rekening zónder beweging zet geen melding aan; en de `enabled`-schakelaar (gevuld rapport → uit, ongeclassificeerde activiteit → uit, werkelijk leeg → aan, geen administratie → uit, enginefout → uit).

`src/test/ledger-completeness-enabled.test.tsx` (4, echte QueryClient + gemockte Supabase-client die elke tabelaanroep telt): zonder optie draait de query (backwards compatible), `enabled: true` draait, `enabled: false` raakt de database niet aan (`fetchStatus: "idle"`), en zonder administratie blijft hij uit.

---

### Historische grootboekvulling — PR 1 (inkoop en verkoop)

**Aanleiding, met productiebewijs.** In productie is `public.ledger_postings` volledig leeg (`totaal_regels = 0`, `klanten = 0`, `groepen = 0`). De proef- en saldibalans, de balans en de W&V zijn daarmee **correct** leeg: er is niets te rapporteren. De rapportagecode is dan ook niet aangeraakt. De oorzaak is dat de grootboekfundering pas sinds migratie `20260914120000` bestaat en bestaande facturen en banktransacties **bewust nooit historisch zijn gebackfilled**. Cijfers verschijnen pas wanneer de ledger via de bestaande writers wordt gevuld — niet door een rapportage een andere bron te laten lezen.

**Wat dit is, en wat het niet is.** Geen datamigratie en geen backfill-script, maar een gecontroleerde applicatieworkflow op `/grootboek/historisch` ("Historische boekingen", onder Grootboek, zonder eigen nav-item). De kernregel: **`ledger_postings` wordt nooit rechtstreeks gevuld**; elke boeking loopt via de bestaande RPC's `post_purchase_invoice()` en `post_sales_invoice()`, aangeroepen via de bestaande mutatiehooks `usePostPurchaseInvoice()` / `usePostSalesInvoice()`.

- **`src/lib/ledger-catchup.ts`** — puur. Beoordeelt per bronrecord: `geboekt` (er is een marker), `klaar` of `geblokkeerd` met concrete redenen. De controles volgen één-op-één de guards in de writermigraties `20260915140000` en `20260915160000`: postbare status, factuurdatum, afgesloten boekjaar (`clients.afgesloten_boekjaar`), aanwezige en positieve bedragen, `excl + btw = incl`, crediteuren-/debiteuren-/BTW-rekening, omzetrekening op de verkoopfactuur, en voor inkoop de regelaggregatie (minstens één regel, elke regel een grootboekrekening, som gelijk aan het bedrag exclusief BTW). Bedragen worden in hele centen vergeleken, omdat de writer in NUMERIC rekent en géén tolerantie hanteert — een vergelijking in doubles zou een geldige factuur afkeuren.
- **Readiness is uitsluitend UX.** De server-writer valideert bij elke aanroep opnieuw en blijft de autoriteit. Zegt deze laag "klaar" en weigert de writer alsnog, dan blijft het record ongeboekt en wordt de weigering per record getoond.
- **`te_controleren` wordt nooit automatisch gewijzigd.** Die facturen verschijnen als geblokkeerd met de status letterlijk in de reden; goedkeuren blijft een menselijke handeling in de inkoopwerkplek. Er is geen bulk-statuswijziging en geen "goedkeuren en boeken".
- **Geen rekeningnummer-heuristiek.** Er wordt nooit een nummerreeks voor bank, debiteuren, crediteuren of BTW verondersteld; er wordt alleen gekeken óf de expliciet ingestelde account-id bestaat. Ontbreekt die, dan is de reden een configuratiereden met een link naar de instellingen.
- **`src/hooks/useLedgerCatchup.ts`** — datalaag en bulkactie. Leest brondocumenten en de **marker**-tabellen (`purchase_invoice_postings`, `sales_invoice_postings`); nooit `ledger_postings` om te bepalen of iets geboekt is. De bulkactie biedt records één voor één aan in de volgorde inkoop → verkoop (zodat de factuurmarkers bestaan vóór de bankafletteringen van PR 2), zonder retrylus: elke writeraanroep is server-side atomair, een halve boekingsgroep bestaat niet, en een weigering op het ene record raakt het volgende niet. Na afloop worden `["ledger-catchup"]`, `["ledger-postings"]` en `["ledger-completeness"]` geïnvalideerd, ook na een gedeeltelijk mislukte ronde.
- **Idempotentie** komt uit de markers plus de writers zelf (beide weigeren een tweede boeking met 23505). Een reeds geboekt record is `geboekt`, ook als het verder gebreken heeft, en wordt nooit opnieuw aangeboden.
- **Periode:** filter op boekjaar of "Alle jaren", altijd op de **echte brondatum**. Er wordt nooit een datum herschreven; de writer bepaalt `posting_date` volgens het bestaande contract.

**Bewust buiten deze PR:** bankafletteringen (PR 2 — die eisen een reeds geboekte bronfactuur en een eigen richtingscontrole) en memoriaalboekingen. Memoriaal kent wél een "opgeslagen maar niet geboekt"-toestand (concept-kop + regels, marker `manual_journal_postings`), maar de tabellen bestaan pas sinds `20260918120000` en worden in dezelfde sessie opgesteld én geboekt: er is geen historische achterstand om in te lopen, dus een catch-up daarvoor zou kunstmatig zijn.

**Tests:** `ledger-catchup.test.ts` (25, puur: elke writerguard afzonderlijk, beide soorten, centenvergelijking, volgorde, en dat geen enkele blokkadereden een rekeningnummer noemt), `ledger-catchup-run.test.tsx` (10, tabelgestuurde nep-Supabase die de echte filters toepast: administratiescheiding inclusief een marker van een andere administratie, tellingen, boekjaarfilter, alleen `klaar` naar de writer, één weigering beschadigt de rest niet, volgorde, geen enkele insert, en idempotentie over twee rondes) en `ledger-catchup-page.test.tsx` (14: samenvatting, per-recordweergave, blokkadereden, bevestigingsdialoog met echte aantallen, resultaatmelding, plus statische grenzen — geen `ledger_postings`-schrijfpad, geen eigen `supabase.rpc`, geen rekeningnummers, geen statuswijziging).

**Geen migratie.** De bestaande bron-, marker- en writerstructuren zijn toereikend; er is geen schemawijziging nodig en er is geen productie-SQL uitgevoerd.

---

### Fase 6C-b9 — de tegenboekingsmotor (reversal engine)

Migratiebestand:
```
supabase/migrations/20260921120000_add_ledger_reversal_posting.sql
```

**Status: ⏳ Nog niet toegepast.** Toepassen via de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`, ná review. De leescontroles vooraf en de postcheck staan in de header van het bestand.

De zesde grootboekschrijver, en de eerste die geen brondocument boekt maar een **bestaande boekingsgroep tegenboekt**. `public.reverse_posting_group(_posting_group_id uuid, _posting_date date, _reason text DEFAULT NULL)` maakt een NIEUWE boekingsgroep die de oorspronkelijke exact negeert: één tegenregel per originele regel, debet en credit verwisseld, rekening, valuta, organisatie en administratie exact overgenomen. **Het origineel blijft ongewijzigd, voor altijd** — er wordt nooit een regel gewijzigd of verwijderd.

- **Lineage in twee lagen.** Regel → regel via `ledger_postings.reversal_of_posting_id` (de kolom bestond sinds 6C-b2 en is hier zijn eerste gebruiker): elke tegenregel wijst naar de **exacte** originele regel-id, niet naar "een regel van de groep". Groep → groep via `public.ledger_reversal_postings`, waarvan `original_posting_group_id` de PRIMARY KEY is — "één origineel → hoogstens één tegenboeking" is daarmee een database-invariant en geen applicatieafspraak. `reversal_posting_group_id` is UNIQUE. `source_line_id` blijft NULL: twee kolommen met hetzelfde feit kunnen uit elkaar gaan lopen.
- **Bronsoort `reversal`**, een eigen soort. De claimtriggers van memoriaal en beginbalans weigerden al een regel die hun bronsoort droeg én een `reversal_of_posting_id`; deze migratie maakt die afspraak universeel met de CHECK `ledger_postings_reversal_source_type_check` (`reversal_of_posting_id IS NULL OR source_type = 'reversal'`) — de enige, additieve `ALTER TABLE` op de fundering.
- **Argumenten: drie in plaats van één.** Alles wat geboekt wordt volgt uit de reeds vastgelegde grootboekregels, op één ding na: de boekingsdatum van de tegenboeking. Dat is een boekhoudkundige keuze die nergens is opgeslagen; hem afleiden zou raden zijn. Hij wordt daarom streng gecontroleerd (bereik 2000–2100, nooit vóór het origineel, nooit in een afgesloten boekjaar) en **nooit stilzwijgend verschoven** — geen terugval op vandaag, geen terugval op het eerstvolgende open jaar. `_reason` is documentatie (≤ 500 tekens) en beïnvloedt geen enkel bedrag.
- **Autorisatie vóór inhoud, in twee drempels.** De functie is `SECURITY DEFINER` en ziet dus rijen die RLS voor de aanroeper verbergt; zou zij eerst "niet gevonden" en daarna "geen rechten" zeggen, dan is dat verschil een orakel waarmee een ingelogde buitenstaander het bestaan van andermans boekingsgroepen kan aflezen. Daarom: (a) **leesdrempel** — de aanroeper moet `read_only` hebben op élke organisatie die in de groep voorkomt; zo niet, dan krijgt hij exact dezelfde fout als voor een niet-bestaande groep: SQLSTATE **42501**, tekst **"Boekingsgroep niet beschikbaar"**. (b) **schrijfdrempel** — daarna geldt de rolvloer **accountant**, gelijk aan memoriaal (6C-b6) en beginbalans (6C-b8) en strenger dan de documentschrijvers; die melding mag eerlijk zijn, want wie de leesdrempel haalt mag de regels onder RLS toch al zien. Pas ná beide drempels volgt élk inhoudelijk oordeel (meerdere organisaties, meerdere administraties, bronsoort, al tegengeboekt, kapot, valuta, afgesloten boekjaar). De organisatieset wordt **in zijn geheel** opgehaald (`array_agg(DISTINCT organization_id)`), nooit via `LIMIT 1`: bij een kapotte groep met twee organisaties zou een steekproef toevallig de rechten op de ene gebruiken en de andere negeren, en juist dán zou er tenantinformatie weglekken. Onder de administratiegrendel wordt nog eens geverifieerd dat de groep dezelfde is als die waarvoor is geautoriseerd; verschilt dat, dan opnieuw de generieke fout.
- **Het origineel wordt eerst als boekhoudkundig feit gevalideerd.** Eén organisatie, één administratie, één valuta (EUR), één boekingsdatum en boekjaar dat daarbij hoort, één bronsoort, één transactie (`created_xact_id`), minstens twee regels, elke regel op precies één zijde, geen NaN, geen negatief bedrag, sluitend in exacte NUMERIC, en elke rekening binnen de administratie (`posting_account_ok`). **Een kapotte groep wordt geweigerd, niet "hersteld"**: tegenboeken zou de fout verdubbelen en het bewijs uitwissen. Ook een groep die in dezelfde transactie is ontstaan wordt geweigerd.
- **`actief` wordt bewust NIET gecontroleerd.** De vijf schrijvers weigeren een inactieve rekening omdat zij iets nieuws beginnen; een tegenboeking haalt juist weg wat er al op staat. Zou `actief` hier gelden, dan werd het deactiveren van een rekening een val waaruit een foutieve boeking nooit meer te corrigeren is.
- **Twee dingen kunnen bewust niet.** (a) Een tegenboeking van een tegenboeking: de keten blijft één stap diep, afgedwongen door de CHECK `original_source_type <> 'reversal'` op de marker én door de schrijver. Is de tegenboeking zelf fout, dan is de juiste weg een nieuwe, correcte boeking. (b) Een tegenboeking van een **geboekte beginbalans** — niet omdat de boeking onmogelijk is, maar omdat de administratie daarna klem zou zitten: `uniq_opening_balance_postings_client` staat hoogstens één geboekte beginbalans per administratie toe en `enforce_no_posting_before_opening_balance()` blijft alles vóór de openingsdatum weigeren, dus het grootboek zou op nul staan zonder dat er ooit een gecorrigeerde beginbalans geboekt kan worden. 6C-b8 schrijft in zijn eigen header uit welke indexwissel daarvoor nodig is; dat is een aparte, bewuste fase. Tot die er is weigert de functie met een expliciete uitleg in plaats van een val te zetten.
- **Concurrency.** Grendelvolgorde ongewijzigd ten opzichte van 6C-b8: administratiegrendel (`lock_ledger_client`) → boekingsgroep-grendel (trigger van 6C-b2) → markerclaim → grootboekregels. Er wordt **geen rijgrendel op het origineel** genomen, en dat is geen omissie: `ledger_postings` is append-only en elke groep is verzegeld aan haar eigen transactie, dus een gecommitte groep kan niet meer veranderen. De enige race is twee gelijktijdige tegenboekingen van dezelfde groep, en die wordt gearbitreerd door de primary key van de marker.
- **Claimtrigger `enforce_reversal_source_claim()`** (BEFORE INSERT op `ledger_postings`, strikt gescoped op `source_type = 'reversal'`): claim aanwezig, groep, organisatie, administratie, datum, boekjaar, valuta, regelnummer binnen het geclaimde aantal, gebruiker gelijk aan de claim, `source_line_id` leeg, `reversal_of_posting_id` verplicht, de originele regel bestaat en hoort bij de geclaimde groep, dezelfde rekening, dezelfde valuta, en debet/credit exact verwisseld. Integriteit, geen autorisatie: geen `auth.uid()`, geen `has_min_role()` (patterns §5B). Daarnaast de **globale** partiële unieke index `idx_ledger_postings_reversal_of_posting` — één originele regel wordt hoogstens één keer tegengeboekt, ooit, ook binnen dezelfde transactie.
- **Rechten.** RPC: `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` gevolgd door `GRANT EXECUTE TO authenticated`; `service_role` krijgt bewust geen EXECUTE. Marker: RLS aan met een `read_only`-leespolicy, `REVOKE ALL` gevolgd door `GRANT SELECT` voor `authenticated` en `service_role`, niets voor `anon`.
- **Diagnostiek (alleen lezen).** `src/lib/reversal-integrity.ts` beoordeelt de lineage op zes punten: claim zonder origineel, claim zonder tegenboeking, tegenregel zonder originele regel, tegenboeking die niet exact negeert (bedrag, rekening, valuta of regelaantal), lineage buiten de administratie, en dubbele tegenboeking. De controle "een boekingsgroep sluit niet" staat er **bewust niet** in: die geldt voor élke groep en wordt al gedaan door `evaluateLedgerIntegrity()`. `diagnosticsForReversals()` vertaalt de bevindingen naar het bestaande itemmodel (alle zes `error`, domein `ledger`) en `useAccountingDiagnostics` haalt de markers op. **Deploy-venster:** verschijnt de frontend vóór de migratie, dan levert de markerquery `null` en wordt de dimensie overgeslagen — nooit "schoon" gemeld op basis van gegevens die niet konden worden opgehaald. De tijdelijke structurele cast op `ledger_reversal_postings` verdwijnt zodra de migratie is toegepast en de types opnieuw zijn gegenereerd (patterns §11).
- **Geen UI in deze PR.** Geen pagina, geen route, geen `nav.ts`, en geen hook rond de RPC: die zou vandaag geen aanroeper hebben. De correctie-UI is de volgende PR.
- **Bekende, bewuste consequentie voor de volgende PR:** `LEDGER_SOURCE_LABELS` in `ledger-reporting.ts` kent `reversal` niet, dus `resolveLedgerSource("reversal", …)` levert een onopgelost resultaat met de ruwe tekst als label. Dat bestand is byte-voor-byte bevroren door de PR5-bewaking en een label is presentatie; het hoort bij de UI-PR, samen met een drilldownroute.
- **Bekende beperking van de diagnoselaag:** `ReversalPostingLike` toetst lineage op `client_id` en niet op `organization_id`. `LedgerPostingLike` in de (byte-bevroren) rapportagekern kent die kolom niet, dus meenemen zou een wijziging aan die kern of een eigen type-uitbreiding vragen — buiten het bestek. De organisatiedimensie wordt wél afgedwongen in de database: `enforce_ledger_posting_org()` eist dat een tegenregel en haar origineel dezelfde organisatie én administratie delen, en de claimtrigger vergelijkt de organisatie van elke tegenregel met die van de claim. Binnen één organisatie is `client_id` bovendien de fijnere van de twee.
- **Tests:** `src/test/ledger-reversal-engine.test.ts` (49: 28 structurele asserties over de migratietekst met commentaar gestript — waaronder de autorisatievolgorde en het ontbreken van een tweede formulering voor "niet beschikbaar" —, 13 over de pure lineagelaag, 3 over de vertaling naar de console, en 5 branch-scope) plus een echt-PostgreSQL-bewijs onder `supabase/tests/ledger-reversal/` (`run-proof.sh`, **98 bewijzen**, waaronder twaalf die de tenantpoort afdekken door de vólledige foutidentiteit (SQLSTATE + boodschap) van een onbekende en een vreemde boekingsgroep letterlijk naast elkaar te leggen, waaronder de drieregelige inkoopstijl-tegenboeking uit de opdracht, exacte centen, twee regels op dezelfde rekening die twee regels blijven, het onveranderde origineel, alle weigeringen, de atomiciteit met een geforceerde mislukking ná de claim, een teruggedraaide aanroeper, en vier gelijktijdigheidsscenario's met twee echte sessies waaronder één winnaar bij een dubbele tegenboeking). Het bewijs is bewust **geen** onderdeel van `npm run test`: CI heeft geen PostgreSQL. Het maakt en verwijdert een wegwerpdatabase en mag nooit op een BoekAssist-database worden gericht.
- **Dertien bestaande scope-testen zijn bijgewerkt, bewust.** Zij legden vast dat hún PR "geen migratie en geen SQL" bevatte — waar over die PR, maar geen invariant: elke latere fase die terecht een migratie meebrengt laat ze omvallen (dat gebeurde eerder al bij 6C-b8 en bij Balans/W&V PR 1). Wat zij werkelijk beschermden staat nu op één plek, `src/test/support/branch-sql-scope.ts`: een migratie in de branch mag de grootboekfundering niet wijzigen of weggooien — **additief erbij zetten mag** — en mag geen bestaande boekingsschrijver herschrijven. Drie testen verboden daarnaast élke `ALTER TABLE public.ledger_postings`; dat is te grof voor een additieve CHECK en is vervangen door hetzelfde onderscheid.

#### PR 2 — de correctieflow (UI)

De applicatielaag op de toegepaste motor. **Geen migratie, geen SQL, geen schemawijziging, geen wijziging aan `reverse_posting_group()`, de claimtrigger of een bestaande schrijver, geen handmatige typewijziging, geen afhankelijkheid, geen nieuwe route en geen nav-item.**

```
src/lib/ledger-reversal-ui.ts                          puur: samenvatting, voorbeeld, vormcontroles, foutvertaling
src/hooks/useLedgerReversal.ts                         regels, claim, rol, en de enige schrijfactie
src/components/grootboek/LedgerPostingGroupSheet.tsx   het boekingsdetail met de correctieactie en het auditspoor
src/components/grootboek/ReversalConfirmDialog.tsx     de bevestiging: datum, toelichting, voorbeeld
```

- **Toegangspunt: het bestaande mutatieoverzicht per rekening** (`/grootboek/saldi/:accountId`). Elke regel hoort bij een boeking, en die boeking is daar aan te wijzen; een knop per regel opent een zijpaneel met de volledige boekingsgroep. Bewust **geen nieuwe route en geen nieuwe navigatie**: een boeking is een detail van wat er al op het scherm staat, geen eigen bestemming. Het paneel wordt pas gemonteerd zodra er een boeking is aangewezen, zodat de mutatietabel nog steeds geen enkele query doet zolang niemand erom vraagt (de bestaande bewaking daarop blijft gelden).
- **De grens blijft waar hij hoort.** Er gaan precies drie waarden naar de database: de id van de boekingsgroep, de door de gebruiker gekozen boekingsdatum en (optioneel) de toelichting. Bedragen, zijden, rekeningen, valuta, organisatie, administratie en de regel-op-regel-lineage komen alle uit `reverse_posting_group()`. Een test pint de RPC-aanroep letterlijk vast en bewijst dat er geen bedrag of rekening in meegaat; een tweede bewijst dat geen enkel gewijzigd bestand een schrijfpad naar `ledger_postings` heeft.
- **Het voorbeeld is een voorbeeld.** De bevestiging toont het effect met debet en credit verwisseld, met een badge "Voorbeeld" en de zin dat de database de tegenboeking maakt uit de opgeslagen grootboekregels. Geen enkel bedrag daaruit verlaat de browser.
- **De datum wordt niet voorgevuld.** Niet vandaag, niet de datum van het origineel, niet het eerstvolgende open jaar. In welke periode een correctie landt is een boekhoudkundige beslissing; het veld is leeg en verplicht, met de datum van het origineel ernaast. Een afgesloten boekjaar blijft een serverweigering.
- **De toelichting** is optioneel, wordt getrimd en is client-side begrensd op 500 tekens (de kolom-CHECK blijft de autoriteit). Er wordt geen enkele boekhoudkundige gevolgtrekking uit afgeleid.
- **Al tegengeboekt komt uitsluitend uit `public.ledger_reversal_postings`** — nooit uit een omschrijving, een bronlabel of een saldo van nul. Is er een claim, dan toont het paneel "Tegengeboekt", de tegenboekingsgroep, de datum en de toelichting, en is er geen tweede uitvoerbare actie.
- **Niet-ondersteunde bronsoorten** (`reversal`, `opening_balance`) krijgen geen knop maar een uitleg, afgelezen uit de **opgeslagen** `source_type` van álle regels (zodat een gemengde groep met ergens een tegenboekingsregel evenmin wordt aangeboden) en nooit uit een rekeningnummer of label.
- **Geen boekhoudkundige acceptatieregel in de UI.** Of een boeking sluit, één valuta heeft, een boekjaar dat bij haar datum hoort, of één bronsoort — dat zijn oordelen van `reverse_posting_group()`, die ze bij élke aanroep opnieuw velt. Ze in React herhalen zou een tweede regelset opleveren die van de echte kan gaan afwijken, en dan wint stilletjes de verkeerde. Zulke afwijkingen worden daarom als **waarschuwing** getoond (`postingGroupWarnings()`) en houden een accountant niet tegen: de knop blijft beschikbaar, de RPC wordt aangeroepen, en de database levert de reden als zij weigert. Blokkeren mag alleen wat géén boekhoudkundig oordeel is: een onbekende of mislukte toestand, een reeds vastgelegde claim, een niet-ondersteunde opgeslagen bronsoort, een aantoonbaar te lage rol, en de vormcontroles op het formulier (datum verplicht, toelichting ≤ 500).
- **Rol:** de knop verschijnt alleen wanneer `has_min_role(…, 'accountant')` waar is; onbekend telt als niet toegestaan. De RPC blijft de autoriteit.
- **Dubbelklik.** `isPending` en een uitgeschakelde knop worden pas ná een render waar; drie klikken binnen één tick zagen die alle drie nog op "uit" staan. Een `useRef`-grendel sluit dat af vóór de eerste render — een test vuurt drie klikken af en telt één RPC.
- **Race met een andere sessie:** een `23505` is een eindtoestand, geen storing. De claim wordt opnieuw opgehaald, het paneel toont dat de boeking al is tegengeboekt, en er wordt nooit automatisch opnieuw geprobeerd.
- **Invalidaties na een tegenboeking:** `ledger-reversal`, `ledger-posting-group`, `ledger-postings`, `ledger-integrity`, `accounting-diagnostics`, `ledger-completeness` en `ledger-catchup` — ook ná een fout, want een concurrerende toestand mag niet in de cache blijven staan. De diagnostiek zelf is niet aangepast.
- **Documentstatus onaangeraakt.** Een geboekte en daarna tegengeboekte factuur blijft historisch geboekt: geen statuswijziging, geen marker weggehaald, geen goedkeuring heropend.
- **Tijdelijke shim:** `ledger_reversal_postings` en `reverse_posting_group` staan nog niet in de gegenereerde types. De cast in `useLedgerReversal.ts` is smal en getypeerd (precies die twee aanroepen, echte parameter- en resultaattypes, geen brede `any`) en kan weg zodra `types.ts` opnieuw is gegenereerd.
- **`LEDGER_SOURCE_LABELS` bewust niet aangepast.** `reversal` ontbreekt daar nog, maar `ledger-reporting.ts` is byte-voor-byte bevroren door `financial-statements-ui-polish.test.tsx` (15) en `resolveLedgerSource("reversal", …)` is gepind door `ledger-reporting.test.ts` (27). Dat aanpassen zou drie testbestanden buiten deze PR raken. De schermen van deze fase gebruiken daarom `reversalAwareSourceLabel()`, dat uitsluitend de ontbrekende fallback invult en voor elke bekende bronsoort de centrale kaart volgt. Opruimen hoort bij een PR die die kaart zelf bijwerkt.
- **Tests:** `src/test/ledger-reversal-ui.test.tsx` (43: de actie verschijnt alleen waar zij mag — ondersteund, niet-ondersteund, al tegengeboekt —, de oorspronkelijke regels staan er onveranderd, de bevestiging noemt dat expliciet, de datum is verplicht, een te lange toelichting blokkeert, de RPC krijgt exact drie waarden en geen bedrag, er wordt nergens geschreven, de claim wordt opnieuw opgehaald en de nieuwe boekingsgroep gemeld, dubbelklik vuurt één keer, vijf serverfouten worden begrijpelijk en zonder tenantdetail gemeld, plus de pure laag en de scopegrenzen). Twee bestaande testbestanden kregen de twee nieuwe props mee (testinfrastructuur; geen assertie gewijzigd), en twee scope-asserties van PR 1 zijn vervangen door hun invariant: geen **bestaande** migratie wordt gewijzigd, en geen gewijzigd bestand krijgt een schrijfpad naar het grootboek.

Verificatiequery (achteraf):
```sql
select to_regclass('public.ledger_reversal_postings') as marker,
       (select count(*) from pg_proc
         where proname in ('reverse_posting_group','enforce_reversal_source_claim')) as routines,
       (select count(*) from pg_trigger
         where tgname = 'validate_reversal_source_claim_trigger') as claimtrigger;
```

---

### Directe bankboeking — correctieve verharding

De zevende schrijver, `public.post_bank_transaction(uuid)`, is toegevoegd en toegepast met migratie `20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql` (commit 63f920c). Die boekt één handmatig gecodeerde bankregel rechtstreeks in het grootboek — netto op de gekozen rekening, BTW apart, bank aan de andere kant — en claimt haar in `public.bank_transaction_postings`, waarvan de primary key op `bank_transaction_id` de idempotentiegarantie is. **Dat bestand is toegepast en wordt nooit meer gewijzigd.**

Correctieve migratie:
```
supabase/migrations/20260921140000_harden_bank_transaction_posting.sql
```

**Status: ⏳ Nog niet toegepast.** Toepassen via de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`, ná review. De leescontroles vooraf en de postcheck staan in de header van het bestand.

Drie dingen, additief, zonder één cijfer aan de boekhouding te veranderen:

- **Markerrechten.** De marker kreeg `GRANT ALL ... TO service_role`. Een rol die de claim zelf mag schrijven kan er een verzinnen (en zo een legitieme boeking voor altijd blokkeren) of er een verwijderen (en zo een dubbele boeking mogelijk maken). Nu, net als bij alle zes de andere markertabellen: `REVOKE ALL` van `anon`, `authenticated` en `service_role`, gevolgd door `GRANT SELECT` aan `authenticated` en `service_role`. Geen enkele applicatierol schrijft nog in de marker.
- **Functierechten.** Er stond alleen `REVOKE ALL ... FROM PUBLIC`; een grant die een platformdefault rechtstreeks aan `anon` of `service_role` geeft, overleeft dat. Elke applicatierol wordt nu expliciet genoemd, en alleen `authenticated` krijgt EXECUTE terug. De REVOKE/GRANT staan zowel vóór als ná de `CREATE OR REPLACE`, omdat die de bestaande ACL behoudt.
- **Tenant-orakel.** De schrijver onderscheidde een onbekende banktransactie (`P0002`, "niet gevonden") van die van een andere organisatie (`42501`, "Geen rechten…"). Omdat de functie `SECURITY DEFINER` is en dus rijen ziet die RLS verbergt, was dat verschil een cross-tenant existence leak. Nu geldt één poort in twee drempels: **leesdrempel** — bestaat de rij niet, óf heeft de aanroeper geen `read_only` op haar organisatie, dan is het antwoord exact `42501 | Banktransactie niet beschikbaar`, in beide gevallen identiek; **schrijfdrempel** — wie die drempel haalt mag de rij onder RLS toch al lezen, dus dat er `assistant` nodig is mag eerlijk worden gezegd. Pas ná beide drempels volgt élke inhoudelijke melding.

**Ongewijzigd:** debet/credit en de richting bij inkomend/uitgaand geld, de BTW-splitsing en de vrijstellingsregel, de keuze van bank-, tegen- en BTW-rekening, de afgesloten-boekjaarregel, de rolvloer `assistant`, `source_type = 'bank_transaction'`, de markeridentiteit, de claimtrigger, de bevriezing van een geboekte bankregel, de directe-schrijfdeurgrens en de UI. `SELECT ... FOR UPDATE` staat op exact dezelfde plek, zodat het gelijktijdigheidsgedrag letterlijk hetzelfde blijft; alleen de meldingen die erop volgen zijn veranderd.

**Bewijs:** `supabase/tests/bank-transaction-posting/` (`run-proof.sh`, **53 bewijzen** tegen een echte PostgreSQL) — de exacte regels bij uitgaand en inkomend geld zonder BTW en bij 9% en 21%, de afronding op de cent (100,00 bruto bij 21% → 82,64 + 17,36), de onaangeroerde banktransactie, marker en grootboekregels die bij elkaar horen, een geforceerde mislukking ná de marker die alles terugdraait, dubbel boeken geweigerd, twee gelijktijdige sessies met precies één winnaar, de tenantpoort met de **volledige foutidentiteit** naast elkaar gelegd (SQLSTATE én boodschap), de markertabel onschrijfbaar voor `authenticated` én `service_role`, de EXECUTE-rechten, en de nog steeds gesloten directe schrijfdeur naar `ledger_postings`. Plus `src/test/bank-transaction-posting-hardening.test.ts` (15 statische asserties, waaronder dat alles ná de poort regel voor regel gelijk is aan de toegepaste versie en dat geen bestaande migratie wordt gewijzigd).

---

### Bank-inhaalslag — PR 1 (backend: preflight en bulkorkestratie)

Migratiebestand:
```
supabase/migrations/20260922120000_add_bank_bulk_posting.sql
```

**Status: ⏳ Nog niet toegepast.** Toepassen via de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`, ná review. De leescontroles vooraf en de postcheck staan in de header van het bestand.

Een administratie kan honderden historische bankregels hebben die handmatig gecodeerd zijn en nog geboekt moeten worden. Deze PR maakt dat mogelijk **zonder een tweede boekhoudmotor**: er blijft precies één schrijver, `public.post_bank_transaction(uuid)`, en de bulklaag doet niets anders dan bepalen wélke id's worden aangeboden en die schrijver per regel aanroepen. Generiek voor élke administratie; er staat geen klantnaam, geen klant-id en geen rekeningnummer in de code. **Geen UI in deze PR** — de shadcn-inhaalpagina is de volgende.

- **Preflight, alleen lezen.** `public.bank_bulk_posting_candidates(_client_id uuid, _boekjaar integer DEFAULT NULL)` geeft per bankregel datum, bedrag, omschrijving, tegenrekening, status, gekozen grootboekrekening, BTW-percentage, of er een marker is, of er een aflettering is, de boekingsgroep, de **werkstroomtoestand** (`posted` / `ready` / `review_needed` / `blocked`) en een leesbare reden. `_boekjaar = NULL` is "alle jaren"; het filter is halfopen (`>= 1 jan`, `< 1 jan volgend jaar`), gelijk aan de rest van het product.
- **Werkstroom is geen acceptatiemotor.** Er wordt uitsluitend geclassificeerd op wat persistent en eenduidig vastligt: de marker, de aflettering, `match_status`, de aanwezige grootboekrekening, een bedrag van nul, de ingestelde bank- en BTW-rekening en het afgesloten boekjaar. Wat driftrisico oplevert — de BTW-splitsing, de afronding, de richting, `posting_account_ok()` — wordt **niet** nagerekend. Zegt de preflight `ready` en weigert de schrijver alsnog, dan heeft de schrijver gelijk en blijft de regel ongeboekt. Er wordt niets afgeleid uit een omschrijving, een tegenrekening of een rekeningnummer.
- **Autorisatie = RLS.** Beide functies zijn `SECURITY INVOKER`. De preflight leest `bank_transactions` onder `role_bank_transactions_select` (read_only, organisatiebreed), dus een administratie van een andere organisatie levert exact hetzelfde op als een administratie die niet bestaat: nul rijen. Er is geen aparte poort geschreven en dus ook geen poort die anders kan gaan antwoorden dan RLS.
- **Bulk.** `public.post_bank_transactions_bulk(_transaction_ids uuid[])` geeft per **unieke** id één rij terug: `ordinal` (de positie van het eerste voorkomen in de invoer), `transaction_id`, `outcome` (`posted` / `already_posted` / `rejected`), `posting_group_id`, `error_code` en een veilige `message`. De rijen komen in invoervolgorde, niet in id-volgorde. Een dubbele id wordt één keer aangeboden.
- **Gedeeltelijke mislukking is de normale uitkomst.** Elke regel draait in een eigen PL/pgSQL-subtransactie: één weigering draait uitsluitend díe regel terug — geen marker, geen grootboekregel — en laat de reeds geboekte broers en zussen staan. Daarbij hoort één subtiliteit die anders stilletjes misgaat: de groepsbalanscontrole van de fundering is `DEFERRABLE INITIALLY DEFERRED` en zou pas bij COMMIT van de buitenste transactie afgaan, en dan de hele partij opblazen in plaats van die ene regel. Na elke geslaagde regel worden de uitgestelde controles daarom binnen de subtransactie afgedwongen (`SET CONSTRAINTS ALL IMMEDIATE`) en daarna weer uitgesteld. In de praktijk schrijft de schrijver altijd een sluitende groep; dit maakt de isolatie echt in plaats van op papier.
- **Geen stille herkansing.** Een geweigerde regel wordt niet opnieuw geprobeerd, in geen enkele vorm. Bewezen met een teller die een terugdraaiing overleeft: na een kunstmatige mislukking ná de claim staat die teller op precies 1.
- **`23505` is een eindtoestand, geen storing** — maar wordt alleen `already_posted` genoemd wanneer de marker daarna ook werkelijk zichtbaar is voor déze aanroeper (onder RLS). Een andere mislukking wordt nooit als succes verkocht, en omgekeerd wordt `posted` pas gemeld nadat de claim is teruggelezen en dezelfde boekingsgroep noemt.
- **Tenantprivacy blijft van de schrijver.** Een vreemde en een niet-bestaande id leveren een letterlijk identieke resultaatrij op: `rejected | 42501 | Banktransactie niet beschikbaar`. Alleen de eigen woordenschat van de schrijver (`28000`, `42501`, `22023`, `23514`, `23505`, `P0002`) gaat ongeschonden naar buiten; alles daarbuiten wordt neutraal gemeld, zodat een interne fout geen details kan lekken.
- **Bovengrens 500**, op de ruwe lijst en niet op het aantal unieke id's — een array van 100.000 keer dezelfde id is evengoed een verzoek dat niet gedaan hoort te worden. Een inhaalslag van enkele honderden regels blijft er ruim onder en gaat in één browserverzoek; daarboven biedt de frontend opeenvolgende partijen aan, elke id precies één keer. Een lege lijst, een `NULL`-lijst en een lege waarde tússen de id's worden geweigerd vóór er iets geboekt is.
- **Rechten.** Beide functies: `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` gevolgd door `GRANT EXECUTE TO authenticated`. `service_role` krijgt bewust geen EXECUTE.
- **Applicatielaag, bewust smal.** `src/lib/bank-bulk-posting.ts` (puur: tellen, `ready`-id's, partijen knippen, foutvertaling — geen enkel bedrag, geen BTW, geen rekening) en `src/hooks/useBankBulkPosting.ts` (de twee aanroepen plus invalidaties, ook ná een fout). Het deploy-venster levert `null` en nooit "niets te doen". Tijdelijke smalle, getypeerde shim op beide RPC's; weg zodra `types.ts` opnieuw is gegenereerd (patterns §11).
- **Tests:** `src/test/bank-bulk-posting.test.ts` (33: geen schrijfpad naar het grootboek of de marker, geen herhaalde BTW-formule, geen debet/credit, geen rekeningnummer of klantnaam, de bovengrens op één getal in migratie én frontend, de bewaking vóór de eerste boeking, de subtransactie mét `SET CONSTRAINTS`, dedup en volgorde, de 23505-regel, plus de pure laag en de branchgrenzen) en een echt-PostgreSQL-bewijs onder `supabase/tests/bank-bulk-posting/` (`run-proof.sh`, **80 bewijzen**, waaronder: de regels uit de bulk letterlijk gelijk aan die van een enkelvoudige boeking, geldig–ongeldig–geldig met twee overlevende buren, de geweigerde regel zonder spoor, dubbele id's, een herhaalde partij, de vier gelijktijdigheidsscenario's met twee echte sessies, de identieke foutidentiteit van een vreemde en een onbekende id, de onschrijfbare marker, de gesloten schrijfdeur naar `ledger_postings`, de EXECUTE-rechten, de bovengrens, de lege partij, en de teller die bewijst dat er geen tweede poging wordt gedaan). Het bewijs is bewust geen onderdeel van `npm run test`: CI heeft geen PostgreSQL.

**Bewust buiten deze PR:** de DataTable/UI, AI-classificatie, automatische rekening- of BTW-keuze, een regelmotor, OCR/import, en bulk-statuswijzigingen. Er wordt geen enkele `match_status` gewijzigd.

#### PR 2 — de inhaalslag-UI

De applicatielaag op de toegepaste backend. **Geen migratie, geen SQL, geen RLS, geen RPC-wijziging, geen handmatige typewijziging, geen afhankelijkheid en geen nieuw nav-item.**

```
src/pages/BankInhaalslag.tsx                        route /bank/inhaalslag
src/components/bank/BankBulkCandidateSheet.tsx      het auditpaneel per bankregel
```

- **Route onder het bestaande werkgebied.** `/bank/inhaalslag`; `isNavItemActive` lost élk `/bank/*`-pad al op naar het bestaande "Bank"-item, dus de koptitel en het kruimelpad werken vanzelf en `nav.ts` is onaangeroerd. Het scherm is bereikbaar via één knop ("Inhaalslag grootboek") in de bestaande bankwerkbalk — dezelfde opzet als `/grootboek/memoriaal` en `/grootboek/historisch`. In `Bank.tsx` (3057 regels) is bewust niets anders aangeraakt dan die knop en de router-import.
- **Twee aanroepen, meer niet:** `useBankBulkCandidates()` leest, `usePostBankTransactionsBulk()` schrijft. De pagina praat niet rechtstreeks met de databaseclient, kent `ledger_postings` en `bank_transaction_postings` niet, en roept `post_bank_transaction()` nergens aan.
- **De servertoestand is de enige status.** `ready`/`review_needed`/`blocked`/`posted` komen ongewijzigd binnen en krijgen alleen een Nederlands label (Gereed / Controle nodig / Geblokkeerd / Geboekt). Er wordt geen tweede werkstroomstatus berekend, geen BTW gesplitst, geen debet/credit bepaald, geen rekening afgeleid en geen afgesloten boekjaar beoordeeld.
- **Selectie is fail-closed.** Alleen `ready` is aanvinkbaar; `review_needed`, `blocked` en `posted` hebben een uitgeschakeld vinkje maar blijven volledig inspecteerbaar. `review_needed` meesturen zou suggereren dat zo'n regel geldig is terwijl de server juist zegt dat er nog iets aan moet gebeuren. `submittableIds()` is bovendien de laatste zeef vóór de RPC: ook een id dat langs een andere weg in de selectie belandt, gaat niet mee.
- **Bulkbalk** met werkelijke tellingen uit de geladen servergegevens (`selectionBreakdown()`), "zichtbare gereed selecteren" en "selectie wissen". Een vinkje boekt nooit iets; boeken kan alleen via de `AlertDialog`, die het aantal noemt en uitlegt dat elke regel opnieuw door de database wordt gevalideerd, dat een weigering de geslaagde regels niet terugdraait en dat een al geboekte regel nooit een tweede keer wordt geboekt.
- **Het resultaat is per uitkomst uitgesplitst** — geboekt / al geboekt / geweigerd — met per geweigerde regel de veilige servermelding en een schakelaar "Alleen geweigerde tonen". Nooit alleen een generieke succesmelding. Na afloop wordt opnieuw opgehaald en de selectie naast de verse gegevens gelegd (`reconcileSelection()`), zodat geboekte regels er vanzelf uit vallen.
- **Een afgebroken reeks partijen liegt niet, en gokt evenmin.** Boven `BANK_BULK_MAX_BATCH` knipt de hook de lijst. Faalt er één verzoek, dan vallen de id's uiteen in **drie** groepen, die `BankBulkPartialError` los van elkaar draagt: `results` (eerdere, voltooide partijen — vastgesteld feit), `outcomeUnknown` (de partij waarvan het verzoek mislukte; die is verstuurd, dus een transportfout ná een commit is niet te onderscheiden van een echte mislukking) en `notSubmitted` (uitsluitend de partijen daarná, die nooit de deur uit zijn geweest). Bij 500/500/200 met een fout op de tweede partij is dat dus 500 bevestigd, 500 onbekend, 200 niet aangeboden — nooit 700 "niet aangeboden". De indeling staat als pure `partialErrorForChunk()` in de rekenlaag, zodat zij toetsbaar is en niet alleen in de hook leeft. Het scherm benoemt de drie apart, dicht de onbekende partij geen uitkomst toe en vraagt eerst te verversen. De schrijver is idempotent, dus een bewuste tweede poging is veilig — maar automatisch opnieuw proberen gebeurt nergens.
- **`candidates === null` is het deploy-venster**, niet een lege lijst: het scherm zegt dat bulkboeken nog niet beschikbaar is en toont nooit "Geen bankregels". Leeg, fout en ladend zijn alle drie apart afgehandeld (`EmptyState`, `Alert`, `Skeleton`).
- **Auditpaneel (`Sheet`)** met kop (status, datum, bedrag), bron (omschrijving, tegenrekening), vastgelegde codering (rekening, BTW-percentage), het oordeel van de server (toestand, reden, al geboekt, afgeletterd) en — in een `Collapsible`, visueel ondergeschikt — transactie-id, boekingsgroep en ruwe status. **Geen berekende tegenboeking**: het paneel bevat geen enkele regeltabel.
- **Responsief en toegankelijk:** datum, bedrag en status blijven op elk formaat staan, grootboekrekening en BTW wijken naar het paneel, bedragen zijn rechts uitgelijnd in `font-mono tabular-nums`, de bulkbalk staat vast onderaan en blijft dus op een telefoon bereikbaar, knoppen zijn minstens 44px hoog, elk selectievakje heeft een eigen `aria-label` en status staat nooit alleen in een kleur (label + `data-state-label`).
- **Tests:** `src/test/bank-bulk-catchup-ui.test.tsx` (35: selectieregels voor alle vier de toestanden, badges uit `workflow_state`, geen BTW- of debet/creditlogica in de gewijzigde bestanden, geen schrijfpad naar grootboek of marker, de dialoog met het echte aantal, de RPC die uitsluitend id's krijgt, de drie uitkomsten apart, de veilige weigeringsmelding, de verzoende selectie, de afgebroken partijreeks, deploy-venster ≠ leeg ≠ fout, de filters, de toegankelijkheid, en de branchgrenzen).

---

### Rapportagetaxonomie — het tweede niveau (`report_subgroup`)

Migratiebestand:
```
supabase/migrations/20260923120000_add_report_subgroup.sql
```

**Status: ⏳ Nog niet toegepast.** Toepassen via de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`, ná review. De leescontroles vooraf en de postcheck staan in de header van het bestand.

De vraag was één expliciet, herbruikbaar classificatiemodel voor Balans en W&V, zonder afleiding uit rekeningnummers of -namen. Het onderzoek vooraf liet zien dat de helft er al stond: `report_group` (Balans/W&V PR 1, toegepast) kent zeven balanswaarden die **exact** de zeven gevraagde balanscategorieën zijn. Wat ontbrak was een **tweede niveau** — "Liquide middelen", "Voorraden", "Handelsdebiteuren" bestonden nergens.

- **Eén additieve, nullable kolom.** `report_group` behoudt haar betekenis en haar vijftien waarden en is voortaan de **Categorie**; `report_subgroup` is de **Groep** daarbinnen. Twee nieuwe CHECKs: het waardendomein, en het paar (een groep hoort bij precies één categorie). Beide slagen op NULL.
- **Geen bestaande classificatie verandert.** Een rekening die iemand op `vlottende_activa` heeft gezet, houdt die waarde en krijgt `report_subgroup = NULL` — "categorie gekozen, groep nog niet", een geldige en normale toestand. Er wordt geen rij gelezen, herschreven, geraden of omgezet, en er is geen combinatie die door deze migratie ongeldig kan worden. Geen backfill, geen lookup-tabel, geen normalisatieproject.
- **Bewuste afwijking van de letterlijke opdracht.** De gevraagde W&V-indeling zet `Huisvestingskosten`, `Verkoopkosten`, `Autokosten` en `Kantoorkosten` op het hoogste niveau; in het bestaande domein zijn dat onderdelen van `overige_bedrijfskosten`. Promoveren zou het vijftien-waardendomein wijzigen en daarmee opgeslagen classificaties én de statement-engine (PR 3) ongeldig maken. Ze staan daarom als subgroepen, met die vier namen als **tussenkopjes in het formulier**, zodat de gevraagde hiërarchie wel zichtbaar is. `Resultaat na belasting` is bewust géén subgroep: dat is geen rekening maar een presentatieregel die de engine al synthetisch berekent.
- **Niets wordt afgeleid.** Geen rekeningnummer, geen naamfragment, geen `categorie`, geen nummerreeks, geen RGS. `1100` komt in geen enkel bestand van deze fase voor. Een classificatie ontstaat uitsluitend doordat iemand haar invult.
- **Normale zijde blijft metadata.** `defaultNormalSideFor()` levert een **voorstel** dat alleen een leeg veld invult en een gemaakte keuze nooit overschrijft. Privé is de uitzondering die het waard is apart te noemen: opnamen debet, stortingen credit, binnen één categorie. W&V krijgt geen voorstel — baten en lasten lopen per groep beide kanten op. De zijde raakt geen boeking en geen saldo: die komen uit `ledger_postings`.
- **Opgeslagen waarden die deze versie niet kent worden gemeld, niet hersteld.** `classificationConflicts()` benoemt zes gevallen (onbekend rapport, onbekende categorie, categorie buiten rapport, onbekende groep, groep buiten categorie, groep zonder categorie); het overzicht toont "Controle nodig" met de reden. Het formulier biedt zo'n waarde niet opnieuw aan, zodat niemand haar per ongeluk opnieuw opslaat — maar in de database blijft zij staan tot iemand bewust ingrijpt.
- **UI:** in de bestaande sectie "Rapportageclassificatie" heet de eerste keuze nu **Rapportagecategorie** (niet "Categorie": dat label is al bezet door het bestaande `categorie`-veld en twee gelijknamige velden zijn slecht voor toetsenbord en schermlezer) en komt daaronder **Groep**, die uitsluitend de groepen van de gekozen categorie toont. Een combinatie als `Vlottende activa` + `Loonheffingen` is daarmee niet aan te wijzen, wordt door de validatie geweigerd én zou door `buildClassificationPayload()` alsnog als `null` worden verstuurd. De groep is optioneel.
- **Tests:** `src/test/reporting-taxonomy.test.ts` (26: Liquide middelen wél onder Vlottende activa en niet onder Vaste activa, de niet-passende combinatie langs drie wegen geweigerd, balans- en W&V-groepen nooit vermengd, elke subgroep bij precies één categorie, de TypeScript-kaart letterlijk naast de CHECK in de migratie gelegd, de bestaande classificatie die ongewijzigd doorkomt, geen nummer- of naamafleiding, de zijde als voorstel dat niets overschrijft, en het volledige voorbeeld Vlottende activa → Liquide middelen → Debet). `reporting-classification-ui.test.tsx` en `grootboek-chart-of-accounts.test.tsx` kregen het nieuwe veld in hun payload-asserties en de nieuwe labelnamen; twee statische bewakers zijn versmald van het WOORD naar de VELDTOEGANG, omdat de taxonomie sinds deze PR zelf een niveau heeft dat "Categorie" heet en dat woord dus legitiem in zichtbare teksten voorkomt.

---

## Emergency rule

> **If the project ref is unclear, stop. Do not run SQL.**
> Open the Lovable Cloud SQL editor and confirm the project ref is `alxlbdhpbwlehbdbfejw` before proceeding.
