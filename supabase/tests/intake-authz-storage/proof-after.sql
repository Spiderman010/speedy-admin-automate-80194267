-- TEST DOUBLE — BEWIJZEN NA DE P2-MIGRATIES (elk twee keer toegepast), op de
-- echte keten. Elke gebruikersactie draait als rol `authenticated` (of `anon`,
-- `service_role`) met auth.uid() uit request.jwt.claims, dus onder de ECHTE
-- RLS-policies uit de migraties.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- ═════ Q — de plakbare read-only preflight en postcheck uit het rapport ═══════
SELECT proof.expect('Q01', 'preflight (vóór de migraties): elke _ok-kolom is true',
  (SELECT coalesce(string_agg(key, ',' ORDER BY key), 'alle true')
   FROM proof.preflight p, json_each_text(row_to_json(p)) WHERE key LIKE '%\_ok' AND value <> 'true'),
  'alle true');
SELECT proof.expect('Q02', 'preflight meet de impact: 6 objecten, 2 wees, 1 van een ex-lid, 1 vreemde regel, 2 weesregels',
  (SELECT format('%s|%s|%s|%s|%s|%s', objecten, wees_objecten, objecten_alleen_null_org, objecten_uploader_geen_lid,
                 regels_andere_organisatie, weesregels) FROM proof.preflight),
  '6|2|0|1|1|2');
SELECT proof.expect('Q03', 'preflight: het orakel van B1-05 was open',
  (SELECT predicaat_orakel_open::text FROM proof.preflight), 'true');
SELECT proof.expect('Q04', 'postcheck (na de migraties): elke _ok-kolom is true',
  (SELECT coalesce(string_agg(key, ',' ORDER BY key), 'alle true')
   FROM proof.postcheck p, json_each_text(row_to_json(p)) WHERE key LIKE '%\_ok' AND value <> 'true'),
  'alle true');
SELECT proof.expect('Q05', 'postcheck: geen onverwachte backfill (tellingen gelijk aan de preflight)',
  (SELECT CASE WHEN (a.objecten, a.wees_objecten, a.regels, a.regels_andere_organisatie, a.weesregels)
                  = (b.objecten, b.wees_objecten, b.regels, b.regels_andere_organisatie, b.weesregels)
               THEN 'gelijk' ELSE 'verschil' END
   FROM proof.preflight a, proof.postcheck b),
  'gelijk');
SELECT proof.expect('Q06', 'postcheck: de FK staat nog op NOT VALID (VALIDATE is een aparte stap)',
  (SELECT regel_fk_nog_not_valid::text FROM proof.postcheck), 'true');

-- ═════ S — structuur van de opslagpolicies (B2-08) ═══════════════════════════
SELECT proof.expect('S01', 'storage.objects heeft precies lezen/uploaden/verwijderen voor invoices',
  (SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'storage.objects'::regclass),
  'invoices_delete_own_folder_current_member:d,invoices_read_current_org_member:r,invoices_upload_own_folder:a');
SELECT proof.expect('S02', 'geen UPDATE- of ALL-policy: bijwerken blijft geweigerd',
  (SELECT count(*)::text FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polcmd IN ('w', '*')), '0');
SELECT proof.expect('S03', 'alle opslagpolicies gelden alleen voor authenticated',
  (SELECT string_agg(DISTINCT r.rolname, ',') FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) AS u(oid)
     JOIN pg_roles r ON r.oid = u.oid WHERE p.polrelid = 'storage.objects'::regclass), 'authenticated');
SELECT proof.expect('S04', 'de lees- en verwijderpolicy kennen geen onvoorwaardelijke eigen-map-tak meer',
  (SELECT (pg_get_expr(polqual, polrelid) LIKE '%is_organization_member%')::text FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass AND polname = 'invoices_delete_own_folder_current_member'), 'true');

-- ═════ O — opslagmatrix: actor × object × lezen/uploaden/bijwerken/verwijderen ═
-- Huidig lid en uploader (assistent A)
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.expect('O01', 'huidig lid (uploader) leest eigen inkoopdocument', proof.lees('doc1'), '1');
SELECT proof.expect('O02', 'huidig lid (uploader) leest eigen verkoopdocument', proof.lees('s1'), '1');
SELECT proof.expect('O03', 'huidig lid leest document van een collega via de factuur (bestaand recht)', proof.lees('doc2'), '1');
SELECT proof.expect('O04', 'huidig lid leest geen document van een andere organisatie', proof.lees('doc3'), '0');
SELECT proof.expect('O05', 'wees-object van de uploader is niet leesbaar (fail-closed)', proof.lees('wees'), '0');
SELECT proof.expect('O06', 'huidig lid uploadt in eigen map (ongewijzigd)',
  proof.upload('a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/nieuw.pdf'), 'OK rows=1');
SELECT proof.expect('O07', 'huidig lid kan niets bijwerken (geen UPDATE-policy)', proof.werkbij('doc1'), 'OK rows=0');
SELECT proof.expect('O08', 'huidig lid verwijdert eigen inkoopdocument', proof.verwijder('doc1'), 'OK rows=1');
SELECT proof.expect('O09', 'huidig lid verwijdert eigen verkoopdocument', proof.verwijder('s1'), 'OK rows=1');
SELECT proof.expect('O10', 'wees-object van de uploader is niet verwijderbaar (fail-closed)', proof.verwijder('wees'), 'OK rows=0');
SELECT proof.expect('O11', 'huidig lid verwijdert geen document uit de map van een ander', proof.verwijder('doc2'), 'OK rows=0');
COMMIT;

-- Collega in dezelfde organisatie (read_only)
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000004');
SELECT proof.expect('O12', 'collega (read_only) leest het document via de factuur', proof.lees('doc1'), '1');
SELECT proof.expect('O13', 'collega verwijdert geen document uit andermans map', proof.verwijder('doc1'), 'OK rows=0');
SELECT proof.expect('O14', 'collega uploadt in eigen map (ongewijzigd)',
  proof.upload('a0000000-0000-4000-8000-000000000004/ca000000-0000-4000-8000-000000000001/x.pdf'), 'OK rows=1');
COMMIT;

-- Ex-medewerker (uit organization_members en user_roles verwijderd)
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000005');
SELECT proof.expect('O15', 'ex-lid leest zijn upload van kantoor A niet meer (was 1, V01)', proof.lees('doc2'), '0');
SELECT proof.expect('O16', 'ex-lid verwijdert zijn upload van kantoor A niet meer (was 1, V02)', proof.verwijder('doc2'), 'OK rows=0');
SELECT proof.expect('O17', 'ex-lid leest zijn wees-object niet', proof.lees('wees-ex'), '0');
SELECT proof.expect('O18', 'ex-lid verwijdert zijn wees-object niet', proof.verwijder('wees-ex'), 'OK rows=0');
SELECT proof.expect('O19', 'ex-lid werkt niets bij', proof.werkbij('doc2'), 'OK rows=0');
SELECT proof.expect('O20', 'ex-lid kan nog in eigen map uploaden (ongewijzigd; open punt, geen toegang tot gegevens)',
  proof.upload('a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/y.pdf'), 'OK rows=1');
SELECT proof.expect('O21', 'ex-lid leest geen documenten van oud-collega''s', proof.lees('doc1'), '0');
COMMIT;

-- Lid van een andere organisatie (assistent B, uploader van doc3)
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('b0000000-0000-4000-8000-000000000002');
SELECT proof.expect('O22', 'andere organisatie leest het document van A niet', proof.lees('doc1'), '0');
SELECT proof.expect('O23', 'andere organisatie verwijdert het document van A niet', proof.verwijder('doc1'), 'OK rows=0');
SELECT proof.expect('O24', 'andere organisatie leest haar eigen document', proof.lees('doc3'), '1');
SELECT proof.expect('O25', 'andere organisatie verwijdert haar eigen document', proof.verwijder('doc3'), 'OK rows=1');
COMMIT;

-- Geregistreerd zonder organisatie
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('c0000000-0000-4000-8000-000000000001');
SELECT proof.expect('O26', 'gebruiker zonder organisatie ziet geen enkel object',
  proof.val($q$SELECT count(*) FROM storage.objects WHERE bucket_id = 'invoices'$q$), '0');
SELECT proof.expect('O27', 'gebruiker zonder organisatie kan nog in eigen map uploaden (ongewijzigd; open punt)',
  proof.upload('c0000000-0000-4000-8000-000000000001/willekeurig/z.pdf'), 'OK rows=1');
COMMIT;

-- anon
BEGIN; SET LOCAL ROLE anon; SELECT proof.als(NULL);
SELECT proof.expect('O28', 'anon ziet geen enkel object', proof.val($q$SELECT count(*) FROM storage.objects$q$), '0');
SELECT proof.expect('O29', 'anon uploadt niet', proof.upload('anon/x.pdf'), 'ERR 42501%');
SELECT proof.expect('O30', 'anon verwijdert niets', proof.verwijder('doc1'), 'OK rows=0');
COMMIT;

-- service_role (edge functions, beheer): ongewijzigd
BEGIN; SET LOCAL ROLE service_role; SELECT proof.als(NULL);
SELECT proof.expect('O31', 'service_role ziet alle zes objecten (RLS omzeild, ongewijzigd)',
  proof.val($q$SELECT count(*) FROM storage.objects WHERE bucket_id = 'invoices'$q$), '6');
SELECT proof.expect('O32', 'service_role kan een wees-object opruimen', proof.verwijder('wees'), 'OK rows=1');
COMMIT;

SELECT proof.expect('O33', 'geen datawijziging: dezelfde objecten als vóór de migraties',
  (SELECT string_agg(name, ',' ORDER BY name) FROM storage.objects),
  (SELECT v FROM proof.snapshot WHERE k = 'objects'));

-- ═════ R — regel hoort bij de organisatie van zijn factuur (A2-17/B1-02) ═════
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('b0000000-0000-4000-8000-000000000001');
SELECT proof.expect('R01', 'lid van B hangt geen regel (org B) meer aan factuur A1 (was OK, V04)',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'DoS', 1, 99)$q$),
  'ERR 42501: inkoopfactuur niet gevonden of geen toegang');
SELECT proof.expect('R02', 'een niet-bestaande factuur geeft exact dezelfde weigering (geen orakel)',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-0000000000ff', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'DoS', 1, 99)$q$),
  'ERR 42501: inkoopfactuur niet gevonden of geen toegang');
SELECT proof.expect('R03', 'lid van B zonder organization_id: afgeleid als A, dus geweigerd door RLS',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'DoS', 1, 99)$q$),
  'ERR 42501%');
COMMIT;

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.expect('R04', 'assistent A zonder organization_id: de organisatie komt uit de factuur',
  proof.val_rollback($q$WITH i AS (INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'Nieuw', 1, 5) RETURNING organization_id)
    SELECT organization_id::text FROM i$q$),
  'aaaaaaaa-0000-4000-8000-00000000000a');
SELECT proof.expect('R05', 'assistent A met organization_id = A (zoals de opslag-RPC)',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Nieuw', 1, 5)$q$),
  'OK rows=1');
SELECT proof.expect('R06', 'een regel verhangen naar een factuur van een andere organisatie wordt geweigerd',
  proof.try_rollback($q$UPDATE public.purchase_invoice_lines SET purchase_invoice_id = '2b000000-0000-4000-8000-000000000001'
    WHERE id = '8a000000-0000-4000-8000-000000000001'$q$),
  'ERR 42501: inkoopfactuur niet gevonden of geen toegang');
SELECT proof.expect('R07', 'verhangen binnen de eigen organisatie blijft mogelijk',
  proof.try_rollback($q$UPDATE public.purchase_invoice_lines SET purchase_invoice_id = '2a000000-0000-4000-8000-000000000003'
    WHERE id = '8a000000-0000-4000-8000-000000000001'$q$),
  'OK rows=1');
SELECT proof.expect('R08', 'alleen het bedrag wijzigen raakt de trigger niet',
  proof.try_rollback($q$UPDATE public.purchase_invoice_lines SET amount_excl = 99 WHERE id = '8a000000-0000-4000-8000-000000000001'$q$),
  'OK rows=1');
COMMIT;

SELECT proof.expect('R09', 'een bestaande weesregel blijft bewerkbaar (NOT VALID, sleutel ongewijzigd)',
  proof.try_rollback($q$UPDATE public.purchase_invoice_lines SET amount_excl = 6 WHERE id = '8a000000-0000-4000-8000-0000000000dd'$q$),
  'OK rows=1');
SELECT proof.expect('R10', 'FK bestaat: purchase_invoices(id), ON DELETE CASCADE, NOT VALID',
  (SELECT format('%s|%s|%s', confrelid::regclass, confdeltype, convalidated::text) FROM pg_constraint
   WHERE conrelid = 'public.purchase_invoice_lines'::regclass AND conname = 'purchase_invoice_lines_purchase_invoice_id_fkey'),
  'purchase_invoices|c|false');
SELECT proof.expect('R11', 'geen datawijziging: weesregel en vreemde regel op A4 staan er nog',
  (SELECT count(*)::text FROM public.purchase_invoice_lines
   WHERE id IN ('8a000000-0000-4000-8000-0000000000dd', '8b000000-0000-4000-8000-000000000004')), '2');

BEGIN;
ALTER TABLE public.purchase_invoice_lines DISABLE TRIGGER enforce_purchase_invoice_line_parent_trigger;
SELECT proof.expect('R12', 'de FK geldt voor nieuwe rijen (ook zonder de trigger)',
  proof.try_rollback($q$INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, sort_order)
    VALUES ('2a000000-0000-4000-8000-0000000000ff', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'x', 1, 0)$q$),
  'ERR 23503%');
ALTER TABLE public.purchase_invoice_lines ENABLE TRIGGER enforce_purchase_invoice_line_parent_trigger;
COMMIT;

-- Verwijderen zoals de app: eerst de (zichtbare) regels, dan de factuur.
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000002');
SELECT proof.expect('R13', 'accountant verwijdert de regels van A4 (alleen de eigen regel is zichtbaar)',
  proof.try_keep($q$DELETE FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-000000000004'$q$), 'OK rows=1');
SELECT proof.expect('R14', 'accountant verwijdert factuur A4: slaagt zoals vóór de migratie (V06)',
  proof.try_keep($q$DELETE FROM public.purchase_invoices WHERE id = '2a000000-0000-4000-8000-000000000004'$q$), 'OK rows=1');
COMMIT;
SELECT proof.expect('R15', 'de cascade nam de onzichtbare vreemde regel mee: geen wees (vóór: wel, V07)',
  (SELECT count(*)::text FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-000000000004'), '0');

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000002');
SELECT proof.expect('R16', 'een administratie met facturen en regels verwijderen slaagt nog (cascade)',
  proof.try_keep($q$DELETE FROM public.clients WHERE id = 'ca000000-0000-4000-8000-000000000002'$q$), 'OK rows=1');
COMMIT;
SELECT proof.expect('R17', '… en laat geen weesregel achter',
  (SELECT count(*)::text FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000c2'), '0');

SELECT proof.expect('R18', 'triggerfunctie: SECURITY DEFINER, search_path=public, geen EXECUTE voor app-rollen',
  (SELECT format('%s|%s|%s', p.prosecdef::text, array_to_string(p.proconfig, ','),
     (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('service_role', p.oid, 'EXECUTE'))::text)
   FROM pg_proc p WHERE p.oid = 'public.enforce_purchase_invoice_line_parent()'::regprocedure),
  'true|search_path=public|false');
SELECT proof.expect('R19', 'de trigger draait als eerste BEFORE INSERT-trigger, vóór set_organization_id_trigger',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
   WHERE tgrelid = 'public.purchase_invoice_lines'::regclass AND NOT tgisinternal
     AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0),
  'enforce_purchase_invoice_line_parent_trigger,prevent_posted_purchase_line_mutation_trigger,set_organization_id_trigger');
SELECT proof.expect('R20', 'bij UPDATE vuurt hij alleen op purchase_invoice_id en organization_id',
  (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_trigger t
   CROSS JOIN LATERAL unnest(t.tgattr::int2[]) AS k(attnum)
   JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum
   WHERE t.tgrelid = 'public.purchase_invoice_lines'::regclass AND t.tgname = 'enforce_purchase_invoice_line_parent_trigger'),
  'organization_id,purchase_invoice_id');

-- ═════ W — werkbank: geen verdubbelde regels (A2-07, D5 open) ═══════════════
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.expect('W01', 'assistent slaat een factuur met regels op: geweigerd in plaats van verdubbeld',
  proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e1',
    '{"notes":"door assistent"}'::jsonb, '[{"omschrijving":"Regel W1","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$),
  'ERR 42501: Je rol mag de bestaande boekingsregels van deze inkoopfactuur niet vervangen%');
SELECT proof.expect('W02', '… de regels en de kop zijn ongewijzigd (alles teruggerold)',
  proof.val($q$SELECT (SELECT count(*) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e1')
    || '|' || (SELECT notes FROM public.purchase_invoices WHERE id = '2a000000-0000-4000-8000-0000000000e1')$q$),
  '1|oud');
SELECT proof.expect('W03', 'assistent slaat een factuur zonder regels voor het eerst op',
  proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e2',
    '{"notes":"eerste opslag"}'::jsonb, '[{"omschrijving":"Regel W2","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$),
  'OK rows=1');
SELECT proof.expect('W04', '… en daarna heeft die factuur precies één regel',
  proof.val($q$SELECT count(*) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e2'$q$), '1');
SELECT proof.expect('W05', 'een tweede opslag door de assistent wordt geweigerd',
  proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e2',
    '{"notes":"tweede opslag"}'::jsonb, '[{"omschrijving":"Regel W2","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$),
  'ERR 42501: Je rol mag%');
SELECT proof.expect('W06', '… en laat de ene regel en de kop staan',
  proof.val($q$SELECT (SELECT count(*) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e2')
    || '|' || (SELECT notes FROM public.purchase_invoices WHERE id = '2a000000-0000-4000-8000-0000000000e2')$q$),
  '1|eerste opslag');
SELECT proof.expect('W07', 'ook de directe aanroep van replace_purchase_invoice_lines weigert',
  proof.try_keep($q$SELECT * FROM public.replace_purchase_invoice_lines('2a000000-0000-4000-8000-0000000000e1',
    '[{"omschrijving":"Regel W1","amount_excl":100,"sort_order":0}]'::jsonb)$q$),
  'ERR 42501: Je rol mag%');
COMMIT;

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000002');
SELECT proof.expect('W08', 'accountant vervangt de regels van W1 (ongewijzigd gedrag)',
  proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e1',
    '{"notes":"door accountant"}'::jsonb, '[{"omschrijving":"Nieuwe regel","amount_excl":100,"btw_percentage":21,"sort_order":0}]'::jsonb)$q$),
  'OK rows=1');
SELECT proof.expect('W09', '… precies één regel, met de nieuwe omschrijving',
  proof.val($q$SELECT count(*) || '|' || min(omschrijving) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e1'$q$),
  '1|Nieuwe regel');
COMMIT;

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000004');
SELECT proof.expect('W10', 'read_only slaat niets op',
  proof.try_keep($q$SELECT public.save_purchase_invoice_with_lines('2a000000-0000-4000-8000-0000000000e1',
    '{"notes":"lezer"}'::jsonb, '[{"omschrijving":"x","amount_excl":100,"sort_order":0}]'::jsonb)$q$),
  'ERR 42501%');
COMMIT;

SELECT proof.expect('W11', 'replace_purchase_invoice_lines blijft SECURITY INVOKER met search_path=public',
  (SELECT format('%s|%s', prosecdef::text, array_to_string(proconfig, ',')) FROM pg_proc
   WHERE oid = 'public.replace_purchase_invoice_lines(uuid,jsonb)'::regprocedure), 'false|search_path=public');
SELECT proof.expect('W12', '… met exact dezelfde rechten als vóór de migratie',
  (SELECT coalesce(proacl::text, 'NULL') FROM pg_proc WHERE oid = 'public.replace_purchase_invoice_lines(uuid,jsonb)'::regprocedure),
  (SELECT v FROM proof.snapshot WHERE k = 'replace_acl'));
SELECT proof.expect('W13', 'geen datawijziging: de verdubbelde regels van W0 (V09) staan er nog',
  (SELECT count(*)::text FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '2a000000-0000-4000-8000-0000000000e0'), '3');

-- ═════ P — scopepredicaten zijn geen API meer (B1-05) ════════════════════════
BEGIN; SET LOCAL ROLE anon; SELECT proof.als(NULL);
SELECT proof.expect('P01', 'anon kan posting_account_ok niet meer aanroepen (was true, V10)',
  proof.val($q$SELECT public.posting_account_ok('9a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000001')::text$q$),
  'ERR 42501%');
COMMIT;
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('b0000000-0000-4000-8000-000000000001');
SELECT proof.expect('P02', 'authenticated kan ledger_link_org_ok niet meer aanroepen (was true, V11)',
  proof.val($q$SELECT public.ledger_link_org_ok('9a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a')::text$q$),
  'ERR 42501%');
SELECT proof.expect('P03', 'authenticated kan posting_client_org_ok niet meer aanroepen',
  proof.val($q$SELECT public.posting_client_org_ok('ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a')::text$q$),
  'ERR 42501%');
COMMIT;
BEGIN; SET LOCAL ROLE service_role; SELECT proof.als(NULL);
SELECT proof.expect('P04', 'service_role kan ze niet meer aanroepen',
  proof.val($q$SELECT public.posting_account_ok('9a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000001')::text$q$),
  'ERR 42501%');
COMMIT;

SELECT proof.expect('P05', 'geen policy, view, constraint, default of index hangt af van de predicaten',
  (SELECT count(*)::text FROM pg_depend d
   WHERE d.refclassid = 'pg_proc'::regclass AND d.classid <> 'pg_proc'::regclass
     AND d.refobjid IN ('public.posting_account_ok(uuid,uuid,uuid)'::regprocedure,
                        'public.posting_client_org_ok(uuid,uuid)'::regprocedure,
                        'public.ledger_link_org_ok(uuid,uuid)'::regprocedure)), '0');
SELECT proof.expect('P06', 'alle functies die ze aanroepen zijn SECURITY DEFINER van de eigenaar (aantal afwijkend | aantal aanroepers)',
  (SELECT count(*) FILTER (WHERE NOT (p.prosecdef AND p.proowner = o.proowner)) || '|' || (count(*) > 10)
   FROM pg_proc p CROSS JOIN (SELECT proowner FROM pg_proc WHERE oid = 'public.posting_account_ok(uuid,uuid,uuid)'::regprocedure) o
   WHERE p.prosrc ~ '(posting_account_ok|posting_client_org_ok|ledger_link_org_ok)'
     AND p.oid NOT IN ('public.posting_account_ok(uuid,uuid,uuid)'::regprocedure,
                       'public.posting_client_org_ok(uuid,uuid)'::regprocedure,
                       'public.ledger_link_org_ok(uuid,uuid)'::regprocedure)), '0|true');
SELECT proof.expect('P07', 'EXECUTE alleen nog voor de eigenaar (geen PUBLIC/anon/authenticated/service_role)',
  (SELECT string_agg(DISTINCT (has_function_privilege(r, p.oid, 'EXECUTE'))::text, ',')
   FROM pg_proc p CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
   WHERE p.oid IN ('public.posting_account_ok(uuid,uuid,uuid)'::regprocedure,
                   'public.posting_client_org_ok(uuid,uuid)'::regprocedure,
                   'public.ledger_link_org_ok(uuid,uuid)'::regprocedure)), 'false');

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000001');
SELECT proof.expect('P08', 'de klanttrigger (ledger_link_org_ok) werkt nog voor authenticated: eigen rekening OK',
  proof.try_rollback($q$UPDATE public.clients SET debiteuren_rekening_id = '9a000000-0000-4000-8000-000000000002'
    WHERE id = 'ca000000-0000-4000-8000-000000000001'$q$), 'OK rows=1');
SELECT proof.expect('P09', '… en weigert nog steeds een rekening van een andere organisatie',
  proof.try_rollback($q$UPDATE public.clients SET debiteuren_rekening_id = '9b000000-0000-4000-8000-000000000001'
    WHERE id = 'ca000000-0000-4000-8000-000000000001'$q$), 'ERR 23514%');
COMMIT;

BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000003');
SELECT proof.expect('P10', 'post_purchase_invoice (posting_account_ok, posting_client_org_ok) boekt nog voor een assistent',
  proof.try_keep($q$SELECT public.post_purchase_invoice('2a000000-0000-4000-8000-0000000000f1')$q$), 'OK rows=1');
COMMIT;
SELECT proof.expect('P11', '… als één sluitende groep van drie regels (debet = credit = 121)',
  (SELECT count(*) || '|' || sum(debit_amount) || '|' || sum(credit_amount) FROM public.ledger_postings
   WHERE source_type = 'purchase_invoice' AND source_id = '2a000000-0000-4000-8000-0000000000f1'),
  '3|121.00|121.00');
