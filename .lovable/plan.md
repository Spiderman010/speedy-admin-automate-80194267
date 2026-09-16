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

## Referentiecriteria
- Desktop-sidebar ongeveer in de compacte verhouding van de referentie, met kleinere verticale tussenruimte en een subtiel blauw actief item.
- Topbar rustig en dun, zonder dubbele concurrentie met de paginatitel.
- Witte, laag-schaduw kaarten met duidelijke KPI-cijfers en consistente padding.
- Dichte maar leesbare tabellen met subtiele kopachtergrond en compacte acties.
- Primaire acties herkenbaar blauw; secundaire bediening visueel stiller.
- Op mobiel: geen horizontale pagina-overloop, toegankelijke aanraakdoelen en een goed bereikbare zijbalk.

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
