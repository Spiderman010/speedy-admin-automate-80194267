-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles direct ná 20261021180000_add_atomic_bank_payment_link.sql (P5a)
--
-- UITSLUITEND in de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`
-- (zie preflight.sql). Alles hieronder is ALLEEN LEZEN.
--
-- STOP en melden (niets herstellen) als:
--   • POST 1 ergens `false` geeft;
--   • POST 2 afwijkt van PRE 6 (een rij is gewijzigd: er mag niets zijn
--     herschreven — voorwaarde 8);
--   • POST 3 iets anders dan 0 / 0 / 0 geeft;
--   • POST 4 afwijkt van PRE 2.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. Structuur, rechten en RLS ───────────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  -- De twee RPC's: SECURITY DEFINER, vaste search_path, alleen authenticated mag uitvoeren.
  (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=public'])
   FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)'),
                   to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)')))
  AND (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN (to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)'),
                       to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)'))) = 2   AS rpcs_aanwezig,
  has_function_privilege('authenticated', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE') AS rpc_rechten,
  NOT EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(role)
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('bank_payment_min_role', 'bank_payment_writer_active', 'bank_payment_allocation_writer_active',
                        'bank_payment_tx_released', 'bank_payment_assert_consistent', 'stamp_bank_payment_record',
                        'prevent_bank_payment_record_mutation', 'guard_bank_allocation_write',
                        'enforce_bank_allocation_integrity', 'enforce_bank_match_rejection_not_linked',
                        'verify_bank_payment_event')
      AND has_function_privilege(r.role, p.oid, 'EXECUTE'))
  AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('bank_payment_min_role', 'bank_payment_writer_active', 'bank_payment_allocation_writer_active',
                         'bank_payment_tx_released', 'bank_payment_assert_consistent', 'stamp_bank_payment_record',
                         'prevent_bank_payment_record_mutation', 'guard_bank_allocation_write',
                         'enforce_bank_allocation_integrity', 'enforce_bank_match_rejection_not_linked',
                         'verify_bank_payment_event')) = 11                                    AS interne_functies_dicht,
  (SELECT bool_and(c.relrowsecurity) FROM pg_class c
   WHERE c.oid IN (to_regclass('public.bank_payment_requests'), to_regclass('public.bank_payment_events')))
    AND has_table_privilege('authenticated', 'public.bank_payment_events', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.bank_payment_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('authenticated', 'public.bank_payment_requests', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.bank_payment_requests', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.bank_payment_events', 'SELECT')
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('bank_payment_requests', 'bank_payment_events')) = 2               AS audit_tabellen,
  (SELECT is_nullable = 'YES' AND column_default = 'auth.uid()' FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'bank_transaction_allocations' AND column_name = 'created_by') AS created_by_kolom,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
     'guard_bank_allocation_write_trigger', 'validate_bank_allocation_integrity_trigger',
     'validate_bank_match_rejection_not_linked_trigger', 'verify_bank_payment_event_trigger',
     'stamp_bank_payment_request_trigger', 'stamp_bank_payment_event_trigger')) = 6
  AND (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'A' AND tgname IN (
     'prevent_bank_payment_request_mutation_trigger', 'prevent_bank_payment_request_truncate_trigger',
     'prevent_bank_payment_event_mutation_trigger', 'prevent_bank_payment_event_truncate_trigger')) = 4 AS triggers,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure)
    = 'd7fa08d5356e5f0152928aa7f03438ad'                                                       AS verkooptrigger_p5a;


-- ── POST 2. Geen enkele bestaande rij gewijzigd (vergelijk met PRE 6) ──────
-- Verwacht: exact dezelfde waarden als PRE 6, en created_by_gevuld = 0.
SELECT
  (SELECT count(*) FROM public.bank_transaction_allocations)                   AS koppelingen,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', id, bank_transaction_id, invoice_type, invoice_id,
                                          client_id, organization_id, amount, user_id), ',' ORDER BY id), '')
       FROM public.bank_transaction_allocations))                             AS koppelingen_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s', id, remaining_amount, status), ',' ORDER BY id), '')
       FROM public.purchase_invoices))                                         AS inkoop_restant_status_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s', id, remaining_amount, status), ',' ORDER BY id), '')
       FROM public.sales_invoices))                                            AS verkoop_restant_status_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, match_status, matched_invoice_id, match_confidence), ',' ORDER BY id), '')
       FROM public.bank_transactions))                                         AS bank_match_md5,
  (SELECT count(*) FROM public.bank_transaction_allocations WHERE created_by IS NOT NULL) AS created_by_gevuld;


-- ── POST 3. Nog geen claims of gebeurtenissen ───────────────────────────────
-- Verwacht: 0 | 0 | 0 (direct na de migratie, vóór het eerste gebruik).
SELECT (SELECT count(*) FROM public.bank_payment_requests) AS claims,
       (SELECT count(*) FROM public.bank_payment_events)   AS gebeurtenissen,
       (SELECT count(*) FROM public.bank_transaction_allocations WHERE created_by IS NOT NULL) AS created_by_gevuld;


-- ── POST 4. Catalogus buiten P5a ongewijzigd (vergelijk met PRE 2) ─────────
SELECT
  md5((SELECT string_agg(format('%s:%s:%s:%s', t.tgname, p.proname, md5(p.prosrc), t.tgenabled), ',' ORDER BY t.tgname)
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal))         AS triggers_bank_transactions,
  md5((SELECT string_agg(format('%s:%s:%s:%s:%s', tablename, policyname, cmd, qual, with_check), ',' ORDER BY tablename, policyname)
       FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices',
                           'sales_invoices', 'bank_match_rejections')))                       AS policies,
  md5((SELECT string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), ',' ORDER BY 1)
       FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices',
                           'sales_invoices', 'bank_match_rejections')))                       AS tabelrechten,
  md5((SELECT string_agg(format('%s:%s', p.proname, md5(p.prosrc)), ',' ORDER BY p.proname)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('post_bank_allocation', 'post_bank_transaction', 'post_sales_invoice',
                           'post_purchase_invoice', 'reverse_posting_group',
                           'enforce_bank_allocation_not_directly_posted', 'enforce_bank_match_rejection_scope',
                           'prevent_posted_bank_allocation_mutation', 'prevent_posted_purchase_invoice_mutation'))) AS schrijvers_en_guards;
