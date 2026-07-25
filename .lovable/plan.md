# Beoordeling BoekAssist — main na PR #124

Alleen review, geen code-, DB- of type-wijzigingen. HEAD: `45c0b5e` (Merge PR #124). Tests: `221/221 ✅` (waarvan `sales-invoices-pagination.test.tsx` 42, `bank-transactions-pagination.test.tsx` 14).

## Resultaat per onderdeel

### 1. Paginering verkoopfacturen — Geslaagd
- `SALES_INVOICES_PAGE_SIZE = 50` (`src/hooks/useSalesInvoices.ts:10`), server-side `.range(from, from+pageSize-1)` met `count: "exact"` (regels 144-150).
- Vorige/Volgende gedisabled op grenzen; `totalPages = Math.max(1, ceil(totalCount/50))` (`Verkoop.tsx:237`).
- Bij verkleining resultaatset klemt `clampPage` naar laatste geldige pagina (regels 266-268).

### 2. Filters en zoeken — Geslaagd
- Zoeken op `invoice_number`, `customer_name`, `status` via veilig-geëscapete `.or(ilike)` (regel 60, `escapeIlikeValue` + `buildIlikeOrFilter`).
- Betaalstatusfilters gebruiken `useScopedSalesInvoices` (whole scoped set, batched 1000, correct >1000 rijen) en filteren/sorteren/pagineren in-memory — pager-totaal reflecteert de gefilterde whole set (`Verkoop.tsx:197-236`).
- `filterSignature` reset naar `page=1` bij wijziging van search, workflow-, betaalfilter, sort, klant of organisatie (regels 254-262). Eerste run wordt overgeslagen via `firstFilterRun`.

### 3. Veilig wisselen klant/organisatie — Geslaagd
- Paginated query heeft **geen** `placeholderData/keepPreviousData` (bewust commentaar regels 152-156 in hook, 241-244 in pagina) → `pageInvoices` is `undefined` tijdens refetch, tabel toont loading (`isLoading` gate regel 678).
- `queryKey` bevat `activeOrganizationId ?? "none"` en `clientId ?? "all"` (hook regels 124-135) → cache is org+klant-gescopeerd; stale rijen kunnen niet lekken.

### 4. Dubbele facturen — Geslaagd
- `useSalesInvoiceDuplicates` doet een server-side ilike-net over factuurnummers van de huidige pagina, gebatched (25 nummers × 1000-rijen paging) en vindt dus duplicaten op andere pagina's (`useSalesInvoices.ts:403-442`).
- Finale match via genormaliseerde `customer_name+invoice_number` (trim+lowercase) in `computeSalesDuplicateIds` — over-matches worden gefilterd.

### 5. Bankmodule — Geslaagd
- `wholeSetReady = hasSelection && !wholeSetLoading && !wholeSetError && !!rawTransactions` (`Bank.tsx:260`).
- `salesReady = hasSelection && !salesLoading && !salesError && !!salesInvs` (regel 280) — een fout wordt **niet** als lege dataset behandeld.
- `matchingReady = wholeSetReady && salesReady` (regel 283) gate't Automatch, Verwerken, Afletterrapport (`disabled={!hasSelection || !matchingReady}` regels 1811, 1836; auto-scan panel gate regel 1907). Bij salesError toont een expliciete banner (regels 1874-1877).

### 6. Visuele controle desktop/mobiel — Niet uitgevoerd
Geen live browser-verificatie gedraaid (sandbox `signed_out` in vorige turns). Aanbeveling: quick pass op `/verkoopfacturen` en `/bank` op 375px + desktop, met focus op paginator wrap en toolbar-buttons.

## Gevonden fouten
Geen kritieke, hoge of middel-ernstige defecten aangetroffen in scope. Lage observaties:
- **Laag** — visuele responsive check nog niet handmatig geverifieerd.
- **Laag** — server-side sort op afgeleide betaalstatus is bewust niet ondersteund; UI-comment documenteert dit (`useSalesInvoices.ts:63-66`). Prima, mits UX-verwachting hierop aangepast blijft.

## Conclusie
De gemergede versie (`45c0b5e`) kan **veilig verder gebruikt worden**. Alle expliciete eisen (paginering, filters/reset, veilig org/klant-wissel, cross-page duplicaten, matching-gating met fout≠leeg) zijn in de code aantoonbaar geïmplementeerd en gedekt door 56 pagineringstests.

## Aanbevolen vervolg
1. Handmatige responsive smoke test op mobiel (375px) voor `/verkoopfacturen` en `/bank`.
2. Overweeg een aparte loading-skeleton bij betaalfilter-wissel (nu deelt die de gewone table-loader — cosmetisch).
