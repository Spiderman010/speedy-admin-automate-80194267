-- ═════════════════════════════════════════════════════════════════════════════
-- LEGACY journal_entries ("SNELLE INVOER") WORDT ALLEEN-LEZEN
--
-- WAAROM
--   `ledger_postings` is de enige financiële waarheid. `journal_entries` is één
--   bedrag op één rekening, zonder tegenrekening, debet/credit, jaarafsluiting
--   of boekingsblokkade, en telt nergens mee in het grootboek. Sinds PR #201
--   schrijft de app er niet meer naar: /boekingen is alleen-lezen en nieuwe
--   boekingen lopen via het memoriaal en `post_manual_journal()`.
--
--   De database stond nog wel schrijven toe: RLS-policies voor INSERT/UPDATE
--   (assistent) en DELETE (accountant), plus Supabase's standaard-tabelrechten
--   (ALL voor anon, authenticated en service_role). Deze migratie sluit dat
--   schrijfoppervlak op BEIDE lagen:
--
--     1. rechten   — REVOKE ALL, daarna alleen SELECT terug voor authenticated
--                    en service_role. anon krijgt niets (had via RLS toch geen
--                    rijen). REVOKE ALL in plaats van een opsomming: dan glipt
--                    ook een toekomstig privilege (bv. MAINTAIN) er niet langs.
--     2. policies  — de drie schrijfpolicies verdwijnen. Komt er ooit per
--                    ongeluk weer een schrijfrecht bij, dan weigert RLS nog
--                    steeds (geen policy = geen toegang). De SELECT-policy
--                    blijft exact zoals zij is.
--
-- WAT BLIJFT WERKEN
--   Lezen voor de alleen-lezen pagina, Bronmutaties, Rapportages en de
--   SnelStart-export — allemaal SELECT via `useJournalEntries`, als
--   authenticated, door de ongewijzigde `role_journal_entries_select`
--   (has_min_role read_only). Tenant-isolatie is dus ongewijzigd.
--
-- WAT NIET WORDT AANGERAAKT
--   Geen rij, geen kolom, geen constraint, geen FK, geen index, geen trigger,
--   geen functie, geen eigenaar, RLS blijft AAN. Geen enkele databasefunctie
--   schrijft `journal_entries`; de triggers op de tabel vuren alleen bij een
--   schrijfactie. FK-acties (clients/auth.users ON DELETE CASCADE,
--   grootboekrekeningen ON DELETE SET NULL) draaien met de rechten van de
--   tabeleigenaar en blijven dus werken zoals nu.
--
-- IDEMPOTENT: een tweede toepassing verandert niets.
--
-- ROLLBACK (handmatig; heropent het schrijfoppervlak) — het exacte omgekeerde.
--   Uitgangstoestand vóór deze migratie (bewezen in het harnas, V1, en gelijk
--   aan Supabase's standaard): ALL voor anon, authenticated en service_role,
--   GEEN toekenning aan PUBLIC, plus de drie schrijfpolicies uit
--   20260613001452 (blok 3A.10). Toont de productie-precheck (rij 10) een
--   andere ACL, herstel dan díe. De SELECT-policy is nooit weggehaald en
--   blijft dus buiten de rollback. Het blok is letterlijk uitvoerbaar (haal
--   alleen het "-- " voor elke regel weg) en idempotent.
-- ROLLBACK-BEGIN
--   GRANT ALL ON TABLE public.journal_entries TO anon, authenticated, service_role;
--   DROP POLICY IF EXISTS role_journal_entries_insert ON public.journal_entries;
--   CREATE POLICY role_journal_entries_insert ON public.journal_entries FOR INSERT TO authenticated
--     WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
--   DROP POLICY IF EXISTS role_journal_entries_update ON public.journal_entries;
--   CREATE POLICY role_journal_entries_update ON public.journal_entries FOR UPDATE TO authenticated
--     USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
--     WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
--   DROP POLICY IF EXISTS role_journal_entries_delete ON public.journal_entries;
--   CREATE POLICY role_journal_entries_delete ON public.journal_entries FOR DELETE TO authenticated
--     USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.journal_entries') IS NULL THEN
    RAISE EXCEPTION 'journal_entries alleen-lezen: public.journal_entries ontbreekt';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.journal_entries'::regclass) THEN
    RAISE EXCEPTION 'journal_entries alleen-lezen: RLS staat UIT op public.journal_entries; eerst onderzoeken';
  END IF;
  -- Het leespad moet blijven werken; zonder deze policy ziet authenticated niets.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'journal_entries'
      AND policyname = 'role_journal_entries_select' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'journal_entries alleen-lezen: role_journal_entries_select ontbreekt; het leespad zou breken';
  END IF;
END
$migratie$;

-- ── 1. Rechten: alleen lezen ────────────────────────────────────────────────

REVOKE ALL ON TABLE public.journal_entries FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.journal_entries TO authenticated, service_role;

-- ── 2. Policies: de schrijfpolicies zijn vervallen ──────────────────────────

DROP POLICY IF EXISTS role_journal_entries_insert ON public.journal_entries;
DROP POLICY IF EXISTS role_journal_entries_update ON public.journal_entries;
DROP POLICY IF EXISTS role_journal_entries_delete ON public.journal_entries;
