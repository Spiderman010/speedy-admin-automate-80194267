-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Replays, as the exact statements the repository migrations contain, every
-- later change production carries on public.grootboekrekeningen after its
-- creation (20260412222343), so the table under test has the production
-- column set, uniqueness, index, role policies and rebind trigger before the
-- migration under test is applied:
--   20260412225236 step 1 + 3 + 4:  client_id nullable, global UNIQUE (nummer)
--   20260531223619 line 17 + 31:    organization_id column + its index
--   20260613001452 §3A.11:          the four role_* policies replace the
--                                   original per-user policy; rebind trigger
-- plus the Supabase default privilege on public tables for the API roles.
-- (20260412225236 step 2, a data de-duplication, is not replayed: the proof
-- inserts its own rows afterwards.)

-- ── 20260412225236 ──────────────────────────────────────────────────────────
ALTER TABLE public.grootboekrekeningen
  ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.grootboekrekeningen
  DROP CONSTRAINT IF EXISTS grootboekrekeningen_nummer_client_id_key;

ALTER TABLE public.grootboekrekeningen
  ADD CONSTRAINT grootboekrekeningen_nummer_key UNIQUE (nummer);

-- ── 20260531223619 ──────────────────────────────────────────────────────────
ALTER TABLE public.grootboekrekeningen            ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS idx_grootboekrekeningen_org_id         ON public.grootboekrekeningen(organization_id);

-- ── 20260613001452 §3A.11 ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own grootboekrekeningen" ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_select ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_insert ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_update ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_delete ON public.grootboekrekeningen;
CREATE POLICY role_grootboekrekeningen_select ON public.grootboekrekeningen FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_grootboekrekeningen_insert ON public.grootboekrekeningen FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'accountant'));
CREATE POLICY role_grootboekrekeningen_update ON public.grootboekrekeningen FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'accountant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'accountant'));
CREATE POLICY role_grootboekrekeningen_delete ON public.grootboekrekeningen FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'owner'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.grootboekrekeningen;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.grootboekrekeningen
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- ── Supabase default privilege ──────────────────────────────────────────────
GRANT ALL ON public.grootboekrekeningen TO anon, authenticated, service_role;
