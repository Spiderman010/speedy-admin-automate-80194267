-- REAL POSTGRESQL CONCURRENCY PROOF for 6C-b11 PR D — throwaway cluster only.
--
-- DE VRAAG. De toets op de boekingsblokkade leest `clients`. Zonder grendel
-- zou dit kunnen: een schrijver leest "geen blokkade", een ander zet de
-- blokkade en commit, en de schrijver boekt alsnog — een boeking die volgens
-- de zojuist vastgelegde blokkade nooit had mogen bestaan.
--
-- DE OPLOSSING DIE HIER WORDT BEWEZEN. Beide kanten nemen dezelfde
-- administratiegrendel: `set_posting_lock()` neemt `lock_ledger_client()`, en
-- PR D laat elke schrijver hem nemen vóór de toets. Daardoor kunnen de twee
-- niet meer door elkaar lopen; ze serialiseren.
--
-- Twee werkelijk gelijktijdige sessies: deze psql-sessie (A) en een tweede
-- backend via dblink (B). Sessie B verbindt als postgres en omzeilt dus RLS;
-- de rolcontroles in de functies draaien onverkort, want die lezen auth.uid()
-- uit de sessie-GUC die op die verbinding wordt gezet.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$)
  AS t(x text);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ═══ 30. EEN BOEKING IN UITVOERING HOUDT DE BLOKKADE TEGEN ══════════════════
--
-- A boekt en houdt zijn transactie open. B probeert de blokkade te zetten en
-- moet wachten — niet omdat de applicatie dat afspreekt, maar omdat A de
-- administratiegrendel houdt.

SELECT proof.new_client('Gelijktijdig — boeking eerst') AS c1 \gset
SELECT proof.new_manual(:'c1', DATE '2024-06-01') AS j1 \gset

BEGIN;

SELECT public.post_manual_journal(:'j1');

SELECT dblink_send_query('b', format(
  'SELECT s.changed FROM public.set_posting_lock(%L, DATE ''2024-12-31'', ''Gelijktijdig'') s', :'c1'));

SELECT proof.record('30', 'een lopende boeking laat de blokkade wachten op de administratiegrendel',
                    dblink_is_busy('b') = 1, format('dblink_is_busy = %s', dblink_is_busy('b')));

COMMIT;

CREATE OR REPLACE FUNCTION proof.collect(_n text, _name text, _client uuid, _regels integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_msg     text;
  v_x       text;
  v_aantal  integer;
  v_slot    date;
BEGIN
  BEGIN
    SELECT x INTO v_x FROM dblink_get_result('b') AS t(x text);
    PERFORM * FROM dblink_get_result('b') AS t(x text);
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  SELECT count(*) INTO v_aantal FROM public.ledger_postings WHERE client_id = _client;
  SELECT posting_locked_through INTO v_slot FROM public.clients WHERE id = _client;

  INSERT INTO proof.result VALUES (_n, _name, v_aantal = _regels,
    format('%s grootboekregels (verwacht %s), blokkade = %s, tweede sessie: %s',
           v_aantal, _regels, COALESCE(v_slot::text, 'geen'), COALESCE(v_msg, COALESCE(v_x, 'klaar'))));
END $$;

-- De boeking is er, en de blokkade is er daarna bijgekomen: geen van beide is
-- half gelukt, en de volgorde is eenduidig.
SELECT proof.collect('31', 'de boeking staat er, en de blokkade is er daarna pas', :'c1', 2);

-- ═══ 32. EEN BLOKKADE IN UITVOERING HOUDT DE BOEKING TEGEN ══════════════════
--
-- Andersom: B zet de blokkade en houdt open, A probeert te boeken. Ook nu
-- serialiseren zij, en A wordt na afloop geweigerd — niet omdat A te laat
-- keek, maar omdat A pas mag lezen als B klaar is.

SELECT proof.new_client('Gelijktijdig — blokkade eerst') AS c2 \gset
SELECT proof.new_manual(:'c2', DATE '2024-06-01') AS j2 \gset

SELECT * FROM dblink('b', 'BEGIN') AS t(x text);
SELECT * FROM dblink('b', format(
  'SELECT s.changed FROM public.set_posting_lock(%L, DATE ''2024-12-31'', ''Eerst de blokkade'') s', :'c2'))
  AS t(x text);

-- B houdt de grendel. A's boeking moet nu wachten; dat is niet in één sessie
-- te observeren zonder te blokkeren, dus A gaat asynchroon via een derde
-- verbinding.
SELECT dblink_connect('a2', :'conn');
SELECT * FROM dblink('a2', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$)
  AS t(x text);
SELECT dblink_send_query('a2', format('SELECT public.post_manual_journal(%L)', :'j2'));

SELECT proof.record('32', 'een lopende blokkadewijziging laat de boeking wachten',
                    dblink_is_busy('a2') = 1, format('dblink_is_busy = %s', dblink_is_busy('a2')));

SELECT * FROM dblink('b', 'COMMIT') AS t(x text);

CREATE OR REPLACE FUNCTION proof.collect_a2(_client uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_msg    text;
  v_x      text;
  v_aantal integer;
BEGIN
  BEGIN
    SELECT x INTO v_x FROM dblink_get_result('a2') AS t(x text);
    PERFORM * FROM dblink_get_result('a2') AS t(x text);
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  SELECT count(*) INTO v_aantal FROM public.ledger_postings WHERE client_id = _client;

  /*
   * A zag na afloop de blokkade die B had vastgelegd en werd geweigerd, mét de
   * gedeelde melding.
   *
   * EERLIJK OVER WAT DIT WÉL EN NIET BEWIJST. Deze richting is
   * timing-gevoelig: ook zónder de grendel vóór de toets komt A hier meestal
   * op hetzelfde uit, want A serialiseert hoe dan ook later — de
   * ledger-insert neemt dezelfde administratiegrendel. Een mutatietest
   * bevestigde dat: de grendel uit post_manual_journal halen laat dit bewijs
   * gewoon slagen.
   *
   * De harde garantie voor déze richting is daarom structureel en staat in
   * proof.sql nr. 28: élke schrijver neemt `lock_ledger_client()` aantoonbaar
   * vóór de bewering. Dat bewijs valt wél om zodra één schrijver hem mist.
   * Bewijs 30/31 hieronder is de omgekeerde richting en is niet
   * timing-gevoelig: daar wacht de blokkadewijziging aantoonbaar op de
   * lopende boeking.
   */
  INSERT INTO proof.result VALUES ('33',
    'de wachtende boeking ziet de nieuwe blokkade en wordt geweigerd',
    v_aantal = 0 AND v_msg IS NOT NULL AND position('boekingsblokkade' IN v_msg) > 0,
    format('%s grootboekregels, uitkomst: %s', v_aantal, COALESCE(v_msg, COALESCE(v_x, 'geslaagd'))));
END $$;

SELECT proof.collect_a2(:'c2');

SELECT dblink_disconnect('a2');
SELECT dblink_disconnect('b');
