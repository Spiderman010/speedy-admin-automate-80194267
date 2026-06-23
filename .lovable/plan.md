## Doel

Op de Bank-pagina mogen banktransacties **niet** standaard zichtbaar zijn voor "Alle klanten". De gebruiker moet eerst expliciet 1 klant, meerdere klanten of "Alle klanten" kiezen. Pas daarna worden transacties, KPI-tegels en de tabel geladen.

## Wat verandert er functioneel

1. **Klantkeuze bovenaan de Bank-pagina** wordt een multi-select (popover met zoekveld + checkboxes):
   - Standaard: **geen** klant geselecteerd.
   - Opties: zoekbaar lijstje van alle klanten met checkboxes + knop "Alles selecteren" / "Wissen".
   - Toont in de knop bv. *"3 klanten geselecteerd"* of *"Alle klanten"*.
2. **Lege staat** zolang er niets gekozen is:
   - KPI-tegels, tabel, blokkade-banner en zoekbalk worden verborgen.
   - In plaats daarvan komt een nette empty state: *"Kies eerst één of meer klanten om bankafschriften te zien"* met de klantkiezer prominent eronder.
3. **Verwerken / Export / Aletterrapport / Upload-knoppen** in de header blijven, maar:
   - Upload-afschrift blijft beschikbaar (vraagt al om klant in dialog).
   - Export Snelstart en Afletterrapport worden uitgeschakeld (disabled met tooltip "Kies eerst een klant") zolang er geen klantselectie is.
4. **Data-laden** gebeurt alleen voor de geselecteerde klant-id's; bij "Alle klanten" werkt het zoals nu.
5. **Onthouden van keuze** binnen de sessie via `useClientContext` (bestaande context) — als de gebruiker via de sidebar al een klant heeft gekozen, wordt die voorgeselecteerd.

## Wat verandert er **niet**

- Geen wijzigingen in database, RLS of edge functions. RLS regelt de échte toegangsbeperking al; dit is een UI/UX-maatregel zodat een gebruiker niet per ongeluk 60 klanten tegelijk ziet.
- Andere pagina's (Facturen, Verkoop, Snelle invoer) blijven ongewijzigd. Als je deze gedragsregel later ook daar wilt, doen we dat in een aparte taak.
- Geen nieuwe libraries; we hergebruiken de bestaande `Popover`, `Command` en `Checkbox` uit `@/components/ui`.

## Technische aanpak (kort)

- `src/pages/Bank.tsx`: vervang het bestaande `<Select>` voor klantfilter door een nieuwe `<ClientMultiSelect>`-component die een `string[]` aan klant-id's teruggeeft (lege array = niets gekozen, `["all"]` = alle klanten).
- Nieuwe component `src/components/ClientMultiSelect.tsx` (popover + search + checkboxes + "Alles" / "Wissen").
- Pas alle plekken in `Bank.tsx` aan waar nu `clientFilter !== "all" ? clientFilter : undefined` wordt doorgegeven aan `useBankTransactions`, `usePurchaseInvoices`, `useSalesInvoices` en `useBankTransactionAllocations`:
  - Als selectie leeg → query overslaan (skeleton/empty state tonen).
  - Als 1 klant → bestaande gedragslijn met die ene `clientId`.
  - Als meerdere klanten → client-side filteren op `selectedIds.includes(tx.client_id)` (hooks laden dan zonder `clientId` of met `"all"`), zelfde patroon als bestaande "Alle klanten"-flow.
- Empty-state component bovenaan de pagina-body.

## Verificatie

- `npx tsgo --noEmit`, `npm run lint`, `npm run test` moeten groen blijven.
- Handmatig in preview: bij verse load geen transacties zichtbaar, na kiezen 1 klant alleen die data, na kiezen meerdere klanten gefilterde data, "Alles" werkt als voorheen.

## Credits-inschatting

Eén gerichte wijziging, één nieuwe kleine component, één bestaande pagina aanpassen, geen migraties of edge functions. Indicatie: **ongeveer 2–4 credits** voor de implementatie + 1 voor verificatie. Definitieve kosten hangen af van hoeveel iteraties nodig zijn (bijv. styling-bijschaaf), maar dit zit ruim binnen een normale feature-taak.

Wil je dat ik dezelfde regel (eerst klant kiezen) ook toepas op **Facturen**, **Verkoopfacturen** en **Vraagposten**? Dat zou dan in een aparte taak (~2–3 credits extra) — laat het weten als je het in één keer wilt meenemen.
