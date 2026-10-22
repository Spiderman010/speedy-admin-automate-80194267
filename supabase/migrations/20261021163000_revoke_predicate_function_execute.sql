-- ═════════════════════════════════════════════════════════════════════════════
-- B1-05 — DE DRIE SCOPEPREDICATEN ZIJN GEEN API
--
-- HET PROBLEEM
--   posting_account_ok(uuid, uuid, uuid)   20260914120000
--   posting_client_org_ok(uuid, uuid)      20260914120000
--   ledger_link_org_ok(uuid, uuid)         20260904120000
--   zijn SECURITY DEFINER-predicaten voor de triggers en schrijvers, maar
--   kregen alleen `REVOKE ALL … FROM PUBLIC`. Supabase geeft bij het aanmaken
--   van een functie in `public` EXECUTE rechtstreeks aan anon, authenticated en
--   service_role (pg_default_acl); die toekenningen staan er nog. Daardoor kan
--   iedereen ze via /rpc aanroepen en met geraden uuid's bevestigen dat een
--   rekening of administratie in een organisatie bestaat (nulmeting B1-05,
--   herhaald door F2). Dezelfde fout herstelde 20260929120000 al voor
--   lock_ledger_client, ledger_client_lock_key en posting_allowed.
--
-- WIE ROEPT ZE AAN
--   Uitsluitend SECURITY DEFINER-functies (triggers en schrijvers) van
--   dezelfde eigenaar; geen RLS-policy, view, CHECK, default, index of app-code
--   en geen edge function. De eigenaar behoudt EXECUTE, dus de definer-
--   aanroepers werken ongewijzigd. Sectie 0 controleert dat in de catalogus en
--   stopt de migratie als de werkelijkheid afwijkt (bijv. een policy in
--   productie die ze wél aanroept): dan zou intrekken RLS breken.
--
-- WAT DEZE MIGRATIE NIET DOET
--   Geen functielichaam, eigenaar, SECURITY-modus, search_path of
--   volatiliteit; geen ALTER DEFAULT PRIVILEGES; geen tabel of policy.
--
-- IDEMPOTENT: een tweede REVOKE verandert niets.
--
-- ROLLBACK (herstelt het orakel; alleen bij nood):
--   GRANT EXECUTE ON FUNCTION public.posting_account_ok(uuid, uuid, uuid) TO anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.posting_client_org_ok(uuid, uuid)     TO anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.ledger_link_org_ok(uuid, uuid)        TO anon, authenticated, service_role;
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten en veiligheidstoets: fail closed ───────────────────────────

DO $migratie$
DECLARE
  v_targets oid[];
  v_owner   oid;
  v_bad     text;
BEGIN
  IF to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.posting_client_org_ok(uuid,uuid)') IS NULL
     OR to_regprocedure('public.ledger_link_org_ok(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'B1-05 vereist posting_account_ok, posting_client_org_ok en ledger_link_org_ok';
  END IF;

  v_targets := ARRAY[
    to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)')::oid,
    to_regprocedure('public.posting_client_org_ok(uuid,uuid)')::oid,
    to_regprocedure('public.ledger_link_org_ok(uuid,uuid)')::oid
  ];

  -- Alle drie van dezelfde eigenaar (dat is de rol die EXECUTE houdt).
  SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_targets[1];
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = ANY (v_targets) AND proowner <> v_owner) THEN
    RAISE EXCEPTION 'B1-05: de drie predicaten hebben niet dezelfde eigenaar; intrekken niet beoordeeld';
  END IF;

  -- a) Geen policy, view, constraint, default, index, trigger-WHEN of
  --    SQL-standaardfunctie die afhangt van een predicaat (pg_depend legt die
  --    afhankelijkheden vast; plpgsql-lichamen niet, die toetst b).
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
  INTO v_bad
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass
    AND d.refobjid = ANY (v_targets)
    AND d.deptype = 'n'
    AND NOT (d.classid = 'pg_proc'::regclass AND EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = d.objid AND p.prosecdef AND p.proowner = v_owner));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'B1-05: EXECUTE intrekken zou breken; afhankelijk: %', v_bad;
  END IF;

  -- b) Geen functie die een predicaat noemt en NIET als dezelfde eigenaar
  --    (SECURITY DEFINER) draait: zo'n functie voert de aanroep uit met de
  --    rechten van de aanroeper.
  SELECT string_agg(p.oid::regprocedure::text, '; ' ORDER BY p.oid::regprocedure::text)
  INTO v_bad
  FROM pg_proc p
  WHERE p.oid <> ALL (v_targets)
    AND p.prosrc ~ '(posting_account_ok|posting_client_org_ok|ledger_link_org_ok)'
    AND NOT (p.prosecdef AND p.proowner = v_owner);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'B1-05: EXECUTE intrekken zou deze functies breken: %', v_bad;
  END IF;
END
$migratie$;

-- ── 1. Alleen de eigenaar ────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.posting_account_ok(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.posting_client_org_ok(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.ledger_link_org_ok(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
