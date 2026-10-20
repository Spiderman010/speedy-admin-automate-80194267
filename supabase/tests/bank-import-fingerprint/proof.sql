-- Bewijzen P1–P6 voor 20261020120000_add_bank_transaction_import_fingerprint.sql.
-- Throwaway database only. Draait NA twee toepassingen van de migratie en
-- vóórdat er een rij met vingerafdruk of bronformaat bestaat.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── P1. Kolommen, CHECKs en index: exacte definities; bestaande rijen onaangeroerd

SELECT proof.record('P1a', 'precies drie nieuwe kolommen, import_fingerprint, import_source en bank_reference: text, nullable, geen standaardwaarde, met commentaar',
  coalesce(bool_and(c.data_type = 'text' AND c.is_nullable = 'YES' AND c.column_default IS NULL
    AND col_description('public.bank_transactions'::regclass, c.ordinal_position::int)
        LIKE CASE c.column_name WHEN 'import_fingerprint' THEN 'SHA-256 (hex)%'
                                WHEN 'import_source' THEN 'Bestandsformaat waaruit%'
                                ELSE 'Referentie van de bank zelf%' END), false)
  AND array_agg(c.column_name::text ORDER BY c.column_name) = ARRAY['bank_reference', 'import_fingerprint', 'import_source'],
  string_agg(format('%s %s %s default=%s', c.column_name, c.data_type, c.is_nullable, c.column_default), '; ' ORDER BY c.column_name))
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'bank_transactions'
  AND c.column_name IN ('import_fingerprint', 'import_source', 'bank_reference');

SELECT proof.record('P1b', 'beide CHECKs (…_import_fingerprint_format, …_import_source_known): exacte expressie, gevalideerd',
  coalesce(bool_and(con.contype = 'c' AND con.convalidated
    AND pg_get_constraintdef(con.oid) = CASE con.conname
      WHEN 'bank_transactions_import_fingerprint_format'
        THEN $e$CHECK (((import_fingerprint IS NULL) OR (import_fingerprint ~ '^[0-9a-f]{64}$'::text)))$e$
      WHEN 'bank_transactions_import_source_known'
        THEN $e$CHECK (((import_source IS NULL) OR (import_source = ANY (ARRAY['mt940'::text, 'camt053'::text]))))$e$ END), false)
  AND array_agg(con.conname::text ORDER BY con.conname)
      = ARRAY['bank_transactions_import_fingerprint_format', 'bank_transactions_import_source_known'],
  string_agg(pg_get_constraintdef(con.oid), '; ' ORDER BY con.conname))
FROM pg_constraint con
WHERE con.conrelid = 'public.bank_transactions'::regclass
  AND con.conname IN ('bank_transactions_import_fingerprint_format', 'bank_transactions_import_source_known');

SELECT proof.record('P1c', 'index: UNIQUE, partieel (WHERE import_fingerprint IS NOT NULL), op (client_id, import_fingerprint), geldig',
  coalesce(bool_and(i.indisunique AND i.indisvalid AND i.indisready AND NOT i.indnullsnotdistinct AND NOT i.indisprimary
    AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) = '(import_fingerprint IS NOT NULL)'
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['client_id', 'import_fingerprint']::name[]
    AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX bank_transactions_client_import_fingerprint_key ON public.bank_transactions USING btree (client_id, import_fingerprint) WHERE (import_fingerprint IS NOT NULL)'),
    false) AND count(*) = 1,
  string_agg(pg_get_indexdef(i.indexrelid), ';'))
FROM pg_index i
WHERE i.indexrelid = to_regclass('public.bank_transactions_client_import_fingerprint_key')
  AND i.indrelid = 'public.bank_transactions'::regclass;

SELECT proof.record('P1d', 'import_fingerprint: één index en één constraint; import_source: geen index, één constraint; bank_reference: geen index, geen constraint; rest van de catalogus gelijk',
  (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
   WHERE i.indrelid = 'public.bank_transactions'::regclass AND a.attname = 'import_fingerprint') = 1
  AND (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
   WHERE i.indrelid = 'public.bank_transactions'::regclass AND a.attname = 'import_source') = 0
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.bank_transactions'::regclass
       AND pg_get_constraintdef(oid) LIKE '%import_fingerprint%') = 1
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.bank_transactions'::regclass
       AND pg_get_constraintdef(oid) LIKE '%import_source%') = 1
  AND (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
   WHERE i.indrelid = 'public.bank_transactions'::regclass AND a.attname = 'bank_reference') = 0
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.bank_transactions'::regclass
       AND pg_get_constraintdef(oid) LIKE '%bank_reference%') = 0
  AND proof.catalog_rest() = (SELECT v FROM proof.state WHERE k = 'catalog_before'));

SELECT proof.record('P1e', 'bestaande rijen: zelfde aantal, inhoud byte-gelijk (digest), vingerafdruk, bronformaat en bankreferentie overal NULL',
  (SELECT count(*)::text FROM public.bank_transactions) = (SELECT v FROM proof.state WHERE k = 'rows_before')
  AND proof.digest() = (SELECT v FROM proof.state WHERE k = 'digest_before')
  AND NOT EXISTS (SELECT 1 FROM public.bank_transactions
                  WHERE import_fingerprint IS NOT NULL OR import_source IS NOT NULL OR bank_reference IS NOT NULL),
  format('rijen=%s digest=%s', (SELECT count(*) FROM public.bank_transactions), proof.digest()));

SELECT proof.record('P1f', 'geen herschrijving en geen UPDATE: relfilenode, ctid en xmin van elke rij ongewijzigd',
  (SELECT relfilenode::text FROM pg_class WHERE oid = 'public.bank_transactions'::regclass)
    = (SELECT v FROM proof.state WHERE k = 'relfilenode_before')
  AND proof.physical() = (SELECT v FROM proof.state WHERE k = 'physical_before'));

-- ── P2. Historische exacte duplicaten laten de migratie niet falen ──────────

SELECT proof.record('P2a', 'de migratie slaagde (2x) terwijl er historische groepen met identieke inhoud bestaan',
  (SELECT count(*) FROM (
     SELECT 1 FROM public.bank_transactions
     GROUP BY client_id, transaction_date, amount, description, counter_account, reference
     HAVING count(*) > 1) g) = 2
  AND (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.bank_transactions_client_import_fingerprint_key')),
  'groepen: parkeren (b001/b002) en dubbele import BANKREF-0001 (b003/b004)');

SELECT proof.record('P2b', 'een historische rij nog eens zonder vingerafdruk importeren blijft mogelijk (NULL botst nooit)',
  proof.attempt($s$INSERT INTO public.bank_transactions
      (user_id, client_id, organization_id, transaction_date, description, amount, counter_account, reference)
    SELECT user_id, client_id, organization_id, transaction_date, description, amount, counter_account, reference
    FROM public.bank_transactions WHERE id = '00000000-0000-0000-0000-00000000b003'$s$) = 'ok');

-- ── P3. Uniek per administratie, en alleen daar ─────────────────────────────

CREATE TEMP TABLE o (n text PRIMARY KEY, v text);
GRANT INSERT, SELECT ON o TO authenticated;   -- P5 schrijft zijn uitkomsten als authenticated

INSERT INTO o VALUES ('P3a', proof.attempt(proof.import_sql(proof.fp('X'), 'X eerste import')));
SELECT proof.record('P3a', 'vingerafdruk X in administratie A: toegestaan', v = 'ok', v) FROM o WHERE n = 'P3a';

INSERT INTO o VALUES ('P3b', proof.attempt(proof.import_sql(proof.fp('X'), 'X tweede import')));
SELECT proof.record('P3b', 'X nogmaals in A: 23505 en de melding noemt de index',
  v LIKE '23505: %bank_transactions_client_import_fingerprint_key%', v) FROM o WHERE n = 'P3b';

INSERT INTO o VALUES ('P3c', proof.attempt(proof.import_sql(proof.fp('X'), 'X in B', '00000000-0000-0000-0000-0000000c0002')));
SELECT proof.record('P3c', 'X in een andere administratie (B, zelfde organisatie): toegestaan', v = 'ok', v) FROM o WHERE n = 'P3c';

INSERT INTO o VALUES ('P3d', proof.attempt(proof.import_sql(proof.fp('X'), 'X in andere organisatie',
  '00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000e3')));
SELECT proof.record('P3d', 'X in een administratie van een andere organisatie: toegestaan', v = 'ok', v) FROM o WHERE n = 'P3d';

SELECT proof.record('P3e', 'X staat precies één keer in A, één keer in B, één keer in C',
  (SELECT array_agg(n ORDER BY client_id) FROM (SELECT client_id, count(*) AS n FROM public.bank_transactions
     WHERE import_fingerprint = proof.fp('X') GROUP BY client_id) s) = ARRAY[1, 1, 1]::bigint[]);

INSERT INTO o VALUES ('P3f', proof.attempt(proof.import_sql(proof.fp('parkeren-ref-1'), 'PARKEREN Q-PARK'))
                       || ' / ' || proof.attempt(proof.import_sql(proof.fp('parkeren-ref-2'), 'PARKEREN Q-PARK')));
SELECT proof.record('P3f', 'twee op inhoud identieke betalingen met verschillende vingerafdruk: beide toegestaan',
  v = 'ok / ok' AND (SELECT count(*) FROM public.bank_transactions
                     WHERE import_fingerprint IN (proof.fp('parkeren-ref-1'), proof.fp('parkeren-ref-2'))) = 2, v)
FROM o WHERE n = 'P3f';

INSERT INTO o VALUES ('P3g', proof.attempt(proof.import_sql(NULL, 'zonder afdruk')) || ' / '
                       || proof.attempt(proof.import_sql(NULL, 'zonder afdruk')) || ' / '
                       || proof.attempt(proof.import_sql(NULL, 'zonder afdruk')));
SELECT proof.record('P3g', 'drie identieke rijen zonder vingerafdruk in dezelfde administratie: alle toegestaan',
  v = 'ok / ok / ok' AND (SELECT count(*) FROM public.bank_transactions WHERE description = 'zonder afdruk') = 3, v)
FROM o WHERE n = 'P3g';

INSERT INTO o VALUES ('P3h', proof.attempt($s$UPDATE public.bank_transactions SET import_fingerprint = proof.fp('X')
                                             WHERE id = '00000000-0000-0000-0000-00000000b005'$s$));
SELECT proof.record('P3h', 'ook via UPDATE kan X geen tweede keer in A: 23505',
  v LIKE '23505: %bank_transactions_client_import_fingerprint_key%', v) FROM o WHERE n = 'P3h';

INSERT INTO o VALUES ('P3i', proof.attempt(format($s$INSERT INTO public.bank_transactions
      (user_id, client_id, organization_id, transaction_date, description, amount, import_fingerprint)
    VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '2026-04-01', 'batch 1', -1.00, %L),
           ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '2026-04-01', 'batch 2', -2.00, %L),
           ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '2026-04-01', 'batch 3', -3.00, %L)$s$,
    proof.fp('batch-1'), proof.fp('X'), proof.fp('batch-3'))));
SELECT proof.record('P3i', 'een afschrift in één INSERT met één al bekende regel: 23505 en geen enkele regel van die INSERT blijft staan',
  v LIKE '23505: %' AND NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE description LIKE 'batch %'), v)
FROM o WHERE n = 'P3i';

INSERT INTO o VALUES ('P3j', proof.attempt(format($s$INSERT INTO public.bank_transactions
      (user_id, client_id, organization_id, transaction_date, description, amount, import_fingerprint)
    VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '2026-04-02', 'zelfde statement', -1.00, %L),
           ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '2026-04-02', 'zelfde statement', -1.00, %L)$s$,
    proof.fp('Y-self'), proof.fp('Y-self'))));
SELECT proof.record('P3j', 'dezelfde vingerafdruk twee keer binnen één INSERT: 23505, niets geschreven',
  v LIKE '23505: %' AND NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE import_fingerprint = proof.fp('Y-self')), v)
FROM o WHERE n = 'P3j';

INSERT INTO o VALUES ('P3k', proof.attempt(proof.import_sql(proof.fp('X'), 'X via ON CONFLICT')
  || ' ON CONFLICT (client_id, import_fingerprint) WHERE import_fingerprint IS NOT NULL DO NOTHING'));
SELECT proof.record('P3k', 'ON CONFLICT (client_id, import_fingerprint) WHERE … DO NOTHING herkent de partiële index (geen fout, niets erbij)',
  v = 'ok' AND (SELECT count(*) FROM public.bank_transactions
                WHERE import_fingerprint = proof.fp('X') AND client_id = '00000000-0000-0000-0000-0000000c0001') = 1, v)
FROM o WHERE n = 'P3k';

-- ── P4. Vorm: alleen 64 kleine hex-tekens ───────────────────────────────────

INSERT INTO o
SELECT 'P4-' || label, proof.attempt(proof.import_sql(val, 'misvormd ' || label))
FROM (VALUES
  ('hoofdletters', upper(proof.fp('U'))),
  ('63-tekens',    left(proof.fp('S'), 63)),
  ('65-tekens',    proof.fp('L') || 'a'),
  ('niet-hex',     'g' || right(proof.fp('G'), 63)),
  ('leeg',         ''),
  ('spatie',       ' ' || right(proof.fp('W'), 63)),
  ('newline',      proof.fp('N') || E'\n')) v(label, val);

SELECT proof.record('P4a', 'misvormde vingerafdruk (hoofdletters, 63/65 tekens, niet-hex, leeg, spatie, newline): elk 23514 op de CHECK',
  count(*) = 7 AND bool_and(v LIKE '23514: %bank_transactions_import_fingerprint_format%'),
  string_agg(n || '=' || left(v, 5), ' ' ORDER BY n))
FROM o WHERE n LIKE 'P4-%';

SELECT proof.record('P4b', 'geen misvormde rij geschreven',
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE description LIKE 'misvormd %'));

INSERT INTO o VALUES ('P4c', proof.attempt($s$UPDATE public.bank_transactions SET import_fingerprint = 'ABC'
                                             WHERE id = '00000000-0000-0000-0000-00000000b005'$s$));
SELECT proof.record('P4c', 'ook via UPDATE: 23514', v LIKE '23514: %', v) FROM o WHERE n = 'P4c';

-- ── P5. Als authenticated, onder RLS; RLS en rechten ongewijzigd ────────────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);   -- assistent, organisatie a001

INSERT INTO o VALUES ('P5a', proof.attempt(proof.import_sql(proof.fp('Z'), 'Z als assistent')));
INSERT INTO o VALUES ('P5b', proof.attempt(proof.import_sql(proof.fp('Z'), 'Z als assistent, tweede keer')));
INSERT INTO o VALUES ('P5c', (SELECT count(*)::text FROM public.bank_transactions WHERE import_fingerprint = proof.fp('Z')));

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);   -- buitenstaander, organisatie a002
INSERT INTO o VALUES ('P5d', proof.attempt(proof.import_sql(proof.fp('Z'), 'Z door buitenstaander in A',
  '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e3')));
INSERT INTO o VALUES ('P5e', proof.attempt(proof.import_sql(proof.fp('Z'), 'Z door buitenstaander in eigen C',
  '00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000e3')));
INSERT INTO o VALUES ('P5f', (SELECT count(*)::text FROM public.bank_transactions
                              WHERE client_id = '00000000-0000-0000-0000-0000000c0001'));
RESET ROLE;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.record('P5a', 'authenticated assistent importeert Z in A: toegestaan', v = 'ok', v) FROM o WHERE n = 'P5a';
SELECT proof.record('P5b', 'authenticated assistent importeert Z nogmaals: 23505 (wat de app als "al geïmporteerd" herkent)',
  v LIKE '23505: %bank_transactions_client_import_fingerprint_key%', v) FROM o WHERE n = 'P5b';
SELECT proof.record('P5c', 'de assistent ziet precies één rij met Z', v = '1', v) FROM o WHERE n = 'P5c';
SELECT proof.record('P5d', 'buitenstaander met Z in A: 42501 door RLS, géén 23505 (de index verraadt geen vreemde rijen)',
  v LIKE '42501: %', v) FROM o WHERE n = 'P5d';
SELECT proof.record('P5e', 'buitenstaander met dezelfde Z in de eigen administratie: toegestaan', v = 'ok', v) FROM o WHERE n = 'P5e';
SELECT proof.record('P5f', 'buitenstaander ziet geen enkele rij van A (leespolicy ongewijzigd)', v = '0', v) FROM o WHERE n = 'P5f';

SELECT proof.record('P5g', 'pg_policies op bank_transactions letterlijk gelijk aan vóór de migratie (4 rolpolicies)',
  proof.policies() = (SELECT v FROM proof.state WHERE k = 'policies_before')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions') = 4,
  (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions'));

SELECT proof.record('P5h', 'relacl, RLS aan, FORCE uit en eigenaar van bank_transactions ongewijzigd; geen kolomrechten',
  proof.acl() = (SELECT v FROM proof.state WHERE k = 'acl_before')
  AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.bank_transactions'::regclass AND attacl IS NOT NULL),
  proof.acl());

-- ── P6. Bronformaat: alleen 'mt940', 'camt053' of NULL ──────────────────────

INSERT INTO o
SELECT 'P6-' || label, proof.attempt(proof.import_sql(proof.fp('src-' || label), 'bron ' || label,
  _source => val))
FROM (VALUES ('mt940', 'mt940'), ('camt053', 'camt053'), ('null', NULL)) v(label, val);
SELECT proof.record('P6a', 'import_source mt940, camt053 en NULL: elk toegestaan',
  count(*) = 3 AND bool_and(v = 'ok')
  AND (SELECT array_agg(coalesce(import_source, '<null>') ORDER BY description) FROM public.bank_transactions
       WHERE description IN ('bron camt053', 'bron mt940', 'bron null')) = ARRAY['camt053', 'mt940', '<null>'],
  string_agg(n || '=' || v, ' ' ORDER BY n))
FROM o WHERE n IN ('P6-mt940', 'P6-camt053', 'P6-null');

INSERT INTO o
SELECT 'P6x-' || label, proof.attempt(proof.import_sql(proof.fp('srcx-' || label), 'bron fout ' || label,
  _source => val))
FROM (VALUES ('MT940', 'MT940'), ('csv', 'csv'), ('leeg', ''), ('spatie', 'mt940 ')) v(label, val);
SELECT proof.record('P6b', 'import_source MT940, csv, leeg en ''mt940 '' bij INSERT: elk 23514 op …_import_source_known, niets geschreven',
  count(*) = 4 AND bool_and(v LIKE '23514: %bank_transactions_import_source_known%')
  AND NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE description LIKE 'bron fout %'),
  string_agg(n || '=' || left(v, 5), ' ' ORDER BY n))
FROM o WHERE n LIKE 'P6x-%';

-- UPDATE op de rij uit P6a (geen historische rij: die moeten fysiek onaangeroerd blijven).
INSERT INTO o
SELECT 'P6u-' || label, proof.attempt(format(
  $s$UPDATE public.bank_transactions SET import_source = %L WHERE description = 'bron mt940'$s$, val))
FROM (VALUES ('MT940', 'MT940'), ('csv', 'csv'), ('leeg', '')) v(label, val);
SELECT proof.record('P6c', 'import_source MT940, csv en leeg bij UPDATE: elk 23514, de rij houdt mt940',
  count(*) = 3 AND bool_and(v LIKE '23514: %bank_transactions_import_source_known%')
  AND (SELECT import_source FROM public.bank_transactions WHERE description = 'bron mt940') = 'mt940',
  string_agg(n || '=' || left(v, 5), ' ' ORDER BY n))
FROM o WHERE n LIKE 'P6u-%';

INSERT INTO o VALUES ('P6d', proof.attempt(
  $s$UPDATE public.bank_transactions SET import_source = 'camt053' WHERE description = 'bron null'$s$)
  || ' / ' || proof.attempt(
  $s$UPDATE public.bank_transactions SET import_source = NULL WHERE description = 'bron camt053'$s$));
SELECT proof.record('P6d', 'UPDATE naar een geldig formaat of terug naar NULL: toegestaan',
  v = 'ok / ok'
  AND (SELECT import_source FROM public.bank_transactions WHERE description = 'bron null') = 'camt053'
  AND (SELECT import_source FROM public.bank_transactions WHERE description = 'bron camt053') IS NULL, v)
FROM o WHERE n = 'P6d';

SELECT proof.record('P6e', 'historische rijen hebben nog steeds import_source NULL',
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE id = ANY (proof.historical()) AND import_source IS NOT NULL));

-- ── P7. Bankreferentie: vrije tekst zoals de bank haar levert, of NULL ───────

INSERT INTO o VALUES ('P7a', proof.attempt(format(
  $s$UPDATE public.bank_transactions SET bank_reference = %L WHERE description = 'bron camt053'$s$, 'ACCTSVCR-2026-0001'))
  || ' / ' || proof.attempt(
  $s$UPDATE public.bank_transactions SET bank_reference = NULL WHERE description = 'bron mt940'$s$));
SELECT proof.record('P7a', 'bank_reference: tekst en NULL toegestaan, ongewijzigd bewaard',
  v = 'ok / ok'
  AND (SELECT bank_reference FROM public.bank_transactions WHERE description = 'bron camt053') = 'ACCTSVCR-2026-0001'
  AND (SELECT bank_reference FROM public.bank_transactions WHERE description = 'bron mt940') IS NULL, v)
FROM o WHERE n = 'P7a';

INSERT INTO o VALUES ('P7b', proof.attempt(format(
  $s$UPDATE public.bank_transactions SET bank_reference = %L WHERE description = 'bron null'$s$, 'ACCTSVCR-2026-0001')));
SELECT proof.record('P7b', 'bank_reference is geen sleutel: dezelfde waarde op twee rijen wordt niet geweigerd (de app beslist over vertrouwen)',
  v = 'ok' AND (SELECT count(*) FROM public.bank_transactions WHERE bank_reference = 'ACCTSVCR-2026-0001') = 2, v)
FROM o WHERE n = 'P7b';

SELECT proof.record('P7c', 'historische rijen hebben nog steeds bank_reference NULL',
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE id = ANY (proof.historical()) AND bank_reference IS NOT NULL));
