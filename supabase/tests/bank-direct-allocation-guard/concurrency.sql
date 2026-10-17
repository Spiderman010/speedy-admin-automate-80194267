-- GELIJKTIJDIGHEID NÁ PR 0 — twee echte sessies. Throwaway database only.
--
-- Drie races, elk in beide volgordes. Per race:
--   • de tweede sessie WACHT op de eerste (de grendel is het serialisatiepunt);
--   • precies één boekingsroute wint, de ander krijgt een gerichte weigering;
--   • geen 40P01, geen time-out, geen gedeeltelijke boeking, één bankmutatie.
--   C1  koppeling INSERT     ↔ directe boeking
--   C2  koppeling UPDATE     ↔ directe boeking   (verplaatsen naar de transactie)
--   C3  aflettering boeken   ↔ directe boeking   (koppeling + boeken in één transactie)
--   C4  de vooraf bestaande deadlock uit NC2: met PR 0 identiek — één 40P01,
--       niets half — want guard 1 neemt dezelfde KEY SHARE als de foreign key.
--
-- Grendelvolgorde (alle paden): koppeling → banktransactie → factuur →
-- administratiegrendel. Guard 1 neemt alleen KEY SHARE op de banktransactie
-- (zoals de foreign key); guards 2 en 3 nemen binnen de schrijvers niets nieuws.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.tx(101, -25.00), proof.purchase(101, 25.00);
SELECT proof.tx(102, -25.00), proof.purchase(102, 25.00);
SELECT proof.tx(103, -25.00), proof.tx(1031, -25.00), proof.purchase(103, 25.00);
SELECT proof.alloc(103, proof.uid(1000, 1031), 'inkoop', proof.uid(2000, 103), 25.00);
SELECT proof.tx(104, -25.00), proof.tx(1041, -25.00), proof.purchase(104, 25.00);
SELECT proof.alloc(104, proof.uid(1000, 1041), 'inkoop', proof.uid(2000, 104), 25.00);
SELECT proof.tx(105, -25.00), proof.purchase(105, 25.00);
SELECT proof.tx(106, -25.00), proof.purchase(106, 25.00);
SELECT proof.tx(108, -60.00), proof.purchase(1080, 30.00), proof.purchase(1081, 30.00);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

CREATE TABLE proof.race (n text PRIMARY KEY, a text, b text);

-- ── C1a: directe boeking eerst, koppeling INSERT wacht en wordt geweigerd ───
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C1a', proof.remote_run('a', $$SELECT proof.post_direct(proof.uid(1000, 101))::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.alloc(101, proof.uid(1000, 101), 'inkoop', proof.uid(2000, 101), 25.00)::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C1a', 'C1 directe boeking eerst: de koppeling-INSERT wacht op de grendel', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C1a';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C1b', 'en wordt na de commit door guard 1 geweigerd',
  b LIKE 'fout [23514] Deze banktransactie is al rechtstreeks%', b) FROM proof.race WHERE n = 'C1a';
SELECT proof.expect_true('C1c', 'één route (direct), één bankmutatie, geen koppeling', $$
  proof.routes(proof.uid(1000, 101)) = 'direct' AND proof.bank_legs(proof.uid(1000, 101)) = 1
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 101)) $$);

-- ── C1d: koppeling INSERT eerst, directe boeking wacht en wordt geweigerd ───
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C1d', proof.remote_run('a', $$SELECT proof.alloc(102, proof.uid(1000, 102), 'inkoop', proof.uid(2000, 102), 25.00)::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.post_direct(proof.uid(1000, 102))::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C1d', 'C1 koppeling eerst: de directe boeking wacht op de grendel', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C1d';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C1e', 'en wordt na de commit door de schrijver geweigerd (koppeling gezien)',
  b LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld%', b) FROM proof.race WHERE n = 'C1d';
SELECT proof.expect_true('C1f', 'geen directe boeking, de koppeling staat', $$
  proof.routes(proof.uid(1000, 102)) = 'none'
  AND EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 102)) $$);

-- ── C2a: directe boeking eerst, koppeling-UPDATE wacht en wordt geweigerd ───
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C2a', proof.remote_run('a', $$SELECT proof.post_direct(proof.uid(1000, 103))::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$UPDATE public.bank_transaction_allocations SET bank_transaction_id = proof.uid(1000, 103)
                                 WHERE id = proof.uid(4000, 103) RETURNING id::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C2a', 'C2 directe boeking eerst: het verplaatsen van de koppeling wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C2a';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C2b', 'en wordt na de commit door guard 1 geweigerd',
  b LIKE 'fout [23514] Deze banktransactie is al rechtstreeks%', b) FROM proof.race WHERE n = 'C2a';
SELECT proof.expect_true('C2c', 'de koppeling staat nog op haar eigen transactie; de doeltransactie alleen direct', $$
  (SELECT bank_transaction_id FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 103)) = proof.uid(1000, 1031)
  AND proof.routes(proof.uid(1000, 103)) = 'direct' AND proof.bank_legs(proof.uid(1000, 103)) = 1 $$);

-- ── C2d: koppeling-UPDATE eerst, directe boeking wacht en wordt geweigerd ───
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C2d', proof.remote_run('a', $$UPDATE public.bank_transaction_allocations
  SET bank_transaction_id = proof.uid(1000, 104) WHERE id = proof.uid(4000, 104) RETURNING id::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.post_direct(proof.uid(1000, 104))::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C2d', 'C2 verplaatsen eerst: de directe boeking wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C2d';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C2e', 'en wordt na de commit door de schrijver geweigerd',
  b LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld%', b) FROM proof.race WHERE n = 'C2d';
SELECT proof.expect_true('C2f', 'de koppeling staat op de doeltransactie, die niet direct geboekt is', $$
  (SELECT bank_transaction_id FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 104)) = proof.uid(1000, 104)
  AND proof.routes(proof.uid(1000, 104)) = 'none' $$);

-- ── C3a: koppeling + aflettering boeken eerst, directe boeking geweigerd ────
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C3a', proof.remote_run('a',
  $$SELECT proof.alloc(105, proof.uid(1000, 105), 'inkoop', proof.uid(2000, 105), 25.00)::text
           || ' / ' || proof.post_alloc(proof.uid(4000, 105))::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.post_direct(proof.uid(1000, 105))::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C3a', 'C3 aflettering eerst: de directe boeking wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C3a';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C3b', 'en wordt na de commit geweigerd',
  b LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld%', b) FROM proof.race WHERE n = 'C3a';
SELECT proof.expect_true('C3c', 'alleen de aflettering, één bankmutatie', $$
  proof.routes(proof.uid(1000, 105)) = 'allocation' AND proof.bank_legs(proof.uid(1000, 105)) = 1 $$);

-- ── C3d: directe boeking eerst, koppeling + aflettering geweigerd ───────────
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C3d', proof.remote_run('a', $$SELECT proof.post_direct(proof.uid(1000, 106))::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.alloc(106, proof.uid(1000, 106), 'inkoop', proof.uid(2000, 106), 25.00)::text
                                    || ' / ' || proof.post_alloc(proof.uid(4000, 106))::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C3d', 'C3 directe boeking eerst: koppeling + aflettering wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C3d';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C3e', 'en strandt al op de koppeling (guard 1), vóór de aflettering',
  b LIKE 'fout [23514] Deze banktransactie is al rechtstreeks%', b) FROM proof.race WHERE n = 'C3d';
SELECT proof.expect_true('C3f', 'alleen de directe boeking, één bankmutatie, geen koppeling', $$
  proof.routes(proof.uid(1000, 106)) = 'direct' AND proof.bank_legs(proof.uid(1000, 106)) = 1
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 106)) $$);

SELECT proof.expect_true('C5', 'in C1–C3 heeft geen enkele sessie een deadlock, time-out of onverwachte fout gekregen', $$
  NOT EXISTS (SELECT 1 FROM proof.race
              WHERE a NOT LIKE 'ok: %'
                 OR b LIKE 'fout [40P01]%' OR b LIKE 'fout [57014]%' OR b LIKE 'fout [55P03]%'
                 OR (b NOT LIKE 'fout [23514]%' AND b NOT LIKE 'fout [22023]%')) $$);

-- ── C4: de vooraf bestaande deadlock (NC2), nu met PR 0 ─────────────────────
SELECT dblink_exec('a', 'BEGIN');
SELECT proof.remote_run('a', $$SELECT proof.alloc(1080, proof.uid(1000, 108), 'inkoop', proof.uid(2000, 1080), 30.00)::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT proof.remote_run('b', $$SELECT proof.alloc(1081, proof.uid(1000, 108), 'inkoop', proof.uid(2000, 1081), 30.00)::text$$);
SELECT dblink_send_query('a', $$SELECT proof.post_alloc(proof.uid(4000, 1080))::text$$);
SELECT pg_sleep(0.3);
SELECT dblink_send_query('b', $$SELECT proof.post_alloc(proof.uid(4000, 1081))::text$$);
SELECT pg_sleep(2.5);
CREATE TABLE proof.c4 AS SELECT proof.remote_outcome('a') AS a, proof.remote_outcome('b') AS b;
SELECT dblink_exec('a', 'COMMIT');
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.record('C4', 'gedocumenteerde 40P01 (bestond al zonder PR 0, zie NC2): precies één sessie afgebroken, de ander boekt',
  ((a LIKE 'fout [40P01]%') <> (b LIKE 'fout [40P01]%')) AND (a LIKE 'ok: %' OR b LIKE 'ok: %'),
  format('a = %s | b = %s', left(a, 60), left(b, 60)))
FROM proof.c4;
SELECT proof.expect_true('C4b', 'en er blijft niets half staan: één koppeling, één keer op de bank', $$
  (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 108)) = 1
  AND proof.routes(proof.uid(1000, 108)) = 'allocation' AND proof.bank_legs(proof.uid(1000, 108)) = 1 $$);

SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');
