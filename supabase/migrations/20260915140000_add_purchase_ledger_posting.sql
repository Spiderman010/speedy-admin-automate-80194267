-- Migration: purchase ledger postings (phase 6C-b3)
--
-- Purpose: the first production accounting writer. Posts a finalised purchase
-- invoice into public.ledger_postings as one balanced, immutable, tenant-safe
-- double-entry group, exactly once.
--
-- Contents:
--   1. public.purchase_invoice_postings — the atomic source-claim marker
--   2. public.post_purchase_invoice(uuid) — the only supported write path
--
-- NO BACKFILL. No existing purchase invoice is posted by this migration; there
-- is deliberately not a single INSERT INTO public.ledger_postings outside the
-- function body.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ENTRY
--
--   DEBIT   each line.amount_excl      → line.grootboekrekening_id
--   DEBIT   header.btw_amount          → clients.btw_te_vorderen_rekening_id   (only when > 0)
--   CREDIT  header.amount_incl         → clients.crediteuren_rekening_id
--
-- VAT is never folded into an expense line. No account number is ever invented
-- and there is no silent fallback: a missing account fails the whole posting.
--
-- RECONCILIATION is exact, not tolerant. src/lib/purchase-line-validation.ts
-- has a lineTolerance() of a few cents, but that is a UI editing affordance for
-- warning the user while typing — it is NOT an accounting convention. The
-- ledger's own group check compares SUM(debit) = SUM(credit) in exact NUMERIC,
-- so anything less than exact equality here would simply be rejected at COMMIT
-- with a confusing error. Both identities are therefore required exactly:
--
--   SUM(line.amount_excl) = header.amount_excl
--   header.amount_excl + header.btw_amount = header.amount_incl
--
-- Discrepancies are NOT repaired here; the invoice is refused so a human fixes
-- the source document.
--
-- DATE / BOEKJAAR / CURRENCY
--   posting_date = invoice_date (NULL fails closed; the column is nullable).
--   boekjaar     = calendar year of invoice_date. This is not an assumption:
--                  the product has no broken-fiscal-year support anywhere (no
--                  start-month/period configuration exists), and its own tested
--                  year filter selects invoice_date >= 'YYYY-01-01' AND
--                  < 'YYYY+1-01-01'. clients.afgesloten_boekjaar is likewise a
--                  single calendar year integer.
--   currency     = 'EUR', passed explicitly. The product is EUR-only today:
--                  purchase_invoices has no currency column, money formatting
--                  is hard-coded to EUR, and both UBL generators emit
--                  currencyID="EUR".
--
-- CLOSED YEAR: posting into a year at or before clients.afgesloten_boekjaar is
-- refused. That field means "closed fiscal year", and an immutable ledger must
-- not gain new rows in a period already closed off.
--
-- UNSUPPORTED, deliberately refused rather than approximated:
--   • Verlegde BTW (reverse charge) on purchases. The purchase model has no
--     field representing it, so the payable leg cannot be expressed. A
--     verlegde invoice can only be stored as 0% VAT, which posts as a plain
--     no-VAT purchase — correct as far as it goes, but the VAT return legs are
--     absent. Do not infer reverse charge from any other field.
--   • Credit notes / negative amounts. ledger_postings forbids negative
--     amounts by design; a creditnota is a reversal, which belongs to the
--     future correction workflow.
--
-- CORRECTIONS: once posted, an invoice cannot be posted again — the marker is
-- a hard claim. If accounting-relevant source data changes afterwards, this
-- phase fails closed on purpose. Corrections require a future reversal
-- workflow that writes NEW immutable rows; nothing here edits or deletes a
-- posted row.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_purchase_source_claim_trigger ON public.ledger_postings;
--   DROP TRIGGER IF EXISTS prevent_posted_purchase_invoice_mutation_trigger ON public.purchase_invoices;
--   DROP TRIGGER IF EXISTS prevent_posted_purchase_line_mutation_trigger ON public.purchase_invoice_lines;
--   DROP FUNCTION IF EXISTS public.enforce_purchase_source_claim();
--   DROP FUNCTION IF EXISTS public.prevent_posted_purchase_invoice_mutation();
--   DROP FUNCTION IF EXISTS public.prevent_posted_purchase_line_mutation();
--   DROP FUNCTION IF EXISTS public.post_purchase_invoice(uuid);
--   DROP POLICY IF EXISTS role_purchase_invoice_postings_select ON public.purchase_invoice_postings;
--   DROP INDEX IF EXISTS public.idx_purchase_invoice_postings_client;
--   DROP INDEX IF EXISTS public.idx_purchase_invoice_postings_organization;
--   DROP TABLE IF EXISTS public.purchase_invoice_postings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The claim marker
--
--    purchase_invoice_id is the PRIMARY KEY, and that single fact is the whole
--    idempotency guarantee: the second claim of an invoice cannot exist. It is
--    durable (unlike purchase_invoice_lines.id, which save_purchase_invoice_
--    with_lines deletes and re-inserts on every save) and it is enforced by an
--    index rather than by application logic, so no SELECT-before-INSERT race
--    and no advisory-lock-only scheme is involved.
--
--    Under concurrency the index is also the serialisation point: the second
--    transaction blocks on the uncommitted key until the first commits, then
--    fails with unique_violation. Both claim and ledger rows are written in the
--    same transaction, so either an invoice is fully posted or not posted.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.purchase_invoice_postings (
  purchase_invoice_id uuid        PRIMARY KEY,
  posting_group_id    uuid        NOT NULL UNIQUE,
  organization_id     uuid        NOT NULL,
  client_id           uuid        NOT NULL,
  user_id             uuid        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
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
      AND t.relname = 'purchase_invoice_postings'
      AND c.conname = 'purchase_invoice_postings_purchase_invoice_id_fkey'
  ) THEN
    ALTER TABLE public.purchase_invoice_postings
      ADD CONSTRAINT purchase_invoice_postings_purchase_invoice_id_fkey
      FOREIGN KEY (purchase_invoice_id) REFERENCES public.purchase_invoices (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'purchase_invoice_postings'
      AND c.conname = 'purchase_invoice_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.purchase_invoice_postings
      ADD CONSTRAINT purchase_invoice_postings_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'purchase_invoice_postings'
      AND c.conname = 'purchase_invoice_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.purchase_invoice_postings
      ADD CONSTRAINT purchase_invoice_postings_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'purchase_invoice_postings'
      AND c.conname = 'purchase_invoice_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.purchase_invoice_postings
      ADD CONSTRAINT purchase_invoice_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_postings_organization
  ON public.purchase_invoice_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_postings_client
  ON public.purchase_invoice_postings (client_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Marker privileges — read-only for the app, writable only by the RPC
--
--    The marker is what makes an invoice un-postable a second time, so a
--    client able to write it directly could either fabricate a claim (blocking
--    a legitimate posting forever) or delete one (enabling a duplicate). It is
--    therefore SELECT-only for every application role.
--
--    The REVOKE list is deliberately broader than INSERT/UPDATE/DELETE: on this
--    Lovable Cloud project, default privileges were observed to also hand out
--    TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on newly created tables. TRIGGER
--    in particular would let a role attach its own trigger to the marker.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_invoice_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_purchase_invoice_postings_select ON public.purchase_invoice_postings;
CREATE POLICY role_purchase_invoice_postings_select ON public.purchase_invoice_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.purchase_invoice_postings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.purchase_invoice_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.purchase_invoice_postings TO authenticated, service_role;

COMMENT ON TABLE public.purchase_invoice_postings IS
'Claim-registratie: bewijst dat een inkoopfactuur precies één keer is geboekt. De primary key op purchase_invoice_id ís de idempotentiegarantie. Alleen public.post_purchase_invoice() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The writer
--
--    SECURITY DEFINER is required, not preferred: the marker table is
--    deliberately not writable by authenticated (section 2), so an INVOKER
--    function could not claim the invoice. Because the definer bypasses RLS,
--    every check RLS would normally perform is done explicitly below:
--    authentication, role, and tenant scope are all validated from the
--    database's own data, never from caller input.
--
--    The ONLY caller input is _invoice_id. organization_id, client_id, user_id,
--    posting_group_id, amounts, accounts, boekjaar and currency are all derived
--    server-side; created_xact_id is stamped by the ledger's own trigger and is
--    not settable here at all.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_purchase_invoice(_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_inv              public.purchase_invoices%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_btw              numeric(12,2);
  v_sum_lines        numeric(12,2);
  v_line_count       integer;
  v_bad_accounts     integer;
  v_line_no          integer := 0;
  v_line             record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- FOR UPDATE: save_purchase_invoice_with_lines UPDATEs this row before it
  -- replaces the lines, so taking the same row lock here serialises save
  -- against post. Whichever starts first finishes first: a save in flight makes
  -- posting wait and then read the fully committed new source, and a posting in
  -- flight makes the save wait and then be refused by the immutability guards
  -- below, because the marker now exists. A mixed old-header/new-lines snapshot
  -- is therefore impossible.
  SELECT * INTO v_inv FROM public.purchase_invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
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

  -- Only a finalised invoice may post. te_controleren is explicitly refused, so
  -- an ordinary save can never produce accounting.
  IF v_inv.status NOT IN ('gecontroleerd', 'betaald', 'geexporteerd') THEN
    RAISE EXCEPTION 'Alleen een gecontroleerde inkoopfactuur kan worden geboekt (status: %)', v_inv.status
      USING ERRCODE = '22023';
  END IF;

  IF v_inv.invoice_date IS NULL THEN
    RAISE EXCEPTION 'Inkoopfactuur heeft geen factuurdatum; een boeking vereist een boekingsdatum'
      USING ERRCODE = '22004';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_inv.invoice_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Inkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  IF v_inv.amount_excl < 0 OR v_btw < 0 OR v_inv.amount_incl <= 0 THEN
    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'
      USING ERRCODE = '22023';
  END IF;

  -- Configuration. No fallback account, ever.
  IF v_client.crediteuren_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen crediteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  IF v_btw > 0 AND v_client.btw_te_vorderen_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen rekening voor BTW te vorderen ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- Lines: at least one, each with an account.
  SELECT COUNT(*), COALESCE(SUM(l.amount_excl), 0),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL)
    INTO v_line_count, v_sum_lines, v_bad_accounts
  FROM public.purchase_invoice_lines l
  WHERE l.purchase_invoice_id = v_inv.id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Inkoopfactuur heeft geen boekingsregels' USING ERRCODE = '22023';
  END IF;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION '% boekingsregel(s) zonder grootboekrekening; boeken is niet mogelijk', v_bad_accounts
      USING ERRCODE = '22023';
  END IF;

  -- Exact reconciliation, in NUMERIC. No tolerance: see the header comment.
  IF v_sum_lines <> v_inv.amount_excl THEN
    RAISE EXCEPTION 'Regels (%) sluiten niet aan op het factuurbedrag exclusief BTW (%)', v_sum_lines, v_inv.amount_excl
      USING ERRCODE = '23514';
  END IF;

  IF v_inv.amount_excl + v_btw <> v_inv.amount_incl THEN
    RAISE EXCEPTION 'Bedrag exclusief (%) plus BTW (%) sluit niet aan op het bedrag inclusief (%)',
      v_inv.amount_excl, v_btw, v_inv.amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Account scope: every account must be usable by THIS administratie.
  SELECT COUNT(*) INTO v_bad_accounts
  FROM public.purchase_invoice_lines l
  WHERE l.purchase_invoice_id = v_inv.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_inv.organization_id, v_inv.client_id);
  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Een boekingsregel verwijst naar een grootboekrekening buiten deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_client.crediteuren_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde crediteurenrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_btw > 0
     AND NOT public.posting_account_ok(v_client.btw_te_vorderen_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde rekening voor BTW te vorderen hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  -- Claim the invoice. The primary key is the idempotency guarantee and, under
  -- concurrency, the serialisation point: a second session blocks here until
  -- the first commits and then fails.
  BEGIN
    INSERT INTO public.purchase_invoice_postings (
      purchase_invoice_id, posting_group_id, organization_id, client_id, user_id
    ) VALUES (
      v_inv.id, v_group_id, v_inv.organization_id, v_inv.client_id, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze inkoopfactuur is al geboekt' USING ERRCODE = '23505';
  END;

  -- DEBIT: one row per expense line, in a deterministic order.
  FOR v_line IN
    SELECT l.grootboekrekening_id, l.amount_excl, l.omschrijving
    FROM public.purchase_invoice_lines l
    WHERE l.purchase_invoice_id = v_inv.id
    ORDER BY l.sort_order, l.id
  LOOP
    -- A zero-amount line cannot be posted (ledger rows must have one positive
    -- side), and silently dropping it would break reconciliation.
    IF v_line.amount_excl <= 0 THEN
      RAISE EXCEPTION 'Boekingsregel met bedrag % kan niet worden geboekt', v_line.amount_excl
        USING ERRCODE = '22023';
    END IF;

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, v_line.amount_excl, 0, 'EUR',
      v_line.omschrijving, 'purchase_invoice', v_inv.id, NULL, v_uid
    );
  END LOOP;

  -- DEBIT: recoverable VAT, only when there is any.
  IF v_btw > 0 THEN
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_client.btw_te_vorderen_rekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, v_btw, 0, 'EUR',
      'BTW te vorderen', 'purchase_invoice', v_inv.id, NULL, v_uid
    );
  END IF;

  -- CREDIT: the supplier debt.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_client.crediteuren_rekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, 0, v_inv.amount_incl, 'EUR',
    COALESCE(v_inv.supplier, 'Crediteur'), 'purchase_invoice', v_inv.id, NULL, v_uid
  );

  RETURN v_group_id;
END
$$;

-- Trigger-only/administrative surface hardening: the function must be callable
-- by the app, but never by anon, and never by PUBLIC.
REVOKE ALL ON FUNCTION public.post_purchase_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_purchase_invoice(uuid) IS
'Boekt één gecontroleerde inkoopfactuur als sluitende dubbele boeking in ledger_postings en claimt hem in purchase_invoice_postings, atomair en precies één keer. Enige invoer is de factuur-id; organisatie, administratie, gebruiker, bedragen, rekeningen, boekjaar en valuta worden server-side afgeleid.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Source-level exactly-once, enforced on ledger_postings itself
--
--    The marker's primary key only protects calls that go through
--    post_purchase_invoice(). It does not protect the table: the 6C-b2
--    foundation grants authenticated a direct INSERT on ledger_postings, so
--    after a legitimate posting an assistant could still insert a SECOND
--    balanced group for the same invoice under a different posting_group_id.
--    Every foundation invariant would hold — the group balances, is one tenant,
--    one date, sealed to its own transaction — and the invoice would silently
--    be in the books twice.
--
--    This trigger closes that by making the marker the single authority for
--    purchase rows: a purchase_invoice ledger row may only exist if it matches
--    its invoice's marker exactly, including the posting group. Since
--    posting_group_id is UNIQUE on the marker, exactly one group per invoice can
--    ever exist.
--
--    Deliberately scoped to source_type = 'purchase_invoice' only. A universal
--    source trigger would silently dictate the design of the 6C-b4/b5/b6
--    writers before those contracts exist; each phase adds its own guard.
--
--    It permits post_purchase_invoice() because that function inserts the
--    marker first and the ledger rows afterwards in the same transaction, so
--    the marker is already visible to these statements.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_purchase_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.purchase_invoice_postings%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'purchase_invoice' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een inkoopboeking moet naar een inkoopfactuur verwijzen' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.purchase_invoice_postings
  WHERE purchase_invoice_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze inkoopfactuur is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een inkoopfactuur kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte inkoopfactuur'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_purchase_source_claim() FROM PUBLIC;

-- "validate_" keeps it after set_organization_id_trigger, so organization_id is
-- already resolved when it is compared against the marker.
DROP TRIGGER IF EXISTS validate_purchase_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_purchase_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_source_claim();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) A posted invoice's source facts are frozen
--
--    Without this, save_purchase_invoice_with_lines() would happily update the
--    header and delete/re-insert the lines of an already-posted invoice. The
--    ledger would then describe facts the source document no longer contains —
--    the audit trail would say one thing and the invoice another — and nothing
--    would reveal the divergence.
--
--    Only ACCOUNTING-relevant fields are frozen. Payment and workflow state
--    must keep moving: status (gecontroleerd -> betaald/geexporteerd),
--    remaining_amount, notes, document/export bookkeeping and updated_at all
--    stay editable, because none of them changes what was booked.
--
--    Corrections to a posted invoice are deliberately impossible here; they
--    belong to the future reversal workflow, which adds NEW immutable rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_posted_purchase_invoice_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_invoice_postings WHERE purchase_invoice_id = OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.client_id            IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
     OR NEW.leverancier_id    IS DISTINCT FROM OLD.leverancier_id
     OR NEW.supplier          IS DISTINCT FROM OLD.supplier
     OR NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
     OR NEW.invoice_date      IS DISTINCT FROM OLD.invoice_date
     OR NEW.amount_excl       IS DISTINCT FROM OLD.amount_excl
     OR NEW.btw_amount        IS DISTINCT FROM OLD.btw_amount
     OR NEW.amount_incl       IS DISTINCT FROM OLD.amount_incl
     OR NEW.btw_percentage    IS DISTINCT FROM OLD.btw_percentage
     OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
     OR NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id
     OR NEW.ledger_account_text IS DISTINCT FROM OLD.ledger_account_text
  THEN
    RAISE EXCEPTION 'Deze inkoopfactuur is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.prevent_posted_purchase_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.purchase_invoice_id, OLD.purchase_invoice_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.purchase_invoice_postings WHERE purchase_invoice_id = v_invoice_id
  ) THEN
    RAISE EXCEPTION 'Deze inkoopfactuur is geboekt; boekingsregels kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_purchase_invoice_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_posted_purchase_line_mutation()    FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posted_purchase_invoice_mutation_trigger ON public.purchase_invoices;
CREATE TRIGGER prevent_posted_purchase_invoice_mutation_trigger
  BEFORE UPDATE ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_purchase_invoice_mutation();

DROP TRIGGER IF EXISTS prevent_posted_purchase_line_mutation_trigger ON public.purchase_invoice_lines;
CREATE TRIGGER prevent_posted_purchase_line_mutation_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_purchase_line_mutation();

COMMENT ON FUNCTION public.enforce_purchase_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=purchase_invoice exact overeenkomt met de claim in purchase_invoice_postings. Sluit een tweede boekingsgroep via een directe INSERT uit.';
