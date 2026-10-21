-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261021180000_add_atomic_bank_payment_link.sql (P5a)
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (zie de controlelijst in PROJECT_MAP.md). Nooit het
-- persoonlijke Supabase-dashboard, nooit een andere projectref.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit en bewaar
-- de uitkomst van PRE 2 en PRE 6: POST 4 en POST 2 moeten er gelijk aan zijn.
-- Het harnas (supabase/tests/bank-payment-allocation/) draait dit bestand
-- letterlijk in een alleen-lezen transactie.
--
-- STOP (niet uitvoeren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1 ergens `false` geeft (vereiste ontbreekt, P5a staat er al half, of
--     prevent_posted_sales_invoice_mutation() is niet de beoordeelde versie);
--   • PRE 5 `stop = true` geeft: een koppeling op een direct geboekte
--     transactie MET geboekte aflettering (een bestaande dubbele boeking —
--     hoort bij PR 0 en moet eerst worden beoordeeld).
-- GEEN STOP, wel doorgeven aan de eigenaar: de tellingen in PRE 3, PRE 4 en
-- PRE 5. Dat zijn de rijen die de betaalschrijver na P5a fail-closed weigert
-- ("herstel nodig"). P5a wijzigt ze niet; zie herstelvoorstel.md.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, P5a nog niet ─────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regclass('public.bank_transaction_allocations') IS NOT NULL
    AND to_regclass('public.bank_match_rejections') IS NOT NULL
    AND to_regclass('public.bank_allocation_postings') IS NOT NULL
    AND to_regclass('public.bank_transaction_postings') IS NOT NULL
    AND to_regclass('public.sales_invoice_postings') IS NOT NULL               AS tabellen,
  to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NOT NULL
    AND to_regprocedure('public.role_rank(public.app_role)') IS NOT NULL
    AND to_regprocedure('public.post_bank_allocation(uuid)') IS NOT NULL       AS rollen_en_schrijver,
  to_regprocedure('public.enforce_bank_match_rejection_scope()') IS NOT NULL   AS migratie_20261010120000,
  to_regprocedure('public.enforce_bank_allocation_not_directly_posted()') IS NOT NULL AS migratie_20261017120000,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.prevent_posted_sales_invoice_mutation()'))
    = 'aad983904aba6df9519d332389427b4e'                                       AS verkooptrigger_beoordeeld,
  to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NULL
    AND to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)') IS NULL
    AND to_regclass('public.bank_payment_requests') IS NULL
    AND to_regclass('public.bank_payment_events') IS NULL                      AS p5a_nog_niet,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bank_transaction_allocations'
                AND column_name = 'created_by')                                AS created_by_nog_niet,
  current_setting('server_version_num')::int >= 140000                        AS postgres_14_of_hoger;


-- ── PRE 2. Catalogus die P5a NIET mag raken (bewaren; POST 4 vergelijkt) ────
-- Eén rij met vier vingerafdrukken.
SELECT
  md5((SELECT string_agg(format('%s:%s:%s:%s', t.tgname, p.proname, md5(p.prosrc), t.tgenabled), ',' ORDER BY t.tgname)
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal))         AS triggers_bank_transactions,
  md5((SELECT string_agg(format('%s:%s:%s:%s:%s', tablename, policyname, cmd, qual, with_check), ',' ORDER BY tablename, policyname)
       FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices',
                           'sales_invoices', 'bank_match_rejections')))                       AS policies,
  md5((SELECT string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), ',' ORDER BY 1)
       FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('bank_transactions', 'bank_transaction_allocations', 'purchase_invoices',
                           'sales_invoices', 'bank_match_rejections')))                       AS tabelrechten,
  md5((SELECT string_agg(format('%s:%s', p.proname, md5(p.prosrc)), ',' ORDER BY p.proname)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('post_bank_allocation', 'post_bank_transaction', 'post_sales_invoice',
                           'post_purchase_invoice', 'reverse_posting_group',
                           'enforce_bank_allocation_not_directly_posted', 'enforce_bank_match_rejection_scope',
                           'prevent_posted_bank_allocation_mutation', 'prevent_posted_purchase_invoice_mutation'))) AS schrijvers_en_guards;


-- ── PRE 3. Facturen die de betaalschrijver zal weigeren ("herstel nodig") ───
-- Eén rij per soort en categorie (alleen categorieën met aantal > 0).
WITH alloc AS (
  SELECT invoice_id, invoice_type, sum(amount) AS som, count(*) AS n
  FROM public.bank_transaction_allocations GROUP BY invoice_id, invoice_type
), inv AS (
  SELECT 'inkoop'::text AS soort, p.id, p.amount_incl AS incl, p.remaining_amount AS rest, p.status
  FROM public.purchase_invoices p
  UNION ALL
  SELECT 'verkoop', s.id, s.amount_incl, s.remaining_amount, s.status FROM public.sales_invoices s
), st AS (
  SELECT i.*, coalesce(a.som, 0) AS som,
         EXISTS (SELECT 1 FROM public.bank_transaction_allocations x
                 WHERE x.invoice_id = i.id AND x.invoice_type <> i.soort) AS ander_type
  FROM inv i LEFT JOIN alloc a ON a.invoice_id = i.id AND a.invoice_type = i.soort
)
SELECT soort, categorie, count(*) AS aantal
FROM (
  SELECT soort,
         CASE
           WHEN ander_type                                  THEN 'Q3a koppeling van de andere soort op dit factuur-id'
           WHEN som > 0 AND incl IS NULL                     THEN 'Q3b koppelingen, maar geen bedrag inclusief btw'
           WHEN som > coalesce(incl, 0) AND incl IS NOT NULL THEN 'Q3c over-allocatie (som koppelingen > factuurbedrag)'
           WHEN status = 'betaald' AND som = 0               THEN 'Q3d betaald zonder enige koppeling (oude match)'
           WHEN status = 'betaald' AND som <> incl           THEN 'Q3e betaald, maar koppelingen dekken het bedrag niet'
           WHEN rest IS NULL AND som > 0                     THEN 'Q3f restant leeg terwijl er koppelingen zijn'
           WHEN rest IS NOT NULL AND incl IS NULL AND som = 0 THEN 'Q3g restant zonder bedrag inclusief btw (o.a. OCR 0)'
           WHEN rest IS NOT NULL AND incl IS NOT NULL AND rest <> incl - som THEN 'Q3h restant wijkt af van factuurbedrag − koppelingen'
           WHEN soort = 'inkoop' AND status = 'betaald'      THEN 'Q3i inkoop met de oude status betaald (ontkoppelen geweigerd)'
         END AS categorie
  FROM st
) x
WHERE categorie IS NOT NULL
GROUP BY soort, categorie
ORDER BY soort, categorie;


-- ── PRE 4. Banktransacties die de betaalschrijver zal weigeren ──────────────
SELECT categorie, count(*) AS aantal
FROM (
  SELECT CASE
           WHEN bt.match_status = 'gematcht' AND a.n IS NULL AND bt.matched_invoice_id IS NULL
             THEN 'Q4a gematcht zonder factuur en zonder koppeling'
           WHEN bt.match_status = 'gematcht' AND a.n IS NULL
             THEN 'Q4b gematcht via een oude match zonder koppeling (alleen die match kan worden vastgelegd)'
           WHEN bt.match_status = 'gematcht' AND bt.matched_invoice_id IS NOT NULL AND NOT a.primair
             THEN 'Q4c gematcht, maar de primaire factuur heeft geen koppeling'
           WHEN bt.match_status = 'handmatig_geboekt' AND a.n > 0
             THEN 'Q4d gecodeerd én gekoppeld'
           WHEN bt.match_status IN ('niet_gematcht', 'suggestie') AND a.n > 0
             THEN 'Q4e koppelingen, maar niet gematcht (wordt bij de volgende koppeling gematcht)'
           WHEN a.som > abs(bt.amount)
             THEN 'Q4f over-allocatie (som koppelingen > transactiebedrag)'
         END AS categorie
  FROM public.bank_transactions bt
  LEFT JOIN (SELECT x.bank_transaction_id, count(*) AS n, sum(x.amount) AS som,
                    bool_or(x.invoice_id = t.matched_invoice_id) AS primair
             FROM public.bank_transaction_allocations x
             JOIN public.bank_transactions t ON t.id = x.bank_transaction_id
             GROUP BY x.bank_transaction_id) a ON a.bank_transaction_id = bt.id
) x
WHERE categorie IS NOT NULL
GROUP BY categorie
ORDER BY categorie;


-- ── PRE 5. Koppelingen die het vangnet bij een volgende wijziging weigert ───
-- Verwacht: één rij; `stop` moet false zijn (zie de kop).
SELECT
  count(*) FILTER (WHERE inv_id IS NULL)                                       AS q5a_factuur_bestaat_niet,
  count(*) FILTER (WHERE inv_id IS NOT NULL AND (inv_client IS DISTINCT FROM a.client_id
                                                 OR inv_org IS DISTINCT FROM a.organization_id)) AS q5b_andere_administratie,
  count(*) FILTER (WHERE (a.invoice_type = 'verkoop' AND bt.amount <= 0)
                      OR (a.invoice_type = 'inkoop' AND bt.amount >= 0))       AS q5c_verkeerde_richting,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.bank_match_rejections r
                                 WHERE r.bank_transaction_id = a.bank_transaction_id
                                   AND r.invoice_type = a.invoice_type AND r.invoice_id = a.invoice_id)) AS q5d_afgewezen_paar,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                                 WHERE m.bank_transaction_id = a.bank_transaction_id)) AS q5e_op_direct_geboekte_transactie,
  EXISTS (SELECT 1 FROM public.bank_transaction_postings m
          JOIN public.bank_allocation_postings p ON p.bank_transaction_id = m.bank_transaction_id) AS stop
FROM public.bank_transaction_allocations a
JOIN public.bank_transactions bt ON bt.id = a.bank_transaction_id
LEFT JOIN LATERAL (
  SELECT p.id AS inv_id, p.client_id AS inv_client, p.organization_id AS inv_org
  FROM public.purchase_invoices p WHERE a.invoice_type = 'inkoop' AND p.id = a.invoice_id
  UNION ALL
  SELECT s.id, s.client_id, s.organization_id
  FROM public.sales_invoices s WHERE a.invoice_type = 'verkoop' AND s.id = a.invoice_id
) i ON true;


-- ── PRE 6. Vingerafdruk van de data (bewaren; POST 2 vergelijkt) ────────────
SELECT
  (SELECT count(*) FROM public.bank_transaction_allocations)                   AS koppelingen,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', id, bank_transaction_id, invoice_type, invoice_id,
                                          client_id, organization_id, amount, user_id), ',' ORDER BY id), '')
       FROM public.bank_transaction_allocations))                             AS koppelingen_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s', id, remaining_amount, status), ',' ORDER BY id), '')
       FROM public.purchase_invoices))                                         AS inkoop_restant_status_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s', id, remaining_amount, status), ',' ORDER BY id), '')
       FROM public.sales_invoices))                                            AS verkoop_restant_status_md5,
  md5((SELECT coalesce(string_agg(format('%s|%s|%s|%s', id, match_status, matched_invoice_id, match_confidence), ',' ORDER BY id), '')
       FROM public.bank_transactions))                                         AS bank_match_md5;
