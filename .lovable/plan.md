## Cleanup-migration (data-only) — niet toepassen zonder akkoord

**Bestandsnaam (voorstel):**
`supabase/migrations/<UTC-timestamp>_cleanup-rls-team-test-data.sql`

**Scope:** alleen DELETEs. Geen schema/RLS/policy/frontend wijzigingen. `auth.users` blijft ongemoeid.

### Opmerking vooraf (gevonden bij verificatie)

De 2 test-vraagposten hebben verschillende `organization_id`:

| id | organization_id | toelichting |
|---|---|---|
| `617805b3-e19b-469c-a5c0-5dc9d53e26ba` | `5faf7b16-…` (owner-org) | expliciet meegegeven |
| `9abe6b35-7133-4a81-be30-a6ae97486354` | `3fdc1925-65ad-40bf-9725-5c1f229649c4` | trigger zette nbsafety1's eigen `default_organization_id` |

Beide horen tot de test en worden via hun `id` verwijderd. Geen issue voor cleanup, maar gerapporteerd voor transparantie.

### Exacte cleanup-SQL

```sql
-- Data-only cleanup van RLS team-access test.
-- Geen schema/RLS/policy wijzigingen. auth.users blijft ongemoeid.
-- rollback: niet automatisch — testdata wordt definitief verwijderd.

BEGIN;

-- 1) Test-vraagposten
DELETE FROM public.vraagposten
WHERE id IN (
  '617805b3-e19b-469c-a5c0-5dc9d53e26ba',
  '9abe6b35-7133-4a81-be30-a6ae97486354'
);

-- 2) Test user_role (assistant in owner-org)
DELETE FROM public.user_roles
WHERE user_id        = '1a50b2fc-8a73-4ce1-8b89-6e7d893da529'
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706'
  AND role            = 'assistant';

-- 3) Test-membership in owner-org
DELETE FROM public.organization_members
WHERE user_id        = '1a50b2fc-8a73-4ce1-8b89-6e7d893da529'
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706';

COMMIT;
```

### Verificatiequeries (na toepassen handmatig draaien)

```sql
-- A) Test-vraagposten weg → verwacht 0
SELECT count(*) AS remaining_test_vraagposten
FROM public.vraagposten
WHERE id IN (
  '617805b3-e19b-469c-a5c0-5dc9d53e26ba',
  '9abe6b35-7133-4a81-be30-a6ae97486354'
);

-- B) Test user_role weg → verwacht 0
SELECT count(*) AS remaining_test_user_role
FROM public.user_roles
WHERE user_id        = '1a50b2fc-8a73-4ce1-8b89-6e7d893da529'
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706'
  AND role            = 'assistant';

-- C) Test-membership weg → verwacht 0
SELECT count(*) AS remaining_test_membership
FROM public.organization_members
WHERE user_id        = '1a50b2fc-8a73-4ce1-8b89-6e7d893da529'
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706';

-- D) auth.users record bestaat nog → verwacht 1
SELECT count(*) AS auth_user_still_present
FROM auth.users
WHERE id = '1a50b2fc-8a73-4ce1-8b89-6e7d893da529';

-- E) org_members_* policies nog 48 → verwacht 48
SELECT count(*) AS org_members_policies
FROM pg_policies
WHERE schemaname = 'public' AND policyname LIKE 'org_members_%';
```

### Niet in scope

- auth.users verwijderen
- schema / RLS / policies / triggers wijzigen
- frontend / types / app_settings / sales / UBL / bank logica

Wacht op akkoord vóór ik de migration aanmaak en laat uitvoeren.
