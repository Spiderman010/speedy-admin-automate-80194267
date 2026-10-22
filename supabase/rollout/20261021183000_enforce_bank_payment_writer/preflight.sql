-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261021183000_enforce_bank_payment_writer.sql (P5c)
--
-- UITSLUITEND in de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`
-- (zie ../20261021180000_add_atomic_bank_payment_link/preflight.sql). Alles
-- hieronder is ALLEEN LEZEN. Bewaar PRE 2 (voor een eventuele rollback) en
-- PRE 6 (POST 2 vergelijkt).
--
-- P5c pas uitvoeren als P5a is toegepast én de app van P5b live is.
--
-- STOP (niet uitvoeren, uitkomst doorgeven) als:
--   • PRE 1 ergens `false` geeft;
--   • PRE 3 `oude_app_schrijft_nog` > 0: er is sinds het eerste gebruik van de
--     betaalschrijver nog een koppeling buiten de schrijver om gemaakt of
--     gewijzigd — een oude client (of P5b) schrijft nog rechtstreeks;
--   • PRE 4 `laatste_ocr_nul_zonder_bedrag` ligt NA het moment waarop de
--     intakefix van P2 live ging: de intake maakt nog facturen met restant 0
--     zonder bedrag, en P5c zou die intake laten falen.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. P5a aanwezig, P5c nog niet ───────────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NOT NULL
    AND to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)') IS NOT NULL
    AND to_regclass('public.bank_payment_events') IS NOT NULL                  AS p5a_toegepast,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_bank_allocation_write_trigger') AS p5a_guard,
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('enforce_bank_allocation_writer_trigger',
                                                        'enforce_invoice_payment_state_trigger')) AS p5c_nog_niet,
  has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'INSERT') AS app_kan_nog_direct;


-- ── PRE 2. Huidige rechten op de koppelingen (bewaren voor de rollback) ─────
SELECT string_agg(format('%s:%s', a.grantee::regrole, a.privilege_type), ',' ORDER BY a.grantee::regrole::text, a.privilege_type)
       AS rechten_koppelingen
FROM pg_class c, aclexplode(c.relacl) a
WHERE c.oid = 'public.bank_transaction_allocations'::regclass;


-- ── PRE 3. Schrijft er nog iets buiten de betaalschrijver om? ───────────────
-- Verwacht: oude_app_schrijft_nog = 0 (en eerste_gebruik niet leeg: P5b is in gebruik).
-- Beperking (review P5-DB §5): telt alleen koppelingen die nog bestaan en na het
-- eerste gebruik zijn gemaakt of gewijzigd. Een directe DELETE van een koppeling
-- of een directe restant-/statuswrite op een factuur door een oud tabblad ziet
-- deze query niet. Dat is fail-closed: P5c sluit precies die paden, zo'n oud
-- tabblad krijgt daarna alleen een weigering.
WITH t0 AS (SELECT min(created_at) AS eerste FROM public.bank_payment_events)
SELECT
  (SELECT eerste FROM t0)                                                      AS eerste_gebruik_schrijver,
  (SELECT count(*) FROM public.bank_transaction_allocations a, t0
   WHERE t0.eerste IS NOT NULL
     AND (a.created_at > t0.eerste OR a.updated_at > t0.eerste)
     AND NOT EXISTS (SELECT 1 FROM public.bank_payment_events e
                     WHERE e.allocation_id = a.id AND e.event_type = 'linked'))  AS oude_app_schrijft_nog,
  (SELECT count(*) FROM public.bank_payment_events)                            AS gebeurtenissen;


-- ── PRE 4. Maakt de intake nog facturen met restant 0 zonder bedrag? ────────
-- Vergelijk laatste_ocr_nul_zonder_bedrag met het live-moment van de P2-fix.
SELECT soort, count(*) AS aantal_totaal, max(created_at) AS laatste_ocr_nul_zonder_bedrag
FROM (
  SELECT 'inkoop'::text AS soort, created_at FROM public.purchase_invoices
  WHERE remaining_amount = 0 AND amount_incl IS NULL AND amount_excl IS NULL
  UNION ALL
  SELECT 'verkoop', created_at FROM public.sales_invoices
  WHERE remaining_amount = 0 AND amount_incl IS NULL AND amount_excl IS NULL
) x
GROUP BY soort
ORDER BY soort;


-- ── PRE 5. Wat P5c vanaf nu weigert (ter informatie, geen STOP) ─────────────
SELECT
  (SELECT count(DISTINCT invoice_id) FROM public.bank_transaction_allocations) AS facturen_met_koppelingen_bedrag_bevroren,
  (SELECT count(*) FROM public.sales_invoices WHERE status = 'betaald')        AS verkoop_betaald_goedkeuren_geweigerd,
  (SELECT count(*) FROM public.bank_transactions bt
   WHERE EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id))
                                                                               AS banktransacties_met_koppelingen_niet_verwijderbaar;


-- ── PRE 6. Vingerafdruk van de data (bewaren; POST 2 vergelijkt) ────────────
SELECT
  (SELECT count(*) FROM public.bank_transaction_allocations)                   AS koppelingen,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', id, bank_transaction_id, invoice_type, invoice_id,
                                          amount, created_by), ',' ORDER BY id), '')
       FROM public.bank_transaction_allocations))                             AS koppelingen_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, remaining_amount, status, amount_incl), ',' ORDER BY id), '')
       FROM public.purchase_invoices))                                         AS inkoop_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, remaining_amount, status, amount_incl), ',' ORDER BY id), '')
       FROM public.sales_invoices))                                            AS verkoop_md5;
