# Gedeelde UI-polish

## Doel
BoekAssist met zo weinig mogelijk gedeelde wijzigingen visueel consistenter, rustiger en professioneler maken, zonder bestaand gedrag te veranderen.

## Uitvoering
- De globale visuele basis verfijnen: rustigere oppervlakken, borders en focusweergave via bestaande semantische kleurrollen.
- De app-shell compact en helder afwerken: consistente bovenbalk, inhoudsruimte en subtielere navigatiehiërarchie, zonder routes of navigatiestructuur te wijzigen.
- De gedeelde kaart, tabel, knop, invoer, select, label en skeleton-stijlen harmoniseren voor consistente dichtheid, states en touch targets.
- Bestaande `PageHeader` en `EmptyState` gebruiken als centrale verbetering voor koppen en lege schermen.
- Alleen bestaande shadcn/Tailwind-patronen toepassen; geen nieuwe pagina-specifieke functies of bibliotheken.

## Technische afbakening
- Alleen presentatiebestanden binnen de app-shell en gedeelde UI-bouwstenen wijzigen.
- Geen pagina's wijzigen tenzij een zichtbaar probleem aantoonbaar niet gedeeld oplosbaar is.
- Geen wijzigingen aan business- of boekhoudlogica, hooks, queries, routes, database, migraties, rechten, gegenereerde types of omgevingsvariabelen.
- De huidige feature branch is gebaseerd op de actuele `main`; niet rechtstreeks op `main` werken.

## Validatie en oplevering
- Gerichte shell/UI-tests uitvoeren, gevolgd door typecheck, lint, volledige tests en productiebuild.
- De preview visueel controleren op desktop en mobiel, inclusief overflow, focus, tabellen en navigatie.
- De uiteindelijke diff controleren op strikte scope.
- De wijziging committen, naar de feature branch pushen en een PR naar `main` openen.
