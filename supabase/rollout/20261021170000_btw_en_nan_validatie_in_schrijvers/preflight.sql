-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261021170000_btw_en_nan_validatie_in_schrijvers.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`
-- (projectref visueel bevestigd). Alles hieronder is ALLEEN LEZEN: elke
-- opdracht is een SELECT. Niets wordt hier getest door te schrijven.
--
-- STOP (niets uitvoeren, uitkomst doorgeven) als:
--   • PRE 1 ergens `false` geeft (PR 2 ontbreekt, een kolom ontbreekt, of een
--     constraintnaam is al bezet) — de migratie zou dan zelf weigeren;
--   • PRE 2 ergens `gelijk = false` geeft (een functie draagt een ander
--     lichaam dan beoordeeld) — eerst een nieuwe beoordeling;
--   • een query een foutmelding geeft.
-- PRE 3 tot en met PRE 6 zijn informatief: zij tellen wat de migratie in de
-- werkstroom verandert, zonder iets te veranderen. Bewaar PRE 6 (de
-- vingerafdruk) voor POST 4. Voer PRE, migratie en POST direct na elkaar uit
-- op een rustig moment: een import of bewerking ertussen laat de vingerafdruk
-- verschillen zonder dat de migratie iets wijzigde.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Voorwaarden van de migratie ──────────────────────────────────────
-- Verwacht: één rij, alle kolommen `true`.
SELECT
  coalesce((SELECT md5(prosrc) = '067939e0c44a672c26ec8883717ef6d2' FROM pg_proc
            WHERE oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')), false)
                                                                                            AS pr2_toegepast,
  (SELECT count(*) = 12 FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (table_name, column_name) IN (
       ('ledger_postings', 'debit_amount'), ('ledger_postings', 'credit_amount'),
       ('purchase_invoices', 'amount_excl'), ('purchase_invoices', 'btw_amount'), ('purchase_invoices', 'amount_incl'),
       ('sales_invoices', 'amount_excl'), ('sales_invoices', 'btw_amount'), ('sales_invoices', 'amount_incl'),
       ('purchase_invoice_lines', 'amount_excl'), ('bank_transactions', 'amount'),
       ('bank_transactions', 'btw_percentage'), ('clients', 'btw_vrijgesteld')))      AS kolommen_aanwezig,
  NOT EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname IN ('ledger_postings_amounts_not_nan', 'purchase_invoices_amounts_not_nan',
                                'sales_invoices_amounts_not_nan', 'purchase_invoice_lines_amount_finite',
                                'bank_transactions_amount_not_nan'))                       AS constraintnamen_vrij,
  to_regprocedure('public.assert_posting_allowed(uuid,date)') IS NOT NULL
  AND to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NOT NULL             AS hulpfuncties_aanwezig;


-- ── PRE 2. De vijf functies: exact het beoordeelde lichaam ──────────────────
-- Verwacht: 5 rijen, `gelijk` overal `true`; `uitvoerrecht_exact` overal `true`.
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht,
       coalesce(md5(p.prosrc) = h.verwacht, false) AS gelijk,
       p.oid IS NOT NULL
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS uitvoerrecht_exact
FROM (VALUES
  ('post_purchase_invoice(uuid)',                '6366f052209d9a171f197de77eaf477a'),
  ('post_sales_invoice(uuid)',                   'cb467b35301239c3051c8b918662ea45'),
  ('post_bank_transaction(uuid)',                '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('bank_bulk_posting_candidates(uuid,integer)', '946bef45005d6e572a7565da6fc12cdb'),
  ('post_bank_transactions_bulk(uuid[])',        '1e5d90d98bf488dbdcbed483b72085ab')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || h.naam)
ORDER BY h.naam;


-- ── PRE 3. E-06: gecodeerde, ongeboekte bankregels zonder btw-percentage ────
-- Informatief. Deze regels boekten tot nu toe stil als 0%; na de migratie zijn
-- ze 'review_needed' en boeken ze pas na een keuze (ook 0 = "Geen BTW").
-- `al_geboekt_zonder_keuze`: historie — al als 0% geboekt zonder expliciete
-- keuze (de migratie verandert die boekingen niet).
SELECT
  coalesce(c.btw_vrijgesteld, false)                                                AS administratie_vrijgesteld,
  count(*) FILTER (WHERE m.bank_transaction_id IS NULL
                     AND t.match_status = 'handmatig_geboekt'
                     AND t.grootboekrekening_id IS NOT NULL
                     AND t.amount <> 0
                     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations al
                                     WHERE al.bank_transaction_id = t.id))           AS wordt_review_needed,
  count(*) FILTER (WHERE m.bank_transaction_id IS NULL)                             AS ongeboekt_zonder_pct_totaal,
  count(*) FILTER (WHERE m.bank_transaction_id IS NOT NULL)                         AS al_geboekt_zonder_keuze,
  count(DISTINCT t.client_id)                                                       AS administraties
FROM public.bank_transactions t
LEFT JOIN public.clients c ON c.id = t.client_id
LEFT JOIN public.bank_transaction_postings m ON m.bank_transaction_id = t.id
WHERE t.btw_percentage IS NULL
GROUP BY 1
ORDER BY 1;


-- ── PRE 4. F1c-N1 en A3-16: inkoopfacturen die na de migratie niet boeken ───
-- Informatief. `vrijgesteld_met_btw_*`: btw > 0 bij een vrijgestelde
-- administratie (weigering 0A000 tot besluit D4); `_geboekt` is historie:
-- al geboekt mét voorbelasting. `fracties_van_een_cent`: ongeboekte facturen
-- met een regel in fracties van een cent (weigering 22023; opnieuw opslaan in
-- de werkbank rondt de regels op hele centen af).
SELECT
  count(*) FILTER (WHERE c.btw_vrijgesteld AND coalesce(i.btw_amount, 0) > 0 AND m.purchase_invoice_id IS NULL
                     AND i.status IN ('gecontroleerd', 'betaald', 'geexporteerd'))  AS vrijgesteld_met_btw_boekklaar,
  count(*) FILTER (WHERE c.btw_vrijgesteld AND coalesce(i.btw_amount, 0) > 0 AND m.purchase_invoice_id IS NULL
                     AND i.status NOT IN ('gecontroleerd', 'betaald', 'geexporteerd')) AS vrijgesteld_met_btw_in_controle,
  count(*) FILTER (WHERE c.btw_vrijgesteld AND coalesce(i.btw_amount, 0) > 0 AND m.purchase_invoice_id IS NOT NULL)
                                                                                    AS vrijgesteld_met_btw_geboekt,
  count(*) FILTER (WHERE m.purchase_invoice_id IS NULL AND EXISTS (
                     SELECT 1 FROM public.purchase_invoice_lines l
                     WHERE l.purchase_invoice_id = i.id AND l.amount_excl <> round(l.amount_excl, 2)))
                                                                                    AS fracties_van_een_cent
FROM public.purchase_invoices i
LEFT JOIN public.clients c ON c.id = i.client_id
LEFT JOIN public.purchase_invoice_postings m ON m.purchase_invoice_id = i.id;


-- ── PRE 5. Q7: NaN (en ±oneindig) in de bedragkolommen ──────────────────────
-- Informatief, maar beslissend voor de LATERE VALIDATE: alleen bij overal 0
-- kan `ALTER TABLE … VALIDATE CONSTRAINT …` (zie de kop van de migratie)
-- slagen. In PostgreSQL is 'NaN' = 'NaN' waar; deze telling vindt NaN dus wel.
-- Een rij hier kan na de migratie niet meer worden bijgewerkt zonder dat het
-- bedrag wordt hersteld.
SELECT
  (SELECT count(*) FROM public.ledger_postings
   WHERE debit_amount = 'NaN'::numeric OR credit_amount = 'NaN'::numeric)          AS ledger_postings_nan,
  (SELECT count(*) FROM public.purchase_invoices
   WHERE amount_excl = 'NaN'::numeric OR btw_amount = 'NaN'::numeric OR amount_incl = 'NaN'::numeric)
                                                                                    AS purchase_invoices_nan,
  (SELECT count(*) FROM public.sales_invoices
   WHERE amount_excl = 'NaN'::numeric OR btw_amount = 'NaN'::numeric OR amount_incl = 'NaN'::numeric)
                                                                                    AS sales_invoices_nan,
  (SELECT count(*) FROM public.purchase_invoice_lines
   WHERE amount_excl IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) AS purchase_invoice_lines_niet_eindig,
  (SELECT count(*) FROM public.bank_transactions WHERE amount = 'NaN'::numeric)     AS bank_transactions_nan;


-- ── PRE 6. Vingerafdruk: catalogus en gegevens (bewaren voor POST 4) ────────
-- Verwacht ná de migratie (POST 4): alle vier kolommen gelijk aan hier — de
-- migratie wijzigt geen andere functie, trigger, RULE of policy en geen rij.
SELECT
  (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text))
   FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid NOT IN (to_regprocedure('public.post_purchase_invoice(uuid)'),
                       to_regprocedure('public.post_sales_invoice(uuid)'),
                       to_regprocedure('public.post_bank_transaction(uuid)'),
                       to_regprocedure('public.bank_bulk_posting_candidates(uuid,integer)'),
                       to_regprocedure('public.post_bank_transactions_bulk(uuid[])')))  AS andere_functies,
  concat_ws('/',
    (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal
       AND t.tgrelid IN ('public.ledger_postings'::regclass, 'public.purchase_invoices'::regclass,
                         'public.sales_invoices'::regclass, 'public.purchase_invoice_lines'::regclass,
                         'public.bank_transactions'::regclass)),
    (SELECT count(*) FROM pg_rules r WHERE r.schemaname = 'public'),
    (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public'))             AS triggers_rules_policies,
  concat_ws('/', (SELECT count(*) FROM public.ledger_postings), (SELECT count(*) FROM public.purchase_invoices),
                 (SELECT count(*) FROM public.sales_invoices), (SELECT count(*) FROM public.purchase_invoice_lines),
                 (SELECT count(*) FROM public.bank_transactions))                    AS rijen,
  md5(concat_ws('/',
    (SELECT sum(debit_amount) || ':' || sum(credit_amount) FROM public.ledger_postings),
    (SELECT sum(amount_excl) || ':' || sum(btw_amount) || ':' || sum(amount_incl) || ':' || count(btw_percentage) FROM public.purchase_invoices),
    (SELECT sum(amount_excl) || ':' || sum(btw_amount) || ':' || sum(amount_incl) || ':' || count(btw_percentage) FROM public.sales_invoices),
    (SELECT sum(amount_excl) || ':' || count(btw_percentage) FROM public.purchase_invoice_lines),
    (SELECT sum(amount) || ':' || count(btw_percentage) || ':' || count(grootboekrekening_id) FROM public.bank_transactions)))
                                                                                    AS bedragen;
