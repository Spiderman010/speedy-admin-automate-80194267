
# Inkoopfactuur-werkpagina

Doel: één volledige boekhoudkundige werkpagina per inkoopfactuur, in plaats van de huidige `InvoiceEditDialog`-modal die na meerdere reparaties nog steeds initialisatiebugs en lay-outfricties heeft.

## Kernprobleem van de huidige modal

- Meerdere lagen "voorstelregel"-logica (form-state + effect + refs) blokkeren elkaar bij handmatige facturen en OCR-facturen.
- Lege regels, phantom-regels en verschilberekening leven door elkaar in één component van 1500+ regels.
- Modal-context beperkt de horizontale ruimte waardoor het regelraster in kaart-stijl staat i.p.v. tabel.
- Alle regelinitialisatie hangt aan een `useEffect` op dialoog-open, wat lastig te redeneren is.

## Nieuwe route

`/facturen/inkoop/:invoiceId` — één volledige pagina.

Op `/facturen` navigeert een klik op een inkoopfactuurrij nu naar deze pagina in plaats van de modal te openen. `InvoiceEditDialog` blijft tijdelijk in de codebase (mogelijk nog gebruikt in bank-koppeling), verwijderen komt in latere cleanup-PR.

## Lay-out

```text
+--------------------------------------------------------------+
| < Terug   Leverancier · Nr · Datum · Status   [<  1/12  >]   |
+---------------------------------+----------------------------+
|                                 |                            |
|  Factuurgegevens (compact)      |                            |
|  klant / leverancier / nr /     |   Document preview         |
|  datum / excl / btw / incl /    |   (sticky)                 |
|  btw% / grootboek / notities    |                            |
|                                 |                            |
|  Totalenoverzicht               |                            |
|  Factuur | Regels | Verschil    |                            |
|  status: groen/amber/rood       |                            |
|                                 |                            |
|  Boekingsregels (tabel)         |                            |
|  omschr | grb | excl | %        |                            |
|  | btw(ro) | incl(ro) | x       |                            |
|  [+ Regel toevoegen]            |                            |
|                                 |                            |
+---------------------------------+----------------------------+
| [Annuleren]         [Opslaan]  [Goedkeuren]  [Volgende >]    |
+--------------------------------------------------------------+
```

Op smalle schermen stapelt de preview onder de gegevens.

## Regel-initialisatie (deterministisch)

Bij laden van de pagina:

1. Query stored `purchase_invoice_lines` voor deze factuur.
2. Als er stored lines zijn → toon ze exact, geen voorstelregel, geen extra lege regel.
3. Als er geen stored lines zijn:
   - Als bruikbare header data (`amount_excl` of `amount_incl`) bekend is → toon exact één voorstelregel via `derivePrefillLine`.
   - Anders → toon nul regels + knop "Eerste boekingsregel toevoegen".

Er wordt nooit een verborgen/lege default-regel aangemaakt. Toevoegen gebeurt alleen expliciet via knop of "Split"-actie.

## Regels tijdens bewerken

- Nieuwe regel mag blanco zijn in de UI, telt niet in totalen, telt niet in validatie, wordt niet opgeslagen.
- `isBlankLine` / `isPartiallyFilledLine` uit `purchase-line-validation.ts` (reeds aanwezig) bepalen dit.
- Deels ingevulde regel blokkeert Opslaan én Goedkeuren met NL-melding.
- Bedraginvoer via `parseAmountInput` / `formatAmountInput` — ondersteunt zowel `12,50` als `12.50`, normaliseert op blur.
- Geen automatische save.

## Totalen en verschil

Compacte samenvattingsblok direct boven de tabel toont drie rijen:

- Factuur: excl / btw / incl (uit header)
- Boekingsregels: excl / btw / incl (som van niet-lege regels via `computeLineTotals`)
- Verschil: excl / btw / incl

Kleurstates op basis van `computeLineDiffs`:

- Groen `De boekingsregels sluiten aan op de factuur.` — alle drie ok.
- Amber `Er resteert nog een verschil van €X.XX` — partiële regels of open verschil terwijl gebruiker nog aan het typen is.
- Rood — echte foute staat (bv. header incl. leeg + regels aanwezig).

Geen technische tolerantietekst; tolerantie blijft intern.

## Acties (fixed action bar)

- Annuleren / Terug → `/facturen`
- Opslaan → header-updates + regels via `useUpdatePurchaseInvoice` + `useReplacePurchaseInvoiceLines`.
- Goedkeuren → status → `gecontroleerd`; disabled zolang:
  - vereiste header-velden ontbreken;
  - een partieel ingevulde regel bestaat;
  - regeltotalen niet aansluiten.
- Volgende factuur → nav naar volgende `te_controleren`-factuur binnen zelfde klantfilter (indien beschikbaar).

## Handmatige factuur

`PurchaseInvoiceCreateDialog` navigeert na succesvolle create direct naar `/facturen/inkoop/:invoiceId` in plaats van modal te openen. Header data is dan al aanwezig, dus exact één voorstelregel verschijnt.

## Technische details

### Nieuwe bestanden

- `src/pages/PurchaseInvoiceWorkspace.tsx` — de nieuwe pagina.
- `src/components/PurchaseInvoiceLineTable.tsx` — klein tabelcomponent voor de boekingsregels (alleen als het duidelijkheid materieel verhoogt).

### Aan te passen bestanden

- `src/App.tsx` — route `/facturen/inkoop/:invoiceId` toevoegen binnen `ProtectedRoutes`.
- `src/pages/Facturen.tsx` — rij-klik navigeert naar workspace i.p.v. `setEditingInvoice`; `InvoiceEditDialog` blijft ingebouwd maar wordt niet meer geopend vanuit rij-klik.
- `src/components/PurchaseInvoiceCreateDialog.tsx` — na `useAddPurchaseInvoice.mutateAsync` → `navigate(`/facturen/inkoop/${id}`)`.

### Hergebruikte hooks / lib

- `usePurchaseInvoices` — losse fetch per id via bestaande cache, of eenvoudige nieuwe select-single wrapper indien nodig.
- `usePurchaseInvoiceLines`, `useReplacePurchaseInvoiceLines`
- `useUpdatePurchaseInvoice`
- `useClients`, `useLeveranciers`, `useGrootboekrekeningen`
- `purchase-line-validation.ts` (blank/partial/prefill/diffs)
- `amount-input.ts` (parse/format)
- `btw-calc.ts` (deriveFromExcl/deriveFromIncl)
- bestaande document-preview render uit `InvoiceEditDialog` (uitknippen naar kleine helper of inline)

### Niet aanraken

- DB schema, RLS, migrations, types, OCR functies, SnelStart export, MCP, sales flow, andere pagina's.

## Tests

Nieuwe/aangepaste tests:

- `src/test/purchase-invoice-workspace-init.test.tsx` — voorstelregel-initialisatie (stored / prefill / geen data), phantom-regel afwezig.
- `src/test/purchase-invoice-workspace-flow.test.tsx` — handmatige factuur end-to-end tot workspace-open met één regel; add-second-line; save & reopen.

Bestaande tests blijven groen; `purchase-invoice-create-flow.test.tsx` wordt aangepast op de nieuwe navigatie (workspace i.p.v. dialoog).

Run vóór PR: `npx tsc --noEmit`, `npm run lint`, `npm run test`.

## Migraties

Geen.

## Opleveringspunten

- PR-branch `feature/purchase-invoice-workspace` op `Spiderman010/speedy-admin-automate-80194267` tegen `main`.
- Screenshots: manual invoice met één regel, tweeregelig, mismatch (amber), match (groen).
- Rapport of oude `InvoiceEditDialog` in een volgende PR verwijderd kan worden.
