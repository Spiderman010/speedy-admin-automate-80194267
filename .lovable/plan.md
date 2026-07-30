# Verbetering 2 — "Selecteer alle veilige suggesties"

Alleen ontwerp- en implementatieplan. Geen code, geen DB, geen hooks, geen types. Volledig hergebruik van `safeSuggestionIds` en `handleBulkConfirmSuggestions` in `src/pages/Bank.tsx`.

## 1. Doel & scope

Eén knop die in één klik alle "veilige" suggesties over de **volledige klantselectie** (niet alleen de zichtbare pagina) aan `selectedIds` toevoegt, waarna de bestaande bulk-bevestig-flow het overneemt. De criteria voor "veilig" blijven exact zoals `safeSuggestionIds` ze vandaag bepaalt.

## 2. Exacte plaatsing van de knop

In de bestaande **auto-scan banner** (`Bank.tsx:1907-1938`), rechts naast "Automatisch voorstellen", vóór "Undo laatste batch". Dit is de enige plek waar al een whole-set actie op suggesties leeft. De knop valt onder dezelfde `matchingReady && (autoConfirm > 0 || …)`-gate die de banner al gebruikt.

Geen tweede knop in de bulk-toolbar onderaan (`Bank.tsx:2534-2542`) — die bevat al de bevestig-actie en zou dupliceren.

## 3. Knoptekst per staat

Afgeleiden in de render: `safeAvailableCount = safeSuggestionIds.size`, `safeUnselectedCount = aantal ids in safeSuggestionIds die nog niet in selectedIds zitten`.

| Situatie | Label | Variant | Enabled |
|---|---|---|---|
| `!matchingReady` (data laadt) | "Selecteer veilige suggesties…" | outline | disabled |
| `safeAvailableCount === 0` | knop niet renderen | — | — |
| `safeUnselectedCount > 0` | "Selecteer alle veilige suggesties ({safeUnselectedCount})" | outline | enabled |
| `safeUnselectedCount === 0 && safeAvailableCount > 0` | "Alle veilige suggesties geselecteerd ({safeAvailableCount})" | outline | disabled |
| `autoScanRunning` of `undoingBatch` | zelfde label | outline | disabled |

De knop **selecteert alleen**, bevestigt niet. Eén bevestig-pad blijft behouden (eis 4 & 6).

## 4. Gedrag & bron-set

`safeSuggestionIds` is een `Set<string>` afgeleid uit `transactions` (whole-set), niet uit `tableRows`. De actie is dus per definitie cross-page en filter-onafhankelijk (eis 7).

```text
onClick:
  next = new Set(selectedIds)
  for id in safeSuggestionIds: next.add(id)
  setSelectedIds(next)
  toast.info(`{safeUnselectedCount} veilige suggesties geselecteerd`)
```

- Bestaande handmatige selecties blijven staan; er wordt alleen **toegevoegd** (eis 5).
- Onzekere suggesties, geblokkeerde en reeds verwerkte regels zitten niet in `safeSuggestionIds` (`Bank.tsx:642-648`), dus nooit meegenomen (eis 5).
- Geen wijziging aan `handleBulkConfirmSuggestions` (`Bank.tsx:1307-1360`) — die filtert zelf al op `safeSuggestionIds` binnen `selectedIds`.

## 5. Bevestigings- en feedbacktekst

Vóór verwerking toont de bulk-toolbar "N transactie(s) geselecteerd" + "Veilige suggesties bevestigen (M)" — de expliciete pre-verwerking-teller (eis 6). Geen extra confirm-dialoog; de actie is reversibel via "Undo laatste batch".

- Na selectie: toast info "{safeUnselectedCount} veilige suggesties geselecteerd. Klik op 'Veilige suggesties bevestigen' om te verwerken."
- Na succes: bestaande toast in `handleBulkConfirmSuggestions` (~regel 1355).
- Gedeeltelijke fout: bestaande `success`/`failed`-telling dekt "X bevestigd, Y mislukt". Geen wijziging.

## 6. Loading / disabled / lege / foutstatus

| Toestand | Gedrag |
|---|---|
| `wholeSetLoading` / `!matchingReady` | disabled, label met "…", tooltip "Wacht tot bankdata volledig geladen is" |
| `wholeSetError` / `salesError` | knop niet renderen (banner gate op `matchingReady`) |
| `safeAvailableCount === 0` | knop niet renderen |
| na klik | synchroon (alleen setState), geen spinner |
| `autoScanRunning` / `undoingBatch` | disabled, voorkomt race |

## 7. Gedrag bij 0, 1 en veel veilige suggesties

- **0**: knop onzichtbaar; banner blokkeert zichzelf al bij `autoConfirm === 0 && toReview === 0`.
- **1**: label "(1)"; rij-inline "✓ Bevestig" blijft ook werken.
- **Veel (bv. 200)**: `setSelectedIds` is O(n), geen performance-issue. Bulk-toolbar toont 200. Bevestig-flow blijft sequentieel — ongewijzigd gedrag.

## 8. Cross-page / filter / zoek

- Selectie leeft in `selectedIds` (whole-set-scope). Pagineren/filteren/zoeken verandert alleen zichtbaarheid, niet de selectie (eis 7).
- De header-checkbox (`Bank.tsx:2140-2141`) blijft op `tableRows` opereren en blijft onaangeraakt; verwarring beperkt door het label "alle veilige suggesties" versus "alle regels".
- Geselecteerde, weggefilterde ids blijven meetellen bij bevestigen — consistent met bestaande bulk-acties.

## 9. Mobiel gedrag (≥375px)

- Banner heeft al `flex flex-wrap items-center gap-…`; knop wrapt vanzelf. Geen extra CSS.
- `size="sm"` Button geeft ≥40px tap target.
- Lang label past op 375px op eigen regel; geen truncation.

## 10. Toegankelijkheid

- `aria-label` gelijk aan zichtbare tekst incl. count, bijv. `aria-label="Selecteer alle 47 veilige suggesties"`.
- `aria-disabled` volgt `disabled`.
- Toast fungeert als `role="status"` announcement bij state-verandering.
- Standaard Button-focus + Enter/Space; geen extra handler.
- Alleen semantische tokens via `variant="outline"`, geen hardcoded kleuren.

## 11. Tests

Nieuw bestand `src/test/bank-select-safe-suggestions.test.tsx` (Vitest + RTL, mocks op `useBankTransactions`/`useSalesInvoices`/`usePurchaseInvoices`):

1. Knop verschijnt niet bij `safeSuggestionIds.size === 0`.
2. Knop disabled bij `!matchingReady`.
3. Label toont juiste `safeUnselectedCount` bij mix van al/niet geselecteerd.
4. Klik voegt ontbrekende veilige ids toe en laat handmatige niet-veilige selecties intact.
5. Na klik: label wordt "Alle veilige suggesties geselecteerd (N)" en knop disabled.
6. Cross-page: met `page=2` worden ook niet-zichtbare veilige ids geselecteerd.
7. Integratie: klik + "Veilige suggesties bevestigen" verwerkt alle N ids.
8. Knop disabled tijdens `autoScanRunning`.

## 12. Betrokken bestanden

- `src/pages/Bank.tsx` — enige productiewijziging: één Button in de auto-scan banner (rond regel 1930) + lokale afgeleide `safeUnselectedCount`. Geen wijziging aan `safeSuggestionIds`, `handleBulkConfirmSuggestions`, `handleAutoScan`, `toggleSelect`, `toggleSelectAll` of bulk-toolbar.
- `src/test/bank-select-safe-suggestions.test.tsx` (nieuw).

Geen wijzigingen aan hooks, types, migraties, RLS, `snelstart-export`, `BankAfletteringDrawer`, `BankMatchDialog`.

## 13. Risico's & edge-cases

| Risico | Mitigatie |
|---|---|
| Gebruiker denkt dat knop direct bevestigt | Tekst "Selecteer…" + toast die naar bevestig-knop verwijst |
| Verwarring header-checkbox (pagina) vs knop (whole-set) | Duidelijk verschillende labels |
| `safeSuggestionIds` verandert tussen selecteren en bevestigen | `handleBulkConfirmSuggestions` her-checkt safety per id (bestaand) |
| Race met `handleAutoScan` | Disabled bij `autoScanRunning` + `undoingBatch` |
| Grote selectie (>500) traag bij bevestigen | Bestaand bulk-gedrag, geen nieuwe scope |
| Selectie blijft staan bij klantwissel | `selectedIds` wordt al gereset bij client-wissel (~regel 200) |
| Screen reader mist count-verandering | Toast als announcement |

## 14. Buiten scope

Select-all over alle pagina's voor willekeurige rijen (verbetering 1), wijzigen van `isSafe`-criteria, extra confirm-modal, keyboard shortcut (verbetering 4), veilig/onveilig-badge in tabel (verbetering 6).
