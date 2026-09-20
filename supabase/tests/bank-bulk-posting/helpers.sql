-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- De hulpmiddelen van het bulkbewijs. Dezelfde vorm als in
-- ../bank-transaction-posting/proof.sql, hier apart gezet omdat dit bewijs die
-- 53 beweringen niet nog een keer hoeft te doen — het leunt erop dat ze elders
-- al bewezen zijn en toetst uitsluitend de bulklaag erbovenop.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE IF NOT EXISTS proof.result (
  n      text,
  name   text,
  ok     boolean,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END $$;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('andere fout dan verwacht (%s): %s', _needle, v_msg));
  END IF;
END $$;

/*
 * De VOLLEDIGE identiteit van een fout: SQLSTATE én de hele boodschap. Voor de
 * tenantpoort is een substringvergelijking niet genoeg — de claim is dat twee
 * antwoorden letterlijk hetzelfde zijn.
 */
CREATE OR REPLACE FUNCTION proof.identity(_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  EXECUTE _sql;
  RETURN 'GEEN FOUT';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || ' | ' || v_msg;
END $$;

/* Eén regel van een boeking: rekeningnummer|debet|credit. */
CREATE OR REPLACE FUNCTION proof.line(_group uuid, _line_no integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT format('%s|%s|%s', g.nummer, lp.debit_amount, lp.credit_amount)
  FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.posting_group_id = _group AND lp.line_no = _line_no;
$$;

/* Tellen buiten RLS om, zodat een telling vóór en ná hetzelfde meet. */
CREATE OR REPLACE FUNCTION proof.marker_count(_tx uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
$$;

CREATE OR REPLACE FUNCTION proof.ledger_count(_tx uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FROM public.ledger_postings WHERE source_id = _tx;
$$;

CREATE OR REPLACE FUNCTION proof.group_of(_tx uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT posting_group_id FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
$$;

/*
 * Eén bulkaanroep uitvoeren en het resultaat platslaan tot één vergelijkbare
 * tekst per regel: "ordinal|outcome|heeft-groep".
 */
CREATE OR REPLACE FUNCTION proof.bulk_shape(_ids uuid[])
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(format('%s|%s|%s', r.ordinal, r.outcome, (r.posting_group_id IS NOT NULL)::text), ' ' ORDER BY r.ordinal)
  FROM public.post_bank_transactions_bulk(_ids) r;
$$;

/* De volledige, voor de gebruiker zichtbare identiteit van één resultaatrij. */
CREATE OR REPLACE FUNCTION proof.bulk_identity(_ids uuid[])
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(format('%s | %s | %s', r.outcome, COALESCE(r.error_code, '-'), COALESCE(r.message, '-')),
                    E'\n' ORDER BY r.ordinal)
  FROM public.post_bank_transactions_bulk(_ids) r;
$$;

GRANT EXECUTE ON FUNCTION proof.expect_true(text, text, text)          TO public;
GRANT EXECUTE ON FUNCTION proof.expect_error(text, text, text, text)   TO public;
GRANT EXECUTE ON FUNCTION proof.identity(text)                         TO public;
GRANT EXECUTE ON FUNCTION proof.line(uuid, integer)                    TO public;
GRANT EXECUTE ON FUNCTION proof.marker_count(uuid)                     TO public;
GRANT EXECUTE ON FUNCTION proof.ledger_count(uuid)                     TO public;
GRANT EXECUTE ON FUNCTION proof.group_of(uuid)                         TO public;
GRANT EXECUTE ON FUNCTION proof.bulk_shape(uuid[])                     TO public;
GRANT EXECUTE ON FUNCTION proof.bulk_identity(uuid[])                  TO public;
