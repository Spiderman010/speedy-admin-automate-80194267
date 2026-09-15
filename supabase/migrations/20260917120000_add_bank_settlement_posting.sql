-- Migration: bank settlement postings (phase 6C-b5b)
--
-- Purpose: the third production accounting writer. Posts ONE bank allocation
-- (one row of public.bank_transaction_allocations: "this bank transaction
-- settles this much of this invoice") into public.ledger_postings as one
-- balanced, immutable, tenant-safe two-leg group, exactly once. It moves the
-- open item from the debtor/creditor account to the bank account; it books
-- no revenue, no expense and no VAT — those were booked by the invoice
-- writers (6C-b3 purchase, 6C-b4 sales) and this writer requires that to have
-- happened first.
--
-- Contents:
--   1. public.bank_allocation_postings — the atomic source-claim marker
--   2. public.post_bank_allocation(uuid) — the only supported write path
--   3. enforce_bank_source_claim() — ledger_postings guard for this source
--   4. prevent_posted_bank_allocation_mutation() — posted allocation freeze
--   5. prevent_posted_bank_transaction_mutation() — posted bank row freeze
--
-- NO BACKFILL. No existing allocation is posted by this migration; there is
-- deliberately not a single INSERT INTO public.ledger_postings outside the
-- function body. Nothing is auto-posted on save, on match, or on import.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT — proven facts this writer builds on (evidence, not assumption)
--
-- 1. SIGN SEMANTICS. bank_transactions.amount is SIGNED: >= 0 is money in
--    (a customer paying → 'verkoop'), < 0 is money out (paying a supplier →
--    'inkoop'). Evidence: src/pages/Bank.tsx:111 (direction derived from the
--    sign), src/lib/ledger-mutations.ts:345 and src/lib/snelstart-export.ts:268
--    (both branch on amount < 0 for the SnelStart in/uit split).
--
-- 2. ALLOCATION AMOUNT IS UNSIGNED. bank_transaction_allocations.amount is
--    NUMERIC(12,2) NOT NULL CHECK (amount > 0) (20260515120000); the UI derives
--    it from Math.abs(tx.amount). Direction is NOT stored on the allocation —
--    it comes from invoice_type ('inkoop' | 'verkoop', CHECK-constrained) and
--    MUST be cross-checked against the transaction sign, which this writer
--    does: a 'verkoop' allocation on an outgoing transaction is refused, as is
--    an 'inkoop' allocation on an incoming one, as is amount = 0.
--
-- 3. THE CLAIM KEY IS THE ALLOCATION ID, not the transaction id and not the
--    invoice id. Both of those are one-to-many with respect to settlements:
--    one transaction may settle several invoices (many allocations per tx,
--    UNIQUE (bank_transaction_id, invoice_id) only), and one invoice may be
--    settled by several transactions (partial payments). The allocation row —
--    id UUID PRIMARY KEY — is the one durable, one-to-one identity of "this
--    much of this invoice was settled by this transaction", so it is the
--    marker's primary key. invoice_id has NO foreign key (it is polymorphic
--    over purchase_invoices / sales_invoices, discriminated by invoice_type),
--    so the writer resolves the invoice itself, per branch.
--
-- 4. THE INVOICE MUST ALREADY CARRY A POSTING MARKER. A settlement entry
--    (DEBIT bank / CREDIT debiteuren) is only meaningful if the open item it
--    clears exists in the ledger, i.e. the invoice was posted by
--    post_sales_invoice() / post_purchase_invoice(). The invoice STATUS proves
--    nothing here: 'betaald' / 'gecontroleerd' are freely settable and say
--    nothing about whether ledger rows exist. The marker tables
--    (sales_invoice_postings / purchase_invoice_postings) are the only proof,
--    so their existence is required, and the invoice row is locked FOR SHARE
--    so that a posting of the invoice in flight is waited for (see lock order).
--
-- 5. ACCOUNT RESOLUTION. Every account comes from the client configuration:
--      bank        → clients.bank_rekening_id        (6C-b5a, 20260916120000)
--      debiteuren  → clients.debiteuren_rekening_id  (20260904120000)
--      crediteuren → clients.crediteuren_rekening_id (20260904120000)
--    bank_rekening_id is validated at configuration time by
--    posting_account_ok() inside enforce_client_ledger_org(); the writer
--    re-checks the same predicate at posting time for all three accounts.
--    NEVER used, deliberately: clients.bank_dagboek (a SnelStart dagboek
--    number, not an account), account number 1100 (a UI fallback for that
--    dagboek, not evidence of a grootboekrekening), bank_transactions.
--    grootboekrekening_id (the CONTRA account of a manually booked mutation,
--    not the bank account), the legacy bank_transactions.ledger_account_id
--    (points at ledger_accounts, not grootboekrekeningen), and
--    grootboekrekeningen.categorie (has no 'bank' value). No account is ever
--    invented and there is no silent fallback: a missing account fails the
--    whole posting.
--
-- 6. PARTIAL / MULTI SEMANTICS. amount = allocation.amount, used as-is — never
--    recalculated from the transaction, never clamped to the invoice. A partial
--    receipt posts a partial settlement; several allocations on one
--    transaction each post their own group; several transactions on one
--    invoice each post their own group. What the writer REFUSES is
--    inconsistent state: over-allocation is enforced ONLY client-side today
--    (src/pages/Bank.tsx:455-500, with a 0.001 tolerance) and there is NO
--    database constraint, so before claiming it checks — in exact NUMERIC, no
--    tolerance — that this allocation and the sum of all allocations on the
--    transaction fit inside abs(tx.amount), and that this allocation and the
--    sum of all allocations on the invoice fit inside the invoice's
--    amount_incl. An overpayment (customer pays more than the invoice) is a
--    real-world case but is NOT supported by this phase: it needs a
--    betalingsverschil / vooruitontvangen leg that this contract deliberately
--    does not book. No suspense account, no 1799, no payment-difference leg.
--
-- 7. DATE / BOEKJAAR / CURRENCY. posting_date = bank_transactions.
--    transaction_date (NOT NULL; the date the money moved, which is what a
--    bank journal books on — never the invoice date, never created_at, never
--    now()). boekjaar = calendar year of that date, matching the purchase and
--    sales writers (no broken-fiscal-year support exists anywhere). currency =
--    'EUR', passed explicitly, exactly as the invoice writers do — there is no
--    currency column anywhere in the schema.
--
-- 8. CLOSED YEAR. Posting into a year at or before clients.afgesloten_boekjaar
--    is refused, identically to purchase and sales.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ENTRY — one group, exactly two legs, amount = allocation.amount
--
--   invoice_type = 'verkoop'  (requires bank_transactions.amount > 0)
--     DEBIT   clients.bank_rekening_id
--     CREDIT  clients.debiteuren_rekening_id
--
--   invoice_type = 'inkoop'   (requires bank_transactions.amount < 0)
--     DEBIT   clients.crediteuren_rekening_id
--     CREDIT  clients.bank_rekening_id
--
-- source_type = 'bank_allocation', source_id = allocation.id,
-- source_line_id = NULL (an allocation has no lines).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCK ORDER — documented once here, followed exactly in the function body
--
--   allocation (FOR UPDATE)
--     → bank transaction (FOR UPDATE)
--       → source invoice (FOR SHARE)
--         → invoice marker (read)
--           → client / accounts (reads)
--             → claim INSERT (marker)
--               → ledger INSERTs
--
-- Why there is no lock cycle: the purchase and sales writers only ever lock
-- their own invoice row (FOR UPDATE) and never touch allocations or bank rows;
-- the app's allocation and bank mutations (useUpsertBankTransactionAllocation,
-- useDeleteBankTransactionAllocation, bank_transactions updates) are separate,
-- single-table transactions. Every path therefore acquires locks in a
-- consistent direction relative to this one. A concurrent allocation INSERT
-- on the same bank transaction takes a KEY SHARE lock on the bank_transactions
-- row for its foreign key (bta_tx_user_client_fk); KEY SHARE conflicts with
-- our FOR UPDATE, so that INSERT waits until this posting commits — which is
-- exactly the serialisation that makes the per-transaction SUM check below
-- sound rather than a best-effort read. The FOR SHARE on the invoice makes a
-- post_sales_invoice()/post_purchase_invoice() in flight (FOR UPDATE on that
-- row) finish first: after its commit the marker is visible and we proceed,
-- after its rollback we refuse with "nog niet geboekt".
--
-- clients.bank_rekening_id is deliberately NOT frozen by this migration. The
-- ledger rows persist the actual grootboekrekening_id that was used, so a
-- later configuration change only affects FUTURE settlements and can never
-- rewrite history; freezing the client's bank account would also block
-- legitimate re-configuration (a new bank, an IBAN split) for every client
-- that ever posted a settlement.
--
-- CORRECTIONS: once posted, an allocation cannot be posted again — the marker
-- is a hard claim — and neither the allocation nor the accounting fields of
-- its bank transaction can change or be deleted (sections 4/5). Corrections
-- require the future reversal workflow that writes NEW immutable rows.
--
-- rollback:
--   DROP TRIGGER IF EXISTS prevent_posted_bank_transaction_mutation_trigger ON public.bank_transactions;
--   DROP TRIGGER IF EXISTS prevent_posted_bank_allocation_mutation_trigger ON public.bank_transaction_allocations;
--   DROP TRIGGER IF EXISTS validate_bank_source_claim_trigger ON public.ledger_postings;
--   DROP FUNCTION IF EXISTS public.prevent_posted_bank_transaction_mutation();
--   DROP FUNCTION IF EXISTS public.prevent_posted_bank_allocation_mutation();
--   DROP FUNCTION IF EXISTS public.enforce_bank_source_claim();
--   DROP FUNCTION IF EXISTS public.post_bank_allocation(uuid);
--   DROP POLICY IF EXISTS role_bank_allocation_postings_select ON public.bank_allocation_postings;
--   DROP INDEX IF EXISTS public.idx_bank_allocation_postings_invoice;
--   DROP INDEX IF EXISTS public.idx_bank_allocation_postings_bank_transaction;
--   DROP INDEX IF EXISTS public.idx_bank_allocation_postings_client;
--   DROP INDEX IF EXISTS public.idx_bank_allocation_postings_organization;
--   DROP TABLE IF EXISTS public.bank_allocation_postings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The claim marker — same design as purchase_invoice_postings and
--    sales_invoice_postings, keyed on the allocation
--
--    allocation_id is the PRIMARY KEY, and that single fact is the whole
--    idempotency guarantee: the second claim of an allocation cannot exist.
--    posting_group_id is UNIQUE, so one allocation ↔ one group.
--
--    The marker also records what was claimed (bank_transaction_id, invoice,
--    invoice_type, amount) so that the audit trail survives independently of
--    the allocation row it explains, and so the bank-transaction freeze below
--    can find "has anything on this transaction been posted?" with an index.
--
--    Under concurrency the primary key index is also the serialisation point:
--    the second transaction blocks on the uncommitted key until the first
--    commits, then fails with unique_violation. Claim and ledger rows are
--    written in the same transaction, so an allocation is either fully posted
--    or not posted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bank_allocation_postings (
  allocation_id       uuid          PRIMARY KEY,
  posting_group_id    uuid          NOT NULL UNIQUE,
  organization_id     uuid          NOT NULL,
  client_id           uuid          NOT NULL,
  bank_transaction_id uuid          NOT NULL,
  invoice_id          uuid          NOT NULL,
  invoice_type        text          NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  user_id             uuid          NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

-- RESTRICT throughout: this row is the audit trail proving why immutable ledger
-- rows exist. It must never be cascade-deleted out from under them. Note the
-- contrast with bta_tx_user_client_fk on the allocation table itself, which is
-- ON DELETE CASCADE: that cascade is stopped from ever reaching a posted
-- allocation by the bank-transaction freeze in section 5, and even if it were
-- not, this RESTRICT would refuse the delete at the marker.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'bank_allocation_postings'
      AND c.conname = 'bank_allocation_postings_allocation_id_fkey'
  ) THEN
    ALTER TABLE public.bank_allocation_postings
      ADD CONSTRAINT bank_allocation_postings_allocation_id_fkey
      FOREIGN KEY (allocation_id) REFERENCES public.bank_transaction_allocations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'bank_allocation_postings'
      AND c.conname = 'bank_allocation_postings_bank_transaction_id_fkey'
  ) THEN
    ALTER TABLE public.bank_allocation_postings
      ADD CONSTRAINT bank_allocation_postings_bank_transaction_id_fkey
      FOREIGN KEY (bank_transaction_id) REFERENCES public.bank_transactions (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'bank_allocation_postings'
      AND c.conname = 'bank_allocation_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.bank_allocation_postings
      ADD CONSTRAINT bank_allocation_postings_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'bank_allocation_postings'
      AND c.conname = 'bank_allocation_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.bank_allocation_postings
      ADD CONSTRAINT bank_allocation_postings_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'bank_allocation_postings'
      AND c.conname = 'bank_allocation_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.bank_allocation_postings
      ADD CONSTRAINT bank_allocation_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_organization
  ON public.bank_allocation_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_client
  ON public.bank_allocation_postings (client_id);

-- Used by the bank-transaction freeze (section 5) on every UPDATE/DELETE of a
-- bank row, so it must be an index lookup, not a scan.
CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_bank_transaction
  ON public.bank_allocation_postings (bank_transaction_id);

-- "Which settlements were posted against this invoice?" — invoice_id alone is
-- ambiguous across the two invoice tables, hence the type in front.
CREATE INDEX IF NOT EXISTS idx_bank_allocation_postings_invoice
  ON public.bank_allocation_postings (invoice_type, invoice_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Marker privileges — read-only for the app, writable only by the RPC
--
--    Same reasoning as the invoice markers: a client able to write the marker
--    directly could fabricate a claim (blocking a legitimate posting forever)
--    or delete one (enabling a duplicate). SELECT-only for every application
--    role.
--
--    service_role is NOT granted EXECUTE on the writer function below, and is
--    revoked here from mutating the marker directly. No edge function
--    currently needs to post settlements; if one ever does, that is a
--    deliberate, separately-reviewed grant, not a default to fall into.
--
--    The reset is REVOKE ALL then GRANT SELECT, not an enumerated REVOKE list.
--    Enumerating (INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, ...)
--    is a list that can always be one item short of whatever Lovable Cloud's
--    default privileges hand out next — MAINTAIN exists as of PostgreSQL 17,
--    for instance, and nothing here otherwise blocks a future default from
--    granting it. REVOKE ALL has no such gap: it clears every privilege that
--    exists on the table for that role, known or not yet invented, and the
--    single GRANT SELECT immediately afterwards restores exactly the read
--    access this table is meant to have. This is a full reset, not a
--    difference from some assumed starting privilege set.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.bank_allocation_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_bank_allocation_postings_select ON public.bank_allocation_postings;
CREATE POLICY role_bank_allocation_postings_select ON public.bank_allocation_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.bank_allocation_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.bank_allocation_postings TO authenticated, service_role;

COMMENT ON TABLE public.bank_allocation_postings IS
'Claim-registratie: bewijst dat één bankkoppeling (bank_transaction_allocations-rij) precies één keer als aflettering is geboekt. De primary key op allocation_id ís de idempotentiegarantie; een banktransactie of factuur kan meerdere koppelingen hebben en is daarom bewust geen sleutel. Alleen public.post_bank_allocation() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The writer
--
--    SECURITY DEFINER is required, not preferred: the marker table is
--    deliberately not writable by authenticated (section 2), so an INVOKER
--    function could not claim the allocation. Because the definer bypasses
--    RLS, every check RLS would normally perform is done explicitly below.
--
--    The ONLY caller input is _allocation_id. organization_id, client_id,
--    user_id, posting_group_id, direction, amount, accounts, date, boekjaar
--    and currency are all derived server-side; created_xact_id is stamped by
--    the ledger's own trigger and is not settable here at all.
--
--    The body follows the lock order documented in the header, in that exact
--    sequence: allocation → bank transaction → source invoice → (marker read)
--    → client/accounts (reads) → claim insert → ledger inserts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_bank_allocation(_allocation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_alloc            public.bank_transaction_allocations%ROWTYPE;
  v_tx               public.bank_transactions%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_inv_id           uuid;
  v_inv_client_id    uuid;
  v_inv_org_id       uuid;
  v_inv_amount_incl  numeric(12,2);
  v_inv_number       text;
  v_inv_name         text;
  v_sum_tx           numeric(12,2);
  v_sum_inv          numeric(12,2);
  v_debit_account    uuid;
  v_credit_account   uuid;
  v_debit_desc       text;
  v_credit_desc      text;
  v_line_no          integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- LOCK 1 — the allocation, FOR UPDATE. The app's allocation mutations
  -- (upsert of the amount, delete) lock this same row, so whichever starts
  -- first finishes first: a mutation in flight makes posting wait and then
  -- read the fully committed new row; a posting in flight makes the mutation
  -- wait and then be refused by the freeze in section 4, because the marker
  -- now exists.
  SELECT * INTO v_alloc
  FROM public.bank_transaction_allocations
  WHERE id = _allocation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bankkoppeling niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Tenant + role, both from stored data. organization_id is nullable in the
  -- allocation DDL (backfilled later), so NULL fails closed. 'assistant'
  -- matches the minimum the ledger_postings INSERT policy itself requires.
  IF v_alloc.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_alloc.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- LOCK 2 — the bank transaction, FOR UPDATE. This is what serialises the
  -- per-transaction over-allocation check: a concurrent allocation INSERT on
  -- this transaction needs a KEY SHARE lock on this row for its FK and waits
  -- here; a concurrent amount/date/client update of the transaction waits
  -- here too, and after our commit is refused by the freeze in section 5.
  SELECT * INTO v_tx
  FROM public.bank_transactions
  WHERE id = v_alloc.bank_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banktransactie niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.client_id <> v_alloc.client_id
     OR v_tx.organization_id IS DISTINCT FROM v_alloc.organization_id THEN
    RAISE EXCEPTION 'Banktransactie hoort niet bij dezelfde administratie/organisatie als de koppeling'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_alloc.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_alloc.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze koppeling' USING ERRCODE = '42501';
  END IF;

  -- LOCK 3 — the source invoice, FOR SHARE, per branch. FOR SHARE (not FOR
  -- UPDATE) is enough: we do not change the invoice, we only need a posting
  -- of it that is in flight (FOR UPDATE inside post_*_invoice) to finish
  -- before we look for its marker, and we need the invoice not to be moved to
  -- another administratie underneath us. The invoice writers' own freeze
  -- keeps the amounts stable once their marker exists.
  IF v_alloc.invoice_type = 'inkoop' THEN
    SELECT id, client_id, organization_id, amount_incl, invoice_number, supplier
      INTO v_inv_id, v_inv_client_id, v_inv_org_id, v_inv_amount_incl, v_inv_number, v_inv_name
    FROM public.purchase_invoices
    WHERE id = v_alloc.invoice_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv_client_id <> v_alloc.client_id
       OR v_inv_org_id IS DISTINCT FROM v_alloc.organization_id THEN
      RAISE EXCEPTION 'Factuur hoort niet bij dezelfde administratie' USING ERRCODE = '42501';
    END IF;

    -- The marker, not the status, proves the open item exists in the ledger.
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase_invoice_postings WHERE purchase_invoice_id = v_alloc.invoice_id
    ) THEN
      RAISE EXCEPTION 'Inkoopfactuur is nog niet geboekt in het grootboek; een aflettering vereist een geboekte factuur'
        USING ERRCODE = '22023';
    END IF;

    -- Direction: paying a supplier is money OUT (Bank.tsx:111,
    -- ledger-mutations.ts:345, snelstart-export.ts:268). Zero is refused too.
    IF v_tx.amount >= 0 THEN
      RAISE EXCEPTION 'Een inkoopkoppeling vereist een uitgaande banktransactie' USING ERRCODE = '22023';
    END IF;

    IF v_client.crediteuren_rekening_id IS NULL THEN
      RAISE EXCEPTION 'Geen crediteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;

  ELSIF v_alloc.invoice_type = 'verkoop' THEN
    SELECT id, client_id, organization_id, amount_incl, invoice_number, customer_name
      INTO v_inv_id, v_inv_client_id, v_inv_org_id, v_inv_amount_incl, v_inv_number, v_inv_name
    FROM public.sales_invoices
    WHERE id = v_alloc.invoice_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Verkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv_client_id <> v_alloc.client_id
       OR v_inv_org_id IS DISTINCT FROM v_alloc.organization_id THEN
      RAISE EXCEPTION 'Factuur hoort niet bij dezelfde administratie' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.sales_invoice_postings WHERE sales_invoice_id = v_alloc.invoice_id
    ) THEN
      RAISE EXCEPTION 'Verkoopfactuur is nog niet geboekt in het grootboek; een aflettering vereist een geboekte factuur'
        USING ERRCODE = '22023';
    END IF;

    -- Direction: a customer paying is money IN. Zero is refused too.
    IF v_tx.amount <= 0 THEN
      RAISE EXCEPTION 'Een verkoopkoppeling vereist een inkomende banktransactie' USING ERRCODE = '22023';
    END IF;

    IF v_client.debiteuren_rekening_id IS NULL THEN
      RAISE EXCEPTION 'Geen debiteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;

  ELSE
    -- Unreachable through the CHECK constraint on invoice_type, but the
    -- writer does not lean on a constraint it does not own.
    RAISE EXCEPTION 'Onbekend koppelingstype: %', v_alloc.invoice_type USING ERRCODE = '22023';
  END IF;

  -- Configuration. No fallback account, ever: not bank_dagboek, not a number.
  IF v_client.bank_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen bankrekening (grootboek) ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- Amount consistency, all NUMERIC, no tolerance, no clamping. The database
  -- has no over-allocation constraint (only Bank.tsx checks it, with a
  -- tolerance), so the writer refuses inconsistent state instead of posting
  -- it. The allocation amount itself is used as-is; it is never recalculated.
  IF v_alloc.amount <= 0 THEN
    RAISE EXCEPTION 'Koppelingsbedrag moet groter dan nul zijn' USING ERRCODE = '22023';
  END IF;

  IF v_alloc.amount > abs(v_tx.amount) THEN
    RAISE EXCEPTION 'Koppelingsbedrag (%) is hoger dan het banktransactiebedrag (%)', v_alloc.amount, abs(v_tx.amount)
      USING ERRCODE = '23514';
  END IF;

  -- Sound under concurrency because of LOCK 2: a competing INSERT on this
  -- transaction is waiting on our FOR UPDATE and cannot be in this sum yet.
  SELECT COALESCE(SUM(amount), 0) INTO v_sum_tx
  FROM public.bank_transaction_allocations
  WHERE bank_transaction_id = v_tx.id;
  IF v_sum_tx > abs(v_tx.amount) THEN
    RAISE EXCEPTION 'De koppelingen op deze banktransactie (%) overschrijden samen het transactiebedrag (%)', v_sum_tx, abs(v_tx.amount)
      USING ERRCODE = '23514';
  END IF;

  IF v_inv_amount_incl IS NULL THEN
    RAISE EXCEPTION 'Factuur mist een bedrag inclusief BTW; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  IF v_alloc.amount > v_inv_amount_incl THEN
    RAISE EXCEPTION 'Koppelingsbedrag (%) is hoger dan het factuurbedrag (%)', v_alloc.amount, v_inv_amount_incl
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum_inv
  FROM public.bank_transaction_allocations
  WHERE invoice_type = v_alloc.invoice_type
    AND invoice_id = v_alloc.invoice_id;
  IF v_sum_inv > v_inv_amount_incl THEN
    RAISE EXCEPTION 'De koppelingen op deze factuur (%) overschrijden samen het factuurbedrag (%); een overbetaling wordt nog niet ondersteund', v_sum_inv, v_inv_amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Date: the day the money moved. transaction_date is NOT NULL.
  v_boekjaar := EXTRACT(YEAR FROM v_tx.transaction_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- Account scope: every account must be usable by THIS administratie — the
  -- same predicate ledger_postings enforces per row, checked up front so the
  -- refusal names the account instead of surfacing as a generic row error.
  IF NOT public.posting_account_ok(v_client.bank_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
    RAISE EXCEPTION 'De ingestelde bankrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_alloc.invoice_type = 'verkoop' THEN
    IF NOT public.posting_account_ok(v_client.debiteuren_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
      RAISE EXCEPTION 'De ingestelde debiteurenrekening hoort niet bij deze organisatie of administratie'
        USING ERRCODE = '23514';
    END IF;
    -- Money in: DEBIT bank, CREDIT the debtor.
    v_debit_account  := v_client.bank_rekening_id;
    v_credit_account := v_client.debiteuren_rekening_id;
    v_debit_desc     := COALESCE(v_inv_number, 'Bankaflettering');
    v_credit_desc    := COALESCE(v_inv_name, 'Debiteur');
  ELSE
    IF NOT public.posting_account_ok(v_client.crediteuren_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
      RAISE EXCEPTION 'De ingestelde crediteurenrekening hoort niet bij deze organisatie of administratie'
        USING ERRCODE = '23514';
    END IF;
    -- Money out: DEBIT the creditor, CREDIT bank.
    v_debit_account  := v_client.crediteuren_rekening_id;
    v_credit_account := v_client.bank_rekening_id;
    v_debit_desc     := COALESCE(v_inv_name, 'Crediteur');
    v_credit_desc    := COALESCE(v_inv_number, 'Bankaflettering');
  END IF;

  -- Claim the allocation. The primary key is the idempotency guarantee and,
  -- under concurrency, the serialisation point: a second session blocks here
  -- until the first commits and then fails.
  BEGIN
    INSERT INTO public.bank_allocation_postings (
      allocation_id, posting_group_id, organization_id, client_id,
      bank_transaction_id, invoice_id, invoice_type, amount, user_id
    ) VALUES (
      v_alloc.id, v_group_id, v_alloc.organization_id, v_alloc.client_id,
      v_tx.id, v_inv_id, v_alloc.invoice_type, v_alloc.amount, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze bankkoppeling is al geboekt' USING ERRCODE = '23505';
  END;

  -- Line 1 — DEBIT (bank for verkoop, crediteuren for inkoop).
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_alloc.organization_id, v_alloc.client_id, v_debit_account, v_group_id, v_line_no,
    v_tx.transaction_date, v_boekjaar, v_alloc.amount, 0, 'EUR',
    v_debit_desc, 'bank_allocation', v_alloc.id, NULL, v_uid
  );

  -- Line 2 — CREDIT (debiteuren for verkoop, bank for inkoop).
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_alloc.organization_id, v_alloc.client_id, v_credit_account, v_group_id, v_line_no,
    v_tx.transaction_date, v_boekjaar, 0, v_alloc.amount, 'EUR',
    v_credit_desc, 'bank_allocation', v_alloc.id, NULL, v_uid
  );

  RETURN v_group_id;
END
$$;

-- Trigger-only/administrative surface hardening: the function must be callable
-- by the app, but never by anon, never by service_role, never by PUBLIC.
--
-- REVOKE FROM PUBLIC alone is not sufficient. PUBLIC is a pseudo-role that new
-- privileges are not granted to by default, but Lovable Cloud has already been
-- observed granting role-specific privileges directly to individual roles on
-- newly created objects — a grant made straight to anon or service_role
-- survives a REVOKE that only names PUBLIC. The revoke below names every
-- application role explicitly, so nothing is left to a default surviving
-- unnoticed.
REVOKE ALL ON FUNCTION public.post_bank_allocation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_allocation(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_bank_allocation(uuid) IS
'Boekt één bankkoppeling (aflettering) als sluitende tweeregelige boeking in ledger_postings — bank tegen debiteuren (verkoop, inkomend) of crediteuren tegen bank (inkoop, uitgaand) — en claimt hem in bank_allocation_postings, atomair en precies één keer. Vereist dat de factuur al geboekt is. Enige invoer is de koppeling-id; organisatie, administratie, gebruiker, richting, bedrag, rekeningen, datum, boekjaar en valuta worden server-side afgeleid.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Source-level exactly-once, enforced on ledger_postings itself
--
--    The marker's primary key only protects calls that go through
--    post_bank_allocation(). It does not protect the table: authenticated has
--    a direct INSERT on ledger_postings, so after a legitimate posting an
--    assistant could still insert a SECOND balanced group for the same
--    allocation under a different posting_group_id.
--
--    This trigger closes that by making the marker the single authority for
--    bank_allocation rows: such a ledger row may only exist if it matches its
--    allocation's marker exactly, including the posting group. Since
--    posting_group_id is UNIQUE on the marker, exactly one group per
--    allocation can ever exist.
--
--    Deliberately scoped to source_type = 'bank_allocation' only — the same
--    discipline as the purchase and sales guards, so 6C-b6 keeps its own
--    contract.
--
--    It permits post_bank_allocation() because that function inserts the
--    marker first and the ledger rows afterwards in the same transaction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_bank_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.bank_allocation_postings%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'bank_allocation' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een afletteringsboeking moet naar een bankkoppeling verwijzen' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.bank_allocation_postings
  WHERE allocation_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze bankkoppeling is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een bankkoppeling kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte bankkoppeling'
      USING ERRCODE = '23514';
  END IF;

  -- grootboekrekening_id is NOT NULL on the table already; re-asserted here so
  -- this guard does not lean on a column constraint it does not own. A group
  -- has exactly two legs, and nothing else about a leg is marker-derived.
  IF NEW.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Een afletteringsregel moet een grootboekrekening hebben' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_source_claim() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so organization_id is
-- already resolved when it is compared against the marker.
DROP TRIGGER IF EXISTS validate_bank_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_bank_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_source_claim();

COMMENT ON FUNCTION public.enforce_bank_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=bank_allocation exact overeenkomt met de claim in bank_allocation_postings. Sluit een tweede boekingsgroep via een directe INSERT uit.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) A posted allocation is frozen
--
--    Without this, useUpsertBankTransactionAllocation (amount overwrite on
--    conflict) and the delete mutations would happily change or remove an
--    already-posted allocation. The ledger would then describe a settlement
--    the source no longer contains, with nothing revealing the divergence.
--
--    Frozen once a marker exists: id, amount, bank_transaction_id, client_id,
--    invoice_id, invoice_type, organization_id, user_id — every column that
--    fed the entry or identifies it. created_at and updated_at remain free
--    (update_bank_transaction_allocations_updated_at keeps bumping the latter
--    and it is not accounting). DELETE is refused outright.
--
--    Explicit TG_OP branches, never COALESCE(NEW.x, OLD.x): on UPDATE, NEW is
--    always present, so a COALESCE would never examine OLD and re-pointing a
--    POSTED row to a new identity would pass. Both sides are checked: the
--    OLD identity must not be posted (freeze), and if the id itself changes,
--    the NEW identity must not be posted either (no re-pointing an unposted
--    row onto a posted identity).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_posted_bank_allocation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Deze bankkoppeling is geboekt; verwijderen is niet mogelijk. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF EXISTS (
    SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = OLD.id
  ) THEN
    IF NEW.id                  IS DISTINCT FROM OLD.id
       OR NEW.amount              IS DISTINCT FROM OLD.amount
       OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
       OR NEW.client_id           IS DISTINCT FROM OLD.client_id
       OR NEW.invoice_id          IS DISTINCT FROM OLD.invoice_id
       OR NEW.invoice_type        IS DISTINCT FROM OLD.invoice_type
       OR NEW.organization_id     IS DISTINCT FROM OLD.organization_id
       OR NEW.user_id             IS DISTINCT FROM OLD.user_id
    THEN
      RAISE EXCEPTION 'Deze bankkoppeling is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id AND EXISTS (
    SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Deze bankkoppeling-identiteit is al geboekt; een andere koppeling kan er niet naartoe worden verplaatst.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_bank_allocation_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posted_bank_allocation_mutation_trigger ON public.bank_transaction_allocations;
CREATE TRIGGER prevent_posted_bank_allocation_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_bank_allocation_mutation();

COMMENT ON FUNCTION public.prevent_posted_bank_allocation_mutation() IS
'Bevriest een geboekte bankkoppeling: id, bedrag, banktransactie, administratie, factuur, koppelingstype, organisatie en gebruiker kunnen niet meer wijzigen en de rij kan niet worden verwijderd. created_at/updated_at blijven vrij.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) A bank transaction with a posted allocation has its accounting facts
--    frozen
--
--    The settlement entry took its posting_date and its direction from the
--    bank row, and its amount was validated against abs(amount). Once any
--    allocation on the transaction is posted, those facts are part of
--    immutable history.
--
--    Frozen: id, amount, transaction_date, client_id, organization_id,
--    user_id. DELETE is refused outright — which also means the ON DELETE
--    CASCADE of bta_tx_user_client_fk can never fire against a posted
--    allocation: the parent delete is stopped before any cascade starts.
--
--    Deliberately NOT frozen, because none of it changed what was booked and
--    the matching workflow must keep working: description, reference,
--    counter_account, camt_ustrd / camt_addtl_ntry_inf / camt_counterparty_name
--    (statement text), match_status / match_confidence / matched_invoice_id
--    (matching state — the allocation rows, not these, are the settlement
--    source), grootboekrekening_id (the SnelStart CONTRA account of a manual
--    booking — not used by settlement at all), ledger_account_id (legacy
--    ledger_accounts link — not used by settlement), created_at, updated_at.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_posted_bank_transaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_allocation_postings WHERE bank_transaction_id = OLD.id
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een geboekte aflettering; verwijderen is niet mogelijk. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id                  IS DISTINCT FROM OLD.id
     OR NEW.amount           IS DISTINCT FROM OLD.amount
     OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.client_id        IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id          IS DISTINCT FROM OLD.user_id
  THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een geboekte aflettering; bedrag, datum, administratie en organisatie kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_bank_transaction_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posted_bank_transaction_mutation_trigger ON public.bank_transactions;
CREATE TRIGGER prevent_posted_bank_transaction_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_bank_transaction_mutation();

COMMENT ON FUNCTION public.prevent_posted_bank_transaction_mutation() IS
'Bevriest bedrag, datum, administratie, organisatie en gebruiker van een banktransactie zodra er een aflettering op is geboekt, en weigert verwijderen (waardoor de cascade naar de koppelingen nooit een geboekte koppeling kan raken). Omschrijving, referentie, tegenrekening, camt-velden, matchstatus en de SnelStart-tegenrekening blijven vrij.';
