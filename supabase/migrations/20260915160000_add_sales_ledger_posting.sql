-- Migration: sales ledger postings (phase 6C-b4)
--
-- Purpose: the second production accounting writer. Posts a finalised sales
-- invoice into public.ledger_postings as one balanced, immutable, tenant-safe
-- double-entry group, exactly once. Mirrors the architecture of 6C-b3
-- (post_purchase_invoice), adapted to the sales source model, which the audit
-- below establishes is materially different from purchase.
--
-- Contents:
--   1. public.sales_invoice_postings — the atomic source-claim marker
--   2. public.post_sales_invoice(uuid) — the only supported write path
--
-- NO BACKFILL. No existing sales invoice is posted by this migration; there is
-- deliberately not a single INSERT INTO public.ledger_postings outside the
-- function body.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT — the sales model differs from purchase in three concrete ways
--
-- 1. HEADER-ONLY, NOT LINE-BASED. There is no sales_invoice_lines table
--    anywhere in the schema (grep across supabase/migrations/ and
--    types.ts returns nothing). sales_invoices.grootboekrekening_id — added by
--    20260904120000, documented there as "Expliciete omzetrekening voor deze
--    verkoopfactuur" — is therefore the ONLY and authoritative revenue account,
--    one per invoice. There is consequently no line-mutation guard in this
--    migration: there is nothing to reassign a line between invoices.
--
-- 2. invoice_date IS NOT NULL. Unlike purchase_invoices.invoice_date
--    (nullable), sales_invoices.invoice_date is NOT NULL at the schema level.
--    The writer still checks for NULL defensively — cheap, and it stops
--    depending on a constraint outliving this migration — but the case is
--    currently unreachable by the schema's own guarantee.
--
-- 3. btw_verlegd exists on sales, not on purchase — and is REFUSED, not
--    silently accepted. sales_invoices carries a boolean btw_verlegd with no
--    counterpart on purchase_invoices, so unlike purchase (where reverse
--    charge simply cannot be represented) silence was not available here: a
--    naive header posting of a verlegde invoice (DEBIT debiteuren amount_incl
--    / CREDIT omzet amount_excl, both equal because btw_amount is forced to 0)
--    would balance and look correct while omitting the verlegde-BTW return
--    legs entirely. The product has already made this exact call once: the
--    SnelStart export explicitly refuses to export a btw_verlegd invoice
--    (src/pages/Verkoop.tsx, "Deze selectie bevat verkoopfacturen met btw
--    verlegd. De juiste SnelStart-exportcode is nog niet ingesteld."). The
--    writer follows the same posture and refuses to post one, rather than
--    quietly booking an entry that is missing its VAT-return consequence.
--
-- What is unchanged from the purchase precedent: EUR-only (no currency column,
-- hard-coded EUR elsewhere in the app); calendar-year-only fiscal years (no
-- broken-fiscal-year support exists anywhere, clients.afgesloten_boekjaar is a
-- bare integer); credit notes are not represented anywhere in the schema
-- (confirmed by grep) and are therefore refused, not approximated, exactly as
-- for purchase; a sales invoice is currently still fully editable regardless of
-- status, so this migration must add its own posted-source freeze, just as
-- 6C-b3 did for purchase.
--
-- STATUS: the DB is authoritative here, and it disagrees with some app code.
-- The live CHECK constraint (20260411231231) only permits
-- ('concept','gecontroleerd','verzonden','betaald') — 'geexporteerd' cannot
-- exist on a sales_invoices row. Yet SALES_LEDGER_STATUSES in
-- src/lib/ledger-mutations.ts and STATUS_ORDER in src/pages/Verkoop.tsx both
-- reference 'geexporteerd' for sales; that reference is dead code inherited
-- from the purchase pattern and is not evidence of a real state. The approve
-- action in SalesInvoiceEditDialog.tsx sets status to 'gecontroleerd', the
-- exact mirror of the purchase approve flow. 'verzonden' is a freely
-- selectable dropdown value with no dedicated code path establishing it means
-- "reviewed" — it plausibly means only "e-mailed to the customer" — so it is
-- treated as NOT final. The finalised/bookable set used below is therefore
-- exactly {'gecontroleerd', 'betaald'}.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ENTRY
--
--   DEBIT   header.amount_incl (gross)  → clients.debiteuren_rekening_id
--   CREDIT  header.amount_excl (net)    → sales_invoices.grootboekrekening_id
--   CREDIT  header.btw_amount           → clients.btw_te_betalen_rekening_id   (only when > 0)
--
-- VAT is never folded into the revenue leg. No account number is ever invented
-- and there is no silent fallback: a missing account fails the whole posting.
--
-- RECONCILIATION is exact NUMERIC, not tolerant, matching the purchase
-- precedent:
--
--   header.amount_excl + header.btw_amount = header.amount_incl
--
-- There is no per-line sum to check, because there are no lines.
-- Discrepancies are NOT repaired here; the invoice is refused so a human fixes
-- the source document.
--
-- DATE / BOEKJAAR / CURRENCY — identical contract to purchase:
--   posting_date = invoice_date (NULL fails closed, defensively).
--   boekjaar     = calendar year of invoice_date.
--   currency     = 'EUR', passed explicitly.
--
-- CLOSED YEAR: posting into a year at or before clients.afgesloten_boekjaar is
-- refused, identically to purchase.
--
-- UNSUPPORTED, deliberately refused rather than approximated:
--   • Credit notes / negative amounts. ledger_postings forbids negative
--     amounts by design; a creditnota is a reversal, which belongs to the
--     future correction workflow. Nothing in the schema represents a sales
--     credit note today.
--   • Verlegde BTW (btw_verlegd = true). See point 3 above: the export path
--     already treats these as not yet safely representable, and the ledger
--     writer follows suit rather than booking an entry missing its VAT-return
--     legs.
--
-- CORRECTIONS: once posted, an invoice cannot be posted again — the marker is
-- a hard claim. If accounting-relevant source data changes afterwards, this
-- phase fails closed on purpose. Corrections require a future reversal
-- workflow that writes NEW immutable rows; nothing here edits or deletes a
-- posted row.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_sales_source_claim_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS prevent_posted_sales_invoice_mutation_trigger ON public.sales_invoices;
--   DROP FUNCTION IF EXISTS public.enforce_sales_source_claim();
--   DROP FUNCTION IF EXISTS public.prevent_posted_sales_invoice_mutation();
--   DROP FUNCTION IF EXISTS public.post_sales_invoice(uuid);
--   DROP POLICY IF EXISTS role_sales_invoice_postings_select ON public.sales_invoice_postings;
--   DROP INDEX IF EXISTS public.idx_sales_invoice_postings_client;
--   DROP INDEX IF EXISTS public.idx_sales_invoice_postings_organization;
--   DROP TABLE IF EXISTS public.sales_invoice_postings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The claim marker — identical design to purchase_invoice_postings
--
--    sales_invoice_id is the PRIMARY KEY, and that single fact is the whole
--    idempotency guarantee: the second claim of an invoice cannot exist.
--
--    Under concurrency the index is also the serialisation point: the second
--    transaction blocks on the uncommitted key until the first commits, then
--    fails with unique_violation. Both claim and ledger rows are written in the
--    same transaction, so either an invoice is fully posted or not posted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sales_invoice_postings (
  sales_invoice_id uuid        PRIMARY KEY,
  posting_group_id uuid        NOT NULL UNIQUE,
  organization_id  uuid        NOT NULL,
  client_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- RESTRICT throughout: this row is the audit trail proving why immutable ledger
-- rows exist. It must never be cascade-deleted out from under them, and the
-- ledger rows it explains are themselves undeletable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'sales_invoice_postings'
      AND c.conname = 'sales_invoice_postings_sales_invoice_id_fkey'
  ) THEN
    ALTER TABLE public.sales_invoice_postings
      ADD CONSTRAINT sales_invoice_postings_sales_invoice_id_fkey
      FOREIGN KEY (sales_invoice_id) REFERENCES public.sales_invoices (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'sales_invoice_postings'
      AND c.conname = 'sales_invoice_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.sales_invoice_postings
      ADD CONSTRAINT sales_invoice_postings_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'sales_invoice_postings'
      AND c.conname = 'sales_invoice_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.sales_invoice_postings
      ADD CONSTRAINT sales_invoice_postings_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'sales_invoice_postings'
      AND c.conname = 'sales_invoice_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.sales_invoice_postings
      ADD CONSTRAINT sales_invoice_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_sales_invoice_postings_organization
  ON public.sales_invoice_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_postings_client
  ON public.sales_invoice_postings (client_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Marker privileges — read-only for the app, writable only by the RPC
--
--    Same reasoning as purchase_invoice_postings: a client able to write the
--    marker directly could fabricate a claim (blocking a legitimate posting
--    forever) or delete one (enabling a duplicate). SELECT-only for every
--    application role, and the REVOKE list is deliberately broader than
--    INSERT/UPDATE/DELETE — Lovable Cloud defaults were observed on 6C-b3 to
--    also hand out TRUNCATE, REFERENCES and TRIGGER on newly created tables.
--
--    service_role is NOT granted EXECUTE on the writer function below, and is
--    revoked here from mutating the marker directly. No edge function
--    currently needs to post sales invoices; if one ever does, that is a
--    deliberate, separately-reviewed grant, not a default to fall into.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sales_invoice_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_sales_invoice_postings_select ON public.sales_invoice_postings;
CREATE POLICY role_sales_invoice_postings_select ON public.sales_invoice_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.sales_invoice_postings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.sales_invoice_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.sales_invoice_postings TO authenticated, service_role;

COMMENT ON TABLE public.sales_invoice_postings IS
'Claim-registratie: bewijst dat een verkoopfactuur precies één keer is geboekt. De primary key op sales_invoice_id ís de idempotentiegarantie. Alleen public.post_sales_invoice() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The writer
--
--    SECURITY DEFINER is required, not preferred: the marker table is
--    deliberately not writable by authenticated (section 2), so an INVOKER
--    function could not claim the invoice. Because the definer bypasses RLS,
--    every check RLS would normally perform is done explicitly below.
--
--    The ONLY caller input is _invoice_id. organization_id, client_id, user_id,
--    posting_group_id, amounts, accounts, boekjaar and currency are all derived
--    server-side; created_xact_id is stamped by the ledger's own trigger and is
--    not settable here at all.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_sales_invoice(_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_inv       public.sales_invoices%ROWTYPE;
  v_client    public.clients%ROWTYPE;
  v_group_id  uuid := gen_random_uuid();
  v_boekjaar  integer;
  v_btw       numeric(12,2);
  v_line_no   integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- FOR UPDATE: the sales save path (useUpdateSalesInvoice) is a plain UPDATE
  -- on this row, so taking the same row lock here serialises save against
  -- post exactly as for purchase. Whichever starts first finishes first: a
  -- save in flight makes posting wait and then read the fully committed new
  -- source, and a posting in flight makes the save wait and then be refused
  -- by the immutability guard below, because the marker now exists.
  SELECT * INTO v_inv FROM public.sales_invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Tenant + role, both from stored data. 'assistant' matches the minimum the
  -- ledger_postings INSERT policy itself requires.
  IF v_inv.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_inv.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_inv.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_inv.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze factuur' USING ERRCODE = '42501';
  END IF;

  -- Only a finalised invoice may post. concept and verzonden are explicitly
  -- refused, so an ordinary save or a "sent to customer" marker can never
  -- produce accounting on their own.
  IF v_inv.status NOT IN ('gecontroleerd', 'betaald') THEN
    RAISE EXCEPTION 'Alleen een gecontroleerde verkoopfactuur kan worden geboekt (status: %)', v_inv.status
      USING ERRCODE = '22023';
  END IF;

  -- Defensive: invoice_date is NOT NULL at the schema level today, so this
  -- branch is currently unreachable, but the writer does not lean on a
  -- constraint it does not itself own.
  IF v_inv.invoice_date IS NULL THEN
    RAISE EXCEPTION 'Verkoopfactuur heeft geen factuurdatum; een boeking vereist een boekingsdatum'
      USING ERRCODE = '22004';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_inv.invoice_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Verkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  IF v_inv.amount_excl < 0 OR v_btw < 0 OR v_inv.amount_incl <= 0 THEN
    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'
      USING ERRCODE = '22023';
  END IF;

  -- Verlegde BTW is refused, not silently posted as a plain no-VAT sale: see
  -- the migration header for why. The SnelStart export already treats these
  -- invoices the same way.
  IF v_inv.btw_verlegd THEN
    RAISE EXCEPTION 'Verkoopfacturen met verlegde BTW kunnen nog niet worden geboekt'
      USING ERRCODE = '0A000';
  END IF;

  -- Configuration. No fallback account, ever. The revenue account is a header
  -- field on THIS invoice (there are no lines to carry it instead).
  IF v_inv.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen omzetrekening ingesteld voor deze verkoopfactuur' USING ERRCODE = '22023';
  END IF;

  IF v_client.debiteuren_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen debiteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  IF v_btw > 0 AND v_client.btw_te_betalen_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen rekening voor BTW te betalen ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- Exact reconciliation, in NUMERIC. No tolerance, no line sum to check —
  -- there are no lines.
  IF v_inv.amount_excl + v_btw <> v_inv.amount_incl THEN
    RAISE EXCEPTION 'Bedrag exclusief (%) plus BTW (%) sluit niet aan op het bedrag inclusief (%)',
      v_inv.amount_excl, v_btw, v_inv.amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Account scope: every account must be usable by THIS administratie.
  IF NOT public.posting_account_ok(v_inv.grootboekrekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde omzetrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_client.debiteuren_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde debiteurenrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_btw > 0
     AND NOT public.posting_account_ok(v_client.btw_te_betalen_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde rekening voor BTW te betalen hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  -- Claim the invoice. The primary key is the idempotency guarantee and, under
  -- concurrency, the serialisation point: a second session blocks here until
  -- the first commits and then fails.
  BEGIN
    INSERT INTO public.sales_invoice_postings (
      sales_invoice_id, posting_group_id, organization_id, client_id, user_id
    ) VALUES (
      v_inv.id, v_group_id, v_inv.organization_id, v_inv.client_id, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is al geboekt' USING ERRCODE = '23505';
  END;

  -- DEBIT: the debtor, for the gross amount.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_client.debiteuren_rekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, v_inv.amount_incl, 0, 'EUR',
    COALESCE(v_inv.customer_name, 'Debiteur'), 'sales_invoice', v_inv.id, NULL, v_uid
  );

  -- CREDIT: revenue, for the net amount.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_inv.grootboekrekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, 0, v_inv.amount_excl, 'EUR',
    COALESCE(v_inv.invoice_number, 'Verkoopfactuur'), 'sales_invoice', v_inv.id, NULL, v_uid
  );

  -- CREDIT: VAT payable, only when there is any. A btw_verlegd invoice never
  -- reaches this point at all — it was refused above.
  IF v_btw > 0 THEN
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_client.btw_te_betalen_rekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, 0, v_btw, 'EUR',
      'BTW te betalen', 'sales_invoice', v_inv.id, NULL, v_uid
    );
  END IF;

  RETURN v_group_id;
END
$$;

-- Trigger-only/administrative surface hardening: the function must be callable
-- by the app, but never by anon, never by service_role, never by PUBLIC.
REVOKE ALL ON FUNCTION public.post_sales_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_invoice(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_sales_invoice(uuid) IS
'Boekt één gecontroleerde verkoopfactuur als sluitende dubbele boeking in ledger_postings en claimt hem in sales_invoice_postings, atomair en precies één keer. Enige invoer is de factuur-id; organisatie, administratie, gebruiker, bedragen, rekeningen, boekjaar en valuta worden server-side afgeleid.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Source-level exactly-once, enforced on ledger_postings itself
--
--    The marker's primary key only protects calls that go through
--    post_sales_invoice(). It does not protect the table: authenticated has a
--    direct INSERT on ledger_postings, so after a legitimate posting an
--    assistant could still insert a SECOND balanced group for the same
--    invoice under a different posting_group_id.
--
--    This trigger closes that by making the marker the single authority for
--    sales rows: a sales_invoice ledger row may only exist if it matches its
--    invoice's marker exactly, including the posting group. Since
--    posting_group_id is UNIQUE on the marker, exactly one group per invoice
--    can ever exist.
--
--    Deliberately scoped to source_type = 'sales_invoice' only — the same
--    discipline as the purchase guard, so 6C-b5/b6 keep their own contract.
--
--    It permits post_sales_invoice() because that function inserts the marker
--    first and the ledger rows afterwards in the same transaction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_sales_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.sales_invoice_postings%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'sales_invoice' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een verkoopboeking moet naar een verkoopfactuur verwijzen' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.sales_invoice_postings
  WHERE sales_invoice_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een verkoopfactuur kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte verkoopfactuur'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_sales_source_claim() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so organization_id is
-- already resolved when it is compared against the marker.
DROP TRIGGER IF EXISTS validate_sales_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_sales_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_source_claim();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) A posted invoice's source facts are frozen
--
--    Without this, useUpdateSalesInvoice would happily update an
--    already-posted invoice's header. The ledger would then describe facts the
--    source document no longer contains, with nothing revealing the
--    divergence.
--
--    Only ACCOUNTING-relevant fields are frozen: identity (client_id,
--    organization_id, customer_name), the fields that fed the entry
--    (invoice_date, amount_excl, btw_amount, amount_incl, btw_percentage,
--    grootboekrekening_id), and btw_verlegd — frozen even though a posted
--    invoice can never have it true (the writer refuses those), so a later
--    phase that adds verlegde-BTW support cannot retroactively flip a booked
--    invoice's tax character. Also invoice_number (audit identity). Payment
--    and workflow state must keep
--    moving: status (gecontroleerd -> betaald), due_date, remaining_amount,
--    notes, pdf_path and updated_at all stay editable, because none of them
--    changes what was booked.
--
--    There is no line-mutation guard here, unlike purchase: sales has no
--    lines table, so there is nothing to reassign between invoices.
--
--    Corrections to a posted invoice are deliberately impossible here; they
--    belong to the future reversal workflow, which adds NEW immutable rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_invoice_postings WHERE sales_invoice_id = OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.client_id            IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
     OR NEW.customer_name     IS DISTINCT FROM OLD.customer_name
     OR NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
     OR NEW.invoice_date      IS DISTINCT FROM OLD.invoice_date
     OR NEW.amount_excl       IS DISTINCT FROM OLD.amount_excl
     OR NEW.btw_amount        IS DISTINCT FROM OLD.btw_amount
     OR NEW.amount_incl       IS DISTINCT FROM OLD.amount_incl
     OR NEW.btw_percentage    IS DISTINCT FROM OLD.btw_percentage
     OR NEW.btw_verlegd       IS DISTINCT FROM OLD.btw_verlegd
     OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
     OR NEW.ledger_account_text IS DISTINCT FROM OLD.ledger_account_text
  THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_sales_invoice_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posted_sales_invoice_mutation_trigger ON public.sales_invoices;
CREATE TRIGGER prevent_posted_sales_invoice_mutation_trigger
  BEFORE UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_sales_invoice_mutation();

COMMENT ON FUNCTION public.enforce_sales_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=sales_invoice exact overeenkomt met de claim in sales_invoice_postings. Sluit een tweede boekingsgroep via een directe INSERT uit.';
