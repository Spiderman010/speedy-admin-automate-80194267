-- HULPFUNCTIES VOOR DE HOLD-FIX — throwaway database only. Never run against any BoekAssist database.
--
-- Bovenop ../bank-transaction-corrections/fixtures.sql (PR 1) en
-- ../bank-correction-booking-description/helpers.sql (PR 2). Hier: het bouwen
-- van boekingsgeschiedenis van vóór PR 1 met de ECHTE schrijvers (boeken,
-- handmatig storneren, marker weg, opnieuw boeken — zoals in productie), en het
-- nabootsen van werkelijk corrupte geschiedenis die de schrijvers terecht niet
-- toelaten (alleen hier, met de append-only-trigger heel even uit).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/** Stap 1 van een historische regel: invoegen, handmatig coderen en boeken (de schrijver). */
CREATE FUNCTION proof.h_post(_n integer, _amount numeric, _btw numeric DEFAULT 0, _date date DEFAULT DATE '2025-11-25')
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE id = proof.uid(1000, _n)) THEN
    PERFORM proof.btx(_n, _amount, format('Historische regel %s', _n), _date => _date);
  END IF;
  UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7), btw_percentage = _btw
  WHERE id = proof.uid(1000, _n);
  RETURN public.post_bank_transaction(proof.uid(1000, _n));
END $$;

/** Stap 2: de actieve groep handmatig storneren (de bestaande reversalketen). */
CREATE FUNCTION proof.h_reverse(_n integer, _date date DEFAULT DATE '2025-11-25')
RETURNS uuid LANGUAGE sql AS $$
  SELECT public.reverse_posting_group(proof.marker(proof.uid(1000, _n)), _date, 'Historische storno');
$$;

/** Stap 3: de marker weghalen, zoals dat vóór PR 1 kon. */
CREATE FUNCTION proof.h_unmark(_n integer) RETURNS void LANGUAGE sql AS $$
  DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, _n);
$$;

/** Stap 4: opnieuw boeken (de schrijver), met een nieuwe marker. */
CREATE FUNCTION proof.h_repost(_n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT public.post_bank_transaction(proof.uid(1000, _n));
$$;

/** De oudste directe bankgroep van testregel _n (het historische origineel). */
CREATE FUNCTION proof.h_orig(_n integer, _rank integer DEFAULT 1) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT grp FROM (
    SELECT lp.posting_group_id AS grp, min(lp.created_at) AS at, min(lp.id::text) AS tie
    FROM public.ledger_postings lp
    WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, _n)
    GROUP BY lp.posting_group_id
    ORDER BY 2, 3
    OFFSET _rank - 1 LIMIT 1) x;
$$;

/** De storno van een groep. */
CREATE FUNCTION proof.storno_of(_group uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.reversal_posting_group_id FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = _group;
$$;

/** Het oordeel van de hulpfunctie, als tekst (zodat een ontbrekende functie geen fout geeft). */
CREATE FUNCTION proof.settled(_n integer, _group uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v boolean;
BEGIN
  EXECUTE 'SELECT public.bank_transaction_group_is_settled_history($1, $2)' INTO v USING proof.uid(1000, _n), _group;
  RETURN v;
END $$;

/** Werkelijk corrupte geschiedenis nabootsen: alleen hier, in een wegwerpdatabase. */
CREATE FUNCTION proof.forge(_sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL session_replication_role = replica;
  ALTER TABLE public.ledger_postings DISABLE TRIGGER prevent_ledger_posting_mutation_trigger;
  EXECUTE _sql;
  ALTER TABLE public.ledger_postings ENABLE ALWAYS TRIGGER prevent_ledger_posting_mutation_trigger;
END $$;

/** De voorwaardencontrole uit een migratie weigert bij elke afwijking; de opzet
    wordt in een subtransactie teruggedraaid. */
CREATE FUNCTION proof.prereq_refuses(_n text, _name text, _setup text, _prereq text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE _setup;
    EXECUTE _prereq;
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'proof: geen weigering';
  EXCEPTION WHEN others THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  INSERT INTO proof.result VALUES (_n, _name,
    v_state = '55000' AND position(lower(_needle) IN lower(v_msg)) > 0, format('[%s] %s', v_state, v_msg));
END $$;

CREATE FUNCTION proof.prereq_passes(_prereq text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _prereq;
  RETURN 'ok';
EXCEPTION WHEN others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;

/** Een gewone app-UPDATE van de codering, als de echte rol (standaard de assistent). */
CREATE FUNCTION proof.app_code(_n integer, _user uuid DEFAULT '00000000-0000-0000-0000-0000000000e2',
                               _role text DEFAULT 'authenticated')
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format($q$UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L, btw_percentage = 0
                                     WHERE id = %L RETURNING id::text$q$, proof.acct(6), proof.uid(1000, _n)), _role);
$$;

/** Een directe herboeking via de schrijver, als de echte rol. */
CREATE FUNCTION proof.app_post(_n integer, _user uuid DEFAULT '00000000-0000-0000-0000-0000000000e2')
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, _n)));
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;
