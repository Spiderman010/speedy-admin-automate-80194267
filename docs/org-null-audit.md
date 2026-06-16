# NULL `organization_id` Audit — BoekAssist

**Type:** Read-only diagnostic document  
**Branch:** `feature/org-null-readonly-audit`  
**Database:** `alxlbdhpbwlehbdbfejw` (Lovable Cloud, confirmed via `sb-project-ref` header)  
**How to run SQL:** Lovable Cloud SQL editor only — NOT the personal Supabase dashboard  
**SQL safety:** Every query in this document is SELECT-only. No mutations.

---

## Background

The nulmeting identified two high-risk findings that must be assessed before any schema change:

- **R-01** — `set_organization_id()` trigger can silently leave `organization_id = NULL`  
- **R-03** — `bank_transaction_allocations` with NULL `organization_id` become invisible under RBAC, causing wrong `remaining_amount` calculations

This document maps the exact failure paths and provides SQL to measure the current exposure.

---

## How `organization_id` Gets Set (and How It Silently Fails)

### Trigger: `set_organization_id()` — migration `20260531223619`

The function runs as `BEFORE INSERT` on all 13 domain tables via two triggers (see note below). Logic:

```
Step 1: if NEW.client_id IS NOT NULL
          → inherit from clients.organization_id
          (if client's org is also NULL, this returns NULL)
Step 2: if still NULL and NEW.user_id IS NOT NULL
          → read profiles.default_organization_id
          (if profile row missing or default is NULL, returns NULL)
Step 3: if still NULL and NEW.user_id IS NOT NULL
          → count organization_members for this user
          → only if count = 1: use that organization_id
          (if user has 0 or 2+ orgs, stays NULL)

Result: NEW.organization_id := v_org_id;   ← CAN BE NULL, no exception raised
```

**Silent failure conditions (R-01):**

| Condition | Result |
|---|---|
| `client_id` NULL or client's `organization_id` NULL | Step 1 returns NULL |
| No profile row, or `default_organization_id` NULL | Step 2 returns NULL |
| User has 0 orgs | Step 3 skipped (member_count = 0 ≠ 1) |
| User has 2+ orgs and no profile default | Step 3 skipped (member_count ≠ 1) |
| All three steps fail | Row inserted with `organization_id = NULL`, no error |

### Trigger name duplication note

Two separate BEFORE INSERT triggers call this same function on every domain table:

| Trigger name | Created by migration |
|---|---|
| `trg_set_org_id` | `20260531223619` |
| `set_organization_id_trigger` | `20260603230656` |

PostgreSQL fires BEFORE triggers in alphabetical order: `set_organization_id_trigger` → `trg_set_org_id`. The second trigger always finds `organization_id IS NOT NULL` and exits immediately (idempotency check at line 1 of the function). Functionally harmless but fires twice per insert.

### RLS consequence when `organization_id IS NULL` (R-03)

All 12 RBAC-gated tables use this policy pattern:

```sql
USING (public.has_min_role(auth.uid(), organization_id, 'read_only'))
```

`has_min_role` queries `ur.organization_id = _organization_id`. When `_organization_id` is NULL, PostgreSQL evaluates `ur.organization_id = NULL` which is always `UNKNOWN` (never TRUE). The EXISTS(...) returns FALSE. **The row is invisible to all users including the owner.** The row is not deleted; it exists but cannot be read, updated, or deleted through the API.

---

## Table Inventory

| Table | `organization_id`? | `client_id`? | client_id nullable? | Trigger derives from | Highest risk |
|---|---|---|---|---|---|
| `clients` | YES (nullable) | — | n/a | profile/sole-member only | **HIGH** — root of cascade |
| `sales_invoices` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `purchase_invoices` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `purchase_invoice_lines` | YES (nullable) | **NO** | n/a | parent invoice → profile → sole | **HIGH** — no direct client path |
| `bank_transactions` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `bank_transaction_allocations` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | **HIGH** — R-03: invisible = broken balances |
| `vraagposten` | YES (nullable) | YES (**nullable**) | yes | client? → profile → sole | **HIGH** — client_id optional |
| `leveranciers` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `grootboekrekeningen` | YES (nullable) | YES (**nullable**) | yes | client? → profile → sole | HIGH — shared across org |
| `ledger_accounts` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `journal_entries` | YES (nullable) | YES (NOT NULL) | no | client → profile → sole | MEDIUM |
| `booking_templates` | YES (nullable) | YES (**nullable**) | yes | client? → profile → sole | HIGH — shared templates |
| `app_settings` | YES (nullable) | **NO** | n/a | profile → sole only | LOW — per-user semantics |

**`purchase_invoice_lines` special case:** The trigger's step 1 uses `NEW.client_id`, but `purchase_invoice_lines` has no `client_id` column — the trigger's `EXCEPTION WHEN undefined_column` block silently catches this and sets `v_client_id := NULL`. The backfill in `20260531223619` step 5a correctly joins `purchase_invoice_lines → purchase_invoices.organization_id` instead. However, going forward, any insert of a line whose parent invoice has `organization_id = NULL` will also insert the line with `organization_id = NULL`.

**Backfill coverage gaps (migration `20260531223619`):**

| Gap | Explanation |
|---|---|
| `clients` itself not in 5b | The 5b loop omits `clients`. Clients without a derivable org (multi-org user, no profile default) stay NULL |
| Rows with NULL `client_id` and multi-org user | `vraagposten`, `grootboekrekeningen`, `booking_templates` rows where `client_id IS NULL` and user has 2+ orgs — sole-membership check fails |
| Child rows of a client with NULL `organization_id` | 5a joins `ON c.organization_id IS NOT NULL`, so these rows are skipped |

---

## SQL Audit Script

Run each block independently in the **Lovable Cloud SQL editor** for project `alxlbdhpbwlehbdbfejw`.  
All queries are `SELECT`-only.

### Block 1 — NULL counts per table

```sql
-- Block 1: NULL organization_id counts across all domain tables
-- Run in Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw
SELECT
  'clients'                    AS tbl, COUNT(*) AS total,
  COUNT(*) FILTER (WHERE organization_id IS NULL) AS null_org
FROM public.clients
UNION ALL
SELECT 'sales_invoices',           COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.sales_invoices
UNION ALL
SELECT 'purchase_invoices',        COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.purchase_invoices
UNION ALL
SELECT 'purchase_invoice_lines',   COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.purchase_invoice_lines
UNION ALL
SELECT 'bank_transactions',        COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.bank_transactions
UNION ALL
SELECT 'bank_transaction_allocations', COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.bank_transaction_allocations
UNION ALL
SELECT 'vraagposten',              COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.vraagposten
UNION ALL
SELECT 'leveranciers',             COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.leveranciers
UNION ALL
SELECT 'grootboekrekeningen',      COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.grootboekrekeningen
UNION ALL
SELECT 'ledger_accounts',          COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.ledger_accounts
UNION ALL
SELECT 'journal_entries',          COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.journal_entries
UNION ALL
SELECT 'booking_templates',        COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.booking_templates
UNION ALL
SELECT 'app_settings',             COUNT(*), COUNT(*) FILTER (WHERE organization_id IS NULL)
FROM public.app_settings
ORDER BY null_org DESC, tbl;
```

**Expected:** All `null_org` values are 0 if the backfill was complete. Any non-zero value requires follow-up with blocks 2–7.

---

### Block 2 — Clients with NULL organization_id (root of cascade)

```sql
-- Block 2: clients with NULL organization_id
-- These cascade: any child record (invoices, transactions, etc.) referencing
-- one of these clients will also have organization_id = NULL after trigger.
SELECT
  c.id,
  c.name,
  c.user_id,
  c.created_at,
  -- Can org be derived from sole membership?
  (SELECT COUNT(*) FROM public.organization_members om WHERE om.user_id = c.user_id) AS member_count,
  (SELECT om.organization_id
   FROM public.organization_members om WHERE om.user_id = c.user_id LIMIT 1
  ) AS sole_org_candidate,
  -- Does user have a profile default?
  p.default_organization_id AS profile_default
FROM public.clients c
LEFT JOIN public.profiles p ON p.user_id = c.user_id
WHERE c.organization_id IS NULL
ORDER BY c.created_at;
```

**Interpretation:**
- `member_count = 1` → org can be safely derived; include in a future backfill migration
- `member_count = 0` → user has no org; this client is a true orphan (requires owner decision)
- `member_count > 1` → ambiguous; needs manual assignment

---

### Block 3 — Derivability scan for child tables with NULL organization_id

```sql
-- Block 3: child tables with NULL org — can it be derived from client chain?
WITH null_purchase_invoices AS (
  SELECT
    pi.id,
    pi.client_id,
    pi.user_id,
    c.organization_id AS client_org,
    (SELECT COUNT(*) FROM public.organization_members om WHERE om.user_id = pi.user_id) AS member_count
  FROM public.purchase_invoices pi
  LEFT JOIN public.clients c ON c.id = pi.client_id
  WHERE pi.organization_id IS NULL
),
null_sales_invoices AS (
  SELECT
    si.id,
    si.client_id,
    si.user_id,
    c.organization_id AS client_org,
    (SELECT COUNT(*) FROM public.organization_members om WHERE om.user_id = si.user_id) AS member_count
  FROM public.sales_invoices si
  LEFT JOIN public.clients c ON c.id = si.client_id
  WHERE si.organization_id IS NULL
),
null_bank_transactions AS (
  SELECT
    bt.id,
    bt.client_id,
    bt.user_id,
    c.organization_id AS client_org,
    (SELECT COUNT(*) FROM public.organization_members om WHERE om.user_id = bt.user_id) AS member_count
  FROM public.bank_transactions bt
  LEFT JOIN public.clients c ON c.id = bt.client_id
  WHERE bt.organization_id IS NULL
)
SELECT 'purchase_invoices' AS tbl,
  COUNT(*) AS null_count,
  COUNT(*) FILTER (WHERE client_org IS NOT NULL) AS derivable_from_client,
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count = 1) AS derivable_from_sole_member,
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count != 1) AS not_derivable
FROM null_purchase_invoices
UNION ALL
SELECT 'sales_invoices',
  COUNT(*),
  COUNT(*) FILTER (WHERE client_org IS NOT NULL),
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count = 1),
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count != 1)
FROM null_sales_invoices
UNION ALL
SELECT 'bank_transactions',
  COUNT(*),
  COUNT(*) FILTER (WHERE client_org IS NOT NULL),
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count = 1),
  COUNT(*) FILTER (WHERE client_org IS NULL AND member_count != 1)
FROM null_bank_transactions;
```

---

### Block 4 — purchase_invoice_lines: NULL org with parent invoice status

```sql
-- Block 4: purchase_invoice_lines with NULL org
-- These have no direct client_id; org must come from parent invoice.
SELECT
  pil.id AS line_id,
  pil.purchase_invoice_id,
  pi.organization_id AS parent_invoice_org,
  pi.client_id,
  c.organization_id AS client_org,
  CASE
    WHEN pi.organization_id IS NOT NULL THEN 'derivable_from_invoice'
    WHEN c.organization_id IS NOT NULL  THEN 'derivable_from_client_via_invoice'
    ELSE 'not_derivable'
  END AS resolution
FROM public.purchase_invoice_lines pil
LEFT JOIN public.purchase_invoices pi ON pi.id = pil.purchase_invoice_id
LEFT JOIN public.clients c ON c.id = pi.client_id
WHERE pil.organization_id IS NULL
ORDER BY resolution, pil.purchase_invoice_id;
```

---

### Block 5 — bank_transaction_allocations: R-03 risk

```sql
-- Block 5: bank_transaction_allocations with NULL organization_id (R-03)
-- These allocations are invisible under the RBAC RLS policy, meaning
-- remaining_amount on the linked invoice does NOT reflect their contribution.
SELECT
  bta.id AS allocation_id,
  bta.bank_transaction_id,
  bta.invoice_id,
  bta.invoice_type,
  bta.client_id,
  bta.amount,
  bta.created_at,
  c.organization_id AS client_org,
  bt.organization_id AS transaction_org,
  -- If client and transaction orgs agree and are not null, safe to derive
  CASE
    WHEN c.organization_id IS NOT NULL AND c.organization_id = bt.organization_id
      THEN 'derivable_consistent'
    WHEN c.organization_id IS NOT NULL AND bt.organization_id IS NULL
      THEN 'derivable_from_client_only'
    WHEN c.organization_id IS NULL AND bt.organization_id IS NOT NULL
      THEN 'derivable_from_transaction_only'
    WHEN c.organization_id IS NOT NULL AND bt.organization_id IS NOT NULL
         AND c.organization_id != bt.organization_id
      THEN 'CONFLICT_parent_orgs_differ'
    ELSE 'not_derivable'
  END AS resolution
FROM public.bank_transaction_allocations bta
LEFT JOIN public.clients c ON c.id = bta.client_id
LEFT JOIN public.bank_transactions bt ON bt.id = bta.bank_transaction_id
WHERE bta.organization_id IS NULL
ORDER BY resolution DESC, bta.created_at;
```

**Critical:** Any row in this result set is an invisible allocation. The linked invoice's `remaining_amount` is inflated by the `amount` value of each such row because the allocation is hidden from query results.

---

### Block 6 — Cross-table org consistency (parent vs child)

```sql
-- Block 6: parent/child org_id mismatches
-- Finds rows where the child's org does not match the parent's org.
-- A mismatch indicates data corruption from a trigger or backfill ordering problem.
SELECT
  'invoice_lines vs invoice' AS check_name,
  COUNT(*) FILTER (
    WHERE pi.organization_id IS NOT NULL
      AND pil.organization_id IS NOT NULL
      AND pil.organization_id != pi.organization_id
  ) AS org_mismatch_count,
  COUNT(*) AS total_rows
FROM public.purchase_invoice_lines pil
JOIN public.purchase_invoices pi ON pi.id = pil.purchase_invoice_id
UNION ALL
SELECT
  'bta vs bank_transaction' AS check_name,
  COUNT(*) FILTER (
    WHERE bt.organization_id IS NOT NULL
      AND bta.organization_id IS NOT NULL
      AND bta.organization_id != bt.organization_id
  ),
  COUNT(*)
FROM public.bank_transaction_allocations bta
JOIN public.bank_transactions bt ON bt.id = bta.bank_transaction_id
UNION ALL
SELECT
  'purchase_invoices vs client' AS check_name,
  COUNT(*) FILTER (
    WHERE c.organization_id IS NOT NULL
      AND pi.organization_id IS NOT NULL
      AND pi.organization_id != c.organization_id
  ),
  COUNT(*)
FROM public.purchase_invoices pi
JOIN public.clients c ON c.id = pi.client_id
UNION ALL
SELECT
  'sales_invoices vs client' AS check_name,
  COUNT(*) FILTER (
    WHERE c.organization_id IS NOT NULL
      AND si.organization_id IS NOT NULL
      AND si.organization_id != c.organization_id
  ),
  COUNT(*)
FROM public.sales_invoices si
JOIN public.clients c ON c.id = si.client_id
UNION ALL
SELECT
  'bank_transactions vs client' AS check_name,
  COUNT(*) FILTER (
    WHERE c.organization_id IS NOT NULL
      AND bt.organization_id IS NOT NULL
      AND bt.organization_id != c.organization_id
  ),
  COUNT(*)
FROM public.bank_transactions bt
JOIN public.clients c ON c.id = bt.client_id;
```

**Expected:** All `org_mismatch_count` = 0. Any non-zero value indicates the `prevent_org_user_rebind` trigger might not have been active during some updates, or a manual data edit occurred.

---

### Block 7 — Trigger presence verification

```sql
-- Block 7: confirm both triggers exist on all expected tables
SELECT
  event_object_table AS tbl,
  trigger_name,
  event_manipulation,
  action_timing
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN ('trg_set_org_id', 'set_organization_id_trigger', 'prevent_org_user_rebind_trg')
  AND event_object_table IN (
    'clients','sales_invoices','purchase_invoices','purchase_invoice_lines',
    'bank_transactions','bank_transaction_allocations','vraagposten','leveranciers',
    'grootboekrekeningen','ledger_accounts','journal_entries','booking_templates','app_settings'
  )
ORDER BY event_object_table, trigger_name;
```

**Expected:**
- `trg_set_org_id` AND `set_organization_id_trigger` on all 13 tables (BEFORE INSERT)
- `prevent_org_user_rebind_trg` on 12 tables (all except `app_settings`) (BEFORE UPDATE)

---

### Block 8 — Users with 2+ orgs who have data (most likely to produce NULL on new inserts)

```sql
-- Block 8: users with multiple org memberships who also own domain data
-- These users are most likely to produce NULL org_id on future inserts
-- if the trigger's profile-default step also fails.
SELECT
  om.user_id,
  COUNT(DISTINCT om.organization_id) AS org_count,
  p.default_organization_id IS NOT NULL AS has_profile_default,
  COUNT(DISTINCT c.id) AS client_count,
  COUNT(DISTINCT pi.id) AS purchase_invoice_count
FROM public.organization_members om
LEFT JOIN public.profiles p ON p.user_id = om.user_id
LEFT JOIN public.clients c ON c.user_id = om.user_id
LEFT JOIN public.purchase_invoices pi ON pi.user_id = om.user_id
GROUP BY om.user_id, p.default_organization_id
HAVING COUNT(DISTINCT om.organization_id) > 1
ORDER BY org_count DESC, client_count DESC;
```

**Interpretation:** Multi-org users without `has_profile_default = true` will produce NULL `organization_id` on any insert where `client_id` is also NULL (e.g., `grootboekrekeningen` without client, `app_settings`, `booking_templates` without client).

---

## Per-Table Risk Summary

| Table | Risk | Why |
|---|---|---|
| `clients` | **HIGH** | Root of cascade. NULL here propagates to all child inserts via trigger step 1. Not included in 5b backfill loop |
| `purchase_invoice_lines` | **HIGH** | No `client_id` column; trigger step 1 always skips; inherits parent invoice's org which may itself be NULL |
| `bank_transaction_allocations` | **HIGH** | R-03: NULL org = invisible allocation = `remaining_amount` is wrong. Has `client_id NOT NULL` so most rows derivable, but risk is high impact |
| `vraagposten` | **HIGH** | `client_id` is nullable; handmatig vraagposten may have no client_id |
| `grootboekrekeningen` | **HIGH** | `client_id` is nullable (made nullable in `20260412225236`); org-wide chart of accounts rows without client reference will fail trigger step 1 |
| `booking_templates` | **HIGH** | `client_id` is nullable per original schema |
| `sales_invoices` | MEDIUM | `client_id NOT NULL`; inherits from client; only risk is client with NULL org |
| `purchase_invoices` | MEDIUM | `client_id NOT NULL`; same |
| `bank_transactions` | MEDIUM | `client_id NOT NULL`; same |
| `leveranciers` | MEDIUM | `client_id NOT NULL`; same |
| `ledger_accounts` | MEDIUM | `client_id NOT NULL`; same |
| `journal_entries` | MEDIUM | `client_id NOT NULL`; same |
| `app_settings` | LOW | No `client_id`; per-user key-value settings; RLS still user-scoped via separate policy |

---

## Interpreting Results and Recommended Next PRs

### Scenario A — Block 1 returns all zeros (no NULL rows)

The backfill was complete and the trigger has been preventing new NULLs since deployment. This is the best case.

**Recommended next steps:**
1. PR: Add `NOT NULL` constraints to `organization_id` on all 13 tables (one per table per migration, with rollback comments)
2. PR: Harden trigger to `RAISE EXCEPTION` if `v_org_id IS NULL` at end of function
3. PR: Remove the duplicate trigger (`set_organization_id_trigger`) left by `20260603230656`, keeping only `trg_set_org_id`

### Scenario B — NULL rows exist and Block 2/3/4/5 show all are derivable

NULL rows exist but can all be safely resolved by running the same backfill logic again (extended to cover `clients`).

**Recommended next steps:**
1. PR: Targeted backfill migration covering all gaps:
   - `clients` via sole-membership (or profile default)
   - Tables with nullable `client_id` via sole-membership fallback
   - `purchase_invoice_lines` via parent invoice chain
2. After verifying Block 1 returns all zeros: proceed with Scenario A steps

### Scenario C — NULL rows exist and some are NOT derivable

Some rows have `resolution = 'not_derivable'` in blocks 3–5. These require owner input before any migration.

**Recommended next steps:**
1. Export the non-derivable rows for manual review (list their `id`, `user_id`, `created_at`, related context)
2. Decide per row: assign to an org manually, or delete if they are test/orphan data
3. Only after all rows have a resolvable org: proceed with Scenario B steps

### Scenario C+ — Block 6 shows org mismatches

Parent/child org mismatch detected. This is more serious than NULL: it means different rows in a parent-child chain belong to different organizations, violating referential integrity at the business level.

**Recommended next steps:**
1. Export the specific mismatched rows
2. Investigate whether this resulted from a manual edit, a broken trigger window, or data import
3. Do not apply NOT NULL constraints until mismatches are resolved

---

## What This Audit Does NOT Cover

- Storage object paths (separate audit if needed)
- Whether `organizations` and `organization_members` are themselves complete
- Whether `profiles.default_organization_id` values are accurate/current
- Whether the app always sends `organization_id` explicitly on insert (it should not need to, since the trigger handles it, but explicit is safer)
- Performance impact of the double-trigger firing on every insert

---

## Files Reviewed for This Audit

### Migrations
| File | Purpose |
|---|---|
| `20260411182021_ce126469…sql` | Initial schema: clients, purchase_invoices, sales_invoices, bank_transactions, journal_entries, booking_templates, ledger_accounts |
| `20260412222343_b9d16193…sql` | `grootboekrekeningen` table (client_id NOT NULL) |
| `20260412225236_b81432c6…sql` | Makes `grootboekrekeningen.client_id` nullable |
| `20260413001937_77b53d05…sql` | `app_settings` table (no client_id) |
| `20260511193208_26d490cf…sql` | `purchase_invoice_lines` table (no client_id, only purchase_invoice_id) |
| `20260512230007_8eb49195…sql` | `vraagposten` table (client_id nullable) |
| `20260512234913_16220fd0…sql` | `leveranciers` table (client_id NOT NULL) |
| `20260515120000_add-bank-transaction-allocations.sql` | `bank_transaction_allocations` table (client_id NOT NULL) |
| `20260530211249_baa29eca…sql` | Organization foundation: organizations, organization_members, profiles, user_roles; adds organization_id to clients |
| `20260531223619_7495538e…sql` | `set_organization_id()` trigger + backfill (adds org_id to 12 tables, backfills) |
| `20260603230656_3489def7…sql` | Re-deploys triggers as `set_organization_id_trigger` (creates duplicate trigger name) |
| `20260603231238_6e3e88b9…sql` | Org-aware RLS policies (intermediate, replaced by next migration) |
| `20260613001452_ac57e447…sql` | RBAC/RLS finalization: `has_min_role`, `prevent_org_user_rebind`, role-based policies on all 12 tables |

---

## Confirmation

- No files changed other than this documentation file
- No migrations created
- No DB schema, RLS, or storage policy changes made
- `src/integrations/supabase/types.ts` not touched
- All SQL in this document is SELECT-only
