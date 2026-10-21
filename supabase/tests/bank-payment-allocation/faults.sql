-- K — FOUTINJECTIE NÁ ELKE STAP EN BIJ COMMIT. Throwaway database only.
--
-- Harnas-triggers (alleen hier, aan het eind weer weg) gooien een fout zodra
-- proof.fail_at hun naam draagt. Na élke schrijfstap van link en unlink wordt
-- een fout geforceerd; daarna moet alles — koppelingen, facturen,
-- banktransacties, claims, gebeurtenissen, grootboek — exact gelijk zijn, en
-- staat de vlag van de betaalschrijver niet meer aan. Bij COMMIT gebeurt
-- hetzelfde in een echte tweede sessie.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['K1','K2','K3','K4','K5','K6','K7','K8','K9','K10','K11','K12','K13','K14']);

CREATE FUNCTION proof.fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('proof.fail_at', true) = TG_ARGV[0] THEN
    RAISE EXCEPTION 'proof: fout geïnjecteerd na %', TG_ARGV[0] USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER proof_fault_after_claim AFTER INSERT ON public.bank_payment_requests
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_claim');
CREATE TRIGGER proof_fault_after_event AFTER INSERT ON public.bank_payment_events
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_event');
CREATE TRIGGER proof_fault_after_alloc_insert AFTER INSERT ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_alloc_insert');
CREATE TRIGGER proof_fault_after_alloc_delete AFTER DELETE ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_alloc_delete');
CREATE TRIGGER proof_fault_after_sales AFTER UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_invoice');
CREATE TRIGGER proof_fault_after_purchase AFTER UPDATE ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_invoice');
CREATE TRIGGER proof_fault_after_tx AFTER UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION proof.fault('after_tx');
CREATE CONSTRAINT TRIGGER proof_fault_at_commit AFTER INSERT ON public.bank_payment_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proof.fault('at_commit');

/** _sql als _user met proof.fail_at = _point, in dezelfde transactie. */
CREATE FUNCTION proof.faulted(_point text, _user uuid, _sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('proof.fail_at', _point, true);
  v := proof.call(_user, _sql);
  PERFORM set_config('proof.fail_at', '', true);
  RETURN v || ' #vlag=' || coalesce(current_setting('boekassist.betaalschrijver', true), '');
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── uitgangstoestand: één te koppelen paar, één te ontkoppelen paar ──
SELECT proof.tx(1000, 100.00), proof.sinv(1000, 100.00);
SELECT proof.tx(1001, 100.00), proof.sinv(1001, 100.00, 'gecontroleerd', true);
SELECT proof.link(proof.u(6), proof.uid(1000, 1001), 'verkoop', proof.uid(3000, 1001), 100, proof.req(1001));
SELECT proof.put('k_digest', proof.p5digest());

CREATE FUNCTION proof.k(_n text, _name text, _point text, _sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  v := proof.faulted(_point, proof.u(6), _sql);
  PERFORM proof.record(_n, _name,
    v LIKE 'fout [P0001] proof: fout geïnjecteerd na ' || _point || '%'
    AND v LIKE '% #vlag=' AND proof.p5digest() = proof.get('k_digest'), v);
END $$;

SELECT proof.k('K1', 'link: fout na de claim → niets vastgelegd', 'after_claim',
  format('SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 60, %L)', proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002)));
SELECT proof.k('K2', 'link: fout na de gebeurtenis → niets vastgelegd', 'after_event',
  format('SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 60, %L)', proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002)));
SELECT proof.k('K3', 'link: fout na de koppeling → niets vastgelegd', 'after_alloc_insert',
  format('SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 60, %L)', proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002)));
SELECT proof.k('K4', 'link: fout na het restant/de status van de factuur → niets vastgelegd', 'after_invoice',
  format('SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 60, %L)', proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002)));
SELECT proof.k('K5', 'link: fout na de matchvelden van de transactie → niets vastgelegd', 'after_tx',
  format('SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 60, %L)', proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002)));
SELECT proof.k('K6', 'unlink: fout na de claim → niets vastgelegd', 'after_claim',
  format('SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 1001), proof.req(1003)));
SELECT proof.k('K7', 'unlink: fout na de gebeurtenis → niets vastgelegd', 'after_event',
  format('SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 1001), proof.req(1003)));
SELECT proof.k('K8', 'unlink: fout na het verwijderen van de koppeling → niets vastgelegd', 'after_alloc_delete',
  format('SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 1001), proof.req(1003)));
SELECT proof.k('K9', 'unlink: fout na het restant/de status (geboekte factuur, betaald → gecontroleerd) → niets vastgelegd', 'after_invoice',
  format('SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 1001), proof.req(1003)));
SELECT proof.k('K10', 'unlink: fout na de matchvelden → niets vastgelegd', 'after_tx',
  format('SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 1001), proof.req(1003)));

-- ── bij COMMIT, in een echte tweede sessie ──
SELECT proof.open_session('k', :'conn');
SELECT proof.put('k11', proof.remote_exec('k', format(
  $q$BEGIN; SELECT set_config('test.user_id', %L, true); SET LOCAL ROLE authenticated; SET LOCAL proof.fail_at = 'at_commit';
     SELECT outcome FROM public.link_bank_payment(%L, 'verkoop', %L, 60, %L); COMMIT;$q$,
  proof.u(6), proof.uid(1000, 1000), proof.uid(3000, 1000), proof.req(1002))));
SELECT proof.remote_exec('k', 'ROLLBACK');
SELECT proof.record('K11', 'link: fout bij COMMIT (echte tweede sessie) → niets vastgelegd',
  proof.get('k11') LIKE 'fout [P0001]%at_commit%' AND proof.p5digest() = proof.get('k_digest'), proof.get('k11'));

SELECT proof.put('k12', proof.remote_exec('k', format(
  $q$BEGIN; SELECT set_config('test.user_id', %L, true); SET LOCAL ROLE authenticated; SET LOCAL proof.fail_at = 'at_commit';
     SELECT outcome FROM public.unlink_bank_payment(%L, %L); COMMIT;$q$,
  proof.u(6), proof.uid(1000, 1001), proof.req(1003))));
SELECT proof.remote_exec('k', 'ROLLBACK');
SELECT proof.record('K12', 'unlink: fout bij COMMIT (echte tweede sessie) → niets vastgelegd',
  proof.get('k12') LIKE 'fout [P0001]%at_commit%' AND proof.p5digest() = proof.get('k_digest'), proof.get('k12'));

-- De oude app in het uitrolvenster: het vangnet weigert pas bij de echte COMMIT.
SELECT proof.tx(1004, 100.00), proof.sinv(1004, 50.00);
SELECT proof.put('k_digest', proof.p5digest());
SELECT proof.put('k13', proof.remote_exec('k', format(
  $q$BEGIN; SELECT set_config('test.user_id', %L, true); SET LOCAL ROLE authenticated;
     INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
     SELECT id, 'verkoop', %L, client_id, 80, user_id FROM public.bank_transactions WHERE id = %L; COMMIT;$q$,
  proof.u(1), proof.uid(3000, 1004), proof.uid(1000, 1004))));
SELECT proof.remote_exec('k', 'ROLLBACK');
SELECT proof.record('K13', 'directe over-allocatie van de oude app: de INSERT slaagt, de echte COMMIT weigert (23514), niets vastgelegd',
  proof.get('k13') LIKE 'fout [23514]%factuurbedrag%' AND proof.p5digest() = proof.get('k_digest'), proof.get('k13'));
SELECT dblink_disconnect('k');

-- En zonder injectie werkt alles gewoon (de harnas-triggers zelf zijn onschuldig).
SELECT proof.put('k14a', proof.link(proof.u(6), proof.uid(1000, 1000), 'verkoop', proof.uid(3000, 1000), 60, proof.req(1002)));
SELECT proof.put('k14b', proof.unlink(proof.u(6), proof.uid(1000, 1001), proof.req(1003)));
SELECT proof.record('K14', 'zonder injectie: dezelfde aanroepen slagen (60 → restant 40; geboekte factuur weer open)',
  proof.f(proof.get('k14a'), 3) = '40.00' AND proof.get('k14b') = 'ok: unlinked|1|niet_gematcht|f'
  AND proof.inv('verkoop', proof.uid(3000, 1001)) = '100.00|gecontroleerd', proof.get('k14a'));

DROP TRIGGER proof_fault_after_claim ON public.bank_payment_requests;
DROP TRIGGER proof_fault_after_event ON public.bank_payment_events;
DROP TRIGGER proof_fault_after_alloc_insert ON public.bank_transaction_allocations;
DROP TRIGGER proof_fault_after_alloc_delete ON public.bank_transaction_allocations;
DROP TRIGGER proof_fault_after_sales ON public.sales_invoices;
DROP TRIGGER proof_fault_after_purchase ON public.purchase_invoices;
DROP TRIGGER proof_fault_after_tx ON public.bank_transactions;
DROP TRIGGER proof_fault_at_commit ON public.bank_payment_events;
