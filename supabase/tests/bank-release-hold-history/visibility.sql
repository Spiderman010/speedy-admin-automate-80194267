-- Y — NIEMAND ZIET DE TUSSENTOESTAND. Throwaway database only (een kopie van database 3).
--
-- Sessie a voert uitvoering.sql uit als één transactie, in drie stukken
-- (kop + PR 1, PR 2, de fix + eindcontrole), zodat er tussendoor gekeken kan
-- worden. Dat is dezelfde transactie als één uitvoering in de editor: wat a
-- schrijft, is tot COMMIT voor niemand zichtbaar.
--   Y1  na PR 1 en na PR 2 ziet een andere sessie (c) niets van PR 1
--   Y2  een verzoek dat het oude gedrag zou benutten (sessie b haalt een marker
--       weg, wat vóór PR 1 kon) wacht op de grendel van a en wordt na COMMIT
--       met de regels van PR 1 geweigerd — het draait nooit tussen PR 1 en de fix
--   Y3  a voltooit: één transactie, 'gecombineerde uitrol voltooid'
--   Y4  daarna ziet iedereen alles tegelijk: de hold van de fix, de hulpfunctie, PR 2
-- :'chunk1', :'chunk2', :'chunk3' = uitvoering.sql, letterlijk, in drie stukken.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['Y1','Y2','Y3','Y4']);

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
GRANT EXECUTE ON FUNCTION proof.y_seen(text) TO public;

SELECT dblink_exec('a', 'BEGIN');
SELECT proof.put('y_c1', proof.remote_exec('a', :'chunk1'));
SELECT proof.put('y_seen1', proof.y_seen('c'));

SELECT dblink_send_query('b', format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L RETURNING bank_transaction_id::text',
                                     proof.uid(1000, 41)));
SELECT proof.put('y_wait', proof.until_waiting('b'));

SELECT proof.put('y_c2', proof.remote_exec('a', :'chunk2'));
SELECT proof.put('y_seen2', proof.y_seen('c'));

SELECT proof.put('y_c3', coalesce((SELECT concat_ws('|', u, g) FROM dblink('a', :'chunk3') AS t(u text, x text, g bigint)), 'geen uitkomst'));
SELECT proof.put('y_commit', proof.remote_exec('a', 'COMMIT'));
SELECT proof.put('y_b', proof.remote_outcome('b'));
SELECT proof.put('y_seen3', proof.y_seen('c'));

SELECT proof.record('Y1', 'tijdens de uitvoering — na PR 1 en na PR 2 — ziet een andere sessie niets van PR 1, PR 2 of de fix',
  proof.get('y_c1') = 'ok' AND proof.get('y_c2') = 'ok'
  AND proof.get('y_seen1') = 'f|f|geen hold|f' AND proof.get('y_seen2') = 'f|f|geen hold|f',
  concat_ws(' / ', proof.get('y_seen1'), proof.get('y_seen2')));

SELECT proof.record('Y2', 'een verzoek tijdens de uitvoering wacht op de grendel en draait daarna onder de eindregels: de marker blijft (42501)',
  proof.get('y_wait') <> 'none' AND proof.get('y_b') LIKE 'fout [42501]%' AND proof.m(41) IS NOT NULL,
  concat_ws(' / ', proof.get('y_wait'), proof.get('y_b')));

SELECT proof.record('Y3', 'de uitvoering voltooit als één transactie',
  proof.get('y_c3') = 'gecombineerde uitrol voltooid|0' AND proof.get('y_commit') = 'ok', proof.get('y_c3'));

SELECT proof.record('Y4', 'na COMMIT ziet iedereen alles tegelijk: PR 1, PR 2 en de hold van de fix met de hulpfunctie',
  proof.get('y_seen3') = 't|t|43347fb9f48ed4c161e291fa769577c2|t', proof.get('y_seen3'));

SELECT dblink_disconnect('a'), dblink_disconnect('b'), dblink_disconnect('c');
