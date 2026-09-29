-- REAL POSTGRESQL PROOF for 6C-b11 PR H — deel 1, VÓÓR de migratie.
-- Run against a THROWAWAY local cluster only. See run-proof.sh.
--
-- Twee taken. (1) De negatieve controle: vandaag weigert het jaarwatermerk
-- een boeking in een afgesloten jaar zónder blokkade — precies het gedrag dat
-- de migratie moet veranderen; staat dit bewijs hier niet, dan bewijst het
-- tegendeel straks niets. (2) Momentopnamen van de catalogus en de
-- auditsporen, zodat deel 2 kan aantonen dat de migratie NIETS anders raakte.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ═══ N1-N4. DE NEGATIEVE CONTROLE: VANDAAG WEIGERT HET WATERMERK ════════════

DO $$
DECLARE
  v_c uuid := proof.pl_client('PR H — A: afgesloten jaar, geen blokkade');
BEGIN
  INSERT INTO proof.subject VALUES ('A', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;

SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 2025);

DO $$
DECLARE
  v_c   uuid;
  v_id  text;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'A';

  PERFORM proof.record('N0', 'uitgangspunt: boekjaar 2025 afgesloten, geen boekingsblokkade',
    proof.status(v_c, 2025) = 'closed' AND proof.watermark(v_c) = 2025 AND proof.lock_of(v_c) IS NULL,
    format('status=%s watermerk=%s blokkade=%s', proof.status(v_c, 2025), proof.watermark(v_c), proof.lock_of(v_c)));

  PERFORM proof.expect_error('N1', 'VÓÓR de migratie weigert het watermerk een memoriaal in het afgesloten jaar',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-01')),
    'is afgesloten voor deze administratie');

  PERFORM proof.expect_error('N2', 'en een directe bankboeking',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-06-02')),
    'is afgesloten voor deze administratie');

  PERFORM proof.record('N3', 'en er staat dus geen enkele nieuwe grootboekregel',
    (SELECT count(*) FROM public.ledger_postings WHERE client_id = v_c) = 2);

  SELECT workflow_state INTO v_id
  FROM public.bank_bulk_posting_candidates(v_c, 2025) LIMIT 1;
  PERFORM proof.record('N4', 'en de bulk-preflight noemt die bankregel geblokkeerd door het watermerk',
    v_id = 'blocked', format('%s', COALESCE(v_id, 'geen')));

  -- Identiteit van een tenant- en een rolweigering, om ná de migratie te
  -- vergelijken: die mogen niet veranderen.
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);
  PERFORM proof.snap_put('pre.identity.tenant',
    proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2026-03-01'))));
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
  PERFORM proof.snap_put('pre.identity.role',
    proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2026-03-02'))));
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

  PERFORM proof.record('N5', 'tenant- en rolweigering zijn vóór de migratie een 42501',
    proof.snap_get('pre.identity.tenant') LIKE '42501 |%' AND proof.snap_get('pre.identity.role') LIKE '42501 |%',
    format('tenant: %s | rol: %s', proof.snap_get('pre.identity.tenant'), proof.snap_get('pre.identity.role')));
END $$;

-- ═══ Momentopnamen — als ALLERLAATSTE, vlak vóór de migratie ═══════════════
--
-- Alles wat pre.sql zelf heeft aangemaakt zit hier al in; wat deel 2 nog
-- ziet veranderen, is dus van de migratie.

DO $$
DECLARE v_naam text;
BEGIN
  FOREACH v_naam IN ARRAY proof.changed_functions() || proof.untouched_functions() LOOP
    PERFORM proof.snap_put('pre.hash.' || v_naam, proof.hash(v_naam));
    PERFORM proof.snap_put('pre.acl.'  || v_naam, proof.acl(v_naam));
  END LOOP;
  PERFORM proof.snap_put('pre.functions', proof.function_set());
  PERFORM proof.snap_put('pre.digest.posting_lock_events', proof.table_digest('public.posting_lock_events'));
  PERFORM proof.snap_put('pre.digest.fiscal_year_events',  proof.table_digest('public.fiscal_year_events'));
  PERFORM proof.snap_put('pre.digest.year_closures',       proof.table_digest('public.year_closures'));
  PERFORM proof.snap_put('pre.digest.ledger_postings',     proof.table_digest('public.ledger_postings'));
  PERFORM proof.snap_put('pre.digest.clients',
    (SELECT COALESCE(md5(string_agg(format('%s:%s:%s', id, afgesloten_boekjaar, posting_locked_through), '|' ORDER BY id)), 'leeg')
     FROM public.clients));
  PERFORM proof.snap_put('pre.ledger_privs',
    format('auth:%s%s%s anon:%s svc:%s%s%s',
      has_table_privilege('authenticated', 'public.ledger_postings', 'INSERT'),
      has_table_privilege('authenticated', 'public.ledger_postings', 'UPDATE'),
      has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE'),
      has_table_privilege('anon', 'public.ledger_postings', 'SELECT'),
      has_table_privilege('service_role', 'public.ledger_postings', 'INSERT'),
      has_table_privilege('service_role', 'public.ledger_postings', 'UPDATE'),
      has_table_privilege('service_role', 'public.ledger_postings', 'DELETE')));
  PERFORM proof.snap_put('pre.ledger_triggers',
    (SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
      WHERE tgrelid = 'public.ledger_postings'::regclass AND NOT tgisinternal));
END $$;

