# Project Map — BoekAssist

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

## Do not use

The following Supabase project refs **must not** be used for BoekAssist production SQL or migrations:

| Ref | Reason |
|---|---|
| `olumcwneiejjefhkzgmz` | Not the database used by the running BoekAssist app |
| `ycuofllsdssoezwwpqmv` | Not the database used by the running BoekAssist app |

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
8. Open the Supabase dashboard.
9. Confirm the browser URL contains:
   ```
   /project/alxlbdhpbwlehbdbfejw
   ```

Only after all steps confirm `alxlbdhpbwlehbdbfejw` may SQL be run.

---

## SQL safety rules

- Never run SQL if the Supabase dashboard project ref is unclear.
- Never run SQL in `olumcwneiejjefhkzgmz`.
- Never run SQL in `ycuofllsdssoezwwpqmv`.
- Never run a "Combined Fresh Install Schema" on production.
- Only run one migration at a time.
- Prefer read-only verification queries before any mutation queries.

---

## Current migration note

PR #21 added the migration:

```
supabase/migrations/20260515120000_add-bank-transaction-allocations.sql
```

**Purpose:** Adds `bank_transaction_allocations` — the foundation for many-to-many bank transaction / invoice allocations.

**Status:** The migration file exists in `main`, but application to the real production Supabase database `alxlbdhpbwlehbdbfejw` still needs to be verified before building allocation UI.

**Verification query** (run in the SQL editor of project `alxlbdhpbwlehbdbfejw`):

```sql
select to_regclass('public.bank_transaction_allocations') as allocation_table;
```

Expected result if the migration has been applied:

```
allocation_table
─────────────────────────────────────
bank_transaction_allocations
```

---

## Emergency rule

> **If the project ref is unclear, stop. Do not run SQL.**
> Verify the app Network tab and Supabase dashboard project ref first.
