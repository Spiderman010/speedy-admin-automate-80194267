## Doel

Frontend-only Auth UX-verbeteringen in BoekAssist. Geen database-, RLS-, schema-, auth-settings- of business-logic wijzigingen.

## Branch

`feature/auth-ux-form-and-reset` — afgeleid van `main`. Geen directe commits naar `main`, PR na implementatie.

## Wijzigingen

### 1. `src/pages/Auth.tsx` (refactor)

- Wrap login-tab inhoud in `<form onSubmit={handleLogin}>`; submit-knop krijgt `type="submit"`. `handleLogin` krijgt `e.preventDefault()`.
- Wrap signup-tab inhoud in `<form onSubmit={handleSignUp}>`; idem.
- Beide knoppen blijven `disabled={loading}` zodat dubbele submit niet kan.
- Onder de login-form: tekstknop "Wachtwoord vergeten?" (variant `link`, type `button`) die een nieuwe `view`-state toggelt: `login | forgot`.
- Nieuwe forgot-view binnen dezelfde Card: e-mail input + submit-form. Submit roept:
  ```ts
  supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`
  })
  ```
  Bij success én bij not-found toont neutrale toast:
  > "Als dit e-mailadres bekend is, ontvang je een resetlink."
  Bij netwerk-/onverwachte fout: Dutch error toast met `error.message`.
- "Terug naar inloggen" knop in forgot-view.

### 2. Duplicate-email detectie in `handleSignUp`

```ts
const { data, error } = await supabase.auth.signUp({...});

const DUPLICATE_MSG = "Dit e-mailadres bestaat al. Log in of gebruik 'Wachtwoord vergeten'.";

const isDuplicate =
  (error && /already (registered|exists)|User already registered/i.test(error.message)) ||
  (!error && data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);

if (isDuplicate) {
  toast({ title: "Account bestaat al", description: DUPLICATE_MSG, variant: "destructive" });
} else if (error) {
  toast({ title: "Fout", description: error.message, variant: "destructive" });
} else {
  toast({ title: "Account aangemaakt", description: "Controleer je e-mail om je account te bevestigen." });
}
```

Bestaande "Controleer je e-mail"-toast wordt dus alleen getoond bij een echte nieuwe registratie.

### 3. Nieuwe `src/pages/ResetPassword.tsx` (publieke pagina)

Zelfde shadcn `Card`/`Input`/`Label`/`Button` styling als `Auth.tsx`.

- `<form onSubmit={handleReset}>` met twee password-velden: "Nieuw wachtwoord" en "Bevestig wachtwoord".
- Validatie client-side:
  - min. 6 tekens
  - beide wachtwoorden identiek
  Fouten via destructive toast met Nederlandse tekst.
- Bij submit:
  ```ts
  const { error } = await supabase.auth.updateUser({ password });
  if (error) { toast(...Dutch error...); return; }
  await supabase.auth.signOut();
  toast({ title: "Wachtwoord bijgewerkt", description: "Wachtwoord bijgewerkt. Log opnieuw in." });
  navigate("/auth");
  ```
- Bij mount: check `supabase.auth.getSession()`. Geen sessie → toon Dutch melding ("Geen geldige herstel-sessie...") + knop "Terug naar inloggen" die naar `/auth` navigeert. Form wordt dan verborgen.
- Als `updateUser` faalt met session-related error, idem fallback.

### 4. `src/App.tsx`

- `import ResetPassword from "./pages/ResetPassword";`
- Voeg publieke route toe **vóór** `AuthRoute` en buiten `ProtectedRoutes`:
  ```tsx
  <Route path="/reset-password" element={<ResetPassword />} />
  ```
- `AuthRoute` blijft alleen op `/auth`; geen redirect-logica op `/reset-password`.

## Niet wijzigen

SQL, migraties, RLS, policies, Supabase auth-settings, schema, organizations/user_roles/memberships, app_settings, sales/export/UBL/bank logic, `src/integrations/supabase/types.ts`, `package.json`, lockfiles, sidebar, dashboard, andere pagina's.

## Verificatie

```
npx tsc --noEmit
npm run lint
npx vitest run
```

Daarna browser-test in Lovable preview tegen acceptatiecriteria (login, signup, Enter-submit op beide forms, duplicate-email tekst exact, "Wachtwoord vergeten?" zichtbaar, `/reset-password` publiek bereikbaar, password-validatie, signOut + redirect na succes, geen console errors).

## Output bij afronden

- Branch: `feature/auth-ux-form-and-reset`
- Reviewed files: `AGENTS.md`, `PROJECT_MAP.md`, `src/App.tsx`, `src/pages/Auth.tsx`, `src/hooks/useAuth.tsx`, `src/integrations/supabase/client.ts`, `src/hooks/use-toast.ts`
- Changed files: `src/pages/Auth.tsx`, `src/pages/ResetPassword.tsx` (new), `src/App.tsx`
- Migrations: None
- Bevestiging: geen SQL/RLS/auth-settings/schema/types/sales/bank wijzigingen
- Test results van de drie commando's
- Preview URL + PR link
