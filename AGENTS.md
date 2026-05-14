# AGENTS.md — BoekAssist

Reference document for all code agents working on this repository.

---

## Official Environment

| Item | Value |
|---|---|
| GitHub repo | `Spiderman010/speedy-admin-automate-80194267` |
| Lovable project ID | `21f860ce-754f-4c09-b153-0e47d874bb93` |
| Supabase project ref | `alxlbdhpbwlehbdbfejw` |
| Supabase URL | `https://alxlbdhpbwlehbdbfejw.supabase.co` |
| Preview URL | `https://id-preview--21f860ce-754f-4c09-b153-0e47d874bb93.lovable.app` |

**Never use:** the old Vercel deployment at `speedy-admin-automate.vercel.app`, any archived Lovable project, or the `master` branch. The `vercel.json` in this repo is a SPA-rewrite fallback only; there is no active Vercel deployment.

---

## Branch Workflow

1. All development happens on a dedicated feature branch — never commit directly to `main`.
2. When assigned a task, check whether a branch already exists (e.g. `claude/boekassist-dev-setup-mJmMl`). Use it if present; otherwise create `feature/<short-description>`.
3. Push with `git push -u origin <branch-name>`.
4. Open a PR into `main` and wait for preview/CI to be green before merging.
5. `main` is the source of truth. Never force-push to `main`.

---

## Commands to Run Before Completing Work

Run all three and fix any failures before pushing:

```bash
# Type-check
npx tsc --noEmit

# Lint
npm run lint

# Unit tests
npm run test
```

The test suite uses Vitest (`vitest.config.ts`). Tests live under `src/test/`. All tests must pass.

---

## Rules for Migrations

- Migrations live in `supabase/migrations/` and are applied to project `alxlbdhpbwlehbdbfejw`.
- Name new migration files with a UTC timestamp prefix and a short slug:
  `YYYYMMDDHHMMSS_short-description.sql`
- Every migration must be **additive and non-destructive** by default:
  - Use `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
  - Never drop or rename columns or tables without explicit owner approval.
  - Never truncate data.
- Always include the inverse operation as a comment (`-- rollback: ...`) so a manual rollback is documented.
- Do not modify the Supabase-generated `types.ts` (`src/integrations/supabase/types.ts`) by hand; it is regenerated from the database schema.
- After adding a migration, regenerate types locally if possible and confirm the TypeScript build still passes.

---

## Rules for UBL Changes

The UBL generator is in `src/lib/ubl-generator.ts` and must stay compliant with **NLCIUS v1.0** (profile `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`, customization `urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0`).

- **Namespace and version** — `UBLVersionID` must remain `2.1`; do not change the `xmlns` declarations.
- **Required fields** — `invoice_number`, `invoice_date`, `amount_excl`, `amount_incl`, `btw_percentage` are validated before generation. Do not remove any entry from `REQUIRED_INVOICE_FIELDS`.
- **BTW (VAT)** — invoices with `btw_percentage > 0` require a supplier BTW-nummer. Preserve this check in `validatePurchaseInvoiceForUbl`.
- **Supplier data priority** — the chain `leverancier record → invoice snapshot → ocr_data` must be preserved in `extractSupplierParty`. Do not invert or short-circuit it.
- **Amounts** — all monetary values are formatted to exactly 2 decimal places with `fmt()`. Never change rounding behaviour.
- **Filename** — generated files use `UBL-<invoice_number>-<supplier>.xml`. Keep `sanitizeFilename` logic intact.
- **No external network calls** — the generator is pure client-side; do not add API calls.
- After any change, validate the output of a real invoice against the NLCIUS validator before merging.

---

## Rules for Supabase Edge Functions

Edge functions live under `supabase/functions/`. Current functions:
- `process-invoice` — OCR/AI processing for purchase invoices
- `process-sales-invoice` — OCR/AI processing for sales invoices

Rules:
- Runtime is **Deno**; use Deno-compatible imports (`https://deno.land/std@...`, `https://esm.sh/...`).
- Always handle the `OPTIONS` preflight with the existing `corsHeaders` block — do not remove CORS headers.
- Required environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (alias `SUPABASE_PUBLISHABLE_KEY`), `LOVABLE_API_KEY`. Fail fast with a clear error if any are missing.
- Authenticate every request: verify the `authorization` header via the anon client before doing any database work.
- Never hard-code secrets or API keys in source. Use `Deno.env.get(...)`.
- Deploy via Lovable Cloud or `supabase functions deploy <name> --project-ref alxlbdhpbwlehbdbfejw`. Do not deploy to a different project ref.
- Keep functions focused — do not merge unrelated business logic into an existing function.

---

## Rules for SnelStart Export

The SnelStart export module is `src/lib/snelstart-export.ts`.

- **CSV format** — the standard format uses semicolons (`;`) as separator and UTF-8 with BOM. Exception: `exportBankTransactionsCSV` uses the SnelStart 12 import format which must have **no BOM** (SnelStart 12 rejects BOM in that format).
- **Standard headers** — `Datum;Omschrijving;Grootboekrekening;Bedrag;Btw-code`. Do not change column order or names.
- **SnelStart 12 headers** — `fldDagboek;fldBoekingcode;fldDatum;fldGrootboeknummer;fldDebet;fldCredit;fldOmschrijving`. Do not change.
- **Date format** — always `DD-MM-YYYY` (Dutch locale). The `formatDate` function handles this; do not change its output format.
- **Amount format** — Dutch decimal notation: comma as decimal separator, two decimal places (e.g. `1234,56`). The `formatAmount` function handles this.
- **BTW codes** — 21% → `"1"`, 9% → `"2"`, 0% → `"0"`, other/null → `""`. Do not add extra codes without confirming with SnelStart documentation.
- **Bank transactions** — each transaction produces exactly two CSV rows (bank account line + contra account line). Transactions without a linked `grootboekrekening_id` are silently skipped — preserve this behaviour.
- Do not change the zip structure produced by `exportAllForClient`; the filenames match what the accountant expects.

---

## Rules for Scope Control

- Do not add features, abstractions, or refactors beyond what the task explicitly requires.
- Do not modify `package.json` or lock files unless the task explicitly requires a dependency change. If a dependency change is needed, state clearly which package and version and why.
- Do not modify unrelated files. If you notice a bug outside the task scope, report it in your completion note rather than fixing it silently.
- Do not create new pages, routes, or navigation items unless explicitly asked.
- Do not alter `src/integrations/supabase/types.ts` by hand; it is auto-generated.
- Do not modify `ENVIRONMENT.md`; it is maintained separately by environment audits.

---

## Required Completion Report

Every task must end with a structured report covering all four sections:

### 1. Reviewed Files
List every file you read or examined, even if unchanged.

### 2. Changed Files
List every file you created or modified, with a one-line description of the change.

### 3. Migrations
List any migration files added (filename + purpose), or state "None".

### 4. Test Results
Paste the output (or a summary) of:
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`

All three must be green before the task is considered complete.
