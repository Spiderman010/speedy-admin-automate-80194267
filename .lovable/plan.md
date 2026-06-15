# Plan: Fix herkenningsregel creatie in Instellingen

## Context
Uit de read-only diagnose: `HerkenningsregelsTab` in `Instellingen.tsx` leest templates org-scoped, maar `handleSave` stuurt bij het aanmaken van een nieuwe regel geen `organization_id` mee. Multi-org gebruikers (Naim, nbsafety1) krijgen daardoor ofwel een stille RLS-fout, ofwel een record dat op de verkeerde (default) organisatie terechtkomt en onzichtbaar wordt.

## Te wijzigen bestanden

### 1. `src/pages/Instellingen.tsx` (regel 324–333)

- `handleSave` aanpassen:
  1. **Guard**: als `activeOrganizationId` ontbreekt → `toast` met variant `destructive` en early return.
  2. **Create pad**: voeg `organization_id: activeOrganizationId` toe aan het payload voor `addMut.mutate(...)`.
  3. **Update pad**: geen `organization_id` wijzigen; alleen `onError`-toast toevoegen.
  4. **Error handling**: `onError`-callback toevoegen aan zowel `addMut.mutate` als `updateMut.mutate` met `variant: "destructive"`.

### 2. `src/hooks/useBookingTemplates.ts` (optioneel, type-correctheid)

- `BookingTemplate`-interface uitbreiden met `organization_id?: string | null;`. Dit is puur TypeScript-declaratief; runtime verandert niets omdat de insert al `as any` doet.

## Niet te wijzigen
- Database schema, migraties, RLS, triggers, Supabase types.
- Andere pagina’s, hooks, of export-logica.

## Verificatie na wijziging
1. `npx tsc --noEmit`
2. `npm run lint`
3. `npm run test`
4. Handmatige test via preview: Instellingen → herkenningsregel aanmaken → controleer org-scoping.