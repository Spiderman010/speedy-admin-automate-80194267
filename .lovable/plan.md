# Waarom geboekte facturen niet in de kolommenbalans staan

## Wat ik in de gegevens zie

De kolommenbalans (proef- en saldibalans) toont uitsluitend regels uit het grootboek. In de administratie staan op dit moment **nul grootboekregels** — voor geen enkele klant, geen enkel jaar.

Tegelijk staan er wel documenten klaar:
- 49 inkoopfacturen (31 gecontroleerd, 5 geëxporteerd, 13 te controleren)
- 48 verkoopfacturen (34 betaald, 12 gecontroleerd, 2 concept)
- 1.817 handmatig geboekte banktransacties
- 1 beginbalans

Geen enkele daarvan is ooit daadwerkelijk in het grootboek gezet: de tellers van alle boekingstabellen (inkoop, verkoop, bank, memoriaal, beginbalans) staan op 0.

Oorzaak: "gecontroleerd", "geëxporteerd" en "betaald" zijn werkstatussen van het document, geen grootboekboeking. De boeking ontstaat pas als per document de actie "Boeken in grootboek" wordt uitgevoerd. Daarom is de kolommenbalans leeg — dat is correct gedrag, niet een fout in het rapport.

## Tweede oorzaak: ontbrekende rekeninginstellingen

Boeken wordt geweigerd zolang de vaste rekeningen van een administratie niet zijn ingesteld. Van de 11 administraties hebben er 10 **geen BTW-rekeningen en geen bankrekening** ingesteld; alleen "agio finance" is volledig ingericht. Debiteuren en crediteuren staan overal wel ingevuld. Zolang die instellingen ontbreken, blijft boeken per factuur geblokkeerd.

## Derde punt: de inhaalpagina is onvindbaar

Er bestaat al een pagina die per klant en jaar laat zien welke facturen geboekt, boekbaar of geblokkeerd zijn, en die ze in één keer kan boeken (`/grootboek/historisch`). Die pagina staat **niet in het menu**, dus in de praktijk gebruikt niemand hem.

## Voorstel

1. Rekeninginstellingen per administratie aanvullen (BTW te vorderen, BTW te betalen, bankrekening) — dit is invoerwerk in de klantinstellingen, geen code.
2. De inhaalpagina "Historisch boeken" aan het Grootboek-menu toevoegen, zodat de bulkboeking vindbaar is.
3. De lege staat van de kolommenbalans een duidelijke uitleg en doorverwijzing geven: "Nog geen geboekte grootboekmutaties. Facturen met status gecontroleerd zijn nog niet geboekt — boek ze via Historisch boeken." met knop naar die pagina.
4. Dezelfde doorverwijzing in de balans- en winst-en-verliesoverzichten, die op dezelfde bron draaien.

## Technische details

- Bron van alle rapportages blijft `ledger_postings`; er wordt niets aan de rapportagelogica of aan bedragen gewijzigd.
- Wijzigingen beperkt tot: navigatie-item in `src/components/layout/nav.ts`, lege-staat-teksten in `ProefSaldibalans.tsx` (en optioneel `Balans.tsx` / `WinstVerlies.tsx`), plus bijpassende tests.
- Geen migraties, geen aanpassing van boekingsfuncties of statussen.
