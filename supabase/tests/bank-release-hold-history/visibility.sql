-- Y — NIEMAND ZIET DE TUSSENTOESTAND. Throwaway database only (een kopie van database 3).
--
-- Sessie a voert uitvoering.sql uit als één opdracht, zoals de editor. Om
-- tussendoor te kunnen kijken, draait zij een kopie met één regel erbij: een
-- pg_sleep vlak vóór de fix, dus ná PR 1 en PR 2 — precies de tussentoestand
-- (c). run-proof.sh toetst dat die kopie verder byte-gelijk is.
--   Y1  in die tussentoestand ziet een andere sessie (c) niets van PR 1, PR 2 of de fix
--   Y2  een verzoek dat het oude gedrag zou benutten (sessie b haalt een marker
--       weg, wat vóór PR 1 kon) wacht op de grendel van a en wordt daarna met de
--       regels van PR 1 geweigerd — het draait nooit in de tussentoestand
--   Y3  a voltooit: 'gecombineerde uitrol voltooid'
--   Y4  daarna ziet iedereen alles tegelijk: de hold van de fix, de hulpfunctie, PR 2
-- Het pad naar de kopie staat in de omgevingsvariabele ZICHT_FILE.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['Y1','Y2','Y3','Y4']);

\set uitvoering `cat "$ZICHT_FILE"`

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');
SELECT proof.open_session('c', :'conn');

CREATE FUNCTION proof.y_seen(_conn text) RETURNS text LANGUAGE sql AS $$
  SELECT x FROM dblink(_conn, $q$SELECT concat_ws('|',
    to_regclass('public.bank_transaction_posting_events') IS NOT NULL,
    to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NOT NULL,
    coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.enforce_bank_transaction_release_hold()')), 'geen hold'),
    to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NOT NULL)$q$) AS t(x text);
$$;

/** Wacht (hooguit ~10 s) tot sessie _name in pg_sleep staat. */
CREATE FUNCTION proof.until_sleeping(_name text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i integer;
BEGIN
  FOR i IN 1..200 LOOP
    IF EXISTS (SELECT 1 FROM pg_stat_activity
               WHERE pid = proof.get('pid_' || _name)::integer AND wait_event = 'PgSleep') THEN
      RETURN true;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RETURN false;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- a start de ene opdracht (DO + de afsluitende SELECT) en staat straks stil na PR 2.
SELECT dblink_send_query('a', :'uitvoering');
SELECT proof.put('y_sleeping', proof.until_sleeping('a')::text);
SELECT proof.put('y_seen2', proof.y_seen('c'));

SELECT dblink_send_query('b', format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L RETURNING bank_transaction_id::text',
                                     proof.uid(1000, 41)));
SELECT proof.put('y_wait', proof.until_waiting('b'));

-- Twee uitkomsten van a: eerst die van de DO-opdracht, dan die van de SELECT.
SELECT proof.put('y_do', coalesce((SELECT x FROM dblink_get_result('a') AS t(x text)), 'geen uitkomst'));
SELECT proof.put('y_a', coalesce((SELECT concat_ws('|', u, h, g) FROM dblink_get_result('a') AS t(u text, h bigint, g bigint)), 'geen uitkomst'));
SELECT count(*) FROM dblink_get_result('a') AS t(x text);
SELECT proof.put('y_b', proof.remote_outcome('b'));
SELECT proof.put('y_seen3', proof.y_seen('c'));

SELECT proof.record('Y1', 'midden in de ene opdracht — PR 1 en PR 2 toegepast, de fix nog niet — ziet een andere sessie niets daarvan',
  proof.get('y_sleeping') = 'true' AND proof.get('y_seen2') = 'f|f|geen hold|f', proof.get('y_seen2'));

SELECT proof.record('Y2', 'een verzoek in die tussentijd wacht op de grendel en draait daarna onder de eindregels: de marker blijft (42501)',
  proof.get('y_wait') <> 'none' AND proof.get('y_b') LIKE 'fout [42501]%' AND proof.m(41) IS NOT NULL,
  concat_ws(' / ', proof.get('y_wait'), proof.get('y_b')));

SELECT proof.record('Y3', 'de opdracht voltooit', proof.get('y_do') = 'DO' AND proof.get('y_a') = 'gecombineerde uitrol voltooid|1|1',
  concat_ws(' / ', proof.get('y_do'), proof.get('y_a')));

SELECT proof.record('Y4', 'daarna ziet iedereen alles tegelijk: PR 1, PR 2 en de hold van de fix met de hulpfunctie',
  proof.get('y_seen3') = 't|t|43347fb9f48ed4c161e291fa769577c2|t', proof.get('y_seen3'));

SELECT dblink_disconnect('a'), dblink_disconnect('b'), dblink_disconnect('c');
