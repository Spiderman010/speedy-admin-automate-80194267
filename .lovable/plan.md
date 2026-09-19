# Inkoopwerkbank: compacte drieluik-layout

## Doel
De bestaande Inkoopwerkbank wordt een rustige, informatie-dichte werkplek waarin wachtrij, boekingsgegevens en brondocument tegelijk te beoordelen zijn. Alle bestaande data, validaties, statussen en acties blijven ongewijzigd.

## Wijzigingen
- Voeg links een compacte factuurwachtrij toe op basis van de al geladen inkoopfacturen, met leverancier, nummer, datum, bedrag en bestaande status; de actieve factuur krijgt een duidelijke selectie-indicatie.
- Herschik de desktopweergave naar drie functionele zones: wachtrij links, boekingsformulier en regels in het midden, documentpreview rechts.
- Maak factuurgegevens, boekingsregels, totalen en boekbaarheidsmelding compacter door minder verticale tussenruimte en een duidelijkere visuele groepering.
- Houd de bestaande factuuridentiteit bovenaan zichtbaar met leverancier, nummer, datum, totaal en status.
- Houd bestaande acties onderaan sticky; voeg geen nieuwe actie toe en wijzig geen bestaande voorwaarden of afhandeling.
- Behoud een bruikbare responsive weergave: op kleinere schermen verdwijnt de vaste zij-aan-zij-indeling en blijven formulier, regels en document logisch gestapeld en horizontaal bruikbaar.

## Bestanden binnen scope
- `src/pages/PurchaseInvoiceWorkspace.tsx`
- Inkoop-specifieke presentatiecomponenten onder `src/components/purchase/`
- Gerichte Inkoopwerkbank UI-tests onder `src/test/`

## Buiten scope
- Geen hooks, bedragen, BTW, accountmapping, readiness, statusovergangen of postinggedrag wijzigen.
- Geen accounting-, ledger-, reversal- of correctiebestanden wijzigen.
- Geen database, SQL, migraties, RLS, RPC's, gegenereerde types of dependencies wijzigen.
- Geen gedeelde shell of andere pagina's herontwerpen.

## Technische details
- De wachtrij gebruikt uitsluitend `usePurchaseInvoices` en bestaande navigatie naar `/facturen/inkoop/:id`.
- Nieuwe code blijft puur presentational; afgeleide labels en sortering volgen de reeds geladen facturen en bestaande statuswaarden.
- Desktop krijgt stabiele kolombreedtes en onafhankelijke verticale bruikbaarheid voor wachtrij en document; mobiel houdt de bestaande formulierflow.
- De huidige action handlers en gate-booleans worden ongewijzigd doorgegeven.

## Validatie
- Gerichte UI-tests controleren wachtrij-inhoud, actieve rij, navigatie, drieluik-layout en behoud van bestaande acties.
- Daarna: `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, `git diff --check`.
- Diffcontrole bevestigt dat alleen Inkoop-UI en gerichte tests gewijzigd zijn.
- Na validatie wordt een PR naar `main` geopend en niet gemerged.
