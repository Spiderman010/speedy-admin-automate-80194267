-- K5 — FOUTINJECTIE NÁ ELKE STAP EN BIJ COMMIT. Throwaway database only.
--
-- Harnas-triggers (alleen hier, aan het eind weer weg) gooien een fout zodra
-- proof.fail_at hun naam draagt. Per RPC en per toestand wordt na élke stap
-- een fout geforceerd; daarna moet elke boekhoudkundige rij — grootboek,
-- tegenboekingen, markers, koppelingen, bankregels én gebeurtenissen — exact
-- gelijk zijn. Bij COMMIT gebeurt hetzelfde in een echte tweede sessie.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'K5a','K5b','K5c','K5d','K5e','K5f',
  'K5g','K5h','K5i','K5j',
  'K5k','K5l','K5m','K5n',
  'K5o','K5p',
  'K5q',
  'K5r','K5s','K5t','K5u',
  'K5v']);

CREATE FUNCTION proof.fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('proof.fail_at', true) = TG_ARGV[0] THEN
    RAISE EXCEPTION 'proof: fout geïnjecteerd na %', TG_ARGV[0] USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER proof_fault_after_reversal AFTER INSERT ON public.ledger_reversal_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_reversal');
CREATE TRIGGER proof_fault_after_reversal_lines AFTER INSERT ON public.ledger_postings
  FOR EACH ROW WHEN (NEW.source_type = 'reversal') EXECUTE FUNCTION proof.fault('after_reversal_lines');
CREATE TRIGGER proof_fault_after_marker_delete AFTER DELETE ON public.bank_transaction_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_marker_delete');
CREATE TRIGGER proof_fault_after_coding AFTER UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_coding');
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

/** Voert _sql uit met proof.fail_at = _point, in dezelfde transactie. */
CREATE FUNCTION proof.faulted(_point text, _sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('proof.fail_at', _point, true);
  EXECUTE _sql INTO v;
  PERFORM set_config('proof.fail_at', '', true);
  RETURN v;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── de uitgangstoestanden ───────────────────────────────────────────────────
SELECT proof.tx(500, -121.00), proof.tx(501, -121.00), proof.tx(502, -121.00), proof.tx(503, -121.00),
       proof.tx(504, -121.00), proof.tx(505, -121.00), proof.tx(506, -60.00);
SELECT proof.put('f500', proof.rc(proof.u(2), proof.uid(1000, 500), NULL, proof.acct(6), 21, proof.req(5000)));
SELECT proof.put('f501', proof.rc(proof.u(2), proof.uid(1000, 501), NULL, proof.acct(6), 21, proof.req(5010)));
SELECT proof.put('f502', proof.rc(proof.u(2), proof.uid(1000, 502), NULL, proof.acct(6), 21, proof.req(5020)));
SELECT proof.put('f502r', proof.rel(proof.u(1), proof.uid(1000, 502), proof.f(proof.get('f502'), 3)::uuid, proof.req(5021)));
SELECT proof.put('f503', proof.rc(proof.u(2), proof.uid(1000, 503), NULL, proof.acct(6), 21, proof.req(5030)));
SELECT public.reverse_posting_group(proof.f(proof.get('f503'), 3)::uuid, DATE '2027-03-01', 'Handmatig');
SELECT proof.put('f504', proof.rc(proof.u(2), proof.uid(1000, 504), NULL, proof.acct(6), 21, proof.req(5040)));
SELECT proof.put('f504r', proof.rel(proof.u(1), proof.uid(1000, 504), proof.f(proof.get('f504'), 3)::uuid, proof.req(5041)));
SELECT proof.put('f505', proof.rc(proof.u(2), proof.uid(1000, 505), NULL, proof.acct(6), 21, proof.req(5050)));
SELECT proof.put('f_digest', proof.digest());

CREATE FUNCTION proof.k5(_n text, _name text, _point text, _sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  v := proof.faulted(_point, _sql);
  PERFORM proof.put('k5_' || _n, v);
END $$;
GRANT EXECUTE ON FUNCTION proof.k5(text, text, text, text) TO public;

CREATE FUNCTION proof.k5_check(_n text, _name text, _point text) RETURNS void LANGUAGE sql AS $$
  SELECT proof.record(_n, _name,
    proof.get('k5_' || _n) LIKE format('fout [P0001] proof: fout geïnjecteerd na %s%%', _point)
    AND proof.digest() = proof.get('f_digest'),
    proof.get('k5_' || _n));
$$;
GRANT EXECUTE ON FUNCTION proof.k5_check(text, text, text) TO public;

-- ── herclassificeren vanuit S1: storno → regels → marker weg → codering → schrijver → gebeurtenis
SELECT proof.k5('K5a', '', 'after_reversal',       format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5001)));
SELECT proof.k5_check('K5a', 'S1 herclassificeren, fout na de tegenboekingsmarker: niets veranderd', 'after_reversal');
SELECT proof.k5('K5b', '', 'after_reversal_lines', format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5002)));
SELECT proof.k5_check('K5b', 'S1 herclassificeren, fout na de tegenboekingsregels: niets veranderd', 'after_reversal_lines');
SELECT proof.k5('K5c', '', 'after_marker_delete',  format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5003)));
SELECT proof.k5_check('K5c', 'S1 herclassificeren, fout na het losmaken van de marker: niets veranderd', 'after_marker_delete');
SELECT proof.k5('K5d', '', 'after_coding',         format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5004)));
SELECT proof.k5_check('K5d', 'S1 herclassificeren, fout na de nieuwe codering: niets veranderd', 'after_coding');
SELECT proof.k5('K5e', '', 'after_writer',         format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5005)));
SELECT proof.k5_check('K5e', 'S1 herclassificeren, fout midden in de schrijver (na de eerste nieuwe regel): niets veranderd', 'after_writer');
SELECT proof.k5('K5f', '', 'after_event',          format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 500), proof.f(proof.get('f500'), 3), proof.acct(7), proof.req(5006)));
SELECT proof.k5_check('K5f', 'S1 herclassificeren, fout na de gebeurtenis: niets veranderd', 'after_event');

-- ── vrijgeven vanuit S1
SELECT proof.k5('K5g', '', 'after_reversal',       format('SELECT proof.rel(%L, %L, %L, %L)', proof.u(1), proof.uid(1000, 501), proof.f(proof.get('f501'), 3), proof.req(5011)));
SELECT proof.k5_check('K5g', 'vrijgeven, fout na de tegenboeking: niets veranderd', 'after_reversal');
SELECT proof.k5('K5h', '', 'after_marker_delete',  format('SELECT proof.rel(%L, %L, %L, %L)', proof.u(1), proof.uid(1000, 501), proof.f(proof.get('f501'), 3), proof.req(5012)));
SELECT proof.k5_check('K5h', 'vrijgeven, fout na het losmaken van de marker: niets veranderd', 'after_marker_delete');
SELECT proof.k5('K5i', '', 'after_coding',         format('SELECT proof.rel(%L, %L, %L, %L)', proof.u(1), proof.uid(1000, 501), proof.f(proof.get('f501'), 3), proof.req(5013)));
SELECT proof.k5_check('K5i', 'vrijgeven, fout na het terugzetten van de codering: niets veranderd', 'after_coding');
SELECT proof.k5('K5j', '', 'after_event',          format('SELECT proof.rel(%L, %L, %L, %L)', proof.u(1), proof.uid(1000, 501), proof.f(proof.get('f501'), 3), proof.req(5014)));
SELECT proof.k5_check('K5j', 'vrijgeven, fout na de gebeurtenis released: niets veranderd, de hold is er niet', 'after_event');

-- ── herboeken vanuit S3: returned → codering → schrijver → posted
SELECT proof.k5('K5k', '', 'after_returned',       format('SELECT proof.rc(%L, %L, NULL, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 502), proof.acct(7), proof.req(5022)));
SELECT proof.k5_check('K5k', 'S3 herboeken, fout na returned: niets veranderd, de transactie blijft vrijgegeven', 'after_returned');
SELECT proof.k5('K5l', '', 'after_coding',         format('SELECT proof.rc(%L, %L, NULL, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 502), proof.acct(7), proof.req(5023)));
SELECT proof.k5_check('K5l', 'S3 herboeken, fout na de codering: niets veranderd', 'after_coding');
SELECT proof.k5('K5m', '', 'after_writer',         format('SELECT proof.rc(%L, %L, NULL, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 502), proof.acct(7), proof.req(5024)));
SELECT proof.k5_check('K5m', 'S3 herboeken, fout in de schrijver: niets veranderd', 'after_writer');
SELECT proof.k5('K5n', '', 'after_event',          format('SELECT proof.rc(%L, %L, NULL, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 502), proof.acct(7), proof.req(5025)));
SELECT proof.k5_check('K5n', 'S3 herboeken, fout na posted: niets veranderd, ook returned is weg', 'after_event');

-- ── herboeken vanuit S2: marker weg → codering → schrijver → reposted
SELECT proof.k5('K5o', '', 'after_marker_delete',  format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 503), proof.f(proof.get('f503'), 3), proof.acct(7), proof.req(5031)));
SELECT proof.k5_check('K5o', 'S2 herboeken, fout na het losmaken van de marker: niets veranderd', 'after_marker_delete');
SELECT proof.k5('K5p', '', 'after_new_marker',     format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Fout'')', proof.u(1), proof.uid(1000, 503), proof.f(proof.get('f503'), 3), proof.acct(7), proof.req(5032)));
SELECT proof.k5_check('K5p', 'S2 herboeken, fout na de nieuwe marker: niets veranderd', 'after_new_marker');

-- ── terugzetten
SELECT proof.k5('K5q', '', 'after_returned',       format('SELECT proof.ret(%L, %L, %L)', proof.u(1), proof.uid(1000, 504), proof.req(5042)));
SELECT proof.k5_check('K5q', 'terugzetten, fout na returned: niets veranderd, de hold blijft', 'after_returned');

-- ── bij COMMIT, in een echte tweede sessie ──────────────────────────────────
SELECT proof.open_session('a', :'conn');

CREATE FUNCTION proof.commit_fault(_n text, _sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_call text; v_commit text;
BEGIN
  PERFORM dblink_exec('a', 'BEGIN');
  PERFORM * FROM dblink('a', $q$SELECT set_config('proof.fail_at', 'at_commit', true)$q$) AS t(x text);
  v_call := proof.remote_run('a', _sql);
  v_commit := proof.remote_exec('a', 'COMMIT');
  RETURN v_call || ' => COMMIT: ' || v_commit;
END $$;
GRANT EXECUTE ON FUNCTION proof.commit_fault(text, text) TO public;

SELECT proof.put('k5_K5r', proof.commit_fault('K5r', format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Bij commit'')',
  proof.u(1), proof.uid(1000, 505), proof.f(proof.get('f505'), 3), proof.acct(7), proof.req(5051))));
SELECT proof.record('K5r', 'S1 herclassificeren slaagt in de sessie maar faalt bij COMMIT: alles teruggedraaid',
  proof.get('k5_K5r') LIKE 'ok: ok: reclassified|f|%=> COMMIT: fout [P0001] proof: fout geïnjecteerd na at_commit%'
  AND proof.digest() = proof.get('f_digest'), proof.get('k5_K5r'));

SELECT proof.put('k5_K5s', proof.commit_fault('K5s', format('SELECT proof.rel(%L, %L, %L, %L)',
  proof.u(1), proof.uid(1000, 501), proof.f(proof.get('f501'), 3), proof.req(5015))));
SELECT proof.record('K5s', 'vrijgeven faalt bij COMMIT: alles teruggedraaid',
  proof.get('k5_K5s') LIKE 'ok: ok: released|f|%=> COMMIT: fout [P0001]%' AND proof.digest() = proof.get('f_digest'), proof.get('k5_K5s'));

SELECT proof.put('k5_K5t', proof.commit_fault('K5t', format('SELECT proof.rc(%L, %L, NULL, %L, 9, %L, ''Bij commit'')',
  proof.u(1), proof.uid(1000, 502), proof.acct(7), proof.req(5026))));
SELECT proof.record('K5t', 'S3 herboeken (twee gebeurtenissen) faalt bij COMMIT: alles teruggedraaid',
  proof.get('k5_K5t') LIKE 'ok: ok: reposted_after_release|f|%=> COMMIT: fout [P0001]%' AND proof.digest() = proof.get('f_digest'), proof.get('k5_K5t'));

-- Na een mislukte COMMIT werkt dezelfde request_id gewoon (het origineel bestaat niet).
SELECT proof.put('k5_after', proof.rc(proof.u(1), proof.uid(1000, 505), proof.f(proof.get('f505'), 3)::uuid, proof.acct(7), 9, proof.req(5051), 'Bij commit'));
SELECT proof.record('K5u', 'na de mislukte COMMIT voert dezelfde request_id het voor het eerst uit (geen spookherhaling)',
  proof.get('k5_after') LIKE 'ok: reclassified|f|%', proof.get('k5_after'));

-- De uitgestelde lineage-controle echt bij COMMIT: marker weg zonder gebeurtenis.
SELECT proof.put('f506', proof.rc(proof.u(2), proof.uid(1000, 506), NULL, proof.acct(7), 0, proof.req(5060)));
SELECT public.reverse_posting_group(proof.marker(proof.uid(1000, 506)), DATE '2027-03-02', 'Handmatig');
SELECT proof.put('f_digest2', proof.digest());
SELECT proof.put('k5_K5v', concat_ws(' => ',
  proof.remote_exec('a', 'BEGIN'),
  proof.remote_run('a', format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L RETURNING bank_transaction_id::text', proof.uid(1000, 506))),
  proof.remote_exec('a', 'COMMIT')));
SELECT proof.record('K5v', 'eigenaar haalt een tegengeboekte marker weg zonder gebeurtenis: de DELETE lukt, de COMMIT faalt (23514), niets veranderd',
  proof.get('k5_K5v') LIKE 'ok => ok: % => fout [23514] Een losgemaakte directe bankboeking moet in dezelfde transactie%'
  AND proof.digest() = proof.get('f_digest2') AND proof.marker(proof.uid(1000, 506)) IS NOT NULL, proof.get('k5_K5v'));

SELECT dblink_disconnect('a');

-- De harnas-triggers verdwijnen weer.
DROP TRIGGER proof_fault_after_reversal ON public.ledger_reversal_postings;
DROP TRIGGER proof_fault_after_reversal_lines ON public.ledger_postings;
DROP TRIGGER proof_fault_after_marker_delete ON public.bank_transaction_postings;
DROP TRIGGER proof_fault_after_coding ON public.bank_transactions;
DROP TRIGGER proof_fault_after_new_marker ON public.bank_transaction_postings;
DROP TRIGGER proof_fault_after_writer ON public.ledger_postings;
DROP TRIGGER proof_fault_after_returned ON public.bank_transaction_posting_events;
DROP TRIGGER proof_fault_after_event ON public.bank_transaction_posting_events;
DROP TRIGGER proof_fault_at_commit ON public.bank_transaction_posting_events;
