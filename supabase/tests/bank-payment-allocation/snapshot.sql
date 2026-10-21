-- Momentopname vóór P5a: data en de catalogus die P5a NIET mag raken.
-- Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/** Alle bedrijfsdata die P5a nooit mag wijzigen. created_by valt erbuiten:
    die kolom bestaat pas na P5a en moet voor bestaande rijen leeg blijven
    (dat toetst A5 apart). */
CREATE FUNCTION proof.p5data() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT md5(coalesce(string_agg((to_jsonb(t) - 'created_by')::text, ',' ORDER BY t.id), '')) FROM public.bank_transaction_allocations t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM public.bank_transactions t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM public.purchase_invoices t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM public.sales_invoices t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM public.bank_match_rejections t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.allocation_id), '')) FROM public.bank_allocation_postings t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.bank_transaction_id), '')) FROM public.bank_transaction_postings t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.sales_invoice_id), '')) FROM public.sales_invoice_postings t),
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.purchase_invoice_id), '')) FROM public.purchase_invoice_postings t)));
$$;

/** Catalogus die P5a niet mag raken: triggers op bank_transactions (naam, functie,
    md5, stand), de policies en tabelrechten van de vijf brontabellen, en de
    lichamen van de bestaande schrijvers en guards. */
CREATE FUNCTION proof.p5catalog() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT string_agg(format('%s:%s:%s:%s', t.tgname, p.proname, md5(p.prosrc), t.tgenabled), ',' ORDER BY t.tgname)
     FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal),
    (SELECT string_agg(format('%s:%s:%s:%s:%s', tablename, policyname, cmd, qual, with_check), ',' ORDER BY tablename, policyname)
     FROM pg_policies WHERE schemaname = 'public'
       AND tablename IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices', 'sales_invoices',
                         'purchase_invoice_lines', 'bank_match_rejections')),
    (SELECT string_agg(format('%s:%s', c.relname, c.relacl::text), ',' ORDER BY c.relname)
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices', 'sales_invoices',
                         'bank_match_rejections', 'ledger_postings')),
    (SELECT string_agg(format('%s:%s', p.proname, md5(p.prosrc)), ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('post_bank_allocation', 'post_bank_transaction', 'post_sales_invoice', 'post_purchase_invoice',
                         'reverse_posting_group', 'reclassify_bank_transaction', 'release_bank_transaction_posting',
                         'return_bank_transaction_to_workflow', 'enforce_bank_allocation_not_directly_posted',
                         'enforce_bank_allocation_not_released', 'enforce_bank_match_rejection_scope',
                         'prevent_posted_bank_allocation_mutation', 'prevent_posted_purchase_invoice_mutation'))));
$$;

GRANT EXECUTE ON FUNCTION proof.p5data(), proof.p5catalog() TO public;

SELECT proof.put('snap_data', proof.p5data());
SELECT proof.put('snap_catalog', proof.p5catalog());
SELECT proof.put('snap_alloc_count', (SELECT count(*)::text FROM public.bank_transaction_allocations));
SELECT proof.put('snap_sales_md5', (SELECT md5(prosrc) FROM pg_proc
                                    WHERE oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure));
