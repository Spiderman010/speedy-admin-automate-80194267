# BoekAssist delivery roadmap — Agio Finance eerst (20 oktober 2026)

## Productbesluit
**Eerst:** intern, kant-en-klaar dagelijks boekhoudwerk voor Agio Finance.
**Daarna:** multitenant SaaS voor administratiekantoren.
**Niet nu:** zzp-facturatie als apart product, herbouw van accounting engine, cosmetische dashboardmigraties, nieuwe monitor-PR's, betaalde licenties zonder gemeten behoefte.

## Uitvoeringsregels
1. Lees `AGENTS.md`, `PROJECT_MAP.md`, `BOOKASSIST_AI_BUILD_STRATEGY.md` en `BOOKASSIST_ACCOUNTING_PATTERNS.md` bij elk werkpakket.
2. Werk vanuit actuele `main`, featurebranch, samenhangende PR. Geen directe commits op `main`.
3. Bestaande financiële schrijf-RPC's en `ledger_postings` zijn leidend; bewijs productie-migratiestatus read-only. `src/integrations/supabase/types.ts` niet handmatig wijzigen.
4. Groene CI op exacte head-SHA, 0 open reviewthreads en zelfstandige financiële/security/tenantisolatie-review. Codex waar beschikbaar; gebruikslimiet is na vastgelegde onafhankelijke review geen automatische blokkade. P0/P1 blokkeren altijd.
5. Geen merge, Lovable Cloud-productie-SQL of productie-uitrol zonder afzonderlijke expliciete GO. Geen productie-SQL via persoonlijk Supabase- of Vercel-account. Projectref: `alxlbdhpbwlehbdbfejw`.
6. Bundel samenhangende wijzigingen in één eind-tot-eind werkpakket. Vermijd tussenliggende documentatie-, proces- of cosmetische micro-PR's.

## Volgorde en oplevercriteria

### P0 — Bankverwerking veilig operationeel (nu)
**Bestaand werk:** #263 is gemerged (`36c897a`); #260 is gesloten zonder merge wegens oudere overlappende correctie-UI.
- #263: import-idempotentie, bronbewuste CAMT/MT940-herkenning, geen stil gekozen btw, duidelijk onderscheid gecodeerd/geboekt, behoud originele omschrijving. Nieuwe migratie `20261020120000_add_bank_transaction_import_fingerprint.sql` NIET toegepast.
- #260: bankboekingen via `reclassify_bank_transaction` corrigeren, inclusief audittrail; RPC en gebeurtenistabel zijn volgens door gebruiker aangeleverde productie-SELECT aanwezig, maar rechten en exacte functiebody nog niet gecontroleerd.
- **Werkvolgorde:** actuele `main` is leidend. De correctie-UI bevat een fail-closed RPC-beschikbaarheidscontrole. Verifieer productiefunctie, rechten en migratiestatus read-only. De bankimportmigratie `20261020120000` is niet als toegepast bevestigd. Productiehandeling alleen na afzonderlijke GO via Lovable Cloud SQL-editor.
- Productiehandelingen afzonderlijk plannen: eerst read-only preflight, migraties vergelijken met aanwezige schema's, dan pas GO voor noodzakelijke enkelvoudige migratie.
- **Klaar wanneer:** voor meerdere Agio-administraties import, controle, afletteren, coderen, boeken en toegestane correcties in end-to-end scenario's betrouwbaar werken; geen dubbelboeken, geen tenantlekken, btw expliciet, audit zichtbaar.

### P1 — Inkoopwerkbank en documenten (volgende)
- Bestaande inkoopworkflow afronden: ontvangst > PDF/UBL bekijken > leverancier en btw controleren > grootboekcodering > boeken > bankafletteren > vraagpost bij twijfel.
- Hergebruik bestaande Radix/shadcn, React Hook Form, Zod en documentcomponenten.
- Onderzoek gratis `pdfjs-dist` voor in-app PDF-voorvertoning; pas integreren als huidige viewer onvoldoende is.
- Vergelijk gratis `invoice2data` / OCR alleen in geïsoleerde proef met 50 **geanonimiseerde** facturen; Python-service is geen directe React-drop-in. Geen geautomatiseerde boeking zonder deterministische controles.
- **Klaar wanneer:** 20 representatieve documenten end-to-end verwerkt met correcte btw, dubbele-factuurpreventie, boeking en bankmatch.

### P2 — Verkoop, memoriaal en periodeafsluiting
- Betrouwbare facturen en UBL, memoriaal, correcties/tegenboekingen, btw-controle.
- Grootboek ↔ proef-/saldibalans ↔ resultaat/balans reconcilieerbaar, afwijkingen zichtbaar.
- **Klaar wanneer:** ten minste één volledige Agio-testadministratie per periode sluitend van bronstuk tot rapportage kan worden doorlopen.

### P3 — Kantoorwerkvoorraad
- Eén overzicht per klant en over alle klanten: bankregels zonder match, facturen ter controle, vraagposten, btw-deadlines en blokkades.
- Alleen bestaande componenten en bestaande tenant-gefilterde data gebruiken.
- **Klaar wanneer:** medewerker vanuit één werkvoorraad uitzonderingen kan afhandelen zonder elke administratie afzonderlijk te openen.

### P4 — Integraties
- SnelStart: interne maatwerkaanvraag; callbackserver-specificatie en toestemming verifiëren. Eerst veilige read-only synchronisatieproef, geen aanname over webhookprotocol.
- Bankconnectors en betaalde OCR pas aanschaffen na proef, volumetarief, dekking en contractuele SaaS-rechten.
- **Klaar wanneer:** gecontroleerde import/export met bron-ID's, foutafhandeling, idempotentie en audit.

### P5 — Intern acceptatietraject
- Agio Finance gebruikt BoekAssist parallel met bestaande administratie; reconciliatie over afgesproken representatieve periode.
- Defecten registreren op financiële ernst (P0/P1/P2), geen nieuwe features die de acceptatie verstoren.
- **Klaar wanneer:** eigenaar dagelijkse werkprocessen aantoonbaar accepteert en financiële resultaten controleerbaar overeenkomen.

### P6 — Commerciële SaaS voor administratiekantoren (pas na P5)
- Onboarding van kantoren, org-/klantisolatie, rollen, abonnementen, support, auditretentie, back-up/restore, privacy, monitoring en commerciële documentatie.
- Licenties van ingekochte/open-source componenten expliciet toetsen op SaaS-toepassing.

## Openstaande PR's / opruimen
- #263: gemerged (`36c897a`); SQL-migratie niet automatisch uitgevoerd.
- #260: gesloten zonder merge; oude UI niet opnieuw introduceren.
- #261: optionele UI-pilot met open zoekfilterbevinding; niet leidend.
- #258/#259: gecombineerde read-only pre-/postchecks; eerst actuele productie-uitrolhistorie verifiëren voordat documentatie wordt verwijderd.
- #262: gesloten zonder merge.

## Rapportage en tempo
Per werkpakket alleen: (1) gerealiseerde gebruikersflow, (2) CI/testbewijs op exacte SHA, (3) resterende P0/P1/P2, (4) benodigde GO. Geen eindeloze voortgangsgesprekken.

**Eerste uitvoeractie na deze roadmap:** read-only productiepreflight voor bankimport en bankcorrecties, resterende migratie- en rechtenverschillen beoordelen, daarna apart GO/NO-GO voor één migratie. Vervolgens P1 inkoopwerkbank.
