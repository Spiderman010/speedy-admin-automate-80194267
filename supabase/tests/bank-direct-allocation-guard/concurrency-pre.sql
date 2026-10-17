-- NEGATIEVE CONTROLE ONDER GELIJKTIJDIGHEID — VÓÓR PR 0. Throwaway database only.
--
-- Twee echte sessies ('a' en 'b', via dblink); deze psql-sessie regisseert.
--   NC1  A boekt een transactie direct en houdt haar vast; B maakt intussen een
--        koppeling en boekt die. B wacht (op de foreign key), maar slaagt zodra
--        A commit: de bank staat twee keer geboekt. B draait daarna terug, zodat
--        de database schoon blijft.
--   NC2  Een vóór PR 0 al bestaande deadlock: twee sessies maken elk een
--        koppeling op dezelfde transactie (beide nemen KEY SHARE via de foreign
--        key) en boeken die daarna (beide willen FOR UPDATE). PostgreSQL breekt
--        er één af met 40P01; er blijft niets half staan. concurrency.sql laat
--        zien dat PR 0 hier niets aan verandert.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.tx(110, -25.00), proof.purchase(110, 25.00);
SELECT proof.tx(111, -60.00), proof.purchase(1110, 30.00), proof.purchase(1111, 30.00);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

-- ── NC1 ─────────────────────────────────────────────────────────────────────
SELECT dblink_exec('a', 'BEGIN');
SELECT proof.remote_run('a', $$SELECT proof.post_direct(proof.uid(1000, 110))::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.alloc(110, proof.uid(1000, 110), 'inkoop', proof.uid(2000, 110), 25.00)::text
                                    || ' / ' || proof.post_alloc(proof.uid(4000, 110))::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('NC1a', 'zonder PR 0: B wacht op A (de foreign key neemt KEY SHARE)', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
SELECT proof.record('NC1b', 'zonder PR 0: na A''s commit slaagt B gewoon — koppeling gemaakt én geboekt', o LIKE 'ok: %', o)
FROM proof.remote_outcome('b') o;
SELECT proof.record('NC1c', 'zonder PR 0: binnen B staat de bank nu twee keer geboekt', o = 'ok: 2', o)
FROM proof.remote_run('b', $$SELECT proof.bank_legs(proof.uid(1000, 110))::text$$) o;
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('NC1d', 'na B''s rollback is alleen de directe boeking over', $$
  proof.routes(proof.uid(1000, 110)) = 'direct' AND proof.bank_legs(proof.uid(1000, 110)) = 1
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 110)) $$);

-- ── NC2 ─────────────────────────────────────────────────────────────────────
SELECT dblink_exec('a', 'BEGIN');
SELECT proof.remote_run('a', $$SELECT proof.alloc(1110, proof.uid(1000, 111), 'inkoop', proof.uid(2000, 1110), 30.00)::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT proof.remote_run('b', $$SELECT proof.alloc(1111, proof.uid(1000, 111), 'inkoop', proof.uid(2000, 1111), 30.00)::text$$);
SELECT dblink_send_query('a', $$SELECT proof.post_alloc(proof.uid(4000, 1110))::text$$);
SELECT pg_sleep(0.3);
SELECT dblink_send_query('b', $$SELECT proof.post_alloc(proof.uid(4000, 1111))::text$$);
SELECT pg_sleep(2.5);
CREATE TABLE proof.nc2 AS SELECT proof.remote_outcome('a') AS a, proof.remote_outcome('b') AS b;
SELECT dblink_exec('a', 'COMMIT');
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.record('NC2a', 'zonder PR 0 bestaat de deadlock al: precies één sessie krijgt 40P01, de ander boekt',
  ((a LIKE 'fout [40P01]%') <> (b LIKE 'fout [40P01]%')) AND (a LIKE 'ok: %' OR b LIKE 'ok: %'),
  format('a = %s | b = %s', left(a, 60), left(b, 60)))
FROM proof.nc2;
SELECT proof.expect_true('NC2b', 'en er blijft niets half staan: één koppeling, één keer op de bank', $$
  (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 111)) = 1
  AND proof.routes(proof.uid(1000, 111)) = 'allocation' AND proof.bank_legs(proof.uid(1000, 111)) = 1 $$);

SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');
