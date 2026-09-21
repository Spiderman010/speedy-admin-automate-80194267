-- REAL POSTGRESQL PROOF for 6C-b10 (de jaarafsluiting) — run against a
-- THROWAWAY local cluster. Never run this against any BoekAssist database.
-- See run-proof.sh.
--
-- De vraag is niet "ziet dit er goed uit" maar "gedraagt de database zich zo".
-- Afsluiten is onomkeerbaar, dus elke weigering wordt op haar eigen reden
-- gecontroleerd en elke geslaagde afsluiting wordt nagerekend: precies één
-- bewijs, watermerk vooruit, en geen enkele grootboekregel erbij.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ═══ 1-3. De normale afsluiting ═════════════════════════════════════════════

DO $$
DECLARE
  v_c uuid := proof.new_client('Normale afsluiting');
  v_created boolean;
  v_wm integer;
  v_markers integer;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  SELECT afgesloten_boekjaar INTO v_wm FROM public.clients WHERE id = v_c;
  SELECT count(*) INTO v_markers FROM public.year_closures WHERE client_id = v_c;

  PERFORM proof.record('1', 'een normaal volgend boekjaar sluit af', v_created,
                       format('created = %s', v_created));
  PERFORM proof.record('2', 'er ontstaat precies één onuitwisbaar afsluitbewijs', v_markers = 1,
                       format('%s bewijs/bewijzen', v_markers));
  PERFORM proof.record('3', 'het watermerk staat daarna op het afgesloten jaar', v_wm = 2026,
                       format('afgesloten_boekjaar = %s', v_wm));
END $$;

-- ═══ 4. Atomiciteit: een geweigerde afsluiting laat niets achter ════════════

DO $$
DECLARE
  v_c uuid := proof.new_client('Atomiciteit');
  v_wm integer;
  v_markers integer;
  v_msg text;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'gecontroleerd', DATE '2026-04-01');

  BEGIN
    PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  SELECT afgesloten_boekjaar INTO v_wm FROM public.clients WHERE id = v_c;
  SELECT count(*) INTO v_markers FROM public.year_closures WHERE client_id = v_c;

  PERFORM proof.record('4', 'een geweigerde afsluiting laat geen bewijs en geen watermerk achter',
                       v_msg IS NOT NULL AND v_markers = 0 AND v_wm IS NULL,
                       format('bewijzen = %s, watermerk = %s', v_markers, COALESCE(v_wm::text, 'leeg')));
END $$;

-- ═══ 5-6, 32. Idempotentie ══════════════════════════════════════════════════

DO $$
DECLARE
  v_c uuid := proof.new_client('Idempotentie');
  v_eerste timestamptz;
  v_tweede timestamptz;
  v_created_2 boolean;
  v_created_3 boolean;
  v_markers integer;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  SELECT closed_at INTO v_eerste FROM public.year_closures WHERE client_id = v_c AND fiscal_year = 2026;

  -- Herhaling na een time-out of een onbekende uitkomst.
  v_created_2 := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  v_created_3 := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  SELECT closed_at INTO v_tweede FROM public.year_closures WHERE client_id = v_c AND fiscal_year = 2026;
  SELECT count(*) INTO v_markers FROM public.year_closures WHERE client_id = v_c;

  PERFORM proof.record('5', 'een herhaling geeft hetzelfde, onveranderde bewijs terug',
                       v_created_2 = false AND v_eerste = v_tweede,
                       format('created = %s, closed_at gelijk = %s', v_created_2, v_eerste = v_tweede));
  PERFORM proof.record('6', 'een dubbele aanvraag verdubbelt niets', v_markers = 1,
                       format('%s bewijs/bewijzen', v_markers));
  PERFORM proof.record('32', 'ook een derde poging na een onbekende uitkomst is idempotent',
                       v_created_3 = false AND v_markers = 1, format('created = %s', v_created_3));
END $$;

-- ═══ 7. Inconsistente "al afgesloten"-toestand faalt gesloten ═══════════════

DO $$
DECLARE v_c uuid := proof.new_client('Watermerk zonder bewijs');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  -- Het watermerk buiten de schrijver om zetten kan alleen de eigenaar van de
  -- tabel, precies zoals bedoeld. Hier gebruikt om de historische toestand na
  -- te bootsen: een met de hand gezet jaar zonder afsluitbewijs.
  ALTER TABLE public.clients DISABLE TRIGGER enforce_year_close_watermark_trigger;
  UPDATE public.clients SET afgesloten_boekjaar = 2026 WHERE id = v_c;
  ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger;

  PERFORM proof.expect_error('7a', 'watermerk zegt afgesloten maar het bewijs ontbreekt: fail closed',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'geen bijbehorend afsluitbewijs');
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('Bewijs zonder watermerk');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by)
  VALUES (v_c, 2026, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1');

  PERFORM proof.expect_error('7b', 'bewijs bestaat maar het watermerk staat er niet op: fail closed',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'maar het watermerk staat op');
END $$;

-- ═══ 8-9. Afsluitvolgorde ═══════════════════════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Sprong over een ouder jaar');
BEGIN
  PERFORM proof.seed_group(v_c, 2025);
  PERFORM proof.seed_group(v_c, 2026);
  PERFORM proof.expect_error('8', 'een ouder boekjaar MET boekingen overslaan blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'oudere boekjaren met boekingen');
END $$;

DO $$
DECLARE
  v_c uuid := proof.new_client('Leeg tussenjaar');
  v_created boolean;
BEGIN
  -- 2024 afgesloten, 2025 leeg, 2026 met boekingen. Een leeg tussenjaar mag
  -- geen valse blokkade opleveren: daar valt niets af te sluiten.
  PERFORM proof.seed_group(v_c, 2024);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2024);
  PERFORM proof.seed_group(v_c, 2026);
  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  PERFORM proof.record('9', 'een leeg tussenliggend boekjaar blokkeert niet', v_created = true,
                       format('created = %s', v_created));
END $$;

-- ═══ 10. Ongebalanceerde boekingsgroep t/m het doeljaar ═════════════════════

DO $$
DECLARE
  v_c   uuid := proof.new_client('Kapotte groep');
  v_org uuid := '00000000-0000-0000-0000-00000000a001';
  v_acc uuid;
BEGIN
  SELECT id INTO v_acc FROM public.grootboekrekeningen WHERE client_id = v_c AND nummer = 4000;
  -- Zo'n groep kan langs de normale weg niet ontstaan — de uitgestelde
  -- constraint-trigger van 6C-b2 weigert hem. Hij wordt hier met de
  -- eigenaarsluik van de fundering afgedwongen, precies om te bewijzen dat de
  -- afsluiting hem alsnog ziet.
  ALTER TABLE public.ledger_postings DISABLE TRIGGER ALL;
  INSERT INTO public.ledger_postings
    (organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
     posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id, created_xact_id)
  VALUES
    (v_org, v_c, v_acc, gen_random_uuid(), 1, DATE '2026-06-01', 2026, 100.00, 0, 'EUR',
     'purchase_invoice', '00000000-0000-0000-0000-0000000000e1', pg_current_xact_id());
  ALTER TABLE public.ledger_postings ENABLE TRIGGER ALL;
  ALTER TABLE public.ledger_postings ENABLE ALWAYS TRIGGER prevent_ledger_posting_mutation_trigger;
  ALTER TABLE public.ledger_postings ENABLE ALWAYS TRIGGER prevent_ledger_posting_truncate_trigger;

  PERFORM proof.expect_error('10', 'een ongebalanceerde boekingsgroep t/m het doeljaar blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'ongebalanceerde boekingsgroep');
END $$;

-- ═══ 11-14. Postbaar maar nog niet geboekt bronwerk ═════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Openstaande inkoop');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'gecontroleerd', DATE '2026-03-01');
  PERFORM proof.expect_error('11', 'een postbare, ongeboekte inkoopfactuur t/m het jaar blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'postbaar brondocument');
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('Openstaande verkoop');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.sales_invoices (client_id, status, btw_verlegd, invoice_date)
  VALUES (v_c, 'betaald', false, DATE '2026-03-01');
  PERFORM proof.expect_error('12', 'een postbare, ongeboekte verkoopfactuur t/m het jaar blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'postbaar brondocument');
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('Openstaand memoriaal');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.manual_journals (client_id, organization_id, posting_date, description, user_id)
  VALUES (v_c, '00000000-0000-0000-0000-00000000a001', DATE '2026-05-01', 'Nog te boeken',
          '00000000-0000-0000-0000-0000000000e1');
  PERFORM proof.expect_error('13', 'een ongeboekte memoriaalboeking t/m het jaar blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'postbaar brondocument');
END $$;

DO $$
DECLARE
  v_c   uuid := proof.new_client('Afletteringen');
  v_bt  uuid;
  v_pi  uuid;
  v_pi2 uuid;
  v_created boolean;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.bank_transactions (client_id, transaction_date)
  VALUES (v_c, DATE '2026-07-01') RETURNING id INTO v_bt;

  -- (a) Een aflettering waarvan de factuur NIET geboekt is, is nog niet
  --     postbaar en mag dus niet blokkeren — maar de factuur zelf wel, dus die
  --     krijgt hier meteen een marker zodat alleen de aflettering overblijft.
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'gecontroleerd', DATE '2026-02-01') RETURNING id INTO v_pi;
  INSERT INTO public.purchase_invoice_postings (purchase_invoice_id, client_id) VALUES (v_pi, v_c);

  INSERT INTO public.bank_transaction_allocations (client_id, bank_transaction_id, invoice_id, invoice_type)
  VALUES (v_c, v_bt, v_pi, 'inkoop');

  PERFORM proof.expect_error('14', 'een postbare, ongeboekte aflettering t/m het jaar blokkeert',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'postbaar brondocument');

  -- (b) Dezelfde aflettering, maar nu hoort zij bij een factuur die NIET
  --     geboekt is: dan is er nog niets af te letteren en blokkeert zij niet.
  DELETE FROM public.bank_transaction_allocations WHERE client_id = v_c;
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'nieuw', DATE '2026-02-01') RETURNING id INTO v_pi2;
  INSERT INTO public.bank_transaction_allocations (client_id, bank_transaction_id, invoice_id, invoice_type)
  VALUES (v_c, v_bt, v_pi2, 'inkoop');

  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  PERFORM proof.record('14b', 'een aflettering bij een NIET geboekte factuur blokkeert niet',
                       v_created = true, format('created = %s', v_created));
END $$;

-- ═══ 15, 17. Later werk blokkeert niet, en created_at telt nooit ════════════

DO $$
DECLARE
  v_c uuid := proof.new_client('Later bronwerk');
  v_created boolean;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  -- Factuurdatum in 2027, maar AANGEMAAKT in 2026. Zou created_at het boekjaar
  -- bepalen, dan blokkeerde deze factuur het afsluiten van 2026. De
  -- boekhoudkundige datum bepaalt het, dus zij blokkeert niet.
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date, created_at)
  VALUES (v_c, 'gecontroleerd', DATE '2027-01-15', TIMESTAMPTZ '2026-12-31 23:00+01');

  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  PERFORM proof.record('15', 'bronwerk in een LATER boekjaar blokkeert niet', v_created = true,
                       format('created = %s', v_created));
  PERFORM proof.record('17', 'created_at is nooit de bron van het boekjaar', v_created = true,
                       'factuur met created_at in 2026 en invoice_date in 2027 blokkeerde 2026 niet');
END $$;

-- ═══ 16. Ontbrekende boekhoudkundige datum faalt gesloten ═══════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Datumloos bronwerk');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'gecontroleerd', NULL);
  PERFORM proof.expect_error('16', 'postbaar bronwerk zonder boekhoudkundige datum faalt gesloten',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'boekhoudkundige datum onbekend');
END $$;

-- ═══ 18-20. Geen boeking, geen doorrol, nulresultaat ════════════════════════

DO $$
DECLARE
  v_c uuid := proof.new_client('Nulresultaat');
  v_voor integer;
  v_na integer;
  v_created boolean;
  v_tabellen integer;
BEGIN
  -- Kosten 100 debet tegen opbrengst 100 credit: het resultaat van dit jaar is
  -- exact nul. Er wordt geen nulboeking geprobeerd — die kan volgens de
  -- groepsinvariant van 6C-b2 (beide totalen strikt > 0) ook niet bestaan.
  PERFORM proof.seed_group(v_c, 2026, 100.00);
  SELECT count(*) INTO v_voor FROM public.ledger_postings WHERE client_id = v_c;

  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  SELECT count(*) INTO v_na FROM public.ledger_postings WHERE client_id = v_c;

  PERFORM proof.record('18', 'een jaar met resultaat nul sluit gewoon af', v_created = true,
                       format('created = %s', v_created));
  PERFORM proof.record('19', 'de afsluiting voegt geen enkele grootboekregel toe', v_voor = v_na,
                       format('%s regels voor, %s na', v_voor, v_na));

  -- Geen doorrolrij, in welke vorm dan ook: er bestaat geen tabel die er een
  -- zou kunnen bevatten, en de schrijver schrijft in precies één tabel.
  SELECT count(*) INTO v_tabellen
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name ~ 'carry_forward' OR table_name ~ 'year_close_postings' OR table_name ~ 'doorrol');
  PERFORM proof.record('20', 'er bestaat geen doorrol- of resultaatboekingstabel', v_tabellen = 0,
                       format('%s kandidaattabellen', v_tabellen));
END $$;

-- ═══ 21, 29, 30. Wat de schrijver NIET doet ═════════════════════════════════

DO $$
DECLARE
  v_src text;
  v_reopen integer;
  v_reversal_ok boolean;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'close_fiscal_year';

  PERFORM proof.record('21', 'de schrijver leidt nergens een resultaatrekening af',
    v_src !~* 'grootboekrekening' AND v_src !~ '9998' AND v_src !~ '9999'
      AND v_src !~* 'INSERT INTO public\.ledger_postings',
    'geen grootboekrekening, geen 9998/9999, geen INSERT in ledger_postings');

  SELECT count(*) INTO v_reopen FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname ~ 'reopen' OR p.proname ~ 'heropen');
  PERFORM proof.record('29', 'er bestaat geen heropen-RPC', v_reopen = 0,
                       format('%s kandidaatfuncties', v_reopen));

  SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reverse_posting_group') INTO v_reversal_ok;
  PERFORM proof.record('30', 'de generieke tegenboekingsmotor staat er onveranderd',
                       v_reversal_ok AND v_src !~* 'reverse_posting_group',
                       'reverse_posting_group bestaat en wordt door de afsluiting niet aangeroepen');
END $$;

DO $$
DECLARE
  v_c uuid := proof.new_client('Tegenboeken na afsluiten');
  v_g uuid;
BEGIN
  -- De jaarafsluiting maakt geen grootboekregel, dus de tegenboekingsmotor
  -- hoefde niet te worden aangepast. Wat zij WEL doet, is het watermerk zetten —
  -- en daar reageert de bestaande motor uit zichzelf al goed op: zij weigert
  -- elke tegenboeking met een datum in een afgesloten boekjaar.
  v_g := proof.seed_group(v_c, 2026);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  CREATE TABLE proof.reversal_subject AS SELECT v_g AS posting_group_id;
END $$;

-- Apart blok, en dus een apart transactie: de tegenboekingsmotor weigert
-- terecht een groep die in DEZELFDE transactie is ontstaan (de zegel van 6C-b2),
-- en dat is niet de weigering die hier bewezen moet worden.
DO $$
DECLARE v_g uuid;
BEGIN
  SELECT posting_group_id INTO v_g FROM proof.reversal_subject;
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  PERFORM proof.expect_error('30b', 'tegenboeken in een zojuist afgesloten jaar wordt geweigerd door de bestaande motor',
    format('SELECT public.reverse_posting_group(%L, DATE ''2026-09-01'')', v_g),
    'afgesloten');
END $$;

-- ═══ 22-24. Tenant, rol en anoniem ══════════════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Rechten');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);

  PERFORM proof.expect_error('22', 'een gebruiker van een ANDERE organisatie wordt geweigerd',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e3', v_c),
    'Administratie niet beschikbaar');

  PERFORM proof.expect_error('23', 'een assistent haalt de rolvloer niet',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e2', v_c),
    'accountant vereist');

  PERFORM set_config('test.user_id', '', true);
  PERFORM proof.expect_error('24a', 'zonder ingelogde gebruiker wordt er niets gelezen of gegrendeld',
    format('SELECT * FROM public.close_fiscal_year(%L, 2026)', v_c),
    'Niet ingelogd');
END $$;

DO $$
BEGIN
  PERFORM proof.record('24b', 'anon mag close_fiscal_year() niet uitvoeren',
    NOT has_function_privilege('anon', 'public.close_fiscal_year(uuid, integer)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.close_fiscal_year(uuid, integer)', 'EXECUTE'),
    'anon: geen EXECUTE, authenticated: wel');
END $$;

-- ═══ 25-27. De marker is onaantastbaar ══════════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Onaantastbaar');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  PERFORM proof.record('25', 'applicatierollen mogen year_closures alleen lezen',
    has_table_privilege('authenticated', 'public.year_closures', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.year_closures', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.year_closures', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.year_closures', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.year_closures', 'SELECT'),
    'SELECT ja; INSERT/UPDATE/DELETE nee; anon niets');

  PERFORM proof.expect_error('26', 'een afsluitbewijs kan niet worden gewijzigd',
    format('UPDATE public.year_closures SET fiscal_year = 2027 WHERE client_id = %L', v_c),
    'append-only');

  PERFORM proof.expect_error('27', 'een afsluitbewijs kan niet worden verwijderd',
    format('DELETE FROM public.year_closures WHERE client_id = %L', v_c),
    'append-only');

  PERFORM proof.expect_error('27b', 'een afsluitbewijs overleeft ook TRUNCATE',
    'TRUNCATE public.year_closures', 'append-only');
END $$;

-- ═══ 28, 31. Het watermerk beweegt alleen nog mét bewijs ════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Watermerkgrendel');
BEGIN
  PERFORM proof.seed_group(v_c, 2025);
  PERFORM proof.seed_group(v_c, 2026);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2025);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  PERFORM proof.expect_error('28a', 'het watermerk kan niet omlaag',
    format('UPDATE public.clients SET afgesloten_boekjaar = 2025 WHERE id = %L', v_c),
    'kan niet omlaag');

  PERFORM proof.expect_error('28b', 'het watermerk kan ook niet worden leeggemaakt',
    format('UPDATE public.clients SET afgesloten_boekjaar = NULL WHERE id = %L', v_c),
    'kan niet omlaag');

  PERFORM proof.expect_error('31', 'het watermerk kan niet met de hand vooruit zonder afsluitbewijs',
    format('UPDATE public.clients SET afgesloten_boekjaar = 2027 WHERE id = %L', v_c),
    'geen afsluitbewijs');
END $$;

-- ═══ Tenantintegriteit van de marker zelf ═══════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Tenantintegriteit');
BEGIN
  PERFORM proof.expect_error('22b', 'een afsluitbewijs kan niet onder de vlag van een andere organisatie',
    format('INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by) VALUES (%L, 2026, %L, %L)',
           v_c, '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000e1'),
    'buiten de organisatie');
END $$;
