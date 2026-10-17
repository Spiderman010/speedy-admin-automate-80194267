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
--   C6  paden buiten de schrijvers: een eigenaar die markers zelf schrijft.
--       Directe marker ↔ koppeling + afletteringsmarker, in drie volgordes.
--   C7  guard 2 leest de koppeling FOR SHARE: verplaatsen tijdens het zetten
--       van haar afletteringsmarker wacht en wordt daarna geweigerd.
--
-- Grendelvolgorde (alle paden): koppeling → banktransactie → factuur →
-- administratiegrendel. Guard 1 neemt KEY SHARE op de banktransactie (zoals de
-- foreign key); guards 2 en 3 nemen FOR UPDATE, wat de schrijvers al houden.

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

-- ── C6: paden buiten de schrijvers (eigenaar/onderhoud schrijft markers zelf) ─
-- Guards 2 en 3 nemen FOR UPDATE; daardoor kunnen een directe marker en een
-- koppeling + afletteringsmarker elkaar ook buiten de schrijvers niet missen.
-- (Markers zonder grootboekregels: hier gaat het om de markerinvariant.)
CREATE FUNCTION proof.raw_direct_marker(_tx uuid)
RETURNS text LANGUAGE sql AS $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (_tx, gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 40.00, 40.00, 0, '00000000-0000-0000-0000-0000000000e1')
  RETURNING 'direct';
$$;
CREATE FUNCTION proof.raw_alloc_marker(_alloc uuid)
RETURNS text LANGUAGE sql AS $$
  INSERT INTO public.bank_allocation_postings (allocation_id, posting_group_id, organization_id, client_id,
    bank_transaction_id, invoice_id, invoice_type, amount, user_id)
  SELECT a.id, gen_random_uuid(), a.organization_id, a.client_id, a.bank_transaction_id, a.invoice_id,
         a.invoice_type, a.amount, a.user_id
  FROM public.bank_transaction_allocations a WHERE a.id = _alloc
  RETURNING 'aflettering';
$$;
GRANT EXECUTE ON FUNCTION proof.raw_direct_marker(uuid), proof.raw_alloc_marker(uuid) TO public;

SELECT proof.tx(161, -40.00), proof.purchase(161, 40.00);
SELECT proof.tx(162, -40.00), proof.purchase(162, 40.00);
SELECT proof.tx(163, -40.00), proof.purchase(163, 40.00);

-- C6a: directe marker eerst; koppeling + afletteringsmarker wacht, dan geweigerd.
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C6a', proof.remote_run('a', $$SELECT proof.raw_direct_marker(proof.uid(1000, 161))$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.alloc(161, proof.uid(1000, 161), 'inkoop', proof.uid(2000, 161), 40.00)::text
                                    || ' / ' || proof.raw_alloc_marker(proof.uid(4000, 161))$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C6a', 'C6 buiten de schrijvers, directe marker eerst: koppeling + afletteringsmarker wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C6a';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C6b', 'en wordt daarna geweigerd',
  b LIKE 'fout [23514] Deze banktransactie is al rechtstreeks%', b) FROM proof.race WHERE n = 'C6a';
SELECT proof.expect_true('C6c', 'alleen de directe marker, geen koppeling', $$
  proof.routes(proof.uid(1000, 161)) = 'direct'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 161)) $$);

-- C6d: koppeling + afletteringsmarker eerst; directe marker wacht, dan geweigerd.
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C6d', proof.remote_run('a',
  $$SELECT proof.alloc(162, proof.uid(1000, 162), 'inkoop', proof.uid(2000, 162), 40.00)::text
           || ' / ' || proof.raw_alloc_marker(proof.uid(4000, 162))$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.raw_direct_marker(proof.uid(1000, 162))$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C6d', 'C6 buiten de schrijvers, afletteringsmarker eerst: de directe marker wacht', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C6d';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C6e', 'en wordt daarna geweigerd',
  b LIKE 'fout [23514] Deze banktransactie heeft een geboekte aflettering%', b) FROM proof.race WHERE n = 'C6d';
SELECT proof.expect_true('C6f', 'alleen de afletteringsmarker', $$ proof.routes(proof.uid(1000, 162)) = 'allocation' $$);

-- C6g: koppeling eerst (KEY SHARE), directe marker wacht, dan pas de
-- afletteringsmarker in de eerste transactie (opwaardering naar FOR UPDATE op
-- een eigen grendel). De eerste slaagt, de directe marker wordt geweigerd.
SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C6g', proof.remote_run('a',
  $$SELECT proof.alloc(163, proof.uid(1000, 163), 'inkoop', proof.uid(2000, 163), 40.00)::text$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT proof.raw_direct_marker(proof.uid(1000, 163))$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C6g', 'C6 koppeling eerst: de directe marker wacht al op de KEY SHARE van de koppeling', dblink_is_busy('b') = 1);
UPDATE proof.race SET a = a || ' | ' || proof.remote_run('a', $$SELECT proof.raw_alloc_marker(proof.uid(4000, 163))$$) WHERE n = 'C6g';
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C6g';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C6h', 'de eerste transactie boekt haar aflettering (opwaardering zonder deadlock), de directe marker wordt geweigerd',
  a LIKE 'ok: % | ok: aflettering' AND b LIKE 'fout [23514] Deze banktransactie heeft een geboekte aflettering%',
  format('a = %s | b = %s', a, left(b, 70))) FROM proof.race WHERE n = 'C6g';
SELECT proof.expect_true('C6i', 'nergens beide markers, en geen deadlock of time-out in C6', $$
  proof.routes(proof.uid(1000, 163)) = 'allocation'
  AND NOT EXISTS (SELECT 1 FROM proof.race WHERE n LIKE 'C6%'
                  AND (a NOT LIKE 'ok: %' OR b LIKE 'fout [40P01]%' OR b LIKE 'fout [57014]%' OR b LIKE 'fout [55P03]%')) $$);

-- ── C7: guard 2 leest de koppeling FOR SHARE ────────────────────────────────
-- Terwijl haar afletteringsmarker wordt gezet, kan de koppeling niet naar een
-- andere transactie worden verplaatst: de verplaatsing wacht en wordt daarna
-- door de bestaande bevriezing geweigerd. Vandaag dwingt de foreign key van de
-- marker naar de koppeling dit ook al af (verplaatsen raakt een unieke index en
-- vraagt FOR UPDATE); C7 legt het gedrag vast, los van welke grendel het draagt.
SELECT proof.tx(171, -40.00), proof.tx(1711, -40.00), proof.purchase(171, 40.00);
SELECT proof.alloc(171, proof.uid(1000, 171), 'inkoop', proof.uid(2000, 171), 40.00);

SELECT dblink_exec('a', 'BEGIN');
INSERT INTO proof.race (n, a) SELECT 'C7a', proof.remote_run('a', $$SELECT proof.raw_alloc_marker(proof.uid(4000, 171))$$);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$UPDATE public.bank_transaction_allocations SET bank_transaction_id = proof.uid(1000, 1711)
                                 WHERE id = proof.uid(4000, 171) RETURNING id::text$$);
SELECT pg_sleep(0.5);
SELECT proof.record('C7a', 'C7 afletteringsmarker eerst: het verplaatsen van die koppeling wacht (FOR SHARE)', dblink_is_busy('b') = 1);
SELECT dblink_exec('a', 'COMMIT');
UPDATE proof.race SET b = proof.remote_outcome('b') WHERE n = 'C7a';
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.record('C7b', 'en wordt daarna door de bevriezing van een geboekte koppeling geweigerd',
  b LIKE 'fout [42501] Deze bankkoppeling is geboekt%', b) FROM proof.race WHERE n = 'C7a';
SELECT proof.expect_true('C7c', 'koppeling en afletteringsmarker wijzen naar dezelfde transactie', $$
  (SELECT bank_transaction_id FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 171)) = proof.uid(1000, 171)
  AND (SELECT bank_transaction_id FROM public.bank_allocation_postings WHERE allocation_id = proof.uid(4000, 171)) = proof.uid(1000, 171) $$);

SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');
