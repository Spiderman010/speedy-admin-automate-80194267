-- ─────────────────────────────────────────────────────────────────────────────
-- Rapportagetaxonomie: het tweede niveau (`report_subgroup`)
--
-- WAT HIER GEBEURT, EN WAAROM ZO KLEIN
--
-- Migratie 20260920120000 (TOEGEPAST) gaf `public.grootboekrekeningen` vier
-- nullable kolommen: `statement_type`, `report_group`, `normal_side` en
-- `report_sort`. `report_group` kent vijftien waarden, waarvan zeven voor de
-- balans:
--
--     vaste_activa · vlottende_activa · eigen_vermogen · voorzieningen
--     langlopende_schulden · kortlopende_schulden · prive
--
-- Dat zijn EXACT de zeven balanscategorieën van de gevraagde taxonomie. Wat
-- ontbreekt is geen nieuw categorieëndomein maar een TWEEDE NIVEAU: "Liquide
-- middelen", "Voorraden", "Handelsdebiteuren" en de rest bestonden nergens.
--
-- Daarom blijft `report_group` ongewijzigd — zij IS de Categorie — en komt er
-- één additieve, nullable kolom `report_subgroup` bij: de Groep.
--
-- WAT DAT BETEKENT VOOR BESTAANDE, HANDMATIG INGEVULDE CLASSIFICATIES
-- Alles blijft staan, letterlijk. Een rekening die iemand op `vlottende_activa`
-- heeft gezet, houdt die waarde en krijgt `report_subgroup = NULL`, wat
-- betekent: "categorie gekozen, groep nog niet". Er wordt geen enkele rij
-- gelezen, herschreven, geraden of omgezet. Er is dan ook geen enkele
-- combinatie die door deze migratie ongeldig kan worden: elke nieuwe CHECK
-- slaagt op NULL.
--
-- BEWUSTE AFWIJKING VAN DE LETTERLIJKE OPDRACHT, HIER VASTGELEGD
-- De gevraagde W&V-indeling zet `Huisvestingskosten`, `Verkoopkosten`,
-- `Autokosten` en `Kantoorkosten` op het hoogste niveau. In het bestaande
-- domein zijn dat onderdelen van `overige_bedrijfskosten`. Ze promoveren zou
-- het vijftien-waardendomein wijzigen, en daarmee bestaande gegevens én de
-- statement-engine (Balans/W&V PR 3) ongeldig maken. Ze staan hier daarom als
-- SUBGROEPEN onder `overige_bedrijfskosten`; het formulier toont ze onder die
-- vier kopjes, zodat de gebruiker de gevraagde hiërarchie wél ziet.
--
-- `Resultaat na belasting` is bewust GEEN subgroep. Dat is geen rekening maar
-- een presentatieregel, en de engine berekent hem al als synthetische regel
-- (PR 3). Hem als classificatie aanbieden zou uitnodigen tot een rekening die
-- het resultaat dubbel telt.
--
-- WAT ER NADRUKKELIJK NIET GEBEURT
--   • geen afleiding uit rekeningnummer, omschrijving, `categorie` of bereik;
--   • geen backfill, geen UPDATE, geen INSERT, geen DELETE;
--   • geen wijziging aan de vier bestaande kolommen of hun vijf CHECKs;
--   • geen wijziging aan `ledger_postings` of welke boeking dan ook;
--   • `normal_side` blijft presentatie-metadata en wordt hier niet gezet.
--
-- LEESCONTROLE VOORAF (read-only, vóór toepassen in de Lovable Cloud SQL
-- editor van project alxlbdhpbwlehbdbfejw):
--
--   -- (a) de kolom hoort nog niet te bestaan:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen'
--     AND column_name = 'report_subgroup';
--
--   -- (b) wat er NU handmatig is geclassificeerd — dit blijft ongewijzigd,
--   --     en laat zien welke categorieën al in gebruik zijn:
--   SELECT statement_type, report_group, normal_side, count(*) AS rekeningen
--   FROM public.grootboekrekeningen
--   WHERE statement_type IS NOT NULL OR report_group IS NOT NULL
--   GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
--
--   -- (c) de VIJF bestaande CHECKs moeten er zijn (anders is 20260920120000
--   --     niet toegepast en hoort deze migratie niet te draaien).
--   --
--   --     Ze worden hier bij naam genoemd in plaats van met een LIKE-patroon.
--   --     Twee redenen: `AND ... LIKE ... OR ... LIKE ...` bindt AND sterker
--   --     dan OR, zodat de tweede tak zonder haakjes ELKE tabel zou matchen —
--   --     en `grootboekrekeningen_normal_side_check` begint met geen van beide
--   --     patronen, zodat een van de vijf sowieso buiten beeld bleef. Een
--   --     expliciete lijst heeft geen van beide problemen.
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.grootboekrekeningen'::regclass
--     AND conname IN (
--       'grootboekrekeningen_statement_type_check',
--       'grootboekrekeningen_report_group_check',
--       'grootboekrekeningen_reporting_pair_check',
--       'grootboekrekeningen_normal_side_check',
--       'grootboekrekeningen_report_sort_check'
--     )
--   ORDER BY 1;
--   -- verwacht: vijf rijen
--
--   -- (c2) en deze twee horen nog NIET te bestaan:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.grootboekrekeningen'::regclass
--     AND (
--       conname LIKE 'grootboekrekeningen_report_subgroup%'
--       OR conname LIKE 'grootboekrekeningen_subgroup%'
--     )
--   ORDER BY 1;
--   -- verwacht: geen rijen
--
-- POSTCHECK (na toepassen):
--
--   -- exact één kolom erbij en twee constraints erbij; geen rij gewijzigd:
--   SELECT count(*) FILTER (WHERE report_subgroup IS NOT NULL) AS met_subgroep,
--          count(*) AS totaal
--   FROM public.grootboekrekeningen;
--   -- verwacht: met_subgroep = 0 (niemand heeft nog een groep gekozen)
--
-- rollback:
--   ALTER TABLE public.grootboekrekeningen
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_report_subgroup_check,
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_subgroup_pair_check;
--   ALTER TABLE public.grootboekrekeningen
--     DROP COLUMN IF EXISTS report_subgroup;
--   -- Dit verliest elke groep die sinds toepassing is ingevuld; de vier
--   -- kolommen van 20260920120000 en elke bestaande categorie blijven staan.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0. Vereisten: zonder het eerste niveau heeft een tweede geen betekenis.
DO $$
BEGIN
  IF to_regclass('public.grootboekrekeningen') IS NULL THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: public.grootboekrekeningen.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen'
      AND column_name = 'report_group'
  ) THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: grootboekrekeningen.report_group. Pas eerst 20260920120000 toe.';
  END IF;
END $$;

-- 1. De kolom. Nullable, geen DEFAULT: bestaande en nieuwe rijen starten NULL.
ALTER TABLE public.grootboekrekeningen
  ADD COLUMN IF NOT EXISTS report_subgroup text NULL;

-- 2. De twee CHECKs. Beide slagen op NULL, dus geen bestaande rij kan ze
--    schenden. Alleen toegevoegd wanneer afwezig, zodat het bestand idempotent
--    is.
DO $$
BEGIN
  -- (a) het domein: welke subgroepwaarden überhaupt bestaan.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_report_subgroup_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_report_subgroup_check
      CHECK (report_subgroup IS NULL OR report_subgroup IN (
        -- ── balans ────────────────────────────────────────────────────────
        'immateriele_vaste_activa', 'materiele_vaste_activa', 'financiele_vaste_activa',
        'voorraden', 'handelsdebiteuren', 'overige_vorderingen',
        'belastingen_premies_te_ontvangen', 'overlopende_activa', 'liquide_middelen',
        'ondernemingsvermogen', 'geplaatst_kapitaal', 'agio',
        'algemene_reserve', 'overige_reserves', 'onverdeeld_resultaat',
        'prive_opnamen', 'prive_stortingen',
        'voorzieningen_algemeen',
        'leningen', 'financiele_lease', 'overige_langlopende_schulden',
        'handelscrediteuren', 'belastingen_premies_te_betalen', 'omzetbelasting',
        'loonheffingen', 'schulden_aan_personeel', 'rekening_courant',
        'overige_kortlopende_schulden', 'overlopende_passiva',
        -- ── winst-en-verliesrekening ──────────────────────────────────────
        'omzet_hoog_tarief', 'omzet_laag_tarief', 'omzet_vrijgesteld',
        'omzet_buitenland', 'overige_omzet',
        'inkopen', 'kostprijs_omzet_direct', 'voorraadmutaties', 'uitbesteed_werk',
        'lonen_en_salarissen', 'sociale_lasten', 'pensioenlasten',
        'overige_personeelskosten',
        'huur', 'gas_water_elektra', 'onderhoud_huisvesting',
        'overige_huisvestingskosten',
        'reclame_en_marketing', 'reis_en_representatiekosten', 'overige_verkoopkosten',
        'auto_brandstof', 'auto_onderhoud', 'auto_verzekering', 'auto_lease',
        'auto_motorrijtuigenbelasting', 'auto_overige',
        'kantoorbenodigdheden', 'telefoon_en_internet', 'automatisering_software',
        'administratie_accountancy', 'bankkosten', 'verzekeringen',
        'overige_algemene_kosten',
        'afschrijving_immateriele_vaste_activa', 'afschrijving_materiele_vaste_activa',
        'rentebaten', 'rentelasten', 'bank_financieringskosten',
        'overige_financiele_baten_lasten',
        'vennootschapsbelasting',
        'overige_baten', 'overige_lasten'
      ));
  END IF;

  -- (b) het paar: een subgroep hoort bij precies één categorie.
  --
  --     Zelfde vorm als grootboekrekeningen_reporting_pair_check: een CASE met
  --     IS NOT NULL-bewaking, niet de naïeve OR-vorm. Een CHECK slaagt immers
  --     zodra zijn expressie NULL oplevert, en de OR-vorm accepteert dan
  --     stilzwijgend een subgroep zonder categorie.
  --
  --     `report_subgroup IS NULL` is altijd toegestaan: "categorie gekozen,
  --     groep nog niet" is een normale, tijdelijke toestand — en precies de
  --     toestand waarin elke vandaag bestaande classificatie terechtkomt.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_subgroup_pair_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_subgroup_pair_check
      CHECK (
        CASE
          WHEN report_subgroup IS NULL THEN true
          WHEN report_group IS NULL THEN false
          WHEN report_group = 'vaste_activa' THEN report_subgroup IN (
            'immateriele_vaste_activa', 'materiele_vaste_activa', 'financiele_vaste_activa')
          WHEN report_group = 'vlottende_activa' THEN report_subgroup IN (
            'voorraden', 'handelsdebiteuren', 'overige_vorderingen',
            'belastingen_premies_te_ontvangen', 'overlopende_activa', 'liquide_middelen')
          WHEN report_group = 'eigen_vermogen' THEN report_subgroup IN (
            'ondernemingsvermogen', 'geplaatst_kapitaal', 'agio',
            'algemene_reserve', 'overige_reserves', 'onverdeeld_resultaat')
          WHEN report_group = 'prive' THEN report_subgroup IN (
            'prive_opnamen', 'prive_stortingen')
          WHEN report_group = 'voorzieningen' THEN report_subgroup IN (
            'voorzieningen_algemeen')
          WHEN report_group = 'langlopende_schulden' THEN report_subgroup IN (
            'leningen', 'financiele_lease', 'overige_langlopende_schulden')
          WHEN report_group = 'kortlopende_schulden' THEN report_subgroup IN (
            'handelscrediteuren', 'belastingen_premies_te_betalen', 'omzetbelasting',
            'loonheffingen', 'schulden_aan_personeel', 'rekening_courant',
            'overige_kortlopende_schulden', 'overlopende_passiva')
          WHEN report_group = 'netto_omzet' THEN report_subgroup IN (
            'omzet_hoog_tarief', 'omzet_laag_tarief', 'omzet_vrijgesteld',
            'omzet_buitenland', 'overige_omzet')
          WHEN report_group = 'kostprijs_omzet' THEN report_subgroup IN (
            'inkopen', 'kostprijs_omzet_direct', 'voorraadmutaties', 'uitbesteed_werk')
          WHEN report_group = 'personeelskosten' THEN report_subgroup IN (
            'lonen_en_salarissen', 'sociale_lasten', 'pensioenlasten',
            'overige_personeelskosten')
          WHEN report_group = 'overige_bedrijfskosten' THEN report_subgroup IN (
            'huur', 'gas_water_elektra', 'onderhoud_huisvesting', 'overige_huisvestingskosten',
            'reclame_en_marketing', 'reis_en_representatiekosten', 'overige_verkoopkosten',
            'auto_brandstof', 'auto_onderhoud', 'auto_verzekering', 'auto_lease',
            'auto_motorrijtuigenbelasting', 'auto_overige',
            'kantoorbenodigdheden', 'telefoon_en_internet', 'automatisering_software',
            'administratie_accountancy', 'bankkosten', 'verzekeringen',
            'overige_algemene_kosten')
          WHEN report_group = 'afschrijvingen' THEN report_subgroup IN (
            'afschrijving_immateriele_vaste_activa', 'afschrijving_materiele_vaste_activa')
          WHEN report_group = 'financiele_baten_lasten' THEN report_subgroup IN (
            'rentebaten', 'rentelasten', 'bank_financieringskosten',
            'overige_financiele_baten_lasten')
          WHEN report_group = 'belastingen' THEN report_subgroup IN (
            'vennootschapsbelasting')
          WHEN report_group = 'overig_resultaat' THEN report_subgroup IN (
            'overige_baten', 'overige_lasten')
          ELSE false
        END
      );
  END IF;
END $$;

COMMENT ON COLUMN public.grootboekrekeningen.report_subgroup IS
  'Tweede niveau van de rapportagetaxonomie (de Groep binnen de Categorie report_group). '
  'Nullable: "categorie gekozen, groep nog niet" is een geldige toestand. '
  'Wordt nooit afgeleid uit nummer, omschrijving of categorie — uitsluitend expliciet ingevuld.';
