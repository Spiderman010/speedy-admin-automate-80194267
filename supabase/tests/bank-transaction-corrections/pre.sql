-- NEGATIEVE CONTROLE — vóór PR 1. Throwaway database only.
--
-- Zonder PR 1:
--   NC1  een direct geboekte en daarna handmatig tegengeboekte bankregel zit
--        vast: opnieuw boeken weigert ("al geboekt"), coderen weigert (bevriezing);
--   NC2  de eigenaar kan een marker verwijderen zonder tegenboeking en zonder
--        dat ergens staat waarom (geen lineage);
--   NC3  de eigenaar kan een marker naar een andere boekingsgroep laten wijzen;
--   NC4  de correctie-RPC's bestaan niet.
-- Elke poging wordt in een subtransactie gedaan en teruggedraaid; de database
-- blijft gelijk.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['NC1a', 'NC1b', 'NC2', 'NC3', 'NC4', 'NC5']);

-- Een direct geboekte transactie via het bestaande pad (coderen, dan de schrijver).
SELECT proof.tx(900, -121.00);
UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt',
  grootboekrekening_id = proof.acct(6), btw_percentage = 21 WHERE id = proof.uid(1000, 900);
SELECT proof.put('nc_group', public.post_bank_transaction(proof.uid(1000, 900))::text);
SELECT proof.put('nc_reversal', public.reverse_posting_group(proof.get('nc_group')::uuid, DATE '2027-03-15', 'Handmatig tegengeboekt')::text);

SELECT proof.expect_error('NC1a', 'zonder PR 1: na een handmatige tegenboeking weigert opnieuw boeken ("al geboekt")',
  $$ SELECT public.post_bank_transaction(proof.uid(1000, 900)) $$, '23505', 'al geboekt');

SELECT proof.expect_error('NC1b', 'zonder PR 1: en de codering wijzigen weigert de bevriezing — de regel zit vast',
  $$ UPDATE public.bank_transactions SET grootboekrekening_id = proof.acct(7) WHERE id = proof.uid(1000, 900) $$,
  '42501', 'Een correctie vereist een tegenboeking');

CREATE FUNCTION proof.nc_try(_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE _sql;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'proof-rollback';
  EXCEPTION WHEN others THEN
    IF SQLERRM = 'proof-rollback' THEN
      RETURN 'gelukt (teruggedraaid)';
    END IF;
    RETURN format('geweigerd [%s] %s', SQLSTATE, SQLERRM);
  END;
END $$;

SELECT proof.record('NC2', 'zonder PR 1: de eigenaar kan een marker verwijderen zonder tegenboeking of lineage', o = 'gelukt (teruggedraaid)', o)
FROM proof.nc_try($$
  SELECT proof.tx(901, -50.00);
  UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7) WHERE id = proof.uid(1000, 901);
  SELECT public.post_bank_transaction(proof.uid(1000, 901));
  DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 901) $$) o;

SELECT proof.record('NC3', 'zonder PR 1: de eigenaar kan een marker naar een andere groep laten wijzen', o = 'gelukt (teruggedraaid)', o)
FROM proof.nc_try($$
  UPDATE public.bank_transaction_postings SET posting_group_id = gen_random_uuid()
  WHERE bank_transaction_id = proof.uid(1000, 900) $$) o;

SELECT proof.record('NC4', 'zonder PR 1: de correctie-RPC''s en de gebeurtenistabel bestaan niet',
  to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
  AND to_regprocedure('public.release_bank_transaction_posting(uuid,uuid,uuid,text)') IS NULL
  AND to_regprocedure('public.return_bank_transaction_to_workflow(uuid,uuid,text)') IS NULL
  AND to_regclass('public.bank_transaction_posting_events') IS NULL);

SELECT proof.record('NC5', 'en de negatieve controle liet de database ongewijzigd (alleen de vastzittende regel 900 staat er)',
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE id = proof.uid(1000, 901))
  AND proof.marker(proof.uid(1000, 900)) = proof.get('nc_group')::uuid);
