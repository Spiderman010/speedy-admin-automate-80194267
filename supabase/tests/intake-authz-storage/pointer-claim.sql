-- R-01 — een ex-medewerker claimt een eigen, verweesde upload uit zijn oude
-- organisatie A voor een factuur in organisatie B. Gedeeld door
-- proof-pointer-before.sql (vóór 20261021165000) en proof-after.sql.
-- Variabelen: :'pre' (C0 / C1), :'fase', :'exp_claim'.
-- Draait als postgres; de stappen zetten zelf de rol (alles teruggedraaid).
BEGIN; SELECT proof.als('a0000000-0000-4000-8000-000000000006');
SELECT proof.expect(:'pre' || '1', :'fase' || ': ex-lid hangt zijn eigen verweesde inkoopupload van administratie A aan een inkoopfactuur in B',
  proof.reeks(ARRAY[
    $q$INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('invoices', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf', 'a0000000-0000-4000-8000-000000000006')$q$,
    $q$SET LOCAL ROLE authenticated$q$,
    $q$INSERT INTO public.purchase_invoices (user_id, client_id, organization_id, supplier, status, file_path)
       VALUES ('a0000000-0000-4000-8000-000000000006', 'cb000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'R-01', 'te_controleren',
               'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf')$q$],
    'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf'), :'exp_claim');
SELECT proof.expect(:'pre' || '2', :'fase' || ': … ook met de administratie van A op een factuur in B (pad en klant kloppen, organisatie niet)',
  proof.reeks(ARRAY[
    $q$INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('invoices', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf', 'a0000000-0000-4000-8000-000000000006')$q$,
    $q$SET LOCAL ROLE authenticated$q$,
    $q$INSERT INTO public.purchase_invoices (user_id, client_id, organization_id, supplier, status, file_path)
       VALUES ('a0000000-0000-4000-8000-000000000006', 'ca000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'R-01', 'te_controleren',
               'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf')$q$],
    'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/r01.pdf'), :'exp_claim');
COMMIT;
