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

**Migration:** `supabase/migrations/20260920120000_add_reporting_classification.sql` — **⏳ NOT YET applied to production** (`alxlbdhpbwlehbdbfejw`). To be applied manually through the Lovable Cloud SQL editor after verifying the project ref; the generated `src/integrations/supabase/types.ts` is regenerated from the production schema *after* that, not in this PR. Independent of 6C-b8 (it only touches `public.grootboekrekeningen`, created 20260412). Stamped `20260920120000` — the next day-granular noon stamp after `20260919120000`, following the chain's convention — so repository history stays in order (the CLI's real-time stamp would have sorted before an already-applied migration; renamed before merge). **Apply it through the Lovable Cloud SQL editor**, as every migration in this chain; the remote `schema_migrations` history does not track the hand-applied migrations, so `supabase db push` is not a usable path in this repository.

Schema only — **no Balans, no W&V, no classification UI, no report engine, no backfill, no comparatives, no year-end closing, no RGS, no automatic classification.** The read-only research that preceded it established that `grootboekrekeningen.categorie` is free `TEXT` (default `'kosten'`, no CHECK/enum/FK) in which `passiva` mixes equity, liabilities, VAT, suspense and result accounts, `activa` mixes fixed and current assets and `kosten` mixes cost of sales, depreciation, financial and operating expense — so `categorie` cannot be the authoritative statement classification.

- **Four additive, nullable columns on `public.grootboekrekeningen`, no defaults:** `statement_type text` (`balans` | `winst_verlies`), `report_group text` (balans: `vaste_activa`, `vlottende_activa`, `eigen_vermogen`, `voorzieningen`, `langlopende_schulden`, `kortlopende_schulden`, `prive`; winst_verlies: `netto_omzet`, `kostprijs_omzet`, `personeelskosten`, `afschrijvingen`, `overige_bedrijfskosten`, `financiele_baten_lasten`, `belastingen`, `overig_resultaat`), `normal_side text` (`debet` | `credit`, presentation side only), `report_sort integer` (≥ 0).
- **Five named CHECK constraints:** `grootboekrekeningen_statement_type_check`, `grootboekrekeningen_report_group_check` (the fifteen-value domain), `grootboekrekeningen_reporting_pair_check` (both NULL, or `balans` + a balans group, or `winst_verlies` + a winst_verlies group), `grootboekrekeningen_normal_side_check`, `grootboekrekeningen_report_sort_check`. The pair check is a `CASE` on `statement_type` with `IS NOT NULL` guards: a CHECK passes when its expression is NULL, and the naive `OR` form accepted NULL + group and `balans` + NULL group on a real cluster; the proof asserts every refused case evaluates to exactly FALSE. **Owner decision, recorded (independent review P2-2):** the pair check reads rules C/D strictly — a `statement_type` without a `report_group` is refused, so "classified" is never half a statement (the requirement relaxes `normal_side` explicitly and `report_group` not at all). The lenient form is a one-line change per branch and is written out in the migration header. `normal_side` and `report_sort` are independent and never forced, even on a classified account; whether the engine requires them is decided in the UI/engine phase.
- **Existing rows stay valid immediately:** every constraint accepts NULL and every existing row has NULL in all four columns. **No backfill**, no UPDATE/INSERT/DELETE, no account-number ranges, no derivation from `categorie`/`omschrijving`/seed position. `categorie` is untouched: not read, not rewritten, not constrained, default unchanged; seed and Grootboek UI unchanged. No trigger, function, policy, grant or index; the existing role policies (accountant INSERT/UPDATE, read_only SELECT) already cover the new columns. `ADD COLUMN` of a nullable column without default is catalog-only (no rewrite); each constraint is added only when absent, so the file is idempotent.
- **Classification is not authoritative until it has been filled in.** Until then every account is "niet geclassificeerd" and the future statement engine must treat it as such. The classification UI and the Balans/W&V engine follow in later PRs, after the migration has been applied and the types regenerated.
- **Rollback (documented in the file, not executed):** drop the five constraints, then the four columns. This loses any classification values entered since application; with no UI and no production application yet, the risk is currently low.
- **Tests:** `src/test/reporting-classification-schema.test.ts` (structural, comments stripped: the four columns, nullability, no default, the exact value sets per constraint, the pair check's three branches and nothing else, no UPDATE/DELETE/INSERT/COPY, no `categorie`, no policy/grant/trigger/function/index/DROP/ALTER COLUMN, only `public.grootboekrekeningen`, no numbers except `>= 0`, no project refs, rollback order and loss statement, exactly one migration and no `src/` / seed / types / package change on the branch — skipped rather than vacuous without `origin/main`) plus a real-PostgreSQL proof under `supabase/tests/reporting-classification/` (`run-proof.sh`: bootstrap double with the role ladder, `has_min_role()` and `prevent_org_user_rebind()` copied verbatim → the real 20260412222343 → every later production change on the table replayed as the exact repository statements (nullable `client_id`, `UNIQUE (nummer)`, `organization_id` + index, the four `role_grootboekrekeningen_*` policies and the rebind trigger from 20260613001452 §3A.11) → "existing" rows incl. free-text `categorie` → the migration **twice** → **70 proofs**: unchanged `relfilenode`, rows byte-identical, all new columns NULL, `categorie` value/default/freedom untouched, no trigger/index/policy/function added, exactly +4 columns and +5 constraints after the second application, the six valid and six invalid examples plus `balans` without group, `'foo'` group, case variant, update paths, each constraint's catalog expression evaluated in isolation to exactly TRUE/FALSE (never NULL), the production policies for real — `accountant` may insert/update the columns, `read_only` may only read them, a foreign organisation is refused — and the pre-existing rows still identical after every probe). Not part of `npm run test`: CI has no PostgreSQL; the proof creates and drops a throwaway database and must never be pointed at a BoekAssist database.
- **Deviation from the expected file list, deliberate:** the PR 2 and PR 3 branch-scope tests (`opening-balance-ui-scope.test.ts` 54, `opening-balance-reporting.test.tsx` 25/26/27/33/34) asserted "no `supabase/` change in this branch" — a scope statement of those PRs, not an invariant, which any later migration branch trips. They now assert what they were protecting: the beginbalans/ledger migrations and proof are untouched and no added SQL references `opening_balance`, `ledger_postings` or `journal_entries`.

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

---

## Emergency rule

> **If the project ref is unclear, stop. Do not run SQL.**
> Open the Lovable Cloud SQL editor and confirm the project ref is `alxlbdhpbwlehbdbfejw` before proceeding.
