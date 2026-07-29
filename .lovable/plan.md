
# Verbetering 2 — "Selecteer alle veilige suggesties"

Alleen ontwerp- en implementatieplan voor deze ene verbetering. Geen code, geen DB, geen hooks, geen types. Volledig hergebruik van `safeSuggestionIds` en `handleBulkConfirmSuggestions` in `src/pages/Bank.tsx`.

## 1. Doel & scope

Één knop die in één klik alle "veilige" suggesties over de **volledige gefilterde set** (niet alleen de zichtbare pagina) aan `selectedIds` toevoegt, waarna de bestaande bulk-bevestig-flow het overneemt. Geen gedragswijziging aan de criteria voor "veilig" — die blijven zoals `safeSuggestionIds` ze vandaag bepaalt.

## 2. Plaatsing van de knop

Één plek, in de bestaande **auto-scan banner** (`Bank.tsx:1907-1938`), naast de knop "Automatisch voorstellen". Reden: dit is de enige plek in de UI waar reeds een globale (whole-set) actie op suggesties leeft; gebruikers verwachten daar de "selecteren"-tegenhanger. De knop verschijnt onder dezelfde `matchingReady && (autoConfirm > 0 || …)`-conditie die de banner al gate-t.

Geen tweede knop in de bulk-toolbar onderaan; die bevat al de bevestig-actie (`Bank.tsx:2534-2542`) en zou dupliceren.

Layout binnen de banner: rechts naast "Automatisch voorstellen", vóór "Undo laatste batch". Op smalle schermen wraps de banner al (`flex-wrap`), dus de knop stapelt vanzelf.

## 3. Knoptekst per state

Bepaal in de render één afgeleide `safeAvailableCount = safeSuggestionIds.size` en `safeUnselectedCount = aantal ids in safeSuggestionIds die nog niet in selectedIds zitten`.

| Situatie | Label | Variant | Enabled |
|---|---|---|---|
| `!matchingReady` (data laadt nog) | "Selecteer veilige suggesties…" | `outline` | disabled |
| `safeAvailableCount === 0` | knop niet renderen | — | — |
| `safeUnselectedCount > 0` (er valt nog wat toe te voegen) | "Selecteer alle veilige suggesties ({safeUnselectedCount})" | `outline` | enabled |
| `safeUnselectedCount === 0 && safeAvailableCount > 0` (alles al geselecteerd) | "Alle veilige suggesties geselecteerd ({safeAvailableCount})" | `outline` | disabled |
| tijdens `autoScanRunning` of `undoingBatch` | zelfde label, maar disabled | `outline` | disabled |

De knop **selecteert alleen**; hij bevestigt niet. De gebruiker klikt daarna zelf op de al bestaande knop "Veilige suggesties bevestigen (N)" in de bulk-toolbar. Zo blijft er één bevestig-pad en één duidelijke pre-verwerking-teller (eis 6).

## 4. Gedrag & bron-set

`safeSuggestionIds` is een `Set<string>` afgeleid uit `transactions` (de whole-set), niet uit `tableRows`. De knop werkt dus per definitie **cross-page en cross-filter**: paginering en filter/zoek beïnvloeden de selectie-actie niet, alleen wat de gebruiker daarna in de tabel ziet (eis 7).

Klik-handler (conceptueel, niet ter uitvoering):

```text
onClick:
  next = new Set(selectedIds)
  for id in safeSuggestionIds: next.add(id)
  setSelectedIds(next)
  toast.info(`{safeUnselectedCount} veilige suggesties geselecteerd`)
```

- Bestaande handmatige selecties (bijv. een grootboek-boeking-selectie) blijven staan; er wordt alleen **toegevoegd** (eis 5 & handmatig-al-geselecteerd-scenario).
- Onzekere suggesties, geblokkeerde regels en reeds verwerkte regels zitten per definitie niet in `safeSuggestionIds` (`Bank.tsx:642-648` bouwt de set uit alleen `suggestie`-status met `isSafe`-criteria), dus die worden nooit meegenomen (eis 5).
- Geen wijziging aan `handleBulkConfirmSuggestions` — die filtert zelf al op `safeSuggestionIds` binnen `selectedIds` (`Bank.tsx:1307-1360`), dus onzekere handmatig-geselecteerde items worden alsnog overgeslagen bij bevestigen. Consistent en veilig.

## 5. Bevestigings- en feedbacktekst

Vóór verwerking: de bestaande bulk-toolbar toont "N transactie(s) geselecteerd" + "Veilige suggesties bevestigen (M)". Dit is de expliciete pre-verwerking-teller (eis 6). Geen extra confirm-dialoog nodig — de actie is reversibel via "Undo laatste batch".

Na klik op "Selecteer alle veilige suggesties":
- Toast (info): "{safeUnselectedCount} veilige suggesties geselecteerd. Klik op 'Veilige suggesties bevestigen' om te verwerken."

Na klik op bestaande bevestig-knop (ongewijzigd gedrag, alleen tekst-check):
- Succes: bestaande toast in `handleBulkConfirmSuggestions` (regel ~1355) — succes-teller.
- Gedeeltelijke fout: `handleBulkConfirmSuggestions` telt al `success`/`failed`; bestaande toast dekt "X bevestigd, Y mislukt". Geen wijziging.

## 6. Loading / disabled / lege / foutstatus

| Toestand | Gedrag |
|---|---|
| `wholeSetLoading` / `!matchingReady` | knop disabled, label met "…"; tooltip "Wacht tot bankdata volledig geladen is" |
| `wholeSetError` of `salesError` | knop niet renderen (banner rendert dan sowieso niet, gate op `matchingReady`) |
| `safeAvailableCount === 0` | knop niet renderen (geen ruis in de UI) |
| na klik | synchroon (alleen setState) — geen eigen loading-spinner nodig |
| `autoScanRunning`/`undoingBatch` | disabled om race met auto-scan te voorkomen |

## 7. Gedrag bij 0, 1 en veel veilige suggesties

- **0**: knop niet zichtbaar. De bestaande banner blokkeert zichzelf al bij `autoConfirm === 0 && toReview === 0`.
- **1**: label "Selecteer alle veilige suggesties (1)". Klik selecteert die ene regel; gebruiker kan alternatief direct op de rij-inline "✓ Bevestig" klikken — beide paden blijven werken.
- **Veel (bv. 200)**: `setSelectedIds` met 200 ids is O(n) — geen performance-issue. Bulk-toolbar toont "200 transactie(s) geselecteerd" en "Veilige suggesties bevestigen (200)". De bestaande bevestig-flow loopt sequentieel (regel 1314 e.v.) — geen wijziging aan snelheid, wel consistent met huidig gedrag.

## 8. Cross-page / filter / zoek

- Selectie leeft in `selectedIds` (whole-set-scope), niet in `tableRows`. Pagineren, filteren of zoeken verandert alleen wat zichtbaar is, niet de geselecteerde ids (eis 7).
- De bestaande header-checkbox (`Bank.tsx:2140-2141`) opereert op `tableRows` — dat blijft onaangeraakt. Verwarring wordt beperkt doordat de nieuwe knop expliciet "alle veilige suggesties" heet (niet "alle regels").
- Als de gebruiker daarna een filter kiest waardoor een geselecteerd id niet meer zichtbaar is: de bulk-toolbar telt en verwerkt nog steeds alle ids in `selectedIds`. Dit is consistent met huidig gedrag van andere bulk-acties.

## 9. Mobiel gedrag (≥375px)

- Banner heeft al `flex flex-wrap items-center gap-…`; de knop wrapt naar een nieuwe regel op smalle schermen. Geen extra CSS.
- Knop-min-height ≥40px via bestaande `size="sm"` Button — tap target voldoet.
- Label kan lang worden ("Selecteer alle veilige suggesties (147)"). Op 375px past dit op eigen regel; geen truncation nodig.

## 10. Toegankelijkheid

- `aria-label` gelijk aan zichtbare tekst inclusief count, bijv. `aria-label="Selecteer alle 47 veilige suggesties"`.
- `aria-disabled` volgt `disabled`.
- Bij state-verandering (na klik) toast fungeert als `role="status"` announcement (bestaande `useToast` doet dit al).
- Toetsenbord: standaard Button focusable, Enter/Space triggeren onClick — geen extra handler nodig.
- Kleurcontrast: `variant="outline"` gebruikt bestaande semantische tokens; geen hardcoded kleuren.

## 11. Tests

Toevoegen aan `src/test/` (Vitest + React Testing Library, dezelfde stijl als bestaande Bank-tests indien aanwezig; anders puur unit-test op de helper-afleiding):

1. **Renderen — knop verschijnt niet als `safeSuggestionIds.size === 0`.**
2. **Renderen — knop disabled als `!matchingReady`.**
3. **Label — toont juiste `safeUnselectedCount` bij mix van al-geselecteerd/nog-niet-geselecteerd.**
4. **Klik-gedrag — voegt ontbrekende veilige ids toe, laat bestaande handmatige (niet-veilige) selecties intact.**
5. **Klik-gedrag — na klik: `safeUnselectedCount === 0`, label wordt "Alle veilige suggesties geselecteerd (N)" en knop disabled.**
6. **Cross-page — met `page=2` en veilige suggesties op page 1, klik selecteert ook de niet-zichtbare ids.**
7. **Integratie — na klik + klik op bestaande "Veilige suggesties bevestigen": `handleBulkConfirmSuggestions` wordt aangeroepen met alle N ids (mock op update-calls).**
8. **Race — knop disabled tijdens `autoScanRunning`.**

Als geen bestaande UI-test-setup voor `Bank.tsx` bestaat, minimaal test 1-6 als pure functie-test op een geëxtraheerde helper (zonder helper te introduceren: dan als component-test met mocks voor `useBankTransactions`/`useSalesInvoices`/`usePurchaseInvoices`).

## 12. Betrokken bestanden

- `src/pages/Bank.tsx` — enige productiewijziging: één nieuwe Button in de bestaande auto-scan banner (rond regel 1930), plus een lokale afgeleide `safeUnselectedCount`. Geen wijziging aan `safeSuggestionIds`, `handleBulkConfirmSuggestions`, `handleAutoScan`, `toggleSelect`, `toggleSelectAll` of de bulk-toolbar.
- `src/test/bank-select-safe-suggestions.test.tsx` (nieuw) — testcases 1-8.

Geen wijzigingen aan hooks, types, migraties, RLS, `snelstart-export`, `BankAfletteringDrawer`, `BankMatchDialog`.

## 13. Risico's & edge-cases

| Risico | Mitigatie |
|---|---|
| Gebruiker denkt dat knop direct bevestigt i.p.v. selecteert | Expliciete tekst "Selecteer…" + toast na klik die verwijst naar de bevestig-knop |
| Verwarring tussen header-checkbox (pagina, 50) en nieuwe knop (whole-set, veilig) | Duidelijk verschillende labels; verbetering 1 (select-all-pagina) is een separate PR |
| `safeSuggestionIds` verandert tussen selecteren en bevestigen (bijv. door refetch) | `handleBulkConfirmSuggestions` her-checkt safety per id (bestaand gedrag) — onveilige ids worden alsnog overgeslagen |
| Race met `handleAutoScan` (die zelf ook veilige matches bevestigt) | Knop disabled bij `autoScanRunning` + `undoingBatch` |
| Grote selectie (>500) laat bulk-bevestig lang lopen | Geen nieuwe scope — bestaand bulk-gedrag; kan later apart geoptimaliseerd |
| Selectie blijft staan als gebruiker van klant wisselt | `selectedIds` wordt vandaag gereset bij client-wissel (bestaand gedrag, regel ~200); niet aangeraakt |
| Screen reader hoort alleen count-verandering niet | Toast fungeert als announcement |

## 14. Buiten scope (expliciet)

- Select-all-over-alle-pagina's voor willekeurige rijen (dat is verbetering 1).
- Wijzigen van `isSafe`-criteria in `safeSuggestionIds`.
- Extra confirm-modal.
- Keyboard shortcut voor deze actie (valt onder verbetering 4).
- Zichtbaar veilig/onveilig-badge in de tabel (verbetering 6).
