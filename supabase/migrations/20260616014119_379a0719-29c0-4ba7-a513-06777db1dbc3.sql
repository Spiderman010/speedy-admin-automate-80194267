-- ORG-TRG-1: drop duplicate trg_set_org_id triggers (13 tables) and
-- replace public.set_organization_id() with a hard-fail variant.

DROP TRIGGER IF EXISTS trg_set_org_id ON public.app_settings;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.bank_transaction_allocations;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.bank_transactions;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.booking_templates;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.clients;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.grootboekrekeningen;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.journal_entries;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.ledger_accounts;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.leveranciers;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.purchase_invoice_lines;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.purchase_invoices;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.sales_invoices;
DROP TRIGGER IF EXISTS trg_set_org_id ON public.vraagposten;

CREATE OR REPLACE FUNCTION public.set_organization_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id    uuid;
  v_user_id      uuid;
  v_org_id       uuid;
  v_member_count int;
BEGIN
  -- Idempotent: respect explicit value
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Pull candidate FKs if columns exist on this row
  BEGIN v_client_id := NEW.client_id; EXCEPTION WHEN undefined_column THEN v_client_id := NULL; END;
  BEGIN v_user_id   := NEW.user_id;   EXCEPTION WHEN undefined_column THEN v_user_id   := NULL; END;

  -- 1) Inherit from client
  IF v_client_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_org_id
    FROM public.clients c
    WHERE c.id = v_client_id;
  END IF;

  -- 2) Fall back to profile default
  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT p.default_organization_id INTO v_org_id
    FROM public.profiles p
    WHERE p.user_id = v_user_id;
  END IF;

  -- 3) Fall back to sole membership
  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT count(*) INTO v_member_count
    FROM public.organization_members
    WHERE user_id = v_user_id;

    IF v_member_count = 1 THEN
      SELECT organization_id INTO v_org_id
      FROM public.organization_members
      WHERE user_id = v_user_id;
    END IF;
  END IF;

  -- Hard-fail: no silent NULL inserts allowed.
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION
      'organization_id kon niet worden afgeleid voor insert op %; geef organization_id expliciet mee of zorg dat client_id/profile/membership beschikbaar is',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.organization_id := v_org_id;
  RETURN NEW;
END;
$function$;

-- rollback (manueel):
--   1) Herstel de vorige functie-body met stille NULL fallback
--      (verwijder het RAISE EXCEPTION-blok; NEW.organization_id := v_org_id; RETURN NEW;)
--   2) Hermaak de duplicaat triggers indien gewenst:
--      CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.<table>
--        FOR EACH ROW EXECUTE FUNCTION public.set_organization_id();
--      voor elk van de 13 tabellen hierboven.