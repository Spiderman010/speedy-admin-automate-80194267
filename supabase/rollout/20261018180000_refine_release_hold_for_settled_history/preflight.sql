-- ═════════════════════════════════════════════════════════════════════════════
-- PRE B — leescontroles vóór de GECOMBINEERDE uitrol van
--   20261018120000 (PR 1) + 20261018150000 (PR 2) + 20261018180000 (deze fix)
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`
-- (projectref visueel bevestigd; nooit het persoonlijke Supabase-dashboard,
-- nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv), ná de PRE van PR 1
-- (supabase/rollout/20261018120000_add_bank_transaction_corrections/preflight.sql)
-- en vóór de ene uitvoering met de drie migraties. Zie uitvoerplan.md.
-- Alles hieronder is ALLEEN LEZEN: elke opdracht is een SELECT, behalve de
-- SET LOCAL in PRE B9 (die geldt alleen binnen die ene uitvoering en wijzigt
-- niets). Voer de blokken één voor één uit en bewaar de uitkomst van PRE B8
-- voor de POST's.
--
-- STOP (niets uitvoeren, uitkomst doorgeven) als:
--   • PRE B1, B2 of B5 ergens `false` geeft;
--   • PRE B3, B4 of B6 `stop = true` geeft;
--   • PRE B7 actieve applicatiesessies toont (wacht, en voer B7 opnieuw uit);
--   • PRE B9 `een_transactie` = false geeft (de editor splitst een uitvoering);
--   • een query een foutmelding geeft.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE B1. Niets van PR 1, PR 2 of deze fix staat er al ────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regclass('public.bank_transaction_posting_events') IS NULL                                     AS geen_gebeurtenistabel,
  to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL AS geen_correctie_rpc,
  to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NULL                         AS geen_hold,
  to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL            AS geen_hulpfunctie,
  to_regprocedure('public.enforce_bank_direct_posting_without_allocations()') IS NOT NULL           AS pr0_toegepast;


-- ── PRE B2. De schrijver waarop PR 2 en deze fix steunen: exact beoordeeld ──
-- Verwacht: één rij, `gelijk` = true.
SELECT md5(p.prosrc) AS md5_productie, md5(p.prosrc) = '2369978c713ac78a0c039dd5c3e5eb4c' AS gelijk
FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)');


-- ── PRE B3. De vier bestaande triggers op bank_transactions ─────────────────
-- PR 1 voegt de hold-trigger toe; PR 2 eist daarna precies vijf triggers met
-- deze functielichamen. Verwacht: 4 rijen, `bekend` overal true, `stop` false.
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
ORDER BY 1;


-- ── PRE B4. Geen RULE en geen publicatie op bank_transactions ────────────────
-- (De voorwaarden van PR 2.) Verwacht: één rij, `stop` = false.
SELECT
  (SELECT count(*) FROM pg_rules WHERE schemaname = 'public' AND tablename = 'bank_transactions')  AS rules,
  (SELECT count(*) FROM pg_publication WHERE puballtables)                                          AS publicaties_alle_tabellen,
  (SELECT count(*) FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'bank_transactions') AS publicaties_bank_transactions,
  EXISTS (SELECT 1 FROM pg_rules WHERE schemaname = 'public' AND tablename = 'bank_transactions')
  OR EXISTS (SELECT 1 FROM pg_publication WHERE puballtables)
  OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'bank_transactions') AS stop;


-- ── PRE B5. De editorrol wordt eigenaar zoals de schrijver ──────────────────
-- De nieuwe functies krijgen de editorrol als eigenaar; PR 2 en deze fix eisen
-- dezelfde eigenaar als post_bank_transaction. Verwacht: `gelijk` = true.
SELECT current_user AS editorrol,
       pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)'))) AS eigenaar_schrijver,
       current_user = pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)'))) AS gelijk;


-- ── PRE B6. Precies de bekende historische storno — en niets onverklaards ───
-- Dezelfde bewijsstukken als PRE 4b van PR 1. De eigenaar heeft één
-- historische storno beoordeeld (banktransactie van 25-11-2025):
--   origineel fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a, storno ff598a0f-e4e3-4b82-968a-9666b54c5ad8,
--   actuele groep 0b1aec4c-1bd1-42f3-b392-6a6125da98e3.
-- Verwacht: bewezen = 1, onverklaard = 0, bekende_storno_bewezen = true,
-- andere_bewezen = 0, stop = false. Een tweede bewezen historische storno is
-- ook STOP: die is niet beoordeeld.
WITH kandidaat AS (
  SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
  FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)
), bewijs AS (
  SELECT k.tx, k.grp, r.reversal_posting_group_id AS storno, m.posting_group_id AS actuele_groep,
    coalesce(
      NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
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
  JOIN public.bank_transactions bt ON bt.id = k.tx
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
     WHERE b.bewezen AND b.grp <> 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a')                                       AS andere_bewezen
)
SELECT t.*, (t.onverklaard > 0 OR NOT t.bekende_storno_bewezen OR t.andere_bewezen > 0) AS stop
FROM telling t;


-- ── PRE B7. Geen lopende applicatieverzoeken (onderhoudsprotocol) ───────────
-- De drie migraties lopen als één transactie; gelijktijdige verzoeken zien de
-- tussentoestand nooit, maar kunnen de migratie laten wachten (lock_timeout).
-- Verwacht: 0 rijen (de app staat stil; PostgREST-verbindingen mogen 'idle' zijn).
SELECT a.pid, a.usename, a.application_name, a.state, a.xact_start, left(a.query, 80) AS query
FROM pg_stat_activity a
WHERE a.pid <> pg_backend_pid()
  AND a.backend_type = 'client backend'
  AND a.usename IN ('authenticator', 'authenticated', 'anon', 'service_role')
  AND a.state <> 'idle'
ORDER BY a.xact_start NULLS LAST;


-- ── PRE B8. Nulmeting (bewaar voor de POST's) ───────────────────────────────
-- Dezelfde kolommen als PRE 7 van PR 2, zonder de gebeurtenissen (die tabel
-- bestaat nog niet). POST 4 van PR 2 en POST C6 vergelijken ermee:
-- banktransacties, bankomschrijvingen_md5, grootboekregels en grootboektekst_md5
-- gelijk; functies_public + 11 en triggers + 9.
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers;


-- ── PRE B9. Proef: draait de editor één uitvoering als één transactie? ───────
-- Plak deze TWEE regels samen en voer ze in ÉÉN uitvoering uit. SET LOCAL
-- werkt alleen binnen een transactie en vervalt daarna vanzelf; er verandert
-- niets. uitvoering.sql steunt op precies dit gedrag (en weigert anders).
-- Verwacht: lock_timeout = 4321ms en een_transactie = true. Anders: STOP.
SET LOCAL lock_timeout = '4321ms';
SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('lock_timeout') = '4321ms' AS een_transactie;
