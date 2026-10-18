-- HULPFUNCTIES VOOR PR 2 — throwaway database only. Never run against any BoekAssist database.
--
-- Bovenop ../bank-transaction-corrections/fixtures.sql (PR 1): dezelfde
-- organisaties, rollen, administraties, rekeningen en dezelfde aanroep van de
-- echte RPC's als de echte rol `authenticated`. Hier komt bij: de oorspronkelijke
-- bankomschrijving van elke testregel, byte voor byte vastgelegd, zodat elk
-- bewijs kan toetsen dat zij na een correctie exact gelijk is.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/** De bankomschrijving zoals zij geïmporteerd werd, als tekst én als bytes, plus
    de duplicaatsleutel op dat moment. */
CREATE TABLE proof.original (tx uuid PRIMARY KEY, description text, bytes bytea, dedup text);
GRANT ALL ON proof.original TO public;

/** Een banktransactie zoals een import haar invoegt, met een exacte omschrijving
    (ook NULL: _null => true). Legt de oorspronkelijke omschrijving vast. */
CREATE FUNCTION proof.btx(_n integer, _amount numeric, _desc text DEFAULT NULL, _null boolean DEFAULT false,
                          _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1',
                          _date date DEFAULT DATE '2027-03-01', _counter text DEFAULT NULL, _ref text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := proof.tx(_n, _amount, _client, _date, _desc);
  UPDATE public.bank_transactions SET
    description     = CASE WHEN _null THEN NULL ELSE description END,
    counter_account = _counter,
    reference       = _ref
  WHERE id = v;
  INSERT INTO proof.original
  SELECT id, description, convert_to(description, 'UTF8'), NULL FROM public.bank_transactions WHERE id = v;
  UPDATE proof.original SET dedup = proof.dedup_key(_n) WHERE tx = v;
  RETURN v;
END $$;

/** Is de bankomschrijving van testregel _n byte-gelijk aan de geïmporteerde (ook NULL)? */
CREATE FUNCTION proof.intact(_n integer) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT o.bytes IS NOT DISTINCT FROM convert_to(bt.description, 'UTF8')
     AND (o.description IS NULL) = (bt.description IS NULL)
  FROM proof.original o JOIN public.bank_transactions bt ON bt.id = o.tx
  WHERE o.tx = proof.uid(1000, _n);
$$;

/** Alle vastgelegde testregels byte-gelijk? (uitzonderingen: _except) */
CREATE FUNCTION proof.all_intact(_except integer[] DEFAULT '{}') RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(bool_and(o.bytes IS NOT DISTINCT FROM convert_to(bt.description, 'UTF8')
                           AND (o.description IS NULL) = (bt.description IS NULL)), true)
  FROM proof.original o JOIN public.bank_transactions bt ON bt.id = o.tx
  WHERE o.tx <> ALL (SELECT proof.uid(1000, x) FROM unnest(_except) x);
$$;

/** De tekst van de eerste regel van een groep: de boekingsomschrijving. */
CREATE FUNCTION proof.text_of(_group uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT lp.description FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _group ORDER BY lp.line_no, lp.id LIMIT 1;
$$;

/** Alle omschrijvingen van een groep, in regelvolgorde. */
CREATE FUNCTION proof.texts_of(_group uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(lp.description, ' / ' ORDER BY lp.line_no, lp.id) FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _group;
$$;

/** De boekingsomschrijving van de actieve directe boeking van testregel _n. */
CREATE FUNCTION proof.active_text(_n integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT proof.text_of(proof.marker(proof.uid(1000, _n)));
$$;

/** De sleutel waarop de import duplicaten herkent zonder TransactionID
    (src/lib/bank-statement-parser.ts, compositeKey): datum | bedrag | de eerste
    50 tekens van de omschrijving | tegenrekening. Plus de reference. */
CREATE FUNCTION proof.dedup_key(_n integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT concat_ws('|', bt.transaction_date::text, to_char(bt.amount, 'FM999999990.00'),
                   left(lower(btrim(coalesce(bt.description, ''), E' \t\r\n')), 50),
                   lower(btrim(coalesce(bt.counter_account, ''))), coalesce(btrim(bt.reference), ''))
  FROM public.bank_transactions bt WHERE bt.id = proof.uid(1000, _n);
$$;

/** De bankregel als jsonb, zonder de kolommen die een correctie hoort te zetten. */
CREATE FUNCTION proof.row_rest(_n integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(bt) - ARRAY['match_status', 'grootboekrekening_id', 'btw_percentage',
                              'matched_invoice_id', 'match_confidence', 'updated_at']
  FROM public.bank_transactions bt WHERE bt.id = proof.uid(1000, _n);
$$;

/** Vingerafdruk van élke andere tabel in de database (alle schema's behalve de
    systeemschema's en proof), dus alles behalve grootboekregels, storno's,
    markers, gebeurtenissen en de bankregels zelf. Moet na een correctie gelijk zijn:
    geen auditregel, geen bijwerking, nergens. */
CREATE FUNCTION proof.rest_digest() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE r record; v text; acc text := '';
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'proof')
      AND c.oid NOT IN ('public.ledger_postings'::regclass, 'public.ledger_reversal_postings'::regclass,
                        'public.bank_transaction_postings'::regclass, 'public.bank_transaction_posting_events'::regclass,
                        'public.bank_transactions'::regclass)
    ORDER BY c.oid::regclass::text
  LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(t::text, %L ORDER BY t::text), %L)) FROM %s t', ',', '', r.rel) INTO v;
    acc := acc || r.rel::text || '=' || v || ';';
  END LOOP;
  RETURN md5(acc);
END $$;

/** De rijen van één groep, als vingerafdruk: de oorspronkelijke grootboekhistorie. */
CREATE FUNCTION proof.group_digest(_group uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t WHERE t.posting_group_id = _group;
$$;

/** Het aantal storno's over alle directe groepen van testregel _n. */
CREATE FUNCTION proof.reversal_count(_n integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM public.ledger_reversal_postings r
  WHERE r.original_posting_group_id IN (SELECT DISTINCT lp.posting_group_id FROM public.ledger_postings lp
                                        WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, _n));
$$;

/** Het aantal directe groepen van testregel _n. */
CREATE FUNCTION proof.group_count(_n integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT lp.posting_group_id)::integer FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, _n);
$$;

/** De laatste gebeurtenis van testregel _n als "type|requested|replacement|superseded". */
CREATE FUNCTION proof.last_event(_n integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT concat_ws('|', e.event_type, coalesce(e.requested_description, '∅'),
                   coalesce(e.replacement_description, '∅'), coalesce(e.superseded_description, '∅'))
  FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, _n)
  ORDER BY e.seq DESC LIMIT 1;
$$;

/** Elke RPC-aanroep in de D-bewijzen loopt hierdoor: naast de uitkomst wordt
    vastgelegd of élke andere tabel gelijk bleef, of de bankregel buiten de
    coderingskolommen gelijk bleef, en of haar omschrijving byte-gelijk is. */
CREATE TABLE proof.watch (n integer, req integer, outcome text, rest_ok boolean, row_ok boolean, intact boolean);
GRANT ALL ON proof.watch TO public;

CREATE FUNCTION proof.rcw(_user uuid, _n integer, _expected uuid, _acct uuid, _pct numeric, _req integer,
                          _reason text DEFAULT NULL, _desc text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_rest text := proof.rest_digest(); v_row jsonb := proof.row_rest(_n); v text;
BEGIN
  v := proof.rc(_user, proof.uid(1000, _n), _expected, _acct, _pct, proof.req(_req), _reason, _desc);
  INSERT INTO proof.watch VALUES (_n, _req, v, proof.rest_digest() = v_rest,
                                  proof.row_rest(_n) IS NOT DISTINCT FROM v_row, proof.intact(_n));
  RETURN v;
END $$;

/** De actieve markergroep van testregel _n. */
CREATE FUNCTION proof.m(_n integer) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT proof.marker(proof.uid(1000, _n));
$$;

/** Een letterlijke waarde voor gebruik BINNEN een al gequote SQL-string (quotes verdubbeld). */
CREATE FUNCTION proof.lit2(_v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(quote_literal(_v), chr(39), chr(39) || chr(39));
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;
