-- DE VOLGORDE VAN MUTATIES EN GRENDELS. Throwaway database only.
--
-- O1–O4  harnas-triggers loggen elke rijmutatie in volgorde; per RPC en
--        toestand moet de reeks exact zijn wat de migratie belooft.
-- O5–O9  grendelvolgorde met twee echte sessies: banktransactie (FOR UPDATE)
--        → administratiegrendel → administratie (FOR SHARE), de laatste tot COMMIT.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['O1','O2','O3','O4','O5','O6','O7','O8','O9']);

CREATE TABLE proof.mutation_log (seq bigserial PRIMARY KEY, tbl text, op text, info text);
GRANT ALL ON proof.mutation_log TO public;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO public;

CREATE FUNCTION proof.log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_row jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  IF current_setting('proof.log', true) = 'on' THEN
    INSERT INTO proof.mutation_log (tbl, op, info) VALUES (TG_TABLE_NAME, TG_OP,
      coalesce(v_row ->> 'source_type', v_row ->> 'event_type', v_row ->> 'match_status', ''));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER proof_log AFTER INSERT OR UPDATE OR DELETE ON public.ledger_postings FOR EACH ROW EXECUTE FUNCTION proof.log_mutation();
CREATE TRIGGER proof_log AFTER INSERT OR UPDATE OR DELETE ON public.ledger_reversal_postings FOR EACH ROW EXECUTE FUNCTION proof.log_mutation();
CREATE TRIGGER proof_log AFTER INSERT OR UPDATE OR DELETE ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION proof.log_mutation();
CREATE TRIGGER proof_log AFTER INSERT OR UPDATE OR DELETE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION proof.log_mutation();
CREATE TRIGGER proof_log AFTER INSERT OR UPDATE OR DELETE ON public.bank_transaction_posting_events FOR EACH ROW EXECUTE FUNCTION proof.log_mutation();

/** Voert _sql gelogd uit en geeft de reeks terug, opeenvolgende gelijke stappen samengevoegd. */
CREATE FUNCTION proof.logged(_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_from bigint;
BEGIN
  SELECT coalesce(max(seq), 0) INTO v_from FROM proof.mutation_log;
  PERFORM set_config('proof.log', 'on', true);
  EXECUTE _sql INTO v;
  PERFORM set_config('proof.log', '', true);
  RETURN v || ' :: ' || coalesce((
    SELECT string_agg(step, ' → ' ORDER BY first_seq)
    FROM (SELECT min(seq) AS first_seq, step FROM (
            SELECT seq, step, seq - row_number() OVER (PARTITION BY step ORDER BY seq) AS grp
            FROM (SELECT seq, format('%s %s %s', tbl, op, info) AS step FROM proof.mutation_log WHERE seq > v_from) s) g
          GROUP BY step, grp) x), '');
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

SELECT proof.tx(600, -121.00), proof.tx(601, -121.00), proof.tx(602, -121.00), proof.tx(603, -121.00), proof.tx(604, -121.00);
SELECT proof.put('o600', proof.rc(proof.u(2), proof.uid(1000, 600), NULL, proof.acct(6), 21, proof.req(6000)));
SELECT proof.put('o601', proof.rc(proof.u(2), proof.uid(1000, 601), NULL, proof.acct(6), 21, proof.req(6010)));
SELECT proof.put('o602', proof.rc(proof.u(2), proof.uid(1000, 602), NULL, proof.acct(6), 21, proof.req(6020)));
SELECT proof.put('o602r', proof.rel(proof.u(1), proof.uid(1000, 602), proof.f(proof.get('o602'), 3)::uuid, proof.req(6021)));
SELECT proof.put('o603', proof.rc(proof.u(2), proof.uid(1000, 603), NULL, proof.acct(6), 21, proof.req(6030)));
SELECT public.reverse_posting_group(proof.f(proof.get('o603'), 3)::uuid, DATE '2027-03-01', 'Handmatig');
SELECT proof.put('o604', proof.rc(proof.u(2), proof.uid(1000, 604), NULL, proof.acct(6), 21, proof.req(6040)));

SELECT proof.put('O1', proof.logged(format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, ''Volgorde'')',
  proof.u(1), proof.uid(1000, 600), proof.f(proof.get('o600'), 3), proof.acct(7), proof.req(6001))));
SELECT proof.record('O1', 'herclassificeren (S1): tegenboekingsmarker → tegenregels → marker weg → codering → nieuwe marker → nieuwe regels → gebeurtenis',
  split_part(proof.get('O1'), ' :: ', 2) =
  'ledger_reversal_postings INSERT  → ledger_postings INSERT reversal → bank_transaction_postings DELETE  → bank_transactions UPDATE handmatig_geboekt → bank_transaction_postings INSERT  → ledger_postings INSERT bank_transaction → bank_transaction_posting_events INSERT reclassified',
  proof.get('O1'));

SELECT proof.put('O2', proof.logged(format('SELECT proof.rel(%L, %L, %L, %L, ''Volgorde'')',
  proof.u(1), proof.uid(1000, 601), proof.f(proof.get('o601'), 3), proof.req(6011))));
SELECT proof.record('O2', 'vrijgeven (S1): tegenboekingsmarker → tegenregels → marker weg → codering terug → gebeurtenis released als allerlaatste',
  split_part(proof.get('O2'), ' :: ', 2) =
  'ledger_reversal_postings INSERT  → ledger_postings INSERT reversal → bank_transaction_postings DELETE  → bank_transactions UPDATE niet_gematcht → bank_transaction_posting_events INSERT released',
  proof.get('O2'));

SELECT proof.put('O3', proof.logged(format('SELECT proof.rc(%L, %L, NULL, %L, 21, %L, ''Volgorde'')',
  proof.u(1), proof.uid(1000, 602), proof.acct(7), proof.req(6022))));
SELECT proof.record('O3', 'herboeken (S3): returned vóór de codering → nieuwe marker → nieuwe regels → posted; geen nieuwe storno',
  split_part(proof.get('O3'), ' :: ', 2) =
  'bank_transaction_posting_events INSERT returned → bank_transactions UPDATE handmatig_geboekt → bank_transaction_postings INSERT  → ledger_postings INSERT bank_transaction → bank_transaction_posting_events INSERT posted',
  proof.get('O3'));

SELECT proof.put('O4', proof.logged(format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, ''Volgorde'')',
  proof.u(1), proof.uid(1000, 603), proof.f(proof.get('o603'), 3), proof.acct(7), proof.req(6031))));
SELECT proof.record('O4', 'herboeken (S2): marker weg → codering → nieuwe marker → nieuwe regels → reposted; geen tweede storno',
  split_part(proof.get('O4'), ' :: ', 2) =
  'bank_transaction_postings DELETE  → bank_transactions UPDATE handmatig_geboekt → bank_transaction_postings INSERT  → ledger_postings INSERT bank_transaction → bank_transaction_posting_events INSERT reposted',
  proof.get('O4'));

DROP TRIGGER proof_log ON public.ledger_postings;
DROP TRIGGER proof_log ON public.ledger_reversal_postings;
DROP TRIGGER proof_log ON public.bank_transaction_postings;
DROP TRIGGER proof_log ON public.bank_transactions;
DROP TRIGGER proof_log ON public.bank_transaction_posting_events;

-- ── grendelvolgorde ─────────────────────────────────────────────────────────
SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

-- b houdt de administratiegrendel vast (zoals een andere schrijver van c1).
SELECT dblink_exec('b', 'BEGIN');
SELECT proof.remote_run('b', $$SELECT public.lock_ledger_client('00000000-0000-0000-0000-0000000000c1')::text$$);

-- a start een correctie: neemt de banktransactie en wacht dan op de administratiegrendel.
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_send_query('a', format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, ''Grendelvolgorde'')',
  proof.u(1), proof.uid(1000, 604), proof.f(proof.get('o604'), 3), proof.acct(7), proof.req(6041)));
SELECT proof.put('O5', proof.until_waiting('a'));
SELECT proof.record('O5', 'de correctie wacht op de administratiegrendel (advisory), niet op iets anders', proof.get('O5') = 'advisory', proof.get('O5'));

SELECT proof.put('O6', proof.remote_run('b', format('SELECT id::text FROM public.bank_transactions WHERE id = %L FOR UPDATE NOWAIT', proof.uid(1000, 604))));
SELECT proof.record('O6', '… terwijl zij de banktransactie al vasthoudt: b krijgt de rij niet (55P03) — eerst T, dan L',
  proof.get('O6') LIKE 'fout [55P03]%', proof.get('O6'));

-- Na de mislukte NOWAIT staat b's transactie in fout; terugdraaien laat de grendel los.
SELECT dblink_exec('b', 'ROLLBACK');
SELECT dblink_exec('b', 'BEGIN');
SELECT proof.put('O7_call', proof.remote_outcome('a'));
-- Wat een configuratiewijziging (UPDATE clients SET bank_rekening_id …) nodig heeft is FOR NO KEY UPDATE.
-- De foreign keys van de nieuwe grootboekregels nemen alleen FOR KEY SHARE en houden dat niet tegen; de
-- FOR SHARE van de RPC wel.
SELECT proof.put('O7', proof.remote_run('b', $$SET LOCAL lock_timeout = '300ms';
  UPDATE public.clients SET bank_rekening_id = bank_rekening_id WHERE id = '00000000-0000-0000-0000-0000000000c1' RETURNING id::text$$));
SELECT proof.record('O7', 'na L en de correctie houdt a de administratie FOR SHARE tot COMMIT: een configuratiewijziging (UPDATE) wacht en loopt tegen de time-out',
  proof.get('O7_call') LIKE 'ok: ok: reclassified|f|%' AND proof.get('O7') LIKE 'fout [55P03]%', proof.get('O7_call') || ' || ' || proof.get('O7'));
SELECT dblink_exec('b', 'ROLLBACK');

SELECT proof.put('O8', proof.remote_run('b', $$SELECT string_agg(DISTINCT l.locktype || ':' || l.mode, ',' ORDER BY l.locktype || ':' || l.mode)
                                              FROM pg_locks l WHERE l.pid = $$ || proof.get('pid_a') || $$ AND l.granted
                                                AND l.locktype IN ('advisory', 'transactionid')$$));
SELECT proof.record('O8', 'a houdt tot COMMIT de administratiegrendel (advisory) en haar transactie-id (de rijgrendels)',
  proof.get('O8') LIKE '%advisory:ExclusiveLock%' AND proof.get('O8') LIKE '%transactionid:ExclusiveLock%', proof.get('O8'));

SELECT dblink_exec('a', 'COMMIT');
SELECT proof.record('O9', 'na COMMIT: de correctie staat, de lineage is compleet', proof.marker(proof.uid(1000, 604)) = proof.f(proof.get('O7_call'), 3)::uuid
  AND proof.lineage_violations() = 0, proof.get('O7_call'));

SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');
