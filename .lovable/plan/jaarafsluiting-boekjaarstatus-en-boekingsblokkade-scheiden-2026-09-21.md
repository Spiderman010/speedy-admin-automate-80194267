# Jaarafsluiting: boekjaarstatus en boekingsblokkade scheiden

## Doel
De bestaande Jaarafsluiting-pagina verduidelijken zonder boekhoudkundige logica of gegevensopslag te wijzigen. Boekjaarstatus, boekingsblokkade, gereedheidscontrole en historie worden afzonderlijke, compacte onderdelen.

## Implementatie
1. **Bestaande bediening behouden**
   - Administratie- en boekjaarkeuze blijven bovenaan.
   - De bestaande gereedheidscontrole, controles, waarschuwingen, blokkades en echte afsluitactie blijven functioneel en behouden hun beveiligingen en test-id's.
   - De bestaande afsluitactie blijft alleen verschijnen wanneer de huidige gereedheids- en rechtencontroles dat toestaan.

2. **Boekjaarstatus**
   - Voeg een compacte kaart toe met boekjaar, statusbadge en echte afsluitgegevens wanneer een bestaand afsluitbewijs beschikbaar is.
   - Open jaren tonen “Open”; afgesloten jaren tonen “Afgesloten”.
   - Een open en gereed jaar gebruikt de bestaande echte actie “Boekjaar afsluiten”.
   - De bestaande afsluitbevestiging en waarschuwingen blijven ongewijzigd, omdat de huidige technische afsluiting nog onomkeerbaar is.
   - Nabij de echte actie staat tijdelijk: “Let op: de huidige technische jaarafsluiting kan nog niet worden heropend. Heropenen wordt toegevoegd zodra de nieuwe jaarcyclus is geïmplementeerd.”
   - Een afgesloten jaar toont “Boekjaar heropenen” als duidelijk gemarkeerde, uitgeschakelde prototypeactie; de toekomstige-flowdialoog is uitsluitend informatief en schrijft niets.
   - “Heropend” wordt als ondersteunde toekomstige presentatiestatus voorbereid, maar niet verzonnen wanneer daar geen echte bron voor bestaat.

3. **Boekingsblokkade**
   - Voeg een volledig onafhankelijke kaart toe met de waarheidsgetrouwe prototypestatus “Nog niet afzonderlijk ingesteld”.
   - Leg uit: “BoekAssist krijgt hiervoor een aparte boekingsblokkade. Deze staat los van de boekjaarstatus.”
   - Leid geen blokkadestatus of datum af uit `afgesloten_boekjaar`; dat veld blijft buiten deze presentatie.
   - Toon de prototypeacties “Boekingsblokkade instellen”, “Blokkade wijzigen” en “Blokkade opheffen”.
   - Prototypeacties krijgen een duidelijke “Nog niet beschikbaar”-aanduiding en voeren geen mutatie uit.

4. **Gereedheid en historie**
   - Geef de bestaande gereedheidskaart een duidelijke sectiekop “Gereedheid voor afsluiten”.
   - Verplaats het echte afsluitbewijs naar een aparte sectie “Historie” en toon uitsluitend bestaande afsluitgegevens via `AuditTrailBlock`; toon anders een eerlijke lege staat en nooit demo- of verzonnen gebeurtenissen.

5. **Heropeningsdialoog**
   - Gebruik `FinancialActionDialog` met verplichte reden, de opgegeven gevolgen en Nederlandse tekst.
   - De bevestigknop blijft uitgeschakeld en wordt als prototype gemarkeerd; de knop naar deze dialoog is eveneens uitgeschakeld zolang heropenen technisch niet bestaat. Er is geen callback naar backendlogica.

6. **Gerichte regressietests en visuele controle**
   - Breid de bestaande Jaarafsluiting-tests uit voor de scheiding tussen status en blokkade, echte afsluitactie, prototypeknoppen, verplichte reden en afwezigheid van extra schrijf- of RPC-aanroepen.
   - Controleer desktop en mobiel in de preview.
   - Draai typecheck, lint, tests, build en `git diff --check`; inspecteer expliciet dat er geen backend-, migratie-, SQL-, types- of boekhoudlogica is gewijzigd.

## Bestanden binnen scope
- `src/pages/Jaarafsluiting.tsx`
- `src/test/jaarafsluiting-close.test.tsx`
- `roadmap.md` voor taakstatus

## Technische grenzen
- Geen migraties, SQL, schema, functies, triggers of gegenereerde types.
- Geen wijziging aan hooks, afsluit-RPC, rechtencontrole, gereedheidsberekening of boekingsgedrag.
- Geen nieuwe route, dependency of gedeeld modalsysteem.
