
# Vraagpost Source Badges – Onderzoeksrapport

## 1. Huidige data model (`vraagposten`)

Kolommen (relevant):
- `id`, `user_id`, `client_id`
- `source_type` (text, NOT NULL) – vrije waarde, in code 4 varianten: `purchase_invoice` | `bank_transaction` | `sales_invoice` | `handmatig`
- `source_id` (uuid, nullable) – verwijst naar bron-row (geen FK)
- `categorie`, `titel`, `omschrijving`
- `status` (`open` | `in_behandeling` | `opgelost` | `genegeerd`), `resolved_at`
- `created_at`, `updated_at`

RLS: per `user_id`. Hooks: `useVraagposten(clientId?)`, `useCreateVraagpost`, `useUpdateVraagpostStatus`, `useDeleteVraagpost`. Labels: `VRAAGPOST_SOURCE_LABELS`, `VRAAGPOST_CATEGORIE_LABELS`.

## 2. Huidige creatie-flows

| Flow | Locatie | source_type |
|---|---|---|
| Bank-rij actie "Vraagpost" | `Bank.tsx` `handleMaakVraagpost` (regel 824) | `bank_transaction` (zet ook `match_status='wacht_op_factuur'`) |
| Bulk bank "Vraagpost" | `Bank.tsx` `handleBulkVraagpost` (regel 1155) | `bank_transaction` |
| Inkoopfactuur dialoog | `InvoiceEditDialog.tsx` (regel 786, knop "Maak vraagpost") | `purchase_invoice` |
| Vraagposten-pagina dialoog | `CreateVraagpostDialog` direct opgeroepen | `handmatig` (default) |
| Verkoop | – niets – | n.v.t. |

`useDeletePurchaseInvoice` ruimt gekoppelde vraagposten op (cascade in app-laag).

## 3. Source-types & `source_id` gebruik

- `bank_transaction` → `source_id = bank_transactions.id`
- `purchase_invoice` → `source_id = purchase_invoices.id`
- `sales_invoice` → vrijgegeven type, nog geen UI die er een aanmaakt
- `handmatig` → `source_id = null`

Geen DB-FK; integriteit volledig in app-laag.

## 4. Huidige badge-status per pagina

| Pagina | Vraagpost-badge nu zichtbaar? |
|---|---|
| `Bank.tsx` | **Ja** – badge "Vraagpost open/opgelost/genegeerd" in boeking-kolom (regel 1773-1795) + filter (regel 1453). |
| `Facturen.tsx` (inkoop) | **Nee** – geen indicator op rij; alleen `InvoiceEditDialog` heeft knop *Maak vraagpost*. |
| `Verkoop.tsx` (verkoop) | **Nee** – geen vraagpost-koppeling. |
| `Index.tsx` (dashboard) | Aggregaat-teller per klant (PR #61), geen per-row link. |

## 5. Aanbeveling eerste PR (minimaal, geen schemawijziging)

**Scope:** voeg dezelfde "Vraagpost"-badge die Bank al heeft toe aan inkoopfactuur-rijen in `Facturen.tsx`. Niets meer.

Reden: Bank is al klaar; inkoop is de tweede plek met bestaande creatie-flow en source_id-mapping. Verkoop overslaan (geen creatie-flow, dus geen bestaande data om te tonen).

### UI-plaatsing
- In `Facturen.tsx`, tab "te_controleren" + "alle", in de bestaande leverancier-/status-kolom: extra `<Badge>` regel eronder, identiek aan Bank-styling:
  - open → amber outline
  - opgelost → groen outline
  - genegeerd → secondary
- Tekst: "Vraagpost open" / "Vraagpost opgelost" / "Vraagpost genegeerd"
- Tooltip met `vp.titel` voor context.

### Navigatie
- Klik op badge → `navigate('/vraagposten')` met query-param `?focus=<vp.id>`.
- In `Vraagposten.tsx`: lees `useSearchParams()`, scroll rij in view + tijdelijke highlight (CSS ring 2s). Geen filter-injectie, geen modal.
- Geen omgekeerde "open bron"-knop in Vraagposten-pagina in deze PR (zie §11).

### Data
Hergebruik `useVraagposten(clientFilter)` (dezelfde hook die Bank ook gebruikt). Bouw map `vraagpostByInvoiceId` analoog aan `vraagpostByBankTransactionId`. Filter op `source_type === 'purchase_invoice'`.

## 6. Duplicate-prevention

Bestaande regel in `handleMaakVraagpost` (Bank, regel 824-862): checkt of er al een vraagpost met dezelfde `source_type`+`source_id` bestaat vóór insert; toont toast "Vraagpost bestaat al". 

`InvoiceEditDialog` doet die check **niet**. Buiten scope van deze PR, maar noteren als opvolger.

## 7. Bestanden waarschijnlijk geraakt

- `src/pages/Facturen.tsx` – import `useVraagposten`, badge in tabelrij, klik → navigate.
- `src/pages/Vraagposten.tsx` – lees `?focus=`, scroll + highlight.
- Geen nieuwe componenten, geen nieuwe hooks, geen migraties, geen types.ts edits.

## 8. Acceptatiecriteria

- Inkoopfactuur-rij met bijhorende `vraagposten`-record toont badge met juiste status.
- Klik op badge navigeert naar `/vraagposten?focus=<id>` en scrollt rij in beeld met korte highlight.
- Geen badge wanneer er geen vraagpost is.
- Bestaande Bank-badges en filters ongewijzigd.
- `npx tsc --noEmit`, `npm run lint`, `npm run test` groen.
- Geen migraties, geen schemawijziging, geen wijziging in `src/integrations/supabase/types.ts`.

## 9. Risico's

- **Laag.** Pure read + display. Geen mutatie, geen export-pad. Extra query per Facturen-render, maar `useVraagposten` is reeds gecached door react-query.
- Kleine kans op verkeerde mapping als ooit een verkeerd `source_type` in DB staat → filter op exact `'purchase_invoice'` voorkomt dit.

## 10. Wat **niet** in deze PR

- Geen auto-creatie van vraagposten (triggers, OCR-blokkades).
- Geen verkoopfactuur-badges (geen creatie-flow → geen data).
- Geen "open bron"-knop in Vraagposten-pagina (omgekeerde navigatie); kandidaat voor PR-2.
- Geen duplicate-check in `InvoiceEditDialog`; kandidaat voor PR-3.
- Geen nieuwe vraagpost-categorieën, geen wijziging aan dashboard-teller.
- Geen routing-/sidebar-wijziging.

## 11. Vervolg-PR's (alleen ter info, niet bouwen)

1. Omgekeerde navigatie: in `Vraagposten.tsx` per rij een "Open bron"-knop die navigate naar `/bank?focus=<id>` of `/facturen?focus=<id>` (en in target-pagina identieke focus-handler).
2. Duplicate-check in `InvoiceEditDialog` (kopie van Bank-patroon).
3. Verkoopfactuur creatie-flow + badge (alleen als pilot dit nodig blijkt).

## 12. Implementatie-prompt voor latere build-loop

```
Task: Add "Vraagpost" badge to purchase invoice rows in Facturen.tsx and add a focus-on-load behaviour to Vraagposten.tsx. UI only, no schema, no migrations, no auto-creation.

Constraints:
- Do not change DB schema or src/integrations/supabase/types.ts.
- Do not add new hooks; reuse useVraagposten().
- Reuse existing Badge component styling identical to Bank.tsx (regel 1773-1795).
- Keep UI in Dutch.

Steps:
1. In src/pages/Facturen.tsx:
   - import { useVraagposten } from "@/hooks/useVraagposten";
   - import { useNavigate } from "react-router-dom";
   - Within the component, call useVraagposten(selectedClientFilter) (same client scope already used for invoices).
   - Build useMemo map vraagpostByInvoiceId: Map<string, Vraagpost> where source_type === "purchase_invoice".
   - In each invoice row (both relevant tabs), render the same three-state badge under the supplier/status cell. Clicking the badge calls navigate(`/vraagposten?focus=${vp.id}`) and stopPropagation so it does not open the InvoiceEditDialog.

2. In src/pages/Vraagposten.tsx:
   - useSearchParams to read ?focus=<id>.
   - After data load, scrollIntoView the matching row and apply a temporary ring (e.g. add a className for 2 seconds via setTimeout).
   - Do not change filters, sorting, or status.

3. Run npx tsc --noEmit, npm run lint, npm run test. All must be green.

4. Completion report:
   - Reviewed files
   - Changed files: only src/pages/Facturen.tsx and src/pages/Vraagposten.tsx
   - Migrations: None
   - Test results

Do not modify any other file. Do not introduce auto-creation logic. Do not touch Bank.tsx or InvoiceEditDialog.
```
