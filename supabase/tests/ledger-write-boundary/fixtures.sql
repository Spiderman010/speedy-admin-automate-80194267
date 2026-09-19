-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Stamgegevens voor het schrijfdeur-bewijs. Het schema zelf komt uit
-- ../opening-balance/bootstrap.sql; hier staat alleen wie er is en wat er is.
--
-- Bewust klein: dit harnas bewijst een RECHT, geen boekhoudscenario. Eén
-- organisatie met een tweede ernaast (om de tenantscheiding te kunnen toetsen),
-- één gebruiker met de rol `accountant`, twee administraties en twee
-- grootboekrekeningen — meer heeft geen van de negen bewijzen nodig.

SET client_min_messages = warning;

INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org B');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'acc1@test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1');

-- `accountant`, niet `owner`: ruim boven de vloer van elke boekingsfunctie, dus
-- een geweigerde INSERT kan nooit aan een te lage rol worden toegeschreven.
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'accountant');

INSERT INTO public.clients (id, organization_id, name, afgesloten_boekjaar) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Klant 1', NULL),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Klant 2', NULL);

INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', NULL, 1200, 'Bank',        'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', NULL, 1600, 'Crediteuren', 'passiva', true);
