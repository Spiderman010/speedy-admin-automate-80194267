-- BEWIJS NÁ PR 0 (20261017120000). Throwaway database only.
--
-- Draait direct na het TWEE keer toepassen van de migratie. Nummering:
--   M*  de migratie zelf: niets anders aangeraakt, vorm, rechten
--   A*  dezelfde vier aanvallen als N1–N4 in pre.sql — nu geweigerd
--   G1–G10  de verplichte scenario's 1–10
--   G11+    idempotentie, isolatie en wat moet blijven werken

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ── M: de migratie raakte niets anders aan ──────────────────────────────────

SELECT proof.expect_true('M1', 'de migratie (twee keer toegepast) liet alle data byte-gelijk',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_pr0') $$);

SELECT proof.expect_true('M2', 'precies drie nieuwe functies, verder geen enkele functie bij of weg', $$
  (SELECT array_agg(f ORDER BY f) FROM (
     SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     EXCEPT
     SELECT unnest(string_to_array((SELECT value FROM proof.state WHERE key = 'functions_before_pr0'), ';'))) x)
  = ARRAY['enforce_bank_allocation_not_directly_posted()',
          'enforce_bank_allocation_posting_not_directly_posted()',
          'enforce_bank_direct_posting_without_allocations()']
  AND NOT EXISTS (
     SELECT unnest(string_to_array((SELECT value FROM proof.state WHERE key = 'functions_before_pr0'), ';'))
     EXCEPT
     SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public')
$$);

SELECT proof.expect_true('M3', 'precies drie nieuwe triggers (ingeschakeld als O), elke bestaande trigger ongewijzigd', $$
  (SELECT array_agg(f ORDER BY f) FROM (
     SELECT c.relname || '.' || t.tgname || ':' || t.tgenabled::text AS f
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     EXCEPT
     SELECT unnest(string_to_array((SELECT value FROM proof.state WHERE key = 'triggers_before_pr0'), ';'))) x)
  = ARRAY['bank_allocation_postings.validate_bank_allocation_posting_not_directly_posted_trigger:O',
          'bank_transaction_allocations.validate_bank_allocation_not_directly_posted_trigger:O',
          'bank_transaction_postings.validate_bank_direct_posting_without_allocations_trigger:O']
  AND NOT EXISTS (
     SELECT unnest(string_to_array((SELECT value FROM proof.state WHERE key = 'triggers_before_pr0'), ';'))
     EXCEPT
     SELECT c.relname || '.' || t.tgname || ':' || t.tgenabled::text
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal)
$$);

SELECT proof.expect_true('M4', 'tabelrechten byte-gelijk: geen enkel nieuw recht op een tabel', $$
  (SELECT md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.relname))
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p'))
  = (SELECT value FROM proof.state WHERE key = 'acl_before_pr0')
$$);

SELECT proof.expect_true('M5', 'de acht PR H-functies hebben exact hun PR H-lichaam (md5 van prosrc)', $$
  (SELECT bool_and(md5(p.prosrc) = h.na) AND count(*) = 8
   FROM (VALUES
     ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
     ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
     ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
     ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
     ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
     ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
     ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
     ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb')) h(naam, na)
   JOIN pg_proc p ON p.proname = h.naam
   JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public')
$$);

SELECT proof.expect_true('M6', 'elke guard: SECURITY DEFINER, search_path=public, VOLATILE, eigenaar = eigenaar van de schrijvers', $$
  (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=public'] AND p.provolatile = 'v'
                   AND p.proowner = (SELECT proowner FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure))
          AND count(*) = 3
   FROM pg_proc p
   WHERE p.oid IN ('public.enforce_bank_allocation_not_directly_posted()'::regprocedure,
                   'public.enforce_bank_allocation_posting_not_directly_posted()'::regprocedure,
                   'public.enforce_bank_direct_posting_without_allocations()'::regprocedure))
$$);

SELECT proof.expect_true('M7', 'geen EXECUTE voor PUBLIC, anon, authenticated of service_role op een guard', $$
  (SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND p.proacl IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
          AND count(*) = 3
   FROM pg_proc p
   WHERE p.oid IN ('public.enforce_bank_allocation_not_directly_posted()'::regprocedure,
                   'public.enforce_bank_allocation_posting_not_directly_posted()'::regprocedure,
                   'public.enforce_bank_direct_posting_without_allocations()'::regprocedure))
$$);

SELECT proof.expect_true('M8', 'triggervorm: guard 1 AFTER per rij op INSERT en UPDATE OF bank_transaction_id; guards 2 en 3 BEFORE per rij op INSERT', $$
  pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'validate_bank_allocation_not_directly_posted_trigger'))
    = 'CREATE TRIGGER validate_bank_allocation_not_directly_posted_trigger AFTER INSERT OR UPDATE OF bank_transaction_id ON public.bank_transaction_allocations FOR EACH ROW EXECUTE FUNCTION enforce_bank_allocation_not_directly_posted()'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'validate_bank_allocation_posting_not_directly_posted_trigger'))
    = 'CREATE TRIGGER validate_bank_allocation_posting_not_directly_posted_trigger BEFORE INSERT ON public.bank_allocation_postings FOR EACH ROW EXECUTE FUNCTION enforce_bank_allocation_posting_not_directly_posted()'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'validate_bank_direct_posting_without_allocations_trigger'))
    = 'CREATE TRIGGER validate_bank_direct_posting_without_allocations_trigger BEFORE INSERT ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION enforce_bank_direct_posting_without_allocations()'
$$);

-- ── A: dezelfde aanvallen als vóór PR 0 — nu geweigerd, niets achtergelaten ─

INSERT INTO proof.state VALUES ('digest_before_A', proof.digest());

SELECT proof.record('A1', 'dezelfde aanval als N1 (direct, dan koppeling INSERTen) wordt geweigerd',
  o LIKE 'geweigerd [23514] Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling%', o)
FROM proof.attack('insert', proof.uid(1000, 1), proof.uid(2000, 1)) o;

SELECT proof.record('A2', 'dezelfde aanval als N2 (koppeling verplaatsen) wordt geweigerd',
  o LIKE 'geweigerd [23514] Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling%', o)
FROM proof.attack('repoint', proof.uid(1000, 2), proof.uid(2000, 2), proof.uid(1000, 3)) o;

SELECT proof.record('A3', 'dezelfde Facturen-volgorde als N3 strandt op de eerste schrijfactie (de koppeling)',
  o LIKE 'geweigerd [23514] Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling%', o)
FROM proof.attack('facturen', proof.uid(1000, 4), proof.uid(2000, 4)) o;

SELECT proof.record('A4', 'dezelfde Verkoop-volgorde als N4 strandt op de eerste schrijfactie (de koppeling)',
  o LIKE 'geweigerd [23514] Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling%', o)
FROM proof.attack('verkoop', proof.uid(1000, 5), proof.uid(3000, 5)) o;

SELECT proof.expect_true('A5', 'de geweigerde aanvallen lieten niets achter',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_A') $$);

-- ── G1: direct geboekte transactie → koppeling INSERT geweigerd ─────────────

SELECT proof.tx(10, -60.00), proof.purchase(10, 60.00);
SELECT proof.post_direct(proof.uid(1000, 10));

SELECT proof.expect_error('G1', 'scenario 1: een koppeling INSERTen op een direct geboekte transactie wordt geweigerd (ook als eigenaar)',
  $$ SELECT proof.alloc(10, proof.uid(1000, 10), 'inkoop', proof.uid(2000, 10), 60.00) $$,
  '23514', 'al rechtstreeks in het grootboek geboekt; een factuurkoppeling zou haar dubbel boeken');

-- ── G2: koppeling met UPDATE naar een direct geboekte transactie ────────────

SELECT proof.tx(11, -60.00), proof.purchase(11, 60.00);
SELECT proof.alloc(11, proof.uid(1000, 11), 'inkoop', proof.uid(2000, 11), 60.00);

SELECT proof.expect_error('G2', 'scenario 2: een ongeboekte koppeling met UPDATE naar een direct geboekte transactie verplaatsen wordt geweigerd',
  $$ UPDATE public.bank_transaction_allocations SET bank_transaction_id = proof.uid(1000, 10) WHERE id = proof.uid(4000, 11) $$,
  '23514', 'al rechtstreeks in het grootboek geboekt');

SELECT proof.expect_true('G2b', 'en de koppeling staat nog op haar eigen transactie',
  $$ (SELECT bank_transaction_id FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 11)) = proof.uid(1000, 11) $$);

SELECT proof.expect_ok('G2c', 'een UPDATE die de koppeling niet verplaatst (alleen het bedrag) blijft toegestaan',
  $$ UPDATE public.bank_transaction_allocations SET amount = 55.00 WHERE id = proof.uid(4000, 11) $$);

SELECT proof.expect_ok('G2d', 'een upsert zoals de app die doet (bank_transaction_id in de SET-lijst, ongewijzigd) blijft toegestaan', $$
  INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
  VALUES (gen_random_uuid(), proof.uid(1000, 11), 'inkoop', proof.uid(2000, 11), '00000000-0000-0000-0000-0000000000c1', 60.00,
          '00000000-0000-0000-0000-0000000000e1')
  ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE
    SET amount = EXCLUDED.amount, bank_transaction_id = EXCLUDED.bank_transaction_id
$$);

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SELECT proof.expect_ok('G2e', 'de upsert van de app (bank_transaction_id in de SET-lijst) op de legacy-koppeling van een direct geboekte transactie blijft werken: geen verplaatsing, dus geen weigering', $$
  INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
  VALUES (gen_random_uuid(), proof.uid(1000, 9), 'inkoop', proof.uid(2000, 9), '00000000-0000-0000-0000-0000000000c1', 79.00,
          '00000000-0000-0000-0000-0000000000e1')
  ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE
    SET amount = EXCLUDED.amount, bank_transaction_id = EXCLUDED.bank_transaction_id,
        invoice_type = EXCLUDED.invoice_type, client_id = EXCLUDED.client_id, user_id = EXCLUDED.user_id
$$);
RESET ROLE;
SELECT proof.expect_true('G2f', 'en zij bleef dezelfde legacy-koppeling, met het nieuwe bedrag, nog steeds ongeboekt', $$
  (SELECT amount FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 9)) = 79.00
  AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 9)) = 1
  AND NOT EXISTS (SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = proof.uid(4000, 9)) $$);

-- ── G3: een al bestaande koppeling boeken terwijl de directe boeking bestaat ─

INSERT INTO proof.state VALUES ('digest_before_G3', proof.digest());

SELECT proof.expect_error('G3', 'scenario 3: de legacy-koppeling (vóór PR 0 aangemaakt) op een direct geboekte transactie kan niet worden geboekt',
  $$ SELECT proof.post_alloc(proof.uid(4000, 9)) $$,
  '23514', 'deze koppeling kan niet ook als aflettering worden geboekt');

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_error('G3b', 'ook niet door de assistent via de API (de route die de app gebruikt)',
  $$ SELECT public.post_bank_allocation(proof.uid(4000, 9)) $$,
  '23514', 'deze koppeling kan niet ook als aflettering worden geboekt');
RESET ROLE;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.expect_true('G3c', 'geen marker, geen grootboekregel, de bank nog steeds één keer geboekt',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_G3')
     AND proof.routes(proof.uid(1000, 9)) = 'direct' AND proof.bank_legs(proof.uid(1000, 9)) = 1 $$);

-- ── G4: bestaande koppeling → direct boeken geweigerd ───────────────────────

SELECT proof.tx(12, -50.00), proof.purchase(12, 50.00);
SELECT proof.alloc(12, proof.uid(1000, 12), 'inkoop', proof.uid(2000, 12), 50.00);
SELECT proof.tx(13, -50.00), proof.purchase(13, 50.00);
SELECT proof.alloc(13, proof.uid(1000, 13), 'inkoop', proof.uid(2000, 13), 50.00);
SELECT proof.post_alloc(proof.uid(4000, 13));

SELECT proof.expect_error('G4', 'scenario 4: een transactie met een (ongeboekte) koppeling direct boeken wordt geweigerd',
  $$ SELECT proof.post_direct(proof.uid(1000, 12)) $$, '22023', 'aan een factuur gekoppeld');
SELECT proof.expect_error('G4b', 'en met een geboekte koppeling ook',
  $$ SELECT proof.post_direct(proof.uid(1000, 13)) $$, '22023', 'aan een factuur gekoppeld');

-- Guard 3 los van de schrijver: zelfs de eigenaar kan de marker niet zetten.
SELECT proof.expect_error('G4c', 'guard 3: een directe marker voor een transactie met koppeling wordt geweigerd, ook voor de eigenaar', $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (proof.uid(1000, 12), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 50.00, 50.00, 0, '00000000-0000-0000-0000-0000000000e1')
$$, '23514', 'aan een factuur gekoppeld; zij kan niet ook rechtstreeks');
SELECT proof.expect_error('G4d', 'guard 3: en voor een transactie met geboekte aflettering eerst die reden', $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (proof.uid(1000, 13), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 50.00, 50.00, 0, '00000000-0000-0000-0000-0000000000e1')
$$, '23514', 'heeft een geboekte aflettering');

-- ── G5: de bulkboeking ──────────────────────────────────────────────────────

SELECT proof.tx(14, -20.00);

CREATE TABLE proof.bulk_result AS
SELECT * FROM public.post_bank_transactions_bulk(ARRAY[proof.uid(1000, 12), proof.uid(1000, 13), proof.uid(1000, 14)]);

SELECT proof.expect_true('G5', 'scenario 5: de bulk boekt de schone transactie en weigert de twee gekoppelde, met de reden van de schrijver', $$
  (SELECT array_agg(outcome || ':' || coalesce(error_code, '') ORDER BY ordinal) FROM proof.bulk_result)
  = ARRAY['rejected:22023', 'rejected:22023', 'posted:']
$$);
SELECT proof.expect_true('G5b', 'na de bulk: 12 ongeboekt, 13 alleen via de aflettering, 14 alleen direct', $$
  proof.routes(proof.uid(1000, 12)) = 'none' AND proof.routes(proof.uid(1000, 13)) = 'allocation'
  AND proof.routes(proof.uid(1000, 14)) = 'direct'
$$);

-- ── G6: meerdere geldige koppelingen en deelbetalingen blijven mogelijk ─────

SELECT proof.tx(15, -300.00), proof.purchase(150, 100.00), proof.purchase(151, 200.00);
SELECT proof.alloc(150, proof.uid(1000, 15), 'inkoop', proof.uid(2000, 150), 100.00);
SELECT proof.alloc(151, proof.uid(1000, 15), 'inkoop', proof.uid(2000, 151), 200.00);
SELECT proof.expect_ok('G6', 'scenario 6: twee koppelingen op één ongeboekte transactie, beide geboekt', $$
  SELECT proof.post_alloc(proof.uid(4000, 150)), proof.post_alloc(proof.uid(4000, 151)) $$);
SELECT proof.expect_true('G6b', 'twee afletteringen, samen exact het transactiebedrag op de bank, geen directe boeking', $$
  proof.routes(proof.uid(1000, 15)) = 'allocation' AND proof.bank_legs(proof.uid(1000, 15)) = 2
  AND proof.bank_net(proof.uid(1000, 15)) = -300.00 $$);

-- Deelbetalingen: één verkoopfactuur van 150, betaald in twee transacties.
SELECT proof.tx(16, 50.00), proof.tx(17, 100.00), proof.sales(16, 150.00);
SELECT proof.alloc(160, proof.uid(1000, 16), 'verkoop', proof.uid(3000, 16), 50.00);
SELECT proof.alloc(170, proof.uid(1000, 17), 'verkoop', proof.uid(3000, 16), 100.00);
SELECT proof.expect_ok('G6c', 'deelbetalingen: een verkoopfactuur afgeletterd over twee transacties', $$
  SELECT proof.post_alloc(proof.uid(4000, 160)), proof.post_alloc(proof.uid(4000, 170)) $$);
SELECT proof.expect_true('G6d', 'beide transacties staan één keer op de bank', $$
  proof.bank_net(proof.uid(1000, 16)) = 50.00 AND proof.bank_net(proof.uid(1000, 17)) = 100.00
  AND proof.bank_legs(proof.uid(1000, 16)) = 1 AND proof.bank_legs(proof.uid(1000, 17)) = 1 $$);

-- ── G7: tegenboeking van een geboekte koppeling — historie blijft ───────────

INSERT INTO proof.state
SELECT 'group_150', posting_group_id::text FROM public.bank_allocation_postings WHERE allocation_id = proof.uid(4000, 150);

SELECT proof.expect_ok('G7', 'scenario 7: de aflettering van koppeling 150 wordt tegengeboekt door de accountant', $$
  SELECT public.reverse_posting_group((SELECT value::uuid FROM proof.state WHERE key = 'group_150'),
                                      DATE '2027-03-31', 'Bewijs: tegenboeking van een aflettering') $$);

SELECT proof.expect_true('G7b', 'origineel, tegenboeking, tegenboekingsmarker en afletteringsmarker staan er allemaal nog; regel voor regel herleidbaar', $$
  (SELECT count(*) FROM public.ledger_postings WHERE posting_group_id = (SELECT value::uuid FROM proof.state WHERE key = 'group_150')) = 2
  AND (SELECT count(*) FROM public.ledger_postings lp
       WHERE lp.reversal_of_posting_id IN (SELECT id FROM public.ledger_postings
                                           WHERE posting_group_id = (SELECT value::uuid FROM proof.state WHERE key = 'group_150'))) = 2
  AND EXISTS (SELECT 1 FROM public.ledger_reversal_postings
              WHERE original_posting_group_id = (SELECT value::uuid FROM proof.state WHERE key = 'group_150'))
  AND EXISTS (SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = proof.uid(4000, 150))
  AND proof.bank_net(proof.uid(1000, 15)) = -200.00
$$);

SELECT proof.expect_error('G7c', 'na de tegenboeking kan de transactie nog steeds niet direct worden geboekt',
  $$ SELECT proof.post_direct(proof.uid(1000, 15)) $$, '22023', 'aan een factuur gekoppeld');

-- Bekende grens: een TEGENGEBOEKTE directe boeking houdt haar marker.
SELECT proof.tx(22, -35.00), proof.purchase(22, 35.00);
INSERT INTO proof.state
SELECT 'group_22', proof.post_direct(proof.uid(1000, 22))::text;
SELECT public.reverse_posting_group((SELECT value::uuid FROM proof.state WHERE key = 'group_22'),
                                    DATE '2027-03-31', 'Bewijs: tegenboeking van een directe boeking');
SELECT proof.expect_error('G7d', 'bekende grens: ook na tegenboeking van de directe boeking blijft koppelen geweigerd, met een melding die dat zegt',
  $$ SELECT proof.alloc(22, proof.uid(1000, 22), 'inkoop', proof.uid(2000, 22), 35.00) $$,
  '23514', 'ook als die directe boeking is tegengeboekt');
SELECT proof.expect_true('G7e', 'de bank netto 0 (boeking en tegenboeking), geen koppeling, de marker blijft', $$
  proof.bank_net(proof.uid(1000, 22)) = 0 AND proof.routes(proof.uid(1000, 22)) = 'direct'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 22)) $$);

-- ── G8: service_role en API-achtige aanroepen ───────────────────────────────

SET ROLE service_role;
SELECT proof.expect_error('G8', 'scenario 8: service_role (omzeilt RLS) wordt door guard 1 tegengehouden',
  $$ SELECT proof.alloc(80, proof.uid(1000, 10), 'inkoop', proof.uid(2000, 10), 60.00) $$,
  '23514', 'al rechtstreeks in het grootboek geboekt');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_error('G8b', 'de assistent via RLS (PostgREST-pad) wordt door guard 1 tegengehouden',
  $$ SELECT proof.alloc(81, proof.uid(1000, 10), 'inkoop', proof.uid(2000, 10), 60.00) $$,
  '23514', 'al rechtstreeks in het grootboek geboekt');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e4', false);
SELECT proof.expect_error('G8c', 'een lezer krijgt de RLS-weigering, niet de guardmelding: de guard is geen autorisatiegrens en verraadt niets',
  $$ SELECT proof.alloc(82, proof.uid(1000, 10), 'inkoop', proof.uid(2000, 10), 60.00) $$,
  '42501', 'row-level security');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);
SELECT proof.expect_error('G8e', 'een buitenstaander (andere organisatie) die het id kent, krijgt evenmin te zien dat de transactie direct geboekt is',
  $$ SELECT proof.alloc(83, proof.uid(1000, 10), 'inkoop', proof.uid(2000, 10), 60.00) $$,
  '42501', 'row-level security');
RESET ROLE;

SELECT proof.tx(18, -70.00), proof.purchase(18, 70.00);
SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_ok('G8d', 'de assistent kan via RLS gewoon een koppeling op een ongeboekte transactie maken',
  $$ SELECT proof.alloc(18, proof.uid(1000, 18), 'inkoop', proof.uid(2000, 18), 70.00) $$);
RESET ROLE;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- Tenantconsistentie: een buitenstaander stuurt zijn EIGEN organisatie mee
-- (RLS toetst alleen die), plus de juiste transactie, eigenaar en administratie.
SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);
SELECT proof.expect_error('G8f', 'buitenstaander met eigen organisatie op een direct geboekte transactie: neutrale weigering', $$
  INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount, user_id)
  VALUES (proof.uid(1000, 10), 'inkoop', gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-00000000a002', 10.00, '00000000-0000-0000-0000-0000000000e1') $$,
  '42501', 'Banktransactie niet beschikbaar');
SELECT proof.expect_error('G8g', 'en op een NIET geboekte transactie exact dezelfde weigering (geen orakel, en geen koppeling op andermans transactie)', $$
  INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount, user_id)
  VALUES (proof.uid(1000, 18), 'inkoop', gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-00000000a002', 10.00, '00000000-0000-0000-0000-0000000000e1') $$,
  '42501', 'Banktransactie niet beschikbaar');
RESET ROLE;
SELECT proof.expect_true('G8g2', 'G8f en G8g gaven letterlijk dezelfde melding', $$
  (SELECT count(DISTINCT detail) FROM proof.result WHERE n IN ('G8f', 'G8g')) = 1 $$);

SELECT proof.tx(23, -15.00), proof.purchase(23, 15.00);
SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SELECT proof.expect_ok('G8h', 'een legitieme rij met de juiste organisatie expliciet meegestuurd blijft toegestaan', $$
  INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount, user_id)
  VALUES (proof.uid(1000, 23), 'inkoop', proof.uid(2000, 23), '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-00000000a001', 15.00, '00000000-0000-0000-0000-0000000000e1') $$);
RESET ROLE;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ── G9: directe marker-INSERT zonder recht ──────────────────────────────────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SELECT proof.expect_error('G9', 'scenario 9: authenticated mag geen directe marker invoegen (recht, vóór elke guard)', $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (proof.uid(1000, 18), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 70.00, 70.00, 0, '00000000-0000-0000-0000-0000000000e1')
$$, '42501', 'permission denied for table bank_transaction_postings');
SELECT proof.expect_error('G9b', 'en geen afletteringsmarker', $$
  INSERT INTO public.bank_allocation_postings (allocation_id, posting_group_id, organization_id, client_id,
    bank_transaction_id, invoice_id, invoice_type, amount, user_id)
  VALUES (proof.uid(4000, 18), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    proof.uid(1000, 18), proof.uid(2000, 18), 'inkoop', 70.00, '00000000-0000-0000-0000-0000000000e1')
$$, '42501', 'permission denied for table bank_allocation_postings');
RESET ROLE;

SET ROLE service_role;
SELECT proof.expect_error('G9c', 'service_role evenmin (alleen SELECT op de markers)', $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (proof.uid(1000, 18), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 70.00, 70.00, 0, '00000000-0000-0000-0000-0000000000e1')
$$, '42501', 'permission denied for table bank_transaction_postings');
RESET ROLE;

SELECT proof.expect_error('G9d', 'guard 2: een afletteringsmarker die naar een andere transactie wijst dan haar koppeling, wordt geweigerd (eigenaar)', $$
  INSERT INTO public.bank_allocation_postings (allocation_id, posting_group_id, organization_id, client_id,
    bank_transaction_id, invoice_id, invoice_type, amount, user_id)
  VALUES (proof.uid(4000, 18), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    proof.uid(1000, 12), proof.uid(2000, 18), 'inkoop', 70.00, '00000000-0000-0000-0000-0000000000e1')
$$, '23514', 'bij de banktransactie van haar eigen koppeling horen');

-- ── G10: de schrijfvolgorde van Facturen en Verkoop ─────────────────────────

SELECT proof.tx(19, -45.00), proof.purchase(19, 45.00);
SELECT proof.post_direct(proof.uid(1000, 19));
INSERT INTO proof.state VALUES ('digest_before_G10', proof.digest());

SET ROLE authenticated;
-- Als de eigenaar van de transactie, zoals de app (user_id = auth.uid()).
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
-- Stap 1 van Facturen.tsx (upsertAllocation). De app wacht op deze aanroep en
-- gaat bij een fout niet verder naar stap 2 (restbedrag) en 3 (banktransactie).
SELECT proof.expect_error('G10', 'scenario 10: de eerste schrijfactie van Facturen (koppeling-upsert) wordt al geweigerd', $$
  INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
  VALUES (proof.uid(1000, 19), 'inkoop', proof.uid(2000, 19), '00000000-0000-0000-0000-0000000000c1', 45.00,
          '00000000-0000-0000-0000-0000000000e1')
  ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount
$$, '23514', 'al rechtstreeks in het grootboek geboekt');
RESET ROLE;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.expect_true('G10b', 'er is niets geschreven: geen koppeling, factuur en transactie ongewijzigd',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_G10') $$);

-- ── G11+: idempotentie, isolatie en wat moet blijven werken ─────────────────

SELECT proof.expect_error('G11', 'idempotentie ongewijzigd: een tweede directe boeking geeft nog steeds 23505',
  $$ SELECT proof.post_direct(proof.uid(1000, 14)) $$, '23505', 'al geboekt');
SELECT proof.expect_error('G11b', 'en een tweede aflettering van dezelfde koppeling ook',
  $$ SELECT proof.post_alloc(proof.uid(4000, 151)) $$, '23505', 'al geboekt');

SELECT proof.expect_ok('G12', 'een gewone wijziging van een direct geboekte transactie (omschrijving) blijft toegestaan',
  $$ UPDATE public.bank_transactions SET description = 'Bankregel 10 (omschrijving bijgewerkt)' WHERE id = proof.uid(1000, 10) $$);

SELECT proof.tx(20, -30.00), proof.purchase(20, 30.00);

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT proof.expect_error('G13', 'een koppeling INSERTen onder REPEATABLE READ wordt geweigerd (snapshot zou een nieuwe marker missen)',
  $$ SELECT proof.alloc(20, proof.uid(1000, 20), 'inkoop', proof.uid(2000, 20), 30.00) $$,
  '25000', 'alleen in een READ COMMITTED transactie');
COMMIT;

BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT proof.expect_error('G13b', 'en onder SERIALIZABLE ook',
  $$ SELECT proof.alloc(20, proof.uid(1000, 20), 'inkoop', proof.uid(2000, 20), 30.00) $$,
  '25000', 'alleen in een READ COMMITTED transactie');
COMMIT;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT proof.expect_ok('G13c', 'een bedragwijziging zonder verplaatsing mag onder elk niveau',
  $$ UPDATE public.bank_transaction_allocations SET amount = 69.00 WHERE id = proof.uid(4000, 18) $$);
COMMIT;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT proof.expect_error('G13d', 'een directe marker vastleggen onder REPEATABLE READ wordt geweigerd (guard 3), ook voor de eigenaar', $$
  INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES (proof.uid(1000, 20), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f006', DATE '2027-03-01', 2027, 30.00, 30.00, 0, '00000000-0000-0000-0000-0000000000e1')
$$, '25000', 'alleen in een READ COMMITTED transactie');
COMMIT;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT proof.expect_error('G13e', 'een afletteringsmarker vastleggen onder REPEATABLE READ wordt geweigerd (guard 2), ook voor de eigenaar', $$
  INSERT INTO public.bank_allocation_postings (allocation_id, posting_group_id, organization_id, client_id,
    bank_transaction_id, invoice_id, invoice_type, amount, user_id)
  VALUES (proof.uid(4000, 18), gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
    proof.uid(1000, 18), proof.uid(2000, 18), 'inkoop', 69.00, '00000000-0000-0000-0000-0000000000e1')
$$, '25000', 'alleen in een READ COMMITTED transactie');
COMMIT;

SELECT proof.expect_ok('G14', 'een koppeling op een ongeboekte transactie maken en boeken werkt gewoon (READ COMMITTED)', $$
  SELECT proof.alloc(20, proof.uid(1000, 20), 'inkoop', proof.uid(2000, 20), 30.00),
         proof.post_alloc(proof.uid(4000, 20)) $$);
SELECT proof.expect_ok('G14b', 'en een transactie zonder koppelingen direct boeken ook', $$
  SELECT proof.tx(21, -10.00), proof.post_direct(proof.uid(1000, 21)) $$);
