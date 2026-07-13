## Doel
Het "Bedrag excl.", "Bedrag incl." en "BTW-bedrag" veld in `InvoiceEditDialog` mag tijdens typen niet meer terugspringen naar `0,00` (of naar het incl-bedrag) bij BTW-vrijgestelde klanten.

## Oorzaak
In `src/components/InvoiceEditDialog.tsx` staat een "vangnet"-effect (regels 342–370) dat bij `isBtwVrijgesteld` reageert op iedere wijziging van `form.amount_excl` / `form.amount_incl` / `form.btw_amount` / `form.btw_percentage` en direct de state overschrijft naar `max(excl, incl)`. Omdat de inputs `controlled` zijn op `form.amount_excl`, wordt tijdens het typen elke keystroke door dit effect teruggeschreven → gebruiker ziet het veld "terugspringen" naar het incl-bedrag of naar 0,00 zodra ze een cijfer wissen.

## Aanpak (minimale delta, alleen presentatie)
Alleen `src/components/InvoiceEditDialog.tsx` aanpassen. Geen wijzigingen aan hooks, DB, of business-logica.

1. **Lokale draft-state voor de drie kopvelden** (zelfde patroon als `_amountInput` op de regels):
   - `amountExclDraft`, `amountInclDraft`, `btwAmountDraft` (strings).
   - Gesynchroniseerd met `form.*` wanneer de factuur wordt geladen of extern gewijzigd (bijv. OCR-refill), niet tijdens typen.
2. **Input gedrag**:
   - `onChange` → alleen `*Draft` bijwerken (geen `set(...)` op `form`).
   - `onBlur` → parseAmountInput → schrijf naar `form.amount_excl` (of incl/btw_amount) en trigger de bestaande `recalcBtw`.
   - Behoud `type="number" step="0.01"` óf schakel om naar `type="text" inputMode="decimal"` (consistent met de regel-inputs, tolereert komma). Voorkeur: `text + inputMode="decimal"` zodat "0,5" niet meer stilletjes leeg wordt.
3. **Vangnet-effect (r. 342–370) laten staan** — het reageert nu op `form.amount_excl` dat pas op blur wijzigt, dus geen keystroke-race meer.
4. **Reset van drafts** wanneer:
   - Dialog opent voor een andere factuur (`invoice?.id` change) → drafts = huidige `form.*` strings.
   - OCR/leverancier-refill de `form.*` waarden vervangt → drafts opnieuw uit `form.*`.

## Niet in scope
- `SalesInvoiceDialog` en `SalesInvoiceEditDialog` (aparte schermen; alleen aanpakken als de gebruiker daar ook hetzelfde gedrag ziet).
- Regel-inputs (die werken al met `_amountInput`).
- Formatting/afronding, validatie, opslaan.

## Verificatie
1. `npx tsc --noEmit`, `npm run lint`, `npm run test` — moeten groen blijven.
2. Handmatig in preview:
   - BTW-plichtige klant: bedrag excl. typen "1234,56" zonder terugspringen; op blur berekent BTW/incl zoals nu.
   - BTW-vrijgestelde klant: bedrag typen, tussentijds cijfer wissen — veld blijft leesbaar; pas op blur worden excl/incl gelijkgezet.
   - OCR-refill: openen van bestaande factuur toont opgeslagen bedragen, drafts nemen die over.

## Bestanden
- `src/components/InvoiceEditDialog.tsx` (enige wijziging).

## Geschatte kosten
±1 credit (kleine UI-refactor in één bestand + drie tests draaien).
