# DOC-3a — Frontend audit preview-pad inkoopfacturen

## Data path (geverifieerd, exact)

```
useActiveOrganization() → activeOrganizationId
  ↓
usePurchaseInvoices({ organizationId })          [src/hooks/usePurchaseInvoices.ts:15-30]
  queryKey: ["purchase_invoices", orgId, clientId]
  .from("purchase_invoices").select("*").eq("organization_id", orgId)
  ↓
invoices (PurchaseInvoice[])
  ↓
filteredSorted (useMemo, client-side filter/sort)  [Facturen.tsx:377]
  ↓ row klik → setEditInvoice(inv)
editInvoice (volledige row, ongewijzigd)
  ↓
<InvoiceEditDialog invoice={editInvoice} ... />   [Facturen.tsx:890-905]
  ↓
<InvoicePreview key={invoice.file_path ?? invoice.id}
                filePath={invoice.file_path} />   [InvoiceEditDialog.tsx:670]
  ↓
supabase.storage.from("invoices")
  .createSignedUrl(filePath, 3600)                [InvoiceEditDialog.tsx:72]
```

## Audit-antwoorden

1. **InvoiceEditDialog opened from**: `Facturen.tsx:890`, gevoed door `editInvoice` state.
2. **Doorgegeven object**: ongewijzigde `PurchaseInvoice` rij uit de query.
3. **`invoice.file_path` → `InvoicePreview`**: 1-op-1, geen transformatie (`filePath={invoice.file_path}`).
4. **Bucket prefix `invoices/`**: niet toegevoegd. Bucket is correct via `.from("invoices")`, pad is ruw `file_path`.
5. **Normalisatie/encoding van `file_path`**: geen. Niet getrimd, niet ge-encodeerd, niet ge-lowercased.
6. **Prev/next navigatie**: gebruikt `filteredSorted[editInvoiceIdx ± 1]` — index opnieuw berekend per render (`useMemo` op `editInvoice + filteredSorted`, Facturen.tsx:404). Correct.
7. **`user_id` filter resterend**: **geen** in `usePurchaseInvoices` of in `Facturen.tsx` rond invoices. Hook filtert puur op `organization_id` (en optioneel `client_id`).
8. **React Query cache key**: `["purchase_invoices", organizationId ?? "all", clientId ?? "all"]` — org-scoped ✓. Organisatie-switch invalideert dus geen cross-contaminatie.
9. **Selected invoice zonder file_path**: `hasFile = !!invoice.file_path` (regel 549) wordt gebruikt; `InvoicePreview` toont expliciet "Geen bestand beschikbaar" als `filePath` null is. Signed-URL fouten worden onderscheiden in `missing` / `unauthorized` / `error` met console.error logging.

## Bestandstype-detectie

- `isPdf = filePath.toLowerCase().endsWith(".pdf")` — case-insensitief, dus `.PDF` werkt.
- Edge function dwingt extensie af van `file.name.split('.').pop()`. Uit DB: alle 48 paden eindigen op `.pdf` of `.jpg` (lowercase, want browser-MIME). Geen risico op extensieloze bestanden in huidige data.
- Bestanden zonder extensie of met verkeerde MIME zouden in de `<img>`-tak vallen en `renderError` triggeren → fallback "Bestand openen in nieuw tabblad". Niet een blokkade, wel een zichtbare melding.

## Root cause kandidaten

**Geen frontend bug gevonden.** De data path is schoon:
- query is org-scoped
- cache key bevat org
- geen user_id filter
- `file_path` wordt onveranderd doorgegeven
- bucket is correct (`invoices`)
- preview heeft adequate fallback + console logging

Combineer met DOC-2 (storage policy + data 100% consistent) → **er is op dit moment geen aantoonbare bug** in storage RLS, data, of frontend pad-afhandeling voor de invoice preview.

## Geen code-wijziging voorgesteld

Conform "Do not change code unless a specific frontend bug is found": geen PR.

## Aanbevolen volgende diagnostische stap (geen wijziging)

Als de gebruiker nog steeds een lege/foutieve preview ziet, vraag exact:

1. **Browser console**: welke van deze logs verschijnt?
   - `InvoicePreview createSignedUrl error <path> <error>` (RLS/404)
   - `InvoicePreview createSignedUrl exception` (netwerk/JS)
   - `InvoicePreview image render error` (MIME/extensie)
   - Géén log → geen klik op rij of `file_path` is null.
2. **Welk pad** staat in die log (kopieer letterlijk).
3. **Welke user** is ingelogd (om aan een org-membership te koppelen).
4. **Welke melding** in de UI: "Geen bestand beschikbaar" / "Bestand ontbreekt of pad klopt niet" / "Geen toegang tot bestand" / "Document kan niet worden geladen" / "Bestand kan niet worden weergegeven".

Met die 4 punten is verder graven mogelijk zonder credits te branden op speculatie. Pas dán DOC-3b openen voor een gerichte fix.

## Niet aangeraakt

Geen migratie, geen RLS/storage, geen edge function, geen types, geen accounting/export logica, geen code. Alleen leesoperaties.
