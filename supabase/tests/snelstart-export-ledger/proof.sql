-- PROOFS — throwaway database only. Never run against any BoekAssist database.
--
-- De facturen uit fixtures.sql worden geboekt via de ECHTE post_purchase_invoice()
-- (laatste definitie 20261002120000), met de rechten en de tenantgrens van de
-- echte schrijver. Daarna wordt vastgelegd wat het grootboek per factuur bevat;
-- export.sql schrijft dat, samen met de bronrijen, naar de fixture die
-- src/test/snelstart-export-ledger.test.ts naast de SnelStart-export legt.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── 1. Rol- en tenantgrens van de schrijver (negatief) ──────────────────────
SELECT proof.expect_error('1.1', 'een lid van een andere organisatie kan niet boeken',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e3', proof.uid(2000, 1))$$, '42501', 'geen rechten');
SELECT proof.expect_error('1.2', 'een read_only-lid kan niet boeken',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e4', proof.uid(2000, 1))$$, '42501', 'geen rechten');

-- ── 2. Boeken als assistant ─────────────────────────────────────────────────
SELECT proof.expect_ok('2.1', 'S1 (A2-04, 21% + 9%) geboekt', $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 1))$$);
SELECT proof.expect_ok('2.2', 'S2 (0%) geboekt',              $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 2))$$);
SELECT proof.expect_ok('2.3', 'S3 (drie tarieven) geboekt',   $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 3))$$);
SELECT proof.expect_ok('2.4', 'S4 (afronding per regel) geboekt', $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 4))$$);
SELECT proof.expect_ok('2.5', 'S5 (kop-btw over het totaal) geboekt: de schrijver toetst de regel-btw niet',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 5))$$);
SELECT proof.expect_ok('2.6', 'S6 (regel zonder btw-%) geboekt: de schrijver kijkt niet naar het regeltarief',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 6))$$);
SELECT proof.expect_ok('2.7', 'S9 (2 × 1,30 @ 21%, kop-btw 0,55 over het totaal) geboekt',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 9))$$);

-- ── 3. Weigeringen die de export ook kent (negatief) ────────────────────────
SELECT proof.expect_error('3.1', 'S7 zonder boekingsregels: geweigerd',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 7))$$, '22023', 'geen boekingsregels');
SELECT proof.expect_error('3.2', 'S8 regel zonder grootboekrekening: geweigerd',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 8))$$, '22023', 'zonder grootboekrekening');
SELECT proof.expect_error('3.3', 'S1 nogmaals boeken: geweigerd (idempotente claim)',
  $$SELECT proof.post_as('00000000-0000-0000-0000-0000000000e1', proof.uid(2000, 1))$$, '23505', 'al geboekt');

-- ── 4. Wat het grootboek bevat ──────────────────────────────────────────────
CREATE VIEW proof.ledger AS
  SELECT lp.source_id, lp.line_no, g.nummer, lp.debit_amount, lp.credit_amount, lp.description, lp.posting_group_id
  FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.source_type = 'purchase_invoice';

SELECT proof.expect_true('4.1', 'precies één marker per geboekte factuur (S1–S6, S9), geen voor S7/S8',
  $$(SELECT count(*) FROM public.purchase_invoice_postings) = 7
    AND NOT EXISTS (SELECT 1 FROM public.purchase_invoice_postings p
                    WHERE p.purchase_invoice_id IN (proof.uid(2000, 7), proof.uid(2000, 8)))$$);
SELECT proof.expect_true('4.2', 'elke boekingsgroep is in balans (debet = credit)',
  $$NOT EXISTS (SELECT 1 FROM proof.ledger GROUP BY posting_group_id HAVING sum(debit_amount) <> sum(credit_amount))$$);
SELECT proof.expect_true('4.3', 'S1: D 4400 100,00 · D 4600 100,00 · D 1520 30,00 · C 1600 230,00',
  $$(SELECT array_agg(format('%s:%s:%s', nummer, debit_amount, credit_amount) ORDER BY line_no)
       FROM proof.ledger WHERE source_id = proof.uid(2000, 1))
    = ARRAY['4400:100.00:0.00', '4600:100.00:0.00', '1520:30.00:0.00', '1600:0.00:230.00']$$);
SELECT proof.expect_true('4.4', 'S5: het grootboek boekt de kop-btw 0,27, niet de regel-btw 0,28',
  $$(SELECT debit_amount FROM proof.ledger WHERE source_id = proof.uid(2000, 5) AND nummer = 1520) = 0.27$$);
SELECT proof.expect_true('4.5', 'S6: geboekt met de kop-btw ondanks een regel zonder btw-%',
  $$(SELECT array_agg(format('%s:%s:%s', nummer, debit_amount, credit_amount) ORDER BY line_no)
       FROM proof.ledger WHERE source_id = proof.uid(2000, 6))
    = ARRAY['4400:100.00:0.00', '1520:21.00:0.00', '1600:0.00:121.00']$$);
SELECT proof.expect_true('4.6', 'de kostenregels volgen sort_order en dragen de regelomschrijving',
  $$(SELECT array_agg(description ORDER BY line_no) FROM proof.ledger
       WHERE source_id = proof.uid(2000, 3) AND nummer NOT IN (1520, 1600))
    = ARRAY['Papier', 'Boeken', 'Premie']$$);
SELECT proof.expect_true('4.7', 'S2 (0%): geen btw-regel, D 7000 50,00 · C 1600 50,00',
  $$(SELECT array_agg(format('%s:%s:%s', nummer, debit_amount, credit_amount) ORDER BY line_no)
       FROM proof.ledger WHERE source_id = proof.uid(2000, 2))
    = ARRAY['7000:50.00:0.00', '1600:0.00:50.00']$$);
SELECT proof.expect_true('4.8', 'S9: het grootboek boekt de kop-btw 0,55 (over het totaal)',
  $$(SELECT array_agg(format('%s:%s:%s', nummer, debit_amount, credit_amount) ORDER BY line_no)
       FROM proof.ledger WHERE source_id = proof.uid(2000, 9))
    = ARRAY['4400:1.30:0.00', '4400:1.30:0.00', '1520:0.55:0.00', '1600:0.00:3.15']$$);
SELECT proof.expect_true('4.9', 'geen fixture raakt een weigering die een latere schrijver toevoegt (NaN, subcenten, btw-vrijgesteld)',
  $$NOT EXISTS (SELECT 1 FROM public.clients WHERE btw_vrijgesteld)
    AND NOT EXISTS (SELECT 1 FROM public.purchase_invoice_lines
                    WHERE amount_excl <> round(amount_excl, 2) OR amount_excl IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
    AND NOT EXISTS (SELECT 1 FROM public.purchase_invoices
                    WHERE 'NaN'::numeric IN (amount_excl, btw_amount, amount_incl))$$);
