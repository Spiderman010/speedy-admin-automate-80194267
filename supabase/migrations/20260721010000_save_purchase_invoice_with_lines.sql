-- Atomic save for purchase invoice header + lines in one transaction.
-- rollback: DROP FUNCTION IF EXISTS public.save_purchase_invoice_with_lines(uuid, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_lines(
  _invoice_id uuid,
  _header_updates jsonb,
  _lines jsonb
) RETURNS public.purchase_invoices
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_invalid_keys text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'niet geauthenticeerd' USING ERRCODE = '28000';
  END IF;

  IF _header_updates IS NULL OR jsonb_typeof(_header_updates) <> 'object' THEN
    RAISE EXCEPTION 'header_updates moet een JSON object zijn'
      USING ERRCODE = '22023';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'lines moet een JSON array zijn'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(key ORDER BY key)
  INTO v_invalid_keys
  FROM jsonb_object_keys(_header_updates) AS key
  WHERE key NOT IN (
    'client_id',
    'leverancier_id',
    'supplier',
    'invoice_number',
    'invoice_date',
    'amount_excl',
    'btw_amount',
    'amount_incl',
    'btw_percentage',
    'ledger_account_text',
    'notes',
    'status'
  );

  IF v_invalid_keys IS NOT NULL THEN
    RAISE EXCEPTION 'onbekende headervelden: %', array_to_string(v_invalid_keys, ', ')
      USING ERRCODE = '22023';
  END IF;

  SELECT organization_id
  INTO v_org
  FROM public.purchase_invoices
  WHERE id = _invoice_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'inkoopfactuur niet gevonden of geen toegang'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.purchase_invoices
  SET
    client_id = CASE
      WHEN _header_updates ? 'client_id'
        THEN NULLIF(_header_updates->>'client_id', '')::uuid
      ELSE client_id
    END,
    leverancier_id = CASE
      WHEN _header_updates ? 'leverancier_id'
        THEN NULLIF(_header_updates->>'leverancier_id', '')::uuid
      ELSE leverancier_id
    END,
    supplier = CASE
      WHEN _header_updates ? 'supplier'
        THEN COALESCE(_header_updates->>'supplier', '')
      ELSE supplier
    END,
    invoice_number = CASE
      WHEN _header_updates ? 'invoice_number'
        THEN NULLIF(_header_updates->>'invoice_number', '')
      ELSE invoice_number
    END,
    invoice_date = CASE
      WHEN _header_updates ? 'invoice_date'
        THEN NULLIF(_header_updates->>'invoice_date', '')::date
      ELSE invoice_date
    END,
    amount_excl = CASE
      WHEN _header_updates ? 'amount_excl'
        THEN NULLIF(_header_updates->>'amount_excl', '')::numeric
      ELSE amount_excl
    END,
    btw_amount = CASE
      WHEN _header_updates ? 'btw_amount'
        THEN NULLIF(_header_updates->>'btw_amount', '')::numeric
      ELSE btw_amount
    END,
    amount_incl = CASE
      WHEN _header_updates ? 'amount_incl'
        THEN NULLIF(_header_updates->>'amount_incl', '')::numeric
      ELSE amount_incl
    END,
    btw_percentage = CASE
      WHEN _header_updates ? 'btw_percentage'
        THEN NULLIF(_header_updates->>'btw_percentage', '')::numeric
      ELSE btw_percentage
    END,
    ledger_account_text = CASE
      WHEN _header_updates ? 'ledger_account_text'
        THEN NULLIF(_header_updates->>'ledger_account_text', '')
      ELSE ledger_account_text
    END,
    notes = CASE
      WHEN _header_updates ? 'notes'
        THEN NULLIF(_header_updates->>'notes', '')
      ELSE notes
    END,
    status = CASE
      WHEN _header_updates ? 'status'
        THEN COALESCE(NULLIF(_header_updates->>'status', ''), status)
      ELSE status
    END
  WHERE id = _invoice_id
  RETURNING * INTO v_invoice;

  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'inkoopfactuur niet gevonden of geen toegang'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.replace_purchase_invoice_lines(_invoice_id, _lines);

  RETURN v_invoice;
END;
$$;

COMMENT ON FUNCTION public.save_purchase_invoice_with_lines(uuid, jsonb, jsonb) IS
'Slaat een inkoopfactuurheader en alle boekingsregels atomair op. Bij iedere fout worden header en regels volledig teruggedraaid.';

REVOKE ALL ON FUNCTION public.save_purchase_invoice_with_lines(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_purchase_invoice_with_lines(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_purchase_invoice_with_lines(uuid, jsonb, jsonb) TO service_role;
