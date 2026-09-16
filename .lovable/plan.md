# BoekAssist gedeelde structuur-polish

## Doel
De bestaande UI-polish en merk-kleuren behouden, maar de gedeelde visuele structuur dichter bij de aangeleverde referentie brengen: compact, rustig en professioneel financieel SaaS.

## Kleinste effectieve wijzigingsset
- **Shell en navigatie** — de bestaande sidebar compacter maken, iconen en labels strakker uitlijnen, het actieve item duidelijker maar rustig vullen en de topbar lichter scheiden van de inhoud. Alle routes, labels, contextkiezers en acties blijven intact.
- **Contentritme** — `PageContainer` en `PageHeader` afstemmen op de referentie met een consequente inhoudsbreedte, compacte bovenruimte en sterkere titel/actie-hiërarchie zonder inhoud te wijzigen.
- **Kaarten en KPI’s** — gedeelde `Card` en `StatCard` voorzien van subtiele 1px-randen, kleinere radius, vrijwel geen schaduw, compactere consistente binnenruimte en een sterkere titel/cijfer-hiërarchie.
- **Tabellen** — gedeelde tabelkop, rijen, cellen en hoverstatus compacter en rustiger maken; bestaande tabular-nums behouden voor cijferuitlijning. Geen kolommen of gedrag wijzigen.
- **Knoppen en velden** — gedeelde `Button`, `Input` en `Select` visueel gelijk trekken in hoogte, rand, focus en nadruk; bestaande varianten en interacties blijven hetzelfde.
- **Lege staten** — `EmptyState` terughoudender maken zodat het aansluit op de compacte kaart- en pagina-opbouw.
- **Kleuren** — de bestaande semantische navy/blauw/teal-tokenpass blijft leidend; alleen een token aanpassen als de structurele toepassing anders onvoldoende contrast geeft.

## Waarschijnlijke bestanden
- `src/components/layout/app-sidebar.tsx`
- `src/components/layout/app-header.tsx`
- `src/components/layout/page-container.tsx`
- `src/components/ui/sidebar.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/table.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/components/PageHeader.tsx`
- `src/components/EmptyState.tsx`
- `src/components/StatCard.tsx`

Geen individuele pagina wordt aangepast tenzij de preview aantoont dat een zichtbaar referentieverschil onmogelijk via deze gedeelde laag kan worden opgelost.

## Primaire referentiecriteria
Het scherpe dashboardvoorbeeld `image-15.png` is de primaire visuele referentie. De bestaande BoekAssist-inhoud wordt niet vervangen of uitgebreid; alleen de herbruikbare presentatielaag neemt de volgende verhoudingen en behandeling over:

- Desktop-sidebar in de compacte verhouding van de referentie: diepe navy kolom, smalle binnenmarges, strak uitgelijnde 16px-iconen en labels, en een helder maar subtiel blauw gevuld actief item.
- Een dunne, lichte topbar met rustige onderrand; bestaande context en acties blijven exact behouden. De zoekbalk, meldingen en profielbediening uit de referentie worden niet als nieuwe functies toegevoegd.
- Heldere scheiding tussen topbar, paginatitel en inhoud, met compacte verticale ruimte en acties rechts uitgelijnd waar de bestaande component dit al ondersteunt.
- Witte kaarten met subtiele 1px-rand, kleine radius en vrijwel geen schaduw; KPI-labels klein en rustig, cijfers groot en zwaar, iconen compact in licht getinte vlakken.
- Dichte maar leesbare tabellen zoals in de referentie: subtiele blauwgrijze kop, fijne rijlijnen, rustige hover, vaste cijferuitlijning en compacte acties.
- Primaire acties herkenbaar helder blauw; secundaire en ghost-bediening wit of transparant met subtiele rand.
- De navy/blauw/teal-balans van de bestaande tokenpass blijft behouden; geen gradients of extra decoratie.
- Op mobiel: geen horizontale pagina-overloop, toegankelijke aanraakdoelen en een goed bereikbare zijbalk zonder de desktopdichtheid letterlijk te forceren.

## Validatie
- Voor/na-visuele vergelijking met de referentie op desktop en mobiel, inclusief sidebar, topbar, kaarten/KPI’s, tabellen, knoppen, velden en lege staten.
- Controle op overflow, focuszichtbaarheid, tekstcontrast en dark mode.
- Gerichte shell/shared-UI-tests.
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`
- `npm run build`
- `git diff --check`
- Diffcontrole: uitsluitend presentatie; geen pagina-inhoud, gedrag, routes, backend, schema, migraties, generated types of omgevingsvariabelen.

## Branch en oplevering
Verder werken vanaf de huidige UI-polishbranch, niet rechtstreeks op `main`. Na validatie branch/HEAD rapporteren en een PR openen indien de beschikbare GitHub-koppeling dat ondersteunt; anders de exacte blokkade vermelden.
