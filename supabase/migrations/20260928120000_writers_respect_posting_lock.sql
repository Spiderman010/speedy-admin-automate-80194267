-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b11 (PR D) — DE SCHRIJVERS GAAN DE BOEKINGSBLOKKADE TOETSEN
--
-- Zie docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md, sectie N (PR D), en PR C
-- (20260927120000) die de blokkade en `posting_allowed()` heeft aangelegd.
--
-- WAT ER VERANDERT
--   Zeven schrijvers toetsen voortaan óók `public.posting_allowed()`, via één
--   gedeelde bewering. Een boeking met een boekhoudkundige datum op of vóór
--   `clients.posting_locked_through` wordt geweigerd.
--
-- DIT IS EEN BEWUST DUBBEL BEWAAKTE FASE
--   De bestaande toets op `afgesloten_boekjaar` blijft in élke schrijver staan,
--   ongewijzigd, en blijft als eerste gecontroleerd. Deze migratie is dus
--   STRIKT STRENGER dan main: alles wat eerder werd geweigerd wordt nog steeds
--   geweigerd, met exact dezelfde melding, en er komt één weigering bij. Een
--   heropend boekjaar wordt hier NIET beboekbaar; die ontkoppeling is een
--   latere PR.
--
-- ÉÉN BEWERING IN PLAATS VAN ZEVEN KOPIEËN
--   `assert_posting_allowed()` is precies de helper die er bij
--   `afgesloten_boekjaar` nooit is gekomen — met als gevolg acht byte-identieke
--   kopieën van dezelfde regel, verspreid over zeven migraties. Die fout wordt
--   hier niet herhaald: de toets en de melding staan één keer.
--
-- WAT ER NADRUKKELIJK NIET GEBEURT
--   `declare_opening_balance_nil()` wordt NIET aangepast. Zie sectie 2.
--   `close_fiscal_year()`, `set_posting_lock()`, de gebeurtenistabellen, de
--   rolvloeren, de retourvormen en de handtekeningen blijven ongemoeid.
--
-- ROLLBACK (handmatig): pas de zeven bronmigraties opnieuw toe in hun
-- oorspronkelijke volgorde; die definiëren de schrijvers zonder de
-- blokkadetoets. Daarna DROP FUNCTION IF EXISTS public.assert_posting_allowed(uuid, date);
-- ═════════════════════════════════════════════════════════════════════════════

DO $migratie$
BEGIN
  IF to_regproc('public.posting_allowed') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR D vereist eerst public.posting_allowed() (PR C)';
  END IF;
  IF to_regproc('public.lock_ledger_client') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR D vereist eerst public.lock_ledger_client() (6C-b8)';
  END IF;
END
$migratie$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) De gedeelde bewering
--
--    WAAROM EEN EIGEN FUNCTIE EN NIET ZEVEN KEER EEN `IF`. Precies de les van
--    `afgesloten_boekjaar`: die toets staat acht keer letterlijk in de code,
--    zonder helper, en de audit in #194 moest daarom acht plekken natellen om
--    te weten of ze wel gelijk waren. Eén bewering betekent één melding, één
--    SQLSTATE en één plek om te wijzigen.
--
--    DE MELDING NOEMT DE DATUM ÉN DE GRENS, en dat mag: deze functie is niet
--    aanroepbaar voor applicatierollen (REVOKE ALL) en wordt uitsluitend
--    bereikt vanuit een schrijver die de aanroeper al voor deze administratie
--    heeft geautoriseerd. Er lekt dus niets naar iemand die het niet al mocht
--    zien.
--
--    SQLSTATE 22023, gelijk aan de bestaande afgesloten-jaar-weigering. Niet uit
--    gemakzucht: de applicatie behandelt 22023 al als een validatiefout met een
--    toonbare melding (`VALIDATION_CODES` in manual-journal-utils.ts en
--    opening-balance-utils.ts, en de datumtak van classifyReversalError). Een
--    nieuwe code zou van deze weigering een "onbekende fout" maken.
--
--    HET GEVAL ZONDER BLOKKADE. `posting_allowed()` geeft ook `false` bij een
--    onbekende administratie of een ontbrekende datum. Dan is er geen grens om
--    te noemen en krijgt de aanroeper een eigen, neutrale melding — fail
--    closed, zonder te verraden wat er precies ontbrak.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_posting_allowed(
  _client_id    uuid,
  _posting_date date
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_through date;
BEGIN
  IF public.posting_allowed(_client_id, _posting_date) THEN
    RETURN;
  END IF;

  SELECT c.posting_locked_through INTO v_through
  FROM public.clients c
  WHERE c.id = _client_id;

  IF v_through IS NULL THEN
    RAISE EXCEPTION 'De boekingsdatum kan niet worden beoordeeld voor deze administratie'
      USING ERRCODE = '22023';
  END IF;

  RAISE EXCEPTION 'Boekingsdatum % valt binnen de boekingsblokkade t/m % voor deze administratie',
    _posting_date, v_through
    USING ERRCODE = '22023';
END
$fn$;

REVOKE ALL ON FUNCTION public.assert_posting_allowed(uuid, date) FROM PUBLIC;

COMMENT ON FUNCTION public.assert_posting_allowed(uuid, date) IS
'Weigert een boeking waarvan de boekhoudkundige datum binnen de boekingsblokkade van de administratie valt. Eén bewering voor alle schrijvers: één melding, één SQLSTATE (22023, gelijk aan de afgesloten-jaar-weigering zodat de applicatie haar al als toonbare validatiefout behandelt). Niet aanroepbaar voor applicatierollen; uitsluitend bereikt vanuit een schrijver die de aanroeper al heeft geautoriseerd.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) WAAROM declare_opening_balance_nil() NIET MEEDOET
--
--    Zij is de enige van de acht die GEEN grootboekregel schrijft. Zij legt
--    vast dat een administratie bewust géén beginbalans heeft — een uitspraak
--    over een BOEKJAAR, niet een boeking op een DATUM. Dat is precies waarom
--    #194 haar apart zette: zij toetst op `v_header.boekjaar` en gebruikt
--    nergens een datum, ook al is `opening_date` op dat punt gewoon geladen.
--
--    Een boekingsblokkade is een datumgebonden beheersmaatregel op het boeken.
--    Die opleggen aan iets wat niet boekt, zou betekenen dat een blokkade t/m
--    31-12-2024 een nihil-verklaring over 2024 zou tegenhouden terwijl er geen
--    enkele boeking bij komt kijken. Zij blijft dus onder de jaarstatus vallen,
--    en die regel is hier ongewijzigd gelaten.
--
--    Deze migratie raakt die functie daarom niet aan. Tests pinnen dat vast.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) De zeven schrijvers
--
--    Elk hieronder is de BESTAANDE functie, letterlijk overgenomen uit haar
--    eigen migratie, met precies twee regels erbij direct na de onveranderde
--    afgesloten-jaar-toets. Een test vergelijkt elke functie byte-voor-byte met
--    haar origineel, op die toevoeging na.
-- ─────────────────────────────────────────────────────────────────────────────

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
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de factuurdatum van de inkoopfactuur.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_inv.invoice_date);

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Inkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  IF v_inv.amount_excl < 0 OR v_btw < 0 OR v_inv.amount_incl <= 0 THEN
    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'
      USING ERRCODE = '22023';
  END IF;

  -- Configuration. No fallback account, ever.
  IF v_client.crediteuren_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen crediteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  IF v_btw > 0 AND v_client.btw_te_vorderen_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen rekening voor BTW te vorderen ingesteld voor deze administratie' USING ERRCODE = '22023';
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
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de factuurdatum van de verkoopfactuur.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_inv.invoice_date);

  v_btw := COALESCE(v_inv.btw_amount, 0);

  IF v_inv.amount_excl IS NULL OR v_inv.amount_incl IS NULL THEN
    RAISE EXCEPTION 'Verkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';
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

CREATE OR REPLACE FUNCTION public.post_bank_allocation(_allocation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_alloc            public.bank_transaction_allocations%ROWTYPE;
  v_tx               public.bank_transactions%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_inv_id           uuid;
  v_inv_client_id    uuid;
  v_inv_org_id       uuid;
  v_inv_amount_incl  numeric(12,2);
  v_inv_number       text;
  v_inv_name         text;
  v_sum_tx           numeric(12,2);
  v_sum_inv          numeric(12,2);
  v_debit_account    uuid;
  v_credit_account   uuid;
  v_debit_desc       text;
  v_credit_desc      text;
  v_line_no          integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- LOCK 1 — the allocation, FOR UPDATE. The app's allocation mutations
  -- (upsert of the amount, delete) lock this same row, so whichever starts
  -- first finishes first: a mutation in flight makes posting wait and then
  -- read the fully committed new row; a posting in flight makes the mutation
  -- wait and then be refused by the freeze in section 4, because the marker
  -- now exists.
  SELECT * INTO v_alloc
  FROM public.bank_transaction_allocations
  WHERE id = _allocation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bankkoppeling niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Tenant + role, both from stored data. organization_id is nullable in the
  -- allocation DDL (backfilled later), so NULL fails closed. 'assistant'
  -- matches the minimum the ledger_postings INSERT policy itself requires.
  IF v_alloc.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_alloc.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- LOCK 2 — the bank transaction, FOR UPDATE. This is what serialises the
  -- per-transaction over-allocation check: a concurrent allocation INSERT on
  -- this transaction needs a KEY SHARE lock on this row for its FK and waits
  -- here; a concurrent amount/date/client update of the transaction waits
  -- here too, and after our commit is refused by the freeze in section 5.
  SELECT * INTO v_tx
  FROM public.bank_transactions
  WHERE id = v_alloc.bank_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banktransactie niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.client_id <> v_alloc.client_id
     OR v_tx.organization_id IS DISTINCT FROM v_alloc.organization_id THEN
    RAISE EXCEPTION 'Banktransactie hoort niet bij dezelfde administratie/organisatie als de koppeling'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_alloc.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_alloc.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze koppeling' USING ERRCODE = '42501';
  END IF;

  -- LOCK 3 — the source invoice, FOR SHARE, per branch. FOR SHARE (not FOR
  -- UPDATE) is enough: we do not change the invoice, we only need a posting
  -- of it that is in flight (FOR UPDATE inside post_*_invoice) to finish
  -- before we look for its marker, and we need the invoice not to be moved to
  -- another administratie underneath us. The invoice writers' own freeze
  -- keeps the amounts stable once their marker exists.
  IF v_alloc.invoice_type = 'inkoop' THEN
    SELECT id, client_id, organization_id, amount_incl, invoice_number, supplier
      INTO v_inv_id, v_inv_client_id, v_inv_org_id, v_inv_amount_incl, v_inv_number, v_inv_name
    FROM public.purchase_invoices
    WHERE id = v_alloc.invoice_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv_client_id <> v_alloc.client_id
       OR v_inv_org_id IS DISTINCT FROM v_alloc.organization_id THEN
      RAISE EXCEPTION 'Factuur hoort niet bij dezelfde administratie' USING ERRCODE = '42501';
    END IF;

    -- The marker, not the status, proves the open item exists in the ledger.
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase_invoice_postings WHERE purchase_invoice_id = v_alloc.invoice_id
    ) THEN
      RAISE EXCEPTION 'Inkoopfactuur is nog niet geboekt in het grootboek; een aflettering vereist een geboekte factuur'
        USING ERRCODE = '22023';
    END IF;

    -- Direction: paying a supplier is money OUT (Bank.tsx:111,
    -- ledger-mutations.ts:345, snelstart-export.ts:268). Zero is refused too.
    IF v_tx.amount >= 0 THEN
      RAISE EXCEPTION 'Een inkoopkoppeling vereist een uitgaande banktransactie' USING ERRCODE = '22023';
    END IF;

    IF v_client.crediteuren_rekening_id IS NULL THEN
      RAISE EXCEPTION 'Geen crediteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;

  ELSIF v_alloc.invoice_type = 'verkoop' THEN
    SELECT id, client_id, organization_id, amount_incl, invoice_number, customer_name
      INTO v_inv_id, v_inv_client_id, v_inv_org_id, v_inv_amount_incl, v_inv_number, v_inv_name
    FROM public.sales_invoices
    WHERE id = v_alloc.invoice_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Verkoopfactuur niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv_client_id <> v_alloc.client_id
       OR v_inv_org_id IS DISTINCT FROM v_alloc.organization_id THEN
      RAISE EXCEPTION 'Factuur hoort niet bij dezelfde administratie' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.sales_invoice_postings WHERE sales_invoice_id = v_alloc.invoice_id
    ) THEN
      RAISE EXCEPTION 'Verkoopfactuur is nog niet geboekt in het grootboek; een aflettering vereist een geboekte factuur'
        USING ERRCODE = '22023';
    END IF;

    -- Direction: a customer paying is money IN. Zero is refused too.
    IF v_tx.amount <= 0 THEN
      RAISE EXCEPTION 'Een verkoopkoppeling vereist een inkomende banktransactie' USING ERRCODE = '22023';
    END IF;

    IF v_client.debiteuren_rekening_id IS NULL THEN
      RAISE EXCEPTION 'Geen debiteurenrekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;

  ELSE
    -- Unreachable through the CHECK constraint on invoice_type, but the
    -- writer does not lean on a constraint it does not own.
    RAISE EXCEPTION 'Onbekend koppelingstype: %', v_alloc.invoice_type USING ERRCODE = '22023';
  END IF;

  -- Configuration. No fallback account, ever: not bank_dagboek, not a number.
  IF v_client.bank_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen bankrekening (grootboek) ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- Amount consistency, all NUMERIC, no tolerance, no clamping. The database
  -- has no over-allocation constraint (only Bank.tsx checks it, with a
  -- tolerance), so the writer refuses inconsistent state instead of posting
  -- it. The allocation amount itself is used as-is; it is never recalculated.
  IF v_alloc.amount <= 0 THEN
    RAISE EXCEPTION 'Koppelingsbedrag moet groter dan nul zijn' USING ERRCODE = '22023';
  END IF;

  IF v_alloc.amount > abs(v_tx.amount) THEN
    RAISE EXCEPTION 'Koppelingsbedrag (%) is hoger dan het banktransactiebedrag (%)', v_alloc.amount, abs(v_tx.amount)
      USING ERRCODE = '23514';
  END IF;

  -- Sound under concurrency because of LOCK 2: a competing INSERT on this
  -- transaction is waiting on our FOR UPDATE and cannot be in this sum yet.
  SELECT COALESCE(SUM(amount), 0) INTO v_sum_tx
  FROM public.bank_transaction_allocations
  WHERE bank_transaction_id = v_tx.id;
  IF v_sum_tx > abs(v_tx.amount) THEN
    RAISE EXCEPTION 'De koppelingen op deze banktransactie (%) overschrijden samen het transactiebedrag (%)', v_sum_tx, abs(v_tx.amount)
      USING ERRCODE = '23514';
  END IF;

  IF v_inv_amount_incl IS NULL THEN
    RAISE EXCEPTION 'Factuur mist een bedrag inclusief BTW; boeken is niet mogelijk' USING ERRCODE = '22004';
  END IF;

  IF v_alloc.amount > v_inv_amount_incl THEN
    RAISE EXCEPTION 'Koppelingsbedrag (%) is hoger dan het factuurbedrag (%)', v_alloc.amount, v_inv_amount_incl
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum_inv
  FROM public.bank_transaction_allocations
  WHERE invoice_type = v_alloc.invoice_type
    AND invoice_id = v_alloc.invoice_id;
  IF v_sum_inv > v_inv_amount_incl THEN
    RAISE EXCEPTION 'De koppelingen op deze factuur (%) overschrijden samen het factuurbedrag (%); een overbetaling wordt nog niet ondersteund', v_sum_inv, v_inv_amount_incl
      USING ERRCODE = '23514';
  END IF;

  -- Date: the day the money moved. transaction_date is NOT NULL.
  v_boekjaar := EXTRACT(YEAR FROM v_tx.transaction_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de datum van de banktransactie.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_tx.transaction_date);

  -- Account scope: every account must be usable by THIS administratie — the
  -- same predicate ledger_postings enforces per row, checked up front so the
  -- refusal names the account instead of surfacing as a generic row error.
  IF NOT public.posting_account_ok(v_client.bank_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
    RAISE EXCEPTION 'De ingestelde bankrekening hoort niet bij deze organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF v_alloc.invoice_type = 'verkoop' THEN
    IF NOT public.posting_account_ok(v_client.debiteuren_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
      RAISE EXCEPTION 'De ingestelde debiteurenrekening hoort niet bij deze organisatie of administratie'
        USING ERRCODE = '23514';
    END IF;
    -- Money in: DEBIT bank, CREDIT the debtor.
    v_debit_account  := v_client.bank_rekening_id;
    v_credit_account := v_client.debiteuren_rekening_id;
    v_debit_desc     := COALESCE(v_inv_number, 'Bankaflettering');
    v_credit_desc    := COALESCE(v_inv_name, 'Debiteur');
  ELSE
    IF NOT public.posting_account_ok(v_client.crediteuren_rekening_id, v_alloc.organization_id, v_alloc.client_id) THEN
      RAISE EXCEPTION 'De ingestelde crediteurenrekening hoort niet bij deze organisatie of administratie'
        USING ERRCODE = '23514';
    END IF;
    -- Money out: DEBIT the creditor, CREDIT bank.
    v_debit_account  := v_client.crediteuren_rekening_id;
    v_credit_account := v_client.bank_rekening_id;
    v_debit_desc     := COALESCE(v_inv_name, 'Crediteur');
    v_credit_desc    := COALESCE(v_inv_number, 'Bankaflettering');
  END IF;

  -- Claim the allocation. The primary key is the idempotency guarantee and,
  -- under concurrency, the serialisation point: a second session blocks here
  -- until the first commits and then fails.
  BEGIN
    INSERT INTO public.bank_allocation_postings (
      allocation_id, posting_group_id, organization_id, client_id,
      bank_transaction_id, invoice_id, invoice_type, amount, user_id
    ) VALUES (
      v_alloc.id, v_group_id, v_alloc.organization_id, v_alloc.client_id,
      v_tx.id, v_inv_id, v_alloc.invoice_type, v_alloc.amount, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze bankkoppeling is al geboekt' USING ERRCODE = '23505';
  END;

  -- Line 1 — DEBIT (bank for verkoop, crediteuren for inkoop).
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_alloc.organization_id, v_alloc.client_id, v_debit_account, v_group_id, v_line_no,
    v_tx.transaction_date, v_boekjaar, v_alloc.amount, 0, 'EUR',
    v_debit_desc, 'bank_allocation', v_alloc.id, NULL, v_uid
  );

  -- Line 2 — CREDIT (debiteuren for verkoop, bank for inkoop).
  v_line_no := v_line_no + 1;
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, source_line_id, user_id
  ) VALUES (
    v_alloc.organization_id, v_alloc.client_id, v_credit_account, v_group_id, v_line_no,
    v_tx.transaction_date, v_boekjaar, 0, v_alloc.amount, 'EUR',
    v_credit_desc, 'bank_allocation', v_alloc.id, NULL, v_uid
  );

  RETURN v_group_id;
END
$$;

CREATE OR REPLACE FUNCTION public.post_manual_journal(_journal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_journal          public.manual_journals%ROWTYPE;
  v_client           public.clients%ROWTYPE;
  v_group_id         uuid := gen_random_uuid();
  v_boekjaar         integer;
  v_line_count       integer;
  v_no_account       integer;
  v_zero_lines       integer;
  v_both_sides       integer;
  v_negative         integer;
  v_nan              integer;
  v_decimals         integer;
  v_org_mismatch     integer;
  v_sum_debit        numeric;
  v_sum_credit       numeric;
  v_bad_scope        integer;
  v_inactive         text;
  v_line_no          integer := 0;
  v_line             record;
BEGIN
  -- (1) Authentication first: nothing is read or locked for an anonymous call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) LOCK 1 — the header, FOR UPDATE. save_manual_journal_lines() and the
  -- app's header UPDATE/DELETE lock this same row, so whichever starts first
  -- finishes first (see LOCK ORDER in the header).
  SELECT * INTO v_journal
  FROM public.manual_journals
  WHERE id = _journal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memoriaalboeking niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (3) Tenant + role, both from stored data. POSTING FLOOR = accountant
  -- (owner decision, header comment): assistants prepare, accountants post.
  IF v_journal.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_journal.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om memoriaalboekingen te boeken voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (4) The administratie must belong to the journal's organisation.
  SELECT * INTO v_client FROM public.clients WHERE id = v_journal.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_journal.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze memoriaalboeking'
      USING ERRCODE = '42501';
  END IF;

  -- (5) Defensive: the column is NOT NULL, but the writer does not lean on a
  -- constraint it does not own.
  IF v_journal.posting_date IS NULL THEN
    RAISE EXCEPTION 'Memoriaalboeking heeft geen boekingsdatum; boeken is niet mogelijk'
      USING ERRCODE = '22004';
  END IF;

  -- (6) A memoriaal without a description is not auditable: it is also the
  -- fallback description of every ledger row whose line has none. Whitespace-
  -- aware: btrim() alone trims spaces only and would accept E'\t\n'.
  IF v_journal.description IS NULL OR btrim(v_journal.description, E' \t\r\n') = '' THEN
    RAISE EXCEPTION 'Memoriaalboeking heeft geen omschrijving; boeken is niet mogelijk'
      USING ERRCODE = '22023';
  END IF;

  -- (7) Closed year, identically to the other writers. No fallback year.
  v_boekjaar := EXTRACT(YEAR FROM v_journal.posting_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de boekingsdatum van het memoriaal.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_journal.posting_date);

  -- (8) LOCK 2 — every line, FOR UPDATE, in posting order. A raw line
  -- UPDATE/DELETE in flight finishes first (we then read its committed
  -- result); one that starts later waits here and is refused by the freeze
  -- once our marker is committed.
  PERFORM 1
  FROM public.manual_journal_lines
  WHERE manual_journal_id = v_journal.id
  ORDER BY sort_order, id
  FOR UPDATE;

  -- (9) One aggregate over the locked lines, then refusals in a fixed order
  -- so the first message names the most fundamental problem.
  --   • the NaN filter is real: a NaN line passes the zero / both-sides /
  --     negative / decimals filters AND the balance check (NaN = NaN), so it
  --     is counted separately and refused before the balance is compared.
  --   • the decimals filter is unreachable through the numeric(12,2) typmod
  --     (a stored value already has two decimals); it is kept so the writer
  --     does not lean on a typmod it does not own.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL),
         COUNT(*) FILTER (WHERE l.debit_amount = 0 AND l.credit_amount = 0),
         COUNT(*) FILTER (WHERE l.debit_amount > 0 AND l.credit_amount > 0),
         COUNT(*) FILTER (WHERE l.debit_amount < 0 OR l.credit_amount < 0),
         COUNT(*) FILTER (WHERE l.debit_amount = 'NaN'::numeric OR l.credit_amount = 'NaN'::numeric),
         COUNT(*) FILTER (WHERE l.debit_amount <> round(l.debit_amount, 2)
                             OR l.credit_amount <> round(l.credit_amount, 2)),
         COUNT(*) FILTER (WHERE l.organization_id IS DISTINCT FROM v_journal.organization_id),
         COALESCE(SUM(l.debit_amount), 0),
         COALESCE(SUM(l.credit_amount), 0)
    INTO v_line_count, v_no_account, v_zero_lines, v_both_sides, v_negative,
         v_nan, v_decimals, v_org_mismatch, v_sum_debit, v_sum_credit
  FROM public.manual_journal_lines l
  WHERE l.manual_journal_id = v_journal.id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Een memoriaalboeking heeft minimaal twee regels: een debet- en een creditregel'
      USING ERRCODE = '22023';
  END IF;

  IF v_no_account > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder grootboekrekening; boeken is niet mogelijk', v_no_account
      USING ERRCODE = '22023';
  END IF;

  IF v_zero_lines > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder bedrag; boeken is niet mogelijk', v_zero_lines
      USING ERRCODE = '22023';
  END IF;

  IF v_both_sides > 0 THEN
    RAISE EXCEPTION 'Een regel kan niet tegelijk debet en credit zijn' USING ERRCODE = '22023';
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION 'Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde'
      USING ERRCODE = '22023';
  END IF;

  IF v_nan > 0 THEN
    RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023';
  END IF;

  IF v_decimals > 0 THEN
    RAISE EXCEPTION 'Bedragen mogen maximaal twee decimalen hebben' USING ERRCODE = '22023';
  END IF;

  IF v_org_mismatch > 0 THEN
    RAISE EXCEPTION 'Een regel hoort bij een andere organisatie dan de memoriaalboeking'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Een memoriaalboeking heeft zowel een debet- als een creditbedrag groter dan nul nodig'
      USING ERRCODE = '22023';
  END IF;

  -- Exact NUMERIC equality. No tolerance, no rounding: the ledger's own group
  -- check is exact, so anything less would only move the refusal to COMMIT.
  -- NO cap on the number of lines: a memoriaal has as many lines as it needs.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Memoriaalboeking is niet in balans: debet % is ongelijk aan credit %', v_sum_debit, v_sum_credit
      USING ERRCODE = '23514';
  END IF;

  -- (10) Account scope: every account must be usable by THIS administratie —
  -- the same predicate ledger_postings enforces per row, checked up front so
  -- the refusal is explicit instead of a generic row error.
  SELECT COUNT(*) INTO v_bad_scope
  FROM public.manual_journal_lines l
  WHERE l.manual_journal_id = v_journal.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_journal.organization_id, v_journal.client_id);
  IF v_bad_scope > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_bad_scope
      USING ERRCODE = '23514';
  END IF;

  -- (11) No posting onto a deactivated account.
  SELECT string_agg(g.nummer::text, ', ' ORDER BY g.nummer) INTO v_inactive
  FROM public.manual_journal_lines l
  JOIN public.grootboekrekeningen g ON g.id = l.grootboekrekening_id
  WHERE l.manual_journal_id = v_journal.id
    AND NOT g.actief;
  IF v_inactive IS NOT NULL THEN
    RAISE EXCEPTION 'Een regel verwijst naar een niet-actieve grootboekrekening (%)', v_inactive
      USING ERRCODE = '22023';
  END IF;

  -- (12) Claim the journal. The primary key is the idempotency guarantee and,
  -- under concurrency, the serialisation point: a second session blocks here
  -- until the first commits and then fails. No EXISTS pre-check — the index
  -- is the arbiter.
  BEGIN
    INSERT INTO public.manual_journal_postings (
      manual_journal_id, posting_group_id, organization_id, client_id, user_id,
      posting_date, line_count, total_amount
    ) VALUES (
      v_journal.id, v_group_id, v_journal.organization_id, v_journal.client_id, v_uid,
      v_journal.posting_date, v_line_count, v_sum_debit
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze memoriaalboeking is al geboekt' USING ERRCODE = '23505';
  END;

  -- (13) One ledger row per line, exactly as stored, in posting order. The
  -- line's own id goes in source_line_id (durable here — header comment).
  FOR v_line IN
    SELECT id, grootboekrekening_id, debit_amount, credit_amount, omschrijving
    FROM public.manual_journal_lines
    WHERE manual_journal_id = v_journal.id
    ORDER BY sort_order, id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_journal.organization_id, v_journal.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_journal.posting_date, v_boekjaar, v_line.debit_amount, v_line.credit_amount, 'EUR',
      COALESCE(NULLIF(btrim(v_line.omschrijving, E' \t\r\n'), ''), v_journal.description),
      'manual_journal', v_journal.id, v_line.id, v_uid
    );
  END LOOP;

  -- (14)
  RETURN v_group_id;
END
$$;

CREATE OR REPLACE FUNCTION public.post_opening_balance(_opening_balance_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_header       public.opening_balances%ROWTYPE;
  v_locked_client uuid;
  v_client       public.clients%ROWTYPE;
  v_group_id     uuid := gen_random_uuid();
  v_line_count   integer;
  v_no_account   integer;
  v_zero_lines   integer;
  v_both_sides   integer;
  v_negative     integer;
  v_nan          integer;
  v_decimals     integer;
  v_scope_bad    integer;
  v_inactive     text;
  v_sum_debit    numeric;
  v_sum_credit   numeric;
  v_earlier      date;
  v_line_no      integer := 0;
  v_line         record;
BEGIN
  -- (1) Authentication first: nothing is read or locked for an anonymous call.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolation contract. Only READ COMMITTED may assert an opening balance:
  -- a snapshot-preserving level could hold a stale view of the other assertion
  -- kind across the advisory lock and let posted and nihil both commit.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een beginbalans kan alleen worden geboekt in een READ COMMITTED transactie (huidig niveau: %)', current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- (3) Read the header WITHOUT a lock first, only to learn the administratie
  -- the advisory lock must be taken on.
  SELECT * INTO v_header FROM public.opening_balances WHERE id = _opening_balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;
  v_locked_client := v_header.client_id;

  -- (4) LOCK 0 — the administratie. Serialises this posting against every other
  -- opening-balance assertion of the same administratie, including a nil
  -- declaration of a DIFFERENT header, which no index could cover.
  PERFORM public.lock_ledger_client(v_locked_client);

  -- (5) LOCK 1 — the header, FOR UPDATE, re-read under the advisory lock.
  SELECT * INTO v_header
  FROM public.opening_balances
  WHERE id = _opening_balance_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beginbalans niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (5a) The lock must cover the row we are about to act on. client_id is
  -- immutable ON A ROW, but the header id → administratie MAPPING is not: a
  -- draft may be deleted and re-created under the same id (id is caller-
  -- suppliable, DELETE sits at the accountant floor), and the window for that
  -- is exactly the wait at LOCK 0 — widest precisely when the lock matters.
  -- Without this, a posting could commit for an administratie whose advisory
  -- lock is held by someone else, which would silently disarm the only
  -- mechanism that makes "geboekt XOR nihil" race-free. Retryable: the caller
  -- simply calls again and then locks the right administratie.
  IF v_header.client_id IS DISTINCT FROM v_locked_client THEN
    RAISE EXCEPTION 'De beginbalans is tussentijds gewijzigd; probeer opnieuw'
      USING ERRCODE = '40001';
  END IF;

  -- (6) Tenant + role, both from stored data. POSTING FLOOR = accountant.
  IF v_header.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_header.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een beginbalans te boeken voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (7) The administratie must belong to the header's organisation.
  SELECT * INTO v_client FROM public.clients WHERE id = v_header.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_header.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze beginbalans'
      USING ERRCODE = '42501';
  END IF;

  -- (8) This header must still be an open draft.
  IF v_header.nil_declared_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deze beginbalans is op nihil verklaard en kan niet worden geboekt'
      USING ERRCODE = '22023';
  END IF;

  -- (9) And the administratie must not already carry the other assertion. The
  -- unique index on the marker and the trigger in section 3 would both refuse
  -- this too; checking here gives the caller the real reason instead of a
  -- constraint name.
  IF EXISTS (
    SELECT 1 FROM public.opening_balances ob
    WHERE ob.client_id = v_header.client_id
      AND ob.nil_declared_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een nihil-verklaring voor de beginbalans; boeken is niet mogelijk'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings obp
    WHERE obp.opening_balance_id = v_header.id
  ) THEN
    RAISE EXCEPTION 'Deze beginbalans is al geboekt' USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.opening_balance_postings obp
    WHERE obp.client_id = v_header.client_id
  ) THEN
    RAISE EXCEPTION 'Deze administratie heeft al een geboekte beginbalans'
      USING ERRCODE = '23505';
  END IF;

  -- (10) Defensive: both columns are NOT NULL, but the writer does not lean on
  -- a constraint it does not own.
  IF v_header.opening_date IS NULL OR v_header.boekjaar IS NULL THEN
    RAISE EXCEPTION 'Beginbalans heeft geen datum of boekjaar; boeken is niet mogelijk'
      USING ERRCODE = '22004';
  END IF;

  -- (11) Calendar-year fiscal model (owner decision, v1). Also a table CHECK.
  IF v_header.boekjaar <> EXTRACT(YEAR FROM v_header.opening_date)::integer THEN
    RAISE EXCEPTION 'Boekjaar % hoort niet bij openingsdatum %; v1 ondersteunt alleen kalenderjaren', v_header.boekjaar, v_header.opening_date
      USING ERRCODE = '22023';
  END IF;

  -- (12) A beginbalans without a description is not auditable: it is also the
  -- fallback description of every ledger row whose line has none. Whitespace-
  -- aware: btrim() alone trims spaces only and would accept E'\t\n'.
  IF v_header.description IS NULL OR btrim(v_header.description, E' \t\r\n') = '' THEN
    RAISE EXCEPTION 'Beginbalans heeft geen omschrijving; boeken is niet mogelijk'
      USING ERRCODE = '22023';
  END IF;

  -- (13) Closed year, identically to the other four writers. No fallback year.
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_header.boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de openingsdatum, dezelfde datum die op elke grootboekregel komt.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_header.opening_date);

  -- (14) EARLIEST FACT. A beginbalans that is not the first accounting fact of
  -- its administratie would double-count everything before it, and nothing
  -- later could detect that: the group balances, so every ledger invariant and
  -- every reporting self-check would stay satisfied while the figures are
  -- wrong. This is the only moment it is visible.
  SELECT max(lp.posting_date) INTO v_earlier
  FROM public.ledger_postings lp
  WHERE lp.client_id = v_header.client_id
    AND lp.posting_date < v_header.opening_date;
  IF v_earlier IS NOT NULL THEN
    RAISE EXCEPTION 'Er staan al boekingen vóór % in het grootboek van deze administratie (laatste: %); een beginbalans moet het eerste feit zijn', v_header.opening_date, v_earlier
      USING ERRCODE = '22023';
  END IF;

  -- (15) LOCK 2 — every line, FOR UPDATE, in posting order. A raw line
  -- UPDATE/DELETE in flight finishes first (we then read its committed result);
  -- one that starts later waits here and is refused by the freeze once our
  -- marker is committed.
  PERFORM 1
  FROM public.opening_balance_lines
  WHERE opening_balance_id = v_header.id
  ORDER BY sort_order, id
  FOR UPDATE;

  -- (16) One aggregate over the locked lines, then refusals in a fixed order so
  -- the first message names the most fundamental problem.
  --   ALL of these filters are unreachable through a stored line, and that is
  --   deliberate rather than an oversight: both-sides, negative and NaN are
  --   refused by the CHECKs on opening_balance_lines, >2 decimals by the
  --   numeric(12,2) typmod, and a scope mismatch by set_opening_balance_line_scope,
  --   which always overwrites organization_id and client_id from the header. The
  --   writer keeps them so it does not lean on constraints and triggers it does
  --   not own. The NaN filter still runs BEFORE the balance comparison, because
  --   NaN = NaN is TRUE in PostgreSQL and an unbalanced NaN group would
  --   otherwise be reported as balanced.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE l.grootboekrekening_id IS NULL),
         COUNT(*) FILTER (WHERE l.debit_amount = 0 AND l.credit_amount = 0),
         COUNT(*) FILTER (WHERE l.debit_amount > 0 AND l.credit_amount > 0),
         COUNT(*) FILTER (WHERE l.debit_amount < 0 OR l.credit_amount < 0),
         COUNT(*) FILTER (WHERE l.debit_amount = 'NaN'::numeric OR l.credit_amount = 'NaN'::numeric),
         COUNT(*) FILTER (WHERE l.debit_amount <> round(l.debit_amount, 2)
                             OR l.credit_amount <> round(l.credit_amount, 2)),
         COUNT(*) FILTER (WHERE l.organization_id IS DISTINCT FROM v_header.organization_id
                             OR l.client_id IS DISTINCT FROM v_header.client_id),
         COALESCE(SUM(l.debit_amount), 0),
         COALESCE(SUM(l.credit_amount), 0)
    INTO v_line_count, v_no_account, v_zero_lines, v_both_sides, v_negative,
         v_nan, v_decimals, v_scope_bad, v_sum_debit, v_sum_credit
  FROM public.opening_balance_lines l
  WHERE l.opening_balance_id = v_header.id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Een beginbalans heeft minimaal twee regels: een debet- en een creditregel'
      USING ERRCODE = '22023';
  END IF;

  IF v_no_account > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder grootboekrekening; boeken is niet mogelijk', v_no_account
      USING ERRCODE = '22023';
  END IF;

  IF v_zero_lines > 0 THEN
    RAISE EXCEPTION '% regel(s) zonder bedrag; boeken is niet mogelijk', v_zero_lines
      USING ERRCODE = '22023';
  END IF;

  IF v_both_sides > 0 THEN
    RAISE EXCEPTION 'Een regel kan niet tegelijk debet en credit zijn' USING ERRCODE = '22023';
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION 'Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde'
      USING ERRCODE = '22023';
  END IF;

  IF v_nan > 0 THEN
    RAISE EXCEPTION 'Bedragen moeten getallen zijn' USING ERRCODE = '22023';
  END IF;

  IF v_decimals > 0 THEN
    RAISE EXCEPTION 'Bedragen mogen maximaal twee decimalen hebben' USING ERRCODE = '22023';
  END IF;

  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION 'Een regel hoort bij een andere organisatie of administratie dan de beginbalans'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Een beginbalans heeft zowel een debet- als een creditbedrag groter dan nul nodig'
      USING ERRCODE = '22023';
  END IF;

  -- Exact NUMERIC equality. No tolerance, no rounding, and above all NO
  -- automatic balancing leg: the difference is reported, never absorbed.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Beginbalans is niet in balans: debet % is ongelijk aan credit % (verschil %)',
      v_sum_debit, v_sum_credit, (v_sum_debit - v_sum_credit)
      USING ERRCODE = '23514';
  END IF;

  -- (17) Account scope: every account must be usable by THIS administratie —
  -- the same predicate ledger_postings enforces per row, checked up front so
  -- the refusal is explicit instead of a generic row error.
  SELECT COUNT(*) INTO v_scope_bad
  FROM public.opening_balance_lines l
  WHERE l.opening_balance_id = v_header.id
    AND NOT public.posting_account_ok(l.grootboekrekening_id, v_header.organization_id, v_header.client_id);
  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_scope_bad
      USING ERRCODE = '23514';
  END IF;

  -- (18) No posting onto a deactivated account.
  SELECT string_agg(g.nummer::text, ', ' ORDER BY g.nummer) INTO v_inactive
  FROM public.opening_balance_lines l
  JOIN public.grootboekrekeningen g ON g.id = l.grootboekrekening_id
  WHERE l.opening_balance_id = v_header.id
    AND NOT g.actief;
  IF v_inactive IS NOT NULL THEN
    RAISE EXCEPTION 'Een regel verwijst naar een niet-actieve grootboekrekening (%)', v_inactive
      USING ERRCODE = '22023';
  END IF;

  -- (19) Claim the beginbalans. The primary key is the per-header idempotency
  -- guarantee and the client_id index the per-administratie one; both are also
  -- the serialisation points for callers that somehow bypassed LOCK 0. No
  -- EXISTS pre-check beyond the friendly messages above — the indexes are the
  -- arbiter.
  BEGIN
    INSERT INTO public.opening_balance_postings (
      opening_balance_id, posting_group_id, organization_id, client_id,
      boekjaar, opening_date, line_count, total_amount, user_id
    ) VALUES (
      v_header.id, v_group_id, v_header.organization_id, v_header.client_id,
      v_header.boekjaar, v_header.opening_date, v_line_count, v_sum_debit, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze beginbalans is al geboekt, of deze administratie heeft er al een'
      USING ERRCODE = '23505';
  END;

  -- (20) One ledger row per line, exactly as stored, in posting order. The
  -- line's own id goes in source_line_id (durable here — header comment).
  FOR v_line IN
    SELECT id, grootboekrekening_id, debit_amount, credit_amount, description
    FROM public.opening_balance_lines
    WHERE opening_balance_id = v_header.id
    ORDER BY sort_order, id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id, user_id
    ) VALUES (
      v_header.organization_id, v_header.client_id, v_line.grootboekrekening_id, v_group_id, v_line_no,
      v_header.opening_date, v_header.boekjaar, v_line.debit_amount, v_line.credit_amount, 'EUR',
      COALESCE(NULLIF(btrim(v_line.description, E' \t\r\n'), ''), v_header.description),
      'opening_balance', v_header.id, v_line.id, v_uid
    );
  END LOOP;

  -- (21)
  RETURN v_group_id;
END
$$;

CREATE OR REPLACE FUNCTION public.reverse_posting_group(
  _posting_group_id uuid,
  _posting_date     date,
  _reason           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_client        public.clients%ROWTYPE;
  v_new_group     uuid := gen_random_uuid();
  v_reason        text;
  v_boekjaar      integer;

  -- Aggregaat over het origineel.
  v_rows          integer;
  v_orgs          integer;
  v_clients       integer;
  v_currencies    integer;
  v_dates         integer;
  v_boekjaren     integer;
  v_sources       integer;
  v_xacts         integer;
  v_bad_sides     integer;
  v_negative      integer;
  v_nan           integer;
  v_own_xact      integer;
  v_sum_debit     numeric;
  v_sum_credit    numeric;

  v_org           uuid;
  v_client_id     uuid;
  -- De VOLLEDIGE sets, niet een steekproef: de autorisatiepoort in (5) moet
  -- over elke organisatie in de groep kunnen oordelen, ook als die groep er
  -- (kapot) meerdere bevat.
  v_org_ids       uuid[];
  v_client_ids    uuid[];
  v_probe_org     uuid;
  v_currency      text;
  v_orig_date     date;
  v_orig_boekjaar integer;
  v_orig_source   text;
  v_scope_bad     integer;

  v_line_no       integer := 0;
  v_row           record;
BEGIN
  -- (1) Authenticatie eerst: voor een anonieme aanroep wordt niets gelezen en
  --     niets gegrendeld.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolatiecontract. 6C-b2 weigert een grootboek-INSERT buiten READ
  --     COMMITTED; hier vroeg gecontroleerd, zodat de aanroeper de echte reden
  --     krijgt in plaats van een triggerfout halverwege.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een tegenboeking kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  IF _posting_group_id IS NULL THEN
    RAISE EXCEPTION 'Geen boekingsgroep opgegeven' USING ERRCODE = '22004';
  END IF;

  IF _posting_date IS NULL THEN
    RAISE EXCEPTION 'Een tegenboeking heeft een boekingsdatum nodig' USING ERRCODE = '22004';
  END IF;

  -- (3) De toelichting normaliseren vóór elke controle: whitespace-only is
  --     geen toelichting. btrim() alleen trimt spaties, dus expliciet ook tab,
  --     CR en LF.
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (4) Datumbereik, gelijk aan de CHECK op boekjaar in ledger_postings.
  IF _posting_date < DATE '2000-01-01' OR _posting_date > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Boekingsdatum % valt buiten het ondersteunde bereik 2000-2100', _posting_date
      USING ERRCODE = '22023';
  END IF;
  v_boekjaar := EXTRACT(YEAR FROM _posting_date)::integer;

  -- ── (5) DE AUTORISATIEPOORT ────────────────────────────────────────────────
  --
  --     Alles hierboven gaat over de ARGUMENTEN en onthult niets over
  --     opgeslagen gegevens. Alles hieronder wel. Hier ligt de grens.
  --
  --     WAAROM DIT ZO MOET
  --     Deze functie is SECURITY DEFINER en ziet dus rijen die RLS voor de
  --     aanroeper verbergt. Zou zij eerst "niet gevonden" zeggen en pas daarna
  --     "geen rechten", dan is het verschil tussen die twee antwoorden een
  --     orakel: een ingelogde buitenstaander kan boekingsgroep-id's aanbieden
  --     en uit de foutboodschap aflezen wélke bestaan. Dat is een
  --     cross-tenant existence leak, hoe klein ook. Beide gevallen krijgen
  --     daarom exact dezelfde fout: dezelfde SQLSTATE én dezelfde tekst.
  --
  --     DE ORGANISATIES EERST, EN ALLEMAAL
  --     Niet één organisatie via LIMIT 1. Bij een kapotte groep met twee
  --     organisaties zou zo'n steekproef toevallig de rechten op de ene
  --     kunnen gebruiken en de andere negeren — precies de tenantinformatie
  --     die niet mag weglekken. De hele set wordt opgehaald en de aanroeper
  --     moet bevoegd zijn voor ÉLKE organisatie erin.
  SELECT array_agg(DISTINCT lp.organization_id)
    INTO v_org_ids
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id;

  --     LEESDREMPEL. Onder read_only verbergt RLS deze rijen sowieso; dan mag
  --     deze functie hun bestaan ook niet bevestigen. Een lege set (de groep
  --     bestaat niet) en een set waarvoor de aanroeper niet bevoegd is, zijn
  --     vanaf hier niet meer van elkaar te onderscheiden.
  --     array_agg(DISTINCT …) slaat NULL-waarden over, dus een groep waarvan
  --     elke rij op onverklaarbare wijze geen organisatie heeft, valt hier
  --     eveneens uit — fail closed.
  IF v_org_ids IS NULL THEN
    RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  FOREACH v_probe_org IN ARRAY v_org_ids LOOP
    IF NOT public.has_min_role(v_uid, v_probe_org, 'read_only') THEN
      RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  --     SCHRIJFDREMPEL. Vanaf hier is bekend dat de aanroeper deze regels
  --     onder RLS gewoon mag lezen, dus een eerlijk antwoord over zijn eigen
  --     rol verraadt niets wat hij niet al kan zien. ROLVLOER = accountant, en
  --     ook hier voor élke organisatie in de groep.
  FOREACH v_probe_org IN ARRAY v_org_ids LOOP
    IF NOT public.has_min_role(v_uid, v_probe_org, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een tegenboeking te maken voor deze organisatie (accountant vereist)'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- (6) Pas NU mag er iets over de vorm van de groep worden gezegd. Een
  --     kapotte groep met meerdere organisaties krijgt zijn eigen, inhoudelijke
  --     melding — maar uitsluitend voor een aanroeper die voor al die
  --     organisaties bevoegd is.
  IF array_length(v_org_ids, 1) > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels van meerdere organisaties en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;
  v_org := v_org_ids[1];

  -- (7) De administratie, om te weten wélke administratiegrendel genomen moet
  --     worden. Ook hier de hele set, niet een steekproef.
  SELECT array_agg(DISTINCT lp.client_id)
    INTO v_client_ids
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id;

  IF v_client_ids IS NULL THEN
    RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF array_length(v_client_ids, 1) > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels van meerdere administraties en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;
  v_client_id := v_client_ids[1];

  -- (8) GRENDEL 0 — de administratie. Dezelfde grendel die elke grootboekregel
  --     via de trigger van 6C-b8 neemt, en die post_opening_balance() als
  --     eerste neemt. Hiermee grendelt deze schrijver in exact dezelfde
  --     volgorde als elke andere schrijfweg.
  PERFORM public.lock_ledger_client(v_client_id);

  -- (9) Het origineel opnieuw lezen ONDER de grendel, als één aggregaat. Een
  --     gecommitte groep verandert niet meer (append-only + zegel), dus dit is
  --     de volledige, definitieve vorm van het origineel.
  SELECT COUNT(*),
         COUNT(DISTINCT lp.organization_id),
         COUNT(DISTINCT lp.client_id),
         COUNT(DISTINCT lp.currency),
         COUNT(DISTINCT lp.posting_date),
         COUNT(DISTINCT lp.boekjaar),
         COUNT(DISTINCT lp.source_type),
         COUNT(DISTINCT lp.created_xact_id),
         COUNT(*) FILTER (WHERE NOT ((lp.debit_amount  > 0 AND lp.credit_amount = 0)
                                  OR (lp.credit_amount > 0 AND lp.debit_amount  = 0))),
         COUNT(*) FILTER (WHERE lp.debit_amount < 0 OR lp.credit_amount < 0),
         COUNT(*) FILTER (WHERE lp.debit_amount = 'NaN'::numeric OR lp.credit_amount = 'NaN'::numeric),
         -- _if_assigned(): dwingt geen transactie-id af (dat zou in een
         -- read-only transactie een onbegrijpelijke fout geven) en levert NULL
         -- zolang deze transactie nog niets heeft geschreven — dan is de groep
         -- per definitie niet van ons en telt de filter terecht niets.
         COUNT(*) FILTER (WHERE lp.created_xact_id = pg_current_xact_id_if_assigned()),
         COALESCE(SUM(lp.debit_amount), 0),
         COALESCE(SUM(lp.credit_amount), 0),
         -- Via text, want PostgreSQL kent geen min(uuid). De DISTINCT-tellingen
         -- hierboven bewijzen dat er hoogstens één waarde is, dus welke
         -- aggregaat het ook is: hij is de enige.
         MIN(lp.organization_id::text)::uuid,
         MIN(lp.client_id::text)::uuid,
         MIN(lp.currency),
         MIN(lp.posting_date),
         MIN(lp.boekjaar),
         MIN(lp.source_type)
    INTO v_rows, v_orgs, v_clients, v_currencies, v_dates, v_boekjaren, v_sources,
         v_xacts, v_bad_sides, v_negative, v_nan, v_own_xact, v_sum_debit, v_sum_credit,
         v_org, v_client_id, v_currency, v_orig_date, v_orig_boekjaar, v_orig_source
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- (10) De groep zoals hij ONDER de grendel blijkt te zijn, moet dezelfde zijn
  --      als die waarvoor in (5) is geautoriseerd. Voor een gecommitte groep
  --      kan dat niet verschillen — append-only plus het transactiezegel van
  --      6C-b2 — maar als het tóch verschilt, is de autorisatie over een andere
  --      groep gegaan dan die we nu zouden tegenboeken. Dan weigeren we
  --      generiek, want elke inhoudelijke melding zou over ongeautoriseerde
  --      gegevens gaan.
  IF v_orgs > 1 OR v_org IS DISTINCT FROM v_org_ids[1]
     OR v_clients > 1 OR v_client_id IS DISTINCT FROM v_client_ids[1] THEN
    RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- (11) De administratie moet bij de organisatie van de groep horen.
  SELECT * INTO v_client FROM public.clients WHERE id = v_client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze boekingsgroep'
      USING ERRCODE = '42501';
  END IF;

  -- (10) Lineage: één stap diep. Een tegenboeking van een tegenboeking maakt de
  --      geschiedenis onleesbaar en lost niets op — is de tegenboeking zelf
  --      fout, dan is de juiste weg een nieuwe, correcte boeking.
  IF v_sources > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere bronsoorten en is niet als één feit te lezen'
      USING ERRCODE = '23514';
  END IF;

  IF v_orig_source = 'reversal' THEN
    RAISE EXCEPTION 'Deze boekingsgroep is zelf een tegenboeking; een tegenboeking van een tegenboeking wordt niet ondersteund. Boek in plaats daarvan de juiste boeking opnieuw.'
      USING ERRCODE = '22023';
  END IF;

  -- (11) Beginbalans: bewust geweigerd, met de reden erbij. Zie de header — het
  --      is niet de boeking die onmogelijk is, het is de toestand waarin de
  --      administratie daarna zou achterblijven.
  IF v_orig_source = 'opening_balance' THEN
    RAISE EXCEPTION 'Een geboekte beginbalans kan niet worden tegengeboekt: deze administratie kan daarna geen nieuwe beginbalans vastleggen. Corrigeer met een memoriaalboeking.'
      USING ERRCODE = '22023';
  END IF;

  -- (12) Is deze groep al tegengeboekt? De primary key van de marker is de
  --      echte arbiter (stap 17); deze controle geeft de aanroeper alleen een
  --      begrijpelijke reden in plaats van een constraintnaam.
  IF EXISTS (
    SELECT 1 FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = _posting_group_id
  ) THEN
    RAISE EXCEPTION 'Deze boekingsgroep is al tegengeboekt' USING ERRCODE = '23505';
  END IF;

  -- (13) HET ORIGINEEL ALS BOEKHOUDKUNDIG FEIT. Een kapotte groep wordt NIET
  --      "hersteld" door haar tegen te boeken: dat verdubbelt de fout en wist
  --      het bewijs uit dat er iets mis is. Elke weigering noemt haar eigen
  --      reden.
  IF v_xacts > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels uit meerdere transacties en is niet als één boeking vastgelegd'
      USING ERRCODE = '23514';
  END IF;

  -- Een groep die in DEZE transactie is ontstaan is nog niet gecommit. Haar
  -- tegenboeken zou betekenen dat origineel en tegenboeking samen staan of
  -- samen vallen, wat geen correctie is maar een lege operatie — en het zou de
  -- marker laten wijzen naar iets wat na een rollback nooit heeft bestaan.
  IF v_own_xact > 0 THEN
    RAISE EXCEPTION 'Deze boekingsgroep is in dezelfde transactie ontstaan en kan nog niet worden tegengeboekt'
      USING ERRCODE = '22023';
  END IF;

  IF v_rows < 2 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat % regel; een boeking heeft minimaal een debet- en een creditregel', v_rows
      USING ERRCODE = '23514';
  END IF;

  IF v_currencies > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere valuta en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  IF v_dates > 1 OR v_boekjaren > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere boekingsdatums of boekjaren en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  -- Boekjaar moet bij de boekingsdatum horen. Alle vijf de bestaande
  -- schrijvers leiden het zo af; wijkt een groep daarvan af, dan is zij niet
  -- door een schrijver gemaakt en is haar periodetoerekening niet te
  -- vertrouwen.
  IF v_orig_boekjaar <> EXTRACT(YEAR FROM v_orig_date)::integer THEN
    RAISE EXCEPTION 'Boekjaar % hoort niet bij boekingsdatum % van de oorspronkelijke boeking', v_orig_boekjaar, v_orig_date
      USING ERRCODE = '23514';
  END IF;

  -- NaN vóór de balanscontrole: NaN = NaN is TRUE in PostgreSQL, dus een
  -- groep met NaN zou anders als sluitend worden gerapporteerd.
  IF v_nan > 0 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat een bedrag dat geen getal is' USING ERRCODE = '23514';
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat een negatief bedrag' USING ERRCODE = '23514';
  END IF;

  IF v_bad_sides > 0 THEN
    RAISE EXCEPTION '% regel(s) in deze boekingsgroep staan niet op precies één zijde', v_bad_sides
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Boekingsgroep heeft geen debet- én creditbedrag groter dan nul (debet %, credit %)', v_sum_debit, v_sum_credit
      USING ERRCODE = '23514';
  END IF;

  -- Exacte NUMERIC-gelijkheid, geen tolerantie.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Boekingsgroep is niet in balans: debet % is ongelijk aan credit % (verschil %); een niet-sluitende boeking wordt niet tegengeboekt maar onderzocht',
      v_sum_debit, v_sum_credit, (v_sum_debit - v_sum_credit)
      USING ERRCODE = '23514';
  END IF;

  -- (14) Valuta. De vijf schrijvers boeken uitsluitend 'EUR' en de
  --      rapportagekern weigert elke andere valuta hard. Een tegenboeking
  --      neemt de valuta van het origineel over; is dat geen EUR, dan is het
  --      origineel zelf al onrapporteerbaar en wordt er niets aan toegevoegd.
  IF v_currency IS DISTINCT FROM 'EUR' THEN
    RAISE EXCEPTION 'Valuta % wordt niet ondersteund; alleen EUR', COALESCE(v_currency, '(leeg)')
      USING ERRCODE = '22023';
  END IF;

  -- (15) Rekeningen. Elke rekening van het origineel moet nog steeds bruikbaar
  --      zijn voor DEZE administratie — hetzelfde predicaat dat
  --      ledger_postings per rij afdwingt, hier vooraf gecontroleerd zodat de
  --      weigering een reden heeft in plaats van een rijfout.
  --
  --      BEWUST NIET gecontroleerd: `actief`. De vijf schrijvers weigeren een
  --      inactieve rekening, en terecht — zij beginnen iets nieuws. Een
  --      tegenboeking doet het tegenovergestelde: zij haalt weg wat er al op
  --      die rekening staat. Zou `actief` hier gelden, dan werd het
  --      deactiveren van een rekening een val waaruit een foutieve boeking
  --      nooit meer te corrigeren is.
  SELECT COUNT(*) INTO v_scope_bad
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id
    AND NOT public.posting_account_ok(lp.grootboekrekening_id, v_org, v_client_id);
  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_scope_bad
      USING ERRCODE = '23514';
  END IF;

  -- (16) De datum van de tegenboeking. Geen stilzwijgende verschuiving, geen
  --      terugval op vandaag, geen terugval op het eerstvolgende open jaar.
  IF _posting_date < v_orig_date THEN
    RAISE EXCEPTION 'Een tegenboeking van % kan niet op % worden geboekt: dat ligt vóór de oorspronkelijke boeking', v_orig_date, _posting_date
      USING ERRCODE = '22023';
  END IF;

  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de datum van de TEGENBOEKING, niet die van het origineel.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, _posting_date);

  -- (17) De claim. De primary key op original_posting_group_id IS de
  --      idempotentiegarantie en het serialisatiepunt: een tweede
  --      gelijktijdige aanroep blokkeert hier tot wij committen en faalt dan.
  BEGIN
    INSERT INTO public.ledger_reversal_postings (
      original_posting_group_id, reversal_posting_group_id,
      organization_id, client_id,
      original_posting_date, original_boekjaar, original_source_type,
      posting_date, boekjaar, line_count, total_amount, currency,
      reason, user_id
    ) VALUES (
      _posting_group_id, v_new_group,
      v_org, v_client_id,
      v_orig_date, v_orig_boekjaar, v_orig_source,
      _posting_date, v_boekjaar, v_rows, v_sum_debit, v_currency,
      v_reason, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze boekingsgroep is al tegengeboekt' USING ERRCODE = '23505';
  END;

  -- (18) Eén tegenregel per originele regel, in de vaste volgorde van het
  --      origineel. Debet en credit worden verwisseld; rekening, valuta,
  --      organisatie en administratie blijven exact wat zij waren.
  --
  --      Er wordt NIET gegroepeerd per rekening: een groep mag meerdere regels
  --      op dezelfde rekening dragen, en die blijven ook in de tegenboeking
  --      afzonderlijke regels — anders zou de regel-op-regel-lineage niet meer
  --      kloppen en zou het regelaantal van de marker niet meer overeenkomen.
  FOR v_row IN
    SELECT lp.id, lp.grootboekrekening_id, lp.debit_amount, lp.credit_amount,
           lp.currency, lp.description
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = _posting_group_id
    ORDER BY lp.line_no, lp.id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id,
      reversal_of_posting_id, user_id
    ) VALUES (
      v_org, v_client_id, v_row.grootboekrekening_id, v_new_group, v_line_no,
      _posting_date, v_boekjaar,
      -- De hele tegenboeking, in twee waarden.
      v_row.credit_amount, v_row.debit_amount,
      v_row.currency,
      'Tegenboeking: ' || COALESCE(v_reason,
                                   NULLIF(btrim(COALESCE(v_row.description, ''), E' \t\r\n'), ''),
                                   to_char(v_orig_date, 'DD-MM-YYYY')),
      'reversal', _posting_group_id,
      -- source_line_id blijft NULL: de regel-op-regel-verwijzing staat in
      -- reversal_of_posting_id, en twee kolommen met hetzelfde feit zijn twee
      -- kolommen die uit elkaar kunnen lopen.
      NULL,
      v_row.id, v_uid
    );
  END LOOP;

  RETURN v_new_group;
END
$$;

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

  -- ── Vanaf hier is alles een letterlijke kopie van 20260920195805 ──────────

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

  IF v_client.bank_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen bankrekening (grootboek) ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_tx.transaction_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar USING ERRCODE = '22023';
  END IF;

  -- ── 6C-b11 PR D: DE BOEKINGSBLOKKADE ──────────────────────────────────────
  --
  --     Een TWEEDE, los besturingselement naast het afsluitwatermerk hierboven.
  --     Dat watermerk blijft onveranderd staan: deze fase is bewust dubbel
  --     bewaakt, en wat eerder werd geweigerd wordt nog steeds geweigerd, met
  --     dezelfde melding. Er komt alleen een weigering bij.
  --
  --     DE GRENDEL EERST. `set_posting_lock()` neemt dezelfde
  --     administratiegrendel, dus zodra wij hem houden kan de blokkade niet
  --     meer tussen deze toets en het boeken door veranderen. Zonder dat zou er
  --     een gat zitten: toetsen, een ander verzet de blokkade, en wij boeken
  --     alsnog. Voor post_opening_balance() en reverse_posting_group() is deze
  --     grendel al genomen; een advisory lock is her-intreedbaar, dus dat kost
  --     daar niets.
  --
  --     DE DATUM IS de datum van de banktransactie.
  PERFORM public.lock_ledger_client(v_client.id);
  PERFORM public.assert_posting_allowed(v_client.id, v_tx.transaction_date);

  IF NOT public.posting_account_ok(v_client.bank_rekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De ingestelde bankrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_tx.grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  -- BTW: vrijgestelde administraties boeken nooit BTW.
  v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE COALESCE(v_tx.btw_percentage, 0) END;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) De bulk-preflight
--
--    `bank_bulk_posting_candidates()` is alleen lezen en geen acceptatiemotor —
--    `post_bank_transaction()` blijft de autoriteit. Maar zij mag een regel niet
--    als `ready` presenteren die de schrijver een seconde later weigert: dan
--    stuurt het scherm de gebruiker een muur in.
--
--    Daarom één extra tak, op exact dezelfde grens als de bewering hierboven
--    (`<=`, dus de blokkadedatum zelf telt mee) en met dezelfde formulering,
--    NA de afgesloten-jaar-tak zodat een al geweigerde regel zijn bestaande
--    reden houdt. Verder is deze functie onveranderd: dezelfde retourvorm,
--    dezelfde volgorde, SECURITY INVOKER, en `post_bank_transactions_bulk()`
--    erft de handhaving vanzelf omdat zij per transactie de echte schrijver
--    aanroept.
-- ─────────────────────────────────────────────────────────────────────────────

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
      WHEN c.afgesloten_boekjaar IS NOT NULL
       AND EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar
                                                        THEN 'blocked'
      WHEN c.posting_locked_through IS NOT NULL
       AND t.transaction_date <= c.posting_locked_through
                                                        THEN 'blocked'
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
      WHEN c.afgesloten_boekjaar IS NOT NULL
       AND EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar
                                                        THEN format('Boekjaar %s is afgesloten voor deze administratie.',
                                                                    EXTRACT(YEAR FROM t.transaction_date)::integer)
      WHEN c.posting_locked_through IS NOT NULL
       AND t.transaction_date <= c.posting_locked_through
                                                        THEN format('Boekingsdatum %s valt binnen de boekingsblokkade t/m %s voor deze administratie',
                                                                    t.transaction_date, c.posting_locked_through)
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
