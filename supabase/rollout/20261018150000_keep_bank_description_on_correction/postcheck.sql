-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles ná 20261018150000_keep_bank_description_on_correction.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- hetzelfde editortabblad als de PRE. Alles hieronder is ALLEEN LEZEN; er wordt
-- niets getest door te schrijven — geen testdata in productie. Dat de
-- bankomschrijving behouden blijft, is bewezen in
-- supabase/tests/bank-correction-booking-description/; hier wordt bewezen dat
-- productie exact die functie draagt en dat verder niets veranderde.
--
-- Bij ELKE afwijking: STOP, niets herstellen, uitkomst doorgeven. De rollback
-- (rollback.sql in deze map) vraagt akkoord van de eigenaar.
--
-- GECOMBINEERDE UITROL (PR 1 + PR 2 + 20261018180000 in één uitvoering, zie
-- supabase/rollout/20261018180000_refine_release_hold_for_settled_history/uitvoerplan.md):
-- dan draagt enforce_bank_transaction_release_hold het lichaam van
-- 20261018180000; POST 2 en POST 3 erkennen dat expliciet (`versie`). POST 4
-- vergelijkt dan met PRE B8 van 20261018180000 (dezelfde kolommen, zonder de
-- gebeurtenissen): de datakolommen gelijk, `gebeurtenissen` = 0,
-- `functies_public` + 11 en `triggers` + 9 (PR 1 en de hulpfunctie).
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. reclassify_bank_transaction: exact het PR 2-lichaam, veilig ─────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  coalesce(md5(p.prosrc) = '067939e0c44a672c26ec8883717ef6d2', false)                    AS lichaam_exact,
  coalesce(p.prosecdef, false)                                                            AS security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.provolatile = 'v', false)                                                    AS volatile,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure), false) AS eigenaar_als_schrijver,
  coalesce(pg_get_function_result(p.oid) = 'TABLE(outcome text, replayed boolean, posting_group_id uuid, superseded_posting_group_id uuid, reversal_posting_group_id uuid, event_id uuid)', false)
                                                                                          AS uitkomsttype_gelijk,
  p.oid IS NOT NULL
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',         p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_exact,
  coalesce(obj_description(p.oid, 'pg_proc') LIKE '%bank_transactions.description blijft na elke correctie byte-gelijk%', false)
                                                                                          AS commentaar_bijgewerkt
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)');


-- ── POST 2. Alle andere functies van PR 1 en de schrijver: ongewijzigd ──────
-- Verwacht: 10 rijen, `gelijk` overal `true`.
SELECT h.naam,
       coalesce(md5(p.prosrc) = h.verwacht
                OR (h.naam = 'enforce_bank_transaction_release_hold' AND md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2'), false) AS gelijk,
       CASE WHEN md5(p.prosrc) = h.verwacht THEN 'beoordeeld'
            WHEN h.naam = 'enforce_bank_transaction_release_hold' AND md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
            ELSE 'ONBEKEND' END AS versie
FROM (VALUES
  ('post_bank_transaction',                            '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('release_bank_transaction_posting',                 '2c3a2e8b93292336ea319fa512b7e09b'),
  ('return_bank_transaction_to_workflow',              '5334092758eb40def4c58a97403c841c'),
  ('enforce_bank_allocation_not_released',             '42dc33ad0be7438a99c66cd666145a11'),
  ('enforce_bank_transaction_posting_event',           '66128cecc40974265cebad258752650b'),
  ('enforce_bank_transaction_posting_marker_delete',   '864dd9bf71ba88b267519dfe6e1e7ffe'),
  ('enforce_bank_transaction_posting_marker_lineage',  'b0c9006afaf0772080159ab24e1d7053'),
  ('enforce_bank_transaction_release_hold',            '812d151a7041cdd48b7a784cd193a159'),
  ('prevent_bank_transaction_posting_event_mutation',  'fc27ac341d6b72c0a20afb2b306393f7'),
  ('prevent_bank_transaction_posting_marker_mutation', '3fe50540a21d6daffd9b0ea98324a8aa')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── POST 3. De triggers op bank_transactions: dezelfde vijf als in PRE 3 ────
-- Verwacht: 5 rijen, `bekend` overal `true`.
WITH bekend(tgname, functie, md5, ingeschakeld) AS (VALUES
  ('enforce_bank_transaction_release_hold_trigger',    'enforce_bank_transaction_release_hold',    '812d151a7041cdd48b7a784cd193a159', 'A'),
  ('prevent_org_user_rebind_trg',                      'prevent_org_user_rebind',                  '9d75d3c98a66f0fc0299b795ee40461e', 'O'),
  ('prevent_posted_bank_transaction_mutation_trigger', 'prevent_posted_bank_transaction_mutation', 'a6437536b1942e78d5b072f22fe6a842', 'O'),
  ('set_organization_id_trigger',                      'set_organization_id',                      'e56450399d8f95c5ed42fd2df04bed06', 'O'),
  ('update_bank_transactions_updated_at',              'update_updated_at_column',                 '301a884953d37769916294bb60562e05', 'O')),
actueel AS (
  SELECT t.tgname::text AS tgname, p.proname::text AS functie, md5(p.prosrc) AS md5, t.tgenabled::text AS ingeschakeld
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal)
SELECT coalesce(a.tgname, b.tgname) AS tgname,
       (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
        AND a.functie = b.functie AND a.ingeschakeld = b.ingeschakeld
        AND (a.md5 = b.md5 OR (a.functie = 'enforce_bank_transaction_release_hold' AND a.md5 = '43347fb9f48ed4c161e291fa769577c2'))) AS bekend,
       CASE WHEN a.md5 = b.md5 THEN 'beoordeeld'
            WHEN a.functie = 'enforce_bank_transaction_release_hold' AND a.md5 = '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
            ELSE 'ONBEKEND' END AS versie
FROM actueel a FULL JOIN bekend b ON b.tgname = a.tgname
ORDER BY 1;


-- ── POST 4. Geen rij veranderd: exact dezelfde waarden als PRE 7 ────────────
-- Verwacht: elke kolom gelijk aan de uitkomst van PRE 7 (de migratie wijzigt
-- alleen een functielichaam; het aantal functies en triggers blijft gelijk).
-- Werd er tussen PRE en POST geïmporteerd of bewerkt, dan mogen de
-- datakolommen daardoor verschillen; `functies_public` en `triggers` niet.
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM public.bank_transaction_posting_events)                           AS gebeurtenissen,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers;
