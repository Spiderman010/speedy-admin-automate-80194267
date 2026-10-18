-- NEGATIEVE CONTROLE — met PR 1 (20261018120000), vóór PR 2. Throwaway database only.
--
-- Zonder PR 2 schrijft een correctie met omschrijving in de bankregel: de
-- geïmporteerde tekst is weg, en daarmee de sleutel waarop de import een
-- dubbele regel herkent. Deze bewijzen moeten hier slagen; na PR 2 tonen de
-- D-bewijzen het omgekeerde.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['NC1', 'NC2', 'NC3']);

SELECT proof.btx(10, -121.00, 'NS GROEP IZ NS REIZIGERS 0123456789 Amsterdam');
SELECT proof.put('nc_key', proof.dedup_key(10));
SELECT proof.put('nc_post', proof.rc(proof.u(2), proof.uid(1000, 10), NULL, proof.acct(6), 21, proof.req(100)));
SELECT proof.put('nc_fix', proof.rc(proof.u(1), proof.uid(1000, 10), proof.f(proof.get('nc_post'), 3)::uuid,
                                    proof.acct(7), 21, proof.req(101), 'Reiskosten', 'Treinkaartje klantbezoek'));

SELECT proof.record('NC1', 'PR 1: een correctie met omschrijving overschrijft de geïmporteerde bankomschrijving',
  proof.get('nc_fix') LIKE 'ok: reclassified|f|%'
  AND NOT proof.intact(10)
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 10)) = 'Treinkaartje klantbezoek',
  proof.get('nc_fix'));

SELECT proof.record('NC2', 'PR 1: daardoor wijkt de duplicaatsleutel af — dezelfde regel opnieuw importeren wordt niet als dubbel herkend',
  proof.dedup_key(10) IS DISTINCT FROM proof.get('nc_key'), proof.dedup_key(10));

-- Zonder nieuwe omschrijving neemt PR 1 de (inmiddels overschreven) bankregel:
-- zet een gebruiker de bankomschrijving terug, dan valt de boeking stil terug.
UPDATE public.bank_transactions SET description = 'NS GROEP IZ NS REIZIGERS 0123456789 Amsterdam' WHERE id = proof.uid(1000, 10);
SELECT proof.put('nc_acct', proof.rc(proof.u(1), proof.uid(1000, 10), proof.f(proof.get('nc_fix'), 3)::uuid,
                                     proof.acct(6), 21, proof.req(102), 'Toch 8250'));
SELECT proof.record('NC3', 'PR 1: een correctie zonder omschrijving valt terug op de bankomschrijving, niet op de boekingsomschrijving',
  proof.get('nc_acct') LIKE 'ok: reclassified|f|%'
  AND proof.active_text(10) = 'NS GROEP IZ NS REIZIGERS 0123456789 Amsterdam',
  proof.active_text(10));
