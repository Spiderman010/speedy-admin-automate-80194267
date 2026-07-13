
# Nulmeting BoekAssist — 13 juli 2026

Snapshot van de huidige staat. Geen wijzigingen — dit is puur meten.

---

## 1. Technische gezondheid

| Check | Resultaat |
|---|---|
| TypeScript (`tsgo --noEmit`) | Groen, geen fouten |
| ESLint | 0 errors, 19 warnings (react-hooks/exhaustive-deps + 1 react-refresh) |
| Unit tests (Vitest) | 76 / 76 geslaagd, 5 testbestanden |
| Console (preview) | Alleen 1 onschuldige `RESET_BLANK_CHECK`-warning |
| Runtime errors | Geen |

Lint-warnings van betekenis:
- `src/pages/Bank.tsx:1439` — onnodige dep `salesInvs` in useCallback
- `src/pages/Grootboek.tsx:76` — ontbrekende dep `seedRek`
- `src/pages/Verkoop.tsx:300` — ontbrekende dep `getClientName`
- `src/hooks/useClientContext.tsx:23` — export mix (fast-refresh)

Niet-blokkerend, wel schuld die op termijn verdient te worden opgeruimd.

---

## 2. Backend / Lovable Cloud

**Database health**
- DB + PgBouncer up, 0 restarts
- Memory 55%, disk 3%, DB-grootte 16 MB, WAL 64 MB
- Connecties 10/60, pool 1/200 → ruim binnen budget
- 6 rolled-back transactions since boot → normaal

**Supabase linter — 3 WARN's**
- 3× "Signed-in users can execute SECURITY DEFINER function". Betreft waarschijnlijk `set_organization_id`, `prevent_org_user_rebind`, `update_updated_at_column`. Deze zijn bedoeld als triggers en niet als API-endpoints — fix = `REVOKE EXECUTE ... FROM authenticated, anon` op deze functies. Geen acuut lek, wel aan te raden.
- `has_role`, `has_min_role`, `is_organization_member`, `role_rank` zijn terecht EXECUTE-bar (RLS-hulpfuncties).

**Auth / RLS**
- RLS-policies aanwezig op elke publieke tabel (4 policies per user-facing tabel).
- `has_role` gebruikt aparte `user_roles`-tabel met SECURITY DEFINER — conform Lovable-standaard.
- `set_organization_id`-trigger dwingt `organization_id` af bij insert — sluit multi-tenant lekken.

**Storage** — bucket `invoices` (private). OK.

**Secrets** — LOVABLE_API_KEY + Supabase-set aanwezig, geen missing.

---

## 3. Data & functionele status

**Volumes**
| Tabel | Rijen |
|---|---|
| clients | 10 |
| leveranciers | 25 |
| grootboekrekeningen | 457 |
| booking_templates | 34 |
| purchase_invoices | 48 |
| sales_invoices | 48 |
| bank_transactions | 2 055 |
| bank_transaction_allocations | 12 |
| journal_entries | 3 |
| vraagposten | 138 |
| organizations / profiles / user_roles | 2 / 2 / 3 |

**Inkoopfacturen (48)**: 13 te_controleren · 24 gecontroleerd · 11 geëxporteerd
**Verkoopfacturen (48)**: 12 concept · 21 gecontroleerd · 15 betaald
**Banktransacties (2 055)**: 25 gematcht · 1 474 handmatig geboekt · **553 niet_gematcht** · 3 suggestie

De 553 niet-gematchte + 3 suggesties zijn de openstaande werkvoorraad in de Verwerkingsscherm-flow.

**Journal_entries = 3** valt op: verhouding tot 1 499 verwerkte banktx + 45 afgeronde facturen suggereert dat het journaal nog niet consequent wordt gevuld — potentiële gap in de export/afrondingsketen.

---

## 4. Codebase-schaal (informatief)

- 7 hoofdroutes actief: `/dashboard /klanten /facturen /bank /verkoopfacturen /snelle-invoer /overzichten` + auth
- 2 edge functions: `process-invoice`, `process-sales-invoice`
- UBL (NLCIUS) + Snelstart-CSV export aanwezig, met dedicated tests
- Testdekking beperkt tot: bank-parser, snelstart-export, purchase-line-validation, client-readiness (geen component/integration tests)

---

## 5. Aandachtspunten voor volgende iteratie (geen actie nu)

Prioriteit hoog → laag, puur observatie:

1. **Journal_entries only 3** — controleer of boekingsregels wel schrijven bij "handmatig_geboekt" / geëxporteerd.
2. **553 openstaande banktransacties** — grootste werkbacklog; Verwerkingsscherm is hiervoor gebouwd, meten of hij op productiedata werkzaam is.
3. **3× SECURITY DEFINER linter-warning** — REVOKE EXECUTE op trigger-only functies.
4. **19 lint-warnings** — technische schuld in hooks van Bank/Grootboek/Verkoop.
5. **Geen component/integration tests** — huidige suite dekt alleen pure libs.

---

## Volgende stap

Zeg welk punt je wil oppakken (bv. "fix de SECURITY DEFINER warnings" of "onderzoek waarom journal_entries leeg blijft"), dan maak ik daar een gerichte plan voor.

Dit is een read-only nulmeting; er zijn geen bestanden gewijzigd.
