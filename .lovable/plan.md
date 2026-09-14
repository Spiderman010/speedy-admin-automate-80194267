# Rapportages moderniseren

## Doel
De bestaande pagina `Overzichten` omvormen tot een professionele, responsieve rapportagewerkruimte zonder queries, berekeningen, exports of boekhoudlogica te wijzigen.

## Uitvoering
- De bestaande paginakop behouden en aanpassen naar **Rapportages** met de gevraagde beschrijving.
- De administratiekeuze mobiel onder de titel over de volle breedte tonen; lange namen veilig afkappen.
- Een compacte rapportselector toevoegen met vijf rapporttypen. Niet-ondersteunde rapporten krijgen uitsluitend een duidelijke beschikbaarheidsstatus.
- Een filterstrook toevoegen met de werkende administratiekeuze en uitgeschakelde velden voor boekjaar, periode en vergelijking; er komt geen nieuwe filterlogica.
- De bestaande exportactie, drie bestaande totalen en tabel met recente inkoopfacturen behouden. Alleen visuele hiërarchie, uitlijning, tabel-scroll en numerieke typografie verbeteren.
- Bestaande query-resultaten gebruiken voor laad-, fout-, geen-administratie- en geen-dataweergaven. Een herlaadknop gebruikt alleen de al aanwezige `refetch`-functies.
- Eén gericht testbestand toevoegen voor renderen, administratiekeuze, rapportkaarten, toestanden, responsieve klassen, bestaand rapportbereik en afwezigheid van nieuwe database-mutaties of financiële rekenlogica.

## Technische afbakening
- Alleen `src/pages/Overzichten.tsx` en één gericht rapportage-testbestand wijzigen.
- Geen wijzigingen aan gedeelde componenten, projectkaart, database, migraties, gegenereerde types, grootboekpostings, boekingslogica of SnelStart-export.
- De bestaande sommen en exportaanroep blijven byte-inhoudelijk en functioneel gelijk waar relevant.

## Validatie
- `npx tsc --noEmit`
- `npx tsc -p tsconfig.app.json --noEmit`
- Gerichte Rapportages-tests
- `npm run lint`
- `npm run test`
- `npm run build`
- Visuele controle op 320, 375, 768, 1024 en 1440 pixels zonder pagina-overloop
