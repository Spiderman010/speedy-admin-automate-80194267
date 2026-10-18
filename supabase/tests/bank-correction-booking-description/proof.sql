-- PR 2 — DE BANKOMSCHRIJVING BLIJFT DE GEÏMPORTEERDE TEKST. Throwaway database only.
--
-- C  catalogus: alleen het lichaam (en het commentaar) van
--    reclassify_bank_transaction veranderde; de voorwaardencontrole bijt.
-- D  gedrag in S0–S4: de bankomschrijving blijft byte-gelijk (ook NULL), de
--    grootboekregels krijgen de juiste boekingsomschrijving, zonder nieuwe
--    omschrijving blijft de bestaande staan; herhaling, unchanged, updated_at,
--    geen bijwerking elders, volgorde van de mutaties, duplicaatsleutel,
--    afgesloten jaar en blokkade, factuurmatches, tenant en rollen.
--
-- Elke RPC-aanroep loopt via proof.rcw: die legt per aanroep vast of élke andere
-- tabel gelijk bleef, of de bankregel buiten de coderingskolommen gelijk bleef en
-- of haar omschrijving byte-gelijk is (D17 telt de afwijkingen).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'C1','C2','C3','C4','C5','C6','C7',
  'C8a','C8b','C8c','C8d','C8e','C8f','C8g','C8h','C8i','C8j',
  'D1','D2','D3a','D3b','D4','D5','D6','D7a','D7b',
  'D8a','D8b','D9','D10a','D10b','D11a','D11b','D11c',
  'D12','D13a','D13b',
  'D14a','D14b','D14c',
  'D15a','D15b','D16','D17','D18a','D18b',
  'D19a','D19b',
  'D20a','D20b','D20c',
  'D21a','D21b','D21c','D21d','D21e',
  'D22',
  'D23a','D23b',
  'D24','D25','D26','D27','D28']);

-- ═══ C. CATALOGUS ════════════════════════════════════════════════════════════

SELECT proof.expect_true('C1', 'van alle functies veranderde alleen reclassify_bank_transaction; elke andere is byte-gelijk (lichaam, SECURITY DEFINER, volatiliteit, instellingen, eigenaar, rechten, uitkomsttype) en er kwam niets bij', $$
  (SELECT array_agg(sig ORDER BY sig) FROM (
     SELECT * FROM proof.cat_functions
     EXCEPT
     SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile::text,
            coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''), pg_get_function_result(p.oid)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) x)
  = ARRAY['reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)']
  AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace) = (SELECT count(*) FROM proof.cat_functions) $$);

SELECT proof.expect_true('C2', 'reclassify_bank_transaction: van PR 1-lichaam naar PR 2-lichaam; signatuur, uitkomsttype, SECURITY DEFINER, search_path, volatiliteit, eigenaar en rechten ongewijzigd', $$
  (SELECT body FROM proof.cat_functions WHERE sig = 'reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') = 'a931207c1a4e97f06e7797ed105c0264'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure) = '067939e0c44a672c26ec8883717ef6d2'
  AND (SELECT ROW(p.prosecdef, p.provolatile::text, coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''), pg_get_function_result(p.oid))
       FROM pg_proc p WHERE p.oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)
    = (SELECT ROW(prosecdef, vol, config, owner, acl, result) FROM proof.cat_functions WHERE sig = 'reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')
  AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public'] AND provolatile = 'v'
       FROM pg_proc WHERE oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)
  AND has_function_privilege('authenticated', 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)', 'EXECUTE') $$);

SELECT proof.expect_true('C3', 'geen enkele trigger, relatie (incl. rechten en RLS), policy, constraint of index veranderde', $$
  NOT EXISTS ((SELECT * FROM proof.cat_triggers
               EXCEPT SELECT t.tgrelid::regclass::text, t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal)
              UNION ALL
              (SELECT t.tgrelid::regclass::text, t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal
               EXCEPT SELECT * FROM proof.cat_triggers))
  AND NOT EXISTS ((SELECT * FROM proof.cat_relations
                   EXCEPT SELECT c.oid::regclass::text, c.relkind::text, coalesce(c.relacl::text, ''), c.relrowsecurity, c.relforcerowsecurity
                          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace)
                  UNION ALL
                  (SELECT c.oid::regclass::text, c.relkind::text, coalesce(c.relacl::text, ''), c.relrowsecurity, c.relforcerowsecurity
                   FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
                   EXCEPT SELECT * FROM proof.cat_relations))
  AND NOT EXISTS ((SELECT * FROM proof.cat_policies
                   EXCEPT SELECT polrelid::regclass::text, polname::text, polcmd::text, polroles::text,
                                 coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '') FROM pg_policy)
                  UNION ALL
                  (SELECT polrelid::regclass::text, polname::text, polcmd::text, polroles::text,
                          coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '') FROM pg_policy
                   EXCEPT SELECT * FROM proof.cat_policies))
  AND NOT EXISTS ((SELECT * FROM proof.cat_constraints
                   EXCEPT SELECT conrelid::regclass::text, conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace)
                  UNION ALL
                  (SELECT conrelid::regclass::text, conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                   EXCEPT SELECT * FROM proof.cat_constraints))
  AND NOT EXISTS ((SELECT * FROM proof.cat_indexes
                   EXCEPT SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace)
                  UNION ALL
                  (SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
                   EXCEPT SELECT * FROM proof.cat_indexes)) $$);

SELECT proof.expect_true('C4', 'van het functiecommentaar veranderde alleen dat van reclassify_bank_transaction', $$
  (SELECT array_agg(sig) FROM (
     (SELECT * FROM proof.cat_comments
      EXCEPT SELECT d.objoid::regprocedure::text, d.description FROM pg_description d
             WHERE d.classoid = 'pg_proc'::regclass AND d.objsubid = 0 AND d.objoid IN (SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace))) x)
  = ARRAY['reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)']
  AND obj_description('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure, 'pg_proc')
      LIKE '%bank_transactions.description blijft na elke correctie byte-gelijk%' $$);

SELECT proof.expect_true('C5', 'de schrijver post_bank_transaction en de PR 1-functies release en return: byte-gelijk aan de beoordeelde pins', $$
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure) = '2369978c713ac78a0c039dd5c3e5eb4c'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.release_bank_transaction_posting(uuid,uuid,uuid,text)'::regprocedure) = '2c3a2e8b93292336ea319fa512b7e09b'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.return_bank_transaction_to_workflow(uuid,uuid,text)'::regprocedure) = '5334092758eb40def4c58a97403c841c' $$);

SELECT proof.record('C6', 'de migratie (twee keer toegepast) veranderde geen enkele rij — ook geen bankomschrijving en niets in een andere tabel',
  proof.digest() = proof.get('digest_before_migration')
  AND proof.rest_digest() = proof.get('rest_before_migration')
  AND (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '∅'), ',' ORDER BY id), ''))
       FROM public.bank_transactions) = proof.get('descriptions_before_migration'));

SELECT proof.expect_true('C7', 'het veiligheidsargument klopt hier: precies de vijf beoordeelde triggers op bank_transactions (met de lichamen uit de migraties), geen RULE, geen publicatie', $$
  (SELECT array_agg(format('%s/%s/%s/%s', t.tgname, p.proname, md5(p.prosrc), t.tgenabled) ORDER BY t.tgname)
   FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal)
  = ARRAY['enforce_bank_transaction_release_hold_trigger/enforce_bank_transaction_release_hold/812d151a7041cdd48b7a784cd193a159/A',
          'prevent_org_user_rebind_trg/prevent_org_user_rebind/9d75d3c98a66f0fc0299b795ee40461e/O',
          'prevent_posted_bank_transaction_mutation_trigger/prevent_posted_bank_transaction_mutation/a6437536b1942e78d5b072f22fe6a842/O',
          'set_organization_id_trigger/set_organization_id/e56450399d8f95c5ed42fd2df04bed06/O',
          'update_bank_transactions_updated_at/update_updated_at_column/301a884953d37769916294bb60562e05/O']
  AND NOT EXISTS (SELECT 1 FROM pg_rules WHERE tablename = 'bank_transactions')
  AND NOT EXISTS (SELECT 1 FROM pg_publication) $$);

-- De voorwaardencontrole uit de migratie (letterlijk, :'prereq') weigert bij
-- elke afwijking; elke opzet wordt in een subtransactie teruggedraaid.
CREATE FUNCTION proof.prereq_refuses(_n text, _name text, _setup text, _prereq text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE _setup;
    EXECUTE _prereq;
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'proof: geen weigering';
  EXCEPTION WHEN others THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  INSERT INTO proof.result VALUES (_n, _name,
    v_state = '55000' AND position(lower(_needle) IN lower(v_msg)) > 0, format('[%s] %s', v_state, v_msg));
END $$;

SELECT proof.prereq_refuses('C8a', 'voorwaarde: een extra trigger op bank_transactions → 55000',
  $s$CREATE TRIGGER proof_extra AFTER UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()$s$,
  :'prereq', 'triggers op bank_transactions');
SELECT proof.prereq_refuses('C8b', 'voorwaarde: een gewijzigd lichaam van een triggerfunctie (updated_at) → 55000',
  $s$CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN
  NEW.updated_at = now(); -- en iets anders
  RETURN NEW;
END;
$f$$s$,
  :'prereq', 'triggers op bank_transactions');
SELECT proof.prereq_refuses('C8c', 'voorwaarde: een uitgeschakelde trigger → 55000',
  $s$ALTER TABLE public.bank_transactions DISABLE TRIGGER update_bank_transactions_updated_at$s$,
  :'prereq', 'triggers op bank_transactions');
SELECT proof.prereq_refuses('C8d', 'voorwaarde: een RULE op bank_transactions → 55000',
  $s$CREATE RULE proof_rule AS ON UPDATE TO public.bank_transactions DO ALSO NOTIFY proof_rule$s$,
  :'prereq', 'RULE');
SELECT proof.prereq_refuses('C8e', 'voorwaarde: bank_transactions in een publicatie (realtime) → 55000',
  $s$CREATE PUBLICATION proof_pub FOR TABLE public.bank_transactions$s$,
  :'prereq', 'gepubliceerd');
SELECT proof.prereq_refuses('C8f', 'voorwaarde: een publicatie FOR ALL TABLES → 55000',
  $s$CREATE PUBLICATION proof_pub_all FOR ALL TABLES$s$,
  :'prereq', 'gepubliceerd');
SELECT proof.prereq_refuses('C8g', 'voorwaarde: een gewijzigde schrijver post_bank_transaction → 55000',
  $s$DO $d$ BEGIN EXECUTE regexp_replace(pg_get_functiondef('public.post_bank_transaction(uuid)'::regprocedure), 'BEGIN', 'BEGIN -- proof'); END $d$$s$,
  :'prereq', 'post_bank_transaction');
SELECT proof.prereq_refuses('C8h', 'voorwaarde: een reclassify_bank_transaction die noch PR 1 noch PR 2 is → 55000',
  $s$DO $d$ BEGIN EXECUTE regexp_replace(pg_get_functiondef('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure), 'BEGIN', 'BEGIN -- proof'); END $d$$s$,
  :'prereq', 'niet de beoordeelde versie');

SELECT proof.prereq_refuses('C8j', 'voorwaarde: reclassify_bank_transaction met een andere eigenaar dan de schrijver → 55000 (CREATE OR REPLACE zou die eigenaar behouden)',
  $s$ALTER FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) OWNER TO authenticated$s$,
  :'prereq', 'andere eigenaar');

CREATE FUNCTION proof.prereq_passes(_prereq text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _prereq;
  RETURN 'ok';
EXCEPTION WHEN others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;
SELECT proof.record('C8i', 'en in de beoordeelde toestand slaagt dezelfde controle', o = 'ok', o)
FROM proof.prereq_passes(:'prereq') o;

-- ═══ D. GEDRAG ═══════════════════════════════════════════════════════════════

SELECT proof.btx(101, -121.00, '  Albert Heijn 1234 AMSTERDAM  ', _counter => 'NL01BANK0123456789');
SELECT proof.btx(102, -12.10, _null => true);
SELECT proof.btx(103, -60.50, E'Café “De Kroon” — €12,50 ☕ \\ ''quote'' 🍀');
SELECT proof.btx(104, -30.25, 'Geen omschrijving');
SELECT proof.btx(105, -242.00, E'Huur\tkantoor\nmaart  ', _ref => 'TX-0105');
SELECT proof.btx(106, -121.00, 'Bankregel 106');
SELECT proof.btx(107, -121.00, 'INCASSO SOFTWARE BV MAART');
SELECT proof.btx(108, -121.00, 'HUUR PAND');
SELECT proof.btx(109, -121.00, 'VERZEKERING POLIS 77');
SELECT proof.btx(110, -121.00, 'VERZEKERING POLIS 78');
SELECT proof.btx(111, -121.00, 'Updated-at-regel');
SELECT proof.btx(112, -121.00, 'Volgorde-regel');

-- D1: S0, eerste boeking zonder omschrijving: de bankomschrijving (zoals de schrijver haar maakt).
SELECT proof.put('d1', proof.rcw(proof.u(2), 101, NULL, proof.acct(7), 21, 1001));
SELECT proof.record('D1', 'S0 zonder omschrijving: eerste boeking met de bankomschrijving (getrimd, zoals de schrijver); de bankregel byte-gelijk, spaties inbegrepen',
  proof.get('d1') LIKE 'ok: posted|f|%'
  AND proof.texts_of(proof.m(101)) = 'Albert Heijn 1234 AMSTERDAM / BTW Albert Heijn 1234 AMSTERDAM / Albert Heijn 1234 AMSTERDAM'
  AND proof.intact(101)
  AND proof.last_event(101) = 'posted|∅|Albert Heijn 1234 AMSTERDAM|∅',
  proof.get('d1'));

-- D2: S0, eerste boeking met omschrijving.
SELECT proof.put('d2', proof.rcw(proof.u(2), 106, NULL, proof.acct(7), 21, 1061, NULL, 'Kantoorbenodigdheden'));
SELECT proof.record('D2', 'S0 met omschrijving: de grootboekregels krijgen haar (ook de BTW-regel), de bankregel blijft byte-gelijk',
  proof.get('d2') LIKE 'ok: posted|f|%'
  AND proof.texts_of(proof.m(106)) = 'Kantoorbenodigdheden / BTW Kantoorbenodigdheden / Kantoorbenodigdheden'
  AND proof.intact(106)
  AND proof.last_event(106) = 'posted|Kantoorbenodigdheden|Kantoorbenodigdheden|∅',
  proof.get('d2'));

-- D3: S1, alleen de omschrijving.
SELECT proof.put('d3_old', proof.m(101)::text), proof.put('d3_old_digest', proof.group_digest(proof.m(101)));
SELECT proof.put('d3', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(7), 21, 1002, 'Omschrijving verbeteren', 'Lunch met klant'));
SELECT proof.record('D3a', 'S1, alleen de omschrijving: storno + herboeking met de nieuwe tekst; de bankregel byte-gelijk',
  proof.get('d3') LIKE 'ok: reclassified|f|%'
  AND proof.texts_of(proof.m(101)) = 'Lunch met klant / BTW Lunch met klant / Lunch met klant'
  AND proof.lines(proof.m(101)) = proof.lines(proof.get('d3_old')::uuid)
  AND proof.intact(101)
  AND proof.last_event(101) = 'reclassified|Lunch met klant|Lunch met klant|Albert Heijn 1234 AMSTERDAM',
  proof.get('d3'));
SELECT proof.record('D3b', 'en de oorspronkelijke grootboekregels zijn byte-gelijk; precies één storno, die het origineel exact spiegelt',
  proof.group_digest(proof.get('d3_old')::uuid) = proof.get('d3_old_digest')
  AND proof.reversal_count(101) = 1 AND proof.group_count(101) = 2
  AND proof.net(proof.uid(1000, 101), proof.acct(7)) = 100.00
  AND proof.net(proof.uid(1000, 101), proof.acct(4)) = 21.00
  AND proof.net(proof.uid(1000, 101), proof.acct(1)) = -121.00,
  proof.lines(proof.f(proof.get('d3'), 5)::uuid));

-- D4: S1, rekening + BTW + omschrijving.
SELECT proof.put('d4', proof.rcw(proof.u(1), 106, proof.m(106), proof.acct(6), 9, 1062, 'Andere rekening en BTW', 'Representatie'));
SELECT proof.record('D4', 'S1, rekening, BTW en omschrijving tegelijk: bedragen juist (121 → 111,01 + 9,99), tekst nieuw, bankregel byte-gelijk',
  proof.get('d4') LIKE 'ok: reclassified|f|%'
  AND proof.lines(proof.m(106)) = '8250:111.01:0.00,1520:9.99:0.00,1100:0.00:121.00'
  AND proof.texts_of(proof.m(106)) = 'Representatie / BTW Representatie / Representatie'
  AND proof.intact(106),
  proof.get('d4'));

-- D5: S1, alleen de rekening: de boekingsomschrijving blijft, ook al wijkt de bankomschrijving af.
SELECT proof.put('d5', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(6), 21, 1003, 'Toch 8250'));
SELECT proof.record('D5', 'S1 zonder omschrijving: de bestaande boekingsomschrijving blijft staan — geen stille terugval op de bankomschrijving',
  proof.get('d5') LIKE 'ok: reclassified|f|%'
  AND proof.text_of(proof.m(101)) = 'Lunch met klant'
  AND proof.intact(101)
  AND proof.last_event(101) = 'reclassified|∅|Lunch met klant|Lunch met klant',
  proof.get('d5'));

-- D6: S1, dezelfde codering zonder omschrijving: unchanged; de rij wordt niet aangeraakt.
SELECT proof.put('d6_upd', (SELECT updated_at::text FROM public.bank_transactions WHERE id = proof.uid(1000, 101)));
SELECT proof.put('d6_digest', proof.digest());
SELECT proof.put('d6', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(6), 21, 1004, 'Nog eens'));
SELECT proof.record('D6', 'S1, dezelfde codering, geen omschrijving: unchanged, geen nieuwe groep, updated_at en bankregel onaangeroerd',
  proof.get('d6') LIKE 'ok: unchanged|f|%'
  AND proof.group_count(101) = 3 AND proof.reversal_count(101) = 2
  AND (SELECT updated_at::text FROM public.bank_transactions WHERE id = proof.uid(1000, 101)) = proof.get('d6_upd')
  AND proof.intact(101),
  proof.get('d6'));

-- D7: dezelfde codering met de huidige tekst → unchanged; met de bankomschrijving expliciet → die geldt.
SELECT proof.put('d7a', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(6), 21, 1005, 'Zelfde tekst', 'Lunch met klant'));
SELECT proof.record('D7a', 'dezelfde codering en dezelfde boekingsomschrijving: unchanged',
  proof.get('d7a') LIKE 'ok: unchanged|f|%' AND proof.group_count(101) = 3 AND proof.intact(101), proof.get('d7a'));
SELECT proof.put('d7b', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(6), 21, 1006, 'Terug naar de banktekst', 'Albert Heijn 1234 AMSTERDAM'));
SELECT proof.record('D7b', 'de bankomschrijving als uitdrukkelijk gevraagde tekst: herboekt met die tekst; de bankregel (mét spaties) blijft byte-gelijk',
  proof.get('d7b') LIKE 'ok: reclassified|f|%'
  AND proof.text_of(proof.m(101)) = 'Albert Heijn 1234 AMSTERDAM' AND proof.intact(101), proof.get('d7b'));

-- D8: S2 (handmatig tegengeboekt op de transactiedatum) → herboeken.
SELECT proof.put('d8_post', proof.rcw(proof.u(2), 107, NULL, proof.acct(7), 21, 1071, NULL, 'Abonnement software'));
SELECT public.reverse_posting_group(proof.m(107), DATE '2027-03-01', 'Handmatige storno');
SELECT proof.put('d8', proof.rcw(proof.u(1), 107, proof.m(107), proof.acct(7), 21, 1072, 'Opnieuw boeken'));
SELECT proof.record('D8a', 'S2 zonder omschrijving: herboekt met de boekingsomschrijving van de tegengeboekte groep, zonder tweede storno',
  proof.get('d8') LIKE 'ok: reposted|f|%'
  AND proof.text_of(proof.m(107)) = 'Abonnement software'
  AND proof.reversal_count(107) = 1 AND proof.group_count(107) = 2
  AND proof.intact(107)
  AND proof.last_event(107) = 'reposted|∅|Abonnement software|Abonnement software',
  proof.get('d8'));
SELECT public.reverse_posting_group(proof.m(107), DATE '2027-03-01', 'Nog een handmatige storno');
SELECT proof.put('d8b', proof.rcw(proof.u(1), 107, proof.m(107), proof.acct(7), 21, 1073, 'Opnieuw boeken', 'Software-abonnement Q1'));
SELECT proof.record('D8b', 'S2 met omschrijving: herboekt met de nieuwe tekst; bankregel byte-gelijk',
  proof.get('d8b') LIKE 'ok: reposted|f|%' AND proof.text_of(proof.m(107)) = 'Software-abonnement Q1' AND proof.intact(107),
  proof.get('d8b'));

-- D9: S3 (vrijgegeven) na twee boekingen met verschillende tekst → herboeken zonder omschrijving.
SELECT proof.put('d9_post', proof.rcw(proof.u(2), 108, NULL, proof.acct(7), 21, 1081, NULL, 'Huur maart'));
SELECT proof.put('d9_fix', proof.rcw(proof.u(1), 108, proof.m(108), proof.acct(7), 21, 1082, 'Andere maand', 'Huur april'));
SELECT proof.put('d9_rel', proof.rel(proof.u(1), proof.uid(1000, 108), proof.m(108), proof.req(1083)));
SELECT proof.put('d9', proof.rcw(proof.u(1), 108, NULL, proof.acct(7), 21, 1084, 'Toch boeken'));
SELECT proof.record('D9', 'S3 zonder omschrijving: herboekt met de tekst van de láátst vervangen groep (Huur april, niet Huur maart of de banktekst)',
  proof.get('d9_rel') LIKE 'ok: released|f|%'
  AND proof.get('d9') LIKE 'ok: reposted_after_release|f|%'
  AND proof.text_of(proof.m(108)) = 'Huur april'
  AND proof.intact(108)
  AND proof.last_event(108) = 'posted|∅|Huur april|∅',
  concat_ws(' || ', proof.get('d9_rel'), proof.get('d9')));

-- D10: S4 (vrijgegeven en teruggezet) → eerste boeking via de RPC.
SELECT proof.put('d10_post', proof.rcw(proof.u(2), 109, NULL, proof.acct(7), 21, 1091, NULL, 'Verzekering bedrijfsauto'));
SELECT proof.put('d10_rel', proof.rel(proof.u(1), proof.uid(1000, 109), proof.m(109), proof.req(1092)));
SELECT proof.put('d10_ret', proof.ret(proof.u(1), proof.uid(1000, 109), proof.req(1093)));
SELECT proof.put('d10', proof.rcw(proof.u(2), 109, NULL, proof.acct(7), 21, 1094));
SELECT proof.record('D10a', 'S4 (teruggezet) zonder omschrijving: de boekingsomschrijving uit de historie, niet de banktekst',
  proof.get('d10_ret') LIKE 'ok: returned|f|%'
  AND proof.get('d10') LIKE 'ok: posted|f|%'
  AND proof.text_of(proof.m(109)) = 'Verzekering bedrijfsauto' AND proof.intact(109),
  concat_ws(' || ', proof.get('d10_ret'), proof.get('d10')));
SELECT proof.put('d10b_post', proof.rcw(proof.u(2), 110, NULL, proof.acct(7), 21, 1101, NULL, 'Verzekering 1'));
SELECT proof.put('d10b_rel', proof.rel(proof.u(1), proof.uid(1000, 110), proof.m(110), proof.req(1102)));
SELECT proof.put('d10b_ret', proof.ret(proof.u(1), proof.uid(1000, 110), proof.req(1103)));
SELECT proof.put('d10b', proof.rcw(proof.u(2), 110, NULL, proof.acct(7), 21, 1104, NULL, 'Verzekering 2'));
SELECT proof.record('D10b', 'S4 met omschrijving: die tekst; bankregel byte-gelijk',
  proof.get('d10b') LIKE 'ok: posted|f|%' AND proof.text_of(proof.m(110)) = 'Verzekering 2' AND proof.intact(110),
  proof.get('d10b'));

-- D11: een bankregel zonder omschrijving (NULL).
SELECT proof.put('d11a', proof.rcw(proof.u(2), 102, NULL, proof.acct(7), 21, 1021));
SELECT proof.record('D11a', 'NULL-bankomschrijving, eerste boeking zonder omschrijving: ''Bankboeking''; de bankregel blijft NULL',
  proof.get('d11a') LIKE 'ok: posted|f|%' AND proof.text_of(proof.m(102)) = 'Bankboeking'
  AND (SELECT description IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 102)) AND proof.intact(102),
  proof.get('d11a'));
SELECT proof.put('d11b', proof.rcw(proof.u(1), 102, proof.m(102), proof.acct(7), 21, 1022, 'Tekst toevoegen', 'Bankkosten'));
SELECT proof.record('D11b', 'NULL-bankomschrijving, correctie met omschrijving: de boeking krijgt haar, de bankregel blijft NULL',
  proof.get('d11b') LIKE 'ok: reclassified|f|%' AND proof.text_of(proof.m(102)) = 'Bankkosten'
  AND (SELECT description IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 102)) AND proof.intact(102),
  proof.get('d11b'));
SELECT proof.put('d11c', proof.rcw(proof.u(1), 102, proof.m(102), proof.acct(6), 0, 1023, 'Geen BTW'));
SELECT proof.record('D11c', 'NULL-bankomschrijving, daarna alleen rekening en BTW: de boekingsomschrijving blijft, niet ''Bankboeking''',
  proof.get('d11c') LIKE 'ok: reclassified|f|%' AND proof.texts_of(proof.m(102)) = 'Bankkosten / Bankkosten'
  AND (SELECT description IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 102)) AND proof.intact(102),
  proof.get('d11c'));

-- D12: een volledige levensloop met bijzondere tekens: na élke stap byte-gelijk.
CREATE TABLE proof.d12 (seq serial, step text, outcome text, intact boolean);
GRANT ALL ON proof.d12 TO public;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO public;
-- Elke stap één opdracht; de toets op de bankregel in de volgende (een nieuwe momentopname).
INSERT INTO proof.d12 (step, outcome) VALUES ('s0', proof.rcw(proof.u(2), 103, NULL, proof.acct(7), 21, 1031, NULL, 'Koffie'));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('s1', proof.rcw(proof.u(1), 103, proof.m(103), proof.acct(7), 9, 1032, 'Laag tarief', 'Koffie & thee'));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
SELECT public.reverse_posting_group(proof.m(103), DATE '2027-03-01', 'Handmatig');
INSERT INTO proof.d12 (step, outcome) VALUES ('s2', proof.rcw(proof.u(1), 103, proof.m(103), proof.acct(7), 9, 1033, 'Herboeken'));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('rel', proof.rel(proof.u(1), proof.uid(1000, 103), proof.m(103), proof.req(1034)));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('s3', proof.rcw(proof.u(1), 103, NULL, proof.acct(6), 21, 1035, 'Na vrijgave'));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('rel2', proof.rel(proof.u(1), proof.uid(1000, 103), proof.m(103), proof.req(1036)));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('ret', proof.ret(proof.u(1), proof.uid(1000, 103), proof.req(1037)));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
INSERT INTO proof.d12 (step, outcome) VALUES ('s4', proof.rcw(proof.u(2), 103, NULL, proof.acct(7), 21, 1038));
UPDATE proof.d12 SET intact = proof.intact(103) WHERE intact IS NULL;
SELECT proof.record('D12', 'S0 → S1 → S2 → S3 → S4 met €, ☕, 🍀, aanhalingstekens en een backslash: elke stap slaagt, de bankregel na elke stap byte-gelijk, de tekst loopt mee',
  (SELECT bool_and(outcome LIKE 'ok: %' AND intact) AND count(*) = 8 FROM proof.d12)
  AND proof.text_of(proof.m(103)) = 'Koffie & thee',
  (SELECT string_agg(step || '=' || left(outcome, 30) || '/' || intact, ' ; ' ORDER BY seq) FROM proof.d12));

-- D13: de gewone schrijver (de app) is ongewijzigd, en de RPC laat zijn regel staan.
SELECT proof.call(proof.u(2), format($q$UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L, btw_percentage = 21
                                       WHERE id = %L RETURNING id::text$q$, proof.acct(7), proof.uid(1000, 105)));
SELECT proof.put('d13_post', proof.call(proof.u(2), format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, 105))));
SELECT proof.record('D13a', 'de app-route (handmatig gecodeerd + post_bank_transaction): de schrijver gebruikt de bankomschrijving zoals altijd',
  proof.get('d13_post') LIKE 'ok: %' AND proof.text_of(proof.m(105)) = E'Huur\tkantoor\nmaart' AND proof.intact(105),
  proof.get('d13_post'));
SELECT proof.put('d13', proof.rcw(proof.u(1), 105, proof.m(105), proof.acct(6), 21, 1051, 'Andere rekening'));
SELECT proof.record('D13b', 'een correctie daarvan zonder omschrijving houdt die boekingstekst (met tab en regeleinde); de bankregel byte-gelijk, ook de afsluitende spaties',
  proof.get('d13') LIKE 'ok: reclassified|f|%' AND proof.text_of(proof.m(105)) = E'Huur\tkantoor\nmaart' AND proof.intact(105),
  proof.get('d13'));

-- D14: herhaling met dezelfde request_id.
SELECT proof.put('d14_digest', proof.digest());
SELECT proof.put('d14a', proof.rcw(proof.u(1), 101, proof.get('d3_old')::uuid, proof.acct(7), 21, 1002, 'Omschrijving verbeteren', 'Lunch met klant'));
SELECT proof.record('D14a', 'herhaling van D3 (dezelfde request_id en argumenten): exact hetzelfde antwoord, replayed, niets nieuws',
  proof.get('d14a') = replace(proof.get('d3'), '|f|', '|t|') AND proof.digest() = proof.get('d14_digest') AND proof.intact(101),
  proof.get('d14a'));
SELECT proof.put('d14b', proof.rcw(proof.u(1), 101, proof.get('d3_old')::uuid, proof.acct(7), 21, 1002, 'Omschrijving verbeteren', 'Andere tekst'));
SELECT proof.record('D14b', 'dezelfde request_id met een andere omschrijving: 22023, niets veranderd',
  proof.get('d14b') LIKE 'fout [22023] Deze request_id is al gebruikt voor een andere aanvraag%' AND proof.digest() = proof.get('d14_digest') AND proof.intact(101),
  proof.get('d14b'));
SELECT public.reverse_posting_group(proof.m(106), DATE '2027-03-01', 'Handmatig na D4');
SELECT proof.put('d14c_digest', proof.digest());
SELECT proof.put('d14c', proof.rcw(proof.u(1), 106, proof.f(proof.get('d2'), 3)::uuid, proof.acct(6), 9, 1062, 'Andere rekening en BTW', 'Representatie'));
SELECT proof.record('D14c', 'herhaling van D4 nadat de boeking intussen handmatig is tegengeboekt: exact het opgeslagen antwoord, geen herboeking',
  proof.get('d14c') = replace(proof.get('d4'), '|f|', '|t|') AND proof.digest() = proof.get('d14c_digest') AND proof.intact(106),
  proof.get('d14c'));

-- D15: updated_at.
SELECT proof.put('d15_post', proof.rcw(proof.u(2), 111, NULL, proof.acct(7), 21, 1111));
SELECT proof.put('d15_now', now()::text), proof.put('d15', proof.rcw(proof.u(1), 111, proof.m(111), proof.acct(7), 21, 1112, 'Tekst', 'Nieuwe tekst'));
SELECT proof.record('D15a', 'updated_at na een correctie = now() van die transactie: precies wat één UPDATE (PR 1) ook zet — het tijdelijk zetten en herstellen voegt niets toe',
  proof.get('d15') LIKE 'ok: reclassified|f|%'
  AND (SELECT updated_at FROM public.bank_transactions WHERE id = proof.uid(1000, 111)) = proof.get('d15_now')::timestamptz,
  concat_ws(' || ', proof.get('d15_now'), (SELECT updated_at::text FROM public.bank_transactions WHERE id = proof.uid(1000, 111))));
SELECT proof.put('d15b', proof.rcw(proof.u(1), 111, proof.m(111), proof.acct(7), 21, 1113, 'Nog eens', 'Nieuwe tekst'));
SELECT proof.record('D15b', 'een daaropvolgende unchanged-aanvraag raakt de rij niet: updated_at blijft exact de waarde van de correctie',
  proof.get('d15b') LIKE 'ok: unchanged|f|%'
  AND (SELECT updated_at FROM public.bank_transactions WHERE id = proof.uid(1000, 111)) = proof.get('d15_now')::timestamptz
  AND proof.intact(111),
  proof.get('d15b'));

-- D16: de bankregel verandert buiten de coderingskolommen nergens.
SELECT proof.expect_true('D16', 'bij elke geslaagde aanroep bleef de bankregel buiten status, rekening, BTW, factuurmatch en updated_at gelijk — omschrijving incluis', $$
  (SELECT bool_and(row_ok) AND count(*) > 20 FROM proof.watch WHERE outcome LIKE 'ok: %') $$);

-- D17: geen bijwerking elders.
SELECT proof.expect_true('D17', 'bij élke aanroep bleef élke andere tabel in de database gelijk (geen audit-, log- of hulprij, nergens), en de bankomschrijving byte-gelijk', $$
  (SELECT bool_and(rest_ok AND intact) AND count(*) > 25 FROM proof.watch) $$);

-- D18: de volgorde van de mutaties, met harnas-triggers die alles in de transactie vastleggen.
CREATE TABLE proof.trace (seq bigserial, xid xid8, what text, detail text);
GRANT ALL ON proof.trace TO public;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO public;
CREATE FUNCTION proof.trace_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  IF TG_TABLE_NAME = 'bank_transactions' THEN
    v := coalesce(OLD.description, '∅') || ' → ' || coalesce(NEW.description, '∅');
  ELSIF TG_TABLE_NAME = 'ledger_postings' THEN
    v := NEW.source_type || ':' || NEW.description;
  END IF;
  INSERT INTO proof.trace (xid, what, detail) VALUES (pg_current_xact_id(), TG_TABLE_NAME || ':' || TG_OP, v);
  RETURN NULL;
END $$;
CREATE TRIGGER proof_trace AFTER UPDATE ON public.bank_transactions FOR EACH ROW
  WHEN (NEW.id = '00000000-0000-0000-1000-000000000112') EXECUTE FUNCTION proof.trace_fn();
CREATE TRIGGER proof_trace AFTER INSERT ON public.ledger_postings FOR EACH ROW
  WHEN (NEW.source_id = '00000000-0000-0000-1000-000000000112' OR NEW.source_type = 'reversal') EXECUTE FUNCTION proof.trace_fn();
CREATE TRIGGER proof_trace AFTER INSERT OR DELETE ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION proof.trace_fn();
CREATE TRIGGER proof_trace AFTER INSERT ON public.bank_transaction_posting_events FOR EACH ROW EXECUTE FUNCTION proof.trace_fn();
CREATE TRIGGER proof_trace AFTER INSERT ON public.ledger_reversal_postings FOR EACH ROW EXECUTE FUNCTION proof.trace_fn();

SELECT proof.put('d18_post', proof.rc(proof.u(2), proof.uid(1000, 112), NULL, proof.acct(7), 21, proof.req(1121)));
TRUNCATE proof.trace;
SELECT proof.put('d18', proof.rc(proof.u(1), proof.uid(1000, 112), proof.m(112), proof.acct(6), 9, proof.req(1122), 'Volgorde', 'Geboekte tekst'));
DROP TRIGGER proof_trace ON public.bank_transactions;
DROP TRIGGER proof_trace ON public.ledger_postings;
DROP TRIGGER proof_trace ON public.bank_transaction_postings;
DROP TRIGGER proof_trace ON public.bank_transaction_posting_events;
DROP TRIGGER proof_trace ON public.ledger_reversal_postings;

SELECT proof.record('D18a', 'de volgorde in één transactie: storno → marker los → omschrijving tijdelijk de boekingstekst → nieuwe marker en regels met die tekst → omschrijving byte-gelijk terug → pas dán de gebeurtenis',
  proof.get('d18') LIKE 'ok: reclassified|f|%'
  AND (SELECT array_agg(what || coalesce('[' || detail || ']', '') ORDER BY seq) FROM proof.trace) = ARRAY[
    'ledger_reversal_postings:INSERT',
    'ledger_postings:INSERT[reversal:Tegenboeking: Volgorde]',
    'ledger_postings:INSERT[reversal:Tegenboeking: Volgorde]',
    'ledger_postings:INSERT[reversal:Tegenboeking: Volgorde]',
    'bank_transaction_postings:DELETE',
    'bank_transactions:UPDATE[Volgorde-regel → Geboekte tekst]',
    'bank_transaction_postings:INSERT',
    'ledger_postings:INSERT[bank_transaction:Geboekte tekst]',
    'ledger_postings:INSERT[bank_transaction:BTW Geboekte tekst]',
    'ledger_postings:INSERT[bank_transaction:Geboekte tekst]',
    'bank_transactions:UPDATE[Geboekte tekst → Volgorde-regel]',
    'bank_transaction_posting_events:INSERT']
  AND (SELECT count(DISTINCT xid) FROM proof.trace) = 1
  AND proof.intact(112),
  (SELECT string_agg(what || coalesce('[' || detail || ']', ''), ' ; ' ORDER BY seq) FROM proof.trace));
SELECT proof.record('D18b', 'de tijdelijke tekst is precies één keer gezet en precies één keer hersteld, en nooit gecommit: na COMMIT staat de geïmporteerde tekst er',
  (SELECT count(*) FROM proof.trace WHERE what = 'bank_transactions:UPDATE') = 2
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 112)) = 'Volgorde-regel');

-- D19: de duplicaatherkenning.
SELECT proof.expect_true('D19a', 'voor elke testregel is de duplicaatsleutel (datum | bedrag | eerste 50 tekens van de omschrijving | tegenrekening | reference) gelijk aan die bij de import', $$
  (SELECT bool_and(o.dedup = proof.dedup_key(split_part(o.tx::text, '-', 5)::integer)) AND count(*) >= 12
   FROM proof.original o WHERE o.tx <> proof.uid(1000, 10)) $$);
SELECT proof.expect_true('D19b', 'dezelfde afschriftregels opnieuw importeren: elke regel wordt als dubbel herkend', $$
  (SELECT bool_and(EXISTS (SELECT 1 FROM public.bank_transactions bt
                           WHERE concat_ws('|', bt.transaction_date::text, to_char(bt.amount, 'FM999999990.00'),
                                           left(lower(btrim(coalesce(bt.description, ''), E' \t\r\n')), 50),
                                           lower(btrim(coalesce(bt.counter_account, ''))), coalesce(btrim(bt.reference), ''))
                                 = o.dedup))
   FROM proof.original o WHERE o.tx <> proof.uid(1000, 10)) $$);

-- D20: afgesloten jaar en boekingsblokkade.
SELECT proof.btx(113, -60.00, 'Abonnement 2026', _date => DATE '2026-06-01');
SELECT proof.put('d20_post', proof.rcw(proof.u(2), 113, NULL, proof.acct(7), 21, 1131, NULL, 'Abonnement juni'));
SELECT proof.put('d20_close', proof.call(proof.u(1), format('SELECT created::text FROM public.close_fiscal_year(%L, 2026)', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.put('d20a', proof.rcw(proof.u(1), 113, proof.m(113), proof.acct(6), 21, 1132, 'Correctie in afgesloten jaar', 'Abonnement juni 2026'));
SELECT proof.record('D20a', 'afgesloten jaar zonder blokkade (D8): de correctie lukt op de oorspronkelijke datum, met de nieuwe tekst; bankregel byte-gelijk',
  proof.get('d20_close') LIKE 'ok: %' AND proof.get('d20a') LIKE 'ok: reclassified|f|%'
  AND proof.text_of(proof.m(113)) = 'Abonnement juni 2026'
  AND (SELECT bool_and(posting_date = DATE '2026-06-01' AND boekjaar = 2026) FROM public.ledger_postings WHERE posting_group_id = proof.m(113))
  AND proof.intact(113),
  concat_ws(' || ', proof.get('d20_close'), proof.get('d20a')));

SELECT proof.btx(114, -60.00, 'Geblokkeerd S1');
SELECT proof.btx(115, -60.00, 'Geblokkeerd S0');
SELECT proof.put('d20_s1', proof.rcw(proof.u(2), 114, NULL, proof.acct(7), 21, 1141, NULL, 'Boekingstekst'));
SELECT proof.put('d20_lock', proof.call(proof.u(1), format('SELECT changed::text FROM public.set_posting_lock(%L, DATE ''2027-03-31'', ''Aangifte Q1'')', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.put('d20_digest', proof.digest());
-- Elke aanroep één opdracht; de toets in de volgende (een nieuwe momentopname).
SELECT proof.put('d20b_a', proof.rcw(proof.u(1), 114, proof.m(114), proof.acct(6), 21, 1142, 'Geblokkeerd', 'Andere tekst'));
SELECT proof.put('d20b_b', proof.rcw(proof.u(2), 115, NULL, proof.acct(7), 21, 1151, NULL, 'Andere tekst'));
SELECT proof.record('D20b', 'boekingsblokkade: een correctie (S1) en een eerste boeking (S0) met omschrijving worden geweigerd (22023); niets veranderd, bankregels byte-gelijk',
  proof.get('d20_lock') LIKE 'ok: %'
  AND proof.get('d20b_a') LIKE 'fout [22023] Boekingsdatum 2027-03-01 valt binnen de boekingsblokkade%'
  AND proof.get('d20b_b') LIKE 'fout [22023] Boekingsdatum 2027-03-01 valt binnen de boekingsblokkade%'
  AND proof.digest() = proof.get('d20_digest') AND proof.intact(114) AND proof.intact(115),
  concat_ws(' || ', proof.get('d20b_a'), proof.get('d20b_b')));
SELECT proof.put('d20_unlock', proof.call(proof.u(1), format('SELECT changed::text FROM public.set_posting_lock(%L, NULL, ''Opgeheven'')', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.put('d20c', proof.rcw(proof.u(1), 114, proof.m(114), proof.acct(6), 21, 1143, 'Na opheffen', 'Andere tekst'));
SELECT proof.record('D20c', 'na het opheffen van de blokkade lukt dezelfde correctie (nieuwe request_id); bankregel byte-gelijk',
  proof.get('d20_unlock') LIKE 'ok: %' AND proof.get('d20c') LIKE 'ok: reclassified|f|%'
  AND proof.text_of(proof.m(114)) = 'Andere tekst' AND proof.intact(114),
  proof.get('d20c'));

-- D21: factuurkoppelingen en achtergebleven suggesties.
SELECT proof.btx(116, -25.00, 'Gematcht zonder koppelingsrij'), proof.purchase(116, 25.00);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(2000, 116), match_confidence = 100
WHERE id = proof.uid(1000, 116);
SELECT proof.btx(117, -25.00, 'Handmatig met achtergebleven match'), proof.purchase(117, 25.00);
UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', matched_invoice_id = proof.uid(2000, 117), match_confidence = 60,
  grootboekrekening_id = proof.acct(7) WHERE id = proof.uid(1000, 117);
SELECT public.post_bank_transaction(proof.uid(1000, 117));
SELECT proof.btx(118, -25.00, 'Suggestie');
UPDATE public.bank_transactions SET match_status = 'suggestie', matched_invoice_id = proof.uid(2000, 116), match_confidence = 60
WHERE id = proof.uid(1000, 118);
SELECT proof.btx(119, -40.00, 'Met koppelingsrij'), proof.purchase(119, 40.00);
INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
VALUES (proof.uid(4000, 119), proof.uid(1000, 119), 'inkoop', proof.uid(2000, 119), '00000000-0000-0000-0000-0000000000c1', 40.00, proof.u(1));
SELECT proof.put('d21_digest', proof.digest());

SELECT proof.put('d21a', proof.rcw(proof.u(2), 116, NULL, proof.acct(7), 0, 1161, NULL, 'Tekst'));
SELECT proof.record('D21a', 'gematcht zonder koppelingsrij: 22023, ook met omschrijving; niets veranderd',
  proof.get('d21a') LIKE 'fout [22023] Deze banktransactie is via de match aan een factuur gekoppeld%'
  AND proof.digest() = proof.get('d21_digest') AND proof.intact(116), proof.get('d21a'));
SELECT proof.put('d21b', proof.rcw(proof.u(2), 119, NULL, proof.acct(7), 0, 1191, NULL, 'Tekst'));
SELECT proof.record('D21b', 'met een koppelingsrij: 22023; niets veranderd',
  proof.get('d21b') LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld%'
  AND proof.digest() = proof.get('d21_digest') AND proof.intact(119), proof.get('d21b'));
SELECT proof.put('d21c', proof.rcw(proof.u(1), 117, proof.m(117), proof.acct(6), 0, 1171, 'Correctie', 'Nieuwe tekst'));
SELECT proof.record('D21c', 'handmatig geboekt met een achtergebleven match: correctie met omschrijving lukt; match en factuur ongemoeid, bankregel byte-gelijk',
  proof.get('d21c') LIKE 'ok: reclassified|f|%'
  AND (SELECT matched_invoice_id = proof.uid(2000, 117) AND match_confidence = 60 FROM public.bank_transactions WHERE id = proof.uid(1000, 117))
  AND (SELECT remaining_amount = 25.00 FROM public.purchase_invoices WHERE id = proof.uid(2000, 117))
  AND proof.text_of(proof.m(117)) = 'Nieuwe tekst' AND proof.intact(117),
  proof.get('d21c'));
SELECT proof.put('d21d', proof.rcw(proof.u(2), 118, NULL, proof.acct(7), 0, 1181, NULL, 'Toch iets anders'));
SELECT proof.record('D21d', 'een onbevestigde suggestie met omschrijving boeken: geboekt, suggestie gewist, bankregel byte-gelijk',
  proof.get('d21d') LIKE 'ok: posted|f|%'
  AND (SELECT matched_invoice_id IS NULL AND match_confidence IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 118))
  AND proof.text_of(proof.m(118)) = 'Toch iets anders' AND proof.intact(118),
  proof.get('d21d'));
SELECT proof.put('d21e_digest', proof.digest());
SELECT proof.put('d21e', proof.rel(proof.u(1), proof.uid(1000, 117), proof.m(117), proof.req(1172)));
SELECT proof.record('D21e', 'vrijgeven van de regel met achtergebleven match blijft geweigerd (PR 1); match en bankregel ongemoeid, niets veranderd',
  proof.get('d21e') LIKE 'fout [22023] Deze banktransactie draagt nog een factuurmatch%' AND proof.intact(117)
  AND proof.digest() = proof.get('d21e_digest')
  AND (SELECT matched_invoice_id FROM public.bank_transactions WHERE id = proof.uid(1000, 117)) = proof.uid(2000, 117), proof.get('d21e'));

-- D22: tenant en rollen.
SELECT proof.put('d22_ins', proof.call(proof.u(2), format($q$INSERT INTO public.bank_transactions
  (id, user_id, client_id, organization_id, transaction_date, description, amount, match_status)
  VALUES (%L, %L, '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a001', DATE '2027-03-01', 'Vreemde administratie', -10.00, 'niet_gematcht')
  RETURNING id::text$q$, proof.uid(1000, 120), proof.u(2))));
INSERT INTO proof.original SELECT id, description, convert_to(description, 'UTF8'), NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 120);
UPDATE proof.original SET dedup = proof.dedup_key(120) WHERE tx = proof.uid(1000, 120);
SELECT proof.put('d22_digest', proof.digest());
SELECT proof.put('d22a', proof.rcw(proof.u(3), 101, proof.m(101), proof.acct(7), 21, 1201, 'Vreemd', 'Gekaapt'));
SELECT proof.put('d22b', proof.rcw(proof.u(2), 101, proof.m(101), proof.acct(7), 21, 1202, 'Assistent', 'Gekaapt'));
SELECT proof.put('d22c', proof.rcw(proof.u(4), 101, proof.m(101), proof.acct(7), 21, 1203, 'Lezer', 'Gekaapt'));
SELECT proof.put('d22d', proof.call(NULL, format('SELECT outcome FROM public.reclassify_bank_transaction(%L, %L, %L, 21, %L, %L, %L)',
                                    proof.uid(1000, 101), proof.m(101), proof.acct(7), proof.req(1204), 'Anon', 'Gekaapt'), 'anon'));
SELECT proof.put('d22e', proof.rcw(proof.u(1), 120, NULL, proof.acct(7), 0, 1205, NULL, 'Gekaapt'));
SELECT proof.record('D22', 'tenant en rollen: andere organisatie, assistent op een geboekte regel, alleen-lezen, anon en een vreemde administratie — alle geweigerd, niets veranderd, bankregels byte-gelijk',
  proof.get('d22a') LIKE 'fout [42501] Banktransactie niet beschikbaar%'
  AND proof.get('d22b') LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)%'
  AND proof.get('d22c') LIKE 'fout [42501] Geen rechten om te boeken voor deze organisatie%'
  AND proof.get('d22d') LIKE 'fout [42501] permission denied for function reclassify_bank_transaction%'
  AND proof.get('d22e') LIKE 'fout [42501] Administratie hoort niet bij de organisatie van deze banktransactie%'
  AND proof.digest() = proof.get('d22_digest') AND proof.intact(101) AND proof.intact(120),
  concat_ws(' || ', proof.get('d22a'), proof.get('d22b'), proof.get('d22c'), proof.get('d22d'), proof.get('d22e')));

-- D23: ongeldige of lege omschrijving.
SELECT proof.put('d23_digest', proof.digest());
SELECT proof.put('d23a', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(6), 21, 1231, 'Te lang', repeat('x', 501)));
SELECT proof.record('D23a', 'een omschrijving van 501 tekens: 22023, niets veranderd',
  proof.get('d23a') LIKE 'fout [22023] De omschrijving is te lang (maximaal 500 tekens)%'
  AND proof.digest() = proof.get('d23_digest') AND proof.intact(101), proof.get('d23a'));
SELECT proof.put('d23b', proof.rcw(proof.u(1), 101, proof.m(101), proof.acct(7), 21, 1232, 'Leeg', E' \t\r\n '));
SELECT proof.record('D23b', 'een omschrijving van alleen witruimte telt als geen omschrijving: de boekingsomschrijving blijft (geen terugval)',
  proof.get('d23b') LIKE 'ok: reclassified|f|%' AND proof.text_of(proof.m(101)) = 'Albert Heijn 1234 AMSTERDAM' AND proof.intact(101)
  AND proof.last_event(101) = 'reclassified|∅|Albert Heijn 1234 AMSTERDAM|Albert Heijn 1234 AMSTERDAM',
  proof.get('d23b'));

-- D26: geld erbij (eerste regel = bank, BTW-regel als laatste): S0 → S1 → S3 → S4 zonder omschrijving.
SELECT proof.btx(130, 121.00, 'OMZET KLANT 42 FACTUUR 2027-010');
CREATE TABLE proof.d26 (seq serial, step text, outcome text, text_now text, texts text, intact boolean);
GRANT ALL ON proof.d26 TO public;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO public;
INSERT INTO proof.d26 (step, outcome) VALUES ('s0', proof.rcw(proof.u(2), 130, NULL, proof.acct(8), 21, 1301, NULL, 'Omzet maart'));
UPDATE proof.d26 SET text_now = proof.text_of(proof.m(130)), texts = proof.texts_of(proof.m(130)), intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('s1', proof.rcw(proof.u(1), 130, proof.m(130), proof.acct(8), 9, 1302, 'Laag tarief'));
UPDATE proof.d26 SET text_now = proof.text_of(proof.m(130)), texts = proof.texts_of(proof.m(130)), intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('rel', proof.rel(proof.u(1), proof.uid(1000, 130), proof.m(130), proof.req(1303)));
UPDATE proof.d26 SET intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('s3', proof.rcw(proof.u(1), 130, NULL, proof.acct(8), 21, 1304, 'Na vrijgave'));
UPDATE proof.d26 SET text_now = proof.text_of(proof.m(130)), texts = proof.texts_of(proof.m(130)), intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('rel2', proof.rel(proof.u(1), proof.uid(1000, 130), proof.m(130), proof.req(1305)));
UPDATE proof.d26 SET intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('ret', proof.ret(proof.u(1), proof.uid(1000, 130), proof.req(1306)));
UPDATE proof.d26 SET intact = proof.intact(130) WHERE intact IS NULL;
INSERT INTO proof.d26 (step, outcome) VALUES ('s4', proof.rcw(proof.u(2), 130, NULL, proof.acct(8), 21, 1307));
UPDATE proof.d26 SET text_now = proof.text_of(proof.m(130)), texts = proof.texts_of(proof.m(130)), intact = proof.intact(130) WHERE intact IS NULL;
SELECT proof.record('D26', 'geld erbij met BTW (bankregel eerst, BTW-regel als laatste): de boekingstekst loopt door S1, S3 en S4 zonder ''BTW''-voorvoegsel; de bankregel na elke stap byte-gelijk',
  (SELECT bool_and(outcome LIKE 'ok: %' AND intact) AND count(*) = 7 FROM proof.d26)
  AND (SELECT bool_and(text_now = 'Omzet maart' AND texts = 'Omzet maart / Omzet maart / BTW Omzet maart')
       FROM proof.d26 WHERE step IN ('s0', 's1', 's3', 's4')),
  (SELECT string_agg(step || '=' || left(outcome, 28) || '/' || coalesce(texts, '-') || '/' || intact, ' ; ' ORDER BY seq) FROM proof.d26));

-- D27: door de app geboekt (met een Toelichting die de bankregel overschreef), daarna de
-- banktekst teruggezet, dan vrijgegeven via de RPC: S3 en S4 houden de boekingstekst
-- van die app-boeking — er is dan geen gebeurtenis met een vervangende groep.
SELECT proof.tx(131, -121.00, _description => 'BOL.COM BESTELLING 1234');
SELECT proof.tx(132, -121.00, _description => 'BOL.COM BESTELLING 5678');
UPDATE public.bank_transactions SET description = 'Toelichting van de app', match_status = 'handmatig_geboekt',
  grootboekrekening_id = proof.acct(7), btw_percentage = 21
WHERE id IN (proof.uid(1000, 131), proof.uid(1000, 132));
SELECT public.post_bank_transaction(proof.uid(1000, 131)), public.post_bank_transaction(proof.uid(1000, 132));
UPDATE public.bank_transactions SET description = 'BOL.COM BESTELLING 1234' WHERE id = proof.uid(1000, 131);
UPDATE public.bank_transactions SET description = 'BOL.COM BESTELLING 5678' WHERE id = proof.uid(1000, 132);
SELECT proof.put('d27_rel131', proof.rel(proof.u(1), proof.uid(1000, 131), proof.m(131), proof.req(1311)));
SELECT proof.put('d27_rel132', proof.rel(proof.u(1), proof.uid(1000, 132), proof.m(132), proof.req(1321)));
SELECT proof.put('d27_ret132', proof.ret(proof.u(1), proof.uid(1000, 132), proof.req(1322)));
SELECT proof.put('d27_s3', proof.rc(proof.u(1), proof.uid(1000, 131), NULL, proof.acct(6), 21, proof.req(1312), 'Herboeken'));
SELECT proof.put('d27_s4', proof.rc(proof.u(2), proof.uid(1000, 132), NULL, proof.acct(6), 21, proof.req(1323)));
SELECT proof.record('D27', 'app-boeking → vrijgegeven via de RPC → S3 en S4 zonder omschrijving: de tekst van de app-boeking, niet de (teruggezette) banktekst; de bankregel ongemoeid',
  proof.get('d27_rel131') LIKE 'ok: released|f|%' AND proof.get('d27_ret132') LIKE 'ok: returned|f|%'
  AND proof.get('d27_s3') LIKE 'ok: reposted_after_release|f|%' AND proof.get('d27_s4') LIKE 'ok: posted|f|%'
  AND proof.text_of(proof.m(131)) = 'Toelichting van de app' AND proof.text_of(proof.m(132)) = 'Toelichting van de app'
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 131)) = 'BOL.COM BESTELLING 1234'
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 132)) = 'BOL.COM BESTELLING 5678',
  concat_ws(' || ', proof.get('d27_s3'), proof.get('d27_s4')));

-- D28: een lege bankomschrijving ('') blijft leeg — niet NULL.
SELECT proof.btx(133, -12.10, '');
SELECT proof.put('d28a', proof.rcw(proof.u(2), 133, NULL, proof.acct(7), 21, 1331));
SELECT proof.put('d28b', proof.rcw(proof.u(1), 133, proof.m(133), proof.acct(6), 21, 1332, 'Tekst', 'Kosten'));
SELECT proof.record('D28', 'lege bankomschrijving: eerste boeking ''Bankboeking'', correctie met tekst; de bankregel blijft '''' (geen NULL)',
  proof.get('d28a') LIKE 'ok: posted|f|%' AND proof.get('d28b') LIKE 'ok: reclassified|f|%'
  AND proof.text_of(proof.m(133)) = 'Kosten' AND proof.intact(133)
  AND (SELECT description = '' AND description IS NOT NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 133)),
  concat_ws(' || ', proof.get('d28a'), proof.get('d28b')));

-- D24: de gebeurtenissen zijn consistent met het grootboek.
SELECT proof.expect_true('D24', 'elke gebeurtenis: de geboekte omschrijving = de eerste regel van de vervangende groep, de vervangen omschrijving = die van de vervangen groep, de gevraagde leeg of gelijk aan de geboekte', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
              WHERE (e.replacement_posting_group_id IS NOT NULL AND e.replacement_description IS DISTINCT FROM proof.text_of(e.replacement_posting_group_id))
                 OR (e.superseded_posting_group_id IS NOT NULL AND e.superseded_description IS DISTINCT FROM proof.text_of(e.superseded_posting_group_id))
                 OR (e.requested_description IS NOT NULL AND e.replacement_description IS NOT NULL AND e.requested_description <> e.replacement_description)) $$);

-- D25: alle invarianten van PR 1 houden.
SELECT proof.expect_true('D25', 'na alle D-scenario''s: lineage in orde, elke groep in balans, per transactie hoogstens één open boeking, elke vervangen groep precies één keer tegengeboekt', $$
  proof.lineage_violations() = 0 AND proof.unbalanced() = 0
  AND NOT EXISTS (SELECT r.original_posting_group_id FROM public.ledger_reversal_postings r GROUP BY 1 HAVING count(*) > 1) $$);
