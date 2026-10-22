# Herstelvoorstel legacy-betaaldata (P5a) — NIET TOEGEPAST

Dit is een voorstel voor de eigenaar. Het staat bewust niet in een migratie: D1, voorwaarde 8, verbiedt
productiedata te wijzigen zonder afzonderlijke toestemming. Er wordt niets automatisch hersteld.

**Wat er nu gebeurt.** Na P5a weigert de betaalschrijver elke factuur en banktransactie die niet aansluit.
De melding is "herstel nodig" en er wordt niets geschreven. Een factuur die vroeger via een oude match is
betaald, gaat dus nooit stil weer open. De tellingen per categorie komen uit `preflight.sql` (PRE 3–5).

**Werkwijze per categorie.** Draai eerst de PRE-blokken en geef de tellingen door. Kies per categorie een
optie, dan pas per administratie. Elke correctie verloopt via de app of via een apart, door de eigenaar
goedgekeurd script met dezelfde PRE/POST-discipline. Na elke correctie volgt PRE 3–5 opnieuw.

## Facturen (PRE 3)

| Code | Betekenis | Risico als je niets doet | Voorstel | Besluit van de eigenaar |
|---|---|---|---|---|
| Q3a | Een koppeling met de verkeerde soort verwijst naar dit factuur-id. | Factuur onbetaalbaar via de app. | Onderzoek per rij welke factuur bedoeld was. Gooi de verkeerde rij weg, of maak een nieuwe aan via de RPC. | Weggooien toestaan? |
| Q3b | Er zijn koppelingen, maar geen bedrag incl. btw. | Restant niet af te leiden. | Vul eerst het bedrag (P4-validatie), daarna Q3h. | Wie vult de bedragen? |
| Q3c | Som van de koppelingen is groter dan het factuurbedrag (overbetaling). | Geblokkeerd. post_bank_allocation weigert ook. | Ontkoppel de jongste koppeling(en) tot de som ≤ bedrag. Een echte overbetaling wordt een open ontwerpbesluit (creditering). | Welke koppeling vervalt? |
| Q3d | Betaald zonder koppeling: betaald via de oude match, vóór de koppelingstabel. | Geen. De factuur blijft betaald en geblokkeerd. | Is de banktransactie bekend (PRE 4, Q4b)? Leg de oude match vast via "koppelen" op díe transactie. De RPC staat dat toe (event `formalized`) als het opgeslagen restant de betaling al bevat. Anders: laten staan. | Vastleggen of laten staan? |
| Q3e | Betaald, maar de koppelingen dekken het bedrag niet. | Geblokkeerd. Mogelijk deels onterecht betaald. | Per factuur beslissen: koppeling aanvullen, of status terug naar gecontroleerd (alleen door de eigenaar, na controle). | Status terugzetten toestaan? |
| Q3f | Restant leeg terwijl er koppelingen zijn. | Geblokkeerd. | Restant := bedrag − som (één UPDATE per factuur, met PRE/POST). | Akkoord met afleiden? |
| Q3g | Restant zonder bedrag incl. btw, o.a. "0" uit de oude OCR-intake (A1-20). De UI toont dit als "Betaald". | Verkeerde weergave. | Bij een OCR-intake zonder bedrag: restant := NULL ("Onbekend"). Daarna het bedrag invullen. | Akkoord? |
| Q3h | Restant wijkt af van bedrag − koppelingen. | Geblokkeerd. | Restant := bedrag − som, als de koppelingen kloppen. Anders eerst de koppelingen herstellen. | Akkoord met afleiden? |
| Q3i | Inkoopfactuur met de oude status `betaald`. | Ontkoppelen geweigerd. Een betaling zet een inkoopfactuur nooit op betaald. | Status naar `gecontroleerd` of `geexporteerd`, afhankelijk van de exportgeschiedenis. | Welke status? |

## Banktransacties (PRE 4)

| Code | Betekenis | Voorstel |
|---|---|---|
| Q4a | Gematcht zonder factuur en zonder koppeling. | Terug naar `niet_gematcht` (matchvelden leeg), na controle in de bankregel. |
| Q4b | Gematcht via een oude match zonder koppeling. | Leg de match vast via de app ("koppelen" op de eigen matched factuur, zie Q3d). Lukt dat niet (restant past niet), dan per geval beslissen. |
| Q4c | Gematcht, maar de primaire factuur heeft geen koppeling (wel andere). | Primaire factuur := een gekoppelde factuur, of de oude match vastleggen. |
| Q4d | Gecodeerd (handmatig_geboekt) én gekoppeld. | Kies één van de twee. Is de transactie direct geboekt? Dan is de koppeling fout (PR 0). Anders de codering weghalen. |
| Q4e | Koppelingen, maar niet gematcht. | Geen actie nodig. De volgende koppeling via de RPC zet `gematcht`. Ontkoppelen ruimt het ook op. |
| Q4f | Som van de koppelingen is groter dan het transactiebedrag. | De jongste koppeling ontkoppelen. |

## Koppelingen (PRE 5)

| Code | Betekenis | Voorstel |
|---|---|---|
| Q5a | Weeskoppeling: de factuur bestaat niet meer (C-08). | Na controle weggooien. P5c weigert daarna het verwijderen van een factuur met koppelingen. |
| Q5b | Factuur van een andere administratie of organisatie. | Weggooien; de juiste koppeling opnieuw via de RPC. |
| Q5c | Verkeerde richting (bijv. verkoop op uitgaand geld, een storno). | Ontwerpbesluit storno (P5-ontwerp §5). Tot dan: laten staan of ontkoppelen. |
| Q5d | Koppeling op een afgewezen paar (A1-24). | De afwijzing of de koppeling vervalt, per geval. |
| Q5e | Koppeling op een direct geboekte transactie (PR 0). | Hoort bij PR 0. De koppeling kan niet geboekt worden. Ontkoppelen kan via de RPC niet (die weigert een direct geboekte transactie), dus dit loopt via een apart script. |

## Wat dit voorstel niet doet

- Het boekt niets in het grootboek en draait niets tegen.
- Het wijzigt geen geboekte (bevroren) koppeling.
- Het raadt geen status: elke statuswijziging hierboven is een besluit van de eigenaar.
