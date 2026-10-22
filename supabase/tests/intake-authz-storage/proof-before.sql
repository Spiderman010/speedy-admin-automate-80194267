-- TEST DOUBLE — NULMETING VÓÓR DE P2-MIGRATIES, op de echte keten.
-- Deze bewijzen leggen vast dat het harnas de bekende lekken ziet: ze slagen
-- alleen zolang de oude policies en functies gelden. Daarmee is aangetoond dat
-- de bewijzen in proof-after.sql rood zouden zijn zonder de migraties.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- Momentopnamen om na de migraties mee te vergelijken.
INSERT INTO proof.snapshot (k, v)
SELECT 'replace_acl', coalesce(proacl::text, 'NULL') FROM pg_proc
WHERE oid = 'public.replace_purchase_invoice_lines(uuid,jsonb)'::regprocedure;
INSERT INTO proof.snapshot (k, v)
SELECT 'objects', string_agg(name, ',' ORDER BY name) FROM storage.objects;

-- ── B2-08: opslag, oude policies ─────────────────────────────────────────────
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000005');
SELECT proof.expect('V01', 'vóór: ex-medewerker leest zijn upload van kantoor A (B2-08)', proof.lees('doc2'), '1');
SELECT proof.expect('V02', 'vóór: ex-medewerker verwijdert zijn upload van kantoor A (B2-08)', proof.verwijder('doc2'), 'OK rows=1');
COMMIT;

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.expect('V03', 'vóór: uploader leest een wees-object (eigen-map-tak)', proof.lees('wees'), '1');
COMMIT;

-- ── A2-17: regel van organisatie B aan een factuur van A ──────────────────────
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('b0000000-0000-4000-8000-000000000001');
SELECT proof.expect('V04', 'vóór: lid van B hangt een regel (org B) aan factuur A1 (A2-17)',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'DoS', 1, 99)$q$),
  'OK rows=1');
COMMIT;

-- Verwijderen zoals useDeletePurchaseInvoice: eerst de regels, dan de factuur.
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000002');
SELECT proof.expect('V05', 'vóór: accountant verwijdert de regels van A5 (alleen de eigen regel is zichtbaar)',
  proof.try_keep($q$DELETE FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-000000000005'$q$), 'OK rows=1');
SELECT proof.expect('V06', 'vóór: accountant verwijdert factuur A5',
  proof.try_keep($q$DELETE FROM public.purchase_invoices WHERE id = '2a000000-0000-4000-8000-000000000005'$q$), 'OK rows=1');
COMMIT;
SELECT proof.expect('V07', 'vóór: de vreemde regel van A5 blijft als wees achter (geen FK)',
  (SELECT count(*)::text FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-000000000005'), '1');

-- ── A2-07: assistent slaat dezelfde factuur twee keer op ─────────────────────
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e0',
  '{"notes":"opslag 1"}'::jsonb, '[{"omschrijving":"Regel W0","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$);
SELECT proof.expect('V08', 'vóór: na één opslag door een assistent staan er 2 regels (A2-07)',
  proof.val($q$SELECT count(*) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e0'$q$), '2');
SELECT proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e0',
  '{"notes":"opslag 2"}'::jsonb, '[{"omschrijving":"Regel W0","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$);
SELECT proof.expect('V09', 'vóór: na twee opslagen staan er 3 regels (A2-07)',
  proof.val($q$SELECT count(*) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e0'$q$), '3');
COMMIT;

-- ── B1-05: bestaansorakel ────────────────────────────────────────────────────
BEGIN; SET LOCAL ROLE anon; SELECT proof.als(NULL);
SELECT proof.expect('V10', 'vóór: anon roept posting_account_ok aan (orakel, B1-05)',
  proof.val($q$SELECT public.posting_account_ok('9a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000001')::text$q$), 'true');
COMMIT;
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('b0000000-0000-4000-8000-000000000001');
SELECT proof.expect('V11', 'vóór: lid van B bevestigt een rekening van A (orakel, B1-05)',
  proof.val($q$SELECT public.ledger_link_org_ok('9a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a')::text$q$), 'true');
COMMIT;
