-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261018150000_keep_bank_description_on_correction.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`
-- (projectref visueel bevestigd), ná 20261018120000 en diens POST. Alles
-- hieronder is ALLEEN LEZEN: elke opdracht is een SELECT.
--
-- STOP (niets uitvoeren, uitkomst doorgeven) als:
--   • PRE 1 of PRE 2 ergens `false` geeft;
--   • PRE 3, PRE 4 of PRE 5 `stop = true` geeft (een afwijkende trigger,
--     triggerfunctie of inschakeling op bank_transactions; een RULE; een
--     publicatie die bank_transactions uitzendt) — de migratie zou dan ook zelf
--     weigeren, maar dan is eerst een nieuwe beoordeling nodig;
--   • een query een foutmelding geeft.
-- PRE 6, PRE 7 en PRE 8 zijn informatief; bewaar de uitkomst van PRE 7 voor POST 4.
-- Voer PRE, migratie en POST direct na elkaar uit op een rustig moment: een
-- import of bewerking tussen PRE 7 en POST 4 laat die vingerafdruk verschillen
-- zonder dat de migratie iets wijzigde (functies en triggers tellen dan nog
-- steeds gelijk). Liefst in hetzelfde venster als 20261018120000 (PR 1), zodat
-- er geen correctie met omschrijving onder PR 1 kan plaatsvinden (PRE 8).
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. PR 1 staat er, exact beoordeeld; PR 2 nog niet ───────────────────
-- Verwacht: één rij, alle kolommen `true`.
SELECT
  to_regclass('public.bank_transaction_posting_events') IS NOT NULL                       AS gebeurtenistabel_pr1,
  coalesce((SELECT md5(prosrc) = 'a931207c1a4e97f06e7797ed105c0264' FROM pg_proc
            WHERE oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')), false)
                                                                                            AS reclassify_is_pr1,
  coalesce((SELECT md5(prosrc) <> '067939e0c44a672c26ec8883717ef6d2' FROM pg_proc
            WHERE oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')), false)
                                                                                            AS pr2_nog_afwezig,
  coalesce((SELECT proowner FROM pg_proc
            WHERE oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
           = (SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)')), false)
                                                                                            AS eigenaar_als_schrijver;


-- ── PRE 2. De schrijver en de twee andere RPC's van PR 1: exact beoordeeld ──
-- Verwacht: 3 rijen, `gelijk` overal `true`.
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht, coalesce(md5(p.prosrc) = h.verwacht, false) AS gelijk
FROM (VALUES
  ('post_bank_transaction',               '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('release_bank_transaction_posting',    '2c3a2e8b93292336ea319fa512b7e09b'),
  ('return_bank_transaction_to_workflow', '5334092758eb40def4c58a97403c841c')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── PRE 3. Precies de vijf beoordeelde triggers op bank_transactions ────────
-- Verwacht: 5 rijen, `bekend` overal `true`, `stop` overal `false`. Elke andere
-- trigger, een ander functielichaam of een andere inschakeling: STOP. (Dit is
-- wat de migratie zelf ook toetst: geen trigger mag de tijdelijke omschrijving
-- ergens anders wegschrijven.)
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
SELECT coalesce(a.tgname, b.tgname) AS tgname, a.functie, a.md5, a.ingeschakeld,
       (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
        AND a.functie = b.functie AND a.md5 = b.md5 AND a.ingeschakeld = b.ingeschakeld) AS bekend,
       NOT (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
            AND a.functie = b.functie AND a.md5 = b.md5 AND a.ingeschakeld = b.ingeschakeld) AS stop
FROM actueel a FULL JOIN bekend b ON b.tgname = a.tgname
ORDER BY 1;


-- ── PRE 4. Geen RULE op bank_transactions ───────────────────────────────────
-- Verwacht: één rij, `rules` = 0, `stop` = false.
SELECT count(*) AS rules, count(*) > 0 AS stop
FROM pg_rules WHERE schemaname = 'public' AND tablename = 'bank_transactions';


-- ── PRE 5. Geen publicatie die bank_transactions uitzendt ───────────────────
-- Verwacht: per publicatie (bv. supabase_realtime) `alle_tabellen` = false en
-- `zendt_bank_transactions_uit` = false, dus `stop` = false. Geen rijen is ook goed.
SELECT p.pubname, p.puballtables AS alle_tabellen,
       EXISTS (SELECT 1 FROM pg_publication_tables pt
               WHERE pt.pubname = p.pubname AND pt.schemaname = 'public' AND pt.tablename = 'bank_transactions') AS zendt_bank_transactions_uit,
       p.puballtables OR EXISTS (SELECT 1 FROM pg_publication_tables pt
               WHERE pt.pubname = p.pubname AND pt.schemaname = 'public' AND pt.tablename = 'bank_transactions') AS stop
FROM pg_publication p
ORDER BY p.pubname;


-- ── PRE 6. Omgeving (informatief) ───────────────────────────────────────────
SELECT current_user                                                         AS editorrol,
       pg_get_userbyid((SELECT proowner FROM pg_proc
                        WHERE oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)) AS eigenaar_rpc,
       pg_get_userbyid((SELECT proowner FROM pg_proc
                        WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure))  AS eigenaar_schrijver,
       current_setting('server_version')                                    AS serverversie,
       current_setting('wal_level')                                         AS wal_level,
       (SELECT string_agg(extname, ', ' ORDER BY extname) FROM pg_extension
        WHERE extname IN ('pgaudit', 'supa_audit', 'pg_net', 'pg_cron'))    AS relevante_extensies;


-- ── PRE 7. Vingerafdruk van de data (bewaar voor POST 4) ────────────────────
-- De migratie wijzigt geen enkele rij; POST 4 moet exact dezelfde waarden geven
-- (zie de kop: alleen als er tussendoor niets werd geïmporteerd of bewerkt).
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


-- ── PRE 8. Correcties met omschrijving onder PR 1 (informatief) ─────────────
-- Onder PR 1 schreef een correctie met omschrijving die tekst in de bankregel.
-- Verwacht: 0 rijen. Elke rij: meld haar aan de eigenaar — de geïmporteerde
-- bankomschrijving van die regel is dan overschreven en wordt door deze
-- migratie niet hersteld (bij CAMT-imports staat zij mogelijk nog in camt_*).
SELECT e.bank_transaction_id, e.event_type, e.created_at,
       e.requested_description,
       bt.description                                       AS bankomschrijving_nu,
       bt.description IS NOT DISTINCT FROM e.requested_description AS waarschijnlijk_overschreven,
       to_jsonb(bt) ->> 'camt_ustrd'                         AS camt_ustrd,
       to_jsonb(bt) ->> 'camt_addtl_ntry_inf'                AS camt_addtl_ntry_inf
FROM public.bank_transaction_posting_events e
JOIN public.bank_transactions bt ON bt.id = e.bank_transaction_id
WHERE e.request_kind = 'reclassify' AND e.requested_description IS NOT NULL
ORDER BY e.seq;
