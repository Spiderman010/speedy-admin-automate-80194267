-- STAP 1: Snapshot-tabellen
CREATE TABLE IF NOT EXISTS grootboekrekeningen_backup_20260420 AS 
  SELECT * FROM grootboekrekeningen;

CREATE TABLE IF NOT EXISTS bank_tx_grootboek_backup_20260420 AS 
  SELECT id, grootboekrekening_id 
  FROM bank_transactions 
  WHERE grootboekrekening_id IS NOT NULL;

-- STAP 2: Remap bank_transactions van 1010 Kruisposten -> 1200 Kruisposten
UPDATE bank_transactions bt
SET grootboekrekening_id = (
  SELECT g_new.id 
  FROM grootboekrekeningen g_new 
  WHERE g_new.nummer = 1200 
    AND g_new.user_id = bt.user_id 
  ORDER BY g_new.created_at ASC 
  LIMIT 1
),
updated_at = now()
WHERE bt.grootboekrekening_id IN (
  SELECT id FROM grootboekrekeningen WHERE nummer = 1010
);

-- STAP 3: Voeg ontbrekende SnelStart 12 standaardrekeningen toe per (user_id, client_id)
WITH snelstart_missing(nummer, omschrijving, categorie) AS (VALUES
  (1201, 'Betaalwijze contant', 'activa'),
  (1202, 'PIN betalingen', 'activa'),
  (1203, 'Betaalwijze elektronisch', 'activa'),
  (1305, 'Oninbare debiteuren', 'activa'),
  (1454, 'Overige vorderingen', 'activa'),
  (1460, 'Vooruitbetaalde facturen', 'activa'),
  (1483, 'Te factureren omzet', 'activa'),
  (1485, 'Overige overlopende activa', 'activa'),
  (1611, 'Te betalen bedragen', 'passiva'),
  (1670, 'Btw af te dragen laag (verkopen)', 'passiva'),
  (1671, 'Btw af te dragen hoog (verkopen)', 'passiva'),
  (1672, 'Btw af te dragen overig (verkopen)', 'passiva'),
  (1673, 'Btw af te dragen verlegd (verkopen)', 'passiva'),
  (1674, 'Btw te vorderen verlegd (verkopen)', 'passiva'),
  (1675, 'Btw-prive af te dragen', 'passiva'),
  (1679, 'Btw te vorderen laag (inkopen)', 'passiva'),
  (1680, 'Btw te vorderen hoog (inkopen)', 'passiva'),
  (1681, 'Btw te vorderen overig (inkopen)', 'passiva'),
  (1682, 'Btw af te dragen verlegd (inkopen)', 'passiva'),
  (1683, 'Btw te vorderen verlegd (inkopen)', 'passiva'),
  (1684, 'Btw afdracht', 'passiva'),
  (1685, 'Te betalen btw vorige jaren', 'passiva'),
  (1687, 'Te betalen loonheffing', 'passiva'),
  (1745, 'Overige schulden', 'passiva'),
  (2000, 'Tussenrekeningen betalingen', 'passiva'),
  (2010, 'Tussenrekening balans', 'passiva'),
  (2011, 'Tussenrekening memoriaal', 'passiva'),
  (9998, 'Resultaat', 'passiva'),
  (9999, 'Mutatie fiscale oudedagsreserve', 'passiva')
)
INSERT INTO grootboekrekeningen (user_id, client_id, nummer, omschrijving, categorie, actief)
SELECT DISTINCT u.user_id, u.client_id, sm.nummer, sm.omschrijving, sm.categorie, true
FROM (SELECT DISTINCT user_id, client_id FROM grootboekrekeningen) u
CROSS JOIN snelstart_missing sm
WHERE NOT EXISTS (
  SELECT 1 FROM grootboekrekeningen g
  WHERE g.user_id = u.user_id 
    AND g.nummer = sm.nummer
    AND g.client_id IS NOT DISTINCT FROM u.client_id
);

-- STAP 4: Deactiveer duplicaten per (user_id, client_id, nummer)
WITH ranked AS (
  SELECT g.id,
    ROW_NUMBER() OVER (
      PARTITION BY g.user_id, g.client_id, g.nummer 
      ORDER BY 
        (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.grootboekrekening_id = g.id) DESC,
        g.created_at ASC
    ) AS rn
  FROM grootboekrekeningen g
)
UPDATE grootboekrekeningen
SET actief = false, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- STAP 5: Deactiveer oude niet-SnelStart rekeningen zonder transactie-referenties
UPDATE grootboekrekeningen
SET actief = false, updated_at = now()
WHERE nummer IN (
  20, 21, 30, 31,
  100, 110, 111, 120, 121,
  200, 201, 210, 211, 220, 221, 230, 231, 240, 241,
  300, 310, 320,
  400, 410, 420, 430, 490,
  500, 510, 520, 530, 540, 550, 560,
  600, 610, 620, 630, 640,
  1010
)
AND id NOT IN (
  SELECT grootboekrekening_id FROM bank_transactions WHERE grootboekrekening_id IS NOT NULL
);