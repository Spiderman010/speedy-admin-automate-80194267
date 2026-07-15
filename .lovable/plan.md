# Nulmeting BoekAssist — 14 juli 2026

Peildatum: dinsdag 14 juli 2026. Meting alleen; geen codewijzigingen.

## 1. Technische gezondheid

| Check | Resultaat |
|---|---|
| Typecheck (`tsgo --noEmit`) | Groen — 0 fouten |
| Lint (`npm run lint`) | 0 errors, **19 warnings** (ongewijzigd t.o.v. vorige nulmeting) |
| Tests (`npm run test`) | **76/76 groen** (5 bestanden: example, snelstart-export, client-readiness, purchase-line-validation, bank-statement-parser) |

Lint-warnings blijven twee categorieën:
- `react-refresh/only-export-components` in UI-primitives en context-hooks (badge, button, form, navigation-menu, sidebar, sonner, toggle, `useActiveOrganization`, `useAuth`, `useClientContext`) — geen bug, alleen hot-reload optimalisatie.
- `react-hooks/exhaustive-deps` op drie plekken: `Bank.tsx:1657` (`salesInvs` overbodig), `Grootboek.tsx:76` (`seedRek` ontbreekt), `Verkoop.tsx:300` (`getClientName` ontbreekt).

## 2. Database (Lovable Cloud)

| Metriek | Waarde |
|---|---|
| Database + PgBouncer | up |
| Restarts sinds boot | 0 |
| Geheugen | 50% |
| Data-disk | 3% |
| Verbindingen | 9/60 |
| Pool clients | 1/200 |
| DB-grootte | 16 MB |
| WAL | 64 MB |
| Teruggerolde transacties sinds boot | 7 |

Ruim binnen limieten; geen capaciteitszorg.

## 3. Database-linter

3× `WARN 0029` — `SECURITY DEFINER`-functies uitvoerbaar door ingelogde gebruikers. Dit betreft de trigger-helpers `set_organization_id`, `prevent_org_user_rebind`, `update_updated_at_column`. Ze zijn triggers (geen API-endpoints); ongewijzigd t.o.v. vorige meting.

## 4. Datavolumes

| Tabel | Aantal | Δ t.o.v. vorige nulmeting |
|---|---|---|
| clients | 10 | = |
| leveranciers | 25 | = |
| grootboekrekeningen | 457 | = |
| booking_templates | 34 | = |
| purchase_invoices | 48 | = |
| sales_invoices | 48 | = |
| bank_transactions | 2.055 | = |
| bank_transaction_allocations | 12 | = |
| journal_entries | 3 | = |
| vraagposten | 138 | = |

**Bank-transacties per status:**
- `handmatig_geboekt` 1.474
- `niet_gematcht` 553
- `gematcht` 25
- `suggestie` 3

**Inkoopfacturen:** `te_controleren` 13 · `gecontroleerd` 24 · `geexporteerd` 11
**Verkoopfacturen:** `concept` 12 · `gecontroleerd` 21 · `betaald` 15

## 5. Waarnemingen (geen actie zonder opdracht)

1. **553 niet-gematchte + 3 suggesties = 556 open banktransacties.** Onveranderd sinds vorige meting. Het nieuwe "Automatisch voorstellen" (met undo) is nog niet zichtbaar toegepast op deze backlog.
2. **`journal_entries` blijft op 3** terwijl 1.474 transacties `handmatig_geboekt` zijn en 11 inkoopfacturen `geexporteerd`. Sterk signaal dat de boekingsregel-schrijver hier geen rijen wegschrijft — nog steeds openstaand.
3. **3× `SECURITY DEFINER` WARN** ongewijzigd. Betreft trigger-functies, geen exposed endpoints.
4. **19 lint-warnings** ongewijzigd — cosmetisch, blokkeert niets.
5. **Geen component-/integratietests**; alleen pure lib-tests (76 stuks).

## Conclusie

Sinds de vorige nulmeting is er geen zichtbare beweging in data of health-metrics. Alle recente wijzigingen (server-side klantfilter, automatisch voorstellen, undo laatste batch) draaien groen door typecheck, lint en tests, maar zijn nog niet in de productiedata terug te zien (554 open banktransacties ongewijzigd, journal_entries nog steeds 3).

Zeg welk aandachtspunt je wil oppakken (bijv. onderzoeken waarom `journal_entries` leeg blijft, of de openstaande banktransacties in één sessie wegwerken met de nieuwe knop) en ik maak daar een gericht plan voor.
