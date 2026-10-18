# BoekAssist Regieagent v2 — read-only GitHub-overzicht

**Status:** concept-PR. v2 levert een **handmatig te starten GitHub Actions-rapport**, geen autonome agent of doorlopende monitoring. Het protocol uit `docs/REGIEAGENT_V1.md`, `AGENTS.md` en `PROJECT_MAP.md` blijft volledig van toepassing.

## Uitvoering na merge

1. Open in de BoekAssist-repository **Actions**.
2. Kies **BoekAssist Regieagent v2 — read-only snapshot**.
3. Klik **Run workflow** op `main`.
4. Open de afgeronde run en lees de **Job summary** (of de logs als de API een fout geeft).

Na de merge moet de nieuwe workflow eerst op de standaardbranch aanwezig zijn voordat deze via `workflow_dispatch` gestart kan worden. Deze concept-PR creëert **geen planning**; de gebruiker start een momentopname zelf.

## Wat het rapport wel en niet doet

- Leest maximaal de 20 recent bijgewerkte open PR's en 20 open Issues. Een GitHub-respons met 100 records of meer dan de zichtbare limiet wordt als **onvolledig** gemarkeerd; dit is geen volledige backlog-export.
- Haalt voor iedere getoonde PR de GitHub check-runs en commit-status op, matcht de kwaliteitscheck op de **exacte PR-head-SHA** en toont die 40-cijferige SHA in het rapport om verouderde snapshots herkenbaar te maken.
- Geeft `STOP` bij rode CI of een verkeerde basisbranch; `WAIT_CI` bij ontbrekende/lopende CI; `DRAFT` bij een concept-PR; anders **`REVIEW_REQUIRED`**, nooit automatisch `GO`.
- Markeert Vercel-commitstatus `failure` **én** `error` als **afwijking** die alleen de eigenaar per PR kan accepteren.
- Vraagt maximaal 100 commitstatussen op en vergelijkt GitHubs `total_count` met het aantal ontvangen statussen. Bij een ongeldig `statuses`-veld of een ontbrekende/niet exact overeenkomende `total_count` volgt expliciet **`STOP / ONVOLLEDIG`**; een niet-gevonden Vercel-status wordt dan nooit als gezond verklaard. Geen automatische goedkeuring bij paginering. Een eerder geaccepteerde uitzondering wordt niet hergebruikt.
- Controleert **niet**: reviewthreads, afzonderlijke Codex-bevindingen, mergeability, CI-skips, financiële invarianten, eigenaars-GO of productiestatus. Die controles blijven verplicht vóór een merge.
- Weigert bij API- of authenticatiefouten een stilzwijgend groen resultaat. Rapportages tonen beknopte status en geen GitHub-token.

## Veiligheids- en kostenkader

- GitHub Actions `workflow_dispatch` alleen: **geen `schedule`, `pull_request_target`, automatische merges, GitHub-write-acties of production-hooks**.
- `GITHUB_TOKEN` gebruikt slechts `contents:read`, `pull-requests:read`, `issues:read`, `checks:read` en `statuses:read`; alle API-aanroepen zijn `GET` naar de vaste repository `Spiderman010/speedy-admin-automate-80194267`.
- Er is **geen** toegang tot Lovable Cloud, Supabase, Vercel-deployments of hun sleutels. GitHub Actions job summary is alleen zichtbaar voor personen met toegang tot de repository/workflow. Voeg geen klant- of financiële persoonsgegevens toe aan Issue-titels.
- Hoogste impact is een rapportagefout; geen data- of broncodemutaties. Stoppen kan door de handmatige run te annuleren. Niet starten is gelijk aan uitgeschakeld.
- De read-only werkstroom consumeert een kleine hoeveelheid GitHub Actions-minuten bij handmatige uitvoering; geen periodieke kostenbron zolang er geen `schedule` is.

## Afhandeling en vervolg

Het rapport is een **intakelijst**, geen definitieve review. De ontwikkelregisseur verifieert voor een afzonderlijke merge altijd `main`, head-SHA, full CI, threads, onafhankelijke review en acceptatie van uitzonderingen zoals `docs/REGIEAGENT_V1.md` voorschrijft.

Een eventuele volgende fase kan opt-in periodieke notificaties toevoegen, maar **alleen met nieuwe toestemming** voor cadence, doel, gegevensbestemming, foutbeleid en stopknop. Eerst moet de handmatige rapportage aantoonbaar correct zijn.

## Oplevering

- Gereviewd: `AGENTS.md`, `PROJECT_MAP.md`, `docs/REGIEAGENT_V1.md`, `docs/CLAUDE_WORKFLOW.md`, `.github/workflows/quality-ci.yml`, `vitest.config.ts`.
- Gewijzigd: `scripts/regieagent-report.mjs`, `src/test/regieagent-report.test.ts`, `.github/workflows/regieagent-readonly.yml`, `docs/REGIEAGENT_V2.md`.
- Migraties: **None**.
- Validatie: via de PR-CI (`npx tsc --noEmit`, `npx tsc -p tsconfig.app.json --noEmit`, `npm run lint`, `npm run test`, `npm run build`). De dispatch-workflow zelf kan pas na merge op `main` live worden getest; geen live rapportageclaim vóór dat bewijs.
