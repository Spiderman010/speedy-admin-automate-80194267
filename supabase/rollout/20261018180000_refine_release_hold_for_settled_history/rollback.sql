-- ROLLBACK van 20261018180000_refine_release_hold_for_settled_history.
--
-- Alleen met akkoord van de eigenaar, in de Lovable Cloud SQL editor van
-- project alxlbdhpbwlehbdbfejw, en vóór een eventuele rollback van PR 2 of
-- PR 1 (nooit erna). Zet enforce_bank_transaction_release_hold byte-gelijk
-- terug naar de versie uit 20261018120000 (PR 1), met haar rechten en
-- commentaar, en verwijdert de hulpfunctie. Data-neutraal. Daarna geldt weer
-- het gedrag van PR 1: een historische storno van vóór PR 1 schakelt de hold
-- na een vrijgave uit.
--
-- Verwacht na afloop: md5(prosrc) van enforce_bank_transaction_release_hold =
-- 812d151a7041cdd48b7a784cd193a159, en geen bank_transaction_group_is_settled_history.

-- Eén opdracht, dus één transactie — hoe de editor haar ook verstuurt: weigert
-- de bewaking, dan verandert er niets. Alleen vanuit de beoordeelde toestand: de
-- hold is die van deze migratie (of al die van PR 1, bij een tweede uitvoering),
-- met de eigenaar van de schrijver.
DO $rollback$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('43347fb9f48ed4c161e291fa769577c2', '812d151a7041cdd48b7a784cd193a159') THEN
    RAISE EXCEPTION 'Rollback geweigerd: enforce_bank_transaction_release_hold is niet de beoordeelde versie (md5 %)', v_md5 USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
     IS DISTINCT FROM
     (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)')) THEN
    RAISE EXCEPTION 'Rollback geweigerd: enforce_bank_transaction_release_hold heeft een andere eigenaar dan de schrijver post_bank_transaction' USING ERRCODE = '55000';
  END IF;

  -- De hold van PR 1, letterlijk, met haar rechten en commentaar.
  EXECUTE $hold_pr1$
CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last             text;
  v_identity_changed boolean := false;
  v_coding_changed   boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_identity_changed :=
         NEW.id               IS DISTINCT FROM OLD.id
      OR NEW.amount           IS DISTINCT FROM OLD.amount
      OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
      OR NEW.client_id        IS DISTINCT FROM OLD.client_id
      OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id          IS DISTINCT FROM OLD.user_id;
    v_coding_changed :=
         NEW.match_status         IS DISTINCT FROM OLD.match_status
      OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
      OR NEW.btw_percentage       IS DISTINCT FROM OLD.btw_percentage
      OR NEW.matched_invoice_id   IS DISTINCT FROM OLD.matched_invoice_id
      OR NEW.match_confidence     IS DISTINCT FROM OLD.match_confidence;

    -- Snel pad: geen bewaakt veld verandert.
    IF NOT v_identity_changed AND NOT v_coding_changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Een actieve marker: de bestaande bevriezing beslist.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- VOLATILE: deze query krijgt een verse snapshot en ziet dus een vrijgave
  -- die net is gecommit terwijl deze opdracht op de rijgrendel wachtte.
  SELECT e.event_type INTO v_last
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = OLD.id
  ORDER BY e.seq DESC
  LIMIT 1;

  -- Geen geschiedenis: gedrag gelijk aan vóór deze migratie.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; verwijderen is niet mogelijk.'
      USING ERRCODE = '42501';
  END IF;

  IF v_identity_changed THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; bedrag, datum, administratie, organisatie en eigenaar kunnen niet meer worden gewijzigd.'
      USING ERRCODE = '42501';
  END IF;

  -- Vrijgegeven = de laatste gebeurtenis is `released` én elke directe
  -- bankgroep van deze transactie staat al als vervangen vast. Een groep die
  -- (nog) niet vervangen is, hoort bij een correctie die nu in dezelfde
  -- transactie loopt: haar marker is net losgemaakt en haar gebeurtenis volgt
  -- — de uitgestelde lineage-controle dwingt dat bij COMMIT af. Zo'n groep
  -- bestaat na een vrijgave alleen als zij buiten de RPC's om is geboekt,
  -- bijvoorbeeld tijdens een functionele rollback van deze migratie.
  IF v_last = 'released' AND v_coding_changed
     AND NOT EXISTS (
       SELECT 1 FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = OLD.id
         AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                         WHERE e.superseded_posting_group_id = lp.posting_group_id)) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; status, rekening, BTW en factuurmatch wijzigen alleen via "Opnieuw boeken" of "Terug naar werkstroom" door een accountant.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_release_hold() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_release_hold() IS
'D12 — BEFORE UPDATE OR DELETE op bank_transactions (ENABLE ALWAYS). Zonder marker en met boekingsgeschiedenis: verwijderen en identiteitswijzigingen geweigerd; na een vrijgave (laatste gebeurtenis released) ook status, rekening, BTW en factuurmatch, voor elke rol en elk pad. Kijkt niet naar rollen.';
$hold_pr1$;

  -- De hulpfunctie pas weg als de hold weer exact die van PR 1 is (die haar niet
  -- aanroept); anders zou een hold die haar wél aanroept achterblijven.
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
     IS DISTINCT FROM '812d151a7041cdd48b7a784cd193a159' THEN
    RAISE EXCEPTION 'Rollback onvolledig: enforce_bank_transaction_release_hold is niet die van PR 1; er is niets veranderd' USING ERRCODE = '55000';
  END IF;
  DROP FUNCTION IF EXISTS public.bank_transaction_group_is_settled_history(uuid, uuid);
END
$rollback$;
