-- Migration: manual journal postings — memoriaal (phase 6C-b6, PR 1: schema + writer)
--
-- Purpose: the fourth production accounting writer, and the first one whose
-- source is authored by hand. A memoriaalboeking is a free-form journal entry
-- (header + N lines, each line DEBIT or CREDIT on one grootboekrekening) that
-- an accountant composes as a draft and then posts, exactly once, as one
-- balanced, immutable, tenant-safe group in public.ledger_postings.
--
-- Contents:
--   1. public.manual_journals           — the draft header (editable until posted)
--   2. public.manual_journal_lines      — the draft lines (editable until posted)
--   3. public.manual_journal_postings   — the atomic source-claim marker
--   4. RLS + grants on the two draft tables
--   5. public.save_manual_journal_lines(uuid, jsonb) — atomic replace of a draft's lines
--   6. public.post_manual_journal(uuid) — the only supported ledger write path
--   7. enforce_manual_journal_source_claim() — ledger_postings guard for this source
--   8. prevent_posted_manual_journal_mutation() / prevent_posted_manual_journal_line_mutation()
--      — posted header / posted lines freeze
--
-- NO BACKFILL. Nothing existing is posted or converted by this migration. The
-- legacy public.journal_entries table (single-sided, no group concept, fed by
-- Boekingen.tsx and the SnelStart export) is NOT touched, NOT read and NOT
-- migrated: there is deliberately not a single reference to it in this file.
-- There is not a single INSERT INTO public.ledger_postings outside the
-- function body. Nothing is auto-posted on save.
--
-- NO UI in this PR. This file ships the schema, the two RPCs and their guards;
-- hooks, pages, navigation and generated types follow in a separate PR once
-- the migration has been applied to production (deploy-order rule, see
-- BOOKASSIST_AI_BUILD_STRATEGY.md §6).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NEW TABLES, NOT journal_entries
--
-- journal_entries holds ONE signed amount on ONE account per row and has no
-- header/group identity, no debit/credit sides and no posting marker; its
-- consumers (Boekingen.tsx, useJournalEntries.ts, snelstart-export.ts) rely on
-- exactly that single-sided shape. Retro-fitting a two-sided, group-based,
-- freezable model onto it would change the meaning of existing production
-- rows and every consumer at once. The memoriaal therefore gets its own
-- greenfield pair of tables that express the double entry natively (one line
-- = one side), with NOT NULL tenant columns and real FKs, following the
-- greenfield precedent of ledger_postings itself (20260914120000).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ENTRY — one group, one ledger row per line, as stored
--
--   for each manual_journal_lines row, ORDER BY sort_order, id:
--     line.debit_amount  > 0  →  DEBIT   line.grootboekrekening_id   line.debit_amount
--     line.credit_amount > 0  →  CREDIT  line.grootboekrekening_id   line.credit_amount
--
-- The writer mirrors the lines exactly as the accountant stored them. There
-- are NO implicit legs: no automatic VAT line, no automatic contra account, no
-- rounding line, no suspense line. A line is either debit or credit (never
-- both, never neither), amounts are non-negative NUMERIC(12,2), and the group
-- must balance exactly (SUM(debit) = SUM(credit) in exact NUMERIC, no
-- tolerance) with at least one debit and one credit line.
--
-- DECIMALS — honest statement of who refuses what. The column type
-- numeric(12,2) ROUNDS a direct write (PostgREST INSERT/UPDATE, SQL editor)
-- to two decimals before any CHECK runs, so a table CHECK "x = round(x, 2)"
-- can never fail and is deliberately NOT declared. The save RPC — the
-- application path — checks the incoming JSON value in an unconstrained
-- numeric BEFORE the cast and refuses >2 decimals with a clear message; that
-- is the ONLY path that refuses instead of rounding. The poster keeps an
-- equivalent filter that is unreachable through the typmod, so the writer
-- does not lean on a column type it does not own.
--
-- NaN — 'NaN'::numeric is a legal numeric value and passes every ordinary
-- amount predicate: NaN >= 0, NaN > 0, NaN = 0 OR …, NaN = round(NaN, 2) and
-- even SUM(debit) <> SUM(credit) are all "not violated" (NaN = NaN is TRUE in
-- PostgreSQL). One NaN line would post and turn every SUM over that account
-- into NaN. Three layers refuse it: CHECK manual_journal_lines_no_nan_check
-- and the marker's total_amount CHECK ("x <> 'NaN'::numeric" is FALSE for
-- NaN, which is the point), save_manual_journal_lines() per element, and
-- post_manual_journal() over the locked lines, before the balance check.
-- NOTE: public.ledger_postings and the purchase/sales/bank marker tables have
-- the same gap at the foundation level (their CHECKs are ">= 0"-shaped and the
-- balance trigger uses "<>"); that is out of scope here and a follow-up on
-- 6C-b2, not on this writer.
--
-- VAT v1: there is no automatic VAT. If a memoriaalboeking carries VAT, the
-- accountant books the VAT account as an ordinary line, like any other line.
-- Nothing in this writer reads clients.btw_* configuration.
--
-- posting_date = manual_journals.posting_date (NOT NULL; chosen by the
-- accountant, CHECK-bounded to the same 2000..2100 window as
-- ledger_postings.boekjaar). boekjaar = calendar year of that date, identical
-- to the purchase, sales and bank writers. currency = 'EUR', passed
-- explicitly, exactly as the other writers do. description per ledger row =
-- the line's omschrijving when present, else the header's description (which
-- is required to be non-blank to post). "Blank" means empty after trimming
-- spaces, tabs, carriage returns and newlines — btrim(x, E' \t\r\n') — in all
-- three places (header refusal, ledger fallback, save normalisation), because
-- plain btrim() trims spaces only and would let E'\t\n' pass as a description.
--
-- source_type = 'manual_journal' (the value the foundation's COMMENT already
-- reserved for 6C-b6), source_id = manual_journals.id, source_line_id =
-- manual_journal_lines.id — see below for why that is safe here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY source_line_id IS PERSISTED HERE (and was NULL for purchase)
--
-- BOOKASSIST_ACCOUNTING_PATTERNS.md §2 forbids persisting source_line_id
-- unless the line id is provably durable for the lifetime of the posting.
-- Purchase could not prove that: save_purchase_invoice_with_lines deletes and
-- re-inserts every line on each save, and nothing stopped a save from running
-- while ledger rows already referenced the old ids. Here the line id IS
-- durable, by construction rather than by convention:
--
--   • save before post — save_manual_journal_lines() only exists for a DRAFT.
--     It refuses (42501) as soon as a marker exists, and the line freeze
--     trigger refuses every INSERT/UPDATE/DELETE on the lines of a posted
--     journal regardless of caller or role. After posting, no code path can
--     replace, renumber or remove a line, so the id the ledger row points at
--     is the id that will always exist.
--   • the poster locks header AND lines (FOR UPDATE, see LOCK ORDER) before
--     reading them, and writes the marker BEFORE the first ledger row, in the
--     same transaction. A concurrent save either finishes first (the poster
--     then reads the new line set, whose ids are the ones it persists) or
--     waits on the header lock and is refused afterwards. No ledger row can
--     ever point at a line id that a later save could replace.
--   • manual_journal_lines.manual_journal_id cannot change (trigger), so a
--     line can never be re-parented away from the journal that posted it.
--   • FK manual_journal_lines → manual_journals is ON DELETE CASCADE (the ONLY
--     cascade in this file) so that deleting a DRAFT removes its lines, but a
--     posted header can never be deleted (freeze trigger + RESTRICT FK from
--     the marker), so the cascade can never reach a posted line.
--
-- The claim trigger (section 7) then uses that durable identity to pin every
-- ledger row to its exact source line: account and amounts must equal the
-- frozen line, and the partial unique index (posting_group_id,
-- source_line_id) WHERE source_type = 'manual_journal' makes it impossible to
-- mirror one line twice even inside the posting transaction itself.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK ORDER — documented once here, followed exactly in both RPC bodies
--
--   manual_journals row (FOR UPDATE)                            -- LOCK 1
--     → manual_journal_lines rows, ORDER BY sort_order, id (FOR UPDATE)  -- LOCK 2 (poster only)
--       → reads: client, accounts, aggregates
--         → claim INSERT (marker)
--           → ledger INSERTs
--
-- BOTH RPCs lock the header first: post_manual_journal() takes LOCK 1 then
-- LOCK 2; save_manual_journal_lines() takes LOCK 1 and then deletes/inserts
-- lines (each line INSERT also takes KEY SHARE on the header for its FK, which
-- the same transaction already holds exclusively — no self-conflict). So save
-- and post always serialise on the header row: whichever starts first
-- finishes first, and the other one either sees the fully committed new line
-- set (post after save) or is refused because the marker now exists (save
-- after post). A mixed old/new line set can never be posted.
--
-- The application only ever writes these tables through single statements
-- (PostgREST) or through the two RPCs above. Every such path acquires locks
-- in the header → lines direction or touches a single row:
--   • header INSERT/UPDATE/DELETE via PostgREST: one header row; a DELETE of a
--     draft cascades to its lines AFTER the header row is locked (header →
--     lines, same direction as the poster).
--   • a raw line INSERT takes KEY SHARE on the header row first (inside the
--     line freeze trigger, deliberately BEFORE the marker check — see section
--     8) and waits behind a poster's FOR UPDATE, then is refused because the
--     marker is visible once the poster committed.
--   • a raw line UPDATE/DELETE locks its own line row first; if the poster
--     already holds LOCK 2 it waits, then is refused by the freeze; if the
--     poster has not reached LOCK 2 yet it commits first and the poster then
--     reads the committed new state under LOCK 2.
--
-- Two paths CAN deadlock, both non-application (manual SQL only):
--   (a) a raw MULTI-ROW line statement in the SQL editor (e.g. UPDATE
--       public.manual_journal_lines SET omschrijving = … WHERE
--       manual_journal_id = X) locks line rows in heap order while the poster
--       locks them in (sort_order, id) order under LOCK 2;
--   (b) a single raw TRANSACTION that first UPDATEs (or DELETEs) a line — a
--       line lock, taken before the poster reached LOCK 2 — and then INSERTs a
--       line: that INSERT takes FOR KEY SHARE on the header inside the line
--       freeze trigger and waits behind the poster's FOR UPDATE (LOCK 1),
--       while the poster is waiting at LOCK 2 on the line the transaction
--       already updated. Line → header inverts the documented header → lines
--       order.
-- In both cases PostgreSQL detects the cycle (40P01) and aborts one side.
-- Nothing partial is ever committed: the posting either commits cleanly or is
-- retried, and once it committed the mutation is refused anyway by the
-- freeze. This is an availability edge on a manual path, never an accounting
-- one — the app's own line writes go through save_manual_journal_lines(),
-- which locks the header first and therefore never enters either cycle.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLES — accountant posting floor, assistant lines-DELETE exception
--
-- POSTING FLOOR = accountant (owner decision). post_manual_journal() requires
-- has_min_role(auth.uid(), organization_id, 'accountant'). A memoriaal is a
-- free-form entry with no source document to reconcile against, so it is
-- reviewed by an accountant before it becomes immutable history. Assistants
-- may prepare and edit drafts (INSERT/UPDATE on both draft tables at the
-- 'assistant' floor, like every other draft document in this schema) but
-- cannot post. This is stricter than the purchase/sales/bank writers
-- ('assistant'), deliberately.
--
-- DOCUMENTED EXCEPTION — manual_journal_lines DELETE floor = assistant.
-- Every other table in this schema puts DELETE at 'accountant'. Here the
-- DELETE policy on manual_journal_lines is at 'assistant', because
-- save_manual_journal_lines() is SECURITY INVOKER and performs an atomic
-- DELETE + re-INSERT of a draft's lines under the caller's own RLS: an
-- assistant editing a draft must be able to replace its lines, and an
-- 'accountant' DELETE floor would silently make every assistant save fail.
-- The exception is limited to DRAFT lines: once a marker exists the line
-- freeze trigger refuses INSERT/UPDATE/DELETE for every role (it does not
-- consult roles at all), so a posted line is protected regardless of the
-- policy. The manual_journals header keeps the normal 'accountant' DELETE
-- floor (the cascade to lines then runs as the deleting accountant).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFERRED, deliberately — the schema stays compatible with all of it
--
--   • NUMBERING. No journal number / boekstuknummer column. Numbering needs a
--     per-administratie, per-boekjaar sequence design of its own; the header
--     carries a free-text reference for now. Adding a number column later is
--     an additive ALTER on an existing table, not a redesign.
--   • REVERSAL ENGINE. No reversal columns here. A future reversal writes a
--     NEW ledger group with reversal_of_posting_id set and its OWN source_type
--     (e.g. 'manual_journal_reversal'): the claim trigger in section 7 refuses
--     any 'manual_journal' row that carries reversal_of_posting_id, so a
--     reversal can never masquerade as, or be appended to, an original
--     memoriaal group. Nothing in this file edits or deletes posted rows.
--   • AUTOMATIC VAT. See VAT v1 above — VAT is an ordinary line.
--   • SNELSTART EXPORT of memoriaal postings. Out of scope; the export module
--     is untouched.
--
-- CORRECTIONS: once posted, a memoriaalboeking cannot be posted again — the
-- marker is a hard claim — and neither its header's accounting fields nor any
-- of its lines can change or be deleted (section 8). Corrections require the
-- future reversal workflow that writes NEW immutable rows.
--
-- ROLLBACK PRECONDITION: the block below is only safe BEFORE the first
-- posting, i.e. while public.manual_journal_postings is empty and
-- public.ledger_postings holds no source_type = 'manual_journal' row.
-- ledger_postings is append-only (6C-b2 seal: no UPDATE, no DELETE), so once a
-- memoriaalboeking has been posted, dropping these tables would leave its
-- ledger rows pointing at a source_id / source_line_id that no longer exists —
-- permanently orphaned, with no way to explain them. Check first:
--   SELECT count(*) FROM public.ledger_postings WHERE source_type = 'manual_journal';
-- and do not run the rollback unless that is 0. After a posting, the only
-- correction path is the future reversal engine.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_manual_journal_source_claim_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS set_manual_journal_line_org_trigger ON public.manual_journal_lines;
--   DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.manual_journal_lines;
--   DROP TRIGGER IF EXISTS prevent_posted_manual_journal_line_mutation_trigger ON public.manual_journal_lines;
--   DROP TRIGGER IF EXISTS prevent_posted_manual_journal_mutation_trigger ON public.manual_journals;
--   DROP TRIGGER IF EXISTS update_manual_journals_updated_at ON public.manual_journals;
--   DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.manual_journals;
--   DROP TRIGGER IF EXISTS validate_manual_journal_client_org_trigger ON public.manual_journals;
--   DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.manual_journals;
--   DROP FUNCTION IF EXISTS public.prevent_posted_manual_journal_line_mutation();
--   DROP FUNCTION IF EXISTS public.prevent_posted_manual_journal_mutation();
--   DROP FUNCTION IF EXISTS public.enforce_manual_journal_source_claim();
--   DROP FUNCTION IF EXISTS public.post_manual_journal(uuid);
--   DROP FUNCTION IF EXISTS public.save_manual_journal_lines(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.set_manual_journal_line_org();
--   DROP FUNCTION IF EXISTS public.enforce_manual_journal_client_org();
--   DROP POLICY IF EXISTS role_manual_journal_postings_select ON public.manual_journal_postings;
--   DROP POLICY IF EXISTS role_manual_journal_lines_delete ON public.manual_journal_lines;
--   DROP POLICY IF EXISTS role_manual_journal_lines_update ON public.manual_journal_lines;
--   DROP POLICY IF EXISTS role_manual_journal_lines_insert ON public.manual_journal_lines;
--   DROP POLICY IF EXISTS role_manual_journal_lines_select ON public.manual_journal_lines;
--   DROP POLICY IF EXISTS role_manual_journals_delete ON public.manual_journals;
--   DROP POLICY IF EXISTS role_manual_journals_update ON public.manual_journals;
--   DROP POLICY IF EXISTS role_manual_journals_insert ON public.manual_journals;
--   DROP POLICY IF EXISTS role_manual_journals_select ON public.manual_journals;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_manual_journal_line;
--   DROP INDEX IF EXISTS public.idx_manual_journal_postings_client;
--   DROP INDEX IF EXISTS public.idx_manual_journal_postings_organization;
--   DROP INDEX IF EXISTS public.idx_manual_journal_lines_user_id;
--   DROP INDEX IF EXISTS public.idx_manual_journal_lines_grootboekrekening_id;
--   DROP INDEX IF EXISTS public.idx_manual_journal_lines_organization;
--   DROP INDEX IF EXISTS public.idx_manual_journal_lines_journal;
--   DROP INDEX IF EXISTS public.idx_manual_journals_user_id;
--   DROP INDEX IF EXISTS public.idx_manual_journals_client_posting_date;
--   DROP INDEX IF EXISTS public.idx_manual_journals_organization;
--   DROP TABLE IF EXISTS public.manual_journal_postings;
--   DROP TABLE IF EXISTS public.manual_journal_lines;
--   DROP TABLE IF EXISTS public.manual_journals;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Prerequisite guard
--
--    plpgsql does not validate table or function references at CREATE FUNCTION
--    time, so without this the file would apply with zero errors on a database
--    that has not received 6C-b2, and post_manual_journal() would only fail at
--    first use with a raw "relation ... does not exist". Refuse up front
--    instead. Required order: 6C-b2 foundation (ledger_postings,
--    posting_account_ok, posting_client_org_ok) → this file. The role ladder
--    (has_min_role, 20260613001452) and clients.afgesloten_boekjaar are older
--    and checked for completeness.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst 6C-b2 (public.ledger_postings ontbreekt)';
  END IF;
  IF to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst 6C-b2 (public.posting_account_ok(uuid,uuid,uuid) ontbreekt)';
  END IF;
  IF to_regprocedure('public.posting_client_org_ok(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst 6C-b2 (public.posting_client_org_ok(uuid,uuid) ontbreekt)';
  END IF;
  IF to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst de rollenladder (public.has_min_role(uuid,uuid,app_role) ontbreekt)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'afgesloten_boekjaar'
  ) THEN
    RAISE EXCEPTION 'Migratie 6C-b6 vereist eerst clients.afgesloten_boekjaar (ontbreekt)';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The draft header
--
--    Deliberately minimal. There is no status column: "draft" versus "posted"
--    is DERIVED from the existence of a manual_journal_postings row, exactly
--    as for invoices and allocations, so the state can never disagree with the
--    ledger. There is no posting_group_id, boekjaar, currency, number, VAT or
--    reversal column: group and boekjaar are derived at posting time and live
--    on the marker and the ledger rows; currency is EUR-only; numbering, VAT
--    automation and reversal are deferred (header comment).
--
--    organization_id / client_id / user_id are NOT NULL with real FKs
--    (greenfield precedent, 20260914120000). posting_date is bounded to the
--    same window the ledger's boekjaar CHECK accepts, so a draft can never
--    hold a date the poster would have to refuse for a schema reason.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manual_journals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL,
  client_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  posting_date     date        NOT NULL
                               CONSTRAINT manual_journals_posting_date_check
                               CHECK (posting_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  description      text        NULL,
  reference        text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- RESTRICT throughout: a memoriaalboeking is accounting identity. An
-- organisation, administratie or user with journals cannot be hard-deleted
-- underneath them (same accepted consequence as ledger_postings).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journals'
      AND c.conname = 'manual_journals_organization_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journals
      ADD CONSTRAINT manual_journals_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journals'
      AND c.conname = 'manual_journals_client_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journals
      ADD CONSTRAINT manual_journals_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journals'
      AND c.conname = 'manual_journals_user_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journals
      ADD CONSTRAINT manual_journals_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- Serves the organisation RESTRICT FK and the RLS policy predicate.
CREATE INDEX IF NOT EXISTS idx_manual_journals_organization
  ON public.manual_journals (organization_id);

-- The list screen of the future UI: one administratie, newest first. Also
-- serves the client RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_manual_journals_client_posting_date
  ON public.manual_journals (client_id, posting_date DESC);

-- Serves the auth.users RESTRICT FK, which would otherwise scan the table on
-- every user delete attempt.
CREATE INDEX IF NOT EXISTS idx_manual_journals_user_id
  ON public.manual_journals (user_id);

-- organization_id derivation — the shared trigger, exactly as on the other 14
-- domain tables: respects an explicit value, otherwise derives from client_id
-- (this table has one), and hard-fails if it cannot. NOT redefined here.
DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.manual_journals;
CREATE TRIGGER set_organization_id_trigger
  BEFORE INSERT ON public.manual_journals
  FOR EACH ROW EXECUTE FUNCTION public.set_organization_id();

-- Tenant consistency: the administratie must belong to the header's
-- organisation. Reuses posting_client_org_ok() (6C-b2) so there is exactly
-- one definition of that rule. Also refuses moving a journal to another
-- administratie while it still has lines: the lines' accounts were chosen in
-- the scope of the old administratie (posting_account_ok is client-scoped),
-- so a re-pointed header could carry lines whose accounts the poster would
-- then refuse — or worse, accept for the wrong administratie. Removing the
-- lines first makes the change explicit.
CREATE OR REPLACE FUNCTION public.enforce_manual_journal_client_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van deze memoriaalboeking'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.client_id IS DISTINCT FROM OLD.client_id
     AND EXISTS (SELECT 1 FROM public.manual_journal_lines WHERE manual_journal_id = OLD.id) THEN
    RAISE EXCEPTION 'Administratie kan niet worden gewijzigd zolang de memoriaalboeking regels heeft; verwijder eerst de regels'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_manual_journal_client_org() FROM PUBLIC;

-- "validate_" sorts after "set_organization_id_trigger", so organization_id is
-- already resolved when it is compared against the client.
DROP TRIGGER IF EXISTS validate_manual_journal_client_org_trigger ON public.manual_journals;
CREATE TRIGGER validate_manual_journal_client_org_trigger
  BEFORE INSERT OR UPDATE OF client_id, organization_id ON public.manual_journals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_manual_journal_client_org();

-- organization_id and user_id are immutable after insert, as on every other
-- domain table (20260613001452). NOT redefined here.
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.manual_journals;
CREATE TRIGGER prevent_org_user_rebind_trg
  BEFORE UPDATE ON public.manual_journals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

DROP TRIGGER IF EXISTS update_manual_journals_updated_at ON public.manual_journals;
CREATE TRIGGER update_manual_journals_updated_at
  BEFORE UPDATE ON public.manual_journals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The posted-header freeze trigger is attached in section 8, after its
-- function and the marker table it reads exist.

COMMENT ON TABLE public.manual_journals IS
'Memoriaalboeking (kop). Concept zolang er geen rij in manual_journal_postings bestaat; daarna bevroren. Bevat bewust geen status-, nummer-, boekjaar-, valuta-, BTW- of tegenboekingskolommen: de boekingsstatus wordt afgeleid uit de claim, boekjaar en groep staan op de claim en de grootboekregels.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) The draft lines
--
--    One line = one side. debit_amount / credit_amount are both NOT NULL
--    DEFAULT 0 with the same single-representation rule as ledger_postings:
--    the unused side is an explicit 0, never NULL. Unlike the ledger, a DRAFT
--    line may be 0/0 (an accountant types the account first and the amount
--    later); the poster refuses such a line, the table does not. A line may
--    never be both debit and credit, never negative and never NaN — those are
--    refused at the table level so no draft can hold an amount the ledger
--    could not represent. Decimals are a different story: numeric(12,2)
--    rounds a direct write to two decimals BEFORE any CHECK could see it, so
--    a "two decimals" CHECK would be dead code and is not declared (header:
--    DECIMALS). The save RPC refuses >2 decimals before the cast.
--
--    sort_order is NOT unique: a UI reorders lines by rewriting sort_order in
--    bulk, and a transient duplicate during that rewrite would otherwise fail.
--    The poster orders by (sort_order, id) so line_no is still deterministic.
--
--    grootboekrekening_id is NULLABLE on the draft (an unfinished line) and
--    required by the poster.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manual_journal_lines (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_journal_id     uuid          NOT NULL,
  organization_id       uuid          NOT NULL,
  user_id               uuid          NOT NULL,
  sort_order            integer       NOT NULL DEFAULT 0,
  grootboekrekening_id  uuid          NULL,
  omschrijving          text          NULL,
  debit_amount          numeric(12,2) NOT NULL DEFAULT 0
                                      CONSTRAINT manual_journal_lines_debit_amount_check
                                      CHECK (debit_amount >= 0),
  credit_amount         numeric(12,2) NOT NULL DEFAULT 0
                                      CONSTRAINT manual_journal_lines_credit_amount_check
                                      CHECK (credit_amount >= 0),
  created_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT manual_journal_lines_single_side_check
    CHECK (debit_amount = 0 OR credit_amount = 0),
  -- NaN passes every predicate above (NaN >= 0 and NaN = 0 OR … are TRUE).
  -- "x <> 'NaN'::numeric" evaluates to FALSE for NaN, so this CHECK is the
  -- one that actually refuses it.
  CONSTRAINT manual_journal_lines_no_nan_check
    CHECK (debit_amount <> 'NaN'::numeric AND credit_amount <> 'NaN'::numeric)
);

-- The ONLY ON DELETE CASCADE in this file: deleting a DRAFT header removes its
-- lines. It can never reach a posted line, because a posted header cannot be
-- deleted (section 8 freeze + the RESTRICT FK from manual_journal_postings).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_lines'
      AND c.conname = 'manual_journal_lines_manual_journal_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_lines
      ADD CONSTRAINT manual_journal_lines_manual_journal_id_fkey
      FOREIGN KEY (manual_journal_id) REFERENCES public.manual_journals (id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_lines'
      AND c.conname = 'manual_journal_lines_organization_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_lines
      ADD CONSTRAINT manual_journal_lines_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_lines'
      AND c.conname = 'manual_journal_lines_user_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_lines
      ADD CONSTRAINT manual_journal_lines_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- RESTRICT (purchase_invoice_lines precedent, 20260718213000): an account
-- referenced by a draft line cannot be deleted; no SET NULL that would quietly
-- turn a complete draft into an incomplete one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_lines'
      AND c.conname = 'manual_journal_lines_grootboekrekening_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_lines
      ADD CONSTRAINT manual_journal_lines_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id) REFERENCES public.grootboekrekeningen (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- The poster's LOCK 2 and every "lines of this journal" read, in posting order.
CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_journal
  ON public.manual_journal_lines (manual_journal_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_organization
  ON public.manual_journal_lines (organization_id);

-- Serves the grootboekrekeningen RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_grootboekrekening_id
  ON public.manual_journal_lines (grootboekrekening_id);

CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_user_id
  ON public.manual_journal_lines (user_id);

-- organization_id of a line is ALWAYS the parent's. The shared
-- set_organization_id() is deliberately NOT attached to this table: it only
-- runs when organization_id is NULL, and its fallbacks (the user's profile
-- default organisation, or sole membership) are the wrong answer for a child
-- row — a line must belong to its journal's organisation, never to whatever
-- organisation the inserting user happens to default to. This trigger
-- therefore derives the value from the parent unconditionally and overwrites
-- any explicit value, so a line can never disagree with its header.
--
-- manual_journal_id is immutable: a line can never be re-parented (that is
-- one of the properties that makes manual_journal_lines.id durable, see the
-- header). On UPDATE, prevent_org_user_rebind_trg sorts BEFORE this trigger
-- ("prevent_" < "set_") and refuses a changed organization_id first; this
-- trigger then re-derives the (unchanged) value from the parent.
CREATE OR REPLACE FUNCTION public.set_manual_journal_line_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.manual_journals
  WHERE id = NEW.manual_journal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memoriaalboeking niet gevonden voor deze regel' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.manual_journal_id IS DISTINCT FROM OLD.manual_journal_id THEN
    RAISE EXCEPTION 'manual_journal_id kan niet worden gewijzigd' USING ERRCODE = '23514';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.set_manual_journal_line_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS set_manual_journal_line_org_trigger ON public.manual_journal_lines;
CREATE TRIGGER set_manual_journal_line_org_trigger
  BEFORE INSERT OR UPDATE ON public.manual_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_manual_journal_line_org();

DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.manual_journal_lines;
CREATE TRIGGER prevent_org_user_rebind_trg
  BEFORE UPDATE ON public.manual_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- The posted-line freeze trigger is attached in section 8.

COMMENT ON TABLE public.manual_journal_lines IS
'Regels van een memoriaalboeking: één regel = één debet- óf creditzijde op één grootboekrekening. Concept zolang de kop niet is geboekt; daarna bevroren. organization_id wordt altijd van de kop overgenomen; manual_journal_id kan niet wijzigen. Bedragen: numeric(12,2) (directe schrijfacties worden afgerond op twee decimalen; save_manual_journal_lines weigert méér dan twee decimalen), nooit negatief, nooit tweezijdig, nooit NaN.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The claim marker — same design as the invoice and allocation markers,
--    keyed on the journal
--
--    manual_journal_id is the PRIMARY KEY, and that single fact is the whole
--    idempotency guarantee: the second claim of a journal cannot exist.
--    posting_group_id is UNIQUE, so one journal ↔ one group.
--
--    The marker also records what was claimed (posting_date, line_count,
--    total_amount = the debit total of the group) so the audit trail survives
--    independently of the header it explains, and so the claim trigger in
--    section 7 can pin the shape of the group (line_no range, date) without
--    re-reading the header.
--
--    Under concurrency the primary key index is also the serialisation point:
--    the second transaction blocks on the uncommitted key until the first
--    commits, then fails with unique_violation. Claim and ledger rows are
--    written in the same transaction, so a journal is either fully posted or
--    not posted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manual_journal_postings (
  manual_journal_id  uuid          PRIMARY KEY,
  posting_group_id   uuid          NOT NULL UNIQUE,
  organization_id    uuid          NOT NULL,
  client_id          uuid          NOT NULL,
  user_id            uuid          NOT NULL,
  posting_date       date          NOT NULL,
  line_count         integer       NOT NULL
                                   CONSTRAINT manual_journal_postings_line_count_check
                                   CHECK (line_count >= 2),
  total_amount       numeric(12,2) NOT NULL
                                   CONSTRAINT manual_journal_postings_total_amount_check
                                   CHECK (total_amount > 0 AND total_amount <> 'NaN'::numeric),
  created_at         timestamptz   NOT NULL DEFAULT now()
);

-- RESTRICT throughout: this row is the audit trail proving why immutable ledger
-- rows exist. It must never be cascade-deleted out from under them — and the
-- RESTRICT on manual_journal_id is what guarantees the lines' CASCADE FK can
-- never fire for a posted journal even if the freeze trigger were disabled.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_postings'
      AND c.conname = 'manual_journal_postings_manual_journal_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_postings
      ADD CONSTRAINT manual_journal_postings_manual_journal_id_fkey
      FOREIGN KEY (manual_journal_id) REFERENCES public.manual_journals (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_postings'
      AND c.conname = 'manual_journal_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_postings
      ADD CONSTRAINT manual_journal_postings_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_postings'
      AND c.conname = 'manual_journal_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_postings
      ADD CONSTRAINT manual_journal_postings_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'manual_journal_postings'
      AND c.conname = 'manual_journal_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.manual_journal_postings
      ADD CONSTRAINT manual_journal_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_manual_journal_postings_organization
  ON public.manual_journal_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_manual_journal_postings_client
  ON public.manual_journal_postings (client_id);

-- Marker privileges — read-only for the app, writable only by the RPC. Same
-- reasoning as the invoice and allocation markers: a client able to write the
-- marker directly could fabricate a claim (blocking a legitimate posting
-- forever) or delete one (enabling a duplicate). The reset is REVOKE ALL then
-- GRANT SELECT, not an enumerated REVOKE list, so no future default privilege
-- (MAINTAIN, ...) can slip past it. service_role is not granted EXECUTE on the
-- writer either; no edge function posts memoriaalboekingen.
ALTER TABLE public.manual_journal_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_manual_journal_postings_select ON public.manual_journal_postings;
CREATE POLICY role_manual_journal_postings_select ON public.manual_journal_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.manual_journal_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.manual_journal_postings TO authenticated, service_role;

COMMENT ON TABLE public.manual_journal_postings IS
'Claim-registratie: bewijst dat één memoriaalboeking (manual_journals-rij) precies één keer in het grootboek is geboekt. De primary key op manual_journal_id ís de idempotentiegarantie; posting_group_id is uniek, dus één memoriaalboeking ↔ één boekingsgroep. Legt boekingsdatum, regelaantal en debettotaal vast als audittrail. Alleen public.post_manual_journal() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) RLS + grants on the draft tables — the existing has_min_role ladder
--
--    manual_journals        SELECT read_only | INSERT assistant (+ own user_id)
--                           | UPDATE assistant | DELETE accountant
--    manual_journal_lines   SELECT read_only | INSERT assistant (+ own user_id)
--                           | UPDATE assistant | DELETE assistant  ← EXCEPTION
--
--    user_id = auth.uid() on both INSERT policies: the same reasoning as the
--    ledger's INSERT policy — a member must not be able to attribute a draft
--    to another user, and rejecting is more honest than silently rewriting.
--
--    DOCUMENTED EXCEPTION — lines DELETE at 'assistant' instead of the
--    schema-wide 'accountant': save_manual_journal_lines() (section 5) is
--    SECURITY INVOKER and replaces a draft's lines with DELETE + INSERT under
--    the caller's own RLS. An assistant who may INSERT and UPDATE draft lines
--    must therefore also be able to DELETE them, or no assistant could ever
--    save an edited draft. This applies to DRAFT lines only: the freeze
--    trigger in section 8 refuses any INSERT/UPDATE/DELETE on the lines of a
--    posted journal for every role, without consulting roles at all, so a
--    posted line is protected by the trigger regardless of this policy. The
--    header keeps the normal 'accountant' DELETE floor.
--
--    Grants are a full reset (REVOKE ALL, then exactly what is intended), so
--    the final grid is a property of this migration and not of whatever
--    default privileges the applying role carries: authenticated gets
--    SELECT, INSERT, UPDATE, DELETE (RLS narrows it per row/role);
--    service_role gets SELECT only (no edge function writes drafts); anon gets
--    nothing.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.manual_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_manual_journals_select ON public.manual_journals;
CREATE POLICY role_manual_journals_select ON public.manual_journals
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_manual_journals_insert ON public.manual_journals;
CREATE POLICY role_manual_journals_insert ON public.manual_journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS role_manual_journals_update ON public.manual_journals;
CREATE POLICY role_manual_journals_update ON public.manual_journals
  FOR UPDATE TO authenticated
  USING      (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));

DROP POLICY IF EXISTS role_manual_journals_delete ON public.manual_journals;
CREATE POLICY role_manual_journals_delete ON public.manual_journals
  FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));

DROP POLICY IF EXISTS role_manual_journal_lines_select ON public.manual_journal_lines;
CREATE POLICY role_manual_journal_lines_select ON public.manual_journal_lines
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_manual_journal_lines_insert ON public.manual_journal_lines;
CREATE POLICY role_manual_journal_lines_insert ON public.manual_journal_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS role_manual_journal_lines_update ON public.manual_journal_lines;
CREATE POLICY role_manual_journal_lines_update ON public.manual_journal_lines
  FOR UPDATE TO authenticated
  USING      (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));

-- DOCUMENTED EXCEPTION: 'assistant', not 'accountant' — see the section
-- comment. Draft lines only; posted lines are frozen by trigger for every role.
DROP POLICY IF EXISTS role_manual_journal_lines_delete ON public.manual_journal_lines;
CREATE POLICY role_manual_journal_lines_delete ON public.manual_journal_lines
  FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'assistant'));

REVOKE ALL ON public.manual_journals, public.manual_journal_lines FROM anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_journals, public.manual_journal_lines TO authenticated;
GRANT SELECT ON public.manual_journals, public.manual_journal_lines TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Atomic replace of a draft's lines
--
--    Clone of the replace_purchase_invoice_lines shape (20260718202037):
--    validate every element, then DELETE + INSERT in one function
--    transaction, so a failing element leaves the previous line set intact.
--
--    SECURITY INVOKER, deliberately: this function writes DRAFT data, which
--    the caller may write directly anyway, so RLS is the authorization —
--    an invisible journal is simply NOT FOUND (P0002), and the DELETE/INSERT
--    below run under the caller's own policies (which is why the lines DELETE
--    policy sits at 'assistant', section 4). No privilege is escalated.
--
--    LOCK 1 — SELECT ... FOR UPDATE on the header — is the SAME lock the
--    poster takes first, so a save and a post on the same journal always
--    serialise: post after save reads the committed new line set; save after
--    post blocks, then finds the marker and is refused. Under RLS a FOR UPDATE
--    also requires the UPDATE policy to pass, so a read_only member cannot
--    even lock the row.
--
--    The marker check is defence in depth — the line freeze trigger would
--    refuse the DELETE anyway — so the caller gets one clear message instead
--    of a trigger error from inside a DELETE.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_manual_journal_lines(
  _journal_id uuid,
  _lines jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_journal   uuid;
  v_elem      jsonb;
  v_idx       integer := 0;
  v_account   uuid;
  v_sort      integer;
  v_debit     numeric;
  v_credit    numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- LOCK 1: the header, FOR UPDATE — same lock as post_manual_journal().
  SELECT id INTO v_journal
  FROM public.manual_journals
  WHERE id = _journal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memoriaalboeking niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.manual_journal_postings WHERE manual_journal_id = _journal_id) THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; regels kunnen niet meer worden gewijzigd'
      USING ERRCODE = '42501';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'lines moet een JSON array zijn' USING ERRCODE = '22023';
  END IF;

  -- Per-element validation before anything is deleted. Draft semantics: a
  -- line may be 0/0 (unfinished) and may lack an account; it may never be
  -- NaN, negative, both-sided, or carry more than two decimals. v_debit and
  -- v_credit are UNCONSTRAINED numeric on purpose: a numeric(12,2) variable
  -- would already have rounded 0.005 to 0.01 before the decimals check below
  -- could see it (header: DECIMALS).
  FOR v_elem IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_idx := v_idx + 1;

    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'Regel % is geen JSON object', v_idx USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_account := NULLIF(v_elem->>'grootboekrekening_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Regel %: grootboekrekening_id is geen geldige uuid', v_idx USING ERRCODE = '22023';
    END;

    IF v_elem ? 'omschrijving' AND jsonb_typeof(v_elem->'omschrijving') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Regel %: omschrijving moet tekst zijn', v_idx USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_sort := COALESCE(NULLIF(v_elem->>'sort_order', '')::integer, v_idx - 1);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Regel %: sort_order moet een geheel getal zijn', v_idx USING ERRCODE = '22023';
    END;

    BEGIN
      v_debit  := COALESCE(NULLIF(v_elem->>'debit_amount', '')::numeric, 0);
      v_credit := COALESCE(NULLIF(v_elem->>'credit_amount', '')::numeric, 0);
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Regel %: debit_amount en credit_amount moeten numeriek zijn', v_idx USING ERRCODE = '22023';
    END;

    -- 'NaN' casts to numeric without error and would pass every check below
    -- (NaN < 0 is FALSE, NaN > 0 is TRUE, NaN = round(NaN, 2) is TRUE), so it
    -- is refused first and explicitly.
    IF v_debit = 'NaN'::numeric OR v_credit = 'NaN'::numeric THEN
      RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023';
    END IF;

    IF v_debit < 0 OR v_credit < 0 THEN
      RAISE EXCEPTION 'Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde'
        USING ERRCODE = '22023';
    END IF;

    IF v_debit > 0 AND v_credit > 0 THEN
      RAISE EXCEPTION 'Een regel kan niet tegelijk debet en credit zijn' USING ERRCODE = '22023';
    END IF;

    -- The ONLY place that refuses >2 decimals instead of rounding them: this
    -- runs on the unconstrained value, before the numeric(12,2) cast at INSERT.
    IF v_debit <> round(v_debit, 2) OR v_credit <> round(v_credit, 2) THEN
      RAISE EXCEPTION 'Bedragen mogen maximaal twee decimalen hebben' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Atomic replace. If the INSERT raises, the DELETE is rolled back with it
  -- and the previous line set remains intact.
  DELETE FROM public.manual_journal_lines
  WHERE manual_journal_id = _journal_id;

  -- Defence in depth for the INVOKER model: under RLS a DELETE silently skips
  -- rows the caller may not delete. If anything survived, the caller must not
  -- be allowed to write a partial line set on top of it.
  IF EXISTS (SELECT 1 FROM public.manual_journal_lines WHERE manual_journal_id = _journal_id) THEN
    RAISE EXCEPTION 'Geen rechten om de regels van deze memoriaalboeking te vervangen'
      USING ERRCODE = '42501';
  END IF;

  -- organization_id is set by set_manual_journal_line_org_trigger from the
  -- parent; user_id is the caller (bound by the INSERT policy).
  INSERT INTO public.manual_journal_lines (
    manual_journal_id, user_id, sort_order, grootboekrekening_id, omschrijving,
    debit_amount, credit_amount
  )
  SELECT
    _journal_id,
    v_uid,
    COALESCE(NULLIF(elem->>'sort_order', '')::integer, (ord - 1)::integer),
    NULLIF(elem->>'grootboekrekening_id', '')::uuid,
    NULLIF(btrim(COALESCE(elem->>'omschrijving', ''), E' \t\r\n'), ''),
    COALESCE(NULLIF(elem->>'debit_amount', '')::numeric, 0),
    COALESCE(NULLIF(elem->>'credit_amount', '')::numeric, 0)
  FROM jsonb_array_elements(_lines) WITH ORDINALITY AS t(elem, ord);
END
$$;

REVOKE ALL ON FUNCTION public.save_manual_journal_lines(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_manual_journal_lines(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.save_manual_journal_lines(uuid, jsonb) IS
'Vervangt atomair alle regels van een concept-memoriaalboeking (verwijderen + opnieuw invoegen in één transactie). Draait als de aanroeper (SECURITY INVOKER): RLS bepaalt de rechten. Grendelt eerst de kop (FOR UPDATE, dezelfde grendel als post_manual_journal) en weigert zodra de memoriaalboeking is geboekt. Bedragen: geen NaN, niet negatief, niet tegelijk debet en credit, maximaal twee decimalen (gecontroleerd vóór de cast naar numeric(12,2); dit is het enige pad dat afkeurt in plaats van afrondt).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) The writer
--
--    SECURITY DEFINER is required, not preferred: the marker table is
--    deliberately not writable by authenticated (section 3), so an INVOKER
--    function could not claim the journal. Because the definer bypasses RLS,
--    every check RLS would normally perform is done explicitly below.
--
--    The ONLY caller input is _journal_id. organization_id, client_id,
--    user_id, posting_group_id, amounts, accounts, sides, date, boekjaar and
--    currency are all derived server-side from the locked rows;
--    created_xact_id is stamped by the ledger's own trigger.
--
--    The body follows the LOCK ORDER documented in the header, in that exact
--    sequence: header (FOR UPDATE) → lines (FOR UPDATE, ORDER BY sort_order,
--    id) → reads → claim insert → ledger inserts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_manual_journal(_journal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_journal          public.manual_journals%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_line_count       integer;
  v_no_account       integer;
  v_zero_lines       integer;
  v_both_sides       integer;
  v_negative         integer;
  v_nan              integer;
  v_decimals         integer;
  v_org_mismatch     integer;
  v_sum_debit        numeric;
  v_sum_credit       numeric;
  v_bad_scope        integer;
  v_inactive         text;
  v_line_no          integer := 0;
  v_line             record;
BEGIN
  -- (1) Authentication first: nothing is read or locked for an anonymous call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) LOCK 1 — the header, FOR UPDATE. save_manual_journal_lines() and the
  -- app's header UPDATE/DELETE lock this same row, so whichever starts first
  -- finishes first (see LOCK ORDER in the header).
  SELECT * INTO v_journal
  FROM public.manual_journals
  WHERE id = _journal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memoriaalboeking niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (3) Tenant + role, both from stored data. POSTING FLOOR = accountant
  -- (owner decision, header comment): assistants prepare, accountants post.
  IF v_journal.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_journal.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om memoriaalboekingen te boeken voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (4) The administratie must belong to the journal's organisation.
  SELECT * INTO v_client FROM public.clients WHERE id = v_journal.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_journal.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze memoriaalboeking'
      USING ERRCODE = '42501';
  END IF;

  -- (5) Defensive: the column is NOT NULL, but the writer does not lean on a
  -- constraint it does not own.
  IF v_journal.posting_date IS NULL THEN
    RAISE EXCEPTION 'Memoriaalboeking heeft geen boekingsdatum; boeken is niet mogelijk'
      USING ERRCODE = '22004';
  END IF;

  -- (6) A memoriaal without a description is not auditable: it is also the
  -- fallback description of every ledger row whose line has none. Whitespace-
  -- aware: btrim() alone trims spaces only and would accept E'\t\n'.
  IF v_journal.description IS NULL OR btrim(v_journal.description, E' \t\r\n') = '' THEN
    RAISE EXCEPTION 'Memoriaalboeking heeft geen omschrijving; boeken is niet mogelijk'
      USING ERRCODE = '22023';
  END IF;

  -- (7) Closed year, identically to the other writers. No fallback year.
  v_boekjaar := EXTRACT(YEAR FROM v_journal.posting_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- (8) LOCK 2 — every line, FOR UPDATE, in posting order. A raw line
  -- UPDATE/DELETE in flight finishes first (we then read its committed
  -- result); one that starts later waits here and is refused by the freeze
  -- once our marker is committed.
  PERFORM 1
  FROM public.manual_journal_lines
  WHERE manual_journal_id = v_journal.id
  ORDER BY sort_order, id
  FOR UPDATE;

  -- (9) One aggregate over the locked lines, then refusals in a fixed order
  -- so the first message names the most fundamental problem.
  --   • the NaN filter is real: a NaN line passes the zero / both-sides /
  --     negative / decimals filters AND the balance check (NaN = NaN), so it
  --     is counted separately and refused before the balance is compared.
  --   • the decimals filter is unreachable through the numeric(12,2) typmod
  --     (a stored value already has two decimals); it is kept so the writer
  --     does not lean on a typmod it does not own.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL),
         COUNT(*) FILTER (WHERE l.debit_amount = 0 AND l.credit_amount = 0),
         COUNT(*) FILTER (WHERE l.debit_amount > 0 AND l.credit_amount > 0),
         COUNT(*) FILTER (WHERE l.debit_amount < 0 OR l.credit_amount < 0),
         COUNT(*) FILTER (WHERE l.debit_amount = 'NaN'::numeric OR l.credit_amount = 'NaN'::numeric),
         COUNT(*) FILTER (WHERE l.debit_amount <> round(l.debit_amount, 2)
                             OR l.credit_amount <> round(l.credit_amount, 2)),
         COUNT(*) FILTER (WHERE l.organization_id IS DISTINCT FROM v_journal.organization_id),
         COALESCE(SUM(l.debit_amount), 0),
         COALESCE(SUM(l.credit_amount), 0)
    INTO v_line_count, v_no_account, v_zero_lines, v_both_sides, v_negative,
         v_nan, v_decimals, v_org_mismatch, v_sum_debit, v_sum_credit
  FROM public.manual_journal_lines l
  WHERE l.manual_journal_id = v_journal.id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Een memoriaalboeking heeft minimaal twee regels: een debet- en een creditregel'
      USING ERRCODE = '22023';
  END IF;

  IF v_no_account > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder grootboekrekening; boeken is niet mogelijk', v_no_account
      USING ERRCODE = '22023';
  END IF;

  IF v_zero_lines > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder bedrag; boeken is niet mogelijk', v_zero_lines
      USING ERRCODE = '22023';
  END IF;

  IF v_both_sides > 0 THEN
    RAISE EXCEPTION 'Een regel kan niet tegelijk debet en credit zijn' USING ERRCODE = '22023';
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION 'Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde'
      USING ERRCODE = '22023';
  END IF;

  IF v_nan > 0 THEN
    RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023';
  END IF;

  IF v_decimals > 0 THEN
    RAISE EXCEPTION 'Bedragen mogen maximaal twee decimalen hebben' USING ERRCODE = '22023';
  END IF;

  IF v_org_mismatch > 0 THEN
    RAISE EXCEPTION 'Een regel hoort bij een andere organisatie dan de memoriaalboeking'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Een memoriaalboeking heeft zowel een debet- als een creditbedrag groter dan nul nodig'
      USING ERRCODE = '22023';
  END IF;

  -- Exact NUMERIC equality. No tolerance, no rounding: the ledger's own group
  -- check is exact, so anything less would only move the refusal to COMMIT.
  -- NO cap on the number of lines: a memoriaal has as many lines as it needs.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Memoriaalboeking is niet in balans: debet % is ongelijk aan credit %', v_sum_debit, v_sum_credit
      USING ERRCODE = '23514';
  END IF;

  -- (10) Account scope: every account must be usable by THIS administratie —
  -- the same predicate ledger_postings enforces per row, checked up front so
  -- the refusal is explicit instead of a generic row error.
  SELECT COUNT(*) INTO v_bad_scope
  FROM public.manual_journal_lines l
  WHERE l.manual_journal_id = v_journal.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_journal.organization_id, v_journal.client_id);
  IF v_bad_scope > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_bad_scope
      USING ERRCODE = '23514';
  END IF;

  -- (11) No posting onto a deactivated account.
  SELECT string_agg(g.nummer::text, ', ' ORDER BY g.nummer) INTO v_inactive
  FROM public.manual_journal_lines l
  JOIN public.grootboekrekeningen g ON g.id = l.grootboekrekening_id
  WHERE l.manual_journal_id = v_journal.id
    AND NOT g.actief;
  IF v_inactive IS NOT NULL THEN
    RAISE EXCEPTION 'Een regel verwijst naar een niet-actieve grootboekrekening (%)', v_inactive
      USING ERRCODE = '22023';
  END IF;

  -- (12) Claim the journal. The primary key is the idempotency guarantee and,
  -- under concurrency, the serialisation point: a second session blocks here
  -- until the first commits and then fails. No EXISTS pre-check — the index
  -- is the arbiter.
  BEGIN
    INSERT INTO public.manual_journal_postings (
      manual_journal_id, posting_group_id, organization_id, client_id, user_id,
      posting_date, line_count, total_amount
    ) VALUES (
      v_journal.id, v_group_id, v_journal.organization_id, v_journal.client_id, v_uid,
      v_journal.posting_date, v_line_count, v_sum_debit
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is al geboekt' USING ERRCODE = '23505';
  END;

  -- (13) One ledger row per line, exactly as stored, in posting order. The
  -- line's own id goes in source_line_id (durable here — header comment).
  FOR v_line IN
    SELECT id, grootboekrekening_id, debit_amount, credit_amount, omschrijving
    FROM public.manual_journal_lines
    WHERE manual_journal_id = v_journal.id
    ORDER BY sort_order, id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_journal.organization_id, v_journal.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_journal.posting_date, v_boekjaar, v_line.debit_amount, v_line.credit_amount, 'EUR',
      COALESCE(NULLIF(btrim(v_line.omschrijving, E' \t\r\n'), ''), v_journal.description),
      'manual_journal', v_journal.id, v_line.id, v_uid
    );
  END LOOP;

  -- (14)
  RETURN v_group_id;
END
$$;

-- Callable by the app, never by anon, never by service_role, never by PUBLIC.
-- Every application role is named explicitly: a grant made straight to anon or
-- service_role by a platform default survives a REVOKE that only names PUBLIC.
REVOKE ALL ON FUNCTION public.post_manual_journal(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_manual_journal(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_manual_journal(uuid) IS
'Boekt één concept-memoriaalboeking als sluitende boeking in ledger_postings — één grootboekregel per memoriaalregel, debet of credit zoals vastgelegd, zonder impliciete regels — en claimt haar in manual_journal_postings, atomair en precies één keer. Vereist de rol accountant. Enige invoer is de memoriaalboeking-id; organisatie, administratie, gebruiker, bedragen, zijden, rekeningen, datum, boekjaar en valuta worden server-side afgeleid uit de gegrendelde kop en regels.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Source-level exactly-once, enforced on ledger_postings itself
--
--    The marker's primary key only protects calls that go through
--    post_manual_journal(). It does not protect the table: authenticated has
--    a direct INSERT on ledger_postings, so after a legitimate posting an
--    assistant could still insert a SECOND balanced group for the same
--    journal under a different posting_group_id.
--
--    This trigger closes that by making the marker the single authority for
--    manual_journal rows. Deliberately scoped to source_type =
--    'manual_journal' only — the same discipline as the purchase, sales and
--    bank guards. It goes further than those, because the source line id is
--    durable here: every ledger row must point at a real line of the claimed
--    journal and carry exactly that line's account and amounts, so a
--    same-transaction raw-SQL caller cannot add, alter or re-side a leg under
--    the claimed group. line_no must lie within the marker's line_count and
--    the partial unique index below stops one line from being mirrored twice
--    (which the foundation's (group, line_no) key alone would not catch).
--
--    A reversal is refused outright: a future reversal engine writes NEW rows
--    with its OWN source_type, never 'manual_journal' rows pointing back.
--
--    Integrity, not authorization: no auth.uid(), no has_min_role() (patterns
--    §5B) — this must hold for every DML path, including service-role or
--    maintenance paths where auth.uid() is legitimately NULL.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_manual_journal_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.manual_journal_postings%ROWTYPE;
  v_line   public.manual_journal_lines%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'manual_journal' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een memoriaalregel in het grootboek moet naar een memoriaalboeking verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.manual_journal_postings
  WHERE manual_journal_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een memoriaalboeking kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte memoriaalboeking'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_date <> v_marker.posting_date THEN
    RAISE EXCEPTION 'Boekingsdatum van deze regel wijkt af van de geboekte memoriaalboeking'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.line_no < 1 OR NEW.line_no > v_marker.line_count THEN
    RAISE EXCEPTION 'Een memoriaalboeking van % regels heeft geen regel %', v_marker.line_count, NEW.line_no
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reversal_of_posting_id IS NOT NULL THEN
    RAISE EXCEPTION 'Een tegenboeking gebruikt een eigen bronsoort' USING ERRCODE = '23514';
  END IF;

  IF NEW.source_line_id IS NULL THEN
    RAISE EXCEPTION 'Een memoriaalregel in het grootboek moet naar een memoriaalregel verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.manual_journal_lines
  WHERE id = NEW.source_line_id
    AND manual_journal_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_line_id hoort niet bij deze memoriaalboeking' USING ERRCODE = '23514';
  END IF;

  IF NEW.grootboekrekening_id <> v_line.grootboekrekening_id
     OR NEW.debit_amount <> v_line.debit_amount
     OR NEW.credit_amount <> v_line.credit_amount THEN
    RAISE EXCEPTION 'Grootboekregel wijkt af van de bevroren memoriaalregel' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_manual_journal_source_claim() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so organization_id is
-- already resolved when it is compared against the marker.
DROP TRIGGER IF EXISTS validate_manual_journal_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_manual_journal_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_manual_journal_source_claim();

-- One ledger row per source line per group. The claim trigger validates each
-- row against its line but cannot see a sibling row inserted earlier in the
-- SAME transaction under a different line_no; without this index a raw-SQL
-- caller inside the posting transaction could mirror one line twice (say
-- line_no 3 and 4 both pointing at line X) and the group would still balance
-- only by accident. Partial on the source type so it costs nothing for any
-- other writer and never constrains their NULL source_line_id rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_manual_journal_line
  ON public.ledger_postings (posting_group_id, source_line_id)
  WHERE source_type = 'manual_journal';

COMMENT ON FUNCTION public.enforce_manual_journal_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=manual_journal exact overeenkomt met de claim in manual_journal_postings én met de bevroren memoriaalregel (source_line_id: rekening en bedragen). Sluit een tweede boekingsgroep, een extra of afwijkende regel en een tegenboeking onder deze bronsoort uit.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) A posted memoriaalboeking is frozen — header and lines
--
--    Without this, a plain PostgREST UPDATE or DELETE (or a
--    save_manual_journal_lines() call) would happily change or remove an
--    already-posted journal. The ledger would then describe an entry the
--    source no longer contains, with nothing revealing the divergence — and
--    the ledger rows' source_line_id would dangle.
--
--    Header, frozen once a marker exists: id, organization_id, client_id,
--    user_id, posting_date, description, reference — every column that fed
--    the entry (description is the fallback text of the ledger rows;
--    reference is the human audit key). created_at and updated_at remain free
--    (update_manual_journals_updated_at keeps bumping the latter). DELETE is
--    refused outright, which also means the lines' ON DELETE CASCADE can never
--    fire for a posted journal.
--
--    Lines: INSERT, UPDATE and DELETE are all refused once the journal is
--    posted. Explicit TG_OP branches; OLD and NEW are checked independently
--    and never through COALESCE(NEW.x, OLD.x) — on UPDATE, NEW is always
--    present, so a COALESCE would never examine OLD and a line could be moved
--    OFF a posted journal undetected (the 6C-b3 bug class). manual_journal_id
--    cannot change anyway (section 2), but the guard does not lean on that.
--
--    INSERT ordering subtlety: a BEFORE INSERT trigger runs BEFORE the row's
--    foreign key takes its KEY SHARE lock on the header, so a raw line INSERT
--    racing a post could pass the marker check while the poster's marker is
--    still uncommitted and then land after the poster committed. The INSERT
--    branch therefore takes FOR KEY SHARE on the header itself, first: it
--    waits behind the poster's FOR UPDATE, and after the poster commits the
--    marker check (a fresh READ COMMITTED snapshot) refuses. Only on INSERT —
--    on UPDATE/DELETE PostgreSQL locks the line tuple before firing the BEFORE
--    trigger, which already serialises against the poster's LOCK 2, and taking
--    a header lock AFTER a line lock would invert the documented lock order.
--
--    Integrity, not authorization (patterns §5B): no auth.uid(), no role.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_posted_manual_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.manual_journal_postings WHERE manual_journal_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; verwijderen is niet mogelijk. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF EXISTS (
    SELECT 1 FROM public.manual_journal_postings WHERE manual_journal_id = OLD.id
  ) THEN
    IF NEW.id                 IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.client_id       IS DISTINCT FROM OLD.client_id
       OR NEW.user_id         IS DISTINCT FROM OLD.user_id
       OR NEW.posting_date    IS DISTINCT FROM OLD.posting_date
       OR NEW.description     IS DISTINCT FROM OLD.description
       OR NEW.reference       IS DISTINCT FROM OLD.reference
    THEN
      RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id AND EXISTS (
    SELECT 1 FROM public.manual_journal_postings WHERE manual_journal_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Deze memoriaalboeking-identiteit is al geboekt; een andere memoriaalboeking kan er niet naartoe worden verplaatst. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.prevent_posted_manual_journal_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialise against a poster in flight BEFORE looking for its marker
    -- (see the section comment). Same transaction as save_manual_journal_lines
    -- already holds FOR UPDATE on this row, so this never self-blocks.
    PERFORM 1 FROM public.manual_journals WHERE id = NEW.manual_journal_id FOR KEY SHARE;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
    SELECT 1 FROM public.manual_journal_postings
    WHERE manual_journal_id = NEW.manual_journal_id
  ) THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; regels kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1 FROM public.manual_journal_postings
    WHERE manual_journal_id = OLD.manual_journal_id
  ) THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is geboekt; regels kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_manual_journal_mutation()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_posted_manual_journal_line_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posted_manual_journal_mutation_trigger ON public.manual_journals;
CREATE TRIGGER prevent_posted_manual_journal_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.manual_journals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_manual_journal_mutation();

DROP TRIGGER IF EXISTS prevent_posted_manual_journal_line_mutation_trigger ON public.manual_journal_lines;
CREATE TRIGGER prevent_posted_manual_journal_line_mutation_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.manual_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_manual_journal_line_mutation();

COMMENT ON FUNCTION public.prevent_posted_manual_journal_mutation() IS
'Bevriest een geboekte memoriaalboeking: id, organisatie, administratie, gebruiker, boekingsdatum, omschrijving en referentie kunnen niet meer wijzigen en de kop kan niet worden verwijderd (waardoor de cascade naar de regels nooit een geboekte regel kan raken). created_at/updated_at blijven vrij.';

COMMENT ON FUNCTION public.prevent_posted_manual_journal_line_mutation() IS
'Weigert elke INSERT, UPDATE en DELETE op de regels van een geboekte memoriaalboeking, voor elke rol. Grendelt bij INSERT eerst de kop (FOR KEY SHARE) zodat een regel nooit ná een gelijktijdige boeking kan binnenkomen.';

COMMENT ON FUNCTION public.enforce_manual_journal_client_org() IS
'Bewaakt dat de administratie van een memoriaalboeking binnen haar organisatie valt, en weigert een wijziging van administratie zolang er regels zijn.';

COMMENT ON FUNCTION public.set_manual_journal_line_org() IS
'Neemt organization_id van een memoriaalregel altijd over van de kop en weigert het wijzigen van manual_journal_id.';
