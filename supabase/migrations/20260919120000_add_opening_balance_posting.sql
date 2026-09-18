-- Migration: opening balance postings — beginbalans (phase 6C-b8, PR 1: schema + writer)
--
-- Purpose: the fifth production accounting writer, and the first one whose
-- source is an assertion from OUTSIDE BoekAssist. A beginbalans states what the
-- ledger of one administratie stood at on one date, on the authority of a
-- predecessor system, a jaarrekening or a founding balance sheet. It is
-- composed as a draft (header + N lines, each line DEBIT or CREDIT on one
-- grootboekrekening) and then posted, exactly once, as one balanced, immutable,
-- tenant-safe group in public.ledger_postings.
--
-- Contents:
--   1. public.opening_balances          — the draft header (editable until posted or nil-declared)
--   2. public.opening_balance_lines     — the draft lines (editable until posted or nil-declared)
--   3. public.opening_balance_postings  — the atomic source-claim marker
--   4. RLS + grants (including the column-level grants that make the nil
--      columns unwritable outside the RPC)
--   5. ledger_client_lock_key / lock_ledger_client  — the per-administratie ledger lock
--   6. public.save_opening_balance_lines(uuid, jsonb) — atomic replace of a draft's lines
--   7. public.post_opening_balance(uuid)             — the only supported ledger write path
--   8. public.declare_opening_balance_nil(uuid)      — the audited "no opening balance" assertion
--   9. enforce_opening_balance_source_claim()        — ledger_postings guard for this source
--  10. lock_ledger_client_for_posting() + enforce_no_posting_before_opening_balance()
--      — every ledger write serialises per administratie; nothing may be posted before it
--  11. freeze — posted OR nil-declared header and lines become immutable
--
-- NO BACKFILL. Nothing existing is posted, converted or read for figures by
-- this migration. public.journal_entries is NOT touched, NOT read and NOT
-- migrated: there is deliberately not a single reference to it in this file.
-- There is not a single INSERT INTO public.ledger_postings outside the
-- post_opening_balance() body. Nothing is auto-posted on save.
--
-- NO UI in this PR. This file ships the schema, the three RPCs and their
-- guards; hooks, pages, reporting labels, completeness states and generated
-- types follow in separate PRs once the migration has been applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY DEDICATED TABLES, NOT manual_journals
--
-- A beginbalans is not a memoriaalboeking that happens to be first. Three
-- things are true of it and of nothing else in this schema:
--   • it is at most ONE effective assertion per administratie, ever, so it
--     needs a uniqueness domain that a memoriaal must not have;
--   • "deliberately no opening balance" is a real accounting state that must be
--     recorded — and it CANNOT be a posting: public.ledger_postings requires
--     at least two rows and SUM(debit) = SUM(credit) > 0 (6C-b2 section 8b), so
--     a zero opening balance is unrepresentable in the ledger by construction.
--     It therefore lives on the header as an audited nil declaration;
--   • it must be the EARLIEST accounting fact of its administratie, which is a
--     precondition no other writer has.
-- Expressing any of that on manual_journals would change the meaning of every
-- existing memoriaalboeking. So the beginbalans gets its own greenfield tables,
-- following ledger_postings (20260914120000) and manual_journals (20260918120000).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ENTRY — one group, one ledger row per line, as stored
--
--   for each opening_balance_lines row, ORDER BY sort_order, id:
--     line.debit_amount  > 0  →  DEBIT   line.grootboekrekening_id   line.debit_amount
--     line.credit_amount > 0  →  CREDIT  line.grootboekrekening_id   line.credit_amount
--
-- The writer mirrors the lines exactly as they were stored. There are NO
-- implicit legs: no suspense account, no equity account, no rounding line, no
-- automatic VAT. If the entry does not balance it is REFUSED with the two
-- totals and the difference in the message — the system never balances it on
-- the user's behalf, because inventing the balancing leg would be inventing the
-- one accounting fact the bookkeeper is supposed to supply.
--
-- CATEGORY: none of this reads grootboekrekeningen.categorie. Activa, passiva,
-- omzet, kosten, privé and free text are all equally postable. The column is
-- unconstrained text, it conflates liabilities with equity, and privé has no
-- statement placement — so no accounting rule is derived from it here (owner
-- decision, v1). A mid-year cutover legitimately needs revenue and expense
-- opening figures, which a balance-sheet-only rule would refuse.
--
-- DECIMALS — the same honest split as 6C-b6. numeric(12,2) ROUNDS a direct
-- write to two decimals before any CHECK can run, so a "x = round(x, 2)" table
-- CHECK could never fail and is deliberately NOT declared. save_opening_balance_lines()
-- checks the incoming JSON value in an UNCONSTRAINED numeric BEFORE the cast
-- and refuses >2 decimals; that is the only path that refuses instead of
-- rounding. post_opening_balance() keeps an equivalent filter that is
-- unreachable through the typmod, so the writer does not lean on a column type
-- it does not own.
--
-- NaN — 'NaN'::numeric is a legal numeric and passes every ordinary amount
-- predicate (NaN >= 0, NaN > 0, NaN = round(NaN, 2), and even SUM(debit) <>
-- SUM(credit) is FALSE because NaN = NaN is TRUE in PostgreSQL). One NaN line
-- would post and turn every SUM over that account into NaN forever. Three
-- layers refuse it: the CHECK on the lines table and on the marker's
-- total_amount ("x <> 'NaN'::numeric" evaluates to FALSE for NaN, which is the
-- point), the save RPC per element, and the poster over the locked lines
-- BEFORE the balance comparison.
--
-- DATE AND BOEKJAAR — calendar-year fiscal model only (owner decision, v1).
--   posting_date = opening_balances.opening_date, chosen by the accountant and
--   CHECK-bounded to the 2000..2100 window ledger_postings.boekjaar accepts.
--   boekjaar     = EXTRACT(YEAR FROM opening_date), identical to the purchase,
--                  sales, bank and memoriaal writers. Enforced twice: a table
--                  CHECK on the header (so no draft can hold a combination the
--                  poster would have to refuse) and again in the poster (which
--                  does not lean on a constraint it does not own).
--   Broken fiscal years are NOT supported in v1. Nothing in this schema knows a
--   fiscal-year start — clients carries afgesloten_boekjaar (an integer) and
--   nothing else, and every period helper in the app is calendar-year. A real
--   fiscal calendar is a phase of its own; this file does not pretend to have
--   one. A MID-YEAR cutover is supported: opening_date may be any date inside
--   its boekjaar, so 2027-07-01 for boekjaar 2027 is accepted.
--
--   Consequence, stated rather than worked around: with opening_date =
--   2027-01-01 and the proef- en saldibalans viewed over calendar 2027, the
--   opening rows fall INSIDE the period, so they appear in the period columns
--   and the beginsaldo column reads 0. The eindsaldo is correct either way, and
--   this is truthful — there is indeed no posting before 1 January. No report
--   ever gets an arithmetic special case for this source type.
--
-- EARLIEST FACT — post_opening_balance() refuses when the administratie
-- already has ANY ledger posting before opening_date. Without that rule an
-- opening balance silently double-counts everything that precedes it, and no
-- later check would ever catch it: the group itself balances, so every
-- invariant in 6C-b2 and every self-check in the reporting kernel stays happy
-- while the figures are wrong. The mirror image — a back-dated purchase, sales,
-- bank or memoriaal row posted AFTER the beginbalans, into the period it
-- already summarises — is the same double count from the other side, and is
-- refused by the trigger in section 10. Neither direction relies on a snapshot
-- read: section 10 makes every ledger write take one per-administratie advisory
-- lock first, so the two sides are genuinely serialised rather than merely
-- checked.
--
-- source_type = 'opening_balance' (the value the foundation's COMMENT already
-- reserved), source_id = opening_balances.id, source_line_id =
-- opening_balance_lines.id.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY source_line_id IS PERSISTED HERE
--
-- BOOKASSIST_ACCOUNTING_PATTERNS.md §2 forbids persisting source_line_id unless
-- the line id is provably durable for the lifetime of the posting. It is, by
-- construction and not by convention:
--   • save_opening_balance_lines() only exists for a DRAFT. It refuses (42501)
--     as soon as a marker exists or the header is nil-declared, and the line
--     freeze trigger (section 11) refuses every INSERT/UPDATE/DELETE on the
--     lines of a posted or nil-declared header for every role.
--   • the poster locks header AND lines (FOR UPDATE) before reading them and
--     writes the marker BEFORE the first ledger row, in one transaction. A
--     concurrent save either finishes first (the poster then reads and persists
--     the ids of the new line set) or waits on the header and is refused.
-- After posting, no code path can replace, renumber or remove a line, so the id
-- a ledger row points at is the id that will always exist.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- STATE MACHINE — draft / posted / nil
--
--   draft    : a header exists; no marker row; nil_declared_at IS NULL.
--              Editable by an assistant. A client may hold SEVERAL drafts at
--              once — a draft asserts nothing, so nothing is ambiguous yet.
--   posted   : a row exists in public.opening_balance_postings for this header.
--              Derived, never stored: there is no mutable status column, so the
--              state can never disagree with the ledger.
--   nil      : nil_declaration = true AND nil_declared_at IS NOT NULL on the
--              header. No marker row, no ledger row — an explicit, audited
--              statement that this administratie deliberately has no opening
--              balance. A table CHECK makes the three nil columns move as one,
--              so "nil_declaration = true" without a timestamp cannot exist.
--
--   transitions:  draft → posted   via post_opening_balance()          (accountant)
--                 draft → nil      via declare_opening_balance_nil()   (accountant)
--                 draft → deleted  ordinary DELETE                      (accountant)
--                 posted/nil → *   NONE. Both are terminal in v1 and frozen by
--                                  section 11. A correction requires the future
--                                  reversal engine.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DOMAIN UNIQUENESS — at most one EFFECTIVE assertion per administratie
--
-- Forbidden, in all three combinations: two posted opening balances, two nil
-- declarations, and a posted one together with a nil declaration. Enforced by
-- three mechanisms that each cover what the others cannot:
--
--   (a) UNIQUE INDEX uniq_opening_balance_postings_client ON
--       opening_balance_postings (client_id)
--       — the declarative backstop for two concurrent posts of DIFFERENT
--       headers of the same administratie. In practice the advisory lock in (c)
--       serialises them first, so the second caller is refused with a readable
--       message rather than a unique_violation; the index is what still holds if
--       a caller ever reaches the marker without that lock. Deliberately an
--       INDEX, not a PRIMARY KEY and not a UNIQUE CONSTRAINT — see RELAXATION.
--
--   (b) UNIQUE INDEX uniq_opening_balance_nil_per_client ON
--       opening_balances (client_id) WHERE nil_declared_at IS NOT NULL
--       — declarative and genuinely partial: it constrains only nil-declared
--       headers, so any number of drafts remain legal. Two concurrent nil
--       declarations of different headers of one administratie serialise on it
--       exactly as (a) does for posts.
--
--   (c) the CROSS-kind rule (posted vs nil) cannot be one index, because the
--       two states live in two tables. It is enforced by a transaction-scoped
--       ADVISORY LOCK keyed on client_id, taken by BOTH RPCs before either
--       reads the other's state (sections 7 and 8), plus a BEFORE INSERT trigger
--       on the marker. The advisory lock is what makes it race-free rather than
--       merely checked: without it, post and nil could each read "the other
--       state does not exist" from their own snapshot and both commit.
--       The only two writers of either state are the two SECURITY DEFINER RPCs
--       (the marker table is not writable by any application role, and the nil
--       columns are excluded from the column-level INSERT/UPDATE grants), so
--       there is no third path that could skip the lock. Both directions of the
--       rule are ALSO refused declaratively, for callers that no grant can stop
--       (a definer- or owner-level statement in the SQL editor): the marker
--       trigger refuses a claim for a nil-declared administratie, and the freeze
--       trigger in section 11 refuses a nil declaration for an administratie
--       that already has a claim.
--
-- ISOLATION: both RPCs refuse anything other than READ COMMITTED, for the same
-- reason 6C-b2 does. Under REPEATABLE READ a transaction can establish its
-- snapshot BEFORE waiting on the advisory lock and then still read the stale
-- state after acquiring it, so ordering alone would not prevent a post and a
-- nil declaration from both committing.
--
-- RELAXATION — how a future reversal phase opens this up without a rebuild.
-- (a) is an INDEX, so reversal adds its own column and swaps the index in one
-- statement pair, touching no table definition, no primary key and no foreign
-- key:
--     ALTER TABLE public.opening_balance_postings
--       ADD COLUMN IF NOT EXISTS reversed_at timestamptz NULL;
--     DROP INDEX IF EXISTS public.uniq_opening_balance_postings_client;
--     CREATE UNIQUE INDEX uniq_opening_balance_postings_client
--       ON public.opening_balance_postings (client_id) WHERE reversed_at IS NULL;
-- (b) is already partial and relaxes the same way (add a withdrawn_at column,
-- extend the predicate). Had (a) been a PRIMARY KEY on client_id, the same
-- change would have meant dropping and recreating the key that the marker's own
-- identity rests on. The freeze in section 11 and the append-only ledger are
-- untouched by any of this: a reversal still writes NEW rows under its OWN
-- source_type and never edits a posted one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK ORDER — documented once here, followed exactly in all three RPC bodies
--
--   advisory lock on client_id (public.lock_ledger_client)       -- LOCK 0
--     → opening_balances row (FOR UPDATE)                        -- LOCK 1
--       → opening_balance_lines rows, ORDER BY sort_order, id (FOR UPDATE)  -- LOCK 2 (poster only)
--         → reads: client, accounts, aggregates, earlier postings
--           → claim INSERT (marker)
--             → ledger INSERTs  → LOCK 0 again (no-op, already held)
--                               → 6C-b2 posting-group advisory lock
--
-- LOCK 0 is NOT limited to these two RPCs. Every INSERT into ledger_postings
-- takes it first, through a trigger on the table (section 10) — that is what
-- makes the "earliest fact" invariant enforceable at all, and it fixes the
-- global order at: client lock → posting-group lock → row locks.
--
-- LOCK 0 before LOCK 1, always and in both directions, so the two RPCs can
-- never build a cycle between an administratie and a header. LOCK 0 is a
-- transaction-scoped advisory lock and is released at COMMIT or ROLLBACK, so it
-- cannot leak into a pooled Supabase connection, and a rolled-back transaction
-- hands it straight to whoever was waiting.
--
-- save_opening_balance_lines() does NOT take LOCK 0: it neither reads nor
-- writes an assertion, it only rewrites draft lines, and taking a
-- per-administratie lock for an ordinary keystroke-level save would serialise
-- unrelated drafts. It takes LOCK 1, the same header lock the poster takes, so
-- save and post still serialise on the header: post after save reads the
-- committed new line set; save after post blocks and is then refused because
-- the marker exists. A mixed old/new line set can never be posted.
--
-- client_id is immutable ON A ROW (it is not in the column-level UPDATE grant,
-- and enforce_opening_balance_client_org() refuses a change outright), so
-- moving a draft to another administratie means deleting it and creating a new
-- one. That is NOT by itself enough to make LOCK 0 sound: the header id is
-- caller-suppliable and a draft may be deleted and re-created under the same id
-- for a DIFFERENT administratie while another session waits at LOCK 0. Both
-- RPCs therefore re-check, after LOCK 1, that the row they locked still belongs
-- to the administratie whose advisory lock they hold, and abort with 40001 if
-- it does not.
--
-- Deadlock, non-application paths only: a raw MULTI-ROW line statement in the
-- SQL editor locks line rows in heap order while the poster locks them in
-- (sort_order, id) order; and a raw transaction that UPDATEs a line and then
-- INSERTs one inverts header → lines. PostgreSQL detects both (40P01) and
-- aborts one side; nothing partial is ever committed. The app's own line writes
-- go through save_opening_balance_lines(), which locks the header first.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLES (owner decisions, v1)
--
--   draft / edit                       assistant
--   post_opening_balance()             accountant
--   declare_opening_balance_nil()      accountant
--   read                               read_only
--
-- Both accountant floors are checked INSIDE the SECURITY DEFINER functions
-- against the organisation stored on the locked header, never against caller
-- input. A nil declaration is an accounting assertion with the same standing as
-- a posting — "this administratie deliberately starts at zero" — so it sits at
-- the same floor.
--
-- DOCUMENTED EXCEPTION — opening_balance_lines DELETE floor = assistant, where
-- the rest of the schema uses accountant: save_opening_balance_lines() is
-- SECURITY INVOKER and replaces a draft's lines with DELETE + INSERT under the
-- caller's own RLS, so an assistant who may edit a draft must be able to delete
-- its lines. Draft lines only — the freeze refuses every mutation on the lines
-- of a posted or nil-declared header for every role, without consulting roles.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFERRED, deliberately — the schema stays compatible with all of it
--
--   • REVERSAL ENGINE. No reversal columns here. A reversal writes a NEW ledger
--     group with reversal_of_posting_id set and its OWN source_type; the claim
--     trigger in section 9 refuses any 'opening_balance' row that carries
--     reversal_of_posting_id, so a reversal can never masquerade as, or be
--     appended to, an original beginbalans group. UNTIL IT EXISTS, POSTING IS
--     FINAL: a posted or nil-declared beginbalans cannot be edited, re-posted,
--     withdrawn or deleted by any role.
--   • CSV IMPORT of a trial balance. Out of scope; manual entry first. An
--     import would feed save_opening_balance_lines() and inherit every rule
--     here unchanged.
--   • AUTOMATIC EQUITY ACCOUNT. Nothing is created or seeded. The seeded
--     SnelStart-12 chart contains no equity account; choosing or creating one
--     is the bookkeeper's decision, not this migration's.
--   • NUMBERING, automatic VAT, SnelStart export of these postings. Untouched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK PRECONDITION — read this before running the block below
--
-- The rollback is safe ONLY BEFORE the first opening balance has been posted,
-- i.e. while public.opening_balance_postings is empty and public.ledger_postings
-- holds no source_type = 'opening_balance' row. ledger_postings is append-only
-- (6C-b2: no UPDATE, no DELETE, TRUNCATE blocked), so once a beginbalans has
-- been posted, dropping these tables would leave its ledger rows pointing at a
-- source_id / source_line_id that no longer exists — permanently orphaned, with
-- no way to explain them, and no way to remove them either. Check first:
--   SELECT count(*) FROM public.ledger_postings WHERE source_type = 'opening_balance';
-- and do not run the rollback unless that is 0. A nil declaration writes no
-- ledger row, so it does not block the rollback — but dropping the tables does
-- silently discard that audited assertion, which is a decision, not a no-op.
-- After a posting the only correction path is the future reversal engine.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_no_posting_before_opening_balance_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS lock_ledger_client_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS validate_opening_balance_source_claim_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS prevent_settled_opening_balance_line_mutation_trigger ON public.opening_balance_lines;
--   DROP TRIGGER IF EXISTS set_opening_balance_line_scope_trigger ON public.opening_balance_lines;
--   DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.opening_balance_lines;
--   DROP TRIGGER IF EXISTS update_opening_balance_lines_updated_at ON public.opening_balance_lines;
--   DROP TRIGGER IF EXISTS prevent_settled_opening_balance_mutation_trigger ON public.opening_balances;
--   DROP TRIGGER IF EXISTS update_opening_balances_updated_at ON public.opening_balances;
--   DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.opening_balances;
--   DROP TRIGGER IF EXISTS validate_opening_balance_client_org_trigger ON public.opening_balances;
--   DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.opening_balances;
--   DROP TRIGGER IF EXISTS validate_opening_balance_marker_exclusivity_trigger ON public.opening_balance_postings;
--   DROP FUNCTION IF EXISTS public.enforce_no_posting_before_opening_balance();
--   DROP FUNCTION IF EXISTS public.lock_ledger_client_for_posting();
--   DROP FUNCTION IF EXISTS public.enforce_opening_balance_source_claim();
--   DROP FUNCTION IF EXISTS public.prevent_settled_opening_balance_line_mutation();
--   DROP FUNCTION IF EXISTS public.prevent_settled_opening_balance_mutation();
--   DROP FUNCTION IF EXISTS public.enforce_opening_balance_marker_exclusivity();
--   DROP FUNCTION IF EXISTS public.declare_opening_balance_nil(uuid);
--   DROP FUNCTION IF EXISTS public.post_opening_balance(uuid);
--   DROP FUNCTION IF EXISTS public.save_opening_balance_lines(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.set_opening_balance_line_scope();
--   DROP FUNCTION IF EXISTS public.enforce_opening_balance_client_org();
--   DROP FUNCTION IF EXISTS public.lock_ledger_client(uuid);
--   DROP FUNCTION IF EXISTS public.ledger_client_lock_key(uuid);
--   DROP POLICY IF EXISTS role_opening_balance_postings_select ON public.opening_balance_postings;
--   DROP POLICY IF EXISTS role_opening_balance_lines_delete ON public.opening_balance_lines;
--   DROP POLICY IF EXISTS role_opening_balance_lines_update ON public.opening_balance_lines;
--   DROP POLICY IF EXISTS role_opening_balance_lines_insert ON public.opening_balance_lines;
--   DROP POLICY IF EXISTS role_opening_balance_lines_select ON public.opening_balance_lines;
--   DROP POLICY IF EXISTS role_opening_balances_delete ON public.opening_balances;
--   DROP POLICY IF EXISTS role_opening_balances_update ON public.opening_balances;
--   DROP POLICY IF EXISTS role_opening_balances_insert ON public.opening_balances;
--   DROP POLICY IF EXISTS role_opening_balances_select ON public.opening_balances;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_opening_balance_line;
--   DROP INDEX IF EXISTS public.uniq_opening_balance_postings_client;
--   DROP INDEX IF EXISTS public.idx_opening_balance_postings_organization;
--   DROP INDEX IF EXISTS public.idx_opening_balance_postings_user_id;
--   DROP INDEX IF EXISTS public.idx_opening_balance_lines_grootboekrekening_id;
--   DROP INDEX IF EXISTS public.idx_opening_balance_lines_organization;
--   DROP INDEX IF EXISTS public.idx_opening_balance_lines_opening_balance;
--   DROP INDEX IF EXISTS public.uniq_opening_balance_nil_per_client;
--   DROP INDEX IF EXISTS public.idx_opening_balances_nil_declared_by;
--   DROP INDEX IF EXISTS public.idx_opening_balances_user_id;
--   DROP INDEX IF EXISTS public.idx_opening_balances_client_boekjaar;
--   DROP INDEX IF EXISTS public.idx_opening_balances_organization;
--   DROP TABLE IF EXISTS public.opening_balance_postings;
--   DROP TABLE IF EXISTS public.opening_balance_lines;
--   DROP TABLE IF EXISTS public.opening_balances;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Prerequisite guard
--
--    plpgsql does not validate table or function references at CREATE FUNCTION
--    time, so without this the file would apply without a single error on a
--    database that never received 6C-b2, and post_opening_balance() would only
--    fail at first use with a raw "relation does not exist". Required order:
--    6C-b2 foundation → this file. The role ladder and clients.afgesloten_boekjaar
--    are older and are checked for completeness.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst 6C-b2 (public.ledger_postings ontbreekt)';
  END IF;
  IF to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst 6C-b2 (public.posting_account_ok(uuid,uuid,uuid) ontbreekt)';
  END IF;
  IF to_regprocedure('public.posting_client_org_ok(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst 6C-b2 (public.posting_client_org_ok(uuid,uuid) ontbreekt)';
  END IF;
  IF to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst de rollenladder (public.has_min_role(uuid,uuid,app_role) ontbreekt)';
  END IF;
  IF to_regprocedure('public.set_organization_id()') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst public.set_organization_id() (ontbreekt)';
  END IF;
  IF to_regprocedure('public.prevent_org_user_rebind()') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst public.prevent_org_user_rebind() (ontbreekt)';
  END IF;
  IF to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst public.update_updated_at_column() (ontbreekt)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'afgesloten_boekjaar'
  ) THEN
    RAISE EXCEPTION 'Migratie 6C-b8 vereist eerst clients.afgesloten_boekjaar (ontbreekt)';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The draft header
--
--    No mutable status column: "posted" is derived from the marker and "nil"
--    from nil_declared_at, so neither state can ever disagree with the ledger
--    or with the audit trail.
--
--    The three nil columns move as one, enforced by a CHECK. nil_declaration
--    on its own would be a boolean anybody could flip; with the CHECK, a nil
--    state that carries no timestamp and no declaring user cannot exist at all,
--    which is what makes "nil" an assertion rather than a flag.
--
--    boekjaar = EXTRACT(YEAR FROM opening_date) is a table CHECK, so no draft
--    can hold a combination the poster would have to refuse later. EXTRACT over
--    a date is immutable, so it is legal in a CHECK.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.opening_balances (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL,
  client_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  boekjaar         integer     NOT NULL
                               CONSTRAINT opening_balances_boekjaar_check
                               CHECK (boekjaar BETWEEN 2000 AND 2100),
  opening_date     date        NOT NULL
                               CONSTRAINT opening_balances_opening_date_check
                               CHECK (opening_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  description      text        NULL,
  reference        text        NULL,
  nil_declaration  boolean     NOT NULL DEFAULT false,
  nil_declared_at  timestamptz NULL,
  nil_declared_by  uuid        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Calendar-year fiscal model (owner decision, v1).
  CONSTRAINT opening_balances_boekjaar_matches_date_check
    CHECK (boekjaar = EXTRACT(YEAR FROM opening_date)::integer),

  -- All three nil columns are set together or none of them is.
  CONSTRAINT opening_balances_nil_consistent_check
    CHECK (
      (nil_declaration = false AND nil_declared_at IS NULL     AND nil_declared_by IS NULL)
      OR
      (nil_declaration = true  AND nil_declared_at IS NOT NULL AND nil_declared_by IS NOT NULL)
    )
);

-- RESTRICT throughout: a beginbalans is accounting identity. An organisation,
-- administratie or user that has one cannot be hard-deleted underneath it —
-- the same accepted consequence as ledger_postings and manual_journals.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'opening_balances'
      AND c.conname = 'opening_balances_organization_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balances
      ADD CONSTRAINT opening_balances_organization_id_fkey
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
      AND t.relname = 'opening_balances'
      AND c.conname = 'opening_balances_client_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balances
      ADD CONSTRAINT opening_balances_client_id_fkey
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
      AND t.relname = 'opening_balances'
      AND c.conname = 'opening_balances_user_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balances
      ADD CONSTRAINT opening_balances_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- The declaring accountant must stay identifiable: a nil declaration is an
-- audited accounting assertion and its author may not become a dangling uuid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'opening_balances'
      AND c.conname = 'opening_balances_nil_declared_by_fkey'
  ) THEN
    ALTER TABLE public.opening_balances
      ADD CONSTRAINT opening_balances_nil_declared_by_fkey
      FOREIGN KEY (nil_declared_by) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- Serves the organisation RESTRICT FK and the RLS policy predicate.
CREATE INDEX IF NOT EXISTS idx_opening_balances_organization
  ON public.opening_balances (organization_id);

-- The list screen of the future UI, and the client RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_opening_balances_client_boekjaar
  ON public.opening_balances (client_id, boekjaar);

-- Serves the auth.users RESTRICT FKs, which would otherwise scan the table on
-- every user delete attempt.
CREATE INDEX IF NOT EXISTS idx_opening_balances_user_id
  ON public.opening_balances (user_id);

CREATE INDEX IF NOT EXISTS idx_opening_balances_nil_declared_by
  ON public.opening_balances (nil_declared_by)
  WHERE nil_declared_by IS NOT NULL;

-- DOMAIN UNIQUENESS (b): at most one nil declaration per administratie.
-- Genuinely partial — drafts are unconstrained, and a future phase relaxes it
-- by extending the predicate (see DOMAIN UNIQUENESS in the header).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_opening_balance_nil_per_client
  ON public.opening_balances (client_id)
  WHERE nil_declared_at IS NOT NULL;

-- organization_id derivation — the shared trigger, exactly as on the other
-- domain tables: respects an explicit value, otherwise derives it from
-- client_id, and hard-fails if it cannot. NOT redefined here.
DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.opening_balances;
CREATE TRIGGER set_organization_id_trigger
  BEFORE INSERT ON public.opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.set_organization_id();

-- Tenant consistency: the administratie must belong to the header's
-- organisation. Reuses posting_client_org_ok() (6C-b2), so there is exactly one
-- definition of that rule in the schema.
CREATE OR REPLACE FUNCTION public.enforce_opening_balance_client_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van deze beginbalans'
      USING ERRCODE = '23514';
  END IF;

  -- client_id is immutable: it is excluded from the column-level UPDATE grant,
  -- and refused here as well so an owner- or definer-level UPDATE cannot move a
  -- header to another administratie behind the advisory lock's back.
  IF TG_OP = 'UPDATE' AND NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'De administratie van een beginbalans kan niet worden gewijzigd; verwijder het concept en maak een nieuwe beginbalans'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_opening_balance_client_org() FROM PUBLIC;

-- "validate_" sorts after "set_organization_id_trigger", so organization_id is
-- already resolved when it is compared against the client.
DROP TRIGGER IF EXISTS validate_opening_balance_client_org_trigger ON public.opening_balances;
CREATE TRIGGER validate_opening_balance_client_org_trigger
  BEFORE INSERT OR UPDATE OF client_id, organization_id ON public.opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opening_balance_client_org();

-- organization_id and user_id are immutable after insert, as on every other
-- domain table (20260613001452). NOT redefined here.
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.opening_balances;
CREATE TRIGGER prevent_org_user_rebind_trg
  BEFORE UPDATE ON public.opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

DROP TRIGGER IF EXISTS update_opening_balances_updated_at ON public.opening_balances;
CREATE TRIGGER update_opening_balances_updated_at
  BEFORE UPDATE ON public.opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The freeze trigger is attached in section 11, after its function and the
-- marker table it reads exist.

COMMENT ON TABLE public.opening_balances IS
'Beginbalans (kop). Concept zolang er geen rij in opening_balance_postings bestaat en nil_declared_at leeg is; daarna bevroren. Bevat bewust geen status-kolom: geboekt wordt afgeleid uit de claim, nihil uit nil_declared_at. Per administratie is er hoogstens één effectieve bewering (geboekt OF nihil).';

COMMENT ON COLUMN public.opening_balances.nil_declaration IS
'TRUE wanneer een accountant expliciet heeft vastgelegd dat deze administratie bewust geen beginbalans heeft. Alleen te zetten via public.declare_opening_balance_nil(); een nihil-verklaring schrijft nooit een grootboekregel, omdat een saldo van nul in ledger_postings niet uit te drukken is (een boekingsgroep vereist debet = credit > 0).';

COMMENT ON COLUMN public.opening_balances.boekjaar IS
'Boekjaar van de beginbalans. Gelijk aan het kalenderjaar van opening_date (CHECK): v1 kent alleen een kalenderjaarmodel, gebroken boekjaren worden niet ondersteund.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) The draft lines
--
--    One line = one side. A DRAFT line may be 0/0 and may lack an account (a
--    bookkeeper types the account first and the amount later); the poster
--    refuses both, the table does not. A line may never be both debit and
--    credit, never negative and never NaN — those are refused at table level so
--    no draft can hold an amount the ledger could not represent.
--
--    client_id is stored alongside organization_id and is taken from the header
--    by trigger, never from the caller. It is what makes an account-scope check
--    possible on a line without joining back to the header every time, and it
--    keeps the line row self-describing for RLS and for the poster.
--
--    sort_order is NOT unique: a UI reorders lines by rewriting sort_order in
--    bulk and a transient duplicate during that rewrite must not fail. The
--    poster orders by (sort_order, id), so line_no is deterministic anyway.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.opening_balance_lines (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_balance_id    uuid          NOT NULL,
  organization_id       uuid          NOT NULL,
  client_id             uuid          NOT NULL,
  user_id               uuid          NOT NULL,
  grootboekrekening_id  uuid          NULL,
  debit_amount          numeric(12,2) NOT NULL DEFAULT 0
                                      CONSTRAINT opening_balance_lines_debit_amount_check
                                      CHECK (debit_amount >= 0),
  credit_amount         numeric(12,2) NOT NULL DEFAULT 0
                                      CONSTRAINT opening_balance_lines_credit_amount_check
                                      CHECK (credit_amount >= 0),
  description           text          NULL,
  sort_order            integer       NOT NULL DEFAULT 0,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT opening_balance_lines_single_side_check
    CHECK (debit_amount = 0 OR credit_amount = 0),

  -- NaN passes every predicate above (NaN >= 0 and NaN = 0 OR … are TRUE).
  -- "x <> 'NaN'::numeric" evaluates to FALSE for NaN, so this CHECK is the one
  -- that actually refuses it.
  CONSTRAINT opening_balance_lines_no_nan_check
    CHECK (debit_amount <> 'NaN'::numeric AND credit_amount <> 'NaN'::numeric)
);

-- The ONLY ON DELETE CASCADE in this file: deleting a DRAFT header removes its
-- lines. It can never reach a settled line, because a posted or nil-declared
-- header cannot be deleted (section 11 freeze + the RESTRICT FK from the marker).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'opening_balance_lines'
      AND c.conname = 'opening_balance_lines_opening_balance_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_lines
      ADD CONSTRAINT opening_balance_lines_opening_balance_id_fkey
      FOREIGN KEY (opening_balance_id) REFERENCES public.opening_balances (id)
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
      AND t.relname = 'opening_balance_lines'
      AND c.conname = 'opening_balance_lines_organization_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_lines
      ADD CONSTRAINT opening_balance_lines_organization_id_fkey
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
      AND t.relname = 'opening_balance_lines'
      AND c.conname = 'opening_balance_lines_client_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_lines
      ADD CONSTRAINT opening_balance_lines_client_id_fkey
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
      AND t.relname = 'opening_balance_lines'
      AND c.conname = 'opening_balance_lines_user_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_lines
      ADD CONSTRAINT opening_balance_lines_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- RESTRICT (purchase_invoice_lines precedent, 20260718213000): an account used
-- by a draft line cannot be deleted; no SET NULL that would quietly turn a
-- complete draft into an incomplete one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'opening_balance_lines'
      AND c.conname = 'opening_balance_lines_grootboekrekening_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_lines
      ADD CONSTRAINT opening_balance_lines_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id) REFERENCES public.grootboekrekeningen (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- The poster's LOCK 2 and every "lines of this beginbalans" read, in posting
-- order.
CREATE INDEX IF NOT EXISTS idx_opening_balance_lines_opening_balance
  ON public.opening_balance_lines (opening_balance_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_opening_balance_lines_organization
  ON public.opening_balance_lines (organization_id);

-- Serves the grootboekrekeningen RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_opening_balance_lines_grootboekrekening_id
  ON public.opening_balance_lines (grootboekrekening_id)
  WHERE grootboekrekening_id IS NOT NULL;

-- organization_id and client_id always come from the header, never from the
-- caller, and opening_balance_id can never be changed — a line cannot be moved
-- to another beginbalans.
CREATE OR REPLACE FUNCTION public.set_opening_balance_line_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org    uuid;
  v_client uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.opening_balance_id IS DISTINCT FROM OLD.opening_balance_id THEN
    RAISE EXCEPTION 'Een beginbalansregel kan niet naar een andere beginbalans worden verplaatst'
      USING ERRCODE = '22023';
  END IF;

  SELECT ob.organization_id, ob.client_id INTO v_org, v_client
  FROM public.opening_balances ob
  WHERE ob.id = NEW.opening_balance_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden voor deze regel' USING ERRCODE = 'P0002';
  END IF;

  NEW.organization_id := v_org;
  NEW.client_id       := v_client;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.set_opening_balance_line_scope() FROM PUBLIC;

-- "set_" sorts before "validate_" and before "prevent_", so scope is resolved
-- before anything compares it.
DROP TRIGGER IF EXISTS set_opening_balance_line_scope_trigger ON public.opening_balance_lines;
CREATE TRIGGER set_opening_balance_line_scope_trigger
  BEFORE INSERT OR UPDATE ON public.opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_opening_balance_line_scope();

DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.opening_balance_lines;
CREATE TRIGGER prevent_org_user_rebind_trg
  BEFORE UPDATE ON public.opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

DROP TRIGGER IF EXISTS update_opening_balance_lines_updated_at ON public.opening_balance_lines;
CREATE TRIGGER update_opening_balance_lines_updated_at
  BEFORE UPDATE ON public.opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.opening_balance_lines IS
'Regels van een beginbalans. Eén regel = één zijde (debet of credit) op één grootboekrekening. Een concept mag onvolledige regels bevatten (geen rekening, 0/0); de boekingsfunctie weigert die. Na boeken of na een nihil-verklaring zijn de regels bevroren.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The claim marker
--
--    opening_balance_id is the PRIMARY KEY, and that single fact is the whole
--    per-header idempotency guarantee: the second claim of one beginbalans
--    cannot exist. posting_group_id is UNIQUE, so one beginbalans ↔ one group.
--    client_id carries a separate UNIQUE INDEX — the per-administratie rule,
--    deliberately an index so a future reversal phase can relax it (see DOMAIN
--    UNIQUENESS in the header).
--
--    The marker also records what was claimed (boekjaar, opening_date,
--    line_count, total_amount = the debit total of the group) so the audit
--    trail survives independently of the header it explains, and so the claim
--    trigger in section 9 can pin the shape of the group without re-reading the
--    header.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.opening_balance_postings (
  opening_balance_id  uuid          PRIMARY KEY,
  posting_group_id    uuid          NOT NULL UNIQUE,
  organization_id     uuid          NOT NULL,
  client_id           uuid          NOT NULL,
  boekjaar            integer       NOT NULL
                                    CONSTRAINT opening_balance_postings_boekjaar_check
                                    CHECK (boekjaar BETWEEN 2000 AND 2100),
  opening_date        date          NOT NULL,
  line_count          integer       NOT NULL
                                    CONSTRAINT opening_balance_postings_line_count_check
                                    CHECK (line_count >= 2),
  total_amount        numeric(12,2) NOT NULL
                                    CONSTRAINT opening_balance_postings_total_amount_check
                                    CHECK (total_amount > 0 AND total_amount <> 'NaN'::numeric),
  user_id             uuid          NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

-- RESTRICT throughout: this row is the audit trail proving why immutable ledger
-- rows exist. It must never be cascade-deleted out from under them — and the
-- RESTRICT on opening_balance_id is what guarantees the lines' CASCADE FK can
-- never fire for a posted beginbalans even if the freeze trigger were disabled.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'opening_balance_postings'
      AND c.conname = 'opening_balance_postings_opening_balance_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_postings
      ADD CONSTRAINT opening_balance_postings_opening_balance_id_fkey
      FOREIGN KEY (opening_balance_id) REFERENCES public.opening_balances (id)
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
      AND t.relname = 'opening_balance_postings'
      AND c.conname = 'opening_balance_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_postings
      ADD CONSTRAINT opening_balance_postings_organization_id_fkey
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
      AND t.relname = 'opening_balance_postings'
      AND c.conname = 'opening_balance_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_postings
      ADD CONSTRAINT opening_balance_postings_client_id_fkey
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
      AND t.relname = 'opening_balance_postings'
      AND c.conname = 'opening_balance_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.opening_balance_postings
      ADD CONSTRAINT opening_balance_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_opening_balance_postings_organization
  ON public.opening_balance_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_opening_balance_postings_user_id
  ON public.opening_balance_postings (user_id);

-- DOMAIN UNIQUENESS (a): at most one posted beginbalans per administratie.
-- An INDEX rather than a PRIMARY KEY or a UNIQUE CONSTRAINT, precisely so the
-- future reversal phase can swap it for a partial one in a single statement
-- pair without touching the table definition (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_opening_balance_postings_client
  ON public.opening_balance_postings (client_id);

-- CROSS-kind rule (c), declaratively visible in the schema instead of only in
-- a function body: a marker may not appear for an administratie that has a nil
-- declaration. Race-freedom comes from the advisory lock both RPCs take
-- (sections 7 and 8); this trigger is the standing guard that also covers an
-- owner-level INSERT, which no grant can stop.
CREATE OR REPLACE FUNCTION public.enforce_opening_balance_marker_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.opening_balances ob
    WHERE ob.client_id = NEW.client_id
      AND ob.nil_declared_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een nihil-verklaring voor de beginbalans; boeken is niet mogelijk'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_opening_balance_marker_exclusivity() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_opening_balance_marker_exclusivity_trigger ON public.opening_balance_postings;
CREATE TRIGGER validate_opening_balance_marker_exclusivity_trigger
  BEFORE INSERT ON public.opening_balance_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opening_balance_marker_exclusivity();

-- Marker privileges — read-only for the app, writable only by the RPC. A client
-- able to write the marker directly could fabricate a claim (blocking a
-- legitimate posting forever) or delete one (enabling a duplicate). The reset is
-- REVOKE ALL then GRANT SELECT, not an enumerated REVOKE list, so no future
-- default privilege can slip past it. service_role gets read only: no edge
-- function posts opening balances.
ALTER TABLE public.opening_balance_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_opening_balance_postings_select ON public.opening_balance_postings;
CREATE POLICY role_opening_balance_postings_select ON public.opening_balance_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.opening_balance_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.opening_balance_postings TO authenticated, service_role;

COMMENT ON TABLE public.opening_balance_postings IS
'Claim-registratie: bewijst dat één beginbalans precies één keer in het grootboek is geboekt. De primary key op opening_balance_id ís de idempotentiegarantie; posting_group_id is uniek (één beginbalans ↔ één boekingsgroep) en client_id is uniek via een losse index (hoogstens één geboekte beginbalans per administratie, bewust een index zodat een latere tegenboekingsfase hem kan versoepelen). Alleen public.post_opening_balance() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) RLS + grants on the draft tables
--
--    opening_balances       SELECT read_only | INSERT assistant (+ own user_id)
--                           | UPDATE assistant | DELETE accountant
--    opening_balance_lines  SELECT read_only | INSERT assistant (+ own user_id)
--                           | UPDATE assistant | DELETE assistant  ← EXCEPTION
--
--    COLUMN-LEVEL GRANTS on opening_balances, and why they matter more here
--    than anywhere else in the schema: nil_declaration / nil_declared_at /
--    nil_declared_by must NOT be writable by the application. If they were, any
--    assistant could assert "this administratie deliberately has no opening
--    balance" with a plain PostgREST PATCH — an accounting statement with no
--    role check, no audit and no lock — and could block a legitimate posting
--    forever through the cross-kind rule. So authenticated gets INSERT and
--    UPDATE on named columns only, and the three nil columns are not among
--    them. declare_opening_balance_nil() is SECURITY DEFINER and therefore
--    unaffected by column privileges; it is the only writer.
--
--    client_id is likewise excluded from the UPDATE list: an administratie
--    change would move a header out from under the advisory lock and the
--    per-client uniqueness. organization_id and user_id are excluded for the
--    same reason the rebind trigger refuses them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_balance_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_opening_balances_select ON public.opening_balances;
CREATE POLICY role_opening_balances_select ON public.opening_balances
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_opening_balances_insert ON public.opening_balances;
CREATE POLICY role_opening_balances_insert ON public.opening_balances
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS role_opening_balances_update ON public.opening_balances;
CREATE POLICY role_opening_balances_update ON public.opening_balances
  FOR UPDATE TO authenticated
  USING      (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));

DROP POLICY IF EXISTS role_opening_balances_delete ON public.opening_balances;
CREATE POLICY role_opening_balances_delete ON public.opening_balances
  FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));

DROP POLICY IF EXISTS role_opening_balance_lines_select ON public.opening_balance_lines;
CREATE POLICY role_opening_balance_lines_select ON public.opening_balance_lines
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_opening_balance_lines_insert ON public.opening_balance_lines;
CREATE POLICY role_opening_balance_lines_insert ON public.opening_balance_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS role_opening_balance_lines_update ON public.opening_balance_lines;
CREATE POLICY role_opening_balance_lines_update ON public.opening_balance_lines
  FOR UPDATE TO authenticated
  USING      (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));

-- DOCUMENTED EXCEPTION: 'assistant', not 'accountant' — see the ROLES block in
-- the header. Draft lines only; settled lines are frozen by trigger for every
-- role.
DROP POLICY IF EXISTS role_opening_balance_lines_delete ON public.opening_balance_lines;
CREATE POLICY role_opening_balance_lines_delete ON public.opening_balance_lines
  FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'assistant'));

REVOKE ALL ON public.opening_balances, public.opening_balance_lines
  FROM anon, authenticated, service_role;

-- Header: table-level SELECT and DELETE, column-level INSERT and UPDATE.
GRANT SELECT, DELETE ON public.opening_balances TO authenticated;
GRANT INSERT (
  id, organization_id, client_id, user_id, boekjaar, opening_date,
  description, reference, created_at, updated_at
) ON public.opening_balances TO authenticated;
GRANT UPDATE (
  boekjaar, opening_date, description, reference, updated_at
) ON public.opening_balances TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.opening_balance_lines TO authenticated;

GRANT SELECT ON public.opening_balances, public.opening_balance_lines TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) The per-administratie LEDGER LOCK — one serialisation point, one definition
--
--    This is the phase's serialisation primitive, and it is deliberately named
--    for the ledger rather than for the beginbalans: it orders EVERY write into
--    public.ledger_postings for one administratie, not only the two assertion
--    RPCs. Section 10 explains why that scope is required — without it the
--    "a beginbalans is the earliest fact" invariant cannot be enforced at all
--    under READ COMMITTED, because two transactions can each miss the other's
--    uncommitted work.
--
--    ONE FUNCTION, not a constant repeated in three bodies: every path calls
--    public.lock_ledger_client(), so the namespace and the key derivation
--    cannot drift apart between callers. Divergence here would not fail loudly;
--    it would silently stop ordering anything.
--
--    KEY DERIVATION follows 6C-b2 section 8a in spirit — read straight out of
--    the uuid's hex text, so it depends only on documented cast and operator
--    behaviour and not on a hash function whose implementation may differ
--    between PostgreSQL versions — but XORs all FOUR 32-bit words instead of
--    taking the first one. Taking only the leading word would make every pair of
--    ids sharing a 4-byte prefix share a lock, which is not hypothetical: it is
--    exactly what happens to sequential, seeded or hand-written uuids, and it
--    silently turns "these two administraties are independent" into "these two
--    administraties serialise". Folding uses all 128 bits of whatever entropy
--    the id actually has. Values above 2^31 wrap to negative integers, which
--    advisory locks accept.
--
--    NAMESPACE 6118, two-argument form. PostgreSQL keeps the two-integer
--    advisory lock space separate from the single-bigint space that 6C-b2 uses
--    for posting groups, so a client lock can never collide with a posting-group
--    lock — which matters, because a transaction holds both (see LOCK ORDER).
--
--    COLLISIONS: the key space is 32 bits, so two different administraties can
--    still map to one lock. The cost is that they serialise for a moment; it can
--    never admit an invalid state, because the lock only orders writers and
--    every rule is still checked against the real rows afterwards. A wider key
--    is not available without giving up the namespace separation from 6C-b2's
--    posting-group locks, and that separation is worth more: a transaction holds
--    both locks, so the two spaces must not be able to alias.
--
--    COST, stated plainly: all ledger writes for ONE administratie now
--    serialise. Two administraties never block each other (different keys), and
--    within one administratie a posting is a single user action of a few rows,
--    so the contention window is a few milliseconds. That is the price of the
--    invariant, and it is paid deliberately rather than traded away.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ledger_client_lock_key(_client_id uuid)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ('x' || substr(h, 1, 8))::bit(32)::integer
       # ('x' || substr(h, 9, 8))::bit(32)::integer
       # ('x' || substr(h, 17, 8))::bit(32)::integer
       # ('x' || substr(h, 25, 8))::bit(32)::integer
  FROM (SELECT replace(_client_id::text, '-', '')) AS t(h);
$$;

CREATE OR REPLACE FUNCTION public.lock_ledger_client(_client_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(6118, public.ledger_client_lock_key(_client_id));
$$;

REVOKE ALL ON FUNCTION public.ledger_client_lock_key(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_ledger_client(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.ledger_client_lock_key(uuid) IS
'Leidt de advisory-lock sleutel van een administratie af door alle vier de 32-bits woorden van haar uuid te XOR-en. Vouwen in plaats van het eerste woord nemen: anders delen twee ids met dezelfde eerste vier bytes stilzwijgend één grendel.';

COMMENT ON FUNCTION public.lock_ledger_client(uuid) IS
'Neemt de transactiegebonden advisory lock die alle grootboekschrijfacties van één administratie serialiseert (namespace 6118). Genomen door de trigger op ledger_postings, door post_opening_balance() en door declare_opening_balance_nil(), zodat alle drie aantoonbaar dezelfde grendel nemen. Verschillende administraties blokkeren elkaar niet.';

-- 6) Atomic replace of a draft's lines
--
--    Clone of the save_manual_journal_lines shape (6C-b6): validate every
--    element, then DELETE + INSERT in one function transaction, so a failing
--    element leaves the previous line set intact.
--
--    SECURITY INVOKER, deliberately: this writes DRAFT data the caller may
--    write directly anyway, so RLS is the authorization — an invisible header
--    is simply NOT FOUND (P0002). No privilege is escalated.
--
--    It takes LOCK 1 (the header, FOR UPDATE) and NOT LOCK 0: see LOCK ORDER.
--    The marker and nil checks are defence in depth — the line freeze trigger
--    would refuse the DELETE anyway — so the caller gets one clear message
--    instead of a trigger error from inside a DELETE.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_opening_balance_lines(
  _opening_balance_id uuid,
  _lines jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_header  public.opening_balances%ROWTYPE;
  v_elem    jsonb;
  v_idx     integer := 0;
  v_account uuid;
  v_sort    integer;
  v_debit   numeric;
  v_credit  numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- LOCK 1: the header, FOR UPDATE — the same lock post_opening_balance() and
  -- declare_opening_balance_nil() take.
  SELECT * INTO v_header
  FROM public.opening_balances
  WHERE id = _opening_balance_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = _opening_balance_id
  ) THEN
    RAISE EXCEPTION 'Deze beginbalans is geboekt; regels kunnen niet meer worden gewijzigd'
      USING ERRCODE = '42501';
  END IF;

  IF v_header.nil_declared_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deze beginbalans is op nihil verklaard; regels kunnen niet meer worden toegevoegd of gewijzigd'
      USING ERRCODE = '42501';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'lines moet een JSON array zijn' USING ERRCODE = '22023';
  END IF;

  -- Per-element validation before anything is deleted. Draft semantics: a line
  -- may be 0/0 (unfinished) and may lack an account; it may never be NaN,
  -- negative, both-sided, or carry more than two decimals. v_debit and v_credit
  -- are UNCONSTRAINED numeric on purpose: a numeric(12,2) variable would
  -- already have rounded 0.005 to 0.01 before the decimals check could see it.
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

    IF v_elem ? 'description' AND jsonb_typeof(v_elem->'description') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Regel %: description moet tekst zijn', v_idx USING ERRCODE = '22023';
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

  -- Atomic replace. If the INSERT raises, the DELETE is rolled back with it and
  -- the previous line set remains intact.
  DELETE FROM public.opening_balance_lines
  WHERE opening_balance_id = _opening_balance_id;

  -- Defence in depth for the INVOKER model: under RLS a DELETE silently skips
  -- rows the caller may not delete. If anything survived, the caller must not be
  -- allowed to write a partial line set on top of it.
  IF EXISTS (
    SELECT 1 FROM public.opening_balance_lines WHERE opening_balance_id = _opening_balance_id
  ) THEN
    RAISE EXCEPTION 'Geen rechten om de regels van deze beginbalans te vervangen'
      USING ERRCODE = '42501';
  END IF;

  -- organization_id and client_id are set by set_opening_balance_line_scope
  -- from the header; user_id is the caller (bound by the INSERT policy).
  INSERT INTO public.opening_balance_lines (
    opening_balance_id, organization_id, client_id, user_id, sort_order,
    grootboekrekening_id, description, debit_amount, credit_amount
  )
  SELECT
    _opening_balance_id,
    v_header.organization_id,
    v_header.client_id,
    v_uid,
    COALESCE(NULLIF(elem->>'sort_order', '')::integer, (ord - 1)::integer),
    NULLIF(elem->>'grootboekrekening_id', '')::uuid,
    NULLIF(btrim(COALESCE(elem->>'description', ''), E' \t\r\n'), ''),
    COALESCE(NULLIF(elem->>'debit_amount', '')::numeric, 0),
    COALESCE(NULLIF(elem->>'credit_amount', '')::numeric, 0)
  FROM jsonb_array_elements(_lines) WITH ORDINALITY AS t(elem, ord);
END
$$;

REVOKE ALL ON FUNCTION public.save_opening_balance_lines(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_opening_balance_lines(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.save_opening_balance_lines(uuid, jsonb) IS
'Vervangt atomair alle regels van een concept-beginbalans (verwijderen + opnieuw invoegen in één transactie). Draait als de aanroeper (SECURITY INVOKER): RLS bepaalt de rechten. Grendelt eerst de kop (FOR UPDATE, dezelfde grendel als post_opening_balance) en weigert zodra de beginbalans geboekt of op nihil verklaard is. Bedragen: geen NaN, niet negatief, niet tegelijk debet en credit, maximaal twee decimalen (gecontroleerd vóór de cast naar numeric(12,2); dit is het enige pad dat afkeurt in plaats van afrondt).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) The writer
--
--    SECURITY DEFINER is required, not preferred: the marker table is
--    deliberately not writable by authenticated (section 3), so an INVOKER
--    function could not claim the beginbalans. Because the definer bypasses
--    RLS, every check RLS would normally perform is done explicitly below.
--
--    The ONLY caller input is _opening_balance_id. organization_id, client_id,
--    user_id, posting_group_id, amounts, accounts, sides, date, boekjaar and
--    currency are all derived server-side from the locked rows;
--    created_xact_id is stamped by the ledger's own trigger.
--
--    Body order = the documented LOCK ORDER: isolation guard → advisory lock on
--    the administratie (LOCK 0) → header FOR UPDATE (LOCK 1) → lines FOR UPDATE
--    (LOCK 2) → reads → claim insert → ledger inserts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_opening_balance(_opening_balance_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_header       public.opening_balances%ROWTYPE;
  v_locked_client uuid;
  v_client       public.clients%ROWTYPE;
  v_group_id     uuid := gen_random_uuid();
  v_line_count   integer;
  v_no_account   integer;
  v_zero_lines   integer;
  v_both_sides   integer;
  v_negative     integer;
  v_nan          integer;
  v_decimals     integer;
  v_scope_bad    integer;
  v_inactive     text;
  v_sum_debit    numeric;
  v_sum_credit   numeric;
  v_earlier      date;
  v_line_no      integer := 0;
  v_line         record;
BEGIN
  -- (1) Authentication first: nothing is read or locked for an anonymous call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolation contract. Only READ COMMITTED may assert an opening balance:
  -- a snapshot-preserving level could hold a stale view of the other assertion
  -- kind across the advisory lock and let posted and nihil both commit.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een beginbalans kan alleen worden geboekt in een READ COMMITTED transactie (huidig niveau: %)', current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- (3) Read the header WITHOUT a lock first, only to learn the administratie
  -- the advisory lock must be taken on.
  SELECT * INTO v_header FROM public.opening_balances WHERE id = _opening_balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;
  v_locked_client := v_header.client_id;

  -- (4) LOCK 0 — the administratie. Serialises this posting against every other
  -- opening-balance assertion of the same administratie, including a nil
  -- declaration of a DIFFERENT header, which no index could cover.
  PERFORM public.lock_ledger_client(v_locked_client);

  -- (5) LOCK 1 — the header, FOR UPDATE, re-read under the advisory lock.
  SELECT * INTO v_header
  FROM public.opening_balances
  WHERE id = _opening_balance_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (5a) The lock must cover the row we are about to act on. client_id is
  -- immutable ON A ROW, but the header id → administratie MAPPING is not: a
  -- draft may be deleted and re-created under the same id (id is caller-
  -- suppliable, DELETE sits at the accountant floor), and the window for that
  -- is exactly the wait at LOCK 0 — widest precisely when the lock matters.
  -- Without this, a posting could commit for an administratie whose advisory
  -- lock is held by someone else, which would silently disarm the only
  -- mechanism that makes "geboekt XOR nihil" race-free. Retryable: the caller
  -- simply calls again and then locks the right administratie.
  IF v_header.client_id IS DISTINCT FROM v_locked_client THEN
    RAISE EXCEPTION 'De beginbalans is tussentijds gewijzigd; probeer opnieuw'
      USING ERRCODE = '40001';
  END IF;

  -- (6) Tenant + role, both from stored data. POSTING FLOOR = accountant.
  IF v_header.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_header.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een beginbalans te boeken voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (7) The administratie must belong to the header's organisation.
  SELECT * INTO v_client FROM public.clients WHERE id = v_header.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_header.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze beginbalans'
      USING ERRCODE = '42501';
  END IF;

  -- (8) This header must still be an open draft.
  IF v_header.nil_declared_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deze beginbalans is op nihil verklaard en kan niet worden geboekt'
      USING ERRCODE = '22023';
  END IF;

  -- (9) And the administratie must not already carry the other assertion. The
  -- unique index on the marker and the trigger in section 3 would both refuse
  -- this too; checking here gives the caller the real reason instead of a
  -- constraint name.
  IF EXISTS (
    SELECT 1 FROM public.opening_balances ob
    WHERE ob.client_id = v_header.client_id
      AND ob.nil_declared_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een nihil-verklaring voor de beginbalans; boeken is niet mogelijk'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings obp
    WHERE obp.opening_balance_id = v_header.id
  ) THEN
    RAISE EXCEPTION 'Deze beginbalans is al geboekt' USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings obp
    WHERE obp.client_id = v_header.client_id
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een geboekte beginbalans'
      USING ERRCODE = '23505';
  END IF;

  -- (10) Defensive: both columns are NOT NULL, but the writer does not lean on
  -- a constraint it does not own.
  IF v_header.opening_date IS NULL OR v_header.boekjaar IS NULL THEN
    RAISE EXCEPTION 'Beginbalans heeft geen datum of boekjaar; boeken is niet mogelijk'
      USING ERRCODE = '22004';
  END IF;

  -- (11) Calendar-year fiscal model (owner decision, v1). Also a table CHECK.
  IF v_header.boekjaar <> EXTRACT(YEAR FROM v_header.opening_date)::integer THEN
    RAISE EXCEPTION 'Boekjaar % hoort niet bij openingsdatum %; v1 ondersteunt alleen kalenderjaren', v_header.boekjaar, v_header.opening_date
      USING ERRCODE = '22023';
  END IF;

  -- (12) A beginbalans without a description is not auditable: it is also the
  -- fallback description of every ledger row whose line has none. Whitespace-
  -- aware: btrim() alone trims spaces only and would accept E'\t\n'.
  IF v_header.description IS NULL OR btrim(v_header.description, E' \t\r\n') = '' THEN
    RAISE EXCEPTION 'Beginbalans heeft geen omschrijving; boeken is niet mogelijk'
      USING ERRCODE = '22023';
  END IF;

  -- (13) Closed year, identically to the other four writers. No fallback year.
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_header.boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- (14) EARLIEST FACT. A beginbalans that is not the first accounting fact of
  -- its administratie would double-count everything before it, and nothing
  -- later could detect that: the group balances, so every ledger invariant and
  -- every reporting self-check would stay satisfied while the figures are
  -- wrong. This is the only moment it is visible.
  SELECT max(lp.posting_date) INTO v_earlier
  FROM public.ledger_postings lp
  WHERE lp.client_id = v_header.client_id
    AND lp.posting_date < v_header.opening_date;
  IF v_earlier IS NOT NULL THEN
    RAISE EXCEPTION 'Er staan al boekingen vóór % in het grootboek van deze administratie (laatste: %); een beginbalans moet het eerste feit zijn', v_header.opening_date, v_earlier
      USING ERRCODE = '22023';
  END IF;

  -- (15) LOCK 2 — every line, FOR UPDATE, in posting order. A raw line
  -- UPDATE/DELETE in flight finishes first (we then read its committed result);
  -- one that starts later waits here and is refused by the freeze once our
  -- marker is committed.
  PERFORM 1
  FROM public.opening_balance_lines
  WHERE opening_balance_id = v_header.id
  ORDER BY sort_order, id
  FOR UPDATE;

  -- (16) One aggregate over the locked lines, then refusals in a fixed order so
  -- the first message names the most fundamental problem.
  --   ALL of these filters are unreachable through a stored line, and that is
  --   deliberate rather than an oversight: both-sides, negative and NaN are
  --   refused by the CHECKs on opening_balance_lines, >2 decimals by the
  --   numeric(12,2) typmod, and a scope mismatch by set_opening_balance_line_scope,
  --   which always overwrites organization_id and client_id from the header. The
  --   writer keeps them so it does not lean on constraints and triggers it does
  --   not own. The NaN filter still runs BEFORE the balance comparison, because
  --   NaN = NaN is TRUE in PostgreSQL and an unbalanced NaN group would
  --   otherwise be reported as balanced.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL),
         COUNT(*) FILTER (WHERE l.debit_amount = 0 AND l.credit_amount = 0),
         COUNT(*) FILTER (WHERE l.debit_amount > 0 AND l.credit_amount > 0),
         COUNT(*) FILTER (WHERE l.debit_amount < 0 OR l.credit_amount < 0),
         COUNT(*) FILTER (WHERE l.debit_amount = 'NaN'::numeric OR l.credit_amount = 'NaN'::numeric),
         COUNT(*) FILTER (WHERE l.debit_amount <> round(l.debit_amount, 2)
                             OR l.credit_amount <> round(l.credit_amount, 2)),
         COUNT(*) FILTER (WHERE l.organization_id IS DISTINCT FROM v_header.organization_id
                             OR l.client_id IS DISTINCT FROM v_header.client_id),
         COALESCE(SUM(l.debit_amount), 0),
         COALESCE(SUM(l.credit_amount), 0)
    INTO v_line_count, v_no_account, v_zero_lines, v_both_sides, v_negative,
         v_nan, v_decimals, v_scope_bad, v_sum_debit, v_sum_credit
  FROM public.opening_balance_lines l
  WHERE l.opening_balance_id = v_header.id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Een beginbalans heeft minimaal twee regels: een debet- en een creditregel'
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

  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION 'Een regel hoort bij een andere organisatie of administratie dan de beginbalans'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Een beginbalans heeft zowel een debet- als een creditbedrag groter dan nul nodig'
      USING ERRCODE = '22023';
  END IF;

  -- Exact NUMERIC equality. No tolerance, no rounding, and above all NO
  -- automatic balancing leg: the difference is reported, never absorbed.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Beginbalans is niet in balans: debet % is ongelijk aan credit % (verschil %)',
      v_sum_debit, v_sum_credit, (v_sum_debit - v_sum_credit)
      USING ERRCODE = '23514';
  END IF;

  -- (17) Account scope: every account must be usable by THIS administratie —
  -- the same predicate ledger_postings enforces per row, checked up front so
  -- the refusal is explicit instead of a generic row error.
  SELECT COUNT(*) INTO v_scope_bad
  FROM public.opening_balance_lines l
  WHERE l.opening_balance_id = v_header.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_header.organization_id, v_header.client_id);
  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_scope_bad
      USING ERRCODE = '23514';
  END IF;

  -- (18) No posting onto a deactivated account.
  SELECT string_agg(g.nummer::text, ', ' ORDER BY g.nummer) INTO v_inactive
  FROM public.opening_balance_lines l
  JOIN public.grootboekrekeningen g ON g.id = l.grootboekrekening_id
  WHERE l.opening_balance_id = v_header.id
    AND NOT g.actief;
  IF v_inactive IS NOT NULL THEN
    RAISE EXCEPTION 'Een regel verwijst naar een niet-actieve grootboekrekening (%)', v_inactive
      USING ERRCODE = '22023';
  END IF;

  -- (19) Claim the beginbalans. The primary key is the per-header idempotency
  -- guarantee and the client_id index the per-administratie one; both are also
  -- the serialisation points for callers that somehow bypassed LOCK 0. No
  -- EXISTS pre-check beyond the friendly messages above — the indexes are the
  -- arbiter.
  BEGIN
    INSERT INTO public.opening_balance_postings (
      opening_balance_id, posting_group_id, organization_id, client_id,
      boekjaar, opening_date, line_count, total_amount, user_id
    ) VALUES (
      v_header.id, v_group_id, v_header.organization_id, v_header.client_id,
      v_header.boekjaar, v_header.opening_date, v_line_count, v_sum_debit, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze beginbalans is al geboekt, of deze administratie heeft er al een'
      USING ERRCODE = '23505';
  END;

  -- (20) One ledger row per line, exactly as stored, in posting order. The
  -- line's own id goes in source_line_id (durable here — header comment).
  FOR v_line IN
    SELECT id, grootboekrekening_id, debit_amount, credit_amount, description
    FROM public.opening_balance_lines
    WHERE opening_balance_id = v_header.id
    ORDER BY sort_order, id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_header.organization_id, v_header.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_header.opening_date, v_header.boekjaar, v_line.debit_amount, v_line.credit_amount, 'EUR',
      COALESCE(NULLIF(btrim(v_line.description, E' \t\r\n'), ''), v_header.description),
      'opening_balance', v_header.id, v_line.id, v_uid
    );
  END LOOP;

  -- (21)
  RETURN v_group_id;
END
$$;

-- Callable by the app, never by anon, never by service_role, never by PUBLIC.
-- Every application role is named explicitly: a grant made straight to anon or
-- service_role by a platform default survives a REVOKE that only names PUBLIC.
-- service_role is deliberately not granted EXECUTE: no edge function posts a
-- beginbalans, and no existing requirement asks for one.
REVOKE ALL ON FUNCTION public.post_opening_balance(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_opening_balance(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_opening_balance(uuid) IS
'Boekt één concept-beginbalans als sluitende boeking in ledger_postings — één grootboekregel per beginbalansregel, debet of credit zoals vastgelegd, zonder impliciete regels en zonder automatische sluitpost — en claimt haar in opening_balance_postings, atomair en precies één keer. Vereist de rol accountant. Enige invoer is de beginbalans-id; organisatie, administratie, gebruiker, bedragen, zijden, rekeningen, datum, boekjaar en valuta worden server-side afgeleid uit de gegrendelde kop en regels. Weigert een niet-sluitende beginbalans onder vermelding van debettotaal, credittotaal en verschil, een afgesloten boekjaar, een administratie met een nihil-verklaring of een eerdere beginbalans, en een administratie die al boekingen vóór de openingsdatum heeft.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) The nil declaration
--
--    "This administratie deliberately has no opening balance" is an accounting
--    assertion, not a checkbox. It cannot be a posting — ledger_postings
--    requires SUM(debit) = SUM(credit) > 0 over at least two rows, so a zero
--    opening balance has no representation there — and it must not be
--    indistinguishable from "nobody has looked at this yet", because the
--    completeness indicator has to tell those two apart.
--
--    So it is recorded on the header, by an accountant, with a timestamp and an
--    author, through this function and nothing else: the three nil columns are
--    excluded from the column-level grants (section 4), so no PostgREST call
--    can set them, and this SECURITY DEFINER function bypasses those grants
--    exactly once, after checking everything RLS would have checked.
--
--    It takes the SAME advisory lock as the poster, first, which is what makes
--    "posted XOR nil" race-free rather than merely checked.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.declare_opening_balance_nil(_opening_balance_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_header public.opening_balances%ROWTYPE;
  v_locked_client uuid;
  v_client public.clients%ROWTYPE;
  v_lines  integer;
BEGIN
  -- (1) Authentication first: nothing is read or locked for an anonymous call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Same isolation contract as the poster, for the same reason.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een nihil-verklaring kan alleen in een READ COMMITTED transactie worden vastgelegd (huidig niveau: %)', current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- (3) Unlocked read, only to learn the administratie for LOCK 0.
  SELECT * INTO v_header FROM public.opening_balances WHERE id = _opening_balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;
  v_locked_client := v_header.client_id;

  -- (4) LOCK 0 — the administratie, the same lock post_opening_balance() takes.
  PERFORM public.lock_ledger_client(v_locked_client);

  -- (5) LOCK 1 — the header, FOR UPDATE, re-read under the advisory lock.
  SELECT * INTO v_header
  FROM public.opening_balances
  WHERE id = _opening_balance_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (5a) The lock must cover the row we are about to act on — see the same
  -- step in post_opening_balance() for why the id → administratie mapping is
  -- not stable across the wait at LOCK 0.
  IF v_header.client_id IS DISTINCT FROM v_locked_client THEN
    RAISE EXCEPTION 'De beginbalans is tussentijds gewijzigd; probeer opnieuw'
      USING ERRCODE = '40001';
  END IF;

  -- (6) Tenant + role, both from stored data. FLOOR = accountant, the same as
  -- posting: this assertion has the same standing.
  IF v_header.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_header.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een beginbalans op nihil te verklaren voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_header.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_header.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze beginbalans'
      USING ERRCODE = '42501';
  END IF;

  -- (7) No marker — neither for this header nor anywhere in this administratie.
  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings obp
    WHERE obp.opening_balance_id = v_header.id
       OR obp.client_id = v_header.client_id
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een geboekte beginbalans; een nihil-verklaring is niet mogelijk'
      USING ERRCODE = '23505';
  END IF;

  -- (8) No prior nil declaration — neither on this header nor on another header
  -- of the same administratie (the partial unique index would refuse the second
  -- one anyway; this names the reason).
  IF v_header.nil_declared_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deze beginbalans is al op nihil verklaard' USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balances ob
    WHERE ob.client_id = v_header.client_id
      AND ob.nil_declared_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een nihil-verklaring voor de beginbalans'
      USING ERRCODE = '23505';
  END IF;

  -- (9) Zero lines. A nil declaration states that there is nothing to post; a
  -- header that still carries lines contradicts that, and silently discarding
  -- them would destroy the bookkeeper's work.
  SELECT COUNT(*) INTO v_lines
  FROM public.opening_balance_lines
  WHERE opening_balance_id = v_header.id;
  IF v_lines > 0 THEN
    RAISE EXCEPTION 'Deze beginbalans heeft % regel(s); verwijder ze eerst om op nihil te verklaren', v_lines
      USING ERRCODE = '22023';
  END IF;

  -- (10) Closed year, identically to the poster: a nil declaration is an
  -- assertion about a boekjaar and may not be made about a closed one.
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_header.boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- (11) Record it. The freeze in section 11 makes the row immutable from here.
  UPDATE public.opening_balances
  SET nil_declaration = true,
      nil_declared_at = now(),
      nil_declared_by = v_uid
  WHERE id = v_header.id;
END
$$;

REVOKE ALL ON FUNCTION public.declare_opening_balance_nil(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.declare_opening_balance_nil(uuid) TO authenticated;

COMMENT ON FUNCTION public.declare_opening_balance_nil(uuid) IS
'Legt vast dat een administratie bewust geen beginbalans heeft. Vereist de rol accountant, een concept zonder regels, geen bestaande geboekte beginbalans of nihil-verklaring voor deze administratie, en een niet-afgesloten boekjaar. Schrijft geen enkele grootboekregel en geen claim: een saldo van nul is in ledger_postings niet uit te drukken. Neemt dezelfde advisory lock als post_opening_balance(), zodat geboekt en nihil elkaar nooit kunnen kruisen. Na afloop is de kop bevroren.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) Source-level exactly-once, enforced on ledger_postings itself
--
--    The marker's primary key only protects calls that go through
--    post_opening_balance(). It does not protect the table: authenticated has a
--    direct INSERT on ledger_postings, so after a legitimate posting an
--    assistant could still insert a SECOND balanced group for the same
--    beginbalans under a different posting_group_id.
--
--    This trigger closes that by making the marker the single authority for
--    opening_balance rows. Deliberately scoped to source_type =
--    'opening_balance' only, the same discipline as the four existing guards.
--    Every ledger row must point at a real line of the claimed beginbalans and
--    carry exactly that line's account and amounts, so a same-transaction
--    raw-SQL caller cannot add, alter or re-side a leg under the claimed group.
--
--    A reversal is refused outright: a future reversal engine writes NEW rows
--    with its OWN source_type, never 'opening_balance' rows pointing back.
--
--    Integrity, not authorization: no auth.uid(), no has_min_role() — this must
--    hold for every DML path, including service-role or maintenance paths where
--    auth.uid() is legitimately NULL.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_opening_balance_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.opening_balance_postings%ROWTYPE;
  v_line   public.opening_balance_lines%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'opening_balance' THEN
    RETURN NEW;
  END IF;

  -- First, and independent of any claim: this source type never carries a
  -- reversal. A future reversal engine writes NEW rows under its OWN source
  -- type, so a row that claims to be both is refused before anything else is
  -- looked up.
  IF NEW.reversal_of_posting_id IS NOT NULL THEN
    RAISE EXCEPTION 'Een tegenboeking gebruikt een eigen bronsoort' USING ERRCODE = '23514';
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een beginbalansregel in het grootboek moet naar een beginbalans verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.opening_balance_postings
  WHERE opening_balance_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze beginbalans is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een beginbalans kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte beginbalans'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_date <> v_marker.opening_date OR NEW.boekjaar <> v_marker.boekjaar THEN
    RAISE EXCEPTION 'Boekingsdatum of boekjaar van deze regel wijkt af van de geboekte beginbalans'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.line_no < 1 OR NEW.line_no > v_marker.line_count THEN
    RAISE EXCEPTION 'Een beginbalans van % regels heeft geen regel %', v_marker.line_count, NEW.line_no
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_line_id IS NULL THEN
    RAISE EXCEPTION 'Een beginbalansregel in het grootboek moet naar een beginbalansregel verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.opening_balance_lines
  WHERE id = NEW.source_line_id
    AND opening_balance_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_line_id hoort niet bij deze beginbalans' USING ERRCODE = '23514';
  END IF;

  -- IS DISTINCT FROM, not <>: a NULL on either side would make <> evaluate to
  -- NULL and let the row through. Unreachable today (the poster refuses a line
  -- without an account before the marker exists, and lines freeze afterwards),
  -- but this is the one guard whose whole job is to fail closed.
  IF NEW.grootboekrekening_id IS DISTINCT FROM v_line.grootboekrekening_id
     OR NEW.debit_amount IS DISTINCT FROM v_line.debit_amount
     OR NEW.credit_amount IS DISTINCT FROM v_line.credit_amount THEN
    RAISE EXCEPTION 'Grootboekregel wijkt af van de bevroren beginbalansregel' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_opening_balance_source_claim() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so organization_id is
-- already resolved when it is compared against the marker.
DROP TRIGGER IF EXISTS validate_opening_balance_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_opening_balance_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opening_balance_source_claim();

-- One ledger row per source line per group. The claim trigger validates each
-- row against its line but cannot see a sibling row inserted earlier in the
-- SAME transaction under a different line_no; without this index a raw-SQL
-- caller inside the posting transaction could mirror one line twice and the
-- group would still balance only by accident. Partial on the source type, so it
-- costs nothing for any other writer and never constrains their NULL
-- source_line_id rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_opening_balance_line
  ON public.ledger_postings (posting_group_id, source_line_id)
  WHERE source_type = 'opening_balance';

COMMENT ON FUNCTION public.enforce_opening_balance_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=opening_balance exact overeenkomt met de claim in opening_balance_postings én met de bevroren beginbalansregel (source_line_id: rekening en bedragen). Sluit een tweede boekingsgroep, een extra of afwijkende regel, een afwijkende datum of boekjaar en een tegenboeking onder deze bronsoort uit.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10) Nothing may be posted BEFORE a posted beginbalans — and the ledger lock
--     that makes that enforceable at all
--
--     post_opening_balance() refuses a beginbalans that is not the earliest
--     fact of its administratie. On its own that check runs once, in one
--     direction, against a snapshot — which under READ COMMITTED closes
--     nothing:
--
--       A: post_opening_balance(client X, opening_date D)   -- sees no earlier row
--       B: INSERT ledger_postings(client X, posting_date < D) -- sees no marker
--       both commit -> the exact double count the invariant forbids.
--
--     A second SELECT anywhere would not help: both transactions are reading
--     committed state and neither's work is committed yet. The only fix is a
--     real serialisation point, so this section provides one.
--
--     THE LOCK. Every INSERT into public.ledger_postings takes the
--     per-administratie ledger lock (section 5) in a BEFORE INSERT trigger,
--     BEFORE anything is checked. post_opening_balance() and
--     declare_opening_balance_nil() take the SAME lock at their very first step,
--     through the same function. After acquiring it, every path re-reads the
--     state it depends on under a fresh READ COMMITTED snapshot. That gives the
--     required property in both directions:
--
--       • beginbalans first: B blocks at the lock BEFORE writing any row, so it
--         has nothing for A to miss. A commits, B wakes, re-reads, sees the
--         marker and is refused.
--       • back-dated row first: A blocks at the lock. B commits, A wakes,
--         re-reads ledger_postings and finds the earlier row, and is refused.
--       • neither can pass on stale state, because neither runs until the other
--         has committed or rolled back.
--
--     WHY A TRIGGER AND NOT THE FOUR EXISTING WRITERS. The guarantee must hold
--     for every path into the table, including the direct INSERT that RLS grants
--     to `authenticated`. Editing purchase, sales, bank and manual-journal
--     writers would cover four of the paths and miss that one, and would edit
--     four already-applied migrations for a rule that is not theirs. The table
--     boundary is the only place where "every write" is expressible.
--
--     TRIGGER ORDER, and why the name matters. PostgreSQL fires BEFORE ROW
--     triggers in alphabetical order of trigger name. On public.ledger_postings
--     that order is now:
--
--       lock_ledger_client_trigger                       <- this section, FIRST
--       lock_ledger_posting_group_trigger                <- 6C-b2 group lock
--       set_organization_id_trigger
--       validate_ledger_posting_org_trigger
--       validate_manual_journal_source_claim_trigger
--       validate_no_posting_before_opening_balance_trigger
--       validate_opening_balance_source_claim_trigger
--
--     "lock_ledger_c..." sorts before "lock_ledger_p...", so the CLIENT lock is
--     always taken before the GROUP lock, on every path, with no exception. The
--     lock trigger reads only NEW.client_id, which is NOT NULL and comes
--     straight from the caller, so it depends on no earlier trigger.
--
--     GLOBAL LOCK ORDER, and why there is no deadlock:
--
--       client advisory lock  ->  posting-group advisory lock  ->  row locks
--
--     Every transaction that touches the ledger acquires them in that order:
--       • an ordinary writer (purchase/sales/bank/memoriaal) locks its own
--         document rows first, then hits the ledger and takes client, then
--         group. Its document rows are in ITS OWN tables, which no other
--         writer and no assertion RPC ever locks, so those locks cannot be the
--         second edge of a cycle;
--       • post_opening_balance() and declare_opening_balance_nil() take the
--         client lock FIRST, before the header and line locks, and their ledger
--         inserts then re-take the same client lock (a no-op for a lock the
--         transaction already holds) before the group lock — the same order;
--       • save_opening_balance_lines() takes no client lock at all. It locks
--         only the header it is editing and that header's lines, and waits for
--         nothing else, so it can never be part of a cycle: it is always able
--         to finish.
--     Had the client lock been taken AFTER the group lock, an ordinary writer
--     (group then client) and a poster (client then group) would have formed a
--     textbook inversion. The trigger name is what prevents it, so it is
--     asserted in the test suite rather than left to reading.
--
--     SCOPE. The trigger skips source_type = 'opening_balance' for the CHECK
--     (a beginbalans is dated ON its opening date, never before it) but NOT for
--     the LOCK: the poster must hold the lock too, or it would not be ordered
--     against anyone. Administraties without a posted beginbalans are unaffected
--     by the check — which today is all of them — and the lock is per
--     administratie, so unrelated administraties keep running concurrently.
--
--     Integrity, not authorization: no auth.uid(), no role check. It must hold
--     for every DML path, including service-role and maintenance paths.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lock_ledger_client_for_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Pure ordering, no business logic: this is the serialisation point every
  -- ledger write shares. It must run before any check reads state that another
  -- transaction could still be about to change, and before the posting-group
  -- lock, so the global lock order is client -> group everywhere.
  PERFORM public.lock_ledger_client(NEW.client_id);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.lock_ledger_client_for_posting() FROM PUBLIC;

-- The name is load-bearing: "lock_ledger_c" sorts before "lock_ledger_p", so
-- this fires before 6C-b2's lock_ledger_posting_group_trigger.
DROP TRIGGER IF EXISTS lock_ledger_client_trigger ON public.ledger_postings;
CREATE TRIGGER lock_ledger_client_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.lock_ledger_client_for_posting();

COMMENT ON FUNCTION public.lock_ledger_client_for_posting() IS
'Neemt bij elke grootboekregel eerst de per-administratie grendel, vóór de boekingsgroep-grendel van 6C-b2 en vóór elke controle. Dit is het serialisatiepunt waarop de beginbalans-invariant ("de beginbalans is het eerste feit") berust: zonder deze grendel kunnen twee gelijktijdige transacties elkaars ongecommitte werk missen en allebei slagen.';

CREATE OR REPLACE FUNCTION public.enforce_no_posting_before_opening_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opening date;
BEGIN
  -- The beginbalans itself is dated ON its opening date, never before it. (It
  -- still took the lock above; only this check is skipped.)
  IF NEW.source_type = 'opening_balance' THEN
    RETURN NEW;
  END IF;

  -- Runs with the client lock already held (lock_ledger_client_trigger fired
  -- first), so this statement's fresh READ COMMITTED snapshot sees the marker
  -- of any beginbalans that committed while we waited, and no beginbalans can
  -- be committing right now.
  -- At most one row: uniq_opening_balance_postings_client.
  SELECT obp.opening_date INTO v_opening
  FROM public.opening_balance_postings obp
  WHERE obp.client_id = NEW.client_id;

  IF v_opening IS NOT NULL AND NEW.posting_date < v_opening THEN
    RAISE EXCEPTION 'De beginbalans van deze administratie staat op %; een boeking van % ligt daarvóór en zou dubbel tellen', v_opening, NEW.posting_date
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_no_posting_before_opening_balance() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so client_id and
-- organization_id are already resolved when they are read.
DROP TRIGGER IF EXISTS validate_no_posting_before_opening_balance_trigger ON public.ledger_postings;
CREATE TRIGGER validate_no_posting_before_opening_balance_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_posting_before_opening_balance();

COMMENT ON FUNCTION public.enforce_no_posting_before_opening_balance() IS
'Weigert een grootboekregel met een boekingsdatum vóór de geboekte beginbalans van dezelfde administratie: die periode is al in de beginbalans samengevat, dus zo''n regel telt dubbel. Draait onder de per-administratie grendel, zodat een gelijktijdige beginbalans niet gemist kan worden. Raakt alleen administraties met een geboekte beginbalans en nooit de beginbalans zelf.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 11) A settled beginbalans is frozen — header and lines
--
--     "Settled" means EITHER a marker exists OR nil_declared_at is set. Both
--     are terminal accounting assertions and both must become immutable, for
--     the same reason: a posted header whose fields could still change would
--     describe an entry the ledger no longer matches (and its ledger rows'
--     source_line_id would dangle), and a nil declaration that could be edited
--     or withdrawn would not be an assertion at all.
--
--     Header, frozen: id, organization_id, client_id, user_id, boekjaar,
--     opening_date, description, reference and all three nil columns — every
--     field that fed the entry or the assertion. created_at and updated_at stay
--     free (the updated_at trigger keeps bumping the latter). DELETE is refused
--     outright, which also means the lines' ON DELETE CASCADE can never fire for
--     a settled beginbalans.
--
--     Lines: INSERT, UPDATE and DELETE are all refused once the header is
--     settled. Explicit TG_OP branches; OLD and NEW are checked independently
--     and never through COALESCE(NEW.x, OLD.x) — on UPDATE, NEW is always
--     present, so a COALESCE would never examine OLD and a line could be moved
--     OFF a settled header undetected (the 6C-b3 bug class).
--
--     INSERT ordering subtlety, inherited from 6C-b6: a BEFORE INSERT trigger
--     runs BEFORE the row's foreign key takes its KEY SHARE lock on the header,
--     so a raw line INSERT racing a post or a nil declaration could pass the
--     check while the other transaction is still uncommitted and then land
--     after it committed. The INSERT branch therefore takes FOR KEY SHARE on the
--     header itself, first: it waits behind the FOR UPDATE and afterwards reads
--     the settled state on a fresh READ COMMITTED snapshot. Only on INSERT — on
--     UPDATE/DELETE PostgreSQL locks the line tuple before firing the BEFORE
--     trigger, which already serialises against the poster's LOCK 2, and taking
--     a header lock AFTER a line lock would invert the documented lock order.
--
--     Integrity, not authorization: no auth.uid(), no role check.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_settled_opening_balance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_settled boolean;
BEGIN
  -- A header is ALWAYS born a draft. The nil columns are excluded from the
  -- column-level INSERT grant, so no application role can do otherwise; this
  -- branch closes the same door for a definer- or owner-level INSERT, which no
  -- grant can stop. Without it the cross-kind rule was asymmetric: the marker
  -- trigger refused a claim next to a nil declaration on INSERT, but a header
  -- could be INSERTed already nil-declared next to a posted beginbalans — two
  -- effective assertions for one administratie, which is exactly what the
  -- DOMAIN UNIQUENESS block promises can never exist.
  IF TG_OP = 'INSERT' THEN
    IF NEW.nil_declared_at IS NOT NULL OR NEW.nil_declared_by IS NOT NULL OR NEW.nil_declaration THEN
      RAISE EXCEPTION 'Een nihil-verklaring wordt vastgelegd met declare_opening_balance_nil(), niet bij het aanmaken van een beginbalans'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.nil_declared_at IS NOT NULL THEN
      RAISE EXCEPTION 'Deze beginbalans is op nihil verklaard; verwijderen is niet mogelijk.'
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Deze beginbalans is geboekt; verwijderen is niet mogelijk. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE. The nil columns are the one exception that has to be allowed
  -- exactly once: declare_opening_balance_nil() sets them on a row that is not
  -- yet settled. Every later change of those same columns — including undoing a
  -- nil declaration — is refused, because by then the row IS settled.
  v_was_settled := OLD.nil_declared_at IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = OLD.id
                   );

  -- The other half of the CROSS-kind rule, and the reason it is here rather
  -- than only in declare_opening_balance_nil(): the marker trigger in section 3
  -- refuses a claim for an administratie that is nil-declared, but nothing
  -- declarative refused the reverse — setting a nil declaration on a DIFFERENT
  -- header of an administratie that already has a posted beginbalans. The
  -- column-level grants keep every application role out of these columns and
  -- the nil RPC checks it, so no reachable application path could do it; a
  -- definer- or owner-level UPDATE (the SQL editor) could. Refused here, so the
  -- rule holds for every caller instead of only for the ones that ask nicely.
  IF OLD.nil_declared_at IS NULL AND NEW.nil_declared_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.opening_balance_postings obp
       WHERE obp.client_id = OLD.client_id
     ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een geboekte beginbalans; een nihil-verklaring is niet mogelijk'
      USING ERRCODE = '23505';
  END IF;

  IF v_was_settled THEN
    IF NEW.id                IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.client_id       IS DISTINCT FROM OLD.client_id
       OR NEW.user_id         IS DISTINCT FROM OLD.user_id
       OR NEW.boekjaar        IS DISTINCT FROM OLD.boekjaar
       OR NEW.opening_date    IS DISTINCT FROM OLD.opening_date
       OR NEW.description     IS DISTINCT FROM OLD.description
       OR NEW.reference       IS DISTINCT FROM OLD.reference
       OR NEW.nil_declaration IS DISTINCT FROM OLD.nil_declaration
       OR NEW.nil_declared_at IS DISTINCT FROM OLD.nil_declared_at
       OR NEW.nil_declared_by IS DISTINCT FROM OLD.nil_declared_by
    THEN
      RAISE EXCEPTION 'Deze beginbalans is vastgelegd (geboekt of op nihil verklaard); boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id AND EXISTS (
    SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Deze beginbalans-identiteit is al geboekt; een andere beginbalans kan er niet naartoe worden verplaatst.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.prevent_settled_opening_balance_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settled boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialise against a poster or a nil declaration in flight BEFORE looking
    -- at their result (see the section comment). The same transaction as
    -- save_opening_balance_lines() already holds FOR UPDATE on this header, so
    -- this never self-blocks.
    PERFORM 1 FROM public.opening_balances WHERE id = NEW.opening_balance_id FOR KEY SHARE;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT (ob.nil_declared_at IS NOT NULL)
           OR EXISTS (
             SELECT 1 FROM public.opening_balance_postings obp
             WHERE obp.opening_balance_id = ob.id
           )
      INTO v_settled
    FROM public.opening_balances ob
    WHERE ob.id = NEW.opening_balance_id;

    IF COALESCE(v_settled, false) THEN
      RAISE EXCEPTION 'Deze beginbalans is vastgelegd (geboekt of op nihil verklaard); regels kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT (ob.nil_declared_at IS NOT NULL)
           OR EXISTS (
             SELECT 1 FROM public.opening_balance_postings obp
             WHERE obp.opening_balance_id = ob.id
           )
      INTO v_settled
    FROM public.opening_balances ob
    WHERE ob.id = OLD.opening_balance_id;

    IF COALESCE(v_settled, false) THEN
      RAISE EXCEPTION 'Deze beginbalans is vastgelegd (geboekt of op nihil verklaard); regels kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_settled_opening_balance_mutation()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_settled_opening_balance_line_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_settled_opening_balance_mutation_trigger ON public.opening_balances;
CREATE TRIGGER prevent_settled_opening_balance_mutation_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.prevent_settled_opening_balance_mutation();

DROP TRIGGER IF EXISTS prevent_settled_opening_balance_line_mutation_trigger ON public.opening_balance_lines;
CREATE TRIGGER prevent_settled_opening_balance_line_mutation_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_settled_opening_balance_line_mutation();

COMMENT ON FUNCTION public.prevent_settled_opening_balance_mutation() IS
'Bevriest een vastgelegde beginbalans (geboekt óf op nihil verklaard): identiteit, organisatie, administratie, gebruiker, boekjaar, openingsdatum, omschrijving, referentie en de drie nihil-kolommen kunnen niet meer wijzigen en de kop kan niet worden verwijderd (waardoor de cascade naar de regels nooit een vastgelegde regel kan raken). created_at/updated_at blijven vrij.';

COMMENT ON FUNCTION public.prevent_settled_opening_balance_line_mutation() IS
'Weigert elke INSERT, UPDATE en DELETE op de regels van een geboekte of op nihil verklaarde beginbalans, voor elke rol. Grendelt bij INSERT eerst de kop (FOR KEY SHARE) zodat een regel nooit ná een gelijktijdige boeking of nihil-verklaring kan binnenkomen.';

COMMENT ON FUNCTION public.enforce_opening_balance_client_org() IS
'Bewaakt dat de administratie van een beginbalans binnen haar organisatie valt, en weigert het wijzigen van de administratie.';

COMMENT ON FUNCTION public.set_opening_balance_line_scope() IS
'Neemt organization_id en client_id van een beginbalansregel altijd over van de kop en weigert het verplaatsen van een regel naar een andere beginbalans.';

COMMENT ON FUNCTION public.enforce_opening_balance_marker_exclusivity() IS
'Weigert een claim voor een administratie die al een nihil-verklaring heeft. Samen met de unieke index op client_id en de advisory lock in beide RPC-en garandeert dit hoogstens één effectieve beginbalans-bewering per administratie.';
