# BoekAssist zichtbare blauwe merkaccenten

## Doel
De bestaande interface duidelijker als BoekAssist laten aanvoelen met rustige blauwe accenten, zonder indeling, inhoud of gedrag te wijzigen.

## Wijzigingen
- Verfijn uitsluitend de semantische kleurrollen in `src/index.css` voor een iets zichtbaarder koelblauw secundair vlak, met behoud van wit, navy, teal, amber en rood.
- Pas alleen gedeelde presentatiecomponenten aan waar de huidige kleurrol een bestaand actief of interactief element te neutraal maakt:
  - lege-status iconen: lichtblauw vlak en blauw icoon;
  - tabelkoppen en geselecteerde rijen: duidelijker blauwgrijs/lichtblauw;
  - tablijsten en actieve tabs: lichtblauwe groep en helderder blauw actief accent;
  - bestaande interactieve kaarten: uitsluitend via bestaande state-attributen een subtiele blauwe rand/achtergrond; gewone kaarten blijven wit;
  - navigatie, focus en knoppen behouden hun bestaande semantiek; statussen blijven teal, amber en rood.
- Geen individuele pagina’s wijzigen tenzij de gedeelde primitives aantoonbaar onvoldoende zijn.

## Controle
- Desktop- en mobiele preview visueel vergelijken op blauwe merkpresentie en overloop.
- Uitvoeren: `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`, `git diff --check`.
- Diff controleren op uitsluitend kleur/surface-presentatie en geen migraties.

## Technische details
- Hergebruik bestaande Tailwind-semantie (`primary`, `secondary`, `muted`, `ring`, sidebar-tokens); geen pagina-specifieke kleuren of nieuwe afhankelijkheden.
- De huidige aparte edit-branch start exact op de laatste lokale/main remote HEAD; commit/push/PR wordt alleen uitgevoerd voor zover de beheerde omgeving dit toestaat.
