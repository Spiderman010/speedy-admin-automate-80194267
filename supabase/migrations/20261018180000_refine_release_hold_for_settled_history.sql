-- ═════════════════════════════════════════════════════════════════════════════
-- Bankcorrecties v1.1 — de vrijgave-hold (D12) en historische storno's van vóór PR 1
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WAAROM
--   De hold van PR 1 (20261018120000) noemt een regel pas "vrijgegeven" als de
--   laatste gebeurtenis `released` is én elke directe bankgroep van die regel
--   al als vervangen in een gebeurtenis staat. Dat laatste is er voor een
--   correctie die op dat moment loopt: haar marker is net losgemaakt en haar
--   gebeurtenis volgt nog. Een directe bankgroep van vóór PR 1 die toen
--   handmatig is gestorneerd en daarna opnieuw is geboekt, staat echter nooit
--   als vervangen vast. Voor zo'n regel ging de hold na een vrijgave dus nooit
--   meer aan: de app (handmatig boeken, sjablonen, de scan, bulk) kon haar stil
--   opnieuw boeken (bewezen in supabase/tests/bank-release-hold-history/).
--   In productie gaat het om één regel van 25-11-2025.
--
-- WAT
--   1. Een interne hulpfunctie, alleen lezen:
--      bank_transaction_group_is_settled_history(transactie, groep) is waar
--      uitsluitend als ALLES bewezen is:
--        (1) de groep bestaat alleen uit directe bankregels van deze transactie;
--        (2) zij is gestorneerd via de bestaande reversalketen: precies één
--            claim, en elke regel van de storno keert precies één regel om;
--        (3) origineel, storno en claim staan op de transactiedatum;
--        (4) origineel en storno zijn per grootboekrekening volledig neutraal;
--        (5) de storno is niet zelf tegengeboekt;
--        (6) de groep is niet de actieve marker en staat in geen gebeurtenis;
--        (7) na de storno volgde een nieuwe directe boeking van de transactie;
--        (8) origineel, storno en claim zijn alle strikt ouder dan elke
--            correctiegebeurtenis van deze transactie — op tijd (created_at)
--            én op transactievolgorde (created_xact_id). Alleen de tijd is niet
--            genoeg: created_at is now(), de START van een transactie; een
--            transactie die vóór een gebeurtenis begon en pas daarna schreef,
--            krijgt een vroegere tijd maar een latere xid (Codex).
--      Alleen een eerdere datum, of alleen het ontbreken van een marker, is
--      dus nooit genoeg.
--   2. enforce_bank_transaction_release_hold = het lichaam van PR 1 met één
--      wijziging: zo'n bewezen historische storno telt niet meer als lopende
--      correctie. Snel pad, markerpad, geschiedenispad, verwijder- en
--      identiteitsbeveiliging, meldingen en foutcodes: letterlijk gelijk.
--
-- WAAROM DIT DE HOLD NIET VERZWAKT
--   • De wijziging voegt alleen een uitzondering toe op de groepen die de hold
--     UITSCHAKELEN. De hold geldt dus in elke situatie waarin hij onder PR 1
--     gold, en daarnaast voor een vrijgegeven regel met bewezen geschiedenis.
--   • Een lopende correctie kan nooit als historische storno gelden. Haar groep
--     was tot in deze transactie de actieve boeking, dus na haar storno bestaat
--     nog geen nieuwe boeking: (7) is onwaar. Bovendien is haar storno niet
--     ouder dan de eerste gebeurtenis van de transactie: (8) is onwaar — ook in
--     F2 (een groep geboekt tijdens een functionele rollback), want die
--     correctie begon pas nadat de vrijgave was gecommit.
--   • Een groep die niet aan alles voldoet, gedraagt zich als onder PR 1; de
--     uitrolcontroles geven daarop STOP (PRE 4, POST 8).
--
-- NIET
--   Geen schrijver, geen grootboekregel, marker, gebeurtenis, trigger(definitie),
--   tabel, RLS of recht verandert — behalve de rechten van de nieuwe hulp-
--   functie zelf (alleen de eigenaar). Geen data.
--
-- VOLGORDE
--   Ná 20261018120000 (PR 1) en 20261018150000 (PR 2). De voorwaardencontrole
--   van PR 2 pint het lichaam van de PR 1-hold; deze migratie eerst toepassen
--   zou PR 2 laten weigeren. Daarom eist de controle hieronder dat PR 2 er al is.
--
-- PRODUCTIE (Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw)
--   Zie supabase/rollout/20261018180000_refine_release_hold_for_settled_history/:
--   PR 1, PR 2 en deze migratie in ÉÉN uitvoering, zodat de tussentoestand
--   (PR 1 zonder deze fix) nooit zichtbaar wordt.
--
-- ROLLBACK (handmatig, met akkoord van de eigenaar; data-neutraal)
--   -- rollback: voer supabase/rollout/20261018180000_refine_release_hold_for_settled_history/rollback.sql
--   --           uit; dat zet de hold byte-gelijk terug naar PR 1 en verwijdert de
--   --           hulpfunctie. Een rollback van PR 2 of PR 1 daarna, nooit ervoor.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Voorwaarden: precies de beoordeelde toestand, anders niets ───────────
DO $migratie$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.ledger_postings') IS NULL
     OR to_regclass('public.ledger_reversal_postings') IS NULL
     OR to_regclass('public.bank_transaction_postings') IS NULL
     OR to_regclass('public.bank_transaction_posting_events') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: de tabellen van het grootboek en van PR 1 ontbreken' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_postings'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_postings'::regclass AND a.attname = 'reversal_of_posting_id' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_postings'::regclass AND a.attname = 'created_xact_id' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_reversal_postings'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.bank_transaction_posting_events'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.bank_transaction_posting_events'::regclass AND a.attname = 'created_xact_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'Voorwaarde: de kolommen waarop het bewijs van geschiedenis steunt ontbreken' USING ERRCODE = '55000';
  END IF;

  -- PR 2 is toegepast (en dus PR 1): eerst PR 2, dan deze migratie.
  IF to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
        IS DISTINCT FROM '067939e0c44a672c26ec8883717ef6d2' THEN
    RAISE EXCEPTION 'Voorwaarde: PR 2 (20261018150000) is niet toegepast' USING ERRCODE = '55000';
  END IF;

  -- De te vervangen hold is exact die van PR 1 (of deze, bij een tweede toepassing).
  IF to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold ontbreekt' USING ERRCODE = '55000';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()');
  IF v_md5 NOT IN ('812d151a7041cdd48b7a784cd193a159', '43347fb9f48ed4c161e291fa769577c2') THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold is niet de beoordeelde versie (md5 %)', v_md5 USING ERRCODE = '55000';
  END IF;

  -- Met de eigenaar van de schrijvers: CREATE OR REPLACE behoudt de eigenaar,
  -- en als SECURITY DEFINER draait de hold met diens rechten.
  IF (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
     IS DISTINCT FROM
     (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)')) THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold heeft een andere eigenaar dan de schrijver post_bank_transaction' USING ERRCODE = '55000';
  END IF;

  -- En de trigger die haar aanroept: ENABLE ALWAYS op bank_transactions.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = 'public.bank_transactions'::regclass
                   AND t.tgname = 'enforce_bank_transaction_release_hold_trigger'
                   AND t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()')
                   AND t.tgenabled = 'A' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Voorwaarde: de hold-trigger op bank_transactions ontbreekt of is niet ENABLE ALWAYS' USING ERRCODE = '55000';
  END IF;

  -- De hulpfunctie bestaat nog niet, of is exact deze (tweede toepassing), met dezelfde eigenaar.
  IF to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NOT NULL
     AND ((SELECT md5(p.prosrc) FROM pg_proc p
           WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
          IS DISTINCT FROM '9e4593fcda07e2994459a7d3ac440ce6'
          OR (SELECT p.proowner FROM pg_proc p
              WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
          IS DISTINCT FROM
          (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)'))) THEN
    RAISE EXCEPTION 'Voorwaarde: bank_transaction_group_is_settled_history bestaat al in een andere vorm' USING ERRCODE = '55000';
  END IF;
END
$migratie$;

-- ── 2. Het bewijs van een historische storno (intern, alleen lezen) ─────────


CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(
  _transaction_id   uuid,
  _posting_group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH tx AS (
    SELECT bt.id, bt.transaction_date
    FROM public.bank_transactions bt
    WHERE bt.id = _transaction_id
  ), orig AS (
    SELECT lp.id, lp.source_type, lp.source_id, lp.grootboekrekening_id, lp.posting_date,
           lp.debit_amount, lp.credit_amount, lp.created_at, lp.created_xact_id
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = _posting_group_id
  ), claim AS (
    SELECT r.reversal_posting_group_id, r.original_source_type, r.original_posting_date, r.posting_date, r.created_at
    FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = _posting_group_id
  ), rev AS (
    SELECT lp.id, lp.source_type, lp.source_id, lp.reversal_of_posting_id, lp.grootboekrekening_id, lp.posting_date,
           lp.debit_amount, lp.credit_amount, lp.created_at, lp.created_xact_id
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = (SELECT c.reversal_posting_group_id FROM claim c)
  ), event AS (
    SELECT e.created_at, e.created_xact_id
    FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = _transaction_id
  )
  SELECT
    -- (1) Dezelfde banktransactie: de groep bestaat uitsluitend uit haar directe bankregels.
    EXISTS (SELECT 1 FROM tx)
    AND EXISTS (SELECT 1 FROM orig)
    AND NOT EXISTS (SELECT 1 FROM orig o
                    WHERE o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM _transaction_id)
    -- (2) Gestorneerd via de bestaande reversalketen: precies één claim, en elke
    --     regel van de storno keert precies één regel van deze groep om.
    AND (SELECT count(*) FROM claim) = 1
    AND (SELECT c.original_source_type FROM claim c) = 'bank_transaction'
    AND EXISTS (SELECT 1 FROM rev)
    AND (SELECT count(*) FROM rev) = (SELECT count(*) FROM orig)
    AND NOT EXISTS (SELECT 1 FROM rev v
                    WHERE v.source_type <> 'reversal'
                       OR v.source_id IS DISTINCT FROM _posting_group_id
                       OR v.reversal_of_posting_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM orig o WHERE o.id = v.reversal_of_posting_id))
    AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM rev v) = (SELECT count(*) FROM orig)
    -- (3) De juiste datum: origineel én storno op de transactiedatum (anders
    --     zou de periode daartussen dubbel staan).
    AND NOT EXISTS (SELECT 1 FROM orig o, tx t WHERE o.posting_date <> t.transaction_date)
    AND NOT EXISTS (SELECT 1 FROM rev v, tx t WHERE v.posting_date <> t.transaction_date)
    AND NOT EXISTS (SELECT 1 FROM claim c, tx t
                    WHERE c.posting_date <> t.transaction_date OR c.original_posting_date <> t.transaction_date)
    -- (4) Volledig neutraal per grootboekrekening.
    AND NOT EXISTS (SELECT x.grootboekrekening_id
                    FROM (SELECT o.grootboekrekening_id, o.debit_amount - o.credit_amount AS saldo FROM orig o
                          UNION ALL
                          SELECT v.grootboekrekening_id, v.debit_amount - v.credit_amount FROM rev v) x
                    GROUP BY x.grootboekrekening_id
                    HAVING sum(x.saldo) <> 0)
    -- (5) De storno is niet zelf ongeldig gemaakt (niet zelf tegengeboekt).
    AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2
                    WHERE r2.original_posting_group_id = (SELECT c.reversal_posting_group_id FROM claim c))
    -- (6) Niet de actieve marker, en in geen enkele correctiegebeurtenis genoemd.
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.posting_group_id = _posting_group_id)
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                    WHERE e.superseded_posting_group_id = _posting_group_id
                       OR e.replacement_posting_group_id = _posting_group_id)
    -- (7) Consistente historie: na de storno volgde een nieuwe directe boeking
    --     van dezelfde banktransactie.
    AND EXISTS (SELECT 1 FROM public.ledger_postings g
                WHERE g.source_type = 'bank_transaction' AND g.source_id = _transaction_id
                  AND g.posting_group_id <> _posting_group_id
                  AND g.created_at >= (SELECT max(v.created_at) FROM rev v))
    -- (8) Geschiedenis van vóór de correctiegebeurtenissen van deze transactie:
    --     origineel, storno en claim zijn alle strikt ouder dan elke gebeurtenis,
    --     op tijd én op transactievolgorde. created_at is now(): de START van de
    --     transactie; een transactie die vóór een gebeurtenis begon maar pas
    --     daarna schreef, heeft dus een vroegere tijd. created_xact_id wordt
    --     toegekend bij de eerste schrijfactie (ook een rijgrendel), zodat zo'n
    --     transactie een latere xid heeft. De claim ontstaat in dezelfde
    --     transactie als de stornoregels (reverse_posting_group).
    AND NOT EXISTS (SELECT 1
                    FROM event f,
                         (SELECT o.created_at, o.created_xact_id FROM orig o
                          UNION ALL SELECT v.created_at, v.created_xact_id FROM rev v
                          UNION ALL SELECT c.created_at, NULL::xid8 FROM claim c) x
                    WHERE x.created_at >= f.created_at OR x.created_xact_id >= f.created_xact_id);
$$;

REVOKE ALL ON FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) IS
'Intern, alleen lezen (STABLE). Waar uitsluitend als de directe bankgroep een bewezen historische storno is van vóór de correctiegebeurtenissen van deze banktransactie: dezelfde transactie, precies één storno via de reversalketen die elke regel omkeert, origineel en storno op de transactiedatum, per grootboekrekening neutraal, de storno niet zelf tegengeboekt, geen marker en in geen gebeurtenis genoemd, gevolgd door een nieuwe directe boeking, en alles strikt ouder dan de eerste gebeurtenis. Gebruikt door enforce_bank_transaction_release_hold.';

-- ── 3. De vrijgave-hold, met de historische storno ───────────────────────────

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
  -- Een bewezen historische storno van vóór de correctiegebeurtenissen van
  -- deze transactie (bank_transaction_group_is_settled_history) is zo'n groep
  -- niet: zij hoort bij geen lopende correctie en schakelt de hold niet uit.
  IF v_last = 'released' AND v_coding_changed
     AND NOT EXISTS (
       SELECT 1 FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = OLD.id
         AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                         WHERE e.superseded_posting_group_id = lp.posting_group_id)
         AND NOT public.bank_transaction_group_is_settled_history(OLD.id, lp.posting_group_id)) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; status, rekening, BTW en factuurmatch wijzigen alleen via "Opnieuw boeken" of "Terug naar werkstroom" door een accountant.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_release_hold() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_release_hold() IS
'D12 — BEFORE UPDATE OR DELETE op bank_transactions (ENABLE ALWAYS). Zonder marker en met boekingsgeschiedenis: verwijderen en identiteitswijzigingen geweigerd; na een vrijgave (laatste gebeurtenis released) ook status, rekening, BTW en factuurmatch, voor elke rol en elk pad. Een bewezen historische storno van vóór de correctiegebeurtenissen (bank_transaction_group_is_settled_history) schakelt die hold niet uit. Kijkt niet naar rollen.';
