-- ═════════════════════════════════════════════════════════════════════════════
-- BETALINGEN — ATOMAIRE KOPPELING VAN BANKTRANSACTIE EN FACTUUR (P5a)
--
-- WAAROM
--   Een betaling koppelen raakt vier dingen: de koppelingsrij
--   (bank_transaction_allocations), het openstaande bedrag van de factuur
--   (remaining_amount), bij verkoop de status `betaald`, en de matchvelden van
--   de banktransactie. Tot nu toe schreef de app die vier los, in drie tot vier
--   aparte verzoeken, in wisselende volgorde, met een restbedrag uit de
--   browsercache en een upsert die een bestaande koppeling overschreef. Een
--   fout halverwege liet een half resultaat achter; twee gelijktijdige
--   koppelingen konden samen meer dan het bedrag toewijzen. De database kende
--   geen enkele schrijver en geen enkele invariant voor het openstaande bedrag.
--
-- BESLUIT D1 ("de database leidt af", eigenaar)
--   Betaalstatus en openstaand bedrag veranderen alleen nog via twee
--   gecontroleerde, atomaire functies:
--     • public.link_bank_payment(T, soort, factuur, bedrag, request_id)
--     • public.unlink_bank_payment(T, request_id, koppeling?)
--   Elk schrijft in één transactie: de koppeling, het openstaande bedrag
--   (factuurbedrag − som van de koppelingen, exacte NUMERIC), bij verkoop
--   `betaald` uitsluitend bij restant 0 én status `gecontroleerd` (een betaling
--   keurt nooit goed), de matchvelden van de banktransactie, een claim op
--   (actor, request_id) en een auditspoor. Inkoopstatus verandert nooit door een
--   betaling; `geexporteerd` blijft exportstatus.
--
-- WAT DEZE MIGRATIE DOET
--   1. bank_transaction_allocations.created_by (nullable, standaard auth.uid()):
--      de echte actor; user_id blijft die van de importeur (de foreign key
--      bta_tx_user_client_fk eist dat). Bestaande rijen krijgen GEEN waarde.
--      Een index op (invoice_id, invoice_type) voor de sommen per factuur.
--   2. bank_payment_requests (de claim) en bank_payment_events (het auditspoor),
--      append-only, alleen lezen voor applicatierollen.
--   3. De twee RPC's, plus interne hulpfuncties (rolvloer, schrijversbewijs,
--      vrijgavetoets) zonder EXECUTE voor applicatierollen.
--   4. Vangnet, voor elk pad (ook de oude app tijdens de uitrol):
--      • guard_bank_allocation_write_trigger (BEFORE, per rij): grendelt de
--        banktransactie vóórdat een nieuwe of gewijzigde koppeling bestaat, en
--        weigert het wijzigen of verwijderen van een koppeling die de
--        betaalschrijver vastlegde, buiten die schrijver om;
--      • validate_bank_allocation_integrity_trigger (uitgesteld tot COMMIT):
--        tenant, factuur van dezelfde soort/administratie/organisatie,
--        richting, geen afwijzing, factuurbedrag bekend, Σ(T) ≤ |T| en
--        Σ(factuur) ≤ factuurbedrag;
--      • validate_bank_match_rejection_not_linked_trigger: een afwijzing en een
--        koppeling van hetzelfde paar kunnen elkaar niet meer missen (A1-24);
--      • verify_bank_payment_event_trigger (uitgesteld): bij COMMIT sluit elke
--        door de schrijver geraakte factuur en banktransactie aan.
--   5. prevent_posted_sales_invoice_mutation(): letterlijk de bestaande functie
--      (20260915160000), met één extra toegestane overgang: `betaald →
--      gecontroleerd` op een geboekte verkoopfactuur, uitsluitend met het
--      bewijs van de betaalschrijver (ontkoppelen). Financiële velden blijven
--      bevroren; elke andere statusovergang blijft geweigerd.
--
-- GRENDELVOLGORDE (huisvolgorde A → T → I → L → C → Y)
--   link:   koppeling van het paar FOR UPDATE → T FOR UPDATE → factuur FOR UPDATE
--   unlink: koppelingen van T FOR UPDATE (id-volgorde) → T FOR UPDATE →
--           facturen FOR UPDATE (soort, id)
--   post_bank_allocation (ongewijzigd): A FOR UPDATE → T FOR UPDATE → I FOR SHARE
--   vangnet: bestaande koppeling van het paar FOR UPDATE → T FOR NO KEY UPDATE
--            (vóór de nieuwe rij bestaat) → I FOR NO KEY UPDATE
--   Geen pad grendelt T of A ná een factuur, en geen pad grendelt een
--   bestaande A ná T: ook een INSERT … ON CONFLICT DO UPDATE van de oude app
--   (BEFORE INSERT vuurt vóór de conflictcontrole) grendelt in de guard eerst
--   de bestaande paar-rij en pas dan T (review P5-DB §2). Unlink weigert met
--   55000 als er tussen beide grendels een koppeling bijkwam. Elk paar paden
--   neemt gedeelde rijen dus in dezelfde volgorde.
--   Beperking (theoretisch, alleen in het venster P5a → P5c): een upsert van
--   MEERDERE rijen in één opdracht grendelt per rij A → T, maar de rijen na
--   elkaar; tegen een gelijktijdige schrijver op een latere rij van dezelfde
--   transactie kan dat nog 40P01 geven (schoon afgebroken, herhaalbaar). De app
--   doet zulke upserts niet; na P5c kan `authenticated` niet meer invoegen.
--   Alleen READ COMMITTED (25000): na het wachten op een grendel leest elke
--   volgende opdracht een verse snapshot.
--
-- LEGACY (voorwaarde 8): fail closed, niets herschreven
--   De RPC's weigeren een factuur waarvan het opgeslagen restant afwijkt van
--   factuurbedrag − koppelingen ("Openstaand bedrag wijkt af van de
--   koppelingen; herstel nodig"; een NULL-restant zonder koppelingen telt als
--   afgeleid), en een banktransactie die volgens een oude match (zonder
--   koppelingsrij) al aan een andere factuur is toegewezen. Een factuur die
--   vóór de koppelingstabel via matched_invoice_id is betaald, heropent dus
--   nooit stil. Uitzondering, eenduidig: de oude match van een transactie mag
--   als koppeling worden VASTGELEGD als het opgeslagen restant die betaling al
--   exact bevat (event `formalized`). Leescontroles en een herstelvoorstel
--   (niet toegepast): supabase/rollout/20261021180000_add_atomic_bank_payment_link/
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen UPDATE, DELETE of backfill van bestaande rijen; geen trigger die
--     bestaande rijen herschrijft. Het vangnet en de guards weigeren alleen.
--   - Geen trigger op bank_transactions (de voorwaardencontrole van
--     20261018150000 pint die set) en geen herdefinitie van een schrijver of
--     van een functie van PR 1/PR 2.
--   - Geen nieuwe rechten op bestaande tabellen; de oude app blijft werken.
--     Het intrekken van de directe schrijfrechten en de guard op de
--     factuurtabellen volgen in P5c (20261021183000), pas na de app (P5b).
--   - Geen ontkoppelen van een geboekte (ook tegengeboekte) koppeling en geen
--     negatieve koppeling (storno): ontwerpbesluiten, zie P5-ontwerp.md §5/§7.
--
-- PRODUCTIE
--   Uitsluitend via de Lovable Cloud SQL editor van project
--   alxlbdhpbwlehbdbfejw, ná review, en pas nadat 20261010120000 en
--   20261017120000 aantoonbaar zijn toegepast. PRE/POST en het herstelvoorstel:
--   supabase/rollout/20261021180000_add_atomic_bank_payment_link/
--   Deze PR past niets toe.
--
-- ROLLBACK (handmatig; eerst P5c terugdraaien als die is toegepast). Herstelt
-- de oorspronkelijke functie van 20260915160000 letterlijk, en verwijdert de
-- RPC's, guards en hulpfuncties. De claim- en gebeurtenistabellen en
-- created_by blijven staan: dat is geschiedenis (weghalen alleen met akkoord
-- van de eigenaar); dat geldt ook voor de kolom bank_payment_events.invoice_amount. Koppelingen, restbedragen en statussen die via de RPC zijn
-- geschreven, blijven geldig: het zijn gewone rijen.
-- ROLLBACK-BEGIN
-- CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM public.sales_invoice_postings WHERE sales_invoice_id = OLD.id
--   ) THEN
--     RETURN NEW;
--   END IF;
--
--   IF NEW.client_id            IS DISTINCT FROM OLD.client_id
--      OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
--      OR NEW.customer_name     IS DISTINCT FROM OLD.customer_name
--      OR NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
--      OR NEW.invoice_date      IS DISTINCT FROM OLD.invoice_date
--      OR NEW.amount_excl       IS DISTINCT FROM OLD.amount_excl
--      OR NEW.btw_amount        IS DISTINCT FROM OLD.btw_amount
--      OR NEW.amount_incl       IS DISTINCT FROM OLD.amount_incl
--      OR NEW.btw_percentage    IS DISTINCT FROM OLD.btw_percentage
--      OR NEW.btw_verlegd       IS DISTINCT FROM OLD.btw_verlegd
--      OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
--      OR NEW.ledger_account_text IS DISTINCT FROM OLD.ledger_account_text
--   THEN
--     RAISE EXCEPTION 'Deze verkoopfactuur is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
--       USING ERRCODE = '42501';
--   END IF;
--
--   -- status is deliberately NOT in the frozen list above — payment progression
--   -- must keep working after posting. But "not frozen" cannot mean "any value":
--   -- an unrestricted status column would let a posted invoice be set back to
--   -- concept or verzonden, which are exactly the states post_sales_invoice()
--   -- refuses to post from. That would leave a row simultaneously "posted" (a
--   -- marker exists, immutable ledger rows exist) and "not yet reviewed"
--   -- (status), an inconsistency nothing else here catches. Only forward payment
--   -- progression is allowed: gecontroleerd may stay or move to betaald; betaald
--   -- may only stay betaald. Every other transition on a posted invoice is
--   -- refused, independent of the accounting-field check above, which does not
--   -- look at status at all.
--   IF NEW.status IS DISTINCT FROM OLD.status
--      AND NOT (OLD.status = 'gecontroleerd' AND NEW.status = 'betaald')
--   THEN
--     RAISE EXCEPTION 'Deze verkoopfactuur is geboekt; status kan alleen nog van gecontroleerd naar betaald. Een correctie vereist een tegenboeking.'
--       USING ERRCODE = '42501';
--   END IF;
--
--   RETURN NEW;
-- END
-- $$;
--   DROP TRIGGER IF EXISTS validate_bank_match_rejection_not_linked_trigger ON public.bank_match_rejections;
--   DROP TRIGGER IF EXISTS validate_bank_allocation_integrity_trigger ON public.bank_transaction_allocations;
--   DROP TRIGGER IF EXISTS guard_bank_allocation_write_trigger ON public.bank_transaction_allocations;
--   DROP TRIGGER IF EXISTS verify_bank_payment_event_trigger ON public.bank_payment_events;
--   DROP FUNCTION IF EXISTS public.link_bank_payment(uuid, text, uuid, numeric, uuid);
--   DROP FUNCTION IF EXISTS public.unlink_bank_payment(uuid, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.enforce_bank_match_rejection_not_linked();
--   DROP FUNCTION IF EXISTS public.enforce_bank_allocation_integrity();
--   DROP FUNCTION IF EXISTS public.guard_bank_allocation_write();
--   DROP FUNCTION IF EXISTS public.verify_bank_payment_event();
--   DROP FUNCTION IF EXISTS public.bank_payment_assert_consistent(text, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.bank_payment_writer_active(text, uuid);
--   DROP FUNCTION IF EXISTS public.bank_payment_allocation_writer_active(uuid, text);
--   DROP FUNCTION IF EXISTS public.bank_payment_tx_released(uuid);
--   DROP FUNCTION IF EXISTS public.bank_payment_min_role(text, text);
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_transaction_allocations') IS NULL
     OR to_regclass('public.purchase_invoices') IS NULL
     OR to_regclass('public.sales_invoices') IS NULL
     OR to_regclass('public.bank_match_rejections') IS NULL
     OR to_regclass('public.bank_allocation_postings') IS NULL
     OR to_regclass('public.bank_transaction_postings') IS NULL
     OR to_regclass('public.sales_invoice_postings') IS NULL THEN
    RAISE EXCEPTION 'P5a vereist bank_transactions, bank_transaction_allocations, purchase_invoices, sales_invoices, bank_match_rejections (20261010120000) en de boekingsmarkers';
  END IF;
  IF to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL
     OR to_regprocedure('public.role_rank(public.app_role)') IS NULL
     OR to_regprocedure('public.post_bank_allocation(uuid)') IS NULL
     OR to_regprocedure('public.enforce_bank_match_rejection_scope()') IS NULL
     OR to_regprocedure('public.enforce_bank_allocation_not_directly_posted()') IS NULL
     OR to_regprocedure('public.prevent_posted_sales_invoice_mutation()') IS NULL THEN
    RAISE EXCEPTION 'P5a vereist has_min_role(), role_rank(), post_bank_allocation(), 20261010120000 en PR 0 (20261017120000)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name IN ('purchase_invoices', 'sales_invoices')
              AND column_name IN ('remaining_amount', 'amount_incl', 'status', 'client_id', 'organization_id'))
          OR (table_name = 'bank_transactions'
              AND column_name IN ('match_status', 'matched_invoice_id', 'match_confidence', 'amount', 'client_id', 'organization_id', 'user_id'))
          OR (table_name = 'bank_transaction_allocations'
              AND column_name IN ('bank_transaction_id', 'invoice_type', 'invoice_id', 'client_id', 'organization_id', 'amount', 'user_id')))) <> 24 THEN
    RAISE EXCEPTION 'P5a: een vereiste kolom ontbreekt op de facturen, de banktransacties of de koppelingen';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.sales_invoices'::regclass
                   AND tgname = 'prevent_posted_sales_invoice_mutation_trigger' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'P5a: prevent_posted_sales_invoice_mutation_trigger ontbreekt op sales_invoices';
  END IF;
  -- De functie die hieronder wordt vervangen, moet de beoordeelde zijn: het
  -- origineel van 20260915160000, of (bij een tweede toepassing) die van P5a.
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p WHERE p.oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure;
  IF v_md5 NOT IN ('aad983904aba6df9519d332389427b4e', 'd7fa08d5356e5f0152928aa7f03438ad') THEN
    RAISE EXCEPTION 'P5a: prevent_posted_sales_invoice_mutation() wijkt af van de beoordeelde versie (md5 %); STOP en laat beoordelen', v_md5;
  END IF;
END
$migratie$;

-- ── 1. Actor op de koppeling, index per factuur ─────────────────────────────

-- Eerst de kolom zonder standaardwaarde, dan pas de standaard: zo krijgt geen
-- enkele bestaande rij een waarde (een standaard bij ADD COLUMN zou hem voor
-- alle bestaande rijen invullen).
ALTER TABLE public.bank_transaction_allocations
  ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.bank_transaction_allocations
  ALTER COLUMN created_by SET DEFAULT auth.uid();

COMMENT ON COLUMN public.bank_transaction_allocations.created_by IS
'Wie de koppeling vastlegde (auth.uid()). user_id blijft de eigenaar van de banktransactie, zoals de foreign key bta_tx_user_client_fk eist. NULL voor koppelingen van vóór 20261021180000. Geen foreign key: een auditveld mag het verwijderen van een gebruiker niet blokkeren.';

CREATE INDEX IF NOT EXISTS idx_bta_invoice_id_type
  ON public.bank_transaction_allocations (invoice_id, invoice_type);

-- ── 2. Claim en auditspoor ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bank_payment_requests (
  actor_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_id          uuid        NOT NULL,
  request_kind        text        NOT NULL,
  args_hash           text        NOT NULL,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id           uuid        NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  bank_transaction_id uuid        NOT NULL,
  outcome             text        NOT NULL,
  result              jsonb       NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_xact_id     xid8        NOT NULL,
  CONSTRAINT bank_payment_requests_pkey PRIMARY KEY (actor_id, request_id),
  CONSTRAINT bank_payment_requests_kind_check CHECK (request_kind IN ('link', 'unlink')),
  CONSTRAINT bank_payment_requests_hash_check CHECK (args_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT bank_payment_requests_outcome_check CHECK (
    (request_kind = 'link'   AND outcome IN ('created', 'unchanged'))
    OR (request_kind = 'unlink' AND outcome IN ('unlinked', 'unchanged')))
);

CREATE INDEX IF NOT EXISTS idx_bank_payment_requests_org ON public.bank_payment_requests (organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_payment_requests_tx  ON public.bank_payment_requests (bank_transaction_id);

COMMENT ON TABLE public.bank_payment_requests IS
'Idempotentieclaim van link_bank_payment/unlink_bank_payment: één rij per (actor, request_id), met de hash van de argumenten en het letterlijke antwoord. Een herhaling met dezelfde argumenten geeft dat antwoord terug (replayed = true); andere argumenten onder dezelfde request_id worden geweigerd. Append-only; alleen de RPC''s schrijven. Bewust geen foreign key naar bank_transactions: een ontkoppelde dubbele import blijft verwijderbaar.';

CREATE TABLE IF NOT EXISTS public.bank_payment_events (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint        GENERATED ALWAYS AS IDENTITY,
  actor_id            uuid          NOT NULL,
  request_id          uuid          NOT NULL,
  event_type          text          NOT NULL,
  allocation_id       uuid          NOT NULL,
  bank_transaction_id uuid          NOT NULL,
  invoice_type        text          NOT NULL,
  invoice_id          uuid          NOT NULL,
  organization_id     uuid          NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id           uuid          NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  amount              numeric(12,2) NOT NULL,
  remaining_before    numeric(12,2),
  remaining_after     numeric(12,2) NOT NULL,
  status_before       text          NOT NULL,
  status_after        text          NOT NULL,
  invoice_amount      numeric(12,2),
  tx_status_before    text          NOT NULL,
  tx_status_after     text          NOT NULL,
  formalized          boolean       NOT NULL DEFAULT false,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  created_xact_id     xid8          NOT NULL,
  CONSTRAINT bank_payment_events_seq_key UNIQUE (seq),
  CONSTRAINT bank_payment_events_allocation_key UNIQUE (allocation_id, event_type),
  CONSTRAINT bank_payment_events_request_fkey FOREIGN KEY (actor_id, request_id)
    REFERENCES public.bank_payment_requests (actor_id, request_id) ON DELETE RESTRICT,
  CONSTRAINT bank_payment_events_type_check CHECK (event_type IN ('linked', 'unlinked')),
  CONSTRAINT bank_payment_events_invoice_type_check CHECK (invoice_type IN ('inkoop', 'verkoop')),
  CONSTRAINT bank_payment_events_amount_check CHECK (amount > 0),
  CONSTRAINT bank_payment_events_formalized_check CHECK (NOT formalized OR event_type = 'linked')
);

-- Upgradepad: een database met een eerdere versie van deze tabel krijgt de
-- kolom alsnog (bestaande rijen blijven leeg; de COMMIT-check kijkt alleen
-- naar gebeurtenissen van de lopende transactie).
ALTER TABLE public.bank_payment_events ADD COLUMN IF NOT EXISTS invoice_amount numeric(12,2);

CREATE INDEX IF NOT EXISTS idx_bank_payment_events_tx_seq  ON public.bank_payment_events (bank_transaction_id, seq);
CREATE INDEX IF NOT EXISTS idx_bank_payment_events_invoice ON public.bank_payment_events (invoice_id, invoice_type);
CREATE INDEX IF NOT EXISTS idx_bank_payment_events_org     ON public.bank_payment_events (organization_id);

COMMENT ON TABLE public.bank_payment_events IS
'Auditspoor van de betaalschrijver: één rij per vastgelegde (linked) of verwijderde (unlinked) koppeling, met bedrag, restant en status van de factuur en de matchstatus van de banktransactie vóór en na. created_xact_id (door een trigger gestempeld) bewijst dat een wijziging van restant, status of koppeling in dezelfde transactie door de schrijver is gedaan. formalized = een oude match zonder koppelingsrij, vastgelegd zonder het restant te wijzigen. Append-only.';

ALTER TABLE public.bank_payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_payment_events   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_bank_payment_requests_select ON public.bank_payment_requests;
CREATE POLICY role_bank_payment_requests_select
  ON public.bank_payment_requests FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_bank_payment_events_select ON public.bank_payment_events;
CREATE POLICY role_bank_payment_events_select
  ON public.bank_payment_events FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

-- Alleen lezen voor applicatierollen; schrijven gebeurt uitsluitend door de
-- RPC's, via het eigenaarschap van de tabellen.
REVOKE ALL ON TABLE public.bank_payment_requests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.bank_payment_events   FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.bank_payment_requests TO authenticated, service_role;
GRANT SELECT ON TABLE public.bank_payment_events   TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.bank_payment_events_seq_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stamp_bank_payment_record()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- De transactie en het moment zijn die van deze INSERT, niet van wie de rij aanlevert.
  NEW.created_at := now();
  NEW.created_xact_id := pg_current_xact_id();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_bank_payment_record() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_bank_payment_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is niet toegestaan. De betaalgeschiedenis wordt aangevuld, nooit herschreven.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_bank_payment_record_mutation() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS stamp_bank_payment_request_trigger ON public.bank_payment_requests;
CREATE TRIGGER stamp_bank_payment_request_trigger
BEFORE INSERT ON public.bank_payment_requests
FOR EACH ROW EXECUTE FUNCTION public.stamp_bank_payment_record();

DROP TRIGGER IF EXISTS prevent_bank_payment_request_mutation_trigger ON public.bank_payment_requests;
CREATE TRIGGER prevent_bank_payment_request_mutation_trigger
BEFORE UPDATE OR DELETE ON public.bank_payment_requests
FOR EACH ROW EXECUTE FUNCTION public.prevent_bank_payment_record_mutation();
ALTER TABLE public.bank_payment_requests ENABLE ALWAYS TRIGGER prevent_bank_payment_request_mutation_trigger;

DROP TRIGGER IF EXISTS prevent_bank_payment_request_truncate_trigger ON public.bank_payment_requests;
CREATE TRIGGER prevent_bank_payment_request_truncate_trigger
BEFORE TRUNCATE ON public.bank_payment_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_bank_payment_record_mutation();
ALTER TABLE public.bank_payment_requests ENABLE ALWAYS TRIGGER prevent_bank_payment_request_truncate_trigger;

DROP TRIGGER IF EXISTS stamp_bank_payment_event_trigger ON public.bank_payment_events;
CREATE TRIGGER stamp_bank_payment_event_trigger
BEFORE INSERT ON public.bank_payment_events
FOR EACH ROW EXECUTE FUNCTION public.stamp_bank_payment_record();

DROP TRIGGER IF EXISTS prevent_bank_payment_event_mutation_trigger ON public.bank_payment_events;
CREATE TRIGGER prevent_bank_payment_event_mutation_trigger
BEFORE UPDATE OR DELETE ON public.bank_payment_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_bank_payment_record_mutation();
ALTER TABLE public.bank_payment_events ENABLE ALWAYS TRIGGER prevent_bank_payment_event_mutation_trigger;

DROP TRIGGER IF EXISTS prevent_bank_payment_event_truncate_trigger ON public.bank_payment_events;
CREATE TRIGGER prevent_bank_payment_event_truncate_trigger
BEFORE TRUNCATE ON public.bank_payment_events
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_bank_payment_record_mutation();
ALTER TABLE public.bank_payment_events ENABLE ALWAYS TRIGGER prevent_bank_payment_event_truncate_trigger;

-- ── 3. Interne hulpfuncties ─────────────────────────────────────────────────

-- D2 en de ontkoppelvloer zijn OPEN besluiten; fail closed gelijk aan de echte
-- RLS (verkoop: owner; DELETE op koppelingen: accountant). Omzetten = alleen
-- deze CASE.
CREATE OR REPLACE FUNCTION public.bank_payment_min_role(_invoice_type text, _action text)
RETURNS public.app_role
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _invoice_type = 'verkoop'                        THEN 'owner'::public.app_role
    WHEN _invoice_type = 'inkoop' AND _action = 'link'    THEN 'assistant'::public.app_role
    WHEN _invoice_type = 'inkoop' AND _action = 'unlink'  THEN 'accountant'::public.app_role
    ELSE 'owner'::public.app_role
  END
$$;

REVOKE ALL ON FUNCTION public.bank_payment_min_role(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.bank_payment_min_role(text, text) IS
'Rolvloer van de betaalschrijver (D2 en ontkoppelvloer open; fail closed gelijk aan de RLS): verkoop owner; inkoop koppelen assistant, ontkoppelen accountant; onbekend owner.';

-- Het bewijs dat de betaalschrijver NU in deze transactie werkt: de sessievlag
-- draagt de eigen transactie-id én er bestaat in deze transactie een
-- gebeurtenis voor precies deze factuur. De vlag alleen is in een SQL-sessie
-- te zetten; een gebeurtenis kan alleen de eigenaar (de RPC) schrijven.
CREATE OR REPLACE FUNCTION public.bank_payment_writer_active(_invoice_type text, _invoice_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN coalesce(current_setting('boekassist.betaalschrijver', true), '') = pg_current_xact_id()::text
     AND EXISTS (SELECT 1 FROM public.bank_payment_events e
                 WHERE e.invoice_id = _invoice_id
                   AND e.invoice_type = _invoice_type
                   AND e.created_xact_id = pg_current_xact_id());
END;
$$;

REVOKE ALL ON FUNCTION public.bank_payment_writer_active(text, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bank_payment_allocation_writer_active(_allocation_id uuid, _event_type text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN coalesce(current_setting('boekassist.betaalschrijver', true), '') = pg_current_xact_id()::text
     AND EXISTS (SELECT 1 FROM public.bank_payment_events e
                 WHERE e.allocation_id = _allocation_id
                   AND e.event_type = _event_type
                   AND e.created_xact_id = pg_current_xact_id());
END;
$$;

REVOKE ALL ON FUNCTION public.bank_payment_allocation_writer_active(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Vrijgegeven na een geboekte correctie (PR 1, D12): geen directe marker en de
-- laatste correctiegebeurtenis is `released`. Dynamisch, zodat P5a niet van
-- de volgorde van uitrol van PR 1 afhangt.
CREATE OR REPLACE FUNCTION public.bank_payment_tx_released(_bank_transaction_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last text;
BEGIN
  IF to_regclass('public.bank_transaction_posting_events') IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = _bank_transaction_id) THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT e.event_type FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = $1 ORDER BY e.seq DESC LIMIT 1'
    INTO v_last USING _bank_transaction_id;
  RETURN v_last IS NOT DISTINCT FROM 'released';
END;
$$;

REVOKE ALL ON FUNCTION public.bank_payment_tx_released(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. Vangnet op de koppelingen ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_bank_allocation_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankkoppeling kan alleen in een READ COMMITTED transactie worden gewijzigd (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Een koppeling die de betaalschrijver vastlegde, verandert alleen nog via
  -- die schrijver; anders loopt het afgeleide restant stil uiteen met de
  -- koppelingen (bv. een oude client die tijdens de uitrol een upsert doet).
  -- Ook een cascade vanuit het verwijderen van de banktransactie valt hieronder.
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND EXISTS (SELECT 1 FROM public.bank_payment_events e
                 WHERE e.allocation_id = OLD.id AND e.event_type = 'linked')
     AND NOT (TG_OP = 'DELETE' AND public.bank_payment_allocation_writer_active(OLD.id, 'unlinked')) THEN
    RAISE EXCEPTION 'Deze koppeling is vastgelegd door de betaalschrijver en verandert alleen via Ontkoppelen. Ververs de pagina en probeer het opnieuw.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Grendelvolgorde A → T, ook voor INSERT … ON CONFLICT DO UPDATE: deze
  -- trigger vuurt vóór de conflictcontrole, die daarna de bestaande koppeling
  -- grendelt. Eerst die bestaande paar-rij grendelen, dan pas T; anders
  -- T → A tegenover link/unlink/post_bank_allocation (A → T): deadlock.
  -- (Bij UPDATE is de rij al gegrendeld vóór deze trigger vuurt.)
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.bank_transaction_allocations a
    WHERE a.bank_transaction_id = NEW.bank_transaction_id
      AND a.invoice_id = NEW.invoice_id
    FOR UPDATE;
  END IF;

  -- De banktransactie grendelen vóórdat de nieuwe of gewijzigde rij bestaat:
  -- zo wacht een directe schrijver op een lopende betaalschrijver (en
  -- andersom) vóór de unieke index (transactie, factuur) wordt geraakt. Zonder
  -- deze grendel konden beide hetzelfde paar invoegen en op elkaar wachten.
  -- Dezelfde grendel neemt het uitgestelde vangnet bij COMMIT.
  PERFORM 1 FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR NO KEY UPDATE;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_bank_allocation_write() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_bank_allocation_write() IS
'P5a, BEFORE INSERT/UPDATE/DELETE per rij op bank_transaction_allocations: grendelt de banktransactie (FOR NO KEY UPDATE) vóór een nieuwe of gewijzigde koppeling bestaat, en weigert (42501) het wijzigen of verwijderen van een koppeling die de betaalschrijver vastlegde, behalve verwijderen door unlink_bank_payment zelf. Alleen READ COMMITTED.';

DROP TRIGGER IF EXISTS guard_bank_allocation_write_trigger ON public.bank_transaction_allocations;
CREATE TRIGGER guard_bank_allocation_write_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.bank_transaction_allocations
FOR EACH ROW EXECUTE FUNCTION public.guard_bank_allocation_write();

CREATE OR REPLACE FUNCTION public.enforce_bank_allocation_integrity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a          public.bank_transaction_allocations%ROWTYPE;
  v_tx_org     uuid;
  v_tx_client  uuid;
  v_tx_amount  numeric;
  v_inv_id     uuid;
  v_inv_org    uuid;
  v_inv_client uuid;
  v_inv_incl   numeric;
  v_sum        numeric;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankkoppeling kan alleen in een READ COMMITTED transactie worden vastgelegd (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Uitgesteld tot COMMIT: de rij zoals zij nu is (een latere opdracht in de
  -- transactie kan haar hebben gewijzigd of verwijderd).
  SELECT * INTO v_a FROM public.bank_transaction_allocations WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Grendels in huisvolgorde: banktransactie, dan factuur.
  SELECT bt.organization_id, bt.client_id, bt.amount INTO v_tx_org, v_tx_client, v_tx_amount
  FROM public.bank_transactions bt
  WHERE bt.id = v_a.bank_transaction_id
  FOR NO KEY UPDATE;
  IF NOT FOUND
     OR v_a.organization_id IS DISTINCT FROM v_tx_org
     OR v_a.client_id IS DISTINCT FROM v_tx_client THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF v_a.invoice_type = 'inkoop' THEN
    SELECT pi.id, pi.organization_id, pi.client_id, pi.amount_incl
      INTO v_inv_id, v_inv_org, v_inv_client, v_inv_incl
    FROM public.purchase_invoices pi
    WHERE pi.id = v_a.invoice_id
    FOR NO KEY UPDATE;
  ELSE
    SELECT si.id, si.organization_id, si.client_id, si.amount_incl
      INTO v_inv_id, v_inv_org, v_inv_client, v_inv_incl
    FROM public.sales_invoices si
    WHERE si.id = v_a.invoice_id
    FOR NO KEY UPDATE;
  END IF;
  IF v_inv_id IS NULL
     OR v_inv_org IS DISTINCT FROM v_a.organization_id
     OR v_inv_client IS DISTINCT FROM v_a.client_id THEN
    RAISE EXCEPTION 'Factuur niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF (v_a.invoice_type = 'verkoop' AND v_tx_amount <= 0)
     OR (v_a.invoice_type = 'inkoop' AND v_tx_amount >= 0) THEN
    RAISE EXCEPTION 'Een verkoopfactuur hoort bij een inkomende en een inkoopfactuur bij een uitgaande banktransactie'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_match_rejections r
             WHERE r.bank_transaction_id = v_a.bank_transaction_id
               AND r.invoice_type = v_a.invoice_type
               AND r.invoice_id = v_a.invoice_id) THEN
    RAISE EXCEPTION 'Deze factuur is voor deze banktransactie afgewezen; maak de afwijzing eerst ongedaan'
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum(a.amount), 0) INTO v_sum
  FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = v_a.bank_transaction_id;
  IF v_sum > abs(v_tx_amount) THEN
    RAISE EXCEPTION 'De koppelingen op deze banktransactie (%) overschrijden samen het transactiebedrag (%)', v_sum, abs(v_tx_amount)
      USING ERRCODE = '23514';
  END IF;

  IF v_inv_incl IS NULL THEN
    RAISE EXCEPTION 'Factuur mist een bedrag inclusief btw; vul dat eerst in' USING ERRCODE = '22004';
  END IF;

  SELECT coalesce(sum(a.amount), 0) INTO v_sum
  FROM public.bank_transaction_allocations a
  WHERE a.invoice_id = v_a.invoice_id AND a.invoice_type = v_a.invoice_type;
  IF v_sum > v_inv_incl THEN
    RAISE EXCEPTION 'De koppelingen op deze factuur (%) overschrijden samen het factuurbedrag (%); een overbetaling wordt niet ondersteund', v_sum, v_inv_incl
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_allocation_integrity() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_allocation_integrity() IS
'P5a-vangnet, uitgestelde constraint-trigger op bank_transaction_allocations (nieuwe of gewijzigde rijen): bij COMMIT, onder T FOR NO KEY UPDATE → factuur FOR NO KEY UPDATE, tenant (42501), factuur van dezelfde soort, administratie en organisatie (42501), richting (22023), geen afwijzing (23514), factuurbedrag bekend (22004), Σ(T) ≤ |T| en Σ(factuur) ≤ factuurbedrag (23514). Voor elke rol en elk pad.';

DROP TRIGGER IF EXISTS validate_bank_allocation_integrity_trigger ON public.bank_transaction_allocations;
CREATE CONSTRAINT TRIGGER validate_bank_allocation_integrity_trigger
AFTER INSERT OR UPDATE OF bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount
ON public.bank_transaction_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_allocation_integrity();

-- ── 5. Afwijzing en koppeling missen elkaar niet meer (A1-24) ───────────────

CREATE OR REPLACE FUNCTION public.enforce_bank_match_rejection_not_linked()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een afwijzing kan alleen in een READ COMMITTED transactie worden vastgelegd (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- De bestaande scopetrigger toetst dit al, maar zonder grendel: een
  -- gelijktijdige koppeling kon ertussen glippen. FOR SHARE botst met de
  -- grendel van de betaalschrijver en van het vangnet; na het wachten ziet de
  -- volgende opdracht de net gecommitte koppeling.
  PERFORM 1 FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR SHARE;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a
             WHERE a.bank_transaction_id = NEW.bank_transaction_id AND a.invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'Deze factuur is al aan de banktransactie gekoppeld; ontkoppel eerst in plaats van af te wijzen'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_match_rejection_not_linked() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS validate_bank_match_rejection_not_linked_trigger ON public.bank_match_rejections;
CREATE TRIGGER validate_bank_match_rejection_not_linked_trigger
AFTER INSERT ON public.bank_match_rejections
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_match_rejection_not_linked();

-- ── 6. Postconditie van de schrijver ────────────────────────────────────────
--
-- Eén controle, op twee momenten: aan het eind van elke RPC (ook als een
-- aanroeper de uitgestelde controle met SET CONSTRAINTS ALL IMMEDIATE naar
-- voren haalt, toetst zij dan de eindtoestand) en bij COMMIT (vangt een
-- latere wijziging in dezelfde transactie).

CREATE OR REPLACE FUNCTION public.bank_payment_assert_consistent(
  _invoice_type text, _invoice_id uuid, _bank_transaction_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_incl       numeric;
  v_rem        numeric;
  v_status     text;
  v_found      boolean;
  v_sum        numeric;
  v_tx_status  text;
  v_tx_primary uuid;
  v_primary_ok boolean;
BEGIN
  IF _invoice_type = 'inkoop' THEN
    SELECT pi.amount_incl, pi.remaining_amount, pi.status INTO v_incl, v_rem, v_status
    FROM public.purchase_invoices pi WHERE pi.id = _invoice_id;
  ELSE
    SELECT si.amount_incl, si.remaining_amount, si.status INTO v_incl, v_rem, v_status
    FROM public.sales_invoices si WHERE si.id = _invoice_id;
  END IF;
  v_found := FOUND;

  SELECT coalesce(sum(a.amount), 0) INTO v_sum
  FROM public.bank_transaction_allocations a
  WHERE a.invoice_id = _invoice_id AND a.invoice_type = _invoice_type;

  -- Ook: nooit meer gekoppeld dan het factuurbedrag, en het restant blijft
  -- tussen 0 en het factuurbedrag (review P5-DB §1b).
  IF NOT v_found OR v_incl IS NULL OR v_rem IS DISTINCT FROM v_incl - v_sum
     OR v_sum > v_incl OR v_rem < 0 OR v_rem > v_incl
     OR (v_status = 'betaald' AND v_rem <> 0) THEN
    RAISE EXCEPTION 'Betaalschrijver: het openstaande bedrag of de status van de factuur sluit niet aan op haar koppelingen'
      USING ERRCODE = '23514';
  END IF;

  SELECT bt.match_status, bt.matched_invoice_id INTO v_tx_status, v_tx_primary
  FROM public.bank_transactions bt WHERE bt.id = _bank_transaction_id;
  IF FOUND THEN
    SELECT coalesce(sum(a.amount), 0), coalesce(bool_or(a.invoice_id = v_tx_primary), false)
      INTO v_sum, v_primary_ok
    FROM public.bank_transaction_allocations a
    WHERE a.bank_transaction_id = _bank_transaction_id;
    IF (v_sum > 0 AND (v_tx_status IS DISTINCT FROM 'gematcht' OR NOT v_primary_ok))
       OR (v_sum = 0 AND (v_tx_status = 'gematcht' OR v_tx_primary IS NOT NULL)) THEN
      RAISE EXCEPTION 'Betaalschrijver: de matchstatus van de banktransactie sluit niet aan op haar koppelingen'
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_payment_assert_consistent(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_bank_payment_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last   public.bank_payment_events%ROWTYPE;
  v_rem    numeric;
  v_status text;
  v_incl   numeric;
BEGIN
  PERFORM public.bank_payment_assert_consistent(NEW.invoice_type, NEW.invoice_id, NEW.bank_transaction_id);

  -- Bij COMMIT staat de factuur exact zoals de LAATSTE betaalgebeurtenis van
  -- deze transactie haar achterliet: hetzelfde factuurbedrag, en restant plus
  -- status gelijk aan de na-toestand. Een sessievlag die ná een legitieme
  -- aanroep met de hand wordt gezet, kan zo niets meer veranderen (review
  -- P5-DB §1a). De vóór-toestand is ook goed: wie de uitgestelde controles met
  -- SET CONSTRAINTS ALL IMMEDIATE naar voren haalt, laat deze trigger vuren
  -- direct na het vastleggen van de gebeurtenis, vóór de factuur is bijgewerkt
  -- (de RPC toetst zelf de eindtoestand); terugzetten naar de vóór-toestand
  -- valt daarbuiten altijd op restant = bedrag − Σ.
  -- Grens: met IMMEDIATE is deze controle al gevuurd vóór een write die ná de
  -- RPC in dezelfde transactie volgt. Onder alleen P5a omzeilt een vervalste
  -- vlag + IMMEDIATE dit dus (geen nieuw gat: zonder P5c schrijft de oude app
  -- facturen toch rechtstreeks). P5c sluit het: de factuurguard laat de
  -- schrijver alleen restant en status naar de na-toestand zetten.
  SELECT * INTO v_last
  FROM public.bank_payment_events e
  WHERE e.invoice_id = NEW.invoice_id
    AND e.invoice_type = NEW.invoice_type
    AND e.created_xact_id = pg_current_xact_id()
  ORDER BY e.seq DESC
  LIMIT 1;
  IF FOUND THEN
    IF NEW.invoice_type = 'inkoop' THEN
      SELECT pi.remaining_amount, pi.status, pi.amount_incl INTO v_rem, v_status, v_incl FROM public.purchase_invoices pi WHERE pi.id = NEW.invoice_id;
    ELSE
      SELECT si.remaining_amount, si.status, si.amount_incl INTO v_rem, v_status, v_incl FROM public.sales_invoices si WHERE si.id = NEW.invoice_id;
    END IF;
    IF v_incl IS DISTINCT FROM v_last.invoice_amount
       OR NOT ((v_rem IS NOT DISTINCT FROM v_last.remaining_after AND v_status IS NOT DISTINCT FROM v_last.status_after)
            OR (v_rem IS NOT DISTINCT FROM v_last.remaining_before AND v_status IS NOT DISTINCT FROM v_last.status_before)) THEN
      RAISE EXCEPTION 'Betaalschrijver: de factuur is na het koppelen of ontkoppelen in dezelfde transactie nog gewijzigd'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_bank_payment_event() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS verify_bank_payment_event_trigger ON public.bank_payment_events;
CREATE CONSTRAINT TRIGGER verify_bank_payment_event_trigger
AFTER INSERT ON public.bank_payment_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.verify_bank_payment_event();

-- ── 7. Geboekte verkoopfactuur: ontkoppelen mag `betaald` terugzetten ───────
--
-- Letterlijk de functie van 20260915160000; de enige wijziging is de derde
-- regel van de statusvoorwaarde. `betaald → gecontroleerd` op een geboekte
-- factuur mag uitsluitend met het bewijs van de betaalschrijver (sessievlag én
-- een gebeurtenis voor deze factuur in deze transactie). De financiële velden
-- blijven bevroren; elke andere statusovergang blijft geweigerd.

CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_invoice_postings WHERE sales_invoice_id = OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.client_id            IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
     OR NEW.customer_name     IS DISTINCT FROM OLD.customer_name
     OR NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
     OR NEW.invoice_date      IS DISTINCT FROM OLD.invoice_date
     OR NEW.amount_excl       IS DISTINCT FROM OLD.amount_excl
     OR NEW.btw_amount        IS DISTINCT FROM OLD.btw_amount
     OR NEW.amount_incl       IS DISTINCT FROM OLD.amount_incl
     OR NEW.btw_percentage    IS DISTINCT FROM OLD.btw_percentage
     OR NEW.btw_verlegd       IS DISTINCT FROM OLD.btw_verlegd
     OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
     OR NEW.ledger_account_text IS DISTINCT FROM OLD.ledger_account_text
  THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is geboekt; boekhoudkundige gegevens kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  -- status is deliberately NOT in the frozen list above — payment progression
  -- must keep working after posting. But "not frozen" cannot mean "any value":
  -- an unrestricted status column would let a posted invoice be set back to
  -- concept or verzonden, which are exactly the states post_sales_invoice()
  -- refuses to post from. That would leave a row simultaneously "posted" (a
  -- marker exists, immutable ledger rows exist) and "not yet reviewed"
  -- (status), an inconsistency nothing else here catches. Only forward payment
  -- progression is allowed: gecontroleerd may stay or move to betaald; betaald
  -- may only stay betaald. Every other transition on a posted invoice is
  -- refused, independent of the accounting-field check above, which does not
  -- look at status at all.
  -- P5a: unlinking a payment through the payment writer (proof: session flag
  -- plus a payment event for this invoice in this transaction) may move
  -- betaald back to gecontroleerd — the only state it can have come from.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'gecontroleerd' AND NEW.status = 'betaald')
     AND NOT (OLD.status = 'betaald' AND NEW.status = 'gecontroleerd'
              AND public.bank_payment_writer_active('verkoop', OLD.id))
  THEN
    RAISE EXCEPTION 'Deze verkoopfactuur is geboekt; status kan alleen nog van gecontroleerd naar betaald. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posted_sales_invoice_mutation() FROM PUBLIC;

-- ── 8. De betaalschrijver: koppelen ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.link_bank_payment(
  _bank_transaction_id uuid,
  _invoice_type        text,
  _invoice_id          uuid,
  _amount              numeric,
  _request_id          uuid
)
RETURNS TABLE (
  allocation_id     uuid,
  outcome           text,
  invoice_remaining numeric,
  invoice_status    text,
  tx_match_status   text,
  replayed          boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               uuid := auth.uid();
  v_amount            numeric(12,2);
  v_hash              text;
  v_pair              public.bank_transaction_allocations%ROWTYPE;
  v_pair_found        boolean;
  v_tx                public.bank_transactions%ROWTYPE;
  v_claim             public.bank_payment_requests%ROWTYPE;
  v_role              public.app_role;
  v_inv_id            uuid;
  v_inv_client        uuid;
  v_inv_org           uuid;
  v_inv_incl          numeric;
  v_inv_rem           numeric;
  v_inv_status        text;
  v_sum_inv           numeric;
  v_cross             integer;
  v_sum_tx            numeric;
  v_count_tx          integer;
  v_primary_allocated boolean;
  v_legacy_primary    boolean;
  v_consistent        boolean;
  v_formalize         boolean := false;
  v_new_rem           numeric(12,2);
  v_new_status        text;
  v_new_primary       uuid;
  v_alloc_id          uuid := gen_random_uuid();
  v_result            jsonb;
  v_check_rem         numeric;
  v_check_status      text;
  v_check_tx          text;
BEGIN
  -- ── 0. Argumenten (nog niets gelezen) ──
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een betaling kan alleen in een READ COMMITTED transactie worden gekoppeld (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _bank_transaction_id IS NULL OR _invoice_type IS NULL OR _invoice_id IS NULL
     OR _amount IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie, factuursoort, factuur, bedrag en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  IF _invoice_type NOT IN ('inkoop', 'verkoop') THEN
    RAISE EXCEPTION 'Onbekende factuursoort; verwacht inkoop of verkoop' USING ERRCODE = '22023';
  END IF;
  -- De typmod van een functieparameter telt in PostgreSQL niet: schaal, NaN en
  -- oneindig worden hier expliciet geweigerd.
  IF _amount = 'NaN'::numeric OR _amount <= 0 OR _amount >= 10000000000
     OR _amount <> round(_amount, 2) THEN
    RAISE EXCEPTION 'Het koppelingsbedrag moet groter dan nul zijn, met hooguit twee decimalen' USING ERRCODE = '22023';
  END IF;
  v_amount := _amount;
  v_hash := md5(concat_ws('|', 'link', _bank_transaction_id::text, _invoice_type, _invoice_id::text, v_amount::text));

  -- ── 1. Grendel A: de bestaande koppeling van dit paar (hooguit één) ──
  PERFORM 1 FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = _bank_transaction_id AND a.invoice_id = _invoice_id
  FOR UPDATE;

  -- ── 2. Grendel T ──
  SELECT * INTO v_tx FROM public.bank_transactions bt
  WHERE bt.id = _bank_transaction_id
  FOR UPDATE;

  -- ── 3. Leesdrempel: één neutrale weigering voor "bestaat niet" en "niet van jou" ──
  IF NOT FOUND OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only')
     OR NOT EXISTS (SELECT 1 FROM public.clients c
                    WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- ── 4. Schrijfdrempel ──
  v_role := public.bank_payment_min_role(_invoice_type, 'link');
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, v_role) THEN
    RAISE EXCEPTION 'Onvoldoende rechten: een %betaling koppelen vereist de rol %',
      CASE _invoice_type WHEN 'inkoop' THEN 'inkoop' ELSE 'verkoop' END, v_role
      USING ERRCODE = '42501';
  END IF;

  -- ── 5. Herhaling: hetzelfde antwoord, of een weigering ──
  SELECT * INTO v_claim FROM public.bank_payment_requests r
  WHERE r.actor_id = v_uid AND r.request_id = _request_id;
  IF FOUND THEN
    IF v_claim.request_kind = 'link' AND v_claim.args_hash = v_hash THEN
      RETURN QUERY SELECT (v_claim.result->>'allocation_id')::uuid,
                          v_claim.result->>'outcome',
                          (v_claim.result->>'invoice_remaining')::numeric,
                          v_claim.result->>'invoice_status',
                          v_claim.result->>'tx_match_status',
                          true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
  END IF;

  -- ── 6. Grendel I ──
  IF _invoice_type = 'inkoop' THEN
    SELECT pi.id, pi.client_id, pi.organization_id, pi.amount_incl, pi.remaining_amount, pi.status
      INTO v_inv_id, v_inv_client, v_inv_org, v_inv_incl, v_inv_rem, v_inv_status
    FROM public.purchase_invoices pi
    WHERE pi.id = _invoice_id
    FOR UPDATE;
  ELSE
    SELECT si.id, si.client_id, si.organization_id, si.amount_incl, si.remaining_amount, si.status
      INTO v_inv_id, v_inv_client, v_inv_org, v_inv_incl, v_inv_rem, v_inv_status
    FROM public.sales_invoices si
    WHERE si.id = _invoice_id
    FOR UPDATE;
  END IF;
  IF v_inv_id IS NULL
     OR v_inv_client IS DISTINCT FROM v_tx.client_id
     OR v_inv_org IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Factuur niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- ── 7. Wat er al staat (na de T-grendel opnieuw gelezen) ──
  SELECT * INTO v_pair FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = _bank_transaction_id AND a.invoice_id = _invoice_id;
  v_pair_found := FOUND;

  SELECT coalesce(sum(a.amount) FILTER (WHERE a.invoice_type = _invoice_type), 0),
         count(*) FILTER (WHERE a.invoice_type <> _invoice_type)
    INTO v_sum_inv, v_cross
  FROM public.bank_transaction_allocations a
  WHERE a.invoice_id = _invoice_id;

  SELECT coalesce(sum(a.amount), 0), count(*),
         coalesce(bool_or(a.invoice_id = v_tx.matched_invoice_id), false)
    INTO v_sum_tx, v_count_tx, v_primary_allocated
  FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = _bank_transaction_id;

  -- Een banktransactie die volgens een oude match (zonder koppelingsrij) aan
  -- een factuur is toegewezen. Het geld kan via die match al zijn ingezet.
  v_legacy_primary := v_tx.match_status = 'gematcht' AND v_tx.matched_invoice_id IS NOT NULL
                      AND NOT v_primary_allocated;

  IF (v_tx.match_status = 'handmatig_geboekt' AND v_count_tx > 0)
     OR (v_tx.match_status = 'gematcht' AND v_tx.matched_invoice_id IS NULL AND v_count_tx = 0)
     OR (v_legacy_primary AND v_tx.matched_invoice_id IS DISTINCT FROM _invoice_id) THEN
    RAISE EXCEPTION 'De matchgegevens van deze banktransactie wijken af van haar koppelingen (oude match zonder koppeling, of gecodeerd én gekoppeld); herstel nodig'
      USING ERRCODE = '23514';
  END IF;

  IF v_cross > 0 THEN
    RAISE EXCEPTION 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig'
      USING ERRCODE = '23514';
  END IF;

  IF v_pair_found THEN
    -- Nooit overschrijven: een ander bedrag of een andere soort is een weigering.
    IF v_pair.invoice_type IS DISTINCT FROM _invoice_type OR v_pair.amount IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION 'Deze banktransactie is al aan deze factuur gekoppeld met een ander bedrag (%); ontkoppel eerst', v_pair.amount
        USING ERRCODE = '23505';
    END IF;
    -- Hetzelfde paar en bedrag: ongewijzigd, mits de factuur aansluit.
    IF v_inv_incl IS NULL OR v_inv_rem IS DISTINCT FROM v_inv_incl - v_sum_inv
       OR (v_inv_status = 'betaald' AND v_sum_inv <> v_inv_incl) THEN
      RAISE EXCEPTION 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig'
        USING ERRCODE = '23514';
    END IF;
    v_result := jsonb_build_object('allocation_id', v_pair.id, 'outcome', 'unchanged',
                                   'invoice_remaining', v_inv_rem, 'invoice_status', v_inv_status,
                                   'tx_match_status', v_tx.match_status);
    BEGIN
      INSERT INTO public.bank_payment_requests
        (actor_id, request_id, request_kind, args_hash, organization_id, client_id, bank_transaction_id, outcome, result)
      VALUES (v_uid, _request_id, 'link', v_hash, v_tx.organization_id, v_tx.client_id, v_tx.id, 'unchanged', v_result);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
    END;
    RETURN QUERY SELECT v_pair.id, 'unchanged'::text, v_inv_rem, v_inv_status, v_tx.match_status, false;
    RETURN;
  END IF;

  -- ── 8. Toestand van een nieuw paar ──
  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling zou haar dubbel boeken'
      USING ERRCODE = '23514';
  END IF;
  IF public.bank_payment_tx_released(v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; koppel haar pas nadat een accountant haar terug naar de werkstroom heeft gezet'
      USING ERRCODE = '23514';
  END IF;
  IF (_invoice_type = 'verkoop' AND v_tx.amount <= 0) OR (_invoice_type = 'inkoop' AND v_tx.amount >= 0) THEN
    RAISE EXCEPTION 'Een verkoopfactuur hoort bij een inkomende en een inkoopfactuur bij een uitgaande banktransactie'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_match_rejections r
             WHERE r.bank_transaction_id = v_tx.id AND r.invoice_type = _invoice_type AND r.invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'Deze factuur is voor deze banktransactie afgewezen; maak de afwijzing eerst ongedaan'
      USING ERRCODE = '23514';
  END IF;
  IF v_inv_incl IS NULL THEN
    RAISE EXCEPTION 'Factuur mist een bedrag inclusief btw; vul dat eerst in' USING ERRCODE = '22004';
  END IF;
  IF v_inv_incl <= 0 THEN
    RAISE EXCEPTION 'Alleen een factuur met een positief bedrag kan worden betaald' USING ERRCODE = '22023';
  END IF;

  -- De factuur sluit aan op haar koppelingen (een NULL-restant zonder
  -- koppelingen telt als afgeleid).
  v_consistent := ((v_inv_rem IS NULL AND v_sum_inv = 0) OR v_inv_rem = v_inv_incl - v_sum_inv)
                  AND (v_inv_status IS DISTINCT FROM 'betaald' OR v_sum_inv = v_inv_incl);
  IF NOT v_consistent AND v_legacy_primary THEN
    -- De oude match van deze transactie vastleggen: alleen als het opgeslagen
    -- restant deze betaling al exact bevat. Het restant verandert dan niet.
    v_formalize := v_inv_rem = v_inv_incl - v_sum_inv - v_amount
                   AND (v_inv_status IS DISTINCT FROM 'betaald' OR v_sum_inv + v_amount = v_inv_incl);
    v_consistent := coalesce(v_formalize, false);
  END IF;
  IF NOT coalesce(v_consistent, false) THEN
    RAISE EXCEPTION 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_tx + v_amount > abs(v_tx.amount) THEN
    RAISE EXCEPTION 'De koppelingen op deze banktransactie (% + %) zouden het transactiebedrag (%) overschrijden', v_sum_tx, v_amount, abs(v_tx.amount)
      USING ERRCODE = '23514';
  END IF;
  IF v_sum_inv + v_amount > v_inv_incl THEN
    RAISE EXCEPTION 'De koppelingen op deze factuur (% + %) zouden het factuurbedrag (%) overschrijden; een overbetaling wordt niet ondersteund', v_sum_inv, v_amount, v_inv_incl
      USING ERRCODE = '23514';
  END IF;

  -- ── 9. Afleiden ──
  v_new_rem := v_inv_incl - v_sum_inv - v_amount;
  v_new_status := CASE WHEN _invoice_type = 'verkoop' AND v_new_rem = 0 AND v_inv_status = 'gecontroleerd'
                       THEN 'betaald' ELSE v_inv_status END;
  v_new_primary := CASE WHEN v_tx.matched_invoice_id IS NOT NULL AND v_primary_allocated
                        THEN v_tx.matched_invoice_id ELSE _invoice_id END;
  v_result := jsonb_build_object('allocation_id', v_alloc_id, 'outcome', 'created',
                                 'invoice_remaining', v_new_rem, 'invoice_status', v_new_status,
                                 'tx_match_status', 'gematcht');

  -- ── 10. Claim, als eerste schrijfactie ──
  BEGIN
    INSERT INTO public.bank_payment_requests
      (actor_id, request_id, request_kind, args_hash, organization_id, client_id, bank_transaction_id, outcome, result)
    VALUES (v_uid, _request_id, 'link', v_hash, v_tx.organization_id, v_tx.client_id, v_tx.id, 'created', v_result);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
  END;

  -- ── 11. Schrijven, in één transactie ──
  PERFORM set_config('boekassist.betaalschrijver', pg_current_xact_id()::text, true);

  INSERT INTO public.bank_payment_events
    (actor_id, request_id, event_type, allocation_id, bank_transaction_id, invoice_type, invoice_id,
     organization_id, client_id, amount, remaining_before, remaining_after,
     status_before, status_after, invoice_amount, tx_status_before, tx_status_after, formalized)
  VALUES
    (v_uid, _request_id, 'linked', v_alloc_id, v_tx.id, _invoice_type, _invoice_id,
     v_tx.organization_id, v_tx.client_id, v_amount, v_inv_rem, v_new_rem,
     v_inv_status, v_new_status, v_inv_incl, v_tx.match_status, 'gematcht', v_formalize);

  INSERT INTO public.bank_transaction_allocations
    (id, bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount, user_id, created_by)
  VALUES
    (v_alloc_id, v_tx.id, _invoice_type, _invoice_id, v_tx.client_id, v_tx.organization_id, v_amount, v_tx.user_id, v_uid);

  IF _invoice_type = 'inkoop' THEN
    UPDATE public.purchase_invoices SET remaining_amount = v_new_rem
    WHERE id = _invoice_id
    RETURNING remaining_amount, status INTO v_check_rem, v_check_status;
  ELSE
    UPDATE public.sales_invoices SET remaining_amount = v_new_rem, status = v_new_status
    WHERE id = _invoice_id
    RETURNING remaining_amount, status INTO v_check_rem, v_check_status;
  END IF;

  UPDATE public.bank_transactions
  SET match_status = 'gematcht', matched_invoice_id = v_new_primary, match_confidence = 100
  WHERE id = v_tx.id
  RETURNING match_status INTO v_check_tx;

  PERFORM set_config('boekassist.betaalschrijver', '', true);

  IF v_check_rem IS DISTINCT FROM v_new_rem OR v_check_status IS DISTINCT FROM v_new_status
     OR v_check_tx IS DISTINCT FROM 'gematcht' THEN
    RAISE EXCEPTION 'Interne fout: de betaalschrijver kon de afgeleide toestand niet vastleggen' USING ERRCODE = 'XX000';
  END IF;
  PERFORM public.bank_payment_assert_consistent(_invoice_type, _invoice_id, v_tx.id);

  RETURN QUERY SELECT v_alloc_id, 'created'::text, v_new_rem::numeric, v_new_status, 'gematcht'::text, false;
END;
$$;

REVOKE ALL ON FUNCTION public.link_bank_payment(uuid, text, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_bank_payment(uuid, text, uuid, numeric, uuid) TO authenticated;

COMMENT ON FUNCTION public.link_bank_payment(uuid, text, uuid, numeric, uuid) IS
'Betaalschrijver (D1): koppelt een banktransactie aan een factuur voor een bedrag, atomair: koppeling (user_id = eigenaar van T, created_by = actor), restant = factuurbedrag − Σ koppelingen, verkoop betaald alleen bij restant 0 en status gecontroleerd, matchvelden van T, claim (actor, request_id) en auditspoor. Grendels A(paar) → T → factuur, FOR UPDATE. Weigert neutraal (42501) bij een andere tenant; 23505 als het paar al met een ander bedrag bestaat (nooit overschrijven); 23514 bij geboekte of vrijgegeven T, afwijzing, over-allocatie of een afwijkend restant ("herstel nodig"); 22023 bij richting, ongeldig bedrag of hergebruikte request_id; 22004 bij een onbekend factuurbedrag.';

-- ── 9. De betaalschrijver: ontkoppelen ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.unlink_bank_payment(
  _bank_transaction_id uuid,
  _request_id          uuid,
  _allocation_id       uuid DEFAULT NULL
)
RETURNS TABLE (
  outcome         text,
  removed_count   integer,
  tx_match_status text,
  replayed        boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               uuid := auth.uid();
  v_hash              text;
  v_ids               uuid[] := '{}';
  v_ids_now           uuid[];
  v_tx                public.bank_transactions%ROWTYPE;
  v_claim             public.bank_payment_requests%ROWTYPE;
  v_role              public.app_role;
  v_count_tx          integer;
  v_primary_allocated boolean;
  r                   record;
  v_plan              jsonb := '[]'::jsonb;
  v_item              jsonb;
  v_inv_id            uuid;
  v_inv_client        uuid;
  v_inv_org           uuid;
  v_inv_incl          numeric;
  v_inv_rem           numeric;
  v_inv_status        text;
  v_sum_inv           numeric;
  v_cross             integer;
  v_new_rem           numeric(12,2);
  v_new_status        text;
  v_new_tx_status     text;
  v_new_primary       uuid;
  v_new_conf          numeric;
  v_count             integer;
  v_deleted           integer;
  v_result            jsonb;
  v_check_rem         numeric;
  v_check_status      text;
  v_check_tx          text;
BEGIN
  -- ── 0. Argumenten ──
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een betaling kan alleen in een READ COMMITTED transactie worden ontkoppeld (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _bank_transaction_id IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  v_hash := md5(concat_ws('|', 'unlink', _bank_transaction_id::text, coalesce(_allocation_id::text, '*')));

  -- ── 1. Grendel A: de te ontkoppelen koppelingen, in id-volgorde ──
  FOR r IN
    SELECT a.id FROM public.bank_transaction_allocations a
    WHERE a.bank_transaction_id = _bank_transaction_id
      AND (_allocation_id IS NULL OR a.id = _allocation_id)
    ORDER BY a.id
    FOR UPDATE
  LOOP
    v_ids := v_ids || r.id;
  END LOOP;

  -- ── 2. Grendel T ──
  SELECT * INTO v_tx FROM public.bank_transactions bt
  WHERE bt.id = _bank_transaction_id
  FOR UPDATE;

  -- ── 3. Leesdrempel ──
  IF NOT FOUND OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only')
     OR NOT EXISTS (SELECT 1 FROM public.clients c
                    WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- Kwam er tussen de A- en de T-grendel een koppeling bij? Die nu nog grendelen
  -- zou A ná T nemen (deadlockrisico tegen post_bank_allocation): weigeren.
  SELECT coalesce(array_agg(a.id ORDER BY a.id), '{}') INTO v_ids_now
  FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = _bank_transaction_id
    AND (_allocation_id IS NULL OR a.id = _allocation_id);
  IF v_ids_now IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'De koppelingen van deze banktransactie zijn intussen gewijzigd; ververs en probeer opnieuw'
      USING ERRCODE = '55000';
  END IF;

  -- ── 4. Schrijfdrempel: de strengste vloer over de betrokken soorten ──
  SELECT x.r INTO v_role
  FROM (SELECT DISTINCT public.bank_payment_min_role(a.invoice_type, 'unlink') AS r
        FROM public.bank_transaction_allocations a WHERE a.id = ANY (v_ids)) x
  ORDER BY public.role_rank(x.r) DESC
  LIMIT 1;
  v_role := coalesce(v_role, public.bank_payment_min_role('inkoop', 'unlink'));
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, v_role) THEN
    RAISE EXCEPTION 'Onvoldoende rechten: deze koppeling verwijderen vereist de rol %', v_role
      USING ERRCODE = '42501';
  END IF;

  -- ── 5. Herhaling ──
  SELECT * INTO v_claim FROM public.bank_payment_requests rq
  WHERE rq.actor_id = v_uid AND rq.request_id = _request_id;
  IF FOUND THEN
    IF v_claim.request_kind = 'unlink' AND v_claim.args_hash = v_hash THEN
      RETURN QUERY SELECT v_claim.result->>'outcome',
                          (v_claim.result->>'removed_count')::integer,
                          v_claim.result->>'tx_match_status',
                          true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
  END IF;

  -- ── 6. Toestand ──
  SELECT count(*), coalesce(bool_or(a.invoice_id = v_tx.matched_invoice_id), false)
    INTO v_count_tx, v_primary_allocated
  FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = v_tx.id;

  -- Een oude match zonder koppelingsrij: ontkoppelen zou de via die match
  -- betaalde factuur stil heropenen of haar betaling verweesd laten staan.
  IF (v_tx.match_status = 'gematcht' AND v_count_tx = 0)
     OR (v_tx.match_status = 'gematcht' AND v_tx.matched_invoice_id IS NOT NULL AND NOT v_primary_allocated)
     OR (v_tx.match_status = 'handmatig_geboekt' AND v_count_tx > 0) THEN
    RAISE EXCEPTION 'De matchgegevens van deze banktransactie wijken af van haar koppelingen (oude match zonder koppeling, of gecodeerd én gekoppeld); herstel nodig'
      USING ERRCODE = '23514';
  END IF;

  IF cardinality(v_ids) = 0 THEN
    v_result := jsonb_build_object('outcome', 'unchanged', 'removed_count', 0, 'tx_match_status', v_tx.match_status);
    BEGIN
      INSERT INTO public.bank_payment_requests
        (actor_id, request_id, request_kind, args_hash, organization_id, client_id, bank_transaction_id, outcome, result)
      VALUES (v_uid, _request_id, 'unlink', v_hash, v_tx.organization_id, v_tx.client_id, v_tx.id, 'unchanged', v_result);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
    END;
    RETURN QUERY SELECT 'unchanged'::text, 0, v_tx.match_status, false;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is ook rechtstreeks in het grootboek geboekt; herstel nodig'
      USING ERRCODE = '23514';
  END IF;
  IF public.bank_payment_tx_released(v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; haar matchgegevens wijzigen alleen via een accountant'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_allocation_postings p WHERE p.allocation_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'Deze koppeling is al als aflettering in het grootboek geboekt; ontkoppelen kan niet, ook niet na een tegenboeking (ontwerpbesluit A1-17)'
      USING ERRCODE = '23514';
  END IF;

  -- ── 7. Grendel I's in (soort, id)-volgorde, en het plan per factuur ──
  -- Per banktransactie bestaat elk factuur-id hooguit één keer (unieke index),
  -- dus elke factuur hoort hier bij precies één koppeling.
  FOR r IN
    SELECT a.id, a.invoice_type, a.invoice_id, a.amount
    FROM public.bank_transaction_allocations a
    WHERE a.id = ANY (v_ids)
    ORDER BY a.invoice_type, a.invoice_id
  LOOP
    v_inv_id := NULL;
    IF r.invoice_type = 'inkoop' THEN
      SELECT pi.id, pi.client_id, pi.organization_id, pi.amount_incl, pi.remaining_amount, pi.status
        INTO v_inv_id, v_inv_client, v_inv_org, v_inv_incl, v_inv_rem, v_inv_status
      FROM public.purchase_invoices pi
      WHERE pi.id = r.invoice_id
      FOR UPDATE;
    ELSE
      SELECT si.id, si.client_id, si.organization_id, si.amount_incl, si.remaining_amount, si.status
        INTO v_inv_id, v_inv_client, v_inv_org, v_inv_incl, v_inv_rem, v_inv_status
      FROM public.sales_invoices si
      WHERE si.id = r.invoice_id
      FOR UPDATE;
    END IF;
    IF v_inv_id IS NULL
       OR v_inv_client IS DISTINCT FROM v_tx.client_id
       OR v_inv_org IS DISTINCT FROM v_tx.organization_id THEN
      RAISE EXCEPTION 'Deze koppeling verwijst naar een factuur die niet (meer) bij deze administratie bestaat; herstel nodig'
        USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(sum(a.amount) FILTER (WHERE a.invoice_type = r.invoice_type), 0),
           count(*) FILTER (WHERE a.invoice_type <> r.invoice_type)
      INTO v_sum_inv, v_cross
    FROM public.bank_transaction_allocations a
    WHERE a.invoice_id = r.invoice_id;

    IF v_cross > 0 OR v_inv_incl IS NULL OR v_inv_rem IS DISTINCT FROM v_inv_incl - v_sum_inv
       OR (v_inv_status = 'betaald' AND v_sum_inv <> v_inv_incl) THEN
      RAISE EXCEPTION 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig'
        USING ERRCODE = '23514';
    END IF;

    v_new_rem := v_inv_incl - (v_sum_inv - r.amount);
    v_new_status := v_inv_status;
    IF v_inv_status = 'betaald' AND v_new_rem > 0 THEN
      IF r.invoice_type = 'verkoop' THEN
        v_new_status := 'gecontroleerd';
      ELSE
        -- Een betaling zet een inkoopfactuur nooit op betaald; deze status is
        -- van vóór de betaalschrijver en wordt niet geraden.
        RAISE EXCEPTION 'Deze inkoopfactuur heeft de oude status betaald; herstel nodig voordat zij kan worden ontkoppeld'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    v_plan := v_plan || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'type', r.invoice_type, 'invoice', r.invoice_id, 'amount', r.amount,
      'rb', v_inv_rem, 'ra', v_new_rem, 'sb', v_inv_status, 'sa', v_new_status, 'incl', v_inv_incl));
  END LOOP;

  -- De banktransactie na afloop: de primaire factuur blijft als zij gekoppeld
  -- blijft, anders de oudste overgebleven koppeling; zonder koppelingen leeg.
  SELECT a.invoice_id INTO v_new_primary
  FROM public.bank_transaction_allocations a
  WHERE a.bank_transaction_id = v_tx.id AND a.id <> ALL (v_ids)
  ORDER BY (a.invoice_id IS NOT DISTINCT FROM v_tx.matched_invoice_id) DESC, a.created_at, a.id
  LIMIT 1;
  IF FOUND THEN
    v_new_tx_status := 'gematcht';
    v_new_conf := coalesce(v_tx.match_confidence, 100);
  ELSE
    v_new_tx_status := 'niet_gematcht';
    v_new_primary := NULL;
    v_new_conf := NULL;
  END IF;

  v_count := cardinality(v_ids);
  v_result := jsonb_build_object('outcome', 'unlinked', 'removed_count', v_count, 'tx_match_status', v_new_tx_status);

  -- ── 8. Claim, als eerste schrijfactie ──
  BEGIN
    INSERT INTO public.bank_payment_requests
      (actor_id, request_id, request_kind, args_hash, organization_id, client_id, bank_transaction_id, outcome, result)
    VALUES (v_uid, _request_id, 'unlink', v_hash, v_tx.organization_id, v_tx.client_id, v_tx.id, 'unlinked', v_result);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag' USING ERRCODE = '22023';
  END;

  -- ── 9. Schrijven ──
  PERFORM set_config('boekassist.betaalschrijver', pg_current_xact_id()::text, true);

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    INSERT INTO public.bank_payment_events
      (actor_id, request_id, event_type, allocation_id, bank_transaction_id, invoice_type, invoice_id,
       organization_id, client_id, amount, remaining_before, remaining_after,
       status_before, status_after, invoice_amount, tx_status_before, tx_status_after)
    VALUES
      (v_uid, _request_id, 'unlinked', (v_item->>'id')::uuid, v_tx.id, v_item->>'type', (v_item->>'invoice')::uuid,
       v_tx.organization_id, v_tx.client_id, (v_item->>'amount')::numeric, (v_item->>'rb')::numeric, (v_item->>'ra')::numeric,
       v_item->>'sb', v_item->>'sa', (v_item->>'incl')::numeric, v_tx.match_status, v_new_tx_status);
  END LOOP;

  DELETE FROM public.bank_transaction_allocations a WHERE a.id = ANY (v_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    IF v_item->>'type' = 'inkoop' THEN
      UPDATE public.purchase_invoices SET remaining_amount = (v_item->>'ra')::numeric
      WHERE id = (v_item->>'invoice')::uuid
      RETURNING remaining_amount, status INTO v_check_rem, v_check_status;
    ELSE
      UPDATE public.sales_invoices SET remaining_amount = (v_item->>'ra')::numeric, status = v_item->>'sa'
      WHERE id = (v_item->>'invoice')::uuid
      RETURNING remaining_amount, status INTO v_check_rem, v_check_status;
    END IF;
    IF v_check_rem IS DISTINCT FROM (v_item->>'ra')::numeric OR v_check_status IS DISTINCT FROM v_item->>'sa' THEN
      RAISE EXCEPTION 'Interne fout: de betaalschrijver kon de afgeleide toestand niet vastleggen' USING ERRCODE = 'XX000';
    END IF;
  END LOOP;

  UPDATE public.bank_transactions
  SET match_status = v_new_tx_status, matched_invoice_id = v_new_primary, match_confidence = v_new_conf
  WHERE id = v_tx.id
  RETURNING match_status INTO v_check_tx;

  PERFORM set_config('boekassist.betaalschrijver', '', true);

  IF v_deleted <> v_count OR v_check_tx IS DISTINCT FROM v_new_tx_status THEN
    RAISE EXCEPTION 'Interne fout: de betaalschrijver kon de afgeleide toestand niet vastleggen' USING ERRCODE = 'XX000';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    PERFORM public.bank_payment_assert_consistent(v_item->>'type', (v_item->>'invoice')::uuid, v_tx.id);
  END LOOP;

  RETURN QUERY SELECT 'unlinked'::text, v_count, v_new_tx_status, false;
END;
$$;

REVOKE ALL ON FUNCTION public.unlink_bank_payment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_bank_payment(uuid, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.unlink_bank_payment(uuid, uuid, uuid) IS
'Betaalschrijver (D1): verwijdert alle koppelingen van een banktransactie, of precies één (_allocation_id), atomair: restant = factuurbedrag − Σ resterende koppelingen, verkoop betaald → gecontroleerd zodra er weer iets openstaat, matchvelden van T, claim en auditspoor. Grendels A (id-volgorde) → T → facturen (soort, id), FOR UPDATE; 55000 als er tussen A en T een koppeling bijkwam. Weigert een geboekte (ook tegengeboekte) koppeling, een oude match zonder koppelingsrij en een afwijkend restant (23514, "herstel nodig"). Rolvloer: bank_payment_min_role(soort, ''unlink'').';
