-- NEGATIEVE CONTROLE — VÓÓR PR 0. Throwaway database only.
--
-- Draait op de echte keten t/m 20261010120000, zonder 20261017120000.
--   N1–N4  dezelfde vier aanvallen die proof.sql straks herhaalt: zonder PR 0
--          lukt elke poging en staat de bank twee keer geboekt. De aanval
--          draait zichzelf altijd terug (proof.attack), dus de database is na
--          afloop onveranderd (N5).
--   N6     de omgekeerde volgorde was al beschermd door de schrijver zelf.
--   N7     legacy: een koppeling op een direct geboekte transactie, aangemaakt
--          vóór PR 0 en BLIJVEND — zo kan een productiedatabase er vandaag al
--          uitzien. PR 0 corrigeert dat niet; proof.sql bewijst dat zij niet
--          meer geboekt kan worden.
--   (De nulmeting vlak vóór de migratie staat in snapshot.sql.)

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- Testobjecten voor de aanvallen. Dezelfde objecten worden ná PR 0 opnieuw
-- aangevallen: de aanval laat niets achter, dus het is letterlijk dezelfde test.
SELECT proof.tx(1, -100.00), proof.purchase(1, 100.00);                       -- insert
SELECT proof.tx(2, -100.00), proof.purchase(2, 100.00), proof.tx(3, -100.00);  -- repoint
SELECT proof.tx(4, -100.00), proof.purchase(4, 100.00);                       -- Facturen
SELECT proof.tx(5,  100.00), proof.sales(5, 100.00);                          -- Verkoop

CREATE TABLE proof.state (key text PRIMARY KEY, value text);
INSERT INTO proof.state VALUES ('digest_before_attacks', proof.digest());

SELECT proof.record('N1', 'zonder PR 0: direct boeken, dan een koppeling INSERTen en boeken → bank twee keer geboekt',
  o LIKE 'dubbel: 2 bankregels, netto -200.00%', o)
FROM proof.attack('insert', proof.uid(1000, 1), proof.uid(2000, 1)) o;

SELECT proof.record('N2', 'zonder PR 0: een ongeboekte koppeling met UPDATE naar een direct geboekte transactie verplaatsen → twee keer geboekt',
  o LIKE 'dubbel: 2 bankregels, netto -200.00%', o)
FROM proof.attack('repoint', proof.uid(1000, 2), proof.uid(2000, 2), proof.uid(1000, 3)) o;

SELECT proof.record('N3', 'zonder PR 0: de schrijfvolgorde van Facturen (koppeling eerst, bankwijziging geweigerd) laat een boekbare koppeling achter → twee keer geboekt',
  o LIKE 'dubbel: 2 bankregels, netto -200.00 op de bankrekening; banktransactie bijwerken geweigerd [42501]', o)
FROM proof.attack('facturen', proof.uid(1000, 4), proof.uid(2000, 4)) o;

SELECT proof.record('N4', 'zonder PR 0: dezelfde volgorde vanuit Verkoop met een verkoopfactuur → twee keer geboekt',
  o LIKE 'dubbel: 2 bankregels, netto 200.00 op de bankrekening; banktransactie bijwerken geweigerd [42501]', o)
FROM proof.attack('verkoop', proof.uid(1000, 5), proof.uid(3000, 5)) o;

SELECT proof.expect_true('N5', 'de aanvallen draaien zichzelf volledig terug: data onveranderd',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_attacks') $$);

-- N6: eerst een koppeling, dan direct boeken — dat weigerde de schrijver al.
SELECT proof.tx(6, -40.00), proof.purchase(6, 40.00);
SELECT proof.alloc(6, proof.uid(1000, 6), 'inkoop', proof.uid(2000, 6), 40.00);
SELECT proof.expect_error('N6', 'zonder PR 0 al beschermd: een transactie met koppeling direct boeken wordt door de schrijver geweigerd',
  $$ SELECT proof.post_direct(proof.uid(1000, 6)) $$, '22023', 'aan een factuur gekoppeld');

-- N7: legacy — een koppeling op een direct geboekte transactie, BLIJVEND.
SELECT proof.tx(9, -80.00), proof.purchase(9, 80.00);
SELECT proof.post_direct(proof.uid(1000, 9));
SELECT proof.alloc(9, proof.uid(1000, 9), 'inkoop', proof.uid(2000, 9), 80.00);
SELECT proof.expect_true('N7', 'legacy-toestand staat: transactie 9 direct geboekt én een (nog ongeboekte) koppeling erop',
  $$ proof.routes(proof.uid(1000, 9)) = 'direct'
     AND EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE id = proof.uid(4000, 9)) $$);
