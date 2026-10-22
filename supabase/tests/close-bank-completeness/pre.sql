-- NEGATIEVE CONTROLE — throwaway database only.
--
-- Draait op de echte keten MET het PR E-lichaam van close_fiscal_year(), dus
-- VÓÓR de migratie onder test. Legt vast wat de afsluiting vandaag doet, zodat
-- proof.sql per casus kan laten zien wat de migratie verandert — en wat niet.
-- Elke afsluitpoging wordt teruggedraaid (proof.try_close); er blijft niets
-- achter behalve de vrijgave van K11, die een gewone toestand is.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- De uitgangstoestand van de functie onder test.
SELECT proof.put('md5_pr_e', proof.close_md5());
SELECT proof.put('acl_pr_e', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure));
SELECT proof.put('owner_pr_e', (SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure));
SELECT proof.put('md5_reopen_pr_e', (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reopen_fiscal_year(uuid,integer,text)'::regprocedure));

-- K11: de geboekte bankregel wordt vrijgegeven (storno zonder herboeking) via
-- de echte correctie-RPC: toestand S3, geen marker, codering bevroren.
SELECT proof.as_user(proof.accountant());
SELECT proof.put('k11_release', (
  SELECT r.outcome FROM public.release_bank_transaction_posting(
    proof.uid(1000, 1101),
    (SELECT m.posting_group_id FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = proof.uid(1000, 1101)),
    '00000000-0000-0000-00a7-000000001101',
    'P7-harnas: vrijgave zonder herboeking') r));
SELECT proof.as_user(NULL);

-- De uitkomsten onder PR E, per casus.
SELECT proof.put('pre_k1_2026',  proof.try_close(proof.client(1), 2026));
SELECT proof.put('pre_k2_2026',  proof.try_close(proof.client(2), 2026));
SELECT proof.put('pre_k3_2026',  proof.try_close(proof.client(3), 2026));
SELECT proof.put('pre_k4_2026',  proof.try_close(proof.client(4), 2026));
SELECT proof.put('pre_k5_2026',  proof.try_close(proof.client(5), 2026));
SELECT proof.put('pre_k6_2026',  proof.try_close(proof.client(6), 2026));
SELECT proof.put('pre_k7_2027',  proof.try_close(proof.client(7), 2027));
SELECT proof.put('pre_k8_2026',  proof.try_close(proof.client(8), 2026));
SELECT proof.put('pre_k9_2026',  proof.try_close(proof.client(9), 2026));
SELECT proof.put('pre_k10_2026', proof.try_close(proof.client(10), 2026));
SELECT proof.put('pre_k11_2026', proof.try_close(proof.client(11), 2026));
SELECT proof.put('pre_k13_2026', proof.try_close(proof.client(13), 2026));

SELECT proof.put('digest_pre', proof.data_digest());

-- De negatieve controle zelf: het gat bestaat op deze keten.
SELECT proof.record('N1', 'NEGATIEVE CONTROLE — PR E sluit 2026 af terwijl een gecodeerde bankregel van 2026 niet is geboekt (A3-02)',
  proof.get('pre_k1_2026') = 'created=true', proof.get('pre_k1_2026'));
SELECT proof.record('N2', 'NEGATIEVE CONTROLE — PR E telt ook een bankregel ZONDER organisatie niet (de bank telt nergens mee)',
  proof.get('pre_k10_2026') = 'created=true', proof.get('pre_k10_2026'));
SELECT proof.record('N3', 'uitgangspunt — de vrijgave (S3) slaagt via de echte correctie-RPC en PR E sluit daarna af',
  proof.get('k11_release') = 'released' AND proof.get('pre_k11_2026') = 'created=true',
  proof.get('k11_release') || ' / ' || proof.get('pre_k11_2026'));
SELECT proof.record('N4', 'NEGATIEVE CONTROLE — PR E telt een postbare inkoopfactuur van een ANDERE organisatie met dit client_id wél (B1-04)',
  proof.get('pre_k8_2026') LIKE '[23514]%postbaar brondocument(en) open met boekjaar t/m 2026%', proof.get('pre_k8_2026'));
SELECT proof.record('N5', 'uitgangspunt — PR E telt een postbare inkoopfactuur ZONDER organisatie (erfenis) mee',
  proof.get('pre_k9_2026') LIKE '[23514]%postbaar brondocument(en) open met boekjaar t/m 2026%', proof.get('pre_k9_2026'));
SELECT proof.record('N6', 'uitgangspunt — onder PR E zegt de weigering nog "voorgoed onboekbaar" (sinds PR H onjuist)',
  proof.get('pre_k9_2026') LIKE '%voorgoed onboekbaar%', proof.get('pre_k9_2026'));
SELECT proof.record('N7', 'uitgangspunt — het lichaam onder test is exact PR E (md5 14cdfaa4…)',
  proof.get('md5_pr_e') = '14cdfaa498bbbc305e95dbf0faa52e26', proof.get('md5_pr_e'));
