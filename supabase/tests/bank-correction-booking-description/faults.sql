-- F — EEN FOUT NA ELKE STAP, OOK BIJ COMMIT, DRAAIT ALLES TERUG. Throwaway database only.
--
-- Harnas-triggers (alleen hier, aan het eind weer weg) gooien een fout zodra
-- proof.fail_at hun naam draagt. Nieuw ten opzichte van PR 1: update_1 (direct
-- na het tijdelijk zetten van de boekingstekst) en update_2 (direct na het
-- herstel). Per toestand S0–S4 wordt na élke stap een fout geforceerd; daarna
-- moet elke boekhoudkundige rij gelijk zijn en elke bankomschrijving byte-gelijk.
-- Bij COMMIT gebeurt hetzelfde in een echte tweede sessie. Een trigger die het
-- herstel saboteert, laat zien dat de RPC haar eigen herstel toetst (23514).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

CREATE FUNCTION proof.fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('proof.fail_at', true) = TG_ARGV[0] THEN
    RAISE EXCEPTION 'proof: fout geïnjecteerd na %', TG_ARGV[0] USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

/** Telt de UPDATE's van een bankregel in deze transactie: update_1 = het tijdelijk
    zetten, update_2 = het herstel. */
CREATE FUNCTION proof.fault_upd() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer := coalesce(nullif(current_setting('proof.upd_n', true), ''), '0')::integer + 1;
BEGIN
  PERFORM set_config('proof.upd_n', n::text, true);
  IF current_setting('proof.fail_at', true) = 'update_' || n THEN
    RAISE EXCEPTION 'proof: fout geïnjecteerd na update_%', n USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER proof_fault_after_reversal AFTER INSERT ON public.ledger_reversal_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_reversal');
CREATE TRIGGER proof_fault_after_marker_delete AFTER DELETE ON public.bank_transaction_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_marker_delete');
CREATE TRIGGER proof_fault_after_new_marker AFTER INSERT ON public.bank_transaction_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_new_marker');
CREATE TRIGGER proof_fault_after_writer AFTER INSERT ON public.ledger_postings
  FOR EACH ROW WHEN (NEW.source_type = 'bank_transaction') EXECUTE FUNCTION proof.fault('after_writer');
CREATE TRIGGER proof_fault_after_returned AFTER INSERT ON public.bank_transaction_posting_events
  FOR EACH ROW WHEN (NEW.event_type = 'returned') EXECUTE FUNCTION proof.fault('after_returned');
CREATE TRIGGER proof_fault_after_event AFTER INSERT ON public.bank_transaction_posting_events
  FOR EACH ROW WHEN (NEW.event_type <> 'returned') EXECUTE FUNCTION proof.fault('after_event');
CREATE CONSTRAINT TRIGGER proof_fault_at_commit AFTER INSERT ON public.bank_transaction_posting_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proof.fault('at_commit');
CREATE TRIGGER proof_fault_update AFTER UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION proof.fault_upd();

/** Saboteert het herstel: bij de tweede UPDATE van de rij zet een trigger een andere tekst. */
CREATE FUNCTION proof.sabotage_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer := coalesce(nullif(current_setting('proof.sab_n', true), ''), '0')::integer + 1;
BEGIN
  PERFORM set_config('proof.sab_n', n::text, true);
  IF current_setting('proof.sabotage', true) = 'on' AND n = 2 THEN
    NEW.description := coalesce(NEW.description, '') || ' (door een trigger gewijzigd)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proof_sabotage BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION proof.sabotage_fn();

/** Voert _sql uit met proof.fail_at = _point (of de sabotage aan), in dezelfde transactie. */
CREATE FUNCTION proof.faulted(_point text, _sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('proof.upd_n', '0', true);
  PERFORM set_config('proof.sab_n', '0', true);
  IF _point = 'sabotage' THEN
    PERFORM set_config('proof.sabotage', 'on', true);
  ELSE
    PERFORM set_config('proof.fail_at', _point, true);
  END IF;
  EXECUTE _sql INTO v;
  PERFORM set_config('proof.fail_at', '', true);
  PERFORM set_config('proof.sabotage', '', true);
  RETURN v;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── de uitgangstoestanden: banktekst ≠ boekingstekst overal ─────────────────
SELECT proof.btx(300, -121.00, 'S0-banktekst'), proof.btx(301, -121.00, 'S1-banktekst'), proof.btx(302, -121.00, 'S2-banktekst'),
       proof.btx(303, -121.00, 'S3-banktekst'), proof.btx(304, -121.00, 'S4-banktekst');
SELECT proof.put('g301', proof.rc(proof.u(2), proof.uid(1000, 301), NULL, proof.acct(7), 21, proof.req(3010), NULL, 'Boeking 301'));
SELECT proof.put('g302', proof.rc(proof.u(2), proof.uid(1000, 302), NULL, proof.acct(7), 21, proof.req(3020), NULL, 'Boeking 302'));
SELECT public.reverse_posting_group(proof.m(302), DATE '2027-03-01', 'Handmatig');
SELECT proof.put('g303', proof.rc(proof.u(2), proof.uid(1000, 303), NULL, proof.acct(7), 21, proof.req(3030), NULL, 'Boeking 303'));
SELECT proof.put('g303r', proof.rel(proof.u(1), proof.uid(1000, 303), proof.m(303), proof.req(3031)));
SELECT proof.put('g304', proof.rc(proof.u(2), proof.uid(1000, 304), NULL, proof.acct(7), 21, proof.req(3040), NULL, 'Boeking 304'));
SELECT proof.put('g304r', proof.rel(proof.u(1), proof.uid(1000, 304), proof.m(304), proof.req(3041)));
SELECT proof.put('g304t', proof.ret(proof.u(1), proof.uid(1000, 304), proof.req(3042)));
SELECT proof.put('f_digest', proof.digest());
SELECT proof.put('f_rest', proof.rest_digest());

/** De aanroep per toestand (met omschrijving, behalve s1b: zonder, dus de overgenomen boekingstekst). */
CREATE TABLE proof.fcall (state text PRIMARY KEY, n integer, sql text);
INSERT INTO proof.fcall VALUES
  ('s0',  300, format('SELECT proof.rc(%L, %L, NULL, %L, 21, %L, NULL, %L)', proof.u(2), proof.uid(1000, 300), proof.acct(6), proof.req(3001), 'Fout-tekst')),
  ('s1',  301, format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L, %L)', proof.u(1), proof.uid(1000, 301), proof.m(301), proof.acct(6), proof.req(3011), 'Fout', 'Fout-tekst')),
  ('s1b', 301, format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L)', proof.u(1), proof.uid(1000, 301), proof.m(301), proof.acct(6), proof.req(3012), 'Fout zonder tekst')),
  ('s2',  302, format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L, %L)', proof.u(1), proof.uid(1000, 302), proof.m(302), proof.acct(6), proof.req(3021), 'Fout', 'Fout-tekst')),
  ('s3',  303, format('SELECT proof.rc(%L, %L, NULL, %L, 21, %L, %L, %L)', proof.u(1), proof.uid(1000, 303), proof.acct(6), proof.req(3032), 'Fout', 'Fout-tekst')),
  ('s4',  304, format('SELECT proof.rc(%L, %L, NULL, %L, 21, %L, NULL, %L)', proof.u(2), proof.uid(1000, 304), proof.acct(6), proof.req(3043), 'Fout-tekst'));
GRANT SELECT ON proof.fcall TO public;

CREATE TABLE proof.fpoint (state text, point text);
INSERT INTO proof.fpoint VALUES
  ('s0', 'update_1'), ('s0', 'after_new_marker'), ('s0', 'after_writer'), ('s0', 'update_2'), ('s0', 'after_event'),
  ('s1', 'after_reversal'), ('s1', 'after_marker_delete'), ('s1', 'update_1'), ('s1', 'after_new_marker'),
  ('s1', 'after_writer'), ('s1', 'update_2'), ('s1', 'after_event'),
  ('s1b', 'update_1'), ('s1b', 'after_writer'), ('s1b', 'update_2'), ('s1b', 'after_event'),
  ('s2', 'after_marker_delete'), ('s2', 'update_1'), ('s2', 'after_writer'), ('s2', 'update_2'), ('s2', 'after_event'),
  ('s3', 'after_returned'), ('s3', 'update_1'), ('s3', 'after_writer'), ('s3', 'update_2'), ('s3', 'after_event'),
  ('s4', 'update_1'), ('s4', 'after_writer'), ('s4', 'update_2'), ('s4', 'after_event');

SELECT proof.plan(array_agg('F-' || state || '-' || point)) FROM proof.fpoint;
SELECT proof.plan(ARRAY['F-s0-at_commit', 'F-s1-at_commit', 'F-s3-at_commit',
                        'F-s0-sabotage', 'F-s1-sabotage',
                        'F-s0-ok', 'F-s1-ok', 'F-s1b-ok', 'F-s2-ok', 'F-s3-ok', 'F-s4-ok', 'F-gone']);

-- ── een fout na elke stap ───────────────────────────────────────────────────
-- Per fout twee opdrachten: eerst de aanroep, dan — in een nieuwe opdracht, met
-- een nieuwe momentopname — de toets.
SELECT format('SELECT proof.put(%L, proof.faulted(%L, %L))', 'fo_' || p.state || '_' || p.point, p.point, c.sql),
       format($f$
  SELECT proof.record(%L, %L,
    proof.get(%L) LIKE 'fout [P0001] proof: fout geïnjecteerd na %s%%'
    AND proof.digest() = proof.get('f_digest') AND proof.rest_digest() = proof.get('f_rest') AND proof.all_intact(ARRAY[10, 202, 203]),
    proof.get(%L))$f$,
  'F-' || p.state || '-' || p.point,
  format('%s: een fout na %s — niets veranderd, bankregels byte-gelijk', p.state, p.point),
  'fo_' || p.state || '_' || p.point, p.point, 'fo_' || p.state || '_' || p.point)
FROM proof.fpoint p JOIN proof.fcall c USING (state)
ORDER BY c.state, p.point \gexec

-- ── bij COMMIT, in een echte tweede sessie ──────────────────────────────────
SELECT proof.open_session('a', :'conn');
SELECT format($f$
  SELECT proof.put(%L, concat_ws(' ~ ',
    proof.remote_exec('a', 'BEGIN'),
    proof.remote_exec('a', 'SET LOCAL proof.fail_at = ''at_commit'''),
    proof.remote_run('a', %L),
    proof.remote_exec('a', 'COMMIT')))$f$,
  'fc_' || c.state, c.sql)
FROM proof.fcall c WHERE c.state IN ('s0', 's1', 's3') ORDER BY c.state \gexec
SELECT proof.record('F-' || s || '-at_commit', s || ': de RPC slaagt in de transactie, maar COMMIT faalt — niets veranderd, bankregels byte-gelijk',
  proof.get('fc_' || s) LIKE 'ok ~ ok ~ ok: ok: %~ fout [P0001] proof: fout geïnjecteerd na at_commit%'
  AND proof.digest() = proof.get('f_digest') AND proof.rest_digest() = proof.get('f_rest') AND proof.all_intact(ARRAY[10, 202, 203]),
  proof.get('fc_' || s))
FROM unnest(ARRAY['s0', 's1', 's3']) s;
SELECT dblink_disconnect('a');

-- ── de RPC toetst haar eigen herstel ────────────────────────────────────────
SELECT format('SELECT proof.put(%L, proof.faulted(''sabotage'', %L))', 'fs_' || c.state, c.sql),
       format($f$
  SELECT proof.record(%L, %L,
    proof.get(%L) LIKE 'fout [23514] De oorspronkelijke bankomschrijving bleef niet behouden; er is niets geboekt%%'
    AND proof.digest() = proof.get('f_digest') AND proof.all_intact(ARRAY[10, 202, 203]),
    proof.get(%L))$f$,
  'F-' || c.state || '-sabotage', c.state || ': een trigger die het herstel wijzigt → 23514, niets geboekt, bankregels byte-gelijk',
  'fs_' || c.state, 'fs_' || c.state)
FROM proof.fcall c WHERE c.state IN ('s0', 's1') ORDER BY c.state \gexec

-- ── zonder fout slagen dezelfde aanroepen ───────────────────────────────────
DROP TRIGGER proof_fault_after_reversal ON public.ledger_reversal_postings;
DROP TRIGGER proof_fault_after_marker_delete ON public.bank_transaction_postings;
DROP TRIGGER proof_fault_after_new_marker ON public.bank_transaction_postings;
DROP TRIGGER proof_fault_after_writer ON public.ledger_postings;
DROP TRIGGER proof_fault_after_returned ON public.bank_transaction_posting_events;
DROP TRIGGER proof_fault_after_event ON public.bank_transaction_posting_events;
DROP TRIGGER proof_fault_at_commit ON public.bank_transaction_posting_events;
DROP TRIGGER proof_fault_update ON public.bank_transactions;
DROP TRIGGER proof_sabotage ON public.bank_transactions;

SELECT proof.record('F-gone', 'de harnas-triggers zijn weer weg: de triggerset op bank_transactions is de beoordeelde',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.bank_transactions'::regclass AND NOT tgisinternal) = 5
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'proof_%'));

-- s1 en s1b gaan over dezelfde regel: s1b eerst (zonder tekst, dus de boekingstekst), dan s1.
SELECT proof.put('fok_s1b', proof.rc(proof.u(1), proof.uid(1000, 301), proof.m(301), proof.acct(6), 21, proof.req(3013), 'Nu zonder fout'));
SELECT proof.record('F-s1b-ok', 's1b zonder fout: herclassificeren zonder omschrijving behoudt ''Boeking 301''; bankregel byte-gelijk',
  proof.get('fok_s1b') LIKE 'ok: reclassified|f|%' AND proof.text_of(proof.m(301)) = 'Boeking 301' AND proof.intact(301), proof.get('fok_s1b'));
SELECT proof.put('fok_s1', proof.rc(proof.u(1), proof.uid(1000, 301), proof.m(301), proof.acct(7), 21, proof.req(3014), 'Nu zonder fout', 'Goede tekst'));
SELECT proof.record('F-s1-ok', 's1 zonder fout: geslaagd met de nieuwe tekst; bankregel byte-gelijk',
  proof.get('fok_s1') LIKE 'ok: reclassified|f|%' AND proof.text_of(proof.m(301)) = 'Goede tekst' AND proof.intact(301), proof.get('fok_s1'));
SELECT proof.put('fok_s0', proof.rc(proof.u(2), proof.uid(1000, 300), NULL, proof.acct(6), 21, proof.req(3002), NULL, 'Goede tekst'));
SELECT proof.record('F-s0-ok', 's0 zonder fout: geslaagd; bankregel byte-gelijk',
  proof.get('fok_s0') LIKE 'ok: posted|f|%' AND proof.text_of(proof.m(300)) = 'Goede tekst' AND proof.intact(300), proof.get('fok_s0'));
SELECT proof.put('fok_s2', proof.rc(proof.u(1), proof.uid(1000, 302), proof.m(302), proof.acct(6), 21, proof.req(3022), 'Nu zonder fout'));
SELECT proof.record('F-s2-ok', 's2 zonder fout en zonder omschrijving: herboekt met ''Boeking 302''; bankregel byte-gelijk',
  proof.get('fok_s2') LIKE 'ok: reposted|f|%' AND proof.text_of(proof.m(302)) = 'Boeking 302' AND proof.intact(302), proof.get('fok_s2'));
SELECT proof.put('fok_s3', proof.rc(proof.u(1), proof.uid(1000, 303), NULL, proof.acct(6), 21, proof.req(3033), 'Nu zonder fout'));
SELECT proof.record('F-s3-ok', 's3 zonder fout en zonder omschrijving: herboekt met ''Boeking 303''; bankregel byte-gelijk',
  proof.get('fok_s3') LIKE 'ok: reposted_after_release|f|%' AND proof.text_of(proof.m(303)) = 'Boeking 303' AND proof.intact(303), proof.get('fok_s3'));
SELECT proof.put('fok_s4', proof.rc(proof.u(2), proof.uid(1000, 304), NULL, proof.acct(6), 21, proof.req(3044)));
SELECT proof.record('F-s4-ok', 's4 zonder fout en zonder omschrijving: geboekt met ''Boeking 304''; bankregel byte-gelijk',
  proof.get('fok_s4') LIKE 'ok: posted|f|%' AND proof.text_of(proof.m(304)) = 'Boeking 304' AND proof.intact(304), proof.get('fok_s4'));
