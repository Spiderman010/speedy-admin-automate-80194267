-- REAL POSTGRESQL CONCURRENCY PROOF for 6C-b10 — throwaway cluster only.
--
-- Twee werkelijk gelijktijdige sessies: deze psql-sessie (A) en een tweede
-- backend via dblink (B). A start een afsluiting en houdt haar transactie open;
-- B krijgt dezelfde aanroep asynchroon en blokkeert op de administratiegrendel;
-- A commit; B gaat door. De assertie gaat over de INVARIANT — precies één
-- afsluitbewijs en precies één watermerkstand — want die moet gelden wat de
-- timing ook doet.
--
-- Sessie B verbindt als postgres en omzeilt dus RLS; de rolcontroles ín de RPC
-- draaien onverkort, want die lezen auth.uid() uit de sessie-GUC die op die
-- verbinding wordt gezet.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

SELECT proof.new_client('Gelijktijdig afsluiten') AS c \gset
SELECT proof.seed_group(:'c', 2026);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$)
  AS t(x text);

BEGIN;

-- A sluit af maar commit nog niet: de administratiegrendel is genomen.
SELECT created FROM public.close_fiscal_year(:'c', 2026);

-- B probeert precies hetzelfde, asynchroon. Zij moet wachten — niet omdat de
-- applicatie dat afspreekt, maar omdat lock_ledger_client() haar tegenhoudt.
SELECT dblink_send_query('b', format('SELECT created FROM public.close_fiscal_year(%L, 2026)', :'c'));

SELECT proof.record('33a', 'de tweede sessie wacht op de administratiegrendel',
                    dblink_is_busy('b') = 1, format('dblink_is_busy = %s', dblink_is_busy('b')));

COMMIT;

-- B komt nu los. Zij mag NIET falen met een ondoorzichtige uniqueness-fout: het
-- jaar staat inmiddels dicht mét bewijs, dus zij hoort datzelfde bewijs terug te
-- krijgen met created = false.
CREATE OR REPLACE FUNCTION proof.collect_second(_client uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_created boolean;
  v_msg     text;
  v_markers integer;
  v_wm      integer;
BEGIN
  BEGIN
    SELECT x INTO v_created FROM dblink_get_result('b') AS t(x boolean);
    PERFORM * FROM dblink_get_result('b') AS t(x boolean);
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  SELECT count(*) INTO v_markers FROM public.year_closures WHERE client_id = _client;
  SELECT afgesloten_boekjaar INTO v_wm FROM public.clients WHERE id = _client;

  INSERT INTO proof.result VALUES ('33b',
    'twee gelijktijdige afsluitingen leveren precies één afsluitbewijs op',
    v_markers = 1 AND v_wm = 2026,
    format('bewijzen = %s, watermerk = %s, tweede sessie: %s',
           v_markers, v_wm, COALESCE(v_msg, format('created = %s', v_created))));

  INSERT INTO proof.result VALUES ('33c',
    'de tweede sessie krijgt het bestaande bewijs in plaats van een uniqueness-fout',
    v_msg IS NULL AND v_created = false,
    COALESCE(v_msg, format('created = %s', v_created)));
END $$;

SELECT proof.collect_second(:'c');

SELECT dblink_disconnect('b');
