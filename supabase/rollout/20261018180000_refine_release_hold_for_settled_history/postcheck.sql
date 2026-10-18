-- ═════════════════════════════════════════════════════════════════════════════
-- POST C — leescontroles ná de gecombineerde uitrol (PR 1 + PR 2 +
-- 20261018180000), of ná 20261018180000 alleen.
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- hetzelfde editortabblad als de PRE, ná de POST van PR 1 en die van PR 2.
-- Alles hieronder is ALLEEN LEZEN: er wordt niets getest door te schrijven —
-- geen testdata in productie. Dat de hold werkt, is bewezen in
-- supabase/tests/bank-release-hold-history/; hier wordt bewezen dat productie
-- exact die functies draagt, dat de historische storno als zodanig herkend
-- wordt, en dat verder niets veranderde.
--
-- Bij ELKE afwijking: STOP, niets herstellen, uitkomst doorgeven. De rollback
-- (rollback.sql in deze map) vraagt akkoord van de eigenaar.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST C1. De hulpfunctie: exact, alleen lezen, alleen voor de eigenaar ───
-- Verwacht: één rij, elke kolom `true`.
SELECT
  coalesce(md5(p.prosrc) = '9e4593fcda07e2994459a7d3ac440ce6', false)                    AS lichaam_exact,
  coalesce(p.provolatile = 's', false)                                                    AS stable,
  coalesce(NOT p.prosecdef, false)                                                        AS geen_security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql'), false)       AS taal_sql,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)')), false) AS eigenaar_als_schrijver,
  p.oid IS NOT NULL
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',          p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role',  p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_dicht
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)');


-- ── POST C2. De hold: exact het lichaam van 20261018180000, veilig ──────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  coalesce(md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2', false)                    AS lichaam_exact,
  coalesce(p.prosecdef, false)                                                            AS security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.provolatile = 'v', false)                                                    AS volatile,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)')), false) AS eigenaar_als_schrijver,
  p.oid IS NOT NULL
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',          p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role',  p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_dicht,
  coalesce(obj_description(p.oid, 'pg_proc') LIKE '%schakelt die hold niet uit%', false)  AS commentaar_bijgewerkt
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()');


-- ── POST C3. De hold-trigger: ongewijzigd en ENABLE ALWAYS ──────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  coalesce(pg_get_triggerdef(t.oid) =
    'CREATE TRIGGER enforce_bank_transaction_release_hold_trigger BEFORE DELETE OR UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_release_hold()', false) AS definitie_exact,
  coalesce(t.tgenabled = 'A', false)                                                      AS enable_always,
  coalesce(t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()'), false) AS juiste_functie
FROM pg_trigger t
WHERE t.tgrelid = 'public.bank_transactions'::regclass AND t.tgname = 'enforce_bank_transaction_release_hold_trigger';


-- ── POST C4. De historische storno wordt als zodanig herkend ────────────────
-- Per directe bankgroep zonder marker: het oordeel van de hulpfunctie (die de
-- hold gebruikt). Verwacht: één rij voor de bekende groep
-- fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a met `bewezen_historisch` = true en
-- `vervangen` = false. Direct na de uitrol zijn er nog geen gebeurtenissen;
-- elke andere rij is STOP.
SELECT k.tx AS banktransactie, k.grp AS groep,
       EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = k.grp) AS vervangen,
       public.bank_transaction_group_is_settled_history(k.tx, k.grp)                                           AS bewezen_historisch,
       k.grp = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'                                                          AS bekend
FROM (SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
      FROM public.ledger_postings lp
      WHERE lp.source_type = 'bank_transaction'
        AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                        WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)) k
ORDER BY k.tx, k.grp;


-- ── POST C5. D12 dekt de regel na een vrijgave ──────────────────────────────
-- Voor elke banktransactie met een bewezen historische storno: zou de hold
-- gelden als haar actuele groep wordt vrijgegeven? Dat is zo als elke ándere
-- directe bankgroep al vervangen is of een bewezen historische storno is.
-- Alleen lezen: er wordt niets vrijgegeven. Verwacht: één rij (de bekende
-- banktransactie) met `hold_dekt_na_vrijgave` = true.
SELECT m.bank_transaction_id AS banktransactie, m.posting_group_id AS actuele_groep,
       NOT EXISTS (
         SELECT 1 FROM public.ledger_postings lp
         WHERE lp.source_type = 'bank_transaction' AND lp.source_id = m.bank_transaction_id
           AND lp.posting_group_id <> m.posting_group_id
           AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                           WHERE e.superseded_posting_group_id = lp.posting_group_id)
           AND NOT public.bank_transaction_group_is_settled_history(m.bank_transaction_id, lp.posting_group_id)) AS hold_dekt_na_vrijgave
FROM public.bank_transaction_postings m
WHERE EXISTS (SELECT 1 FROM public.ledger_postings lp2
              WHERE lp2.source_type = 'bank_transaction' AND lp2.source_id = m.bank_transaction_id
                AND lp2.posting_group_id <> m.posting_group_id
                AND public.bank_transaction_group_is_settled_history(m.bank_transaction_id, lp2.posting_group_id))
ORDER BY 1;


-- ── POST C6. Verder niets veranderd ─────────────────────────────────────────
-- Dezelfde kolommen als PRE B8. Verwacht na de gecombineerde uitrol:
-- banktransacties, bankomschrijvingen_md5, grootboekregels en grootboektekst_md5
-- letterlijk gelijk aan PRE B8; functies_public = PRE B8 + 11; triggers = PRE B8 + 9.
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers;
