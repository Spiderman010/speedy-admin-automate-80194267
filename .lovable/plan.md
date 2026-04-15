

## Bankafschriften upgrade: saldo, sortering, duplicaatdetectie

### Wat wordt aangepast

Drie bestanden, geen database-migraties, alleen de Bankafschriften-flow.

### Stap 1: Parser uitbreiden (`src/lib/bank-statement-parser.ts`)

**Nieuwe types en functies toevoegen:**

- `ParsedStatement { openingBalance: number | null, closingBalance: number | null, transactions: ParsedTransaction[] }`
- `DuplicateInfo { isDuplicate: boolean, reason: "reference" | "composite" | null }`
- `parseBankStatementFull(content): ParsedStatement` — nieuwe functie die saldo's extraheert
- `detectDuplicates(incoming, existing): DuplicateInfo[]` — duplicaatdetectie

**Bestaande `parseBankStatement()` blijft exact ongewijzigd.**

**MT940 saldo-extractie:** `:60F:` en `:62F:` tags parsen (C/D + YYMMDD + EUR + bedrag met komma).

**CAMT.053 saldo-extractie:** `<Bal>` elementen met `<Cd>OPBD</Cd>` / `<Cd>CLBD</Cd>`.

**Sortering:** transacties sorteren op `date` string descending (YYYY-MM-DD ISO-formaat, geen locale-afhankelijke parsing).

**Duplicaatdetectie logica:**
- Stap 1: reference match (non-empty, trimmed)
- Stap 2 fallback: composite key = `date|amount.toFixed(2)|description.trim().toLowerCase().slice(0,50)|counterAccount`
- Retourneert per rij of het een duplicaat is en waarom

### Stap 2: Upload-dialog aanpassen (`src/components/BankStatementUploadDialog.tsx`)

- Nieuw prop: `existingTransactions` (optioneel, array van bestaande banktransacties)
- Na file parse: `parseBankStatementFull()` aanroepen, saldo's + duplicaat-info opslaan in state
- **Saldo-weergave:** beginsaldo en eindsaldo boven transactietabel
- **Saldo-controle:** `Math.abs(opening + sum(amounts) - closing) <= 0.01` → groen vinkje, anders rode waarschuwing
- **Duplicaat-markering:** badge per rij met reden ("TransactionID" of "datum/bedrag/omschrijving")
- **Checkbox-kolom:** duplicaten standaard uit, overige standaard aan
- **Import-knop:** toont aantal geselecteerde rijen, importeert alleen aangevinkte

### Stap 3: Bank-pagina aanpassen (`src/pages/Bank.tsx`)

- `transactions` doorgeven als `existingTransactions` prop aan `BankStatementUploadDialog`

### Niet gewijzigd

Dashboard, Klanten, Inkoop/Verkoopfacturen, sidebar, routing, styling, andere parsers/utilities.

