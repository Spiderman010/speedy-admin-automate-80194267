# Inkoop-werkbank: compacte, SnelStart-achtige presentatie

## Reikwijdte
Alleen de bestaande Inkoop-werkbank visueel aanscherpen: wachtrij, factuurgegevens, boekingsregels, bestaande totalen, documentweergave en actiezone. Geen wijzigingen aan gedrag, berekeningen, data, database, navigatie of andere schermen. De globale tabeldichtheid en kleuren blijven voor een afzonderlijke consistency-PR.

## Aanpak
- **Wachtrij:** bestaande leveranciers-, nummer-, datum-, bedrag- en statusweergave compacter en netjes uitgelijnd maken. Items blijven minimaal `min-h-[3.25rem]` (circa 52 px), zodat alle bestaande informatie leesbaar blijft.
- **Factuurgegevens en boekingsregels:** bestaande panelen, kolommen en onderlinge uitlijning versoberen; minder overbodige witruimte, duidelijke scheiding tussen regels en rechts uitgelijnde bedragen. Invoervelden en rijacties blijven minimaal `h-9` (36 px), ook op mobiel.
- **Totalen:** alleen de reeds gerenderde factuur-, regel- en verschilwaarden visueel strakker presenteren. Een Verschil-balk uitsluitend stylen waar de bestaande component die al rendert; niets toevoegen of in React opnieuw berekenen. Geen nieuwe debet-/creditpresentatie op dit scherm.
- **Document en acties:** alleen de bestaande documentomlijsting en actiezone compacter vormgeven. De bestaande preview, knoppen, labels, volgorde, voorwaarden en werking blijven intact.
- **Mobiel:** bestaande stapeling en horizontaal scrollende regeltabel behouden; zorgen dat tekst en bediening niet botsen.

## Technische grenzen en controle
Alleen presentatiewijzigingen in de bestaande Inkoop-pagina en onderdelen onder `src/components/purchase/`, primair classNames en bestaande indeling. Geen nieuwe PDF-preview, selectiemodel, knoppen, teksten, hooks, queries, functies, boekingslogica, migraties, types of globale stijltokens. Controleer daarna de bestaande Inkoop-weergave op desktop en mobiel en de relevante bestaande tests; voer de afgesproken repositorycontroles uit. Uitvoering uitsluitend op een toegestane feature-branch, niet op `main`.
