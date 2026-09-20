# Bankboekingen zichtbaar maken in de rapportages

## Wat ik heb gevonden

Bij AA-Secure staan 342 bankregels (2023 t/m 2025) op "Handmatig geboekt" en alle 342 hebben een grootboekrekening. Toch staat er voor deze administratie geen enkele regel in het grootboek, en de rapportages lezen uitsluitend het grootboek.

De oorzaak: "Handmatig geboekt" in het bankscherm legt alleen vast *welke rekening* jij bij die bankregel kiest. Er bestaat op dit moment geen functie die zo'n bankregel daadwerkelijk als boeking (bank tegen de gekozen rekening) wegschrijft. Alleen bankregels die aan een in- of verkoopfactuur zijn gekoppeld hebben zo'n boekingsfunctie; direct gecodeerde bankregels hebben die nooit gehad. Daarom blijft het scherm zeggen "geboekt", terwijl de rapportages leeg blijven.

De instellingen van AA-Secure zijn wél compleet (bank-, debiteuren-, crediteuren- en beide BTW-rekeningen zijn ingesteld), dus zodra de boekingsfunctie er is, kan deze administratie direct verwerkt worden.

## Wat ik ga bouwen

### 1. BTW per bankregel
Een BTW-percentage per bankregel (21 / 9 / 0 / geen), in te vullen in het bankscherm naast de grootboekrekening. Boekingssjablonen die al een BTW-percentage hebben, vullen dit automatisch in. Bij BTW-vrijgestelde administraties blijft het veld leeg en wordt er geen BTW geboekt.

### 2. Echte boeking van een bankregel
Een nieuwe serverfunctie zet één bankregel in het grootboek:
- bedrag af → gekozen rekening debet (netto) + BTW te vorderen debet, bank credit
- bedrag bij → bank debet, gekozen rekening credit (netto) + BTW te betalen credit
Datum, boekjaar en bedrag komen altijd van de bankregel zelf; de frontend rekent niets uit. Elke bankregel kan maar één keer geboekt worden, en een geboekte regel kan daarna niet meer gewijzigd worden (zelfde bescherming als bij facturen).

### 3. Knop in het bankscherm
Per bankregel en voor een selectie van regels: "Boeken in grootboek", met een duidelijke markering welke regels al geboekt zijn. Regels zonder rekening of met een onvolledige administratie-instelling geven de reden waarom ze nog niet geboekt kunnen worden.

### 4. Inhaalactie per jaar
De bestaande inhaalpagina (Historisch boeken) krijgt bankregels erbij: kies een jaar, zie hoeveel regels boekbaar zijn en boek ze in één run. Hiermee haal je de 342 regels van AA-Secure alsnog op.

## Technisch

- Migratie 1: `bank_transactions.btw_percentage numeric null` (additief).
- Migratie 2: markertabel `bank_transaction_postings` (transactie-id uniek, posting_group_id, org/client/user, created_at) met GRANTs, RLS op organisatielidmaatschap, en INSERT/UPDATE/DELETE geweigerd — identiek aan `bank_allocation_postings`.
- Migratie 3: `post_bank_transaction(_transaction_id uuid)` security definer, in dezelfde stijl als `post_bank_allocation`: client-lock, rolcheck (`has_min_role` accountant), org-check, statuscheck (`handmatig_geboekt` zonder allocatieregels), rekening- en bedragvalidatie, BTW-splitsing op basis van `btw_percentage`, marker-insert, Nederlandse foutmeldingen. Plus `enforce_bank_transaction_source_claim`-trigger en mutatieblokkade op geboekte regels.
- Frontend: `src/pages/Bank.tsx` (BTW-veld, boekknop, statusindicatie), nieuwe hook `useBankTransactionPosting.ts` (alleen RPC + invalidatie), uitbreiding `src/lib/ledger-catchup.ts` + `useLedgerCatchup.ts` + `src/pages/GrootboekHistorisch.tsx` met bron "bank".
- Tests: postingregels (debet/credit-richting, BTW-splitsing, dubbelboeking geweigerd), catch-up-beoordeling, en UI-tests voor de boekknop.
- Buiten scope: bestaande factuur- en afletterboekingen, rapportagelogica, snelstart-export.
