-- PRODUCTIEGELIJKE GESCHIEDENIS — throwaway database only.
--
-- Zoals productie volgens PRE 4/PRE 4b: precies één historische storno — een
-- bankregel van 25-11-2025, € 3.993, twee regels, geboekt, dezelfde dag
-- handmatig gestorneerd, marker weg, opnieuw geboekt (alles vóór PR 1) —
-- naast gewone regels: geboekt (41, 42 met BTW) en ongeboekt (40).
-- Met -v known=1 krijgen de drie groepen de groeps-id's uit productie, zodat
-- PRE B6 en POST C4 letterlijk kunnen draaien (nagebootst, alleen hier).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.h_post(10, -3993.00);
SELECT proof.h_reverse(10);
SELECT proof.h_unmark(10);
SELECT proof.h_repost(10);

SELECT proof.h_post(41, -41.00), proof.h_post(42, 121.00, 21);
SELECT proof.btx(40, -40.00, 'Gewone regel 40', _date => DATE '2025-11-26');

\if :known
SELECT proof.put('k_orig', proof.h_orig(10)::text), proof.put('k_storno', proof.storno_of(proof.h_orig(10))::text),
       proof.put('k_actueel', proof.m(10)::text);
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET posting_group_id = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a' WHERE posting_group_id = %1$L;
  UPDATE public.ledger_postings SET posting_group_id = 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8', source_id = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'
  WHERE posting_group_id = %2$L;
  UPDATE public.ledger_postings SET posting_group_id = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3' WHERE posting_group_id = %3$L;
  UPDATE public.ledger_reversal_postings
  SET original_posting_group_id = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a', reversal_posting_group_id = 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8'
  WHERE original_posting_group_id = %1$L;
  UPDATE public.bank_transaction_postings SET posting_group_id = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3' WHERE posting_group_id = %3$L $f$,
  proof.get('k_orig'), proof.get('k_storno'), proof.get('k_actueel')));
DO $$
BEGIN
  IF proof.h_orig(10) IS DISTINCT FROM 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'
     OR proof.storno_of(proof.h_orig(10)) IS DISTINCT FROM 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8'
     OR proof.m(10) IS DISTINCT FROM '0b1aec4c-1bd1-42f3-b392-6a6125da98e3'
     OR proof.unbalanced() <> 0 THEN
    RAISE EXCEPTION 'de productie-id''s zijn niet goed nagebootst';
  END IF;
END $$;
\endif
