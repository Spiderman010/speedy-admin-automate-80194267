-- ═════════════════════════════════════════════════════════════════════════════
-- P4 — BTW EN NaN: VALIDATIE IN DE SCHRIJVERS (fail-closed)
-- Bevindingen E-06/A3-08, F1c-N1 (ontwerpbesluit D4 OPEN), A3-01, A3-16.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WAAROM
--   • E-06: post_bank_transaction() boekte een ontbrekend btw-percentage (NULL)
--     stil als 0%. Een gecodeerde kostenpost van 21% kwam zo zonder
--     voorbelasting in het grootboek, zonder dat iemand het zag. Elke
--     codeerroute in de app vraagt een expliciete keuze — ook "Geen BTW" (0) is
--     een keuze, ook bij een btw-vrijgestelde administratie — en de bulklaag
--     biedt zo'n regel niet aan (applyVatChoiceGate). De server dwingt nu
--     precies die regel af.
--   • F1c-N1: post_purchase_invoice() boekte btw van een btw-vrijgestelde
--     administratie als voorbelasting (btw te vorderen). Hoe btw op inkopen
--     van een vrijgestelde administratie wél moet worden verwerkt, is nog niet
--     besloten (D4). Tot dat besluit: weigeren, niet gokken.
--   • A3-01: in PostgreSQL is 'NaN' = 'NaN' WAAR en is NaN groter dan elk
--     getal. Een NaN-bedrag glipt daardoor door elke controle van de schrijvers
--     ("niet negatief", "sluit aan", "groep in balans") en belandt als NaN in
--     het grootboek.
--   • A3-16: een inkoopregel (numeric zonder schaal) kan fracties van een cent
--     bevatten; het grootboek (numeric(12,2)) rondt die bij het boeken af, en
--     dan wijkt de boeking stil af van de bron, of weigert de groepsbalans met
--     een onbegrijpelijke melding.
--
-- WAT (zelfde signaturen, uitkomsttypes, eigenaar, SECURITY DEFINER/INVOKER,
-- search_path en functiecommentaar; CREATE OR REPLACE behoudt die)
--   1. post_bank_transaction():
--      - btw_percentage IS NULL → 22004 "Het BTW-percentage van deze
--        banktransactie is nog niet gekozen; …", ook bij een vrijgestelde
--        administratie (de app vraagt daar evengoed een keuze). Explicit 0, 9
--        en 21 boeken ongewijzigd; bij een vrijgestelde administratie blijft
--        elk gekozen percentage 0 (geen BTW), zoals altijd.
--      - btw_percentage NaN of ±oneindig → 22023 (de bestaande melding
--        "Ongeldig BTW-percentage"); ook bij een vrijgestelde administratie,
--        waar zo'n waarde tot nu toe stil 0 werd.
--      - amount NaN → 22023.
--      De toets op NULL staat in het BTW-blok, ná de leesdrempel, de
--      schrijfdrempel, de tenant- en statuscontroles en de boekingsblokkade:
--      een vreemde of geblokkeerde regel krijgt dus dezelfde fout als voorheen.
--   2. bank_bulk_posting_candidates(): een regel die verder 'ready' zou zijn
--      maar geen btw-percentage heeft, is 'review_needed' met precies de reden
--      die de app al toont (VAT_NOT_CHOSEN_REASON). Elke eerdere arm (geboekt,
--      gekoppeld, nul, gematcht, status, grootboekrekening, bankrekening,
--      BTW-rekening, boekingsblokkade) gaat voor, net als in de app.
--   3. post_bank_transactions_bulk(): 22004 hoort voortaan bij de eigen,
--      tenantveilige woordenschat die ongeschonden naar buiten gaat. Binnen
--      post_bank_transaction() kan 22004 alleen nog komen uit de toets van punt
--      1 en uit assert_posting_allowed() ("Boekingsdatum of administratie
--      ontbreekt …"); geen van beide noemt een id of andermans gegevens.
--   4. post_purchase_invoice():
--      - een NaN-bedrag (kop) of een NaN/±oneindig regelbedrag → 22023;
--      - btw-vrijgesteld en btw > 0 → 0A000 (zoals verlegde btw bij verkoop:
--        "nog niet ondersteund"); zonder btw boekt zij zoals altijd, en nooit
--        met een regel "BTW te vorderen";
--      - een regel met fracties van een cent → 22023, vóór de aansluitcontrole.
--   5. post_sales_invoice(): een NaN-bedrag → 22023.
--   6. CHECK-constraints NOT VALID tegen NaN op de bedragkolommen van
--      ledger_postings, purchase_invoices, sales_invoices,
--      purchase_invoice_lines (daar ook ±oneindig: de kolom heeft geen schaal)
--      en bank_transactions. NOT VALID: bestaande rijen worden NIET getoetst
--      (geen volledige tabelscan, geen weigering op historie), elke nieuwe of
--      gewijzigde rij wel. `x <> 'NaN'::numeric` is ONWAAR precies voor NaN,
--      en NULL (onbekend) laat de CHECK door.
--
-- WAT NIET
--   Geen btw-beleid: geen percentage wordt afgeleid, geen standaard ingevuld,
--   geen bestaande rij bijgewerkt (geen backfill, geen UPDATE/DELETE, geen
--   trigger). Geen kolom of tabel weg of hernoemd, geen nieuwe kolom, geen
--   wijziging van DEFAULT 21 op purchase_invoices/sales_invoices.btw_percentage
--   (open punt), geen nieuwe schrijfroute voor remaining_amount of status.
--   Elke andere toets, grendel, volgorde, foutcode en boeking van de vijf
--   functies is letterlijk die van 20261002120000 (vier functies) en
--   20260922120000 (de bulk). De boekhoudkundige uitkomst van alles wat wél
--   wordt geboekt, is ongewijzigd.
--
-- GEVOLG VOOR BESTAANDE GEGEVENS (geteld door preflight.sql, read-only)
--   • Gecodeerde, ongeboekte bankregels zonder btw-percentage worden
--     'review_needed' en boeken pas na een keuze.
--   • Ongeboekte inkoopfacturen van een vrijgestelde administratie met btw > 0
--     boeken niet meer (tot besluit D4).
--   • Ongeboekte inkoopfacturen met regels in fracties van een cent boeken pas
--     na opnieuw opslaan in de werkbank (die slaat hele centen op).
--   • Een bestaande NaN-rij kan na deze migratie niet meer worden bijgewerkt
--     zonder dat het bedrag wordt hersteld (de CHECK geldt voor elke nieuwe
--     rijversie). Telling Q7.
--
-- LATER, APART (na telling Q7 = 0 in productie; SHARE UPDATE EXCLUSIVE, leest
-- de tabel, blokkeert geen lezen of schrijven):
--   ALTER TABLE public.ledger_postings        VALIDATE CONSTRAINT ledger_postings_amounts_not_nan;
--   ALTER TABLE public.purchase_invoices      VALIDATE CONSTRAINT purchase_invoices_amounts_not_nan;
--   ALTER TABLE public.sales_invoices         VALIDATE CONSTRAINT sales_invoices_amounts_not_nan;
--   ALTER TABLE public.purchase_invoice_lines VALIDATE CONSTRAINT purchase_invoice_lines_amount_finite;
--   ALTER TABLE public.bank_transactions      VALIDATE CONSTRAINT bank_transactions_amount_not_nan;
--
-- PRODUCTIE (Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw)
--   Ná 20261018150000 (PR 2; deze migratie weigert anders, zie de voorwaarden):
--   supabase/rollout/20261021170000_btw_en_nan_validatie_in_schrijvers/preflight.sql
--   → SET lock_timeout = '5s'; + deze migratie in één uitvoering → postcheck.sql.
--   (ADD CONSTRAINT neemt kort een ACCESS EXCLUSIVE-grendel per tabel.)
--
-- ROLLBACK (handmatig, met akkoord van de eigenaar; data-neutraal)
--   -- rollback: voer supabase/rollout/20261021170000_btw_en_nan_validatie_in_schrijvers/rollback.sql
--   --           uit; dat zet de vijf functies byte-gelijk terug (md5 van vóór
--   --           deze migratie) en verwijdert de vijf CHECK-constraints.
--   Let op: 20261018150000 (PR 2) pint de md5 van post_bank_transaction; zolang
--   deze migratie staat, kan PR 2 niet opnieuw worden toegepast. Draai bij een
--   terugdraaiing van PR 2 of eerder dus eerst deze migratie terug.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Voorwaarden: precies de beoordeelde toestand, anders niets ───────────
DO $migratie$
DECLARE
  v_naam text;
  v_hash text;
  v_voor text;
  v_na   text;
BEGIN
  IF to_regclass('public.ledger_postings') IS NULL
     OR to_regclass('public.purchase_invoices') IS NULL
     OR to_regclass('public.purchase_invoice_lines') IS NULL
     OR to_regclass('public.sales_invoices') IS NULL
     OR to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: een van de tabellen ledger_postings, purchase_invoices, purchase_invoice_lines, sales_invoices, bank_transactions of clients ontbreekt' USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('ledger_postings', 'debit_amount'), ('ledger_postings', 'credit_amount'),
          ('purchase_invoices', 'amount_excl'), ('purchase_invoices', 'btw_amount'), ('purchase_invoices', 'amount_incl'),
          ('sales_invoices', 'amount_excl'), ('sales_invoices', 'btw_amount'), ('sales_invoices', 'amount_incl'),
          ('purchase_invoice_lines', 'amount_excl'), ('bank_transactions', 'amount'),
          ('bank_transactions', 'btw_percentage'), ('clients', 'btw_vrijgesteld'))) <> 12 THEN
    RAISE EXCEPTION 'Voorwaarde: een vereiste kolom ontbreekt (bedragen, bank_transactions.btw_percentage of clients.btw_vrijgesteld)' USING ERRCODE = '55000';
  END IF;

  IF to_regprocedure('public.assert_posting_allowed(uuid,date)') IS NULL
     OR to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: assert_posting_allowed, posting_account_ok of has_min_role ontbreekt' USING ERRCODE = '55000';
  END IF;

  -- PR 2 (20261018150000) pint de md5 van post_bank_transaction. Wie deze
  -- migratie vóór PR 2 toepast, maakt PR 2 ontoepasbaar; dus eerst PR 2.
  -- (to_regprocedure, geen ::regprocedure: die cast faalt al bij het plannen
  -- als de functie ontbreekt, en dan verscheen deze melding nooit.)
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
     IS DISTINCT FROM '067939e0c44a672c26ec8883717ef6d2' THEN
    RAISE EXCEPTION 'Voorwaarde: 20261018150000 (PR 2) is niet toegepast; pas eerst PR 1 en PR 2 toe' USING ERRCODE = '55000';
  END IF;

  -- ── Anti-clobber ──────────────────────────────────────────────────────────
  --    Vijf volledige lichamen worden vervangen. Dat mag alleen als het huidige
  --    lichaam exact het beoordeelde is: dat van vóór deze migratie, of het
  --    lichaam dat deze migratie zelf schrijft (tweede uitvoering). Elke andere
  --    hash wordt geweigerd vóórdat er ook maar één CREATE OR REPLACE draait.
  FOREACH v_naam IN ARRAY ARRAY['post_purchase_invoice', 'post_sales_invoice', 'post_bank_transaction',
                                'bank_bulk_posting_candidates', 'post_bank_transactions_bulk'] LOOP
    SELECT md5(p.prosrc) INTO v_hash
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(CASE v_naam
      WHEN 'post_purchase_invoice'        THEN 'public.post_purchase_invoice(uuid)'
      WHEN 'post_sales_invoice'           THEN 'public.post_sales_invoice(uuid)'
      WHEN 'post_bank_transaction'        THEN 'public.post_bank_transaction(uuid)'
      WHEN 'bank_bulk_posting_candidates' THEN 'public.bank_bulk_posting_candidates(uuid,integer)'
      WHEN 'post_bank_transactions_bulk'  THEN 'public.post_bank_transactions_bulk(uuid[])'
    END);
    v_voor := CASE v_naam
      WHEN 'post_purchase_invoice'        THEN '6366f052209d9a171f197de77eaf477a'
      WHEN 'post_sales_invoice'           THEN 'cb467b35301239c3051c8b918662ea45'
      WHEN 'post_bank_transaction'        THEN '2369978c713ac78a0c039dd5c3e5eb4c'
      WHEN 'bank_bulk_posting_candidates' THEN '946bef45005d6e572a7565da6fc12cdb'
      WHEN 'post_bank_transactions_bulk'  THEN '1e5d90d98bf488dbdcbed483b72085ab'
    END;
    v_na := CASE v_naam
      WHEN 'post_purchase_invoice'        THEN '4d183b1e5fe11f37d508a3e7f764176f'
      WHEN 'post_sales_invoice'           THEN 'd05b6c0a4b9c3dd6ef6a835ff37f9b64'
      WHEN 'post_bank_transaction'        THEN '28ac97ed4e030759bbb31082da50c118'
      WHEN 'bank_bulk_posting_candidates' THEN '4b04544d2292704d8ac034edc909055c'
      WHEN 'post_bank_transactions_bulk'  THEN '885fe27bd78d6cc3836fc760412015ed'
    END;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION 'Voorwaarde: public.%() ontbreekt', v_naam USING ERRCODE = '55000';
    END IF;
    IF v_hash <> v_voor AND v_hash <> v_na THEN
      RAISE EXCEPTION 'Geweigerd: public.%() heeft een onbekend lichaam (md5(prosrc) = %; verwacht vóór deze migratie: %, of erna: %). Niets is gewijzigd.',
        v_naam, v_hash, v_voor, v_na USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Een constraint met een van onze namen op een andere tabel, van een ander
  -- type of met een andere CHECK-expressie: weigeren (gevalideerd of niet).
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN (VALUES
      ('public.ledger_postings'::regclass,        'ledger_postings_amounts_not_nan',
       'CHECK (((debit_amount <> ''NaN''::numeric) AND (credit_amount <> ''NaN''::numeric)))'),
      ('public.purchase_invoices'::regclass,      'purchase_invoices_amounts_not_nan',
       'CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric)))'),
      ('public.sales_invoices'::regclass,         'sales_invoices_amounts_not_nan',
       'CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric)))'),
      ('public.purchase_invoice_lines'::regclass, 'purchase_invoice_lines_amount_finite',
       'CHECK (((amount_excl <> ''NaN''::numeric) AND (amount_excl <> ''Infinity''::numeric) AND (amount_excl <> ''-Infinity''::numeric)))'),
      ('public.bank_transactions'::regclass,      'bank_transactions_amount_not_nan',
       'CHECK ((amount <> ''NaN''::numeric))')
    ) AS d(rel, naam, definitie) ON c.conname = d.naam
    WHERE c.conrelid <> d.rel OR c.contype <> 'c'
       OR regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', '') <> d.definitie
  ) THEN
    RAISE EXCEPTION 'Geweigerd: een constraint met een naam uit deze migratie bestaat al op een andere tabel, van een ander type of met een andere definitie' USING ERRCODE = '55000';
  END IF;
END
$migratie$;

-- ── 1. post_purchase_invoice ────────────────────────────────────────────────
--    Letterlijk 20261002120000, met drie toetsen erbij: NaN (A3-01),
--    btw-vrijgesteld met btw (F1c-N1, D4 open) en fracties van een cent (A3-16).

CREATE OR REPLACE FUNCTION public.post_purchase_invoice(_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_inv              public.purchase_invoices%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_btw              numeric(12,2);
  v_sum_lines        numeric(12,2);
  v_line_count       integer;
  v_bad_accounts     integer;
  v_subcent          integer;
  v_line_no          integer := 0;
  v_line             record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- FOR UPDATE: save_purchase_invoice_with_lines UPDATEs this row before it
  -- replaces the lines, so taking the same row lock here serialises save
  -- against post. Whichever starts first finishes first: a save in flight makes
  -- posting wait and then read the fully committed new source, and a posting in
  -- flight makes the save wait and then be refused by the immutability guards
  -- below, because the marker now exists. A mixed old-header/new-lines snapshot
  -- is therefore impossible.
  SELECT * INTO v_inv FROM public.purchase_invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Tenant + role, both from stored data. 'assistant' matches the minimum the
  -- ledger_postings INSERT policy itself requires.
  IF v_inv.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_inv.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_inv.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_inv.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze factuur' USING ERRCODE = '42501';
  END IF;

  -- Only a finalised invoice may post. te_controleren is explicitly refused, so
  -- an ordinary save can never produce accounting.
  IF v_inv.status NOT IN ('gecontroleerd', 'betaald', 'geexporteerd') THEN
    RAISE EXCEPTION 'Alleen een gecontroleerde inkoopfactuur kan worden geboekt (status: %)', v_inv.status
      USING ERRCODE = '22023';
  END IF;

  IF v_inv.invoice_date IS NULL THEN
    RAISE EXCEPTION 'Inkoopfactuur heeft geen factuurdatum; een boeking vereist een boekingsdatum'
      USING ERRCODE = '22004';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_inv.invoice_date)::integer;
  -- Het jaarwatermerk (clients.afgesloten_boekjaar) is hier sinds 20261002120000
  -- geen boekingstoets meer. De boekingsblokkade — assert_posting_allowed()
  -- hieronder — is de enige datumgrendel; de boekjaarstatus is een
  -- administratief gegeven van de jaarafsluiting.

  -- PR D — DE BOEKINGSBLOKKADE. Autoriteit voor deze schrijver: factuurdatum van de inkoopfactuur.
  --        De helper grendelt eerst de administratie (lock_ledger_client),
  --        zodat een gelijktijdige set_posting_lock() er niet tussendoor kan.
  PERFORM public.assert_posting_allowed(v_inv.client_id, v_inv.invoice_date);

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Inkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG. In PostgreSQL is 'NaN' = 'NaN'
  -- waar en is NaN groter dan elk getal: een NaN-bedrag glipt door elke toets
  -- hieronder (ook "sluit aan") en zou als NaN in het grootboek belanden. Een
  -- regelbedrag (numeric zonder schaal) kan bovendien ±oneindig zijn.
  IF v_inv.amount_excl = 'NaN'::numeric OR v_btw = 'NaN'::numeric OR v_inv.amount_incl = 'NaN'::numeric
     OR EXISTS (SELECT 1 FROM public.purchase_invoice_lines l
                WHERE l.purchase_invoice_id = v_inv.id
                  AND l.amount_excl IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) THEN
    RAISE EXCEPTION 'Inkoopfactuur heeft een bedrag dat geen getal is (NaN); herstel de bedragen voordat u boekt'
      USING ERRCODE = '22023';
  END IF;

  IF v_inv.amount_excl < 0 OR v_btw < 0 OR v_inv.amount_incl <= 0 THEN
    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'
      USING ERRCODE = '22023';
  END IF;

  -- F1c-N1 (20261021170000) — BTW-VRIJGESTELD; ontwerpbesluit D4 is OPEN. Een
  -- vrijgestelde administratie boekt geen voorbelasting. Hoe btw op haar
  -- inkopen dan wél wordt verwerkt (bijvoorbeeld als kosten), is nog niet
  -- besloten: tot dat besluit wordt zo'n factuur geweigerd — niet stil met
  -- voorbelasting en niet stil zonder btw geboekt. Zonder btw boekt zij zoals
  -- altijd.
  IF v_client.btw_vrijgesteld AND v_btw > 0 THEN
    RAISE EXCEPTION 'Deze administratie is btw-vrijgesteld en kan geen voorbelasting boeken, maar de factuur bevat een btw-bedrag van %. Hoe btw op inkopen van een vrijgestelde administratie wordt verwerkt, is nog niet besloten; boeken is daarom niet mogelijk', v_btw
      USING ERRCODE = '0A000';
  END IF;

  -- Configuration. No fallback account, ever.
  IF v_client.crediteuren_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen crediteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  IF v_btw > 0 AND v_client.btw_te_vorderen_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen rekening voor BTW te vorderen ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- A3-16 (20261021170000) — HELE CENTEN. Een regelbedrag met fracties van een
  -- cent wordt door het grootboek (numeric(12,2)) bij het boeken afgerond; de
  -- boeking wijkt dan stil af van de bron, of de groepsbalans weigert. Hier
  -- weigeren, vóór de aansluittoets (die de som al op centen afrondt).
  SELECT COUNT(*) INTO v_subcent
  FROM public.purchase_invoice_lines l
  WHERE l.purchase_invoice_id = v_inv.id
    AND l.amount_excl <> round(l.amount_excl, 2);

  IF v_subcent > 0 THEN
    RAISE EXCEPTION '% boekingsregel(s) met een bedrag in fracties van een cent; rond elke regel af op hele centen en boek daarna opnieuw', v_subcent
      USING ERRCODE = '22023';
  END IF;

  -- Lines: at least one, each with an account.
  SELECT COUNT(*), COALESCE(SUM(l.amount_excl), 0),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL)
    INTO v_line_count, v_sum_lines, v_bad_accounts
  FROM public.purchase_invoice_lines l
  WHERE l.purchase_invoice_id = v_inv.id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Inkoopfactuur heeft geen boekingsregels' USING ERRCODE = '22023';
  END IF;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION '% boekingsregel(s) zonder grootboekrekening; boeken is niet mogelijk', v_bad_accounts
      USING ERRCODE = '22023';
  END IF;

  -- Exact reconciliation, in NUMERIC. No tolerance: see the header comment.
  IF v_sum_lines <> v_inv.amount_excl THEN
    RAISE EXCEPTION 'Regels (%) sluiten niet aan op het factuurbedrag exclusief BTW (%)', v_sum_lines, v_inv.amount_excl
      USING ERRCODE = '23514';
  END IF;

  IF v_inv.amount_excl + v_btw <> v_inv.amount_incl THEN
    RAISE EXCEPTION 'Bedrag exclusief (%) plus BTW (%) sluit niet aan op het bedrag inclusief (%)',
      v_inv.amount_excl, v_btw, v_inv.amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Account scope: every account must be usable by THIS administratie.
  SELECT COUNT(*) INTO v_bad_accounts
  FROM public.purchase_invoice_lines l
  WHERE l.purchase_invoice_id = v_inv.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_inv.organization_id, v_inv.client_id);
  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Een boekingsregel verwijst naar een grootboekrekening buiten deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_client.crediteuren_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde crediteurenrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_btw > 0
     AND NOT public.posting_account_ok(v_client.btw_te_vorderen_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde rekening voor BTW te vorderen hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  -- Claim the invoice. The primary key is the idempotency guarantee and, under
  -- concurrency, the serialisation point: a second session blocks here until
  -- the first commits and then fails.
  BEGIN
    INSERT INTO public.purchase_invoice_postings (
      purchase_invoice_id, posting_group_id, organization_id, client_id, user_id
    ) VALUES (
      v_inv.id, v_group_id, v_inv.organization_id, v_inv.client_id, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze inkoopfactuur is al geboekt' USING ERRCODE = '23505';
  END;

  -- DEBIT: one row per expense line, in a deterministic order.
  FOR v_line IN
    SELECT l.grootboekrekening_id, l.amount_excl, l.omschrijving
    FROM public.purchase_invoice_lines l
    WHERE l.purchase_invoice_id = v_inv.id
    ORDER BY l.sort_order, l.id
  LOOP
    -- A zero-amount line cannot be posted (ledger rows must have one positive
    -- side), and silently dropping it would break reconciliation.
    IF v_line.amount_excl <= 0 THEN
      RAISE EXCEPTION 'Boekingsregel met bedrag % kan niet worden geboekt', v_line.amount_excl
        USING ERRCODE = '22023';
    END IF;

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, v_line.amount_excl, 0, 'EUR',
      v_line.omschrijving, 'purchase_invoice', v_inv.id, NULL, v_uid
    );
  END LOOP;

  -- DEBIT: recoverable VAT, only when there is any.
  IF v_btw > 0 THEN
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_client.btw_te_vorderen_rekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, v_btw, 0, 'EUR',
      'BTW te vorderen', 'purchase_invoice', v_inv.id, NULL, v_uid
    );
  END IF;

  -- CREDIT: the supplier debt.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_client.crediteuren_rekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, 0, v_inv.amount_incl, 'EUR',
    COALESCE(v_inv.supplier, 'Crediteur'), 'purchase_invoice', v_inv.id, NULL, v_uid
  );

  RETURN v_group_id;
END
$$;

-- ── 2. post_sales_invoice ───────────────────────────────────────────────────
--    Letterlijk 20261002120000, met de NaN-toets (A3-01) erbij.

CREATE OR REPLACE FUNCTION public.post_sales_invoice(_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_inv       public.sales_invoices%ROWTYPE;
  v_client    public.clients%ROWTYPE;
  v_group_id  uuid := gen_random_uuid();
  v_boekjaar  integer;
  v_btw       numeric(12,2);
  v_line_no   integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- FOR UPDATE: the sales save path (useUpdateSalesInvoice) is a plain UPDATE
  -- on this row, so taking the same row lock here serialises save against
  -- post exactly as for purchase. Whichever starts first finishes first: a
  -- save in flight makes posting wait and then read the fully committed new
  -- source, and a posting in flight makes the save wait and then be refused
  -- by the immutability guard below, because the marker now exists.
  SELECT * INTO v_inv FROM public.sales_invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Tenant + role, both from stored data. 'assistant' matches the minimum the
  -- ledger_postings INSERT policy itself requires.
  IF v_inv.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_inv.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_inv.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_inv.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze factuur' USING ERRCODE = '42501';
  END IF;

  -- Only a finalised invoice may post. concept and verzonden are explicitly
  -- refused, so an ordinary save or a "sent to customer" marker can never
  -- produce accounting on their own.
  IF v_inv.status NOT IN ('gecontroleerd', 'betaald') THEN
    RAISE EXCEPTION 'Alleen een gecontroleerde verkoopfactuur kan worden geboekt (status: %)', v_inv.status
      USING ERRCODE = '22023';
  END IF;

  -- Defensive: invoice_date is NOT NULL at the schema level today, so this
  -- branch is currently unreachable, but the writer does not lean on a
  -- constraint it does not itself own.
  IF v_inv.invoice_date IS NULL THEN
    RAISE EXCEPTION 'Verkoopfactuur heeft geen factuurdatum; een boeking vereist een boekingsdatum'
      USING ERRCODE = '22004';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_inv.invoice_date)::integer;
  -- Het jaarwatermerk (clients.afgesloten_boekjaar) is hier sinds 20261002120000
  -- geen boekingstoets meer. De boekingsblokkade — assert_posting_allowed()
  -- hieronder — is de enige datumgrendel; de boekjaarstatus is een
  -- administratief gegeven van de jaarafsluiting.

  -- PR D — DE BOEKINGSBLOKKADE. Autoriteit voor deze schrijver: factuurdatum van de verkoopfactuur.
  --        De helper grendelt eerst de administratie (lock_ledger_client),
  --        zodat een gelijktijdige set_posting_lock() er niet tussendoor kan.
  PERFORM public.assert_posting_allowed(v_inv.client_id, v_inv.invoice_date);

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Verkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG. 'NaN' = 'NaN' is waar en NaN
  -- is groter dan elk getal: zonder deze toets glipt een NaN-bedrag door elke
  -- controle hieronder en belandt het als NaN in het grootboek.
  IF v_inv.amount_excl = 'NaN'::numeric OR v_btw = 'NaN'::numeric OR v_inv.amount_incl = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Verkoopfactuur heeft een bedrag dat geen getal is (NaN); herstel de bedragen voordat u boekt'
      USING ERRCODE = '22023';
  END IF;

  IF v_inv.amount_excl < 0 OR v_btw < 0 OR v_inv.amount_incl <= 0 THEN
    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'
      USING ERRCODE = '22023';
  END IF;

  -- Verlegde BTW is refused, not silently posted as a plain no-VAT sale: see
  -- the migration header for why. The SnelStart export already treats these
  -- invoices the same way.
  IF v_inv.btw_verlegd THEN
    RAISE EXCEPTION 'Verkoopfacturen met verlegde BTW kunnen nog niet worden geboekt'
      USING ERRCODE = '0A000';
  END IF;

  -- Configuration. No fallback account, ever. The revenue account is a header
  -- field on THIS invoice (there are no lines to carry it instead).
  IF v_inv.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen omzetrekening ingesteld voor deze verkoopfactuur' USING ERRCODE = '22023';
  END IF;

  IF v_client.debiteuren_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen debiteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  IF v_btw > 0 AND v_client.btw_te_betalen_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen rekening voor BTW te betalen ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- Exact reconciliation, in NUMERIC. No tolerance, no line sum to check —
  -- there are no lines.
  IF v_inv.amount_excl + v_btw <> v_inv.amount_incl THEN
    RAISE EXCEPTION 'Bedrag exclusief (%) plus BTW (%) sluit niet aan op het bedrag inclusief (%)',
      v_inv.amount_excl, v_btw, v_inv.amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Account scope: every account must be usable by THIS administratie.
  IF NOT public.posting_account_ok(v_inv.grootboekrekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde omzetrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_client.debiteuren_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde debiteurenrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_btw > 0
     AND NOT public.posting_account_ok(v_client.btw_te_betalen_rekening_id, v_inv.organization_id, v_inv.client_id) THEN
    RAISE EXCEPTION 'De ingestelde rekening voor BTW te betalen hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  -- Claim the invoice. The primary key is the idempotency guarantee and, under
  -- concurrency, the serialisation point: a second session blocks here until
  -- the first commits and then fails.
  BEGIN
    INSERT INTO public.sales_invoice_postings (
      sales_invoice_id, posting_group_id, organization_id, client_id, user_id
    ) VALUES (
      v_inv.id, v_group_id, v_inv.organization_id, v_inv.client_id, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is al geboekt' USING ERRCODE = '23505';
  END;

  -- DEBIT: the debtor, for the gross amount.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_client.debiteuren_rekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, v_inv.amount_incl, 0, 'EUR',
    COALESCE(v_inv.customer_name, 'Debiteur'), 'sales_invoice', v_inv.id, NULL, v_uid
  );

  -- CREDIT: revenue, for the net amount.
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_inv.grootboekrekening_id, v_group_id, v_line_no,
    v_inv.invoice_date, v_boekjaar, 0, v_inv.amount_excl, 'EUR',
    COALESCE(v_inv.invoice_number, 'Verkoopfactuur'), 'sales_invoice', v_inv.id, NULL, v_uid
  );

  -- CREDIT: VAT payable, only when there is any. A btw_verlegd invoice never
  -- reaches this point at all — it was refused above.
  IF v_btw > 0 THEN
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_inv.organization_id, v_inv.client_id, v_client.btw_te_betalen_rekening_id, v_group_id, v_line_no,
      v_inv.invoice_date, v_boekjaar, 0, v_btw, 'EUR',
      'BTW te betalen', 'sales_invoice', v_inv.id, NULL, v_uid
    );
  END IF;

  RETURN v_group_id;
END
$$;

-- ── 3. post_bank_transaction ────────────────────────────────────────────────
--    Letterlijk 20261002120000, met de NaN-toets op het bedrag en, in het
--    BTW-blok, de weigering van een ontbrekend (22004) of ongeldig (NaN,
--    ±oneindig) btw-percentage.

CREATE OR REPLACE FUNCTION public.post_bank_transaction(_transaction_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_tx           public.bank_transactions%ROWTYPE;
  v_client       public.clients%ROWTYPE;
  v_group_id     uuid := gen_random_uuid();
  v_boekjaar     integer;
  v_gross        numeric(12,2);
  v_net          numeric(12,2);
  v_btw          numeric(12,2);
  v_pct          numeric;
  v_btw_account  uuid;
  v_line_no      integer := 0;
  v_desc         text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- De grendel blijft de eerste aanraking van de rij: exact dezelfde
  -- SELECT ... FOR UPDATE als in de toegepaste migratie, op exact dezelfde
  -- plek. Het gelijktijdigheidsgedrag verandert dus niet; alleen wat er
  -- daarna wordt gezegd.
  SELECT * INTO v_tx
  FROM public.bank_transactions
  WHERE id = _transaction_id
  FOR UPDATE;

  -- LEESDREMPEL. "Bestaat niet" en "niet van jou" zijn vanaf hier niet meer
  -- van elkaar te onderscheiden: dezelfde SQLSTATE, dezelfde tekst. Onder
  -- read_only verbergt RLS deze rij sowieso (role_bank_transactions_select),
  -- dus deze functie mag haar bestaan ook niet bevestigen.
  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- SCHRIJFDREMPEL. Wie hier komt mag de rij onder RLS toch al lezen, dus een
  -- eerlijk antwoord over zijn eigen rol verraadt niets nieuws. De vloer is
  -- ongewijzigd: assistant.
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- ── Vanaf hier een letterlijke kopie van 20260920195805, op de toetsen van ──
  -- ── 20261021170000 (NaN-bedrag, btw-percentage) na ──────────────────────────

  SELECT * INTO v_client FROM public.clients WHERE id = v_tx.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  IF v_tx.match_status <> 'handmatig_geboekt' THEN
    RAISE EXCEPTION 'Alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering' USING ERRCODE = '22023';
  END IF;

  IF v_tx.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Deze banktransactie heeft nog geen grootboekrekening' USING ERRCODE = '22023';
  END IF;

  IF v_tx.amount = 0 THEN
    RAISE EXCEPTION 'Een banktransactie van nul kan niet geboekt worden' USING ERRCODE = '22023';
  END IF;

  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG: 'NaN' = 'NaN' is waar en NaN
  -- is groter dan elk getal, dus zonder deze toets kwam een NaN-boeking door
  -- elke controle hieronder, tot en met de groepsbalans.
  IF v_tx.amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Het bedrag van deze banktransactie is geen getal (NaN); boeken is niet mogelijk' USING ERRCODE = '22023';
  END IF;

  IF v_client.bank_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen bankrekening (grootboek) ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_tx.transaction_date)::integer;
  -- Het jaarwatermerk (clients.afgesloten_boekjaar) is hier sinds 20261002120000
  -- geen boekingstoets meer. De boekingsblokkade — assert_posting_allowed()
  -- hieronder — is de enige datumgrendel; de boekjaarstatus is een
  -- administratief gegeven van de jaarafsluiting.

  -- PR D — DE BOEKINGSBLOKKADE. Autoriteit voor deze schrijver: transactiedatum van de bankregel.
  --        De helper grendelt eerst de administratie (lock_ledger_client),
  --        zodat een gelijktijdige set_posting_lock() er niet tussendoor kan.
  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  IF NOT public.posting_account_ok(v_client.bank_rekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De ingestelde bankrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_tx.grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  -- E-06 (20261021170000) — GEEN STILLE 0%. Een ontbrekend btw-percentage
  -- (NULL) werd hier als 0% geboekt: een kostenpost van 21% kwam dan zonder
  -- voorbelasting in het grootboek. Elke codeerroute in de app vraagt een
  -- expliciete keuze — ook "Geen BTW" (0), ook bij een vrijgestelde
  -- administratie — en deze schrijver dwingt precies die regel af.
  IF v_tx.btw_percentage IS NULL THEN
    RAISE EXCEPTION 'Het BTW-percentage van deze banktransactie is nog niet gekozen; kies 0 (geen BTW), 9 of 21 procent en boek daarna opnieuw'
      USING ERRCODE = '22004';
  END IF;

  -- A3-01: NaN of ±oneindig is geen percentage. Bij een vrijgestelde
  -- administratie werd zo'n waarde hieronder stil 0.
  IF v_tx.btw_percentage IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'Ongeldig BTW-percentage (%) op deze banktransactie', v_tx.btw_percentage USING ERRCODE = '22023';
  END IF;

  -- BTW: vrijgestelde administraties boeken nooit BTW.
  v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE v_tx.btw_percentage END;
  IF v_pct < 0 OR v_pct >= 100 THEN
    RAISE EXCEPTION 'Ongeldig BTW-percentage (%) op deze banktransactie', v_tx.btw_percentage USING ERRCODE = '22023';
  END IF;

  v_gross := round(abs(v_tx.amount), 2);
  v_net   := round(v_gross / (1 + v_pct / 100), 2);
  v_btw   := v_gross - v_net;

  IF v_btw > 0 THEN
    v_btw_account := CASE WHEN v_tx.amount < 0
      THEN v_client.btw_te_vorderen_rekening_id
      ELSE v_client.btw_te_betalen_rekening_id END;
    IF v_btw_account IS NULL THEN
      RAISE EXCEPTION 'Geen BTW-rekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;
    IF NOT public.posting_account_ok(v_btw_account, v_tx.organization_id, v_tx.client_id) THEN
      RAISE EXCEPTION 'De ingestelde BTW-rekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_desc := COALESCE(NULLIF(btrim(v_tx.description), ''), 'Bankboeking');

  BEGIN
    INSERT INTO public.bank_transaction_postings (
      bank_transaction_id, posting_group_id, organization_id, client_id,
      grootboekrekening_id, posting_date, boekjaar,
      gross_amount, net_amount, btw_amount, btw_percentage, user_id
    ) VALUES (
      v_tx.id, v_group_id, v_tx.organization_id, v_tx.client_id,
      v_tx.grootboekrekening_id, v_tx.transaction_date, v_boekjaar,
      v_gross, v_net, v_btw, NULLIF(v_pct, 0), v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze banktransactie is al geboekt' USING ERRCODE = '23505';
  END;

  IF v_tx.amount < 0 THEN
    -- Geld eraf: kosten/rekening debet (netto) + BTW te vorderen debet, bank credit.
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_tx.grootboekrekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, v_net, 0, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    IF v_btw > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.ledger_postings (
        organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
        posting_date, boekjaar, debit_amount, credit_amount, currency,
        description, source_type, source_id, user_id
      ) VALUES (
        v_tx.organization_id, v_tx.client_id, v_btw_account, v_group_id, v_line_no,
        v_tx.transaction_date, v_boekjaar, v_btw, 0, 'EUR',
        'BTW ' || v_desc, 'bank_transaction', v_tx.id, v_uid
      );
    END IF;

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_client.bank_rekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, 0, v_gross, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );
  ELSE
    -- Geld erbij: bank debet, opbrengst/rekening credit (netto) + BTW te betalen credit.
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_client.bank_rekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, v_gross, 0, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_tx.grootboekrekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, 0, v_net, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    IF v_btw > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.ledger_postings (
        organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
        posting_date, boekjaar, debit_amount, credit_amount, currency,
        description, source_type, source_id, user_id
      ) VALUES (
        v_tx.organization_id, v_tx.client_id, v_btw_account, v_group_id, v_line_no,
        v_tx.transaction_date, v_boekjaar, 0, v_btw, 'EUR',
        'BTW ' || v_desc, 'bank_transaction', v_tx.id, v_uid
      );
    END IF;
  END IF;

  RETURN v_group_id;
END;
$$;

-- ── 4. bank_bulk_posting_candidates ─────────────────────────────────────────
--    Letterlijk 20261002120000, met één arm vóór ELSE: zonder btw-percentage
--    is een regel 'review_needed', met de reden die de app al toont.

CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates(
  _client_id uuid,
  _boekjaar  integer DEFAULT NULL
)
RETURNS TABLE (
  transaction_id       uuid,
  transaction_date     date,
  amount               numeric,
  description          text,
  counter_account      text,
  match_status         text,
  grootboekrekening_id uuid,
  btw_percentage       numeric,
  is_posted            boolean,
  is_allocated         boolean,
  posting_group_id     uuid,
  workflow_state       text,
  reason               text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.transaction_date,
    t.amount,
    t.description,
    t.counter_account,
    t.match_status,
    t.grootboekrekening_id,
    t.btw_percentage,
    (m.bank_transaction_id IS NOT NULL)                      AS is_posted,
    a.allocated                                              AS is_allocated,
    m.posting_group_id,
    CASE
      WHEN m.bank_transaction_id IS NOT NULL            THEN 'posted'
      WHEN a.allocated                                  THEN 'blocked'
      WHEN t.amount = 0                                 THEN 'blocked'
      WHEN t.match_status = 'gematcht'                  THEN 'blocked'
      WHEN t.match_status <> 'handmatig_geboekt'        THEN 'review_needed'
      WHEN t.grootboekrekening_id IS NULL               THEN 'review_needed'
      WHEN c.bank_rekening_id IS NULL                   THEN 'blocked'
      WHEN NOT COALESCE(c.btw_vrijgesteld, false)
       AND COALESCE(t.btw_percentage, 0) > 0
       AND CASE WHEN t.amount < 0
                THEN c.btw_te_vorderen_rekening_id
                ELSE c.btw_te_betalen_rekening_id END IS NULL
                                                        THEN 'blocked'
      WHEN c.posting_locked_through IS NOT NULL
       AND t.transaction_date <= c.posting_locked_through
                                                        THEN 'blocked'
      WHEN t.btw_percentage IS NULL                     THEN 'review_needed'
      ELSE 'ready'
    END AS workflow_state,
    CASE
      WHEN m.bank_transaction_id IS NOT NULL            THEN NULL
      WHEN a.allocated                                  THEN 'Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering.'
      WHEN t.amount = 0                                 THEN 'Een banktransactie van nul kan niet geboekt worden.'
      WHEN t.match_status = 'gematcht'                  THEN 'Deze banktransactie is aan een factuur gematcht; boeken loopt via de aflettering.'
      WHEN t.match_status <> 'handmatig_geboekt'        THEN format('Status is %s; alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden.', t.match_status)
      WHEN t.grootboekrekening_id IS NULL               THEN 'Deze banktransactie heeft nog geen grootboekrekening.'
      WHEN c.bank_rekening_id IS NULL                   THEN 'Geen bankrekening (grootboek) ingesteld voor deze administratie.'
      WHEN NOT COALESCE(c.btw_vrijgesteld, false)
       AND COALESCE(t.btw_percentage, 0) > 0
       AND CASE WHEN t.amount < 0
                THEN c.btw_te_vorderen_rekening_id
                ELSE c.btw_te_betalen_rekening_id END IS NULL
                                                        THEN 'Geen BTW-rekening ingesteld voor deze administratie.'
      WHEN c.posting_locked_through IS NOT NULL
       AND t.transaction_date <= c.posting_locked_through
                                                        THEN format('Boekingsdatum %s valt binnen de boekingsblokkade t/m %s voor deze administratie.',
                                                                    t.transaction_date, c.posting_locked_through)
      WHEN t.btw_percentage IS NULL                     THEN 'Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.'
      ELSE NULL
    END AS reason
  FROM public.bank_transactions t
  LEFT JOIN public.clients c
         ON c.id = t.client_id
  LEFT JOIN public.bank_transaction_postings m
         ON m.bank_transaction_id = t.id
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM public.bank_transaction_allocations al
      WHERE al.bank_transaction_id = t.id
    ) AS allocated
  ) a
  WHERE t.client_id = _client_id
    AND (_boekjaar IS NULL
         OR (t.transaction_date >= make_date(_boekjaar, 1, 1)
         AND t.transaction_date <  make_date(_boekjaar + 1, 1, 1)))
  ORDER BY t.transaction_date, t.id;
$$;

-- ── 5. post_bank_transactions_bulk ──────────────────────────────────────────
--    Letterlijk 20260922120000, met '22004' in de lijst van eigen woordenschat.

CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk(_transaction_ids uuid[])
RETURNS TABLE (
  ordinal          integer,
  transaction_id   uuid,
  outcome          text,
  posting_group_id uuid,
  error_code       text,
  message          text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- De bovengrens staat hier één keer; de melding leidt hem eruit af.
  c_max_batch constant integer := 500;
  v_item      record;
  v_group     uuid;
  v_marker    uuid;
  v_state     text;
  v_msg       text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  IF _transaction_ids IS NULL OR cardinality(_transaction_ids) = 0 THEN
    RAISE EXCEPTION 'Geen banktransacties opgegeven' USING ERRCODE = '22023';
  END IF;

  IF array_position(_transaction_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'De lijst met banktransacties bevat een lege waarde' USING ERRCODE = '22023';
  END IF;

  -- Op de RUWE lengte, niet op het aantal unieke id's: een array van 100.000
  -- keer dezelfde id is evengoed een verzoek dat niet gedaan hoort te worden.
  IF cardinality(_transaction_ids) > c_max_batch THEN
    RAISE EXCEPTION 'Maximaal % banktransacties per keer; er zijn er % aangeboden',
      c_max_batch, cardinality(_transaction_ids) USING ERRCODE = '54000';
  END IF;

  FOR v_item IN
    SELECT d.ord, d.id
    FROM (
      SELECT DISTINCT ON (u.id) u.id, u.ord
      FROM unnest(_transaction_ids) WITH ORDINALITY AS u(id, ord)
      ORDER BY u.id, u.ord
    ) d
    ORDER BY d.ord
  LOOP
    ordinal          := v_item.ord::integer;
    transaction_id   := v_item.id;
    outcome          := NULL;
    posting_group_id := NULL;
    error_code       := NULL;
    message          := NULL;

    BEGIN
      -- DE ENIGE SCHRIJVENDE HANDELING. Alles wat er boekhoudkundig gebeurt,
      -- gebeurt hierbinnen, in de reeds geharde schrijver.
      v_group := public.post_bank_transaction(v_item.id);

      -- Uitgestelde controles (o.a. de groepsbalans van 6C-b2) binnen DEZE
      -- subtransactie afdwingen, zodat een fout bij deze regel hoort en niet
      -- bij COMMIT de hele partij raakt. Daarna weer uitstellen, want de
      -- volgende schrijveraanroep bouwt haar groep opnieuw regel voor regel op.
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;

      -- Succes wordt pas gemeld als de claim ook echt staat en dezelfde groep
      -- noemt. Zo hoort bij elke `posted` precies één vastgelegde marker.
      SELECT m.posting_group_id INTO v_marker
      FROM public.bank_transaction_postings m
      WHERE m.bank_transaction_id = v_item.id;

      IF v_marker IS NULL OR v_marker IS DISTINCT FROM v_group THEN
        RAISE EXCEPTION 'De boeking van deze banktransactie kon niet worden bevestigd' USING ERRCODE = '23514';
      END IF;

      outcome          := 'posted';
      posting_group_id := v_group;
      message          := 'Geboekt in het grootboek.';

    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;

      IF v_state = '23505' THEN
        -- Al geboekt — maar alleen idempotent te noemen als de marker ook
        -- werkelijk zichtbaar is voor deze aanroeper (RLS).
        SELECT m.posting_group_id INTO v_marker
        FROM public.bank_transaction_postings m
        WHERE m.bank_transaction_id = v_item.id;
      ELSE
        v_marker := NULL;
      END IF;

      IF v_state = '23505' AND v_marker IS NOT NULL THEN
        outcome          := 'already_posted';
        posting_group_id := v_marker;
        message          := 'Deze banktransactie was al geboekt.';
      ELSE
        outcome    := 'rejected';
        error_code := v_state;
        -- Alleen de eigen woordenschat van de schrijver gaat ongeschonden naar
        -- buiten; die is bewust tenantveilig geformuleerd (een onbekende en een
        -- vreemde banktransactie geven allebei exact
        -- '42501 | Banktransactie niet beschikbaar'). Alles daarbuiten kan
        -- interne details bevatten en wordt neutraal gemeld.
        -- 22004 (20261021170000): het nog niet gekozen btw-percentage, en de
        -- ontbrekende datum of administratie van assert_posting_allowed();
        -- geen van beide noemt een id of andermans gegevens.
        message := CASE
          WHEN v_state IN ('28000', '42501', '22023', '23514', '23505', 'P0002', '22004') THEN v_msg
          ELSE 'Boeken is niet gelukt voor deze banktransactie.'
        END;
      END IF;
    END;

    RETURN NEXT;
    -- Geen herkansing: de lus gaat door naar de volgende id, nooit terug.
  END LOOP;

  RETURN;
END;
$$;

-- ── 6. Functierechten: het eindbeeld expliciet, zonder venster ──────────────
--    CREATE OR REPLACE behoudt de rechten al. Toch legt deze migratie het
--    bedoelde eindbeeld vast: alleen authenticated (en de eigenaar). Zoals in
--    20260929120000 wordt authenticated NIET eerst ingetrokken, zodat er geen
--    moment is waarop de app het recht mist; het eindbeeld is gelijk aan
--    REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role + GRANT.

REVOKE ALL ON FUNCTION public.post_purchase_invoice(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.post_sales_invoice(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.post_sales_invoice(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.post_bank_transaction(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.bank_bulk_posting_candidates(uuid, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.bank_bulk_posting_candidates(uuid, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.post_bank_transactions_bulk(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_transactions_bulk(uuid[]) TO authenticated;

-- ── 7. Geen NaN in de bedragen: CHECK NOT VALID ─────────────────────────────
--    NOT VALID: alleen nieuwe en gewijzigde rijen worden getoetst; bestaande
--    rijen niet (geen tabelscan, geen weigering op historie). VALIDATE volgt
--    apart, na telling Q7 (zie de kop). Idempotent: alleen toevoegen wat er
--    nog niet staat. `x <> 'NaN'::numeric` is ONWAAR precies voor NaN
--    ('NaN' = 'NaN' is waar in PostgreSQL); NULL laat de CHECK door.

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.ledger_postings'::regclass AND conname = 'ledger_postings_amounts_not_nan') THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_amounts_not_nan
      CHECK (debit_amount <> 'NaN'::numeric AND credit_amount <> 'NaN'::numeric) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.purchase_invoices'::regclass AND conname = 'purchase_invoices_amounts_not_nan') THEN
    ALTER TABLE public.purchase_invoices
      ADD CONSTRAINT purchase_invoices_amounts_not_nan
      CHECK (amount_excl <> 'NaN'::numeric AND btw_amount <> 'NaN'::numeric AND amount_incl <> 'NaN'::numeric) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.sales_invoices'::regclass AND conname = 'sales_invoices_amounts_not_nan') THEN
    ALTER TABLE public.sales_invoices
      ADD CONSTRAINT sales_invoices_amounts_not_nan
      CHECK (amount_excl <> 'NaN'::numeric AND btw_amount <> 'NaN'::numeric AND amount_incl <> 'NaN'::numeric) NOT VALID;
  END IF;

  -- numeric zonder schaal: ook ±oneindig is geen bedrag.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.purchase_invoice_lines'::regclass AND conname = 'purchase_invoice_lines_amount_finite') THEN
    ALTER TABLE public.purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_amount_finite
      CHECK (amount_excl <> 'NaN'::numeric AND amount_excl <> 'Infinity'::numeric AND amount_excl <> '-Infinity'::numeric) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.bank_transactions'::regclass AND conname = 'bank_transactions_amount_not_nan') THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_amount_not_nan
      CHECK (amount <> 'NaN'::numeric) NOT VALID;
  END IF;
END
$constraints$;

COMMENT ON CONSTRAINT ledger_postings_amounts_not_nan ON public.ledger_postings IS
  'A3-01 (20261021170000): geen NaN in debet of credit. NaN = NaN is waar in PostgreSQL, dus zonder deze CHECK sluit een NaN-groep "in balans". NOT VALID tot de aparte VALIDATE na telling Q7.';
COMMENT ON CONSTRAINT purchase_invoices_amounts_not_nan ON public.purchase_invoices IS
  'A3-01 (20261021170000): geen NaN in amount_excl, btw_amount of amount_incl. NULL blijft toegestaan. NOT VALID tot de aparte VALIDATE na telling Q7.';
COMMENT ON CONSTRAINT sales_invoices_amounts_not_nan ON public.sales_invoices IS
  'A3-01 (20261021170000): geen NaN in amount_excl, btw_amount of amount_incl. NULL blijft toegestaan. NOT VALID tot de aparte VALIDATE na telling Q7.';
COMMENT ON CONSTRAINT purchase_invoice_lines_amount_finite ON public.purchase_invoice_lines IS
  'A3-01 (20261021170000): het regelbedrag is een eindig getal (geen NaN, geen ±oneindig; de kolom heeft geen schaal). NOT VALID tot de aparte VALIDATE na telling Q7.';
COMMENT ON CONSTRAINT bank_transactions_amount_not_nan ON public.bank_transactions IS
  'A3-01 (20261021170000): het bedrag is geen NaN. NOT VALID tot de aparte VALIDATE na telling Q7.';
