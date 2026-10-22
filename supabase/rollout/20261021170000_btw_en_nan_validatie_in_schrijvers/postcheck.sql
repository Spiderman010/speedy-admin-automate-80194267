-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles ná 20261021170000_btw_en_nan_validatie_in_schrijvers.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- hetzelfde editortabblad als de PRE. Alles hieronder is ALLEEN LEZEN; er wordt
-- niets getest door te schrijven — geen testdata in productie. Het gedrag
-- (NULL-btw geweigerd, expliciet 0 geboekt, vrijgesteld met btw geweigerd, NaN
-- geweigerd door elke schrijver en elke CHECK) is bewezen in
-- supabase/tests/writer-vat-nan-validation/; hier wordt bewezen dat productie
-- exact die functies en constraints draagt en dat verder niets veranderde.
--
-- Bij ELKE afwijking: STOP, niets herstellen, uitkomst doorgeven. De rollback
-- (rollback.sql in deze map) vraagt akkoord van de eigenaar.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. De vijf functies: exact de nieuwe lichamen, rechten exact ───────
-- Verwacht: 5 rijen, elke booleaanse kolom `true`.
SELECT h.naam,
       coalesce(md5(p.prosrc) = h.verwacht, false)                             AS lichaam_exact,
       coalesce(p.prosecdef = h.definer, false)                                AS security_als_voorheen,
       coalesce(p.proconfig = ARRAY['search_path=public'], false)              AS search_path_vast,
       p.oid IS NOT NULL
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS uitvoerrecht_exact
FROM (VALUES
  ('post_purchase_invoice(uuid)',                '4d183b1e5fe11f37d508a3e7f764176f', true),
  ('post_sales_invoice(uuid)',                   'd05b6c0a4b9c3dd6ef6a835ff37f9b64', true),
  ('post_bank_transaction(uuid)',                '28ac97ed4e030759bbb31082da50c118', true),
  ('bank_bulk_posting_candidates(uuid,integer)', '4b04544d2292704d8ac034edc909055c', false),
  ('post_bank_transactions_bulk(uuid[])',        '885fe27bd78d6cc3836fc760412015ed', false)) h(naam, verwacht, definer)
LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || h.naam)
ORDER BY h.naam;


-- ── POST 2. De vijf CHECK-constraints: aanwezig, exact, NOT VALID ───────────
-- Verwacht: 5 rijen, `definitie_exact` en `nog_niet_gevalideerd` overal `true`.
-- (`nog_niet_gevalideerd` wordt pas `false` na de aparte VALIDATE.)
SELECT d.tabel, d.naam,
       coalesce(pg_get_constraintdef(c.oid) = d.definitie, false) AS definitie_exact,
       coalesce(NOT c.convalidated, false)                        AS nog_niet_gevalideerd
FROM (VALUES
  ('ledger_postings', 'ledger_postings_amounts_not_nan',
   'CHECK (((debit_amount <> ''NaN''::numeric) AND (credit_amount <> ''NaN''::numeric))) NOT VALID'),
  ('purchase_invoices', 'purchase_invoices_amounts_not_nan',
   'CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric))) NOT VALID'),
  ('sales_invoices', 'sales_invoices_amounts_not_nan',
   'CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric))) NOT VALID'),
  ('purchase_invoice_lines', 'purchase_invoice_lines_amount_finite',
   'CHECK (((amount_excl <> ''NaN''::numeric) AND (amount_excl <> ''Infinity''::numeric) AND (amount_excl <> ''-Infinity''::numeric))) NOT VALID'),
  ('bank_transactions', 'bank_transactions_amount_not_nan',
   'CHECK ((amount <> ''NaN''::numeric)) NOT VALID')) d(tabel, naam, definitie)
LEFT JOIN pg_constraint c
       ON c.conname = d.naam AND c.conrelid = to_regclass('public.' || d.tabel) AND c.contype = 'c'
ORDER BY d.tabel;


-- ── POST 3. De grootboekfundering heel: haar eigen CHECK's staan er nog ─────
-- Verwacht: één rij, `true`. (Er zijn alleen constraints bijgekomen.)
SELECT
  (SELECT count(*) FROM pg_constraint
   WHERE conrelid = 'public.ledger_postings'::regclass AND contype = 'c' AND convalidated
     AND conname IN ('ledger_postings_debit_amount_check', 'ledger_postings_credit_amount_check',
                     'ledger_postings_single_side_check')) = 3                      AS grootboek_checks_intact;


-- ── POST 4. Vingerafdruk: gelijk aan PRE 6 ──────────────────────────────────
-- Verwacht: alle vier kolommen exact gelijk aan PRE 6. Geen andere functie
-- gewijzigd, geen trigger, RULE of policy bij of weg, geen rij toegevoegd,
-- gewijzigd of verwijderd (geen backfill).
SELECT
  (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text))
   FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid NOT IN (to_regprocedure('public.post_purchase_invoice(uuid)'),
                       to_regprocedure('public.post_sales_invoice(uuid)'),
                       to_regprocedure('public.post_bank_transaction(uuid)'),
                       to_regprocedure('public.bank_bulk_posting_candidates(uuid,integer)'),
                       to_regprocedure('public.post_bank_transactions_bulk(uuid[])')))  AS andere_functies,
  concat_ws('/',
    (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
       AND t.tgrelid IN ('public.ledger_postings'::regclass, 'public.purchase_invoices'::regclass,
                         'public.sales_invoices'::regclass, 'public.purchase_invoice_lines'::regclass,
                         'public.bank_transactions'::regclass)),
    (SELECT count(*) FROM pg_rules r WHERE r.schemaname = 'public'),
    (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public'))             AS triggers_rules_policies,
  concat_ws('/', (SELECT count(*) FROM public.ledger_postings), (SELECT count(*) FROM public.purchase_invoices),
                 (SELECT count(*) FROM public.sales_invoices), (SELECT count(*) FROM public.purchase_invoice_lines),
                 (SELECT count(*) FROM public.bank_transactions))                    AS rijen,
  md5(concat_ws('/',
    (SELECT sum(debit_amount) || ':' || sum(credit_amount) FROM public.ledger_postings),
    (SELECT sum(amount_excl) || ':' || sum(btw_amount) || ':' || sum(amount_incl) || ':' || count(btw_percentage) FROM public.purchase_invoices),
    (SELECT sum(amount_excl) || ':' || sum(btw_amount) || ':' || sum(amount_incl) || ':' || count(btw_percentage) FROM public.sales_invoices),
    (SELECT sum(amount_excl) || ':' || count(btw_percentage) FROM public.purchase_invoice_lines),
    (SELECT sum(amount) || ':' || count(btw_percentage) || ':' || count(grootboekrekening_id) FROM public.bank_transactions)))
                                                                                    AS bedragen;
