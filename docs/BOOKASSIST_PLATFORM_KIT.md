# BoekAssist Platform Kit

De gedeelde presentatielaag van BoekAssist: een kleine verzameling
componenten voor patronen die in de app al meermaals bewezen zijn.

Canonieke bronnen naast dit document: `AGENTS.md` (werkwijze),
`PROJECT_MAP.md` (omgeving en migratiestatus) en
`BOOKASSIST_ACCOUNTING_PATTERNS.md` (de boekhoudkundige patronen achter de
schrijvers). Spreekt dit document een van die drie tegen, dan winnen zij.

---

## 1. Waarom deze laag bestaat

De app had een duidelijk patroon dat telkens opnieuw werd uitgeschreven.
Enkele tellingen uit de inventarisatie die aan V1 voorafging:

| Patroon | Wat er stond |
|---|---|
| Bedrag rechts uitgelijnd, monospace, `tabular-nums` | 124 keer, in 40 bestanden, in ruim 30 varianten van dezelfde klassenreeks |
| Eigen `label → waarde`-hulpcomponent (`Veld`, `Stat`, `Regel`, `Totaalregel`, `TechnischVeld`) | 6 privé-implementaties in 6 bestanden |
| `<dl>` met label/waarde-paren | 21 plaatsen |
| Waarschuwing | ofwel `Alert variant="destructive"` (rood, terwijl het geen fout is), ofwel met losse `amber-*`-kleuren buiten het tokensysteem om |

Het doel is niet uniformiteit om de uniformiteit. Het doel is dat een
volgende module — en een volgende agent — niet opnieuw hoeft te bedenken
hoe een bedrag eruitziet of wat er gebeurt met een veld dat niet is
vastgelegd.

---

## 2. De regel: REUSE → EXTEND → NEW

In deze volgorde, en bij elke stap pas verder als de vorige echt niet kan.

1. **REUSE** — bestaat het al? Kijk in deze kit, dan in
   `src/components/` (inclusief `overzichten/`, `grootboek/`, `bank/`),
   dan in `src/components/ui/` (shadcn).
2. **EXTEND** — bestaat het bijna? Geef het bestaande onderdeel een
   optionele prop. Een prop erbij is bijna altijd beter dan een tweede
   component die 90% hetzelfde doet.
3. **NEW** — pas als geen van beide redelijkerwijs werkt.

Nieuwe UI-ideeën zijn welkom. Wat een reden vraagt, is een **terugkerend
patroon** dat naast een bestaand patroon komt te staan. Noem die reden in de
PR: wat kon het bestaande niet, en waarom was een prop erbij geen oplossing.

Twee dingen die deze regel **niet** betekent:

- geen verbod op een eenmalige, plaatsgebonden opmaak;
- geen opdracht om bestaande schermen te migreren. Een scherm migreert
  wanneer er toch aan gewerkt wordt, niet als doel op zich.

---

## 3. Wat er nu in de kit zit

| Component | Bestand | Waarvoor |
|---|---|---|
| `AccountingAmount` | `src/components/platform/AccountingAmount.tsx` | één manier om een bedrag in centen te tonen |
| `AccountingNotice` | `src/components/platform/AccountingNotice.tsx` | informatie, waarschuwing of blokkade |
| `AuditTrailBlock` | `src/components/platform/AuditTrailBlock.tsx` | vastgelegde metadata: datum, reden, bron, verwijzing |
| `ReconciliationBlock` | `src/components/platform/ReconciliationBlock.tsx` | een aansluiting: regels plus uitkomst |
| `FinancialActionDialog` | `src/components/platform/FinancialActionDialog.tsx` | bevestiging van een handeling met boekhoudkundige gevolgen |
| `visibleAuditEntries` | `src/lib/platform/audit-trail.ts` | de regel achter een ontbrekend auditveld |

Alles staat onder test in `src/test/platform-kit.test.tsx`.

---

## 4. Wanneer je ze juist NIET gebruikt

**`AccountingAmount`** — niet voor een aantal, een percentage, een
btw-tarief of een rekeningnummer; die zijn geen geld en hoeven geen
euroteken. Niet wanneer je alleen centen naar tekst wilt: gebruik dan
`formatCents` rechtstreeks. En niet om een teken te laten omklappen — dat
doet de component bewust niet (zie §5).

**`AccountingNotice`** — niet voor een melding die vanzelf verdwijnt; dat is
een toast (`useToast`). Niet als knop of statuslabel; dat is `Badge`. Niet
voor een blokkade die de gebruiker moet bevestigen; dat is
`FinancialActionDialog`.

**`AuditTrailBlock`** — niet voor gegevens die de gebruiker kan wijzigen: dit
is een weergave van wat is vastgelegd, geen formulier. Niet voor een
bedragenoverzicht; dat is `ReconciliationBlock`. En niet om een veld te
"vullen" dat er niet is.

**`ReconciliationBlock`** — niet voor een gewone lijst bedragen zonder
uitkomst; dat is een tabel. Niet wanneer de component zelf zou moeten
uitrekenen wat de uitkomst is: dan hoort die berekening eerst ergens in
`src/lib` thuis, mét eigen test.

**`FinancialActionDialog`** — niet voor een gewone bevestiging zonder
boekhoudkundig gevolg; daar is `AlertDialog` genoeg. Niet als
formulierdialoog voor invoer (een factuur aanmaken); dat is een gewone
`Dialog`. En nooit als plek om de handeling zelf in te zetten (§5).

---

## 5. Boekhoudkundige veiligheid

Vijf regels. Ze gelden voor elke component in deze kit, nu en later, en er
staan tests op.

1. **Een component verzint nooit een financieel gegeven.** Geen bedrag, geen
   datum, geen reden, geen actor. Ontbreekt iets, dan staat er dat het
   ontbreekt, of het staat er niet. Er wordt geen standaardwaarde ingevuld en
   geen ontbrekende datum "vandaag".
2. **Centen, exact, al berekend.** Bedragen komen binnen als hele centen en
   worden alleen opgemaakt. Geen deling, geen optelling, geen afronding, geen
   floats. Wie een som nodig heeft, rekent die uit in `src/lib` — met test —
   en geeft de uitkomst door.
3. **Geen afleiding uit het rekeningnummer.** Nooit debet/credit, activa/
   passiva of een rapportplaats bepalen uit nummer, naam, categorie of een
   nummerreeks. De enige plek die een grootboeksaldo naar een rapportbedrag
   oriënteert is `displayedCents()` in `src/lib/financial-statements.ts`. Er
   komt geen tweede tekenmotor bij.
4. **Geen verborgen keuze van administratie of periode.** Een component kiest
   nooit zelf een `clientId`, een boekjaar of een periode. Die komen van het
   scherm, zodat een paneel nooit stilletjes andere cijfers toont dan het
   rapport eromheen.
5. **Geen schrijfpad in een presentatiecomponent.** Geen Supabase-client,
   geen `useMutation`, geen RPC, geen directe toegang tot `ledger_postings`.
   Een handeling wordt doorgegeven als callback; wát er gebeurt blijft bij de
   beller, inclusief de controles die daarbij horen.

De laatste drie worden per bestand afgedwongen door de statische grenstests
onderaan `src/test/platform-kit.test.tsx`. Komt er ooit een component die een
hook wél nodig heeft, dan is dat een bewuste uitzondering die in de PR wordt
beargumenteerd — niet iets dat stilletjes de grens verschuift.

---

## 6. Gebruik

```tsx
import { AccountingAmount } from "@/components/platform/AccountingAmount";

<td className="px-2 py-1.5 text-right">
  <AccountingAmount cents={line.debitCents} blankWhenZero />
</td>
<AccountingAmount cents={totaalCents} emphasis />
```

```tsx
import { AccountingNotice } from "@/components/platform/AccountingNotice";

<AccountingNotice severity="warning" title="Beginbalans ontbreekt">
  De bedragen blijven zichtbaar; alleen de overloop uit eerdere jaren is nog
  niet vastgesteld.
</AccountingNotice>

// `icon={null}` voor een melding die er in de bestaande app geen had.
<AccountingNotice severity="blocking" icon={null}>…</AccountingNotice>
```

```tsx
import { AuditTrailBlock } from "@/components/platform/AuditTrailBlock";

// Mét fallback: de regel blijft staan en zegt dat er niets is vastgelegd.
// Zónder fallback: de regel verdwijnt. Kies bewust welke van de twee klopt.
<AuditTrailBlock
  fallback="Niet vastgelegd"
  entries={[
    { label: "Datum tegenboeking", value: datum, valueClassName: "font-mono tabular-nums text-foreground" },
    { label: "Reden", value: reden, valueClassName: "break-words text-foreground" },
  ]}
/>
```

```tsx
import { ReconciliationBlock } from "@/components/platform/ReconciliationBlock";

// De beller rekent; het blok toont. `reconciled` is een uitspraak van de
// beller, geen oordeel van het blok.
<ReconciliationBlock
  rows={[
    { label: "Beginsaldo", cents: a.openingCents },
    { label: `Mutaties ${periodLabel}`, cents: a.periodMovementCents },
  ]}
  result={{ label: "Eindsaldo", cents: a.closingCents }}
  reconciled={a.reconciles}
  mismatchNotice={<AccountingNotice severity="blocking">Sluit niet aan.</AccountingNotice>}
/>
```

```tsx
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";

<FinancialActionDialog
  open={open}
  onOpenChange={setOpen}
  title="Tegenboeking maken"
  explanation="De database maakt de tegenboeking en bepaalt de regels."
  consequences={["De originele boeking blijft staan.", "Er komt een nieuwe boeking bij."]}
  confirmLabel="Tegenboeking maken"
  pendingLabel="Bezig met boeken…"
  isPending={reverse.isPending}
  confirmDisabled={!!issue}
  onConfirm={handleConfirm}
>
  {/* datum, reden, voorbeeld — velden van de beller */}
</FinancialActionDialog>
```

`intent="destructive"` geeft de rode knop, en alleen als je erom vraagt.
Boeken is in deze app geen destructieve handeling: een tegenboeking
verwijdert niets, dus die dialoog gebruikt bewust de gewone knop.

---

## 7. Een nieuw onderdeel toevoegen

1. **Toon dat het al bestaat.** Minstens twee plaatsen die het patroon nu
   uitschrijven, of één volgende module die het aantoonbaar nodig heeft.
   Noem de bestanden in de PR.
2. **Kijk eerst bij shadcn.** Bouw geen primitief na dat
   `src/components/ui/` al heeft. Wat er wél mag, is een dunne schil eromheen
   met de betekenis erbij — dat is precies wat `AccountingNotice` doet met
   `Alert`.
3. **Zet er geen boekhouding in.** Rekenregels horen in `src/lib`, met eigen
   test; de component toont de uitkomst.
4. **Migreer minstens één echte aanroeper** in dezelfde PR. Een component
   zonder gebruiker is een gok, en de bestaande tests van die aanroeper zijn
   meteen het bewijs dat er niets veranderd is.
5. **Test het gedrag, niet de opmaak.** Wat mag het nooit doen? Schrijf dáár
   een test op, en controleer met een opzettelijke mutatie dat die test ook
   werkelijk omvalt.
6. **Zet het in §3, §4 en §6** van dit document, en voeg het bestand toe aan
   de grenstests.

---

## 8. Wat bewust nog niet is gebouwd

Deze zijn in de inventarisatie herkend maar niet gebouwd: het patroon is er
wel, maar nog niet stabiel genoeg om vast te leggen, of het raakt te veel
bestaande schermen tegelijk.

| Kandidaat | Waarom nog niet |
|---|---|
| `EntityDetailSheet` | 4 zijpanelen delen de opzet, maar hun koppen en voetteksten verschillen nog te veel |
| `DataTableShell` | ruim 20 tabellen, met echt uiteenlopende omhulsels; eerst de varianten terugbrengen |
| `StatusBadge` | statussen verschillen per domein; een gedeelde kleurtoewijzing zou nu betekenis verzinnen |
| `ModulePageShell` | `PageHeader` dekt het grootste deel al; de rest is per pagina verschillend |
| `PeriodClientToolbar` | raakt de periodekeuze, en die is boekhoudkundig gevoelig — apart en met opzet |
