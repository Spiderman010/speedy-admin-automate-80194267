# AI-boekingsagent voor BoekAssist — mogelijkheden

Je vraagt om een AI-agent die daadwerkelijk kan boeken in BoekAssist. Dat is technisch mogelijk op drie manieren. Elk heeft andere mogelijkheden, veiligheidsrisico's en bouwomvang. Deze vergelijking geeft de opties zonder dat er nu al code verandert.

## Bestaande situatie

- Er is al een chat-UI op `/ai-chat` met een simpele vraag-antwoord Edge Function (`supabase/functions/ai-chat/index.ts`).
- Er is al een MCP-server (`src/lib/mcp/index.ts`) met OAuth-beveiliging en vier lees-tools: klanten, openstaande inkoopfacturen, openstaande verkoopfacturen, niet-gematchte banktransacties.
- De app werkt via Lovable Cloud (Supabase backend), met RLS, organisatie-scoping en gebruikersauthenticatie.
- Directe boekingen in SnelStart zijn niet mogelijk: de app exporteert alleen CSV-bestanden die handmatig in SnelStart worden geïmporteerd.

## Wat "boeken" voor deze agent betekent

De agent kan in de app drie soorten acties uitvoeren:

1. **Status wijzigen** — bijvoorbeeld een inkoopfactuur van `te_controleren` naar `gecontroleerd` zetten.
2. **Regels aanmaken/wijzigen** — bijvoorbeeld boekingsregels bij een inkoopfactuur opslaan via `purchase_invoice_lines`.
3. **Export voorbereiden** — bijvoorbeeld een SnelStart-CSV genereren voor een selectie facturen of banktransacties.

De agent kan **niet** rechtstreeks in SnelStart boeken, omdat er geen API-koppeling is.

## Optie A — In-app chatagent met boekingsrechten

De bestaande `/ai-chat` pagina wordt uitgebreid tot een agent met tool-calling. De gebruiker geeft opdrachten in het Nederlands, bijvoorbeeld: *"Zet alle inkoopfacturen van klant X die al compleet zijn op gecontroleerd"* of *"Genereer de SnelStart-export voor de gecontroleerde inkoopfacturen van deze maand"*.

### Wat kan

- Lezen van inkoopfacturen, verkoopfacturen, banktransacties, klanten.
- Wijzigen van status, toevoegen van boekingsregels, voorbereiden van exports.
- Mutaties kunnen achter een expliciete "Bevestig"-vraag van de agent staan (needsApproval).

### Wat niet kan

- Direct in SnelStart boeken; de gebruiker moet de gegenereerde CSV nog handmatig importeren.

### Bouwomvang

Medium. Er moet een nieuwe Edge Function komen (of `ai-chat` wordt uitgebreid) die:

- de volledige chatgeschiedenis onthoudt;
- tools definieert voor lezen, status-wijzigen, boekingsregels opslaan en export genereren;
- mutaties pas uitvoert na bevestiging;
- fouten en credietlimieten van de Lovable AI Gateway afhandelt.

### Voor- en nadelen

| Voordeel | Nadeel |
|---|---|
| Geen extra externe tool nodig; werkt binnen BoekAssist | Vereist dat de gebruiker de app open heeft |
| Geschiedenis kan in de database worden opgeslagen | Muterende agent vereist zorgvuldige beveiliging en approvals |

## Optie B — MCP-server uitbreiden met schrijftools

De bestaande MCP-server (`boekassist-mcp`) krijgt extra tools die niet alleen lezen, maar ook mutaties uitvoeren. De gebruiker kan dan vanuit een externe AI-client (ChatGPT, Claude, Cursor) verbinding maken met BoekAssist en opdrachten geven.

### Wat kan

- Dezelfde lees-tools als nu, plus schrijftools voor status, boekingsregels en export.
- Externe AI-clients kunnen de BoekAssist-data gebruiken in hun eigen chatomgeving.

### Wat niet kan

- Een volledig in-app chatgevoel; de gebruiker zit in ChatGPT/Claude/Cursor.
- Directe SnelStart-boeking blijft onmogelijk.

### Bouwomvang

Medium tot groot. Vereist:

- Uitbreiding van `src/lib/mcp/tools/` met schrijftools.
- `defineMcp` in `src/lib/mcp/index.ts` uitbreiden.
- Nieuwe deploy van de MCP Edge Function.
- Opnieuw valideren van de MCP-manifest.
- Expliciet toestemmingsflow (OAuth) blijft bestaan.

### Voor- en nadelen

| Voordeel | Nadeel |
|---|---|
| Werkt vanuit de AI-tool die de gebruiker al kent | Minder visuele controle binnen BoekAssist |
| Geen extra UI-bouw in de app | Mutaties vanuit een externe client vragen extra vertrouwen |

## Optie C — Automatische achtergrondagent (regels gebaseerd)

Een agent die niet via chat werkt, maar via vooraf ingestelde regels automatisch voorstellen doet. Bijvoorbeeld: bij elke nieuwe inkoopfactuur wordt een grootboekrekening voorgesteld op basis van leverancier + omschrijving; bij banktransacties wordt automatisch een match voorgesteld als de tegenpartij en het bedrag overeenkomen.

### Wat kan

- Automatisch voorstellen voor grootboekrekening, BTW-percentage, matching.
- De gebruiker krijgt een lijst met voorstellen en bevestigt ze in één keer (bulk-approval).

### Wat niet kan

- Echte "chat" met de agent.
- Directe SnelStart-boeking.

### Bouwomvang

Groot. Vereist:

- Opslag van matchregels/templates per klant.
- Een nieuwe Edge Function die op aanvraag voorstellen genereert.
- UI voor voorstellen beoordelen en bulk-goedkeuren.

### Voor- en nadelen

| Voordeel | Nadeel |
|---|---|
| Minste dagelijkse handmatige kliks | Grootste bouwomvang |
| Werkt zonder dat de gebruiker een chat hoeft te voeren | Vereert historische data en patronen om betrouwbaar te zijn |

## Aanbeveling

Gezien de huidige architectuur (bestaande chat-UI, bestaande MCP-server, strakke RLS) is **Optie A** de snelste en meest gebruiksvriendelijke route. De gebruiker blijft in BoekAssist, en de bestaande AI-chat pagina kan geleidelijk worden opgewaardeerd tot een agent met beperkte, goedgekeurde boekingsacties.

## Keuzes die jij moet maken

Voordat we bouwen, zijn er twee keuzes die jouw werkproces bepalen:

1. **Gespreksvorm**
   - Eén doorlopend gesprek (de agent onthoudt alles in één chat).
   - Meerdere aparte gesprekken/threads (bijvoorbeeld per klant of per taak).

2. **Opslag van gesprekken**
   - Geen opslag (elk gesprek is nieuw na verversen).
   - Opslag in de browser (`localStorage`).
   - Opslag in de database (Lovable Cloud), met RLS per gebruiker/organisatie.

## Veiligheidskanttekening

Een agent die kan boeken, is muterend. Daarom moet elke mutatie:

- geautoriseerd zijn via de bestaande Supabase-sessie;
- gescoped zijn op organisatie en klant;
- niet zonder expliciete bevestiging plaatsvinden;
- audit-loggbaar zijn (wie, wat, wanneer).

Voorstel is om te beginnen met een "simulatie-modus": de agent laat zien welke acties hij zou doen, en de gebruiker bevestigt ze pas daarna. Pas na gebruik kan deze modus worden uitgeschakeld voor bepaalde veilige, laag-risico-acties.

## Vervolgstap

Geef aan welke optie je prefereert en maak de twee keuzes hierboven. Dan wordt een concreet implementatieplan opgesteld met exacte bestanden, routes en database-acties.
