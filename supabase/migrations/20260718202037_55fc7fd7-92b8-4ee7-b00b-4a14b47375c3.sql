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
'Atomair vervangen van boekingsregels voor een inkoopfactuur. Rolt volledig terug bij fouten zodat bestaande regels nooit verloren gaan.';

REVOKE ALL ON FUNCTION public.replace_purchase_invoice_lines(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_purchase_invoice_lines(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_purchase_invoice_lines(uuid, jsonb) TO service_role;