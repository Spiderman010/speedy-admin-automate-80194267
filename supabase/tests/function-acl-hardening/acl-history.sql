-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- De inkoop-, verkoop- en afletterschrijver hebben brontabellen die dit
-- harnas niet opzet; hun oorspronkelijke migraties (20260915140000,
-- 20260915160000, 20260917120000) draaien hier dus niet. De functies zelf
-- bestaan wél: 20260928120000 maakt ze met CREATE OR REPLACE aan.
--
-- Wat hier ontbreekt is alleen hun RECHTENGESCHIEDENIS. CREATE OR REPLACE
-- laat rechten staan, dus in productie dragen deze drie nog de ACL die hun
-- eerste migratie zette. Hieronder staan precies die regels, letterlijk
-- overgenomen — zodat het harnas `post_purchase_invoice` in dezelfde half
-- dichtgezette toestand heeft als productie.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- 20260915140000_add_purchase_ledger_posting.sql:428-429
REVOKE ALL ON FUNCTION public.post_purchase_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid) TO authenticated;

-- 20260915160000_add_sales_ledger_posting.sql:458-460
REVOKE ALL ON FUNCTION public.post_sales_invoice(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_sales_invoice(uuid) TO authenticated;

-- 20260917120000_add_bank_settlement_posting.sql:692-694
REVOKE ALL ON FUNCTION public.post_bank_allocation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_allocation(uuid) TO authenticated;
