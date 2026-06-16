## Doel
Maak de inkoopfactuur-popup net iets prettiger op desktop door alleen layout-aanpassingen in `InvoiceEditDialog.tsx`.

## Wijzigingen

### 1. Bredere rechterkolom
Wijzig de desktop-gridverhouding van 5:7 (≈42:58) naar 2:3 (40:60) zodat het formulier met factuurregels meer ruimte krijgt:
- Huidig: `lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]`
- Nieuw: `lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]`

### 2. Compactere bovenste sectie
Verklein verticale spacing tussen blokken in de rechterkolom zodat "Factuurregels" sneller zichtbaar is:
- `space-y-4` op het scrollbare container-div wordt `space-y-2`
- `space-y-2` binnen de leverancierkoppeling-kaart wordt `space-y-1`
- `space-y-3` bij de BTW-sectie wordt `space-y-1.5`
- `p-3` op de leverancierkoppeling-kaart wordt `p-2`
- `space-y-2` in de factuurregels-lijst wordt `space-y-1.5`
- `gap-3` op diverse grid-rijen (leverancier, factuurnummer/datum, bedragen) blijft `gap-3` — geen verdichte layout die onleesbaar wordt

### 3. Factuurregels-sectie compacter
- De border-t/pt-3 rond de factuurregels-sectie wordt `border-t pt-2`
- De totaalvergelijkingskaart houdt zijn padding (`px-3 py-2`) maar de ruimte eromheen verkleint mee
- Regel-items (`rounded-md border p-2`) blijven ongewijzigd — al compact genoeg

## Niet gewijzigd
- Geen berekeningen, validatie, logica, hooks, state, events
- Geen backend/database/export/edge-function wijzigingen
- Geen andere bestanden dan `InvoiceEditDialog.tsx`

## Validatie
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`