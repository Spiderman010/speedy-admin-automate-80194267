-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- `journal_entries` is aangemaakt in de grote Lovable-basismigratie
-- 20260411182021, die niet op de gedeelde bootstrap past. Hier staat de tabel
-- precies zoals de migratieketen haar achterlaat, op het deel dat run-proof.sh
-- daarna ÉCHT toepast na:
--
--   20260411182021  CREATE TABLE (kolommen, CHECK, FK's), RLS aan,
--                   update_journal_entries_updated_at
--   20260531223619  organization_id
--   20260603230656  set_organization_id_trigger (BEFORE INSERT)
--
-- Echt toegepast door run-proof.sh (niet nagebouwd):
--   20260719201000  grootboekrekening_id + FK (de migratie zelf)
--   20260613001452  het blok "3A.10 journal_entries": de vier role-policies en
--                   prevent_org_user_rebind_trg — letterlijk uit het bestand
--                   geknipt.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- De verouderde rekeningtabel waar ledger_account_id nog naar wijst.
CREATE TABLE IF NOT EXISTS public.ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.journal_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL,
  btw_percentage NUMERIC(5,2) DEFAULT 21,
  btw_amount NUMERIC(12,2),
  ledger_account_id UUID REFERENCES public.ledger_accounts(id),
  ledger_account_text TEXT,
  invoice_number TEXT,
  entry_type TEXT NOT NULL DEFAULT 'handmatig' CHECK (entry_type IN ('inkoop','verkoop','bank','handmatig')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER update_journal_entries_updated_at BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_journal_entries_client ON public.journal_entries(client_id);

ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id ON public.journal_entries(organization_id);

CREATE TRIGGER set_organization_id_trigger BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_organization_id();
