# Header-totalen afleiden uit boekingsregels

## Probleem
Bij handmatig ingevoerde inkoopfacturen wordt in de header alleen `amount_excl` gezet (bv. €100). `btw_amount` blijft leeg en `amount_incl` is gelijk aan `amount_excl`. Zodra de boekingsregel BTW toevoegt (bv. 9% → €9 BTW, €109 incl.), toont het verschiloverzicht een kunstmatig verschil, terwijl de regel zelf klopt.

## Root cause
`PurchaseInvoiceWorkspace` initialiseert de header direct uit `invoice.*` (`emptyHeader`) en past nooit een normalisatie toe wanneer de header incompleet/inconsistent is. Bij handmatige creatie wordt vaak alleen excl. gezet; de workspace laat dat staan en berekent het verschil t.o.v. regels die wél BTW hebben.

## Oplossing (klein & lokaal)

### 1. Header-normalisatie bij initialisatie
In het bestaande init-`useEffect` in `src/pages/PurchaseInvoiceWorkspace.tsx`, na het bepalen van `nextHeader` en na het bepalen van de te tonen `lines` (stored of prefill), één keer normaliseren wanneer alle onderstaande waar zijn:

- `amount_excl` is aanwezig
- `btw_amount` is null/leeg
- `amount_incl` is null of gelijk aan `amount_excl` (binnen 1 cent)
- er is minstens één "meaningful" (niet-blanke) regel én die regels bevatten BTW-info

Dan:
- header `amount_excl` = som regels excl.
- header `btw_amount`  = som regels BTW
- header `amount_incl` = som regels incl.

Voor BTW-vrijgestelde klanten blijft de bestaande coherentie-regel (`incl = excl`, `btw = 0`) leidend; normalisatie doet daar niets extra's.

### 2. Geen overschrijven van expliciete waarden
Normalisatie draait alleen als alle drie condities hierboven kloppen (dus header is aantoonbaar incompleet). Zijn `btw_amount` én `amount_incl` beide gezet en consistent met `amount_excl`, dan gebeurt er niets. Zo blijven complete OCR- of handmatig ingevulde headers ongemoeid.

### 3. Eenmalig, na load
Normalisatie draait binnen hetzelfde `initialized`-guarded effect dat al bestaat: pas nadat `invoice` én `storedLines` geladen zijn, exact één keer. Geen render loop, geen herberekening bij elke keystroke. Latere handmatige edits van de gebruiker op headervelden zijn gezaghebbend — de bestaande `patchHeader` blijft ongewijzigd en het effect draait niet opnieuw.

### 4. Persist bij Opslaan
`buildHeaderUpdates()` schrijft al `amount_excl`, `btw_amount`, `amount_incl` en `btw_percentage` weg uit `header.*`. Omdat de header nu genormaliseerde waarden bevat, worden die vanzelf gepersisteerd. Bij heropenen is de header compleet en triggert de normalisatie niet meer (conditie "btw_amount is null" is dan false).

### 5. Approval
Ongewijzigd: `canApprove` blijft afhangen van `linesMatch` (`diffs.allOk`) en compleetheid. Na normalisatie zijn de verschillen 0 en kan goedgekeurd worden.

## Tests (`src/test/`)
Nieuw testbestand `purchase-workspace-header-derivation.test.ts` met pure helper-tests op een geëxtraheerde functie `deriveHeaderFromLines(header, lineTotals)`:

- incompleet header (excl=100, btw=null, incl=null) + één 9%-regel → 100/9/109
- incompleet header + mixed VAT (100@21, 50@9, 25@0) → 175/29.5/204.5 (exacte som via `computeLineTotals`)
- volledig header (100/21/121) blijft ongewijzigd
- header met `incl != excl` (gebruiker heeft bewerkt) blijft ongewijzigd
- geen regels → header ongewijzigd
- BTW-vrijgesteld: al gelijkgetrokken excl/incl blijft, geen afleiding

De helper wordt geïmporteerd door `PurchaseInvoiceWorkspace` en aangeroepen binnen het bestaande init-effect. Zo blijft de test unit-niveau en hoeven we geen React-flow te mocken voor de kernlogica.

## Bestanden
- `src/pages/PurchaseInvoiceWorkspace.tsx` — normalisatie-aanroep in init-effect
- `src/lib/purchase-line-validation.ts` — nieuwe pure helper `deriveHeaderFromLines` (of nieuw bestand `src/lib/purchase-header-derivation.ts` als dat schoner past)
- `src/test/purchase-workspace-header-derivation.test.ts` — nieuwe tests

## Niet in scope
Geen schema/migraties, geen RLS, geen OCR-wijziging, geen SnelStart-export, geen MCP, geen types-edits, geen redesign, geen wijziging in stored-line logica.

## Verificatie
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`
- Handmatige browsertest: nieuwe factuur €100, regel 9% → header toont 100/9/109, verschil 0.
