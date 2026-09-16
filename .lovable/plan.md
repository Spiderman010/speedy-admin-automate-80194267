# BoekAssist branding-pass

## Doel
De bestaande UI-polish behouden en uitsluitend de gedeelde kleuridentiteit aanscherpen naar een rustige, professionele BoekAssist-uitstraling.

## Wijziging
- Alleen de semantische kleurrollen in `src/index.css` aanpassen.
- Lichte modus: koel-witte achtergrond, navy tekst, helder betrouwbaar blauw, ingetogen teal/groen, gedempt amber en rood, subtiele koelgrijze randen.
- Donkere modus: dezelfde merkhiërarchie met voldoende contrast.
- Sidebar: dieper navy, duidelijker blauw actief item en rustige contrasterende tekst.
- Geen componentstructuur, ruimteverdeling, dichtheid, content of interactie wijzigen.

## Technische details
- Bestaande HSL CSS-variabelen blijven de enige bron voor kleuren.
- Bestaande Tailwind-klassen en shadcn-varianten blijven ongewijzigd en nemen de nieuwe tokens automatisch over.
- Contrast wordt numeriek gecontroleerd voor tekst/achtergrond en statusrollen, plus visueel op desktop en mobiel.

## Validatie
- Desktop- en mobiele preview, inclusief sidebar, primaire actie, badges en focusstatus.
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`
- `npm run build`
- `git diff --check`
- Eindcontrole dat alleen presentatie is gewijzigd en migraties ontbreken.
