-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles direct ná 20261021183000_enforce_bank_payment_writer.sql (P5c)
--
-- UITSLUITEND in de Lovable Cloud SQL editor van project `alxlbdhpbwlehbdbfejw`.
-- Alles hieronder is ALLEEN LEZEN.
--
-- STOP en melden als POST 1 ergens `false` geeft of POST 2 afwijkt van PRE 6.
-- Daarna in de app: één koppeling en één ontkoppeling op een testadministratie
-- (de schrijver werkt), en controleren dat "Factuur bewerken" van een onbetaalde
-- factuur nog opslaat.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. Rechten, guards en policies ─────────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.bank_transaction_allocations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.bank_transaction_allocations', 'SELECT,INSERT,UPDATE,DELETE') AS alleen_lezen,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transaction_allocations') = 4 AS policies_staan,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.bank_transaction_allocations'::regclass
          AND tgname = 'enforce_bank_allocation_writer_trigger' AND tgenabled = 'O')                       AS schrijverguard,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'enforce_invoice_payment_state_trigger' AND tgenabled = 'O'
     AND tgrelid IN ('public.purchase_invoices'::regclass, 'public.sales_invoices'::regclass)) = 2         AS factuurguards,
  NOT has_function_privilege('authenticated', 'public.enforce_invoice_payment_state()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.enforce_bank_allocation_writer()', 'EXECUTE')  AS guards_dicht,
  has_function_privilege('authenticated', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE') AS schrijver_bereikbaar;


-- ── POST 2. Geen rij gewijzigd (vergelijk met PRE 6) ────────────────────────
SELECT
  (SELECT count(*) FROM public.bank_transaction_allocations)                   AS koppelingen,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', id, bank_transaction_id, invoice_type, invoice_id,
                                          amount, created_by), ',' ORDER BY id), '')
       FROM public.bank_transaction_allocations))                             AS koppelingen_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, remaining_amount, status, amount_incl), ',' ORDER BY id), '')
       FROM public.purchase_invoices))                                         AS inkoop_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, remaining_amount, status, amount_incl), ',' ORDER BY id), '')
       FROM public.sales_invoices))                                            AS verkoop_md5;
