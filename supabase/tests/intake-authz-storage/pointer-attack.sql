-- B2-08c — de pointer-aanval, als de ex-medewerker van A die assistent is in B.
-- Gedeeld door proof-pointer-before.sql (vóór 20261021164000: het lek werkt)
-- en proof-after.sql (na de migratie: geweigerd). Verwacht :'pre' = X0 / X1
-- en de verwachte uitkomsten in :'exp_ins', :'exp_upd', :'exp_vreemd'.
BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('a0000000-0000-4000-8000-000000000006');
SELECT proof.expect(:'pre' || '0', :'fase' || ': zonder pointer leest de ex-medewerker zijn oude OCR-document van A niet',
  proof.reeks('{}', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/doc-ex.pdf'), 'OK leest 0|verwijdert 0');
SELECT proof.expect(:'pre' || '1', :'fase' || ': nieuwe inkoopfactuur in B met file_path = zijn oude OCR-document van A',
  proof.reeks(ARRAY[$q$INSERT INTO public.purchase_invoices (user_id, client_id, organization_id, supplier, status, file_path)
    VALUES ('a0000000-0000-4000-8000-000000000006', 'cb000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b',
            'Aanval', 'te_controleren', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/doc-ex.pdf')$q$],
    'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/doc-ex.pdf'), :'exp_ins');
SELECT proof.expect(:'pre' || '2', :'fase' || ': bestaande inkoopfactuur in B omgezet naar zijn eigen verkoopupload van A',
  proof.reeks(ARRAY[$q$UPDATE public.purchase_invoices SET file_path = 'a0000000-0000-4000-8000-000000000006/sales/ca000000-0000-4000-8000-000000000001/s-ex.pdf'
    WHERE id = '2b000000-0000-4000-8000-000000000002'$q$],
    'a0000000-0000-4000-8000-000000000006/sales/ca000000-0000-4000-8000-000000000001/s-ex.pdf'), :'exp_upd');
SELECT proof.expect(:'pre' || '3', :'fase' || ': bestaande inkoopfactuur in B omgezet naar een object van iemand anders in A',
  proof.reeks(ARRAY[$q$UPDATE public.purchase_invoices SET file_path = 'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/wees.pdf'
    WHERE id = '2b000000-0000-4000-8000-000000000002'$q$],
    'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/wees.pdf'), :'exp_vreemd');
COMMIT;
