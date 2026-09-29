-- ═════════════════════════════════════════════════════════════════════════════
-- ACL-HARDENING — INTERNE HULPFUNCTIES ZIJN ALLEEN VOOR DE EIGENAAR
--
-- HET PROBLEEM
--   Drie interne hulpfuncties werden aangemaakt met alleen
--   `REVOKE ALL … FROM PUBLIC`:
--
--     lock_ledger_client(uuid)        20260919120000  advisory lock per administratie
--     ledger_client_lock_key(uuid)    20260919120000  de sleutel van die lock
--     posting_allowed(uuid, date)     20260927120000  SECURITY DEFINER-toets op de blokkade
--
--   Supabase geeft via zijn standaard-functierechten (pg_default_acl) bij het
--   AANMAKEN van elke functie in `public` EXECUTE rechtstreeks aan anon,
--   authenticated en service_role. Een REVOKE van PUBLIC haalt die directe
--   toekenningen niet weg. De productie-audit van 2026-09-28 bevestigt het:
--   anon en authenticated kunnen `lock_ledger_client` en `posting_allowed`
--   rechtstreeks via /rpc aanroepen.
--
--   Gevolg, zonder dit te dramatiseren: met een bekende client-uuid kan een
--   aanroeper de grootboekgrendel van die administratie kort vasthouden, en
--   `posting_allowed` (SECURITY DEFINER) verraadt of een administratie bestaat
--   en of zij op een datum geblokkeerd is. Beide horen alleen door de eigen
--   SECURITY DEFINER-schrijvers te worden aangeroepen.
--
--   `post_purchase_invoice(uuid)` is een ECHT toegangspunt (de app roept hem
--   aan via usePurchaseInvoicePosting), maar werd in 20260915140000 alleen van
--   PUBLIC ontnomen. Zijn zes gedateerde broers staan al op "alleen
--   authenticated"; deze migratie trekt hem daarmee gelijk.
--
-- WIE ROEPT DEZE HULPFUNCTIES AAN — ALLEMAAL SECURITY DEFINER
--   lock_ledger_client     ← post_opening_balance, reverse_posting_group,
--                            declare_opening_balance_nil, close_fiscal_year,
--                            set_posting_lock, assert_posting_allowed,
--                            lock_ledger_client_for_posting (trigger)
--   ledger_client_lock_key ← lock_ledger_client (SECURITY INVOKER, maar altijd
--                            uitgevoerd binnen een van de DEFINER-aanroepers
--                            hierboven, dus als de eigenaar)
--   posting_allowed        ← assert_posting_allowed
--   Geen policy, view, app-code of edge function roept een van de drie direct
--   aan. De eigenaar behoudt EXECUTE: een REVOKE van genoemde rollen raakt de
--   eigen toekenning van de eigenaar niet.
--
-- WAT DEZE MIGRATIE NIET DOET
--   Geen functielichaam, geen eigenaar, geen SECURITY DEFINER/INVOKER, geen
--   search_path, geen volatiliteit, geen tabelrecht, geen policy. Ook
--   `ALTER DEFAULT PRIVILEGES` blijft ongemoeid: dat raakt elke toekomstige
--   functie, ook die van de Lovable-tooling, en hoort niet in een gerichte
--   hardening. `assert_posting_allowed` staat al op alleen-eigenaar
--   (20260928120000) en wordt hier niet aangeraakt.
--
-- IDEMPOTENT: een tweede toepassing verandert niets.
--
-- ROLLBACK (handmatig; herstelt de blootstelling, dus alleen bij nood):
--   GRANT EXECUTE ON FUNCTION public.lock_ledger_client(uuid)     TO anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.ledger_client_lock_key(uuid) TO anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.posting_allowed(uuid, date)  TO anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid)  TO anon, service_role;
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed als een doelfunctie ontbreekt ────────────────

DO $migratie$
BEGIN
  IF to_regprocedure('public.lock_ledger_client(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ACL-hardening vereist public.lock_ledger_client(uuid) (20260919120000)';
  END IF;
  IF to_regprocedure('public.ledger_client_lock_key(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ACL-hardening vereist public.ledger_client_lock_key(uuid) (20260919120000)';
  END IF;
  IF to_regprocedure('public.posting_allowed(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'ACL-hardening vereist public.posting_allowed(uuid,date) (20260927120000)';
  END IF;
  IF to_regprocedure('public.assert_posting_allowed(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'ACL-hardening vereist public.assert_posting_allowed(uuid,date) (20260928120000)';
  END IF;
  IF to_regprocedure('public.post_purchase_invoice(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ACL-hardening vereist public.post_purchase_invoice(uuid) (20260915140000)';
  END IF;
END
$migratie$;

-- ── 1. Interne hulpfuncties: alleen de eigenaar ─────────────────────────────

REVOKE ALL ON FUNCTION public.lock_ledger_client(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.ledger_client_lock_key(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.posting_allowed(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. post_purchase_invoice: toegangspunt voor authenticated, verder niemand ─
--
--    authenticated wordt NIET eerst ingetrokken: er is dus geen moment waarop
--    de app het recht mist. De GRANT legt het bedoelde recht expliciet vast.

REVOKE ALL ON FUNCTION public.post_purchase_invoice(uuid)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid) TO authenticated;
