# Jaarafsluiting en boekingsblokkade — architectuur en migratiepad

**Status:** ontwerp. Geen migratie, geen gedragswijziging, niets toegepast op productie.
**Aanleiding:** rookproef op productie. De huidige implementatie maakt van "afgesloten" een
permanent technisch schrijfverbod, en dat is niet het productmodel dat Agio Finance nodig heeft.

De regel waar dit ontwerp naartoe werkt:

> Een boekjaar afsluiten betekent dat het **administratief is afgerond**. Het betekent NIET dat
> BoekAssist voor altijd weigert om nog in dat jaar te boeken.
>
> Als later een correctie nodig is: heropen het boekjaar, hef indien nodig de aparte
> boekingsblokkade op, boek de correctie, controleer opnieuw, sluit opnieuw af, en zet de
> boekingsblokkade desgewenst weer aan.

---

## A. Huidig gedrag, in kaart

Vandaag bestaat er precies één begrip, en dat begrip doet twee dingen tegelijk.

`clients.afgesloten_boekjaar` (integer, nullable, toegevoegd in
`20260512233324_956b7974-27ad-437a-91c0-b1adacfbb2fb.sql:6`) is tegelijk:

1. **de administratieve status** — "dit jaar is afgerond", en
2. **het technische schrijfverbod** — elke schrijver weigert `boekjaar <= afgesloten_boekjaar`.

Sinds `20260924120000_add_year_close_writer.sql` komt daar een derde eigenschap bij: de kolom kan
**alleen nog omhoog**, en alleen naar een jaar waarvoor een `year_closures`-rij bestaat. Daarmee is
het schrijfverbod niet alleen gekoppeld aan de status maar ook **onomkeerbaar gemaakt**.

De gebruikersstroom is vandaag dus eenrichtingsverkeer: sluiten kan, heropenen bestaat niet, en de
enige uitweg uit een fout is een correctie in een later boekjaar.

---

## B. Databaseobjecten en schrijfgrenzen — exact

### B1. Wat `20260924120000_add_year_close_writer.sql` heeft toegevoegd

| Regel | Object | Wat het doet |
|---|---|---|
| 114 | `public.year_closures` | tabel; PK `(client_id, fiscal_year)`; kolommen `client_id`, `fiscal_year`, `organization_id`, `closed_at`, `closed_by`; FK's `RESTRICT` naar `clients`, `organizations`, `auth.users` |
| 176, 179 | `idx_year_closures_organization`, `idx_year_closures_closed_by` | indexen |
| 204, 222 | `enforce_year_closure_org()` + `enforce_year_closure_org_trigger` | `BEFORE INSERT`; tenantintegriteit via `posting_client_org_ok()` |
| 241, 257, 262 | `prevent_year_closure_mutation()` + twee triggers | `BEFORE UPDATE OR DELETE` en `BEFORE TRUNCATE`; beide `ENABLE ALWAYS` (266-267) |
| 282-290 | RLS + rechten | `role_year_closures_select` (`has_min_role(…, 'read_only')`); `REVOKE ALL` van `anon, authenticated, service_role`, daarna alleen `GRANT SELECT` |
| 329, 364 | `enforce_year_close_watermark()` + `enforce_year_close_watermark_trigger` | `BEFORE UPDATE OF afgesloten_boekjaar ON public.clients`, `ENABLE ALWAYS` (368). Weigert élke verlaging en élke verhoging zonder bijbehorende `year_closures`-rij |
| 404, 747-748 | `close_fiscal_year(uuid, integer)` | `SECURITY DEFINER`, `SET search_path = public`, rolvloer accountant; `EXECUTE` alleen voor `authenticated` |

### B2. De acht schrijvers die vandaag op het watermerk stuiten

Alle acht dragen een **byte-identieke** toets. Dat is de belangrijkste vondst van deze audit: er is
geen variatie om rekening mee te houden, maar er is ook geen gedeelde helper — de regel staat acht
keer letterlijk in de code.

```sql
IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
  RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
    USING ERRCODE = '22023';
END IF;
```

| Schrijver | Migratie : regel | Boekhoudkundige datum vlak vóór de toets |
|---|---|---|
| `post_purchase_invoice()` | `20260915140000` : 283 | `v_inv.invoice_date` (277: NULL wordt geweigerd) |
| `post_sales_invoice()` | `20260915160000` : 328 | `invoice_date` |
| `post_bank_allocation()` | `20260917120000` : 604 | `bank_transactions.transaction_date` |
| `post_manual_journal()` | `20260918120000` : 1168 | `v_journal.posting_date` |
| `post_opening_balance()` | `20260919120000` : 1544 | `v_header.opening_date` → `v_header.boekjaar` |
| `declare_opening_balance_nil()` | `20260919120000` : 1854 | idem |
| `reverse_posting_group()` | `20260921120000` : 803 | het argument `_posting_date` |
| `post_bank_transaction()` | `20260921140000` : 221 | `v_tx.transaction_date` |

**Zeven van de acht hebben op dat punt de échte datum in een lokale variabele**, niet alleen het
afgeleide jaartal. Dat is beslissend voor sectie E: een blokkade op datumniveau is technisch
haalbaar zonder die zeven schrijvers te herstructureren.

**De achtste is een echte uitzondering, en een leerzame.** `declare_opening_balance_nil()` toetst
op `v_header.boekjaar` en gebruikt nergens een datum. Dat is geen slordigheid: deze functie
**schrijft geen enkele grootboekregel**. Zij legt vast dat een administratie bewust géén
beginbalans heeft — een uitspraak over een boekjaar, geen boeking op een datum. De kop wordt wel
volledig geladen (`SELECT * INTO v_header FROM public.opening_balances`), dus `opening_date` is
bereikbaar, maar hem hier gebruiken zou een datumregel opleggen aan iets wat geen datum heeft.

Gevolg voor het ontwerp: een *boekings*blokkade hoort deze ene schrijver **niet** te beheersen. De
juiste beheersmaatregel is daar de boekjaarstatus uit D2. Zie E2.

Daarnaast, read-only en dus géén schrijfgrens maar wel dezelfde regel:
`bank_bulk_posting_candidates()` (`20260922120000` : 204-205 en 223-224) bepaalt de
postbaarheidsvlag met `EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar`.
`post_bank_transactions_bulk()` (`20260922120000` : 257) boekt zelf niet maar roept per transactie
`post_bank_transaction()` aan en erft de toets daarmee.

### B3. Wat het watermerk vandaag nog meer tegenhoudt

- **Heropenen is structureel onmogelijk.** `enforce_year_close_watermark()` weigert elke verlaging
  én `NULL`, met `ERRCODE 42501`.
- **Het bewijs kan niet weg.** `prevent_year_closure_mutation()` weigert `UPDATE`, `DELETE` en
  `TRUNCATE`, en staat op `ENABLE ALWAYS`.
- **De tegenboekingsmotor weigert elke correctiedatum in een afgesloten jaar**
  (`20260921120000` : 803). Dat is vandaag de enige correctieweg, en hij is voor het afgesloten
  jaar dus dicht.

### B4. Applicatiekant

| Bestand | Rol |
|---|---|
| `src/hooks/useYearClose.ts` | `useYearClosure` (leest `year_closures`), `useCanCloseFiscalYear`, `useCloseFiscalYear` |
| `src/hooks/useYearCloseSources.ts` | leest het watermerk uit `useClients` als `closedThrough` |
| `src/lib/year-close-readiness.ts` | `yearAlreadyClosed()`, `yearOrder()`, `unpostedWorkThroughYear()` — alle drie redeneren over het watermerk |
| `src/lib/year-close-action.ts` | `closeAvailability()`; kent `already_closed` en `inconsistent`, kent géén `reopen` |
| `src/pages/Jaarafsluiting.tsx` | de afsluitstroom; toont na afsluiten uitsluitend het bewijs |
| `src/pages/Klanten.tsx` | toont `afgesloten_boekjaar` alleen-lezen sinds PR 2a |
| `src/lib/ledger-catchup.ts` | `jaarAfgesloten()` → blokcode `boekjaar_afgesloten` (`:238`, `:351`) |
| `src/hooks/useAccountingDiagnostics.ts`, `src/hooks/useLedgerCatchup.ts` | lezen `afgesloten_boekjaar` mee in de klantconfiguratie |
| `src/pages/PurchaseInvoiceWorkspace.tsx` | `:425`, geeft het watermerk door aan de inhaalslaglogica |

### B5. Tests die "afgesloten = voorgoed niet meer boeken" vastleggen

Deze moeten bij de uitrol bewust worden bijgesteld — geen van alle is fout vandaag.

- `src/lib/accounting-diagnostics.ts:71-73` — `ALTIJD_ERROR = { "boekjaar_afgesloten" }`, met het
  commentaar *"Boeken in een afgesloten jaar mag niet en wordt nooit toegestaan."* Vastgepind door
  `src/test/accounting-diagnostics.test.ts:131` en `:405`.
- `src/test/purchase-ledger-posting.test.ts:94`, `sales-ledger-posting.test.ts:99`,
  `bank-ledger-posting.test.ts:201-202`, `manual-journal-posting.test.ts:407-408`,
  `opening-balance-posting.test.ts:292-293`, `ledger-reversal-engine.test.ts:166` — elk pint de
  letterlijke guardtekst van zijn eigen schrijver.
- `src/test/year-close-writer.test.ts:284` — pint dat het watermerk niet omlaag kan.
- `src/test/ledger-catchup.test.ts:222-223`, `:282` en `bank-bulk-catchup-ui.test.tsx:324` — pinnen
  de blokcode en de foutmelding.

---

## C. Waarom afsluiting en boekingsblokkade uit elkaar moeten

Drie redenen, alle drie uit de code hierboven en niet uit voorkeur.

1. **Ze hebben een andere levensduur.** Een afsluiting is een gebeurtenis met een datum en een
   actor; een blokkade is een instelling die aan en uit gaat. Ze in één integer proppen betekent dat
   de instelling niet kan bewegen zonder de geschiedenis te herschrijven — precies wat
   `enforce_year_close_watermark()` nu verbiedt, en terecht.

2. **Ze hebben een andere korrel.** De afsluiting gaat over een **boekjaar**. Een blokkade gaat in
   de praktijk over een **datum**: "dicht tot en met 31-12-2024" is wat een kantoor wil, en dat is
   niet hetzelfde als "boekjaar 2024 is administratief klaar". Zolang beide één kolom delen, is de
   fijnere korrel onbereikbaar.

3. **Ze hebben een andere foutkost.** Ten onrechte niet afgesloten is een administratieve
   slordigheid. Ten onrechte niet kunnen boeken is een blokkade van het werk — en vandaag een
   *permanente*, want er is geen weg terug. Eén schakelaar voor twee risico's met verschillende
   kosten dwingt je om de strengste te kiezen, altijd.

De rookproef maakte dat concreet: `AA-Secure`, boekjaar 2023 werd afgesloten, en daarmee is elke
correctie in 2023 voorgoed geweigerd — ook een correctie die de accountant welbewust en terecht zou
willen maken.

---

## D. Doeldomeinmodel

Drie begrippen, streng gescheiden.

### D1. Afsluitgebeurtenis (onuitwisbaar)

Een **gebeurtenis**, nooit een toestand: `closed` of `reopened`, met administratie, organisatie,
boekjaar, tijdstip, actor en — bij heropenen — een verplichte reden. De geschiedenis wordt nooit
overschreven; 2025 `CLOSED` → `REOPENED` → `CLOSED` is drie rijen.

### D2. Boekjaarstatus (afgeleid, deterministisch)

`OPEN` of `CLOSED`, per administratie en boekjaar, bepaald door de **laatste** gebeurtenis. Nooit
afgeleid uit tekst, rekeningnummers, of schermtoestand — dezelfde regel die de rapportagelaag al
hanteert.

### D3. Boekingsblokkade (los instelbaar)

Beschermt tegen het per ongeluk boeken in een oude periode. Onafhankelijk van D2: een boekjaar mag
**administratief CLOSED** zijn terwijl het voor een geautoriseerde correctie **tijdelijk
ontgrendeld** is, en andersom mag een nog niet afgesloten jaar al geblokkeerd zijn omdat de
BTW-aangifte eruit is.

---

## E. Voorgesteld databasemodel

### E1. Afsluitgeschiedenis — aanbeveling: `year_closures` behouden als huidige stand, nieuwe gebeurtenistabel ernaast

Drie opties afgewogen tegen wat er werkelijk staat:

| | Behouden + gebeurtenislog (**aanbevolen**) | `year_closures` ombouwen tot log | Alles nieuw, oude tabel afvoeren |
|---|---|---|---|
| Bestaande PK `(client_id, fiscal_year)` | blijft de huidige stand — precies wat zij al betekent | moet weg; PK wordt `(client_id, fiscal_year, seq)` | n.v.t. |
| `prevent_year_closure_mutation` (`ENABLE ALWAYS`) | blijft gelden voor de gebeurtenissen; de standtabel heeft een eigen, engere regel | moet worden versoepeld om heropenen te kunnen loggen — een trigger die onuitwisbaarheid bewijst, weer openzetten | n.v.t. |
| Bestaande rijen op productie | blijven geldig en betekenen nog hetzelfde | moeten worden geherinterpreteerd | moeten worden gemigreerd |
| `useYearClosure()` en de UI | blijven werken zonder wijziging | breken | breken |
| Nieuwe idempotentie | PK van de standtabel blijft de garantie | complexer: laatste rij per jaar opzoeken onder grendel | idem |

**Aanbeveling: additief.** Precies één nieuwe tabel, en `year_closures` blijft wat zij is — de
huidige stand, met haar bestaande primary key als idempotentiegarantie.

```
public.fiscal_year_events            -- onuitwisbaar, append-only
  id               uuid   PK
  client_id        uuid   NOT NULL   FK clients      RESTRICT
  organization_id  uuid   NOT NULL   FK organizations RESTRICT   + posting_client_org_ok()-trigger
  fiscal_year      integer NOT NULL  CHECK 2000..2100
  event_type       text   NOT NULL   CHECK IN ('closed','reopened')
  reason           text   NULL       CHECK: NOT NULL en niet-leeg als event_type = 'reopened'
  occurred_at      timestamptz NOT NULL DEFAULT now()
  actor_id         uuid   NOT NULL   FK auth.users   RESTRICT
  INDEX (client_id, fiscal_year, occurred_at)
```

`year_closures` krijgt er één nullable kolom bij: `status text NOT NULL DEFAULT 'closed'
CHECK IN ('closed','reopened')`. Heropenen zet die op `reopened` — dus de tabel wordt van
onuitwisbaar naar *één* toegestane statusovergang. Dat betekent dat
`prevent_year_closure_mutation()` moet worden vervangen door een engere trigger die **alleen** de
kolom `status` laat wijzigen en alle andere kolommen én `DELETE` en `TRUNCATE` blijft weigeren. Die
versmalling is de enige echte concessie van deze optie, en zij is expliciet en klein te maken.

*Alternatief dat is overwogen en afgevallen:* `year_closures` volledig onuitwisbaar houden en de
huidige stand altijd uit `fiscal_year_events` afleiden. Dat is architectonisch zuiverder, maar het
maakt de idempotentiegarantie van de afsluitschrijver afhankelijk van een `ORDER BY … LIMIT 1` onder
de administratiegrendel in plaats van een primary key. Gezien hoe zwaar PR 2a op die PK leunt
(gelijktijdigheidsbewijs 33a-c), weegt dat niet op. Wél de moeite waard om bij PR A nog één keer
tegen elkaar te leggen.

### E2. Boekingsblokkade — aanbeveling: `locked_through_date` op de administratie

| | `clients.posting_locked_through` (date) (**aanbevolen**) | `locked_through_fiscal_year` (integer) | `posting_locks`-tabel |
|---|---|---|---|
| "dicht t/m 31-12-2024" | ✅ direct | ✅ | ✅ |
| "dicht t/m 30-06-2025" (na BTW-aangifte) | ✅ | ❌ jaargrens is te grof | ✅ |
| Past op de acht schrijvers | ✅ elke schrijver heeft de datum al bij de hand (zie B2) | ✅ | ✅ |
| Verwarring met `afgesloten_boekjaar` | klein: andere naam, ander type | **groot**: twee integers met bijna dezelfde naam | klein |
| Historie van blokkade-wijzigingen | apart te loggen | idem | ingebouwd |
| Complexiteit nu | één kolom | één kolom | tabel + RLS + grants + rechten |

**Aanbeveling: één kolom `clients.posting_locked_through date NULL`**, plus dezelfde
gebeurtenisaanpak voor de wijzigingen (`posting_lock_events`) zodra daar vraag naar is — niet in de
eerste PR. De datumkorrel is wat kantoren werkelijk gebruiken, het type verschilt zichtbaar van
`afgesloten_boekjaar`, en elke schrijver kan hem toetsen zonder herstructurering.

Eén gedeelde helper, in plaats van de acht kopieën van vandaag:

```sql
public.posting_allowed(_client_id uuid, _posting_date date) RETURNS boolean
-- STABLE, SECURITY DEFINER, SET search_path = public
-- false zodra posting_locked_through IS NOT NULL AND _posting_date <= posting_locked_through
```

**Zeven** schrijvers vervangen hun eigen `IF …` door een aanroep van deze helper. Omdat de guards
byte-identiek zijn, is dat zeven keer exact dezelfde, mechanische vervanging — en de bestaande
tests uit B5 bewijzen per schrijver dát het gebeurd is.

**`declare_opening_balance_nil()` doet niet mee.** Zij schrijft geen grootboekregel en heeft geen
boekingsdatum (zie B2). Haar toets hoort te verhuizen naar de **boekjaarstatus** uit D2: een
nihil-verklaring over een `CLOSED` jaar is een administratieve uitspraak die niet past, ongeacht
welke datum er geblokkeerd staat. Concreet krijgt zij in PR D/H
`fiscal_year_status(_client_id, _boekjaar) = 'open'` in plaats van `posting_allowed()`.

Die splitsing is het bewijs dat de scheiding uit sectie C geen woordenspel is: er ís werkelijk een
schrijver waarvoor de twee begrippen een ander antwoord geven.

### E3. Wat er met `afgesloten_boekjaar` gebeurt

De kolom blijft bestaan en blijft de **administratieve** status dragen (afgeleid uit D2, bijgewerkt
door de schrijvers). Wat verdwijnt is haar rol als schrijfverbod: die verhuist naar
`posting_locked_through`. Dat is de kern van de hele operatie en gebeurt pas in PR G, nadat de
blokkade bestaat en is ingericht.

---

## F. Afsluitstroom (aangepast)

Ongewijzigd ten opzichte van vandaag, met drie toevoegingen:

1. gereedheidscontrole, bevestiging, `close_fiscal_year(_client_id, _fiscal_year)` — als nu;
2. de schrijver legt naast de stand in `year_closures` óók een `closed`-gebeurtenis vast;
3. herafsluiten na een heropening is toegestaan: de stand gaat van `reopened` terug naar `closed`,
   met een nieuwe gebeurtenis. Idempotentie blijft: is de stand al `closed`, dan komt hetzelfde
   bewijs terug met `created = false` en wordt er **geen** tweede gebeurtenis geschreven.

Het afsluiten zet **geen** boekingsblokkade. Wil het kantoor dat, dan is dat een aparte, zichtbare
handeling — desnoods als voorgestelde vervolgstap op hetzelfde scherm.

---

## G. Heropenstroom (nieuw)

`reopen_fiscal_year(_client_id uuid, _fiscal_year integer, _reason text)`.

- rolvloer **accountant**, gelijk aan alle financiële schrijvers;
- reden **verplicht**, genormaliseerd zoals `reverse_posting_group()` dat met `_reason` doet
  (`btrim(…, E' \t\r\n')`, lege tekst is geen reden), en begrensd;
- onder `lock_ledger_client()` + `SELECT … FOR UPDATE`, dezelfde grendelvolgorde als elke schrijver;
- schrijft een `reopened`-gebeurtenis, zet de stand op `reopened` en verlaagt
  `afgesloten_boekjaar` naar `_fiscal_year - 1`;
- **verwijdert niets**: geen bewijs, geen boeking, geen tegenboeking, geen resultaat- of
  doorrolregel;
- **volgorde**: alleen het hoogste afgesloten jaar kan worden heropend. Een ouder jaar heropenen
  terwijl een jonger jaar dicht staat, zou het watermerk onder dat jongere jaar wegtrekken.
  Fail-closed, met een begrijpelijke melding;
- **idempotentie**: staat het jaar al open, dan is dat geen fout maar een mededeling — met de
  bestaande gebeurtenis erbij, exact het patroon van `created = false` bij afsluiten.

Na heropenen is boeken in dat jaar mogelijk **voor zover de boekingsblokkade het toelaat**. Dat is
de hele bedoeling van de scheiding.

---

## H. Boekingsblokkadestroom (nieuw)

`set_posting_lock(_client_id uuid, _locked_through date, _reason text)` en
`clear_posting_lock(_client_id uuid, _reason text)`.

- rolvloer **accountant**;
- beide leggen een gebeurtenis vast met de oude en de nieuwe waarde, plus reden en actor;
- de blokkade **vooruit** zetten is routine; **terug** zetten of opheffen is de gevoelige handeling
  en krijgt daarom een eigen bevestiging en een verplichte reden;
- de toets zit in `posting_allowed()` en dus **in de databaseschrijfgrens**, niet in de UI. De UI
  mag hem tonen; hij mag er nooit van afhangen.

Typische stroom die hiermee mogelijk wordt, en vandaag niet:

```
blokkade t/m 31-12-2024        → 2023 en 2024 beschermd, werken in 2025
correctie nodig in 2024        → boekjaar 2024 heropenen (reden verplicht)
                               → blokkade tijdelijk naar 31-12-2023
                               → correctie boeken
                               → gereedheid opnieuw controleren
                               → 2024 opnieuw afsluiten
                               → blokkade terug naar 31-12-2024
```

---

## I. Autorisatiemodel

Ongewijzigd van opzet: `has_min_role()` in de database, geen tweede ladder in de app.

| Handeling | Vloer | Grond |
|---|---|---|
| Afsluitgeschiedenis lezen | `read_only` | gelijk aan `year_closures` vandaag |
| Boekjaar afsluiten | `accountant` | gelijk aan vandaag |
| Boekjaar heropenen | `accountant` | maakt eerder gesloten werk weer beschrijfbaar |
| Blokkade vooruit zetten | `accountant` | beschermende richting |
| Blokkade opheffen of verlagen | `accountant` | dezelfde vloer, maar met verplichte reden en eigen bevestiging |

Een hogere vloer (`owner`) voor heropenen en ontgrendelen is overwogen. Afgevallen omdat élke
bestaande financiële schrijver op `accountant` staat en een afwijkende vloer hier een tweede,
ongedocumenteerde rangorde zou introduceren. Dit is uitdrukkelijk een **productbeslissing die de
firma kan overrulen** — de plek om hem te veranderen is één regel in beide nieuwe schrijvers.

---

## J. Audit-eisen

1. Geen gebeurtenis wordt ooit gewijzigd of verwijderd — `prevent_…_mutation`-patroon met
   `ENABLE ALWAYS`, inclusief `TRUNCATE`.
2. Elke heropening draagt een reden; zonder reden geen heropening (CHECK, niet alleen applicatie).
3. Elke gebeurtenis draagt actor en tijdstip; de actor is een FK naar `auth.users` met `RESTRICT`.
4. De volledige geschiedenis per boekjaar is leesbaar voor iedereen die de organisatie mag lezen.
5. Bestaande afsluitbewijzen blijven staan, ook na heropening. Heropenen wist geen bewijs; het voegt
   bewijs toe.

---

## K. Migratie- en backfillstrategie

**Voorwaartse migraties, altijd.** `20260924120000` is toegepast op productie
(`alxlbdhpbwlehbdbfejw`) en wordt niet aangeraakt — hem bewerken zou de repo laten afwijken van wat
er draait.

| Bestaande gegevens | Behandeling |
|---|---|
| Rijen in `year_closures` | blijven staan. De nieuwe `status`-kolom krijgt `DEFAULT 'closed'`, wat voor elke bestaande rij de juiste waarde is |
| `fiscal_year_events` bij aanvang | backfill van één `closed`-gebeurtenis per bestaande `year_closures`-rij, met `occurred_at = closed_at` en `actor_id = closed_by`. Dat verzint niets: beide waarden staan al vast |
| `clients.afgesloten_boekjaar` | ongewijzigd. Hij blijft de administratieve stand tot PR G, en daarna nog steeds — alleen niet langer als schrijfverbod |
| **Handmatige watermerken zonder bewijs** | **niet backfillen.** Er is geen actor en geen tijdstip, dus een gebeurtenis zou verzonnen zijn. Zij blijven de bestaande "inconsistent"-toestand en krijgen bij PR E een expliciete herstelweg: de accountant sluit het jaar alsnog via de nieuwe weg af, of heropent het bewust. Wat er **niet** gebeurt is stilzwijgend een bewijs fabriceren |
| `posting_locked_through` | start als `NULL` voor iedereen = geen blokkade. Bij PR G wordt per administratie éénmalig voorgesteld hem op `31-12-<afgesloten_boekjaar>` te zetten, als **expliciete, zichtbare** handeling per klant — geen stille massaupdate |

Niets in dit pad is destructief. De enige bestaande garantie die wordt versmald is
`prevent_year_closure_mutation()` (van "geen enkele UPDATE" naar "alleen de statuskolom"), en dat
gebeurt met een eigen migratie, een eigen test en een eigen rollbackcomment.

---

## L. Erfenis: het handmatige watermerk

Productie kent administraties waarvan `afgesloten_boekjaar` vóór PR 2a met de hand is gezet, zonder
`year_closures`-rij. `close_fiscal_year()` faalt daar vandaag bewust op (`23514`), en de UI meldt
het sinds PR 2b expliciet.

In het nieuwe model verandert die toestand van **doodlopend** in **oplosbaar**: zodra heropenen
bestaat, kan de accountant zo'n jaar bewust heropenen (met reden), de controle draaien en het via de
nieuwe weg afsluiten — waarna er wél bewijs is. Dat is een echte verbetering en het is de reden om
de erfenistoestand niet te backfillen maar te laten herstellen.

---

## M. Faal- en idempotentiemodel

| Situatie | Gedrag |
|---|---|
| Afsluiten van een al afgesloten jaar | bestaand bewijs terug, `created = false`, geen tweede gebeurtenis |
| Heropenen van een al open jaar | bestaande gebeurtenis terug, `reopened = false`, geen tweede gebeurtenis |
| Twee gelijktijdige afsluitingen | serialiseren op `lock_ledger_client()`; de PK van `year_closures` arbitreert |
| Twee gelijktijdige heropeningen | idem; de tweede ziet de stand al op `reopened` |
| Onbekende afloop (time-out) | de UI verzoent door de stand opnieuw te lezen, zoals PR 2b al doet |
| Heropenen terwijl een jonger jaar dicht staat | geweigerd, fail-closed, met reden |
| Blokkade zetten terwijl een boeking loopt | serialiseert op dezelfde administratiegrendel |

---

## N. Uitrol in kleine PR's

Afwijkend van de voorgestelde volgorde op één punt: **de boekingsblokkade komt vóór het heropenen**.
Reden: zodra heropenen bestaat zonder blokkade, is er een venster waarin een heropend jaar volledig
onbeschermd is. Andersom is er geen venster — een blokkade zonder heropenmogelijkheid verandert
niets aan wat er vandaag kan.

| PR | Inhoud | Los te reviewen? |
|---|---|---|
| **A** | `fiscal_year_events` + `status`-kolom + backfill uit bestaande `year_closures`. Nog geen gedragswijziging: niemand leest de tabel | ja — puur additief |
| **B** | `close_fiscal_year()` legt óók een gebeurtenis vast. Idempotentie ongewijzigd | ja — gedrag identiek, alleen rijker auditspoor |
| **C** | `posting_allowed()` + `clients.posting_locked_through` + `set_posting_lock()` / `clear_posting_lock()`. De helper wordt gemaakt maar nog **niet** door de schrijvers gebruikt | ja — nog geen enkele schrijver raakt eraan |
| **D** | De acht schrijvers toetsen `posting_allowed()` **naast** het bestaande watermerk. Strikt strenger, dus geen regressierisico | ja — alleen toevoegend |
| **E** | `reopen_fiscal_year()` + de versmalde markertrigger | ja |
| **F** | UI: heropenen, geschiedenis, reden, bevestiging | ja |
| **G** | UI: boekingsblokkade instellen, opheffen, tonen; per klant het eenmalige voorstel | ja |
| **H** | **Ontkoppeling.** De acht schrijvers laten de watermerktoets vallen; `afgesloten_boekjaar` is vanaf hier alleen nog status. Tests uit B5 bijgesteld, `ALTIJD_ERROR` herzien | ja, maar **dit is de enige PR met echt gedragsrisico** en hoort apart te worden uitgerold en gerookt |

Acht kleine PR's in plaats van zeven, en de gevaarlijke stap staat alleen en als laatste.

---

## O. Risico's

1. **PR H is de enige echte.** Daarvóór wordt het systeem alleen strenger of rijker; daarna kan er
   geboekt worden waar dat eerder niet kon. Uitrollen met een rookproef per administratie, en pas
   nadat de blokkades zijn ingericht.
2. **Twee velden die op elkaar lijken.** `afgesloten_boekjaar` (integer, status) naast
   `posting_locked_through` (date, blokkade). Mitigatie: verschillende typen, verschillende namen,
   en in de UI nooit naast elkaar zonder uitleg.
3. **Heropenen als sluipweg.** Als heropenen te makkelijk is, verdwijnt de betekenis van afsluiten.
   Mitigatie: verplichte reden, onuitwisbare gebeurtenis, zichtbaar in de geschiedenis, en de
   volgorderegel.
4. **De versmalling van `prevent_year_closure_mutation()`** is het enige moment waarop een
   bestaande onuitwisbaarheidsgarantie wordt aangeraakt. Eigen migratie, eigen bewijs op een
   wegwerpcluster, eigen review.
5. **Backfill van de gebeurtenissen** leunt op `closed_at`/`closed_by`. Voor de handmatige
   watermerken bestaan die niet — vandaar dat die bewust niet worden gebackfilled. Wie dat later
   alsnog wil, verzint gegevens.
6. **`bank_bulk_posting_candidates()`** dupliceert de watermerkregel in SQL zonder de guard aan te
   roepen (`20260922120000` : 204-205, 223-224). Bij PR D/H moet die apart worden meegenomen,
   anders loopt de preflight uit de pas met de schrijver.
7. **Boekjaar = kalenderjaar** blijft een aanname van het hele product. Een datumblokkade is daar
   niet mee in strijd, maar maakt het verschil wel zichtbaarder.

---

## P. Teststrategie

- **Puur (vitest):** statusafleiding uit een gebeurtenisreeks (`closed` → `reopened` → `closed`),
  de beschikbaarheid van heropenen, de normalisatie van de reden, de nieuwe foutvertalingen.
- **Contract over de migraties:** één test per nieuwe migratie, in het bestaande patroon van
  `src/test/year-close-writer.test.ts` — commentaar gestript, gericht op codevormen, nooit op proza.
- **Echte PostgreSQL** (`supabase/tests/`, wegwerpcluster, zoals `year-close/run-proof.sh`):
  sluiten → heropenen → boeken → opnieuw sluiten in één doorlopend bewijs; de volgorderegel;
  idempotentie van beide schrijvers; twee gelijktijdige heropeningen; de blokkade die een boeking
  tegenhoudt en na opheffen doorlaat; rechten en RLS op beide nieuwe tabellen.
- **De acht schrijvers:** de bestaande per-schrijvertests uit B5 blijven het instrument. In PR D
  wordt er per schrijver een assertie op `posting_allowed()` bijgezet; in PR H verschuift de
  assertie van de watermerktoets naar de blokkadetoets. Dat maakt zichtbaar of een schrijver bij een
  van beide stappen is overgeslagen.
- **Pinning nu:** `src/test/year-close-coupling.test.ts` (deze PR) legt vast dat alle acht schrijvers
  vandaag dezelfde guard dragen, zodat een latere refactor aantoonbaar niemand vergeet.

---

## Wat dit document NIET voorstelt

Geen wijziging aan het debet-creditmodel, aan `ledger_postings` als financiële waarheid, aan de
synthetische resultaatregels in de rapportage, aan de beginbalansmotor, aan de
rapportageclassificatie of aan de BTW-logica. Dit is uitsluitend levenscyclus- en controle-
architectuur.
