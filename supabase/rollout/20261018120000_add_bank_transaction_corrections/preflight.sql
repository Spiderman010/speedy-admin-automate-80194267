-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261018120000_add_bank_transaction_corrections.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (controlelijst in PROJECT_MAP.md: de Request-URL-
-- host en de `sb-project-ref`-header in het netwerktabblad, en de projectref in
-- de editor). Nooit het persoonlijke Supabase-dashboard, nooit de Vercel
-- Marketplace-database, nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit (de editor
-- toont van een meervoudige uitvoering alleen het laatste resultaat) en bewaar
-- de uitkomst van PRE 6 en PRE 7: POST 6 en POST 7 vergelijken ermee.
--
-- MOMENT: PRE, migratie en POST direct na elkaar op een rustig moment (niemand
-- actief in BoekAssist). Plak bij de migratie `SET lock_timeout = '5s';` als
-- EERSTE REGEL in DEZELFDE uitvoering als het ongewijzigde migratiebestand;
-- een losse uitvoering gebruikt niet gegarandeerd dezelfde verbinding.
--
-- LET OP — gecombineerde uitrol: bevat PRE 4 een bewezen historische storno
-- (`waarvan_historische_storno` > 0), dan mag deze migratie NIET alleen worden
-- uitgevoerd. Volg dan supabase/rollout/20261018180000_refine_release_hold_for_settled_history/
-- uitvoerplan.md: PR 1, PR 2 en 20261018180000 in één uitvoering — anders
-- beschermt de vrijgave-hold die regel na een vrijgave niet.
--
-- STOP (niet migreren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1, PRE 2 of PRE 8 ergens `false` geeft;
--   • PRE 4 `stop = true` geeft (een bankboeking die niet de vorm van de
--     schrijver heeft, of een directe bankgroep zonder marker die geen bewezen
--     historische storno is — PRE 4b noemt welke en waarom);
--   • PRE 4 `stop_losse_uitrol = true` geeft en u deze migratie LOS wilt
--     uitvoeren: dan niet; alleen de gecombineerde uitrol (uitvoerplan.md)
--     verwacht precies `stop = false` met `stop_losse_uitrol = true`;
--   • PRE 11 `stop = true` geeft (een onbekende trigger op bank_transactions);
--   • een query een foutmelding geeft.
-- PRE 3, PRE 4b, PRE 5, PRE 9 en PRE 10 zijn informatief (PRE 4b licht PRE 4 toe).
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, PR 1 nog niet ────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
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
  -- 20261017120000 (PR 0) moet aantoonbaar zijn toegepast: drie guards, ingeschakeld.
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
                                                                          AS pr1_nog_afwezig;


-- ── PRE 2. De acht PR H-functies en de drie PR 0-guards: exact beoordeeld ──
-- Verwacht: 11 rijen, `gelijk` overal `true`.
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
ORDER BY h.naam;


-- ── PRE 3. Omvang (informatief) ─────────────────────────────────────────────
-- `direct_geboekt_met_oude_factuurmatch`: direct geboekte regels die nog een
-- matched_invoice_id dragen (meestal een achtergebleven suggestie).
-- Herclassificeren laat die match staan; vrijgeven weigert ze (22023), want
-- het zou de match wissen zonder de factuur te herrekenen.
-- `waarvan_factuur_niet_meer_volledig_open`: daarvan de regels waarvan de
-- gematchte factuur betaald of deels betaald is (of niet bestaat) — mogelijk
-- een echte oudere koppeling; voor de eigenaar ter beoordeling.
-- `gematcht_zonder_koppelingsrij`: herclassificeren weigert die (22023).
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
  (SELECT count(*) FROM public.ledger_reversal_postings)     AS tegenboekingen;


-- ── PRE 4. Vorm van de bestaande directe bankboekingen (STOP-controle) ──────
-- De correctie-RPC leest het origineel als de schrijver het maakte: één regel
-- aan de bankzijde (het bruto), aan de tegenzijde netto (+ BTW), alle regels
-- van deze transactie, op de markerdatum, en die markerdatum is de
-- transactiedatum (de RPC stort op de transactiedatum). Een afwijkende groep kan de RPC
-- niet veilig corrigeren.
-- Een directe bankgroep zónder marker breekt de lineage-aanname — behalve een
-- BEWEZEN historische storno (zie PRE 4b voor elk bewijsstuk): dezelfde
-- transactie, precies één storno via de reversalketen die elke regel omkeert,
-- origineel en storno op de transactiedatum, per grootboekrekening neutraal,
-- de storno niet zelf tegengeboekt, en daarna een nieuwe boeking die nu de
-- actieve marker draagt. Alleen een eerdere datum of het ontbreken van een
-- marker is nooit genoeg.
-- Verwacht: afwijkende_vorm = 0 en waarvan_onverklaard = 0, stop = false.
-- `stop_losse_uitrol` is ook waar zodra er een directe bankgroep zonder marker
-- is — ook een bewezen historische storno: dan NIET deze migratie los
-- uitvoeren, maar alleen de gecombineerde uitrol (zie de kop).
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
      -- (1) dezelfde banktransactie (die bestaat nog)
      bt.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
                  AND (o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM k.tx))
      -- (2) de reversalketen
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
      -- (3) de juiste datum
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id) AND x.posting_date <> bt.transaction_date)
      AND r.posting_date = bt.transaction_date AND r.original_posting_date = bt.transaction_date
      -- (4) neutraal per grootboekrekening
      AND NOT EXISTS (SELECT x.grootboekrekening_id FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                      GROUP BY x.grootboekrekening_id HAVING sum(x.debit_amount - x.credit_amount) <> 0)
      -- (5) de storno is niet zelf tegengeboekt
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2 WHERE r2.original_posting_group_id = r.reversal_posting_group_id)
      -- (7) gevolgd door een nieuwe boeking, die (9) de actieve marker draagt
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
  -- Ook elke bewezen historische storno: dan mag PR 1 NIET los worden uitgevoerd.
  EXISTS (SELECT 1 FROM shape
          WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
             OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)
  OR EXISTS (SELECT 1 FROM kandidaat)                                      AS stop_losse_uitrol,
  EXISTS (SELECT 1 FROM shape
          WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
             OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)
  OR EXISTS (SELECT 1 FROM bewijs b WHERE NOT b.bewezen)                   AS stop;


-- ── PRE 4b. Elke directe bankgroep zonder marker, met elk bewijsstuk ─────────
-- Eén rij per groep (per transactie). `bewezen` = alle bewijsstukken waar.
-- `toestand` zegt wat ermee moet. Geen rijen is ook goed.
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
ORDER BY f.transaction_date, f.tx, f.groepsdatum;


-- ── PRE 5. Handmatig tegengeboekte directe boekingen (S2, informatief) ──────
-- Na PR 1 kunnen deze via "Opnieuw boeken" worden herboekt, zonder tweede
-- storno — maar alleen als de storno op de transactiedatum staat
-- (`herboekbaar_via_rpc`). Bij een latere stornodatum weigert de RPC (22023):
-- dan is een memoriaalboeking nodig; de eigenaar beslist.
SELECT m.bank_transaction_id, bt.transaction_date, bt.amount, m.posting_group_id, r.reversal_posting_group_id,
       r.posting_date AS tegenboekingsdatum, r.posting_date = bt.transaction_date AS herboekbaar_via_rpc, r.reason
FROM public.bank_transaction_postings m
JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = m.posting_group_id
ORDER BY bt.transaction_date, m.bank_transaction_id
LIMIT 200;


-- ── PRE 6. Nulmeting van de data ────────────────────────────────────────────
-- Bewaar deze uitkomst; POST 6 moet er letterlijk gelijk aan zijn.
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
FROM public.ledger_reversal_postings t;


-- ── PRE 7. Nulmeting van de catalogus ───────────────────────────────────────
-- Bewaar deze uitkomst; POST 7 noemt per kolom de verwachte verandering.
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
     'validate_bank_allocation_not_released_trigger'))                                                 AS bestaande_triggers_digest;


-- ── PRE 8. De editorrol kan dit uitvoeren zoals de schrijvers (STOP-controle) ──
-- De nieuwe functies krijgen de editorrol als eigenaar (SECURITY DEFINER: zij
-- lezen en schrijven onder die rol); ALTER TABLE … ENABLE ALWAYS TRIGGER vereist
-- het eigenaarschap van de tabel. Verwacht: elke booleaanse kolom `true`.
-- `serverversie` is informatief: POST vergelijkt gedeparste definities
-- (triggers, constraints, index), beoordeeld op PostgreSQL 16; noteer de versie
-- zodat een eventuele afwijking in POST direct te duiden is.
SELECT
  current_user AS editorrol,
  current_setting('server_version') AS serverversie,
  current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
                  WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure)            AS eigenaar_van_de_schrijvers,
  current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transactions'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_postings'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_allocations'::regclass)
                                                                                           AS eigenaar_van_de_tabellen;


-- ── PRE 9. Tenantconsistentie (informatief, verwacht 0) ─────────────────────
-- De RPC's weigeren een banktransactie waarvan de administratie bij een andere
-- organisatie hoort (42501); zo'n regel is daarna alleen niet corrigeerbaar.
SELECT count(*) AS transacties_met_afwijkende_tenant
FROM public.bank_transactions bt
JOIN public.clients c ON c.id = bt.client_id
WHERE bt.organization_id IS DISTINCT FROM c.organization_id;


-- ── PRE 10. Bestaande triggers op de vier banktabellen ──────────────────────
-- `bekend` = de trigger staat in de keten die het harnas toepast. Een onbekende
-- trigger op bank_transactions is een STOP (PRE 11): een BEFORE UPDATE-trigger
-- die na de hold codering zet, zou de hold omzeilen.
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
ORDER BY c.relname, t.tgname;


-- ── PRE 11. Onbekende triggers op bank_transactions (STOP-controle) ─────────
-- Verwacht: onbekend = 0, stop = false. Onbekend op de andere drie tabellen is
-- informatief (PRE 10).
SELECT count(*) AS onbekend, count(*) > 0 AS stop
FROM pg_trigger t
WHERE NOT t.tgisinternal
  AND t.tgrelid = 'public.bank_transactions'::regclass
  AND t.tgname NOT IN ('prevent_org_user_rebind_trg', 'prevent_posted_bank_transaction_mutation_trigger',
                       'set_organization_id_trigger', 'update_bank_transactions_updated_at');
