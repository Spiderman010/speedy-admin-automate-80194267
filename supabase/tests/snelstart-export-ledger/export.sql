-- EXPORT — throwaway database only. Never run against any BoekAssist database.
--
-- Schrijft de bronrijen (facturen, boekingsregels, rekeningen) en de
-- journaalregels die post_purchase_invoice() er werkelijk van maakte, als één
-- JSON-document. Deterministisch: vaste id's, geen tijdstempels en geen
-- willekeurige posting_group_id's.
--
-- Aanroep: psql -v out=<pad> -f export.sql

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o :out
SELECT jsonb_pretty(jsonb_build_object(
  'generated_by', 'supabase/tests/snelstart-export-ledger/run-proof.sh',
  'crediteuren_nummer', 1600,
  'btw_te_vorderen_nummer', 1520,
  'invoices', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', i.id, 'client_id', i.client_id, 'organization_id', i.organization_id,
      'supplier', i.supplier, 'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date,
      'amount_excl', i.amount_excl, 'btw_amount', i.btw_amount, 'amount_incl', i.amount_incl,
      'btw_percentage', i.btw_percentage, 'status', i.status, 'remaining_amount', i.remaining_amount,
      'posted', EXISTS (SELECT 1 FROM public.purchase_invoice_postings p WHERE p.purchase_invoice_id = i.id)
    ) ORDER BY i.id)
    FROM public.purchase_invoices i
  ),
  'lines', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', l.id, 'purchase_invoice_id', l.purchase_invoice_id, 'omschrijving', l.omschrijving,
      'amount_excl', l.amount_excl, 'btw_percentage', l.btw_percentage,
      'grootboekrekening_id', l.grootboekrekening_id, 'sort_order', l.sort_order,
      'organization_id', l.organization_id
    ) ORDER BY l.purchase_invoice_id, l.sort_order, l.id)
    FROM public.purchase_invoice_lines l
  ),
  'accounts', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', g.id, 'nummer', g.nummer, 'organization_id', g.organization_id, 'client_id', g.client_id
    ) ORDER BY g.nummer)
    FROM public.grootboekrekeningen g
  ),
  'ledger', (
    SELECT jsonb_agg(jsonb_build_object(
      'source_id', lp.source_id, 'line_no', lp.line_no, 'nummer', g.nummer,
      'debit_amount', lp.debit_amount, 'credit_amount', lp.credit_amount, 'description', lp.description
    ) ORDER BY lp.source_id, lp.line_no)
    FROM public.ledger_postings lp
    JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
    WHERE lp.source_type = 'purchase_invoice'
  )
));
\o
