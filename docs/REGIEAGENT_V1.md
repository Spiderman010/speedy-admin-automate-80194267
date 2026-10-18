# BoekAssist Regieagent v1 — werkprotocol

**Status:** voorstel op een featurebranch; na merge bruikbaar als ontwikkelregie. Dit is **geen** autonoom draaiende bot, geen geplande monitor en geen onderdeel van de BoekAssist-productieapp. GitHub Issues zijn het taakregister; GitHub Pull Requests en Actions zijn het controlebewijs. De regieagent kan in een actieve ChatGPT-/Claude-sessie het werk organiseren en (binnen de verleende rechten) uitvoeren.

## 0. Bestaande afspraken gaan voor

Read `AGENTS.md` and `PROJECT_MAP.md` first. Ook verplicht voor alle uitvoerende agents. Raadpleeg `BOOKASSIST_AI_BUILD_STRATEGY.md` voor onderzoek, parallelisme en reviews, `BOOKASSIST_ACCOUNTING_PATTERNS.md` voor grootboekschrijvers en `docs/CLAUDE_WORKFLOW.md` voor de bestaande Claude-guards. Dit protocol vervangt die regels niet.

- Repository: `Spiderman010/speedy-admin-automate-80194267`; start altijd vanaf de op dat moment nieuwste `main`.
- Alleen een eigen `feature/`- of `fix/`-branch, met PR naar `main`. Nooit rechtstreeks committen of pushen naar `main`.
- Productiebackend: Lovable Cloud, projectref `alxlbdhpbwlehbdbfejw`. Productie-SQL uitsluitend via de zichtbare Lovable Cloud SQL-editor, na een **apart en expliciet productie-GO**.
- Niet gebruiken voor BoekAssist-productie: `olumcwneiejjefhkzgmz`, `ycuofllsdssoezwwpqmv`, persoonlijk Supabase-dashboard, Vercel Supabase Marketplace, Combined Fresh Install Schema.
- `src/integrations/supabase/types.ts` nooit handmatig wijzigen; `VITE_SUPABASE_URL` niet terloops veranderen.

## 1. Intake: één taak, één eigenaar, één doel

Maak een GitHub Issue met de template **BoekAssist — regietaak** of leg dezelfde gegevens compact in de chat vast:

| Veld | Minimum |
|---|---|
| Doel | Probleem en gewenst resultaat in één of twee zinnen |
| Scope | Wat wel/niet gewijzigd mag worden, eventuele betrokken bestanden |
| Risico | **L** (documentatie/kleine UI), **M** (appflow/tests), **H** (financiële boekingen, RLS/auth, schema, data, productie) |
| Acceptatie | Concreet en verifieerbaar: tests, gedrag, regressies |
| Afhankelijkheid | Open PR, migratie, review, exclusieve file-eigenaar of `geen` |

Geen extra formulier nodig als de feiten al vaststaan: de regieagent vult de intake uit de context en vraagt alleen echt ontbrekende beslissingen. Geen werk starten op basis van een veronderstelde productie- of mergeautorisatie.

## 2. Taakverdeling zonder dubbele inspanning

| Rol | Verantwoordelijkheid |
|---|---|
| **Regie (ChatGPT)** | Controleer repo, actuele `main`, afhankelijkheden en risico; leg scope vast, kies uitvoerder, controleer bewijs en geef een kort STOP/GO-advies |
| **Claude Code** | Onderzoek en implementatie van complexe, financiële of databasegerelateerde taken; eigen branch + PR, tests en volledig eindrapport |
| **Codex / onafhankelijke reviewer** | Adversarial review op een **vaste head-SHA**, vooral tenantisolatie, dubbele boekingen, correcties, races en productiegrenzen |
| **Lovable** | UI/UX en previews; geen zelfstandige wijzigingen aan financiële waarheid, beveiligingsgrenzen of productieschema |
| **Eigenaar** | Beslist over financiële contracten, risicowaivers, merges en iedere productie-uitrol |

Het onafhankelijke oordeel mag niet door de schrijver van hetzelfde werk worden geclaimd. Als Codex een gebruikslimiet heeft: noteer **review niet uitgevoerd**; gebruik een andere onafhankelijke reviewer of vraag de eigenaar een **PR- en SHA-specifieke** uitzondering. Voor H-risico's nooit automatisch een review overslaan.

Parallel uitvoeren mag bij gescheiden modules en bestanden. Twee uitvoerders mogen niet dezelfde bestanden aanpassen; geen parallelle productie-SQL of ongereviewde schemawijzigingen. Scheid complexe architectuur en implementatie.

## 3. Statusmachine

`INTAKE → RESEARCH (indien nodig) → READY_TO_BUILD → BUILDING → REVIEW → READY_FOR_MERGE → MERGED`

Afwijkingen gaan naar `BLOCKED` met oorzaak en eerstvolgende actie. Schema- of productieafhankelijke taken gaan na merge naar `ROLLOUT_PENDING`; pas na apart productie-GO, preflight, uitvoering, postchecks, typesynchronisatie en documentatie naar `DONE`. Een gemergede migratie is **niet** automatisch productie toegepast.

**Fast lane L:** kleine documenten/typen/UI zonder financiële gevolgen → één branch, smalle diff, verplichte CI en review passend bij risico; geen onnodig architectuurtraject.

**Controlled lane M/H:** eerst een kort contract op basis van bestaande code en bewezen patronen, dan implementatie, onafhankelijke toetsing en expliciete eigenaarsbeslissing.

## 4. Mergepoort — elke PR apart

Een PR is pas `READY_FOR_MERGE` nadat de regieagent **direct vooraf** verifieert:

1. De PR is open, niet draft, base = `main`, head-SHA en main-SHA zijn actueel; wijziging is mergeable en bevat alleen afgesproken bestanden.
2. `Typecheck, lint, tests & build` is **groen op die head-SHA**; testskip's en bekende beperkingen zijn expliciet gedocumenteerd. De CI-testen draaien zonder productiecredentials; de vijf live securitytests zijn bewust uitgesloten.
3. Reviewthreads: geen open P0/P1/P2; Codex-/onafhankelijke review matcht de **laatste** head-SHA of een expliciet, beperkt en vastgelegd eigenaarsbesluit dekt het ontbreken ervan.
4. Iedere afwijkende status (bijv. historische rode Vercel-status bij Lovable) is verklaard en **per PR** geaccepteerd; een eerdere waiver erft niet mee.
5. **De eigenaar geeft expliciet merge-GO voor die PR met de exacte head-SHA en geaccepteerde uitzonderingen.** Controleer daarna opnieuw en merge met `expected_head_sha`; bij elke verandering STOP.

**Geen automatische merge, ook niet bij groene CI.** Verificatie na de merge: GitHub meldt `merged=true`, de mergecommit staat daadwerkelijk op `main` en eventuele post-merge CI wordt gecontroleerd. Rood = een afzonderlijke herstel-PR, niet direct in `main` repareren.

## 5. Productiepoort — afzonderlijk

Een merge is nooit toestemming voor deployment of SQL. Voor iedere productiestap is nodig: de exacte omgeving en ref zichtbaar bevestigd, read-only PRE, expliciete eigenaar-GO op het volledige uitvoerplan, afgebakende uitvoering, POST met STOP-criteria en herstelplan. Gebruik uitsluitend de Lovable Cloud SQL-editor. **Geen automatische SQL-aanroepen vanuit agents of GitHub Actions.**

Voor de reeds gemergede bankcorrecties #243/#244/#245 bestaat een afzonderlijk gecombineerd, atomair uitrolplan. Het blijft `ROLLOUT_PENDING` tot een apart productie-GO en de in het plan vereiste controles; pas dat niet stilzwijgend toe als losse migraties.

## 6. Bewijs, uitzonderingen en rapportage

Een taakrapport bevat alleen:

- **Gedaan:** issue/PR, actuele SHA, gewijzigde bestanden en migraties (`None` indien geen).
- **Bewijs:** `npx tsc --noEmit`, `npx tsc -p tsconfig.app.json --noEmit`, `npm run lint`, `npm run test` en build indien van toepassing; of de betreffende GitHub CI-run. Maak duidelijk wat **niet** is uitgevoerd.
- **Risico/STOP:** actuele onopgeloste bevindingen, skips, productie-afhankelijkheden, uitzonderingen met verwijzing naar eigenaarsbesluit.
- **Volgende actie:** één concreet voorstel; vraag de eigenaar uitsluitend om een noodzakelijke beslissing.

Gebruik controlelinks en commit-SHA's als bewijs. Claim nooit dat een review, merge, SQL-apply of deploy is uitgevoerd zonder een bijbehorende controle. Vermijd herhaalde statusberichten: meld pas een verandering, bevinding of eigenaarsbeslissing.

## 7. Startprompt voor uitvoerder

```text
Read AGENTS.md and PROJECT_MAP.md first.
Read BOOKASSIST_AI_BUILD_STRATEGY.md and the applicable parts of docs/CLAUDE_WORKFLOW.md.

Repository: Spiderman010/speedy-admin-automate-80194267
Start from the latest main. Work in one dedicated feature/fix branch and open a PR.
Task: <GitHub Issue or agreed one-sentence outcome>
Scope: <specific files and explicit exclusions>
Acceptance: <observable behavior, tests, and risk boundaries>

Do not commit to main, merge, deploy, run production SQL, edit generated
src/integrations/supabase/types.ts, or modify unrelated files.
If you find an accounting/schema/security decision, STOP and report it before changing scope.
Run typecheck (including tsconfig.app.json), lint, tests and build where applicable.
Report reviewed files, changed files, migrations, test results, PR URL, head SHA,
outstanding findings and the single next action.
```

## 8. Grenzen van v1 en v2-kandidaten

**Nu beschikbaar na merge:** documentair regieprotocol en een GitHub Issue-intaketemplate. De bestaande GitHub Actions-workflow levert CI-bewijs.

**Niet aanwezig in v1:** continu draaiende regieagent, automatische Codex-/Claude-/Lovable-uitvoering, ingebouwde statusmonitor, autonome goedkeuringen of productiekoppeling. Als dit later nodig is: maak een aparte ontwerp-PR voor read-only PR-/issue-monitoring met duidelijke toestemming, frequentie, foutafhandeling en stopknop.
