# Uitvoerplan productie — PR 1 + PR 2 + 20261018180000 in één opdracht

> **Status: niet uitvoeren zonder afzonderlijk GO van de eigenaar.** Dit plan
> beschrijft de uitrol; het is zelf geen toestemming.

Project: **`alxlbdhpbwlehbdbfejw`**, uitsluitend via de **Lovable Cloud SQL
editor** (Lovable → Cloud-icoon, of Cmd/Ctrl+K → "Cloud"), na de
projectcontrole uit `PROJECT_MAP.md` (Request-URL-host en `sb-project-ref` in
het netwerktabblad, de projectref in de editor). Nooit het persoonlijke
Supabase-dashboard, nooit de Vercel Marketplace-database, nooit
`olumcwneiejjefhkzgmz` of `ycuofllsdssoezwwpqmv`, nooit een "Combined Fresh
Install Schema". Bij twijfel over het project: STOP.

## 1. Waarom één opdracht, en waarom "los na elkaar" STOP is

Productie heeft één banktransactie (25-11-2025, € 3.993) die vóór PR 1 is
geboekt, dezelfde dag handmatig is gestorneerd, haar marker kwijtraakte en
opnieuw is geboekt. De hold van PR 1 (D12) geldt na een vrijgave alleen als
élke directe bankgroep van de regel als vervangen in een gebeurtenis staat;
die historische groep staat dat nooit. Met alleen PR 1 (of PR 1 + PR 2) kan de
app zo'n regel na een vrijgave dus stil opnieuw coderen en boeken, buiten
"Opnieuw boeken" om. Dat is aangetoond in
`supabase/tests/bank-release-hold-history/` (negatieve controle N1–N7, en Z6
in de productiegelijke database). 20261018180000 sluit dat gat.

**Los na elkaar uitvoeren (PR 1 → POST → PR 2 → POST → fix → POST) kan niet
aantoonbaar veilig.** Tussen PR 1 en de fix staat de tussentoestand gecommit
in productie: elke vrijgave van die regel in dat venster, gevolgd door een
app-boeking, is een stille herboeking. Dat venster dichthouden vergt dat
niemand — geen gebruiker, geen import, geen achtergrondproces — een vrijgave
of boeking doet, en dat valt vanuit de database niet te bewijzen. **Daarom:
STOP voor de losse volgorde.** PRE 4 van PR 1 zegt dat ook zelf:
`stop_losse_uitrol = true`.

**Alternatief (dit plan):** `uitvoering.sql` in deze map. Dat is **één
DO-opdracht** die de drie migraties letterlijk uitvoert (`EXECUTE` van de
ongewijzigde bestanden), met bewaking vooraf en achteraf, gevolgd door één
SELECT die de eindtoestand leest. Eén opdracht is altijd één transactie — hoe
de editor de plak ook verstuurt (in één keer of opdracht voor opdracht) — dus
de tussentoestand wordt nooit gecommit en is voor niemand zichtbaar. Een
afgekapte plak is een syntaxfout en doet niets. De laatste rij zegt alleen
`gecombineerde uitrol voltooid` als alle drie er exact staan, anders
`NIET VOLTOOID — STOP`. Bewezen in het harnas (database `…_plan` en
`…_zicht`):

| bewijs | wat |
|---|---|
| A20 | opdracht voor opdracht, doorgaan na een fout, `lock_timeout` al 5 s op de sessie, eindcontrole gesaboteerd: niets toegepast, laatste rij `NIET VOLTOOID — STOP` |
| A21 | een andere sessie houdt een grendel op `bank_transactions`: na 5 s `lock timeout`, niets toegepast |
| A22 | een fout ná alle drie migraties (in de eindcontrole): alles teruggedraaid, ook PR 1 en PR 2 |
| A24 | een afgekapte plak (halverwege PR 2): syntaxfout, niets toegepast |
| A25 | op een kopie opdracht voor opdracht: voltooid — de drie migraties zijn één opdracht |
| A30–A47 | in één keer: voltooid; elke POST-controle letterlijk in orde; de regel van 25-11-2025 is na vrijgeven dicht voor de app en "Opnieuw boeken" werkt |
| Y1–Y4 | midden in de ene opdracht (PR 1 en PR 2 toegepast, de fix nog niet) ziet een andere sessie niets; een verzoek dat het oude gedrag zou benutten wacht en draait daarna onder de eindregels; na afloop is alles tegelijk zichtbaar |

De volgorde binnen de opdracht is vast: **PR 1 → PR 2 → fix**. PR 2 pint de
hold van PR 1 (en weigert dus na de fix); de fix eist PR 2.

## 2. De vier toestanden in de uitrolcontroles

| toestand | PRE 4 / PRE 4b (PR 1) | POST 8 (PR 1) | betekenis |
|---|---|---|---|
| (a) aantoonbaar veilige historische storno | `waarvan_historische_storno` > 0, `waarvan_onverklaard` = 0, `stop` = false, `stop_losse_uitrol` = true; PRE 4b: elk bewijsstuk `true`, toestand "bewezen historische storno — alleen via de gecombineerde uitrol" | — | alleen deze uitrol (één opdracht); PRE B6 moet bevestigen dat het precies de beoordeelde storno is |
| (b) werkelijk ontbrekende of inconsistente marker | `waarvan_onverklaard` > 0 → `stop` = true; PRE 4b noemt de onware bewijsstukken ("STOP — niet gestorneerd", "STOP — geen actuele marker", "STOP — de banktransactie bestaat niet meer", "STOP — onverklaard") | `toestand` = 'STOP' | **STOP** — niets uitvoeren |
| (c) tijdelijke toestand vóór de fix | — | `toestand` = 'TIJDELIJK — …' (hold van PR 1, wel een historische storno) | mag in productie nooit zichtbaar worden; bij deze uitrol onmogelijk. Ziet u dit: **STOP, melden** |
| (d) definitieve toestand na alle drie | — | `toestand` = 'IN ORDE', `hold_versie` = '20261018180000' | klaar |

Alleen een eerdere datum, of alleen het ontbreken van een marker, is nooit
genoeg: een groep is pas bewezen historisch als alle bewijsstukken waar zijn
(dezelfde, nog bestaande transactie, precies één storno via de reversalketen
die elke regel omkeert, origineel, storno en claim op de transactiedatum, per
grootboekrekening neutraal, de storno niet zelf tegengeboekt, geen marker en in
geen gebeurtenis genoemd, daarna een nieuwe boeking, en alles strikt ouder dan
elke gebeurtenis). Elke andere groep is STOP. Bij de uitrol zelf zijn er nog
geen gebeurtenissen (PRE B1: de tabel bestaat niet), dus elke bestaande groep
is per definitie van vóór de correctiegebeurtenissen.

**Twee niveaus, bewust.** De hold zelf (de hulpfunctie) toetst "ouder dan elke
gebeurtenis" op de tijd (`created_at`). Een vergissing daar kan de hold alleen
strenger maken — nooit zwakker — en de tijd blijft kloppen na een logische
restore. POST 8 toetst strenger: ook op de volgorde van de transacties
(`created_xact_id`). Wat daar niet in beide volgordes ouder is, geeft STOP.
Gevolgen:

- Na een logische restore (een nieuwe xid-reeks) kan POST 8 STOP geven op de
  bekende groep, terwijl de hold de regel blijft dekken (harnas X8–X10). Dat
  is geen reden om iets te herstellen: melden.
- Gedocumenteerd restgeval: een groep die alleen in een functionele
  rollback-tussentijd kan ontstaan, door transacties die hun xid al vóór een
  gebeurtenis hadden en tijdens de rollback open bleven. Zo'n groep geldt ook
  in POST 8 als geschiedenis. Gevolg: de hold geldt vaker, nooit minder vaak
  (harnas X2, X6, X7). De rollback houdt BoekAssist dicht (§8).

## 3. Onderhoudsprotocol

1. **Afspraak.** De eigenaar kiest een rustig moment en meldt aan alle
   gebruikers (accountants en assistenten van Agio Finance) dat BoekAssist
   gedurende de uitrol niet gebruikt wordt: niet inloggen, geen bankimport,
   geen uploads (die starten `process-invoice` / `process-sales-invoice`),
   geen boekingen, geen vrijgaven.
2. **Vlak vóór de uitvoering: PRE B7** (geen actieve applicatieverzoeken via
   de API-rollen). Toont B7 rijen: wachten en B7 opnieuw uitvoeren; blijft het
   druk: STOP en een ander moment kiezen. B7 ziet alleen verzoeken via
   PostgREST; de atomiciteit hangt er niet van af.
3. **Tijdens de uitvoering** is de tussentoestand onzichtbaar (één opdracht,
   één transactie). Een verzoek dat toch binnenkomt, wacht op de grendel
   (hooguit enkele seconden) of laat de uitvoering na 5 s mislukken op
   `lock_timeout` — dan is er **niets** veranderd en begint u opnieuw bij
   stap 2.
4. **Na de uitvoering** eerst alle POST's (§7); pas als die in orde zijn, mag
   BoekAssist weer gebruikt worden.

## 4. Voorbereiding (geen SQL)

- GO van de eigenaar voor productie, met het commit-id van `main` waarop dit
  plan is gemerged.
- Open op GitHub, op dát commit, `supabase/rollout/20261018180000_refine_release_hold_for_settled_history/uitvoering.sql`
  (Raw). De kop noemt de sha256 van de drie migraties; de contracttest
  (`src/test/bank-release-hold-history-migration.test.ts`, test 13) bewaakt
  dat de tekst tussen elk paar dollar-aanhalingstekens byte-gelijk dat bestand
  is. Het bestand eindigt met de regel
  `(SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.bank_transaction_posting_events')) AS gebeurtenistabel;`
  — controleer na het plakken dat die laatste regel in de editor staat.
- Open de Lovable Cloud SQL editor en bevestig het project `alxlbdhpbwlehbdbfejw`.

## 5. PRE — alleen lezen, elk blok een eigen uitvoering

De editor toont van een meervoudige uitvoering alleen het laatste resultaat:
voer daarom elk blok apart uit en noteer de uitkomst.

**5a. `supabase/rollout/20261018120000_add_bank_transaction_corrections/preflight.sql` (PR 1)**

| blok | verwacht | anders |
|---|---|---|
| PRE 1 | één rij, elke kolom `true` | STOP |
| PRE 2 | 11 rijen, `gelijk` overal `true` | STOP |
| PRE 3, 5, 9, 10 | informatief (noteren) | — |
| PRE 4 | `afwijkende_vorm` = 0, `bankgroepen_zonder_marker` = 1, `waarvan_historische_storno` = 1, `waarvan_onverklaard` = 0, `stop` = false, `stop_losse_uitrol` = true | STOP |
| PRE 4b | precies één rij: groep `fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a`, storno `ff598a0f-e4e3-4b82-968a-9666b54c5ad8`, actuele groep `0b1aec4c-1bd1-42f3-b392-6a6125da98e3`, elk bewijsstuk `true`, `bewezen` = true | STOP |
| PRE 6, PRE 7 | **bewaren** (POST 6 en POST 7 vergelijken ermee) | — |
| PRE 8 | elke booleaanse kolom `true` (noteer `serverversie`) | STOP |
| PRE 11 | `onbekend` = 0, `stop` = false | STOP |

**5b. `supabase/rollout/20261018180000_refine_release_hold_for_settled_history/preflight.sql` (PRE B)**

| blok | verwacht | anders |
|---|---|---|
| PRE B1 | één rij, elke kolom `true` (niets van PR 1, PR 2 of de fix; PR 0 toegepast) | STOP |
| PRE B2 | `gelijk` = true (de schrijver exact beoordeeld) | STOP |
| PRE B3 | 4 rijen, `bekend` overal true, `stop` overal false | STOP |
| PRE B4 | `stop` = false (geen RULE, geen publicatie) | STOP |
| PRE B5 | `gelijk` = true (de editorrol is eigenaar van de schrijver) | STOP |
| PRE B6 | `bewezen` = 1, `onverklaard` = 0, `bekende_storno_bewezen` = true, `andere_bewezen` = 0, `stop` = false | STOP |
| PRE B7 | 0 rijen | wachten, opnieuw; blijft het: STOP |
| PRE B8 | **bewaren** (POST 4 van PR 2 en POST C6 vergelijken ermee) | — |
| PRE B9 | één rij, `heel` = true (de editor knipt geneste dollar-aanhalingstekens niet, zoals in `uitvoering.sql`) | STOP |

De PRE van PR 2 (`20261018150000_…/preflight.sql`) wordt **niet** uitgevoerd:
die verwacht PR 1 al in productie. Haar voorwaarden zijn gedekt door PRE B2–B5
en worden binnen de opdracht opnieuw afgedwongen door de voorwaardencontrole
van PR 2 zelf.

## 6. De uitvoering — één keer

1. PRE B7 opnieuw: 0 rijen.
2. Plak **het hele bestand** `uitvoering.sql`, ongewijzigd, in één editorvenster
   en controleer dat de laatste regel van §4 er staat. Voer het **één keer** uit.
3. Verwachte (laatste) uitkomst: één rij met `uitkomst` =
   `gecombineerde uitrol voltooid`, `hulpfunctie` = 1, `gebeurtenistabel` = 1.

| uitkomst | betekenis | wat nu |
|---|---|---|
| `gecombineerde uitrol voltooid` | alle drie toegepast in één transactie | door naar §7 |
| `… lock timeout …` | iemand hield een grendel vast; **niets** veranderd | PRE B1 (alles `true`) ter bevestiging; terug naar §3 stap 2 |
| `Uitrol geweigerd: PR 1, PR 2 of 20261018180000 is al (deels) aanwezig …` | er is al iets van de uitrol | **STOP**, niets herstellen, melden |
| `Voorwaarde: …` (uit een van de migraties) | de productie wijkt af van de beoordeelde toestand; **niets** veranderd | **STOP**, melden |
| `Uitrol geweigerd: na de drie migraties is de eindtoestand niet de beoordeelde …` | **niets** veranderd | **STOP**, melden |
| `NIET VOLTOOID — STOP` (met of zonder foutmelding ervoor) | de DO-opdracht is niet geslaagd; niets veranderd | PRE B1 ter bevestiging; **STOP**, melden |
| een syntaxfout (bv. `unterminated dollar-quoted string`) | de plak is onvolledig; niets veranderd | **STOP**; opnieuw plakken vanaf §4 |
| elke andere foutmelding, of geen `uitkomst`-rij | de opdracht is niet (volledig) uitgevoerd | PRE B1 ter bevestiging; **STOP**, melden |

Nooit de drie migratiebestanden los uitvoeren, nooit `uitvoering.sql` in
stukken, nooit opnieuw na een geslaagde uitvoering (de bewaking weigert dan).

## 7. POST — alleen lezen, elk blok een eigen uitvoering

**7a. `supabase/rollout/20261018120000_add_bank_transaction_corrections/postcheck.sql` (PR 1)**

| blok | verwacht | anders |
|---|---|---|
| POST 1 | 10 rijen, elke booleaanse kolom `true`; `lichaam_versie` 8× 'PR 1', `reclassify_bank_transaction` 'PR 2', `enforce_bank_transaction_release_hold` '20261018180000' | STOP |
| POST 2 | 9 rijen, `definitie_exact` en `inschakeling_exact` overal `true` | STOP |
| POST 3 | één rij, elke booleaanse kolom `true` (gebeurtenistabel leeg) | STOP |
| POST 4 | 11 rijen, `gelijk` overal `true` | STOP |
| POST 5 | één rij, elke kolom `false` | STOP |
| POST 6 | letterlijk gelijk aan PRE 6 | STOP |
| POST 7 | t.o.v. PRE 7: `publieke_functies` + 11, `triggers_public` + 9, `tabellen` + 1, `sequences` + 1, `policies` + 1; alle andere kolommen letterlijk gelijk | STOP |
| POST 8 | `toestand` = 'IN ORDE', `waarvan_historische_storno` = 1, `waarvan_onverklaard` = 0, `gebeurtenissen` = 0, `hold_versie` = '20261018180000' | 'TIJDELIJK …' of 'STOP': **STOP**, melden |

**7b. `supabase/rollout/20261018150000_keep_bank_description_on_correction/postcheck.sql` (PR 2)**

| blok | verwacht | anders |
|---|---|---|
| POST 1 | één rij, elke kolom `true` | STOP |
| POST 2 | 10 rijen, `gelijk` overal `true`; `versie` 'beoordeeld', voor de hold '20261018180000' | STOP |
| POST 3 | 5 rijen, `bekend` overal `true`; voor de hold-trigger `versie` '20261018180000' | STOP |
| POST 4 | t.o.v. **PRE B8**: data gelijk, `gebeurtenissen` = 0, `functies_public` + 11, `triggers` + 9 | STOP |

**7c. `supabase/rollout/20261018180000_refine_release_hold_for_settled_history/postcheck.sql` (POST C)**

| blok | verwacht | anders |
|---|---|---|
| POST C1, C2, C3 | één rij, elke kolom `true` | STOP |
| POST C4 | één rij: groep `fb1d2550-…`, `bewezen_historisch` = true, `vervangen` = false, `bekend` = true | STOP |
| POST C5 | één rij: `actuele_groep` `0b1aec4c-…`, `hold_dekt_na_vrijgave` = true | STOP |
| POST C6 | t.o.v. PRE B8: data gelijk, `functies_public` + 11, `triggers` + 9 | STOP |

Alles in orde: BoekAssist mag weer gebruikt worden. Er wordt in productie niets
getest door te schrijven (geen testdata); het gedrag is bewezen in het harnas.

## 8. Rollback (alleen met akkoord van de eigenaar; data-neutraal)

Altijd in deze volgorde, elk als eigen uitvoering, met BoekAssist dicht van de
eerste tot en met de laatste stap:

1. `supabase/rollout/20261018180000_refine_release_hold_for_settled_history/rollback.sql`
   — één opdracht: bewaking, de hold terug naar PR 1, en daarna pas de
   hulpfunctie weg; weigert één onderdeel, dan verandert er niets.
   **Gevolg:** de historische regel valt na een vrijgave weer buiten de hold —
   de tussentoestand (c).
2. `supabase/rollout/20261018150000_keep_bank_description_on_correction/rollback.sql`
   — de correctie-RPC terug naar PR 1. Weigert zolang stap 1 niet gedaan is.
   Dit bestand is een bewaking gevolgd door losse opdrachten: plak het in zijn
   geheel in één uitvoering (dan draait een weigering alles terug, zie PRE B9)
   en STOP bij elke foutmelding.
3. Het ROLLBACK-blok uit de kop van `20261018120000_add_bank_transaction_corrections.sql`.

Gebeurtenissen en grootboekregels blijven bij elke rollback staan. Na een
volledige rollback is er geen vooraf beoordeelde weg terug: `uitvoering.sql`
weigert (de gebeurtenistabel blijft bestaan) en de losse volgorde is STOP.
Opnieuw toepassen vraagt dan een eigen plan en een eigen GO. (PR 2 opnieuw
toepassen terwijl de fix er staat, weigert ook — bewezen in het harnas.)

## 9. STOP-criteria in één lijst

- Project niet visueel bevestigd als `alxlbdhpbwlehbdbfejw`, of een geblokkeerde ref in beeld.
- PRE 1, 2, 8 (PR 1) of PRE B1, B2, B5 ergens `false`.
- PRE 4, PRE 11, PRE B3, PRE B4 of PRE B6 `stop = true`; PRE 4 anders dan precies één bewezen historische storno met `stop_losse_uitrol = true`; PRE 4b anders dan precies de bekende groep met alle bewijsstukken `true`.
- PRE B7 blijft rijen tonen.
- PRE B9 geeft iets anders dan één rij met `heel` = true.
- Elke foutmelding bij een PRE- of POST-blok.
- `uitvoering.sql` geeft iets anders dan `gecombineerde uitrol voltooid` (behalve `lock timeout`: dan is er niets veranderd, opnieuw vanaf §3 stap 2), of de laatste regel van §4 staat niet in de editor.
- Elke POST-afwijking uit §7, in het bijzonder POST 8 'TIJDELIJK …' of 'STOP'.
- Twijfel over wat een uitkomst betekent.

Bij STOP: niets herstellen, niets opnieuw proberen buiten dit plan, de
uitkomst letterlijk doorgeven.
