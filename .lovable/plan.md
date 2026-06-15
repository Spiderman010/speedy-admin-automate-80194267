# Respect klant-BTW op inkoopfacturen

Branch: `feature/respect-client-btw-type-on-purchase-invoices`

## Scope
Alleen `src/components/InvoiceEditDialog.tsx`. `Facturen.tsx` geeft `client` al door (regel 891), dus daar is geen wijziging nodig. Geen migraties, geen edits aan `types.ts`, geen wijzigingen aan Verkoop, Bank of Snelstart-export.

## Wijzigingen in `src/components/InvoiceEditDialog.tsx`

1. **Afleiden van setting** (boven de hooks waar nodig):
   ```ts
   const clientBtwType = (client as any)?.btw_type ?? (client?.btw_vrijgesteld ? "vrijgesteld" : "plichtig");
   const isBtwVrijgesteld = clientBtwType === "vrijgesteld";
   ```
   Fallback op legacy `btw_vrijgesteld` voor robuustheid; geen extra fetch nodig.

2. **Init-effect (regel 223–248) — header BTW**:
   Als `isBtwVrijgesteld`: forceer `setBtwEnabled(false)`, `btw_percentage: "0"`, `btw_amount: "0"`, ongeacht OCR/invoice waarden. Overige velden ongewijzigd.

3. **Lines-effect (regel 427–437)**:
   Bij mappen van `existingLines`: als `isBtwVrijgesteld`, map `btw_percentage` → `0` (i.p.v. originele waarde).

4. **`addLine` (regel 439)**:
   Default `btw_percentage`: `isBtwVrijgesteld ? 0 : 21`.

5. **UI — header BTW-blok (regel 738–769)**:
   - Disable de `Switch` "BTW toepassen" wanneer `isBtwVrijgesteld` (en houd `checked={false}`).
   - Disable de BTW% `Select` en het `btw_amount` `Input` (regel 733).
   - Toon onder het blok een kleine hint:
     ```tsx
     {isBtwVrijgesteld && (
       <p className="text-xs text-muted-foreground">
         Klant is BTW-vrijgesteld: BTW wordt op 0 gezet.
       </p>
     )}
     ```

6. **UI — per-line BTW% Select (regel 815–825)**:
   Disable de `Select` wanneer `isBtwVrijgesteld`; `value` blijft `"0"`.

7. **`buildUpdates` (regel 485–506)**:
   Als `isBtwVrijgesteld`: forceer `btw_percentage: 0`, `btw_amount: 0` (overschrijft `form`-waarden), zodat onSave/onApprove correct doorspoelen.

8. **`persistLines` (regel 508–518)**:
   Als `isBtwVrijgesteld`: map elke regel `btw_percentage` → `0` bij persist.

Voor `btw_type === "mix"` of `"plichtig"`: geen gedragsverandering.

## Wat we NIET wijzigen
- Geen wijziging aan `Facturen.tsx` (al wired).
- Geen wijziging aan OCR edge functions — OCR mag z'n waarde leveren, de dialog overschrijft hem client-side voor vrijgestelde klanten.
- Geen `types.ts`, geen migratie, geen RLS/policies, geen bank/verkoop/snelstart code.

## Verificatie
```
npx tsc --noEmit
npm run lint
npm run test
```

Handmatig:
- Klant `vrijgesteld` → open inkoopfactuur → BTW% staat op 0, BTW-bedrag 0, switch + selects disabled, hint zichtbaar; opslaan/goedkeuren persisteert 0.
- Klant `plichtig` → ongewijzigd gedrag (Switch, 0/9/21%, OCR-waarden behouden).
- Klant `mix` → ongewijzigd gedrag (handmatig per regel).

## Deliverables
Reviewed files, Changed files (1: `InvoiceEditDialog.tsx`), Migrations: None, test/build output, PR link, bevestiging dat purchase invoices nu `clients.btw_type` respecteren.
