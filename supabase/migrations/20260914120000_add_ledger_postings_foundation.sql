-- Migration: ledger postings foundation (phase 6C-b2)
--
-- Purpose: introduce public.ledger_postings — the persisted, append-only,
-- tenant-isolated posting layer that future accounting phases write to.
--
-- THIS MIGRATION CREATES AN EMPTY TABLE AND NOTHING ELSE.
--   • no historic purchase/sales/bank/journal document is backfilled;
--   • no existing table, policy, function or trigger is modified;
--   • no posting is generated anywhere — there is deliberately not a single
--     INSERT INTO public.ledger_postings in this file.
-- Writers arrive in later phases (6C-b3 purchase, 6C-b4 sales, 6C-b5 bank
-- settlement, 6C-b6 manual journal, 6C-b7 Grootboek reads).
--
-- Model: ONE ROW = ONE SIDE of a double entry. A complete accounting entry is
-- a set of rows sharing posting_group_id, which must sum debit = credit. This
-- is the first table in the schema that expresses two-sidedness at all: today
-- journal_entries holds one signed amount on one account, sales_invoices is
-- header-only, and the only existing two-sided artefact is the transient
-- boekingcode pairing inside the SnelStart CSV export.
--
-- Money type: NUMERIC(12,2), the repository's money convention
-- (20260411182021 purchase/sales/bank/journal amounts, 20260515120000
-- allocations). Never float.
--
-- FK behaviour: ON DELETE RESTRICT throughout, following the
-- purchase_invoice_lines precedent (20260718213000), NOT the ON DELETE SET
-- NULL used for optional configuration links (20260718234500, 20260719201000,
-- 20260904120000). Those columns are optional config that may become unknown;
-- these are mandatory accounting identity. Posted history must never silently
-- lose its client, its organisation or its account, and must never be
-- cascade-deleted when a parent row is removed. Deleting a client or account
-- that carries postings is therefore refused by PostgreSQL — which is the
-- intended accounting semantics.
--
-- Append-only: enforced in four independent layers, see section 7.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_ledger_posting_group_balance_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS validate_ledger_posting_org_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS prevent_ledger_posting_truncate_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS prevent_ledger_posting_mutation_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS lock_ledger_posting_group_trigger ON public.ledger_postings;
--   DROP FUNCTION IF EXISTS public.lock_ledger_posting_group();
--   DROP FUNCTION IF EXISTS public.enforce_ledger_posting_group_balance();
--   DROP FUNCTION IF EXISTS public.enforce_ledger_posting_org();
--   DROP FUNCTION IF EXISTS public.prevent_ledger_posting_mutation();
--   DROP FUNCTION IF EXISTS public.posting_account_ok(uuid, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.posting_client_org_ok(uuid, uuid);
--   DROP POLICY IF EXISTS role_ledger_postings_select ON public.ledger_postings;
--   DROP POLICY IF EXISTS role_ledger_postings_insert ON public.ledger_postings;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_reversal_of_posting_id;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_user_id;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_source;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_grootboekrekening_id;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_client_account_date;
--   DROP INDEX IF EXISTS public.idx_ledger_postings_organization_date;
--   DROP TABLE IF EXISTS public.ledger_postings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Table
--
--    organization_id / client_id / user_id are NOT NULL. Existing domain tables
--    carry a NULLABLE organization_id only because it was retrofitted onto rows
--    that already existed (20260531223619). This table is greenfield and starts
--    empty, so it follows the stricter greenfield precedent of
--    organization_members / user_roles (20260530211249): NOT NULL plus a real
--    FK. There is no historic row that could violate it.
--
--    boekjaar is stored explicitly rather than derived from posting_date,
--    because a Dutch administratie may run a gebroken boekjaar that does not
--    equal the calendar year. clients.afgesloten_boekjaar already treats the
--    boekjaar as a first-class integer.
--
--    currency is recorded even though no other table has the concept. The
--    reason is specific to this table: rows are immutable, so a currency column
--    added later could never be truthfully backfilled for postings already
--    written — the unit of an amount has to be captured at write time or it is
--    lost forever. It is NOT NULL and has no default, because inventing an
--    implicit EUR would be inventing a convention the repository has never
--    documented; writers state the currency explicitly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ledger_postings (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id        uuid        NOT NULL,
  client_id              uuid        NOT NULL,
  grootboekrekening_id   uuid        NOT NULL,

  posting_group_id       uuid        NOT NULL,
  -- NOT NULL and deliberately WITHOUT a default: every writer must assign the
  -- line number explicitly. A DEFAULT 1 would be a trap — a multi-row insert
  -- that forgot to set it would have every row collide on the unique index
  -- below, turning a writer bug into a confusing constraint error instead of
  -- an obvious one.
  line_no                integer     NOT NULL CHECK (line_no > 0),

  posting_date           date        NOT NULL,
  boekjaar               integer     NOT NULL CHECK (boekjaar BETWEEN 2000 AND 2100),

  debit_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (debit_amount  >= 0),
  credit_amount          numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  -- NOT NULL with NO default. The repository has no currency convention and
  -- there is no documented product requirement for EUR, so defaulting would be
  -- inventing one silently. The shape check asserts an uppercase ISO-4217-style
  -- code only; this is not a currency registry and does not claim the code is
  -- real. Future writers pass 'EUR' explicitly.
  currency               text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  description            text,

  -- Shape-checked, NOT value-checked. An enumerated CHECK would mean a schema
  -- migration every time a later phase introduces a source, on the canonical
  -- long-lived ledger table — and it would buy little, because the real
  -- protection against a bogus source is the writer-specific idempotency
  -- constraint each phase adds for its own source_type, not a list here. The
  -- shape rule still prevents the drift an unconstrained text column invites
  -- ('Purchase Invoice' vs 'purchase_invoice' vs ' purchase_invoice'), which
  -- matters because a future partial index keys off the literal value.
  -- Deliberately not a PostgreSQL enum: the repo uses text + CHECK everywhere
  -- except app_role, and an enum is worse here (ALTER TYPE to extend, and
  -- values can never be removed).
  source_type            text        NOT NULL CHECK (
                                       btrim(source_type) <> ''
                                       AND source_type ~ '^[a-z][a-z0-9_]*$'
                                     ),
  source_id              uuid,
  source_line_id         uuid,

  reversal_of_posting_id uuid,

  user_id                uuid        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  -- The database transaction that created this row. Seals the posting group:
  -- every row of one posting_group_id must carry the same value, so a group
  -- cannot be enlarged by a LATER transaction (see section 8a). Always
  -- overwritten by the trigger, never trusted from the caller, so it cannot be
  -- spoofed through PostgREST.
  --
  -- xid8 rather than xid/bigint: it is the 64-bit epoch-extended transaction
  -- id, so it is immune to the 32-bit xid wraparound that would eventually make
  -- two different transactions compare equal — which on an immutable ledger
  -- would silently re-open the group it is meant to seal.
  created_xact_id        xid8        NOT NULL,

  -- Exactly one side is positive. Both columns are NOT NULL DEFAULT 0, so the
  -- "unused" side is always an explicit 0 and never NULL — there is one single
  -- representation of an empty side, which keeps SUM() and every future balance
  -- query total. Rejects: both sides positive, both sides zero, and (together
  -- with the column CHECKs above) any negative amount. A negative posting is
  -- always expressed as a positive amount on the opposite side.
  CONSTRAINT ledger_postings_single_side_check CHECK (
    (debit_amount > 0 AND credit_amount = 0)
    OR
    (credit_amount > 0 AND debit_amount = 0)
  )
);

-- No updated_at column: the table is append-only, so a row is never updated.
-- This matches the existing append-only-ish tables ledger_accounts,
-- booking_templates and purchase_invoice_lines, which also carry created_at
-- only. user_id is the creating user and, because rows are immutable, is
-- permanently the "created_by" of the posting.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Foreign keys — ON DELETE RESTRICT, idempotent via pg_constraint lookup
--    (mirrors the DO $$ ... $$ pattern of 20260904120000)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'Constraint ledger_postings_organization_id_fkey already exists, skipping';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_client_id_fkey
      FOREIGN KEY (client_id)
      REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'Constraint ledger_postings_client_id_fkey already exists, skipping';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_grootboekrekening_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'Constraint ledger_postings_grootboekrekening_id_fkey already exists, skipping';
  END IF;
END
$$;

-- user_id is the creator of an immutable row, so it must stay both present and
-- truthful. The first-wave tables (20260411182021) use ON DELETE CASCADE, which
-- is exactly wrong here: deleting a user would erase accounting history. The
-- closer precedent is bank_transaction_allocations (20260515120000), which
-- references auth.users(id) with no cascade at all. RESTRICT makes that
-- intent explicit rather than implicit (NO ACTION), and is not deferrable, so
-- the check cannot be postponed inside a transaction. The consequence is
-- deliberate: an auth user who has posted can no longer be hard-deleted, which
-- is the correct trade for never leaving a fabricated or dangling creator uuid
-- on a permanent accounting record.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'Constraint ledger_postings_user_id_fkey already exists, skipping';
  END IF;
END
$$;

-- Self-reference for a future reversal: the reversing posting points at the
-- posting it reverses. Nullable (almost every posting is not a reversal) and
-- RESTRICT, so a reversed posting can never be deleted out from under its
-- reversal. Reversals are always NEW rows; nothing is ever edited in place.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_reversal_of_posting_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_reversal_of_posting_id_fkey
      FOREIGN KEY (reversal_of_posting_id)
      REFERENCES public.ledger_postings (id)
      ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'Constraint ledger_postings_reversal_of_posting_id_fkey already exists, skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Uniqueness / idempotency
--
--    Implemented now: (posting_group_id, line_no) is unique. Safe because
--    line_no is NOT NULL with no default, so a writer must assign it and can do
--    so reliably — there are no NULLs to weaken the index. It gives a posting
--    group a deterministic line order and makes an accidental double-insert of
--    the same line within one group impossible.
--
--    posting_group_id itself is deliberately NOT unique: a group contains
--    several rows by definition. Uniqueness lives on the (group, line) pair.
--
--    DELIBERATELY DEFERRED: a universal source-identity uniqueness constraint
--    such as (source_type, source_id, source_line_id, grootboekrekening_id).
--    It cannot be defined safely yet, for concrete reasons per source:
--      • purchase_invoice_lines rows are NOT durable — replace_purchase_invoice_lines
--        and save_purchase_invoice_with_lines (20260718202037 / 20260721010000)
--        delete and re-insert every line on each save, so purchase_invoice_lines.id
--        changes and cannot anchor a permanent posting identity;
--      • sales_invoices is header-only (no line table exists), so source_line_id
--        would always be NULL there — and NULLs are never equal in a unique
--        index, which would silently disable the constraint precisely where it
--        is needed;
--      • bank_transaction_allocations has its own natural key
--        (bank_transaction_id, invoice_id) that does not include an account;
--      • journal_entries is single-sided with no group concept at all.
--    Each writer phase knows its own identity semantics and will add a targeted,
--    partial unique index (or an idempotency key) for its own source_type. The
--    source_type/source_id/source_line_id columns and idx_ledger_postings_source
--    exist precisely so that is possible without another table migration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS ledger_postings_group_line_key
  ON public.ledger_postings (posting_group_id, line_no);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Indexes — each one justified, none speculative
-- ─────────────────────────────────────────────────────────────────────────────

-- Organisation-wide period queries (a boekjaar overview across administraties).
-- Also indexes organization_id as the leading column, which the RESTRICT FK
-- needs when an organisation delete is attempted.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_organization_date
  ON public.ledger_postings (organization_id, posting_date);

-- The main future Grootboek query: one administratie, one account, by period.
-- client_id leads, so this also serves the client RESTRICT FK check.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_client_account_date
  ON public.ledger_postings (client_id, grootboekrekening_id, posting_date);

-- grootboekrekening_id is not the leading column of any index above, so without
-- this a delete of a grootboekrekening would sequentially scan every posting to
-- evaluate the RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_grootboekrekening_id
  ON public.ledger_postings (grootboekrekening_id);

-- "Which postings did this document produce?" — drill-down from an invoice or
-- transaction, and the lookup every future writer needs to check whether it has
-- already posted this document before writing again.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_source
  ON public.ledger_postings (source_type, source_id);

-- user_id leads no other index, so without this the RESTRICT FK above would
-- sequentially scan every posting whenever an auth user delete is attempted.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_user_id
  ON public.ledger_postings (user_id);

-- Reversals are rare, so a partial index keeps this near-free while still
-- serving the self-referencing RESTRICT FK.
CREATE INDEX IF NOT EXISTS idx_ledger_postings_reversal_of_posting_id
  ON public.ledger_postings (reversal_of_posting_id)
  WHERE reversal_of_posting_id IS NOT NULL;

-- posting_group_id deliberately gets NO separate index: it is already the
-- leading column of the unique ledger_postings_group_line_key above.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) organization_id derivation — reuse the existing shared trigger
--
--    set_organization_id() respects an explicit value and otherwise derives the
--    organisation from NEW.client_id (this table has one), raising
--    check_violation if it cannot. Attaching it keeps ledger_postings
--    consistent with the other 13 domain tables rather than inventing a second
--    mechanism. The function itself is NOT redefined here.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.ledger_postings;
CREATE TRIGGER set_organization_id_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.set_organization_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Tenant consistency — a posting may never cross organisations
--
--    The FKs in section 2 guarantee existence only; they cannot express "and it
--    belongs to the same organisation". A composite FK was rejected for the
--    same three reasons documented in 20260904120000: ON DELETE behaviour would
--    have to touch organization_id, MATCH SIMPLE skips enforcement on NULLs,
--    and it entangles organization_id in an FK. So this mirrors the established
--    trigger approach instead.
--
--    Both directions required by the phase brief are enforced at ROW level:
--      posting.organization_id = client.organization_id
--      posting.organization_id = grootboekrekening.organization_id
--
--    GROUP-level tenant isolation (all rows of one posting_group_id share one
--    organisation and one client) is enforced separately in section 8, because
--    it can only be judged once the whole group exists.
--
--    The account side reuses the existing public.ledger_link_org_ok(), so there
--    is exactly one definition of "this ledger link is in-organisation" in the
--    schema. Note its IS NOT DISTINCT FROM semantics: a global account
--    (organization_id IS NULL) does NOT satisfy an organisation-scoped posting.
--    That is deliberate and is the strictest safe reading of the rule — a
--    permanent, immutable accounting record must be unambiguously owned by one
--    organisation. The table is empty and has no writers yet, so this contract
--    is being set before any data can depend on a looser one.
--
--    Why this is safe: both functions are SECURITY DEFINER with
--    SET search_path = public (so no search_path shadowing can redirect the
--    lookups), are REVOKEd from PUBLIC, and are never granted to authenticated
--    or anon — they are reachable only as triggers, never as PostgREST RPCs.
--    SECURITY DEFINER is required here because the check must see rows the
--    calling user's RLS may hide: without it, a client or account in another
--    organisation would read as "does not exist" and the cross-tenant write
--    would be accepted rather than refused.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.posting_client_org_ok(
  _client_id uuid,
  _organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Unlike ledger_link_org_ok, a NULL client is NOT tolerated: client_id is
  -- NOT NULL on this table, so a NULL here can only mean a broken caller.
  SELECT EXISTS (
    SELECT 1
    FROM public.clients c
    WHERE c.id = _client_id
      AND c.organization_id IS NOT DISTINCT FROM _organization_id
  );
$$;

-- The account check cannot be public.ledger_link_org_ok: that only compares
-- organization_id, and grootboekrekeningen is scoped one level finer. An
-- account is either organisation-wide (client_id IS NULL — the seeded chart,
-- e.g. the shared 1799 vraagpost) or owned by one administratie (client_id set).
-- With an org-only check, an accounting firm holding administraties A and B
-- could post A's amount onto B's own "4000 Kosten": the future Grootboek reads
-- on (client_id, grootboekrekening_id, posting_date), so the amount would
-- vanish from B's ledger and surface in A's under an account A does not own —
-- silently wrong balances for both, permanently.
--
-- Requiring client_id equality outright would be just as wrong: it would reject
-- every shared account, which is the dominant pattern in this schema. Hence
-- "shared OR mine". ledger_link_org_ok is deliberately left untouched — other
-- tables still use it with the looser meaning that is correct for them.
CREATE OR REPLACE FUNCTION public.posting_account_ok(
  _account_id uuid,
  _organization_id uuid,
  _client_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.grootboekrekeningen g
    WHERE g.id = _account_id
      AND g.organization_id IS NOT DISTINCT FROM _organization_id
      AND (g.client_id IS NULL OR g.client_id = _client_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_ledger_posting_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van deze boeking'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(NEW.grootboekrekening_id, NEW.organization_id, NEW.client_id) THEN
    RAISE EXCEPTION 'grootboekrekening_id verwijst naar een grootboekrekening buiten deze organisatie of van een andere administratie'
      USING ERRCODE = '23514';
  END IF;

  -- A tegenboeking must stay inside the same administratie: an immutable row
  -- may not hold a permanent pointer into another tenant's ledger, which the
  -- RESTRICT FK would then pin in place forever.
  IF NEW.reversal_of_posting_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.ledger_postings p
       WHERE p.id = NEW.reversal_of_posting_id
         AND p.organization_id = NEW.organization_id
         AND p.client_id = NEW.client_id
     ) THEN
    RAISE EXCEPTION 'reversal_of_posting_id verwijst naar een boeking van een andere organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Append-only enforcement
--
--    Four independent layers, so no single misconfiguration re-opens mutation:
--
--      a. RLS (section 9) grants SELECT and INSERT only. With RLS enabled and
--         no permissive UPDATE/DELETE policy, PostgreSQL denies both for
--         authenticated by default. The two missing policies are intentional —
--         every other table in this schema spells out all four.
--      b. Explicit REVOKE of UPDATE/DELETE/TRUNCATE from anon and authenticated,
--         mirroring the read-only backup-table precedent (20260802201226).
--      c. A row-level trigger for UPDATE/DELETE, which also covers roles that
--         bypass RLS — notably service_role, which edge functions use and which
--         would otherwise sail straight past (a) and (b).
--      d. A STATEMENT-level trigger for TRUNCATE. TRUNCATE fires no row-level
--         trigger, so (c) is blind to it; without (d) the whole ledger rested
--         on the REVOKE in (b) alone.
--
--    Privileged maintenance: the trigger blocks every caller unconditionally,
--    including postgres. A genuine DBA correction is therefore an explicit,
--    auditable act rather than an accident:
--
--      ALTER TABLE public.ledger_postings DISABLE TRIGGER prevent_ledger_posting_mutation_trigger;
--      -- ... corrective statement ...
--      ALTER TABLE public.ledger_postings ENABLE  TRIGGER prevent_ledger_posting_mutation_trigger;
--
--    Only the table owner can run that, so the schema stays operable without
--    leaving an in-band bypass that application code could ever reach.
--    Normal corrections never need it: a mistake is fixed by posting a
--    reversing entry, which is a new row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_ledger_posting_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_postings is append-only: % is niet toegestaan. Corrigeer met een tegenboeking in plaats van de bestaande boeking te wijzigen.', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS prevent_ledger_posting_mutation_trigger ON public.ledger_postings;
CREATE TRIGGER prevent_ledger_posting_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_posting_mutation();

-- TRUNCATE fires no ROW trigger, so the trigger above cannot see it — but a
-- STATEMENT-level TRUNCATE trigger can, and has existed since PostgreSQL 8.4.
-- Without this, TRUNCATE rested on the REVOKE alone, and one routine
-- "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role" repair snippet
-- would have silently re-armed it: the entire ledger erasable in one statement
-- while every UPDATE and DELETE stayed correctly blocked.
DROP TRIGGER IF EXISTS prevent_ledger_posting_truncate_trigger ON public.ledger_postings;
CREATE TRIGGER prevent_ledger_posting_truncate_trigger
  BEFORE TRUNCATE ON public.ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_ledger_posting_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Posting-group invariants — a group is one accounting journal entry
--
--    posting_group_id is a journal-entry identity, not a UI grouping key, so
--    the whole group is validated as a unit, not just its arithmetic.
--
--    Implemented as a DEFERRABLE INITIALLY DEFERRED constraint trigger, which
--    is the reason it can be enforced at all in this phase. A plain row trigger
--    would reject the first row of a balanced multi-row entry because the group
--    is only half-written at that instant. A deferred constraint trigger
--    instead fires at COMMIT, when every row of the group already exists, so it
--    always observes the FINAL state of the group.
--
--    PostgreSQL semantics relied on here, deliberately:
--      • a constraint trigger stays ROW-level even when deferred, so this
--        function runs once per inserted row at commit and therefore re-checks
--        the same group several times for a multi-row entry. That redundancy is
--        accepted: every execution evaluates the same committed final state, so
--        the checks are idempotent and the verdict cannot depend on which row
--        happened to fire. Correctness beats saving duplicate work here.
--      • it is AFTER INSERT only. UPDATE and DELETE are blocked outright by
--        section 7, so no later statement can move a validated group out of
--        balance behind this check's back.
--
--    A group must satisfy ALL of:
--      • at least 2 rows — a single-sided entry is not a double entry;
--      • exactly one organization_id  (group-level tenant isolation);
--      • exactly one client_id        (group-level tenant isolation);
--      • exactly one currency;
--      • exactly one posting_date, and exactly one boekjaar;
--      • SUM(debit) = SUM(credit), with both totals strictly > 0.
--
--    Why one organisation/client per group is enforced rather than assumed: a
--    posting_group_id is supplied by the caller, so nothing stops a client from
--    reusing another tenant's group id. Relying on UUID randomness to make that
--    "unlikely" is not enforcement. Without this, two tenants' rows could sum to
--    a balanced group across the tenant boundary.
--
--    Why one currency: a plain SUM(debit) = SUM(credit) would call
--    "100 EUR debit / 100 USD credit" balanced. It is not — the amounts are not
--    commensurable. The currency check runs BEFORE the balance comparison so
--    such a group is rejected on the real reason.
--
--    Why one posting_date: in Dutch bookkeeping a journaalpost has exactly one
--    boekingsdatum; the debit and credit sides of one entry are the same event.
--    Rows on different dates are two entries and belong in two groups. Allowing
--    a split date would also make the entry land in two periods at once, which
--    would silently break any future period or boekjaar close.
--
--    NUMERIC arithmetic is exact, so the equality needs no epsilon — unlike the
--    JavaScript float arithmetic in src/lib/invoice-balances.ts.
--
--    SECURITY DEFINER is load-bearing here, not decoration: the aggregate must
--    see every row of the group. Running as the caller, another tenant's rows
--    in the same group would be filtered out by RLS, the group would look
--    single-tenant and balanced, and the cross-tenant check in this very
--    function would be defeated by the rows it is meant to catch.
--
--    A group can no longer be enlarged after its transaction commits: the
--    created_xact_id seal in 8a refuses the append at insert time, and the
--    COUNT(DISTINCT created_xact_id) check below re-asserts it at COMMIT. No
--    separate journal-header table was needed to achieve that.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 8a) Serialising concurrent writers to the same posting group
--
--    The deferred check in 8b sees committed rows plus its own transaction's
--    rows — it cannot see another in-flight transaction. Two concurrent
--    transactions could therefore each write half of what becomes one group,
--    each validate its own half as balanced, and both commit, leaving a
--    combined group that is invalid and, because the table is append-only,
--    permanently uncorrectable.
--
--    This BEFORE INSERT trigger takes a transaction-scoped advisory lock keyed
--    on posting_group_id, so writers to the SAME group serialise while writers
--    to different groups never block each other. It is named "lock_..." so it
--    sorts before both "set_organization_id_trigger" and "validate_...", which
--    means the lock is held before any validation work happens — the second
--    transaction waits at its first inserted row rather than racing.
--
--    WRITER CONTRACT (deadlock): the lock is taken per inserted row, in row
--    order, and held to COMMIT. A transaction writing several posting groups
--    therefore takes several locks, and two such transactions covering the same
--    groups in opposite orders can deadlock. That is an availability detail,
--    not a correctness one: PostgreSQL detects the cycle and aborts one side
--    with 40P01, so nothing partial is ever committed and every invariant above
--    still holds. It is therefore stated as a contract rather than designed
--    around: write ONE posting group per transaction, or — if a batch writer
--    must cover several — insert them ordered by posting_group_id, which makes
--    a cycle impossible, or retry on 40P01.
--
--    pg_advisory_xact_lock (not pg_advisory_lock) releases automatically at
--    COMMIT or ROLLBACK, so no session-level lock can leak into a pooled
--    connection — which matters because Supabase pools connections.
--
--    KEY DERIVATION: the first 64 bits of the uuid, read straight out of its
--    hex text. This is a pure, deterministic mapping that depends only on
--    documented cast behaviour, not on a hash function whose implementation may
--    differ between PostgreSQL versions (hashtextextended is not contracted to
--    be stable across major versions, and this lock must mean the same thing on
--    every server that runs it). Values above 2^63 wrap to negative bigints,
--    which advisory locks accept.
--
--    COLLISION IMPLICATIONS: two different group ids sharing their first 64
--    bits would share a lock. The consequence is a brief, harmless serialisation
--    of two unrelated groups — never a correctness failure, because the lock
--    only orders writers and every group is still validated on its own rows by
--    8b. So a collision costs a little concurrency and can never admit an
--    invalid group. With random v4 uuids the chance is negligible anyway, and
--    only matters between transactions that are literally in flight at the same
--    instant.
-- ─────────────────────────────────────────────────────────────────────────────

--    ISOLATION LEVEL: the advisory lock orders writers, but ordering alone is
--    not enough under a snapshot-preserving isolation level. Under REPEATABLE
--    READ a writer can establish its snapshot BEFORE waiting on the lock; when
--    it finally acquires the lock it still reads the old snapshot, so the
--    check in 8b cannot see the rows the other transaction just committed, and
--    two individually valid halves can both commit into one invalid group.
--
--    That is not theoretical. Reproduced on PostgreSQL 16 against this exact
--    schema minus the guard below: two REPEATABLE READ transactions sharing a
--    posting_group_id both committed and left a single group spanning TWO
--    organisations, TWO clients and TWO posting dates — permanently, because
--    the table is append-only.
--
--    ONLY READ COMMITTED IS PERMITTED. Everything else is refused before a row
--    is accepted:
--      • READ COMMITTED — allowed. Each statement takes a fresh snapshot, so
--        after the lock is granted the group is re-read including the other
--        transaction's committed rows, and both the seal check below and 8b see
--        the true current state.
--      • REPEATABLE READ — refused, for the snapshot reason above.
--      • SERIALIZABLE — also refused. An earlier revision allowed it on the
--        grounds that SSI turns the interleaving into a write-skew pivot. That
--        argument is too narrow: SSI only arbitrates between transactions that
--        are THEMSELVES serializable. With a READ COMMITTED writer (the
--        PostgREST default) racing a SERIALIZABLE one, no dangerous structure is
--        detected at all, and the SERIALIZABLE transaction still aggregates
--        against its stale snapshot. Allowing it would reintroduce exactly the
--        hole the REPEATABLE READ refusal closes.
--      • READ UNCOMMITTED — refused too. PostgreSQL treats it as READ
--        COMMITTED, but the setting still reports its own name, and an exact
--        contract is worth more here than accommodating a level nothing uses.
--
--    Refusing is the right call for BoekAssist specifically: nothing in this
--    codebase sets an isolation level. Every posting write goes through
--    PostgREST or a SECURITY INVOKER RPC, both of which run at the default
--    READ COMMITTED, and the future writers in 6C-b3+ are server-side code in
--    this same repository. So the guard rejects levels no current or planned
--    caller uses, while making it impossible for a later writer to silently
--    opt into an unsafe one. It is enforced by the database rather than left
--    as a documented convention, so no application code has to remember it.
--
--    SEALING THE GROUP: the lock orders concurrent writers, but on its own it
--    still allowed a COMMITTED group to be enlarged later. Because 8b only
--    checks that the final state is consistent, any assistant could post a
--    second balanced pair onto an existing posting_group_id through a plain
--    PostgREST call and turn a 100,00 entry into 150,00 — permanently, since
--    UPDATE and DELETE are blocked. Mutation-by-append is indistinguishable
--    from a correction and carries no reversal marker, so this defeated the
--    whole immutability guarantee. Delegating the rule to the future writers
--    was not sufficient, because RLS gives authenticated direct INSERT: the
--    writers are not the only path in.
--
--    So a group is now sealed to the transaction that created it, using the
--    created_xact_id stamp. A later transaction attempting to append is
--    refused. Corrections are what they should always have been: a new group.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lock_ledger_posting_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) Isolation contract, refused before the row is accepted rather than at
  --    COMMIT, so nothing is ever written under a level whose snapshot would
  --    blind the group check. Only READ COMMITTED is permitted; see the
  --    comment block above for why SERIALIZABLE is not sufficient either.
  --    current_setting('transaction_isolation') is the level actually in force,
  --    so a caller cannot dodge it by any SET syntax.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ledger_postings mag alleen worden geschreven in een READ COMMITTED transactie (huidig niveau: %). Een snapshot-vasthoudend niveau zou de boekingsgroep-controle een verouderde staat laten zien.', current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- 2) Stamp the creating transaction. Assigned here, never read from the
  --    caller, so a client cannot forge membership of an existing group.
  NEW.created_xact_id := pg_current_xact_id();

  -- 3) Serialise writers to this group BEFORE reading its existing rows, so the
  --    seal check below cannot race another in-flight writer.
  PERFORM pg_advisory_xact_lock(
    ('x' || substr(replace(NEW.posting_group_id::text, '-', ''), 1, 16))::bit(64)::bigint
  );

  -- 4) Seal: a posting group belongs to exactly one transaction. Rows written
  --    by an earlier, already-committed transaction make this group closed
  --    forever. Under READ COMMITTED this statement takes a fresh snapshot, so
  --    it sees those committed rows; the advisory lock above rules out a
  --    concurrent writer. Same-transaction inserts pass, including across
  --    several INSERT statements, because the stamp is identical.
  IF EXISTS (
    SELECT 1
    FROM public.ledger_postings p
    WHERE p.posting_group_id = NEW.posting_group_id
      AND p.created_xact_id <> NEW.created_xact_id
  ) THEN
    RAISE EXCEPTION 'boekingsgroep % is al vastgelegd door een eerdere transactie en kan niet worden uitgebreid; corrigeer met een nieuwe tegenboeking', NEW.posting_group_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8b) Posting-group invariants, checked at COMMIT
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_ledger_posting_group_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows       integer;
  v_orgs       integer;
  v_clients    integer;
  v_currencies integer;
  v_dates      integer;
  v_boekjaren  integer;
  v_xacts      integer;
  v_debit      numeric;
  v_credit     numeric;
BEGIN
  SELECT COUNT(*),
         COUNT(DISTINCT p.organization_id),
         COUNT(DISTINCT p.client_id),
         COUNT(DISTINCT p.currency),
         COUNT(DISTINCT p.posting_date),
         COUNT(DISTINCT p.boekjaar),
         COUNT(DISTINCT p.created_xact_id),
         COALESCE(SUM(p.debit_amount),  0),
         COALESCE(SUM(p.credit_amount), 0)
    INTO v_rows, v_orgs, v_clients, v_currencies, v_dates, v_boekjaren, v_xacts, v_debit, v_credit
  FROM public.ledger_postings p
  WHERE p.posting_group_id = NEW.posting_group_id;

  -- Closing half of the seal. The BEFORE trigger refuses an append at insert
  -- time; this re-asserts it at COMMIT over the group's final state, so the
  -- invariant does not rest on a single check.
  IF v_xacts > 1 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat regels uit meerdere transacties; een boeking wordt in één transactie vastgelegd', NEW.posting_group_id
      USING ERRCODE = '23505';
  END IF;

  IF v_rows < 2 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat % regel; een boeking heeft minimaal een debet- en een creditregel', NEW.posting_group_id, v_rows
      USING ERRCODE = '23514';
  END IF;

  IF v_orgs > 1 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat regels van meerdere organisaties', NEW.posting_group_id
      USING ERRCODE = '23514';
  END IF;

  IF v_clients > 1 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat regels van meerdere administraties', NEW.posting_group_id
      USING ERRCODE = '23514';
  END IF;

  IF v_currencies > 1 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat meerdere valuta; een boeking moet in één valuta zijn', NEW.posting_group_id
      USING ERRCODE = '23514';
  END IF;

  IF v_dates > 1 OR v_boekjaren > 1 THEN
    RAISE EXCEPTION 'boekingsgroep % bevat meerdere boekingsdatums of boekjaren; een boeking heeft één boekingsdatum', NEW.posting_group_id
      USING ERRCODE = '23514';
  END IF;

  IF v_debit <= 0 OR v_credit <= 0 THEN
    RAISE EXCEPTION 'boekingsgroep % moet zowel een debet- als een creditbedrag groter dan nul hebben (debet %, credit %)', NEW.posting_group_id, v_debit, v_credit
      USING ERRCODE = '23514';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'boekingsgroep % is niet in balans: debet % is ongelijk aan credit %', NEW.posting_group_id, v_debit, v_credit
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.lock_ledger_posting_group()                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.posting_client_org_ok(uuid, uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.posting_account_ok(uuid, uuid, uuid)        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_ledger_posting_org()               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_ledger_posting_mutation()          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_ledger_posting_group_balance()     FROM PUBLIC;

-- Fires FIRST of the BEFORE INSERT triggers ("lock_" sorts before "set_" and
-- "validate_"), so concurrent writers to one posting group serialise before any
-- of them does validation work.
DROP TRIGGER IF EXISTS lock_ledger_posting_group_trigger ON public.ledger_postings;
CREATE TRIGGER lock_ledger_posting_group_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.lock_ledger_posting_group();

-- Trigger names start with "validate_" so they sort AFTER
-- "set_organization_id_trigger". PostgreSQL fires per-row triggers in name
-- order, and organization_id must already be resolved before it is compared.
DROP TRIGGER IF EXISTS validate_ledger_posting_org_trigger ON public.ledger_postings;
CREATE TRIGGER validate_ledger_posting_org_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ledger_posting_org();

DROP TRIGGER IF EXISTS validate_ledger_posting_group_balance_trigger ON public.ledger_postings;
CREATE CONSTRAINT TRIGGER validate_ledger_posting_group_balance_trigger
  AFTER INSERT ON public.ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ledger_posting_group_balance();

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) RLS — reuses the existing has_min_role ladder, no new permission framework
--
--    SELECT  : read_only  (anyone who may see the administratie)
--    INSERT  : assistant  (same level that may create journal_entries)
--    UPDATE  : no policy — append-only
--    DELETE  : no policy — append-only
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ledger_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_ledger_postings_select ON public.ledger_postings;
CREATE POLICY role_ledger_postings_select ON public.ledger_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

-- The membership check alone would let any authenticated member submit another
-- existing user's uuid as user_id: the FK would pass, and the posting would be
-- permanently and untraceably attributed to the wrong person — on a row that
-- can never be corrected. Binding user_id to auth.uid() closes that.
--
-- Done in the policy rather than with a trigger that rewrites user_id: a
-- rewriting trigger would silently accept a spoofed value and quietly change
-- it, which hides the caller's intent. Rejecting is the honest behaviour, and
-- the repository has no precedent for auto-filling user_id (no DEFAULT
-- auth.uid() exists anywhere).
--
-- service_role bypasses RLS, so server-side writers can still supply the
-- originating user's uuid explicitly where that is the correct attribution.
DROP POLICY IF EXISTS role_ledger_postings_insert ON public.ledger_postings;
CREATE POLICY role_ledger_postings_insert ON public.ledger_postings
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND user_id = auth.uid()
  );

-- anon must never reach accounting data, and no application role may mutate a
-- posted row (layer (b) of section 7).
--
-- service_role is included deliberately. It is the one role where neither of
-- the other two layers helps: it bypasses RLS, so layer (a) is irrelevant to
-- it, and TRUNCATE fires no row-level trigger at all, so layer (c) cannot see
-- it either — a single TRUNCATE would silently erase the entire ledger while
-- every UPDATE and DELETE stayed correctly blocked. Privilege is therefore the
-- only mechanism that closes this, and it must be applied to service_role
-- explicitly rather than assumed from RLS.
--
-- UPDATE and DELETE are revoked from service_role too, as defence in depth:
-- the mutation trigger already refuses them, but a REVOKE stops the statement
-- one layer earlier and keeps the privilege grid stating the intent outright,
-- so the trigger is not the single point of failure for an RLS-exempt role.
--
-- service_role keeps SELECT and INSERT, so edge functions can still read and
-- write postings normally.
REVOKE ALL ON public.ledger_postings FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.ledger_postings FROM anon, authenticated, service_role;

-- The table owner keeps TRUNCATE (ownership privileges cannot be revoked from
-- the owner), so the documented owner-only maintenance path in section 7 stays
-- operable. That is intended: maintenance is an explicit, auditable act by a
-- DBA, not something any application role can reach.

-- ─────────────────────────────────────────────────────────────────────────────
-- 10) Documentation
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.ledger_postings IS
'Append-only grootboekboekingen. Eén rij = één debet- of creditzijde; een volledige boeking is de set rijen met hetzelfde posting_group_id, die per groep in balans moet zijn. Rijen worden nooit gewijzigd of verwijderd — een correctie is een nieuwe tegenboeking. Wordt in fase 6C-b2 nog door geen enkele workflow gevuld.';

COMMENT ON COLUMN public.ledger_postings.created_xact_id IS
'De databasetransactie die deze regel schreef. Door de trigger gezet, nooit door de client. Verzegelt de boekingsgroep: alle regels van één posting_group_id horen bij dezelfde transactie, zodat een al vastgelegde boeking later niet kan worden uitgebreid.';

COMMENT ON COLUMN public.ledger_postings.posting_group_id IS
'Groepeert de debet- en creditrijen van één boeking. De groep moet atomair in één transactie worden weggeschreven en in balans zijn.';

COMMENT ON COLUMN public.ledger_postings.line_no IS
'Regelvolgorde binnen de boekingsgroep; uniek per posting_group_id.';

COMMENT ON COLUMN public.ledger_postings.boekjaar IS
'Boekjaar waaraan deze boeking wordt toegerekend. Expliciet opgeslagen omdat een gebroken boekjaar niet gelijk hoeft te zijn aan het kalenderjaar van posting_date.';

COMMENT ON COLUMN public.ledger_postings.source_type IS
'Herkomst van de boeking, als lowercase snake_case. De CHECK bewaakt alleen de vorm, niet de waarde: nieuwe bronsoorten komen erbij zonder schemamigratie. Bekende waarden: purchase_invoice (6C-b3), sales_invoice (6C-b4), bank_transaction (6C-b5), manual_journal (6C-b6), opening_balance, correction. Elke schrijverfase bewaakt zijn eigen bronsoort met een eigen idempotency-constraint.';

COMMENT ON COLUMN public.ledger_postings.source_line_id IS
'Optionele regel binnen het brondocument. Let op: purchase_invoice_lines.id is niet duurzaam (regels worden bij elke opslag verwijderd en opnieuw ingevoegd), dus dit veld is geen permanente identiteit.';

COMMENT ON COLUMN public.ledger_postings.reversal_of_posting_id IS
'Verwijst naar de boeking die door deze regel wordt tegengeboekt. NULL voor gewone boekingen.';

COMMENT ON FUNCTION public.posting_client_org_ok(uuid, uuid) IS
'TRUE wanneer de administratie (client) binnen dezelfde organisatie valt als de boeking. Gebruikt door de tenant-consistency trigger op ledger_postings.';
