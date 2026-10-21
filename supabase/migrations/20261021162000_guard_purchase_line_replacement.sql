-- ═════════════════════════════════════════════════════════════════════════════
-- A2-07 — REGELS VERVANGEN LAAT NOOIT MEER EEN VERDUBBELDE SET ACHTER
--
-- HET PROBLEEM
--   replace_purchase_invoice_lines (20260718202037, laatste en enige definitie;
--   save_purchase_invoice_with_lines uit 20260721010000 roept haar aan) is
--   SECURITY INVOKER en vervangt de regels met DELETE + INSERT onder de RLS van
--   de aanroeper. Voor een assistent raakt de DELETE 0 rijen (DELETE-floor
--   accountant, 20260613001452 r. 130-131) terwijl de INSERT wel mag: elke
--   opslag zet de regels er opnieuw bij (1, 2, 3 …), boeken wordt geweigerd en
--   de assistent kan het niet herstellen (nulmeting A2-07, F1b F1).
--
-- ONTWERPBESLUIT D5 ("mag een assistent regels vervangen?") STAAT OPEN.
--   Deze migratie bouwt daarom de fail-closed variant: na de DELETE controleert
--   de functie of er nog regels van deze factuur zichtbaar zijn. Zo ja, dan
--   heeft de aanroeper niet alle bestaande regels mogen verwijderen en volgt
--   RAISE 42501 met een Nederlandse melding. De hele transactie rolt terug:
--   de DELETE, en via save_purchase_invoice_with_lines ook de kopwijziging.
--   Dezelfde guard als save_manual_journal_lines (20260918120000) heeft.
--   De variant voor D5 = "ja" (SECURITY DEFINER met expliciete rolcheck) staat
--   als niet-toegepaste schets in het rapport.
--
-- GEVOLG PER ROL (nu)
--   accountant/owner: ongewijzigd (de DELETE raakt alle regels).
--   assistant: een factuur zonder regels kan één keer worden opgeslagen
--     (eerste opslag/goedkeuring); daarna wordt elke opslag met regels
--     geweigerd in plaats van verdubbeld.
--   read_only: werd al geweigerd (INSERT-floor assistant); nu eerder, met
--     dezelfde SQLSTATE 42501.
--
-- BEHOUDEN GARANTIES (letterlijk uit 20260718202037)
--   SECURITY INVOKER (RLS blijft de autorisatie), SET search_path = public,
--   auth.uid() verplicht (28000), factuur onzichtbaar = 42501, JSON-array-eis
--   (22023), per regel omschrijving en parseerbaar bedrag (23514/22P02) vóór
--   er iets wordt verwijderd, organization_id en user_id uit de factuur en de
--   aanroeper, sort_order-fallback, dezelfde returnset en dezelfde rechten
--   (CREATE OR REPLACE behoudt de bestaande EXECUTE-toekenningen).
--
-- IDEMPOTENT: CREATE OR REPLACE.
--
-- ROLLBACK: de functie uit 20260718202037 opnieuw toepassen (zelfde
--   signatuur; dat bestand is zelf CREATE OR REPLACE), zonder het blok
--   "A2-07-guard" hieronder.
-- ═════════════════════════════════════════════════════════════════════════════

DO $migratie$
BEGIN
  IF to_regprocedure('public.replace_purchase_invoice_lines(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'A2-07 vereist public.replace_purchase_invoice_lines(uuid, jsonb) (20260718202037)';
  END IF;
END
$migratie$;

CREATE OR REPLACE FUNCTION public.replace_purchase_invoice_lines(
  _invoice_id uuid,
  _lines jsonb
) RETURNS SETOF public.purchase_invoice_lines
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_elem jsonb;
  v_desc text;
  v_amount_txt text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'niet geauthenticeerd' USING ERRCODE = '28000';
  END IF;

  -- RLS on purchase_invoices enforces organization access; if the caller
  -- cannot see the invoice, this returns NULL and we reject.
  SELECT organization_id INTO v_org
  FROM public.purchase_invoices
  WHERE id = _invoice_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'inkoopfactuur niet gevonden of geen toegang'
      USING ERRCODE = '42501';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'lines moet een JSON array zijn'
      USING ERRCODE = '22023';
  END IF;

  -- Defensive per-line validation: required fields + parseable amount.
  FOR v_elem IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_desc := btrim(COALESCE(v_elem->>'omschrijving', ''));
    v_amount_txt := v_elem->>'amount_excl';
    IF v_desc = '' THEN
      RAISE EXCEPTION 'elke regel moet een omschrijving hebben'
        USING ERRCODE = '23514';
    END IF;
    IF v_amount_txt IS NULL OR v_amount_txt = '' THEN
      RAISE EXCEPTION 'elke regel moet een geldig bedrag excl. hebben'
        USING ERRCODE = '23514';
    END IF;
    -- Force numeric parse; raises 22P02 on invalid input.
    PERFORM v_amount_txt::numeric;
  END LOOP;

  -- Atomic replace. If either statement raises, the enclosing function
  -- transaction rolls back and the original rows remain intact.
  DELETE FROM public.purchase_invoice_lines
  WHERE purchase_invoice_id = _invoice_id;

  -- A2-07-guard (D5 open, fail-closed). Onder RLS slaat een DELETE stil de
  -- rijen over die de aanroeper niet mag verwijderen. Is er na de DELETE nog
  -- een regel van deze factuur zichtbaar, dan mag de nieuwe set er niet naast
  -- komen: weigeren, en alles rolt terug.
  IF EXISTS (SELECT 1 FROM public.purchase_invoice_lines WHERE purchase_invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'Je rol mag de bestaande boekingsregels van deze inkoopfactuur niet vervangen; er is niets opgeslagen. Laat een accountant of eigenaar de regels opslaan.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.purchase_invoice_lines (
    purchase_invoice_id,
    user_id,
    organization_id,
    omschrijving,
    amount_excl,
    btw_percentage,
    grootboekrekening_id,
    sort_order
  )
  SELECT
    _invoice_id,
    v_uid,
    v_org,
    btrim(elem->>'omschrijving'),
    (elem->>'amount_excl')::numeric,
    NULLIF(elem->>'btw_percentage', '')::numeric,
    NULLIF(elem->>'grootboekrekening_id', '')::uuid,
    COALESCE(NULLIF(elem->>'sort_order','')::int, (ord - 1)::int)
  FROM jsonb_array_elements(_lines) WITH ORDINALITY AS t(elem, ord);

  RETURN QUERY
    SELECT *
    FROM public.purchase_invoice_lines
    WHERE purchase_invoice_id = _invoice_id
    ORDER BY sort_order ASC, created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.replace_purchase_invoice_lines(uuid, jsonb) IS
'Atomair vervangen van boekingsregels voor een inkoopfactuur. Rolt volledig terug bij fouten zodat bestaande regels nooit verloren gaan. Blijven er na het verwijderen regels staan die de aanroeper niet mocht verwijderen, dan weigert de functie (42501) in plaats van een verdubbelde set achter te laten (A2-07; ontwerpbesluit D5 open).';
