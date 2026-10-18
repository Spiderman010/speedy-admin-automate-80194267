-- GESCHIEDENIS VAN VÓÓR PR 1 — throwaway database only.
--
-- Met de echte schrijvers, elke stap in een eigen transactie (zoals in
-- productie): boeken → handmatig storneren → marker weg → opnieuw boeken.
-- Geldig (bewezen historische storno):
--   10  geld eraf, 2 regels, € 3.993 — zoals de regel in productie
--   11  geld erbij, 21% BTW, 3 regels
--   12  voor de reguliere correcties op een historische regel
--   13  negatieve controle: de tussentoestand vóór de fix
--   14  voor de races
--   15  twee keer gestorneerd en opnieuw geboekt (twee historische groepen)
--   16  voor het terugzetten naar de werkstroom
--   17  voor de bekende-storno-controle (PRE B6) in een schone database
--   18  daarna ook de nieuwe boeking handmatig gestorneerd, marker behouden (S2)
--   19  storneren, marker weg en opnieuw boeken in ÉÉN transactie (gelijke created_at)
-- Corrupt (precies één bewijsstuk onwaar):
--   20  niet gestorneerd              21  storno op een latere datum
--   22  geen nieuwe boeking/marker    23  storno zelf tegengeboekt (nagebootst)
--   24  niet neutraal (nagebootst)    25  regel van een andere transactie (nagebootst; 26 is die andere)
--   27  origineel op een andere datum (nagebootst)
--   28  claim op een andere datum (nagebootst)
--   29  storno mist een regel (nagebootst)
--   30  stornoregel zonder verwijzing (nagebootst)
--   31  claim van een andere bronsoort (nagebootst)
--   32  een stornoregel keert een regel van een andere groep om (nagebootst)
--   33  een stornoregel noemt een andere bron dan het origineel (nagebootst)
--   34  de stornoregels op een andere datum dan de claim (nagebootst)
--   35  gestorneerd, marker weg, opnieuw geboekt, die marker ook weg, en daarna de
--       banktransactie zelf verwijderd (kon vóór PR 1)
-- Gewoon (geen geschiedenis): 40 en 41.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ── geldig ──────────────────────────────────────────────────────────────────
SELECT proof.h_post(10, -3993.00), proof.h_post(11, 121.00, 21), proof.h_post(12, -500.00), proof.h_post(13, -250.00),
       proof.h_post(14, -300.00), proof.h_post(15, -150.00), proof.h_post(16, -175.00), proof.h_post(17, -99.00),
       proof.h_post(18, -60.50);
SELECT proof.h_reverse(n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n;
SELECT proof.h_unmark(n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n;
SELECT proof.h_repost(n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n;
-- 15 nog een keer
SELECT proof.h_reverse(15);
SELECT proof.h_unmark(15);
SELECT proof.h_repost(15);
-- 18: ook de nieuwe boeking handmatig gestorneerd, de marker blijft (S2 in PR 1)
SELECT proof.h_reverse(18);
-- 19: storno, marker weg en herboeking in één opdracht, dus één transactie
SELECT proof.h_post(19, -19.00);
SELECT proof.h_reverse(19), proof.h_unmark(19), proof.h_repost(19);

-- ── corrupt, met de schrijvers ──────────────────────────────────────────────
SELECT proof.h_post(20, -20.00), proof.h_post(21, -21.00), proof.h_post(22, -22.00);
SELECT proof.h_reverse(21, DATE '2025-12-01'), proof.h_reverse(22);
SELECT proof.h_unmark(20), proof.h_unmark(21), proof.h_unmark(22);
SELECT proof.h_repost(20), proof.h_repost(21);

-- ── corrupt, nagebootst vanuit een geldige geschiedenis ─────────────────────
SELECT proof.h_post(n, -(n::numeric)) FROM generate_series(23, 34) n;
SELECT proof.btx(41, -41.00, 'Gewone regel 41'), proof.btx(40, -40.00, 'Gewone regel 40');
SELECT proof.h_reverse(n) FROM generate_series(23, 34) n WHERE n <> 26;
SELECT proof.h_unmark(n) FROM generate_series(23, 34) n WHERE n <> 26;
SELECT proof.h_repost(n) FROM generate_series(23, 34) n WHERE n <> 26;

-- 23: de storno is zelf tegengeboekt (een claim die de storno als origineel noemt).
SELECT proof.forge(format($f$
  INSERT INTO public.ledger_reversal_postings
    (original_posting_group_id, reversal_posting_group_id, organization_id, client_id, original_posting_date, original_boekjaar,
     original_source_type, posting_date, boekjaar, line_count, total_amount, currency, reason, user_id)
  SELECT r.reversal_posting_group_id, gen_random_uuid(), r.organization_id, r.client_id, r.posting_date, r.boekjaar,
         'bank_transaction', r.posting_date, r.boekjaar, r.line_count, r.total_amount, r.currency, 'Storno van de storno', r.user_id
  FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = %L $f$, proof.h_orig(23)));
-- 24: niet neutraal: één stornoregel op een andere rekening (de groep blijft in balans).
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET grootboekrekening_id = %L
  WHERE id = (SELECT v.id FROM public.ledger_postings v WHERE v.posting_group_id = %L AND v.credit_amount > 0 LIMIT 1) $f$,
  proof.acct(6), proof.storno_of(proof.h_orig(24))));
-- 25: één regel van het origineel hoort bij een andere transactie (26).
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET source_id = %L
  WHERE id = (SELECT o.id FROM public.ledger_postings o WHERE o.posting_group_id = %L ORDER BY o.line_no LIMIT 1) $f$,
  proof.uid(1000, 26), proof.h_orig(25)));
-- 27: het origineel staat op een andere datum dan de transactie (de claim niet).
SELECT proof.forge(format($f$ UPDATE public.ledger_postings SET posting_date = DATE '2025-11-24' WHERE posting_group_id = %L $f$, proof.h_orig(27)));
-- 28: de claim staat op een andere datum dan de transactie (de regels niet).
SELECT proof.forge(format($f$ UPDATE public.ledger_reversal_postings SET posting_date = DATE '2025-11-26' WHERE original_posting_group_id = %L $f$, proof.h_orig(28)));
-- 29: de storno mist een regel.
SELECT proof.forge(format($f$
  DELETE FROM public.ledger_postings
  WHERE id = (SELECT v.id FROM public.ledger_postings v WHERE v.posting_group_id = %L ORDER BY v.line_no LIMIT 1) $f$,
  proof.storno_of(proof.h_orig(29))));
-- 30: een stornoregel verwijst naar geen enkele regel van het origineel.
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET reversal_of_posting_id = NULL
  WHERE id = (SELECT v.id FROM public.ledger_postings v WHERE v.posting_group_id = %L ORDER BY v.line_no LIMIT 1) $f$,
  proof.storno_of(proof.h_orig(30))));
-- 31: de claim noemt een andere bronsoort.
SELECT proof.forge(format($f$ UPDATE public.ledger_reversal_postings SET original_source_type = 'manual_journal' WHERE original_posting_group_id = %L $f$, proof.h_orig(31)));
-- 32: een stornoregel keert een regel van een andere groep om (de actieve groep van 26, die nooit wordt gestorneerd).
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET reversal_of_posting_id = (SELECT o.id FROM public.ledger_postings o WHERE o.posting_group_id = %L ORDER BY o.line_no LIMIT 1)
  WHERE id = (SELECT v.id FROM public.ledger_postings v WHERE v.posting_group_id = %L ORDER BY v.line_no LIMIT 1) $f$,
  proof.m(26), proof.storno_of(proof.h_orig(32))));
-- 33: een stornoregel noemt een andere bron dan het origineel.
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET source_id = gen_random_uuid()
  WHERE id = (SELECT v.id FROM public.ledger_postings v WHERE v.posting_group_id = %L ORDER BY v.line_no LIMIT 1) $f$,
  proof.storno_of(proof.h_orig(33))));
-- 34: de stornoregels staan op een andere datum dan de transactie (de claim niet).
SELECT proof.forge(format($f$ UPDATE public.ledger_postings SET posting_date = DATE '2025-11-26' WHERE posting_group_id = %L $f$, proof.storno_of(proof.h_orig(34))));

-- 35: de banktransactie bestaat niet meer (een rol die mocht verwijderen, vóór PR 1).
SELECT proof.h_post(35, -35.00);
SELECT proof.h_reverse(35);
SELECT proof.h_unmark(35);
SELECT proof.h_repost(35);
SELECT proof.h_unmark(35);
DELETE FROM public.bank_transactions WHERE id = proof.uid(1000, 35);

-- ── gewoon (geen geschiedenis) ──────────────────────────────────────────────
UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7), btw_percentage = 0
WHERE id IN (proof.uid(1000, 40), proof.uid(1000, 41));
SELECT public.post_bank_transaction(proof.uid(1000, 41));

-- De nagebootste corruptie liet de append-only-trigger weer ENABLE ALWAYS achter.
DO $$
BEGIN
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'prevent_ledger_posting_mutation_trigger'
      AND tgrelid = 'public.ledger_postings'::regclass) IS DISTINCT FROM 'A' THEN
    RAISE EXCEPTION 'de append-only-trigger staat niet meer op ENABLE ALWAYS';
  END IF;
END $$;
