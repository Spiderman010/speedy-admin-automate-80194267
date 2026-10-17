# Bank — niet-operationeel ontwerpvoorstel v1.1

## Doel en afbakening
Een herkenbaar afgescheiden voorbeeldwerkbank op de bestaande Bankpagina: moderne, compacte bankadministratie met statische, fictieve transacties en een conceptueel correctiepaneel. Het is geen vervanging van de werkende bankadministratie en geen werkende correctiefunctie.

De bestaande transactietabel, filters, selectie, boekingsknoppen, handlers en detaildocks blijven ongewijzigd. De voorbeeldwerkbank krijgt een zichtbare aanduiding **“Bankcorrecties v1.1 — voorbeeldgegevens, geen echte boekingen”**, zodat voorbeelden nooit als echte administratie worden gepresenteerd.

## Wat de inspectie laat zien
- De bestaande tabel toont datum, omschrijving, bedrag, betrouwbaarheid, matchstatus, factuurkoppeling en acties. Tegenrekening en grootboekcodering zijn niet als volwaardige tabelkolommen zichtbaar.
- `gematcht` en `handmatig_geboekt` zijn verwerkingsstatussen: ze bewijzen niet dat een transactie in het grootboek is geboekt. Directe boekingen en geboekte factuurafletteringen hebben aparte boekingsbewijzen.
- Bestaande transacties hebben een tegenrekening en optionele grootboekcodering. De directe boekingsbediening biedt 0%, 9% en 21% btw. Factuuraflettering boekt de betaling, niet opnieuw kosten of btw.
- De huidige stijl gebruikt warmgrijze achtergrond, witte werkvlakken, dunne randen en semantische kleuren. Deze bestaande stijl blijft leidend.
- De projectafspraken benoemen expliciet dat een tegengeboekte bankboeking haar boekingsmarkering behoudt. Dit voorstel suggereert daarom niet dat tegenboeken een transactie automatisch ontgrendelt.

## Voorgestelde indeling
```text
Bankcorrecties v1.1 — voorbeeldgegevens, geen echte boekingen
┌───────────────────────────────────┬───────────────────────────┐
│ Voorbeeldtransacties              │ Correctievoorstel         │
│ Datum / omschrijving / IBAN       │ Geselecteerd voorbeeld    │
│ Bedrag / rekening / btw / status  │ Rekening                  │
│                                   │ Btw-behandeling           │
│ Compacte, selecteerbare rijen     │ Omschrijving              │
│                                   │ Voorbeeld correctiehistorie│
└───────────────────────────────────┴───────────────────────────┘
```

### 1. Banktransactietabel
- Desktop: circa 65% tabel en 35% correctiepaneel, zonder zwevende kaarten of grote schaduwen.
- Kolommen: **Datum, Omschrijving, Tegenrekening, Bedrag, Grootboekrekening, Btw-behandeling, Status**.
- Bedragen rechts uitgelijnd, Nederlandse euro-opmaak en mono/tabular cijfers. IBAN en rekeningnummer goed scanbaar; volledige omschrijving blijft bereikbaar.
- Compacte rijen met voldoende ruimte voor twee regels tekst. Invoervelden en rijbediening minimaal 36px hoog.
- Blauw uitsluitend voor selectie en normale bediening; groen, amber en rood behouden hun bestaande betekenis.
- Mobiel: voorbeeldrijen stapelen datum/bedrag, omschrijving en boekingsinformatie logisch; correctiepaneel onder de lijst. Geen horizontale pagina-scroll.

### 2. Boekingsroute en boekingsstatus onderscheiden
De voorbeeldgegevens bevatten expliciet beide dimensies, zonder iets uit matchstatus of rekeningnummer af te leiden:
- **Direct geboekt**: grootboekrekening en bekende btw-behandeling zichtbaar.
- **Via factuur afgeletterd**: factuurverwijzing zichtbaar; btw aangeduid als afkomstig van de factuur, geen tweede btw-boeking op de betaling.
- **Nog niet geboekt**: onderscheid tussen ongecodeerd en al gecodeerd maar nog niet definitief geboekt.
- Ontbrekende informatie blijft “—” of “Niet beschikbaar”; 0% wordt niet gelijkgesteld aan vrijgesteld of verlegd.

### 3. Conceptueel correctiepaneel
- Alleen selectie uit de fictieve transacties opent het voorbeeldpaneel; nooit de echte bankselectie gebruiken.
- Toon bestaande voorbeeldwaarden naast een lokaal correctievoorstel voor **grootboekrekening, btw-behandeling en omschrijving**.
- Voorbeeld: rekening **8250 → 4700**. Dit is uitsluitend fictieve illustratie, geen wijziging van de eerder besproken echte transactie.
- Lokale wijzigingen mogen alleen het voorbeeld veranderen; geen opslaan-, boeken- of corrigerenactie met financieel gevolg.
- De factuuraflettering krijgt een informatieve voorbeeldvariant, geen suggestie dat haar rekening of btw op dezelfde manier direct kan worden aangepast.

### 4. Voorbeeld correctiehistorie
Een compacte, duidelijk fictieve tijdlijn met:
1. **Originele boeking** — voorbeeldrekening 8250.
2. **Tegenboeking** — neutraliseert het origineel in het voorbeeld.
3. **Vervangende boeking** — voorbeeldrekening 4700.

De bedragen en historie zijn vooraf ingevulde voorbeelden, geen berekeningen uit echte transacties. Geen verzonnen echte actor, datum of auditbewijs. Origineel en vervanging blijven beide leesbaar; de tijdlijn belooft geen bestaande correctiemogelijkheid.

## Voorgenomen bestanden na expliciet akkoord
| Bestand | Wijziging |
|---|---|
| `src/components/bank/BankCorrectionsPrototype.tsx` — nieuw | Zelfstandige voorbeeldtabel, lokaal conceptpaneel en fictieve historie; uitsluitend bestaande UI-componenten en stijltokens. |
| `src/pages/Bank.tsx` — bestaand | Alleen import en duidelijk afgescheiden plaatsing van het prototype; bestaande werkende onderdelen blijven intact. |
| `AGENTS.md` — bestaand | Eén korte structurele regel: prototype volledig gescheiden van echte bankdata en schrijfhandelingen. |

Geen globale stijlwijzigingen. Geen wijzigingen aan hooks, queries, routes, detaildocks, boekingsacties, gegenereerde types, packagebestanden of Edge Functions. Geen databaseactie, migratie, RPC, commit naar main of productiepublicatie.

## Technische veiligheid en controle
- Het prototype importeert geen databaseclient, boekingshook of mutatiehook en ontvangt geen echte banktransacties of echte schrijfhandlers.
- Alle tijdelijke selectie en invoer blijven binnen het prototype; herladen verwijdert het concept.
- Hergebruik bestaande Table, Input, Select, Badge en andere UI-primitieven. Geen nieuwe UI-library of financiële rekenlaag.
- Na akkoord: desktop en mobiel controleren, voorbeeldselectie en conceptvelden doorlopen en controleren dat bestaande bankbediening ongewijzigd blijft; relevante bestaande Banktests uitvoeren.
- Actieve sessiebranch is `edit/edt-580fe40b-7fd7-4269-b3e9-13d1d5c7725f`, niet `main`. Geen git-branchwijziging, commit of push uitgevoerd. Vóór bouwen moet de bedoelde feature-branch actief zijn; branchbeheer loopt via Lovable/GitHub.

## Inspectierapport
**Gelezen:** `AGENTS.md`, relevante delen van `PROJECT_MAP.md`, `src/pages/Bank.tsx`, `src/components/bank/BankTransactionDetailSheet.tsx`, `src/components/BankAfletteringDrawer.tsx`, `src/hooks/useBankTransactions.ts` (meegeleverde context), `src/hooks/useBankTransactionPosting.ts`, `src/hooks/useBankAllocationPosting.ts`, `src/components/bank/BankTransactionPostingAction.tsx`, `src/components/BankAllocationPostingAction.tsx`, `src/index.css`, `tailwind.config.ts`, `src/components/ui/sheet.tsx`, `src/components/ui/dialog.tsx`, `src/components/ui/table.tsx` en relevante projectgeheugenafspraken.

**Gewijzigde applicatiebestanden:** geen. Alleen het ontwerpvoorstel en de projectgeheugenafspraak zijn vastgelegd.

**Migraties:** geen.

**Tests:** niet uitgevoerd; dit is uitsluitend inspectie en ontwerp, geen implementatie. Geen build, databaseactie of publicatie uitgevoerd.

## Akkoord gevraagd
Geef expliciet akkoord voor dit afgebakende statische prototype en de bovenstaande voorgenomen bestanden. Tot dat akkoord wordt geen bestaande code aangepast.