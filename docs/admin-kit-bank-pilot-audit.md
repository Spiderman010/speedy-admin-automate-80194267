# BoekAssist — Admin Kit bank- en grootboekpilot (read-only audit)

## Doel
Bestaande bank- en grootboekschermen sneller verbeteren zonder financiële schrijvers, RLS, tenantisolatie, append-only ledger, of boekingslogica te veranderen.

## Vastgestelde bronnen
- Aangeleverd archief `admin-kit-shadcnblocks(2).zip`, map `shadcn-admin-2.3.0/`.
- Admin Kit package.json: Next.js 16.1.6, React 19.2.4, Tailwind 4, @tanstack/react-table 8.21.3.
- BoekAssist package.json: React 18, Vite 5, Tailwind 3, TanStack Query; geen TanStack Table dependency.
- `src/pages/Bank.tsx` en `src/pages/Grootboek.tsx` zijn bestaande bedrijfskritische schermen; niet vervangen als eerste experiment.
- Admin Kit voorbeelden: `src/app/(admin)/original/(tasks)/tasks/components/data-table-*.tsx` en `src/app/(admin)/original/(users)/users/components/data-table-*.tsx`.

## Keuze
1. **P0**: PR #260 bankcorrecties eerst onafhankelijk afronden. Geen styling-PR die financiële correctieflows tegelijk raakt.
2. **Pilot**: maak op een featurebranch een NIEUWE, originele presentatielaag voor uitsluitend read-only banktransacties (maximaal één afgebakende tabel), met huidige data-query en filtering, zonder de tabel die mutaties initieert te vervangen.
3. **Functionaliteit**: sorteerbare kolommen datum/omschrijving/bedrag/status, zoekfilter, keyboard-toegang, duidelijke selectie, paginering; behoud null states, tenantcontext en database-serverfiltering.
4. **Techniek**: evalueer `@tanstack/react-table` als onafhankelijke MIT-library in React 18/Tailwind 3; geen Next.js router, server actions, React 19 of Tailwind 4 kopiëren.
5. **Vergelijk**: bestaande schermen versus pilot: functionaliteit, performance bij 2.860 banktransacties, accessibility, regressies, onderhoud en code-omvang.
6. **Grootboek** pas na positieve bankpilot; hergebruik dan dezelfde eigen tabelprimitieven.

## Licentiegate
De ZIP verwijst naar https://www.shadcnblocks.com/license. De huidige betaalde licentie staat commerciële eindproducten/SaaS toe, maar verbiedt herdistributie van componenten/derivaten buiten een eindproduct, inclusief publicatie van componentbroncode in een publieke repository. De exacte koper/licentiehouder, Standard-vs-Team-rechten en zichtbaarheid van de BoekAssist-repo moeten vóór overname van templatecode gecontroleerd worden.

**Geen Admin Kit-broncode, layout-derivaten, screenshots of assets in deze PR overgenomen.** Ontwerp-ideeën en onafhankelijke libraries zijn geen kopie van de template.

## Acceptatie
- Geen database SQL of migrations.
- Geen directe aanpassingen aan `src/integrations/supabase/types.ts`.
- Bestaande boekings- en bankcorrectiehandlers ongewijzigd.
- Toekomstige pilot heeft concrete componenttests, Nederlandse bedragen/datums, lege tabel, meerdere administraties, paginering en keyboardtests.
- Pre-merge: TypeScript, lint, tests, build, Codex; eigenaar beslist over merge.
