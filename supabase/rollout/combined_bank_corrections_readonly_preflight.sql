-- BoekAssist gecombineerde read-only PRE-controles voor bankcorrecties v1.1.
-- Bronnen: beide officiele preflight.sql-bestanden van main.
-- UITSLUITEND Lovable Cloud SQL-editor project alxlbdhpbwlehbdbfejw.
-- Een SELECT: per PRE-blok het rij-aantal en alle oorspronkelijke rijen in JSON.
-- Vergelijk ALLE resultaten met uitvoerplan.md. Dit script geeft geen automatische GO.
-- PRE B9 in deze SELECT bewijst NIET hoe de editor DO-dollarquotes verstuurt:
-- deze test moet afzonderlijk ongewijzigd worden uitgevoerd voor een uitrol.
-- PRE B7 afzonderlijk herhalen vlak voor een eventuele uitrol.
-- Bewaar de volledige PRE 6, PRE 7 en PRE B8 JSON voor de POST-vergelijking.
-- Geen mutaties of productiegegevenswijzigingen.

SELECT 'PRE 1'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  to_regclass('public.bank_transactions')            IS NOT NULL
  AND to_regclass('public.bank_transaction_postings')    IS NOT NULL
  AND to_regclass('public.bank_transaction_allocations') IS NOT NULL
  AND to_regclass('public.bank_allocation_postings')     IS NOT NULL
  AND to_regclass('public.ledger_postings')              IS NOT NULL
  AND to_regclass('public.ledger_reversal_postings')     IS NOT NULL      AS tabellen,
  to_regprocedure('public.post_bank_transaction(uuid)')            IS NOT NULL
  AND to_regprocedure('public.reverse_posting_group(uuid,date,text)')  IS NOT NULL
  AND to_regprocedure('public.assert_posting_allowed(uuid,date)')      IS NOT NULL
  AND to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)')     IS NOT NULL
  AND to_regprocedure('public.has_min_role(uuid,uuid,app_role)')       IS NOT NULL AS schrijvers_en_hulpfuncties,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'bank_transaction_postings'
           AND column_name IN ('bank_transaction_id', 'posting_group_id', 'grootboekrekening_id', 'posting_date',
                               'boekjaar', 'gross_amount', 'net_amount', 'btw_amount', 'btw_percentage',
                               'user_id', 'created_at'))
       OR (table_name = 'ledger_postings' AND column_name = 'created_xact_id')
       OR (table_name = 'ledger_reversal_postings'
           AND column_name IN ('original_posting_group_id', 'reversal_posting_group_id')))) = 14 AS kolommen,
  to_regprocedure('public.enforce_bank_allocation_not_directly_posted()') IS NOT NULL
  AND to_regprocedure('public.enforce_bank_allocation_posting_not_directly_posted()') IS NOT NULL
  AND to_regprocedure('public.enforce_bank_direct_posting_without_allocations()') IS NOT NULL
  AND (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN
       ('validate_bank_allocation_not_directly_posted_trigger',
        'validate_bank_allocation_posting_not_directly_posted_trigger',
        'validate_bank_direct_posting_without_allocations_trigger')) = 3    AS pr0_toegepast,
  to_regclass('public.bank_transaction_posting_events') IS NULL
  AND to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
  AND to_regprocedure('public.release_bank_transaction_posting(uuid,uuid,uuid,text)') IS NULL
  AND to_regprocedure('public.return_bank_transaction_to_workflow(uuid,uuid,text)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (
        'enforce_bank_transaction_posting_event', 'prevent_bank_transaction_posting_event_mutation',
        'prevent_bank_transaction_posting_marker_mutation', 'enforce_bank_transaction_posting_marker_delete',
        'enforce_bank_transaction_posting_marker_lineage', 'enforce_bank_transaction_release_hold',
        'enforce_bank_allocation_not_released'))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN (
        'enforce_bank_transaction_posting_marker_delete_trigger', 'enforce_bank_transaction_posting_marker_lineage_trigger',
        'prevent_bank_transaction_posting_marker_update_trigger', 'prevent_bank_transaction_posting_marker_truncate_trigger',
        'enforce_bank_transaction_release_hold_trigger', 'validate_bank_allocation_not_released_trigger'))
                                                                          AS pr1_nog_afwezig
) AS q
UNION ALL
SELECT 'PRE 2'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht, coalesce(md5(p.prosrc) = h.verwacht, false) AS gelijk
FROM (VALUES
  ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
  ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
  ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
  ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
  ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
  ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
  ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb'),
  ('enforce_bank_allocation_not_directly_posted',         '8855c971ecaa5bab46579c3ca5af5e58'),
  ('enforce_bank_allocation_posting_not_directly_posted', 'fb390f45211a7c4e909e4fc8590389b0'),
  ('enforce_bank_direct_posting_without_allocations',     '2c5174b792b86c1ee007c853be0602c7')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam
) AS q
UNION ALL
SELECT 'PRE 3'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  (SELECT count(*) FROM public.bank_transactions)            AS banktransacties,
  (SELECT count(*) FROM public.bank_transaction_postings)    AS directe_boekingen,
  (SELECT count(*) FROM public.bank_transaction_postings m
   WHERE EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = m.posting_group_id))
                                                             AS handmatig_tegengeboekt_s2,
  (SELECT count(*) FROM public.bank_transaction_postings m
   JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
   WHERE bt.matched_invoice_id IS NOT NULL)                AS direct_geboekt_met_oude_factuurmatch,
  (SELECT count(*) FROM public.bank_transaction_postings m
   JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
   WHERE bt.matched_invoice_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM (
         SELECT pi.status, pi.remaining_amount, coalesce(pi.amount_incl, pi.amount_excl) AS totaal
         FROM public.purchase_invoices pi WHERE pi.id = bt.matched_invoice_id
         UNION ALL
         SELECT si.status, si.remaining_amount, coalesce(si.amount_incl, si.amount_excl)
         FROM public.sales_invoices si WHERE si.id = bt.matched_invoice_id
       ) f
       WHERE f.status IS DISTINCT FROM 'betaald'
         AND coalesce(f.remaining_amount, f.totaal) IS NOT DISTINCT FROM f.totaal))
                                                             AS waarvan_factuur_niet_meer_volledig_open,
  (SELECT count(*) FROM public.bank_transactions bt
   WHERE bt.match_status = 'gematcht'
     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id))
                                                             AS gematcht_zonder_koppelingsrij,
  (SELECT count(*) FROM public.bank_transaction_allocations) AS koppelingen,
  (SELECT count(*) FROM public.bank_allocation_postings)     AS geboekte_afletteringen,
  (SELECT count(*) FROM public.ledger_postings)              AS grootboekregels,
  (SELECT count(*) FROM public.ledger_reversal_postings)     AS tegenboekingen
) AS q
UNION ALL
SELECT 'PRE 4'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
WITH g AS (
  SELECT m.bank_transaction_id AS tx, m.posting_group_id AS grp, m.gross_amount, m.net_amount, m.btw_amount,
         m.posting_date, bt.amount, bt.transaction_date
  FROM public.bank_transaction_postings m
  JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
), shape AS (
  SELECT g.grp,
         count(lp.*)                                                                             AS regels,
         count(*) FILTER (WHERE lp.source_type <> 'bank_transaction' OR lp.source_id <> g.tx
                             OR lp.posting_date <> g.posting_date
                             OR g.posting_date <> g.transaction_date)                            AS vreemd,
         count(*) FILTER (WHERE (g.amount < 0 AND lp.credit_amount > 0) OR (g.amount > 0 AND lp.debit_amount > 0)) AS bankzijde,
         count(*) FILTER (WHERE ((g.amount < 0 AND lp.credit_amount > 0) OR (g.amount > 0 AND lp.debit_amount > 0))
                             AND lp.debit_amount + lp.credit_amount = g.gross_amount)            AS bankzijde_bruto,
         count(*) FILTER (WHERE (g.amount < 0 AND lp.debit_amount > 0) OR (g.amount > 0 AND lp.credit_amount > 0)) AS tegenzijde,
         max(g.btw_amount) AS btw
  FROM g LEFT JOIN public.ledger_postings lp ON lp.posting_group_id = g.grp
  GROUP BY g.grp
), kandidaat AS (
  SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
  FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)
), bewijs AS (
  SELECT k.tx, k.grp,
    coalesce(
      bt.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
                  AND (o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM k.tx))
      AND (SELECT count(*) FROM public.ledger_reversal_postings r1 WHERE r1.original_posting_group_id = k.grp) = 1
      AND r.original_source_type = 'bank_transaction'
      AND (SELECT count(*) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id
                      AND (v.source_type <> 'reversal' OR v.source_id IS DISTINCT FROM k.grp OR v.reversal_of_posting_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM public.ledger_postings o
                                          WHERE o.posting_group_id = k.grp AND o.id = v.reversal_of_posting_id)))
      AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id) AND x.posting_date <> bt.transaction_date)
      AND r.posting_date = bt.transaction_date AND r.original_posting_date = bt.transaction_date
      AND NOT EXISTS (SELECT x.grootboekrekening_id FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                      GROUP BY x.grootboekrekening_id HAVING sum(x.debit_amount - x.credit_amount) <> 0)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2 WHERE r2.original_posting_group_id = r.reversal_posting_group_id)
      AND m.posting_group_id IS NOT NULL AND m.posting_group_id <> k.grp
      AND (SELECT min(a.created_at) FROM public.ledger_postings a WHERE a.posting_group_id = m.posting_group_id)
          >= (SELECT max(v.created_at) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id),
      false) AS bewezen
  FROM kandidaat k
  LEFT JOIN public.bank_transactions bt ON bt.id = k.tx
  LEFT JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = k.grp
  LEFT JOIN public.bank_transaction_postings m ON m.bank_transaction_id = k.tx
)
SELECT
  (SELECT count(*) FROM shape
   WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
      OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)                AS afwijkende_vorm,
  (SELECT count(DISTINCT grp) FROM kandidaat)                              AS bankgroepen_zonder_marker,
  (SELECT count(DISTINCT grp) FROM bewijs b
   WHERE b.bewezen AND NOT EXISTS (SELECT 1 FROM bewijs b2 WHERE b2.grp = b.grp AND NOT b2.bewezen))
                                                                           AS waarvan_historische_storno,
  (SELECT count(DISTINCT grp) FROM bewijs b WHERE NOT b.bewezen)           AS waarvan_onverklaard,
  EXISTS (SELECT 1 FROM shape
          WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
             OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)
  OR EXISTS (SELECT 1 FROM kandidaat)                                      AS stop_losse_uitrol,
  EXISTS (SELECT 1 FROM shape
          WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
             OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)
  OR EXISTS (SELECT 1 FROM bewijs b WHERE NOT b.bewezen)                   AS stop
) AS q
UNION ALL
SELECT 'PRE 4b'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
WITH kandidaat AS (
  SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
  FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)
), feiten AS (
  SELECT k.tx, k.grp, bt.transaction_date, r.reversal_posting_group_id AS storno, m.posting_group_id AS actuele_groep,
    (SELECT min(o.posting_date) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)                 AS groepsdatum,
    (SELECT min(v.posting_date) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id) AS stornodatum,
    (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)                           AS regels,
    (SELECT sum(o.debit_amount) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)                AS debet,
    coalesce(bt.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
                      AND (o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM k.tx)), false) AS b1_zelfde_transactie,
    coalesce((SELECT count(*) FROM public.ledger_reversal_postings r1 WHERE r1.original_posting_group_id = k.grp) = 1
      AND r.original_source_type = 'bank_transaction'
      AND (SELECT count(*) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id
                      AND (v.source_type <> 'reversal' OR v.source_id IS DISTINCT FROM k.grp OR v.reversal_of_posting_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM public.ledger_postings o
                                          WHERE o.posting_group_id = k.grp AND o.id = v.reversal_of_posting_id)))
      AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp), false) AS b2_reversalketen,
    coalesce(NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                         WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id) AND x.posting_date <> bt.transaction_date)
      AND r.posting_date = bt.transaction_date AND r.original_posting_date = bt.transaction_date, false)         AS b3_transactiedatum,
    coalesce(r.reversal_posting_group_id IS NOT NULL
      AND NOT EXISTS (SELECT x.grootboekrekening_id FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                      GROUP BY x.grootboekrekening_id HAVING sum(x.debit_amount - x.credit_amount) <> 0), false) AS b4_neutraal,
    coalesce(r.reversal_posting_group_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2 WHERE r2.original_posting_group_id = r.reversal_posting_group_id), false)
                                                                                                                AS b5_storno_geldig,
    coalesce(m.posting_group_id IS NOT NULL AND m.posting_group_id <> k.grp
      AND (SELECT min(a.created_at) FROM public.ledger_postings a WHERE a.posting_group_id = m.posting_group_id)
          >= (SELECT max(v.created_at) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id), false)
                                                                                                                AS b6_actuele_marker_daarna
  FROM kandidaat k
  LEFT JOIN public.bank_transactions bt ON bt.id = k.tx
  LEFT JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = k.grp
  LEFT JOIN public.bank_transaction_postings m ON m.bank_transaction_id = k.tx
)
SELECT f.tx AS banktransactie, f.grp AS groep, f.storno, f.actuele_groep,
       f.transaction_date, f.groepsdatum, f.stornodatum, f.regels, f.debet,
       f.b1_zelfde_transactie, f.b2_reversalketen, f.b3_transactiedatum, f.b4_neutraal, f.b5_storno_geldig, f.b6_actuele_marker_daarna,
       (f.b1_zelfde_transactie AND f.b2_reversalketen AND f.b3_transactiedatum AND f.b4_neutraal
        AND f.b5_storno_geldig AND f.b6_actuele_marker_daarna)                                                 AS bewezen,
       CASE WHEN f.b1_zelfde_transactie AND f.b2_reversalketen AND f.b3_transactiedatum AND f.b4_neutraal
                 AND f.b5_storno_geldig AND f.b6_actuele_marker_daarna
            THEN 'bewezen historische storno — alleen via de gecombineerde uitrol (PR 1 + PR 2 + 20261018180000)'
            WHEN f.transaction_date IS NULL THEN 'STOP — de banktransactie bestaat niet meer'
            WHEN f.storno IS NULL THEN 'STOP — niet gestorneerd'
            WHEN f.actuele_groep IS NULL THEN 'STOP — geen actuele marker'
            ELSE 'STOP — onverklaard (zie de onware bewijsstukken)' END                                          AS toestand
FROM feiten f
ORDER BY f.transaction_date, f.tx, f.groepsdatum
) AS q
UNION ALL
SELECT 'PRE 5'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT m.bank_transaction_id, bt.transaction_date, bt.amount, m.posting_group_id, r.reversal_posting_group_id,
       r.posting_date AS tegenboekingsdatum, r.posting_date = bt.transaction_date AS herboekbaar_via_rpc, r.reason
FROM public.bank_transaction_postings m
JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = m.posting_group_id
ORDER BY bt.transaction_date, m.bank_transaction_id
LIMIT 200
) AS q
UNION ALL
SELECT 'PRE 6'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT 'bank_transactions' AS tabel, count(*) AS rijen,
       md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) AS digest
FROM public.bank_transactions t
UNION ALL
SELECT 'bank_transaction_allocations', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), ''))
FROM public.bank_transaction_allocations t
UNION ALL
SELECT 'bank_allocation_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.allocation_id), ''))
FROM public.bank_allocation_postings t
UNION ALL
SELECT 'bank_transaction_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.bank_transaction_id), ''))
FROM public.bank_transaction_postings t
UNION ALL
SELECT 'ledger_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), ''))
FROM public.ledger_postings t
UNION ALL
SELECT 'ledger_reversal_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.original_posting_group_id), ''))
FROM public.ledger_reversal_postings t
) AS q
UNION ALL
SELECT 'PRE 7'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)                            AS publieke_functies,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace)                                AS triggers_public,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p'))  AS tabellen,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S')         AS sequences,
  (SELECT count(*) FROM pg_policy)                                                                       AS policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace <> 'public'::regnamespace)                           AS functies_buiten_public,
  (SELECT count(*) FROM pg_event_trigger)                                                                AS event_triggers,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s', c.oid::regclass, c.relkind, coalesce(c.relacl::text, ''),
                                         c.relrowsecurity), ',' ORDER BY c.oid::regclass::text), ''))
   FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname NOT IN ('bank_transaction_posting_events', 'bank_transaction_posting_events_seq_seq')
     AND c.relname NOT LIKE 'bank_transaction_posting_events_%'
     AND c.relname NOT LIKE 'idx_bank_transaction_posting_events_%')                                   AS bestaande_relaties_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', polrelid::regclass, polname, polcmd, polroles::text,
                                         pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)),
                                  ',' ORDER BY polrelid::regclass::text, polname), ''))
   FROM pg_policy WHERE polrelid <> coalesce(to_regclass('public.bank_transaction_posting_events')::oid, 0::oid)) AS bestaande_policies_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s', p.oid::regprocedure, md5(p.prosrc), pg_get_userbyid(p.proowner),
                                         coalesce(p.proacl::text, '')), ',' ORDER BY p.oid::regprocedure::text), ''))
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN (
     'reclassify_bank_transaction', 'release_bank_transaction_posting', 'return_bank_transaction_to_workflow',
     'enforce_bank_transaction_posting_event', 'prevent_bank_transaction_posting_event_mutation',
     'prevent_bank_transaction_posting_marker_mutation', 'enforce_bank_transaction_posting_marker_delete',
     'enforce_bank_transaction_posting_marker_lineage', 'enforce_bank_transaction_release_hold',
     'enforce_bank_allocation_not_released', 'bank_transaction_group_is_settled_history'))            AS bestaande_functies_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s', t.tgrelid::regclass, t.tgname, t.tgenabled),
                                  ',' ORDER BY t.tgrelid::regclass::text, t.tgname), ''))
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgname NOT IN (
     'enforce_bank_transaction_posting_event_trigger', 'prevent_bank_transaction_posting_event_mutation_trigger',
     'prevent_bank_transaction_posting_event_truncate_trigger', 'prevent_bank_transaction_posting_marker_update_trigger',
     'prevent_bank_transaction_posting_marker_truncate_trigger', 'enforce_bank_transaction_posting_marker_delete_trigger',
     'enforce_bank_transaction_posting_marker_lineage_trigger', 'enforce_bank_transaction_release_hold_trigger',
     'validate_bank_allocation_not_released_trigger'))                                                 AS bestaande_triggers_digest
) AS q
UNION ALL
SELECT 'PRE 8'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  current_user AS editorrol,
  current_setting('server_version') AS serverversie,
  current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
                  WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure)            AS eigenaar_van_de_schrijvers,
  current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transactions'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_postings'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_allocations'::regclass)
                                                                                           AS eigenaar_van_de_tabellen
) AS q
UNION ALL
SELECT 'PRE 9'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT count(*) AS transacties_met_afwijkende_tenant
FROM public.bank_transactions bt
JOIN public.clients c ON c.id = bt.client_id
WHERE bt.organization_id IS DISTINCT FROM c.organization_id
) AS q
UNION ALL
SELECT 'PRE 10'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT c.relname AS tabel, t.tgname, t.tgenabled,
       (c.relname::text, t.tgname::text) IN (VALUES
         ('bank_allocation_postings',     'validate_bank_allocation_posting_not_directly_posted_trigger'),
         ('bank_transaction_allocations', 'prevent_org_user_rebind_trg'),
         ('bank_transaction_allocations', 'prevent_posted_bank_allocation_mutation_trigger'),
         ('bank_transaction_allocations', 'set_organization_id_trigger'),
         ('bank_transaction_allocations', 'update_bank_transaction_allocations_updated_at'),
         ('bank_transaction_allocations', 'validate_bank_allocation_not_directly_posted_trigger'),
         ('bank_transaction_postings',    'validate_bank_direct_posting_without_allocations_trigger'),
         ('bank_transactions',            'prevent_org_user_rebind_trg'),
         ('bank_transactions',            'prevent_posted_bank_transaction_mutation_trigger'),
         ('bank_transactions',            'set_organization_id_trigger'),
         ('bank_transactions',            'update_bank_transactions_updated_at')) AS bekend
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.oid IN ('public.bank_transactions'::regclass, 'public.bank_transaction_postings'::regclass,
                'public.bank_transaction_allocations'::regclass, 'public.bank_allocation_postings'::regclass)
ORDER BY c.relname, t.tgname
) AS q
UNION ALL
SELECT 'PRE 11'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT count(*) AS onbekend, count(*) > 0 AS stop
FROM pg_trigger t
WHERE NOT t.tgisinternal
  AND t.tgrelid = 'public.bank_transactions'::regclass
  AND t.tgname NOT IN ('prevent_org_user_rebind_trg', 'prevent_posted_bank_transaction_mutation_trigger',
                       'set_organization_id_trigger', 'update_bank_transactions_updated_at')
) AS q
UNION ALL
SELECT 'PRE B1'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  to_regclass('public.bank_transaction_posting_events') IS NULL                                     AS geen_gebeurtenistabel,
  to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL AS geen_correctie_rpc,
  to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NULL                         AS geen_hold,
  to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL            AS geen_hulpfunctie,
  to_regprocedure('public.enforce_bank_direct_posting_without_allocations()') IS NOT NULL           AS pr0_toegepast
) AS q
UNION ALL
SELECT 'PRE B2'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT md5(p.prosrc) AS md5_productie, md5(p.prosrc) = '2369978c713ac78a0c039dd5c3e5eb4c' AS gelijk
FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)')
) AS q
UNION ALL
SELECT 'PRE B3'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
WITH bekend(tgname, functie, md5, ingeschakeld) AS (VALUES
  ('prevent_org_user_rebind_trg',                      'prevent_org_user_rebind',                  '9d75d3c98a66f0fc0299b795ee40461e', 'O'),
  ('prevent_posted_bank_transaction_mutation_trigger', 'prevent_posted_bank_transaction_mutation', 'a6437536b1942e78d5b072f22fe6a842', 'O'),
  ('set_organization_id_trigger',                      'set_organization_id',                      'e56450399d8f95c5ed42fd2df04bed06', 'O'),
  ('update_bank_transactions_updated_at',              'update_updated_at_column',                 '301a884953d37769916294bb60562e05', 'O')),
actueel AS (
  SELECT t.tgname::text AS tgname, p.proname::text AS functie, md5(p.prosrc) AS md5, t.tgenabled::text AS ingeschakeld
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal)
SELECT coalesce(a.tgname, b.tgname) AS tgname, a.functie, a.md5, a.ingeschakeld,
       (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
        AND a.functie = b.functie AND a.md5 = b.md5 AND a.ingeschakeld = b.ingeschakeld) AS bekend,
       NOT (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
            AND a.functie = b.functie AND a.md5 = b.md5 AND a.ingeschakeld = b.ingeschakeld) AS stop
FROM actueel a FULL JOIN bekend b ON b.tgname = a.tgname
ORDER BY 1
) AS q
UNION ALL
SELECT 'PRE B4'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  (SELECT count(*) FROM pg_rules WHERE schemaname = 'public' AND tablename = 'bank_transactions')  AS rules,
  (SELECT count(*) FROM pg_publication WHERE puballtables)                                          AS publicaties_alle_tabellen,
  (SELECT count(*) FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'bank_transactions') AS publicaties_bank_transactions,
  EXISTS (SELECT 1 FROM pg_rules WHERE schemaname = 'public' AND tablename = 'bank_transactions')
  OR EXISTS (SELECT 1 FROM pg_publication WHERE puballtables)
  OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'bank_transactions') AS stop
) AS q
UNION ALL
SELECT 'PRE B5'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT current_user AS editorrol,
       pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)'))) AS eigenaar_schrijver,
       current_user = pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)'))) AS gelijk
) AS q
UNION ALL
SELECT 'PRE B6'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
WITH kandidaat AS (
  SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
  FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)
), bewijs AS (
  SELECT k.tx, k.grp, r.reversal_posting_group_id AS storno, m.posting_group_id AS actuele_groep,
    coalesce(
      bt.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
                  AND (o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM k.tx))
      AND (SELECT count(*) FROM public.ledger_reversal_postings r1 WHERE r1.original_posting_group_id = k.grp) = 1
      AND r.original_source_type = 'bank_transaction'
      AND (SELECT count(*) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id
                      AND (v.source_type <> 'reversal' OR v.source_id IS DISTINCT FROM k.grp OR v.reversal_of_posting_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM public.ledger_postings o
                                          WHERE o.posting_group_id = k.grp AND o.id = v.reversal_of_posting_id)))
      AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id) AND x.posting_date <> bt.transaction_date)
      AND r.posting_date = bt.transaction_date AND r.original_posting_date = bt.transaction_date
      AND NOT EXISTS (SELECT x.grootboekrekening_id FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                      GROUP BY x.grootboekrekening_id HAVING sum(x.debit_amount - x.credit_amount) <> 0)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2 WHERE r2.original_posting_group_id = r.reversal_posting_group_id)
      AND m.posting_group_id IS NOT NULL AND m.posting_group_id <> k.grp
      AND (SELECT min(a.created_at) FROM public.ledger_postings a WHERE a.posting_group_id = m.posting_group_id)
          >= (SELECT max(v.created_at) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id),
      false) AS bewezen
  FROM kandidaat k
  LEFT JOIN public.bank_transactions bt ON bt.id = k.tx
  LEFT JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = k.grp
  LEFT JOIN public.bank_transaction_postings m ON m.bank_transaction_id = k.tx
), telling AS (
  SELECT
    (SELECT count(DISTINCT grp) FROM bewijs b
     WHERE b.bewezen AND NOT EXISTS (SELECT 1 FROM bewijs b2 WHERE b2.grp = b.grp AND NOT b2.bewezen))          AS bewezen,
    (SELECT count(DISTINCT grp) FROM bewijs b WHERE NOT b.bewezen)                                               AS onverklaard,
    EXISTS (SELECT 1 FROM bewijs b
            WHERE b.bewezen
              AND b.grp = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'
              AND b.storno = 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8'
              AND b.actuele_groep = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3')                                       AS bekende_storno_bewezen,
    (SELECT count(DISTINCT grp) FROM bewijs b
     WHERE b.bewezen AND b.grp <> 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a')                                       AS andere_bewezen,
    coalesce((SELECT max(x.created_at) FROM public.ledger_postings x
              WHERE x.posting_group_id IN ('fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a', 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8')) < now()
             AND (SELECT r.created_at FROM public.ledger_reversal_postings r
                  WHERE r.original_posting_group_id = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a') < now(), false)       AS bekende_storno_in_verleden
)
SELECT t.*, (t.onverklaard > 0 OR NOT t.bekende_storno_bewezen OR t.andere_bewezen > 0 OR NOT t.bekende_storno_in_verleden) AS stop
FROM telling t
) AS q
UNION ALL
SELECT 'PRE B7'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT a.pid, a.usename, a.application_name, a.state, a.xact_start, left(a.query, 80) AS query
FROM pg_stat_activity a
WHERE a.pid <> pg_backend_pid()
  AND a.backend_type = 'client backend'
  AND a.usename IN ('authenticator', 'authenticated', 'anon', 'service_role')
  AND a.state <> 'idle'
ORDER BY a.xact_start NULLS LAST
) AS q
UNION ALL
SELECT 'PRE B8'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers
) AS q
UNION ALL
SELECT 'PRE B9'::text AS controle, count(*)::bigint AS aantal_rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat
FROM (
SELECT $buiten$
$binnen$;
SELECT 'GESPLITST — STOP' AS proef;
$binnen$
$buiten$ IS NOT NULL AS heel
) AS q;
