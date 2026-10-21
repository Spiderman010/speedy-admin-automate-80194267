-- ═════════════════════════════════════════════════════════════════════════════
-- IMPACT — wie merkt 20261021200000_close_fiscal_year_direct_bank_completeness?
--
-- ALLEEN LEZEN. Uitsluitend in de Lovable Cloud SQL editor van
-- alxlbdhpbwlehbdbfejw, vóór (of na) de migratie: de uitkomst hangt niet af
-- van de functie, alleen van de gegevens. Wijzigt niets.
--
-- De regel is letterlijk de nieuwe tak van controle D: een bankregel met
-- match_status = 'handmatig_geboekt', een grootboekrekening, een bedrag <> 0,
-- geen koppeling en geen directe boeking (marker), van de eigen organisatie.
-- Boekjaar = jaar van transaction_date. Een bankregel ZONDER organisatie telt
-- niet: post_bank_transaction() weigert haar altijd (42501), dus zij is niet
-- postbaar (review H-1). IMPACT 1 telt haar wel apart, ter informatie.
--
-- D8 (OPEN ontwerpbesluit): controle D kent per boekjaar alleen een
-- BOVENgrens (boekjaar <= doeljaar), zoals onder PR E voor facturen. Bankwerk
-- van vóór de beginbalans of van vóór de grootboekschrijvers (september 2026)
-- telt dus mee, en het alsnog boeken ervan kan naast een beginbalans dubbel
-- tellen. IMPACT 1 en 2 tellen die regels APART, zodat de eigenaar vóór de
-- GO ziet hoeveel het er zijn; P7 verzint geen ondergrens.
--
-- Een boekjaar dat al is afgesloten (t/m clients.afgesloten_boekjaar) blijft
-- afgesloten: close_fiscal_year() geeft daar het bestaande bewijs terug vóór
-- elke controle. Wie geraakt wordt, is de administratie met zulke regels in een
-- OPEN boekjaar (ook een heropend jaar): zij kan dat jaar, en elk later jaar,
-- pas afsluiten nadat die regels zijn geboekt (bijvoorbeeld via de
-- bank-inhaalslag). Een vrijgegeven regel (bankcorrecties, toestand S3) telt
-- niet mee: de vrijgave zet haar terug op niet_gematcht zonder rekening.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── IMPACT 1. Samenvatting (één rij) ────────────────────────────────────────
-- De laatste vier kolommen zijn informatief:
--   regels_voor_beginbalans       (D8) in een open jaar, met een datum vóór de
--                                 openingsdatum van een GEBOEKTE beginbalans
--                                 van dezelfde administratie
--   regels_van_voor_de_schrijvers (D8) in een open jaar, aangemaakt vóór de
--                                 directe bankschrijver (20260920195805)
--   administraties_met_d8_regels  (D8) hoeveel administraties dat raakt
--   bank_zonder_org_onboekbaar    (H-1) dezelfde regel zonder organisatie;
--                                 telt NIET (de schrijver weigert haar)
WITH open_bank AS (
  SELECT bt.client_id, bt.transaction_date, bt.created_at,
         EXTRACT(YEAR FROM bt.transaction_date)::integer AS boekjaar
  FROM public.bank_transactions bt
  JOIN public.clients c ON c.id = bt.client_id
  WHERE bt.organization_id = c.organization_id
    AND bt.match_status = 'handmatig_geboekt'
    AND bt.grootboekrekening_id IS NOT NULL
    AND bt.amount <> 0
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id)
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = bt.id)
), per_regel AS (
  SELECT o.*,
         (c.afgesloten_boekjaar IS NULL OR o.boekjaar IS NULL OR o.boekjaar > c.afgesloten_boekjaar) AS in_open_jaar,
         EXISTS (SELECT 1 FROM public.opening_balance_postings obp
                 WHERE obp.client_id = o.client_id AND obp.opening_date > o.transaction_date)        AS voor_beginbalans,
         (o.created_at < TIMESTAMPTZ '2026-09-20 19:58:05+00')                                         AS voor_schrijvers
  FROM open_bank o JOIN public.clients c ON c.id = o.client_id
)
SELECT
  count(DISTINCT client_id) FILTER (WHERE in_open_jaar)          AS administraties_geraakt,
  count(*) FILTER (WHERE in_open_jaar)                           AS regels_in_open_jaren,
  count(*) FILTER (WHERE NOT in_open_jaar)                       AS regels_in_al_afgesloten_jaren,
  count(*) FILTER (WHERE boekjaar IS NULL)                       AS regels_zonder_datum,
  count(*) FILTER (WHERE in_open_jaar AND voor_beginbalans)      AS regels_voor_beginbalans,
  count(*) FILTER (WHERE in_open_jaar AND voor_schrijvers)       AS regels_van_voor_de_schrijvers,
  count(DISTINCT client_id) FILTER (WHERE in_open_jaar AND (voor_beginbalans OR voor_schrijvers))
                                                                 AS administraties_met_d8_regels,
  (SELECT count(*) FROM public.bank_transactions bt
   WHERE bt.organization_id IS NULL
     AND bt.match_status = 'handmatig_geboekt'
     AND bt.grootboekrekening_id IS NOT NULL
     AND bt.amount <> 0
     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id)
     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = bt.id))
                                                                 AS bank_zonder_org_onboekbaar
FROM per_regel;


-- ── IMPACT 2. Per administratie (alleen de geraakte) ────────────────────────
WITH open_bank AS (
  SELECT bt.client_id, bt.transaction_date, bt.created_at,
         EXTRACT(YEAR FROM bt.transaction_date)::integer AS boekjaar
  FROM public.bank_transactions bt
  JOIN public.clients c ON c.id = bt.client_id
  WHERE bt.organization_id = c.organization_id
    AND bt.match_status = 'handmatig_geboekt'
    AND bt.grootboekrekening_id IS NOT NULL
    AND bt.amount <> 0
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id)
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = bt.id)
)
SELECT
  c.organization_id,
  c.id                                                             AS client_id,
  c.name                                                           AS administratie,
  c.afgesloten_boekjaar,
  min(o.boekjaar)                                                  AS eerste_jaar_dat_niet_meer_afsluit,
  count(*)                                                         AS ongeboekte_gecodeerde_bankregels,
  array_agg(DISTINCT o.boekjaar ORDER BY o.boekjaar)               AS boekjaren,
  -- D8: de openingsdatum van de geboekte beginbalans, en hoeveel van deze
  -- regels daarvóór liggen of van vóór de directe bankschrijver zijn.
  (SELECT min(obp.opening_date) FROM public.opening_balance_postings obp
   WHERE obp.client_id = c.id)                                     AS beginbalans_per,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.opening_balance_postings obp
                                 WHERE obp.client_id = o.client_id AND obp.opening_date > o.transaction_date))
                                                                   AS regels_voor_beginbalans,
  count(*) FILTER (WHERE o.created_at < TIMESTAMPTZ '2026-09-20 19:58:05+00')
                                                                   AS regels_van_voor_de_schrijvers
FROM open_bank o
JOIN public.clients c ON c.id = o.client_id
WHERE c.afgesloten_boekjaar IS NULL OR o.boekjaar IS NULL OR o.boekjaar > c.afgesloten_boekjaar
GROUP BY c.organization_id, c.id, c.name, c.afgesloten_boekjaar
ORDER BY c.organization_id, min(o.boekjaar), c.name;


-- ── IMPACT 3. B1-04 — bronrijen van een ANDERE organisatie (informatief) ────
-- Deze rijen dragen het client_id van een administratie maar een andere
-- organization_id. Onder PR E telden zij mee (en konden zij een afsluiting
-- blokkeren); na P7 niet meer. Verwacht in de vijf `…_andere_org`-kolommen: 0.
-- Een getal > 0 is een kruisverwijzing (B1-02) die apart onderzoek verdient; P7
-- verandert de rijen zelf niet. De `…_zonder_org`-kolommen zijn erfenis (B1-07):
-- een inkoop-, verkoopfactuur of koppeling zonder organisatie telt vóór en ná
-- P7 mee (zoals PR E); een BANKREGEL zonder organisatie telt in de nieuwe
-- banktak NIET, omdat post_bank_transaction() haar weigert (review H-1).
SELECT
  (SELECT count(*) FROM public.purchase_invoices pi JOIN public.clients c ON c.id = pi.client_id
   WHERE pi.organization_id IS NOT NULL AND pi.organization_id <> c.organization_id)            AS inkoop_andere_org,
  (SELECT count(*) FROM public.sales_invoices si JOIN public.clients c ON c.id = si.client_id
   WHERE si.organization_id IS NOT NULL AND si.organization_id <> c.organization_id)            AS verkoop_andere_org,
  (SELECT count(*) FROM public.bank_transaction_allocations a JOIN public.clients c ON c.id = a.client_id
   WHERE a.organization_id IS NOT NULL AND a.organization_id <> c.organization_id)              AS koppelingen_andere_org,
  (SELECT count(*) FROM public.bank_transactions bt JOIN public.clients c ON c.id = bt.client_id
   WHERE bt.organization_id IS NOT NULL AND bt.organization_id <> c.organization_id)            AS bank_andere_org,
  (SELECT count(*) FROM public.manual_journals mj JOIN public.clients c ON c.id = mj.client_id
   WHERE mj.organization_id <> c.organization_id)                                               AS memoriaal_andere_org,
  -- Ter vergelijking: rijen ZONDER organisatie (facturen/koppelingen tellen
  -- mee; bankregels niet, zie hierboven en IMPACT 1).
  (SELECT count(*) FROM public.purchase_invoices WHERE organization_id IS NULL)                 AS inkoop_zonder_org,
  (SELECT count(*) FROM public.sales_invoices WHERE organization_id IS NULL)                    AS verkoop_zonder_org,
  (SELECT count(*) FROM public.bank_transaction_allocations WHERE organization_id IS NULL)      AS koppelingen_zonder_org,
  (SELECT count(*) FROM public.bank_transactions WHERE organization_id IS NULL)                 AS bank_zonder_org;
