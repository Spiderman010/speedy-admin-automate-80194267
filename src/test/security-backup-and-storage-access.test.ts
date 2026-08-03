import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regressietests voor de security-fix:
 *  - backup-tabellen zijn niet leesbaar voor onbevoegden (anon geen rechten,
 *    authenticated alleen org-gescoped, schrijven volledig geblokkeerd)
 *  - storage bucket 'invoices': alleen eigen map of factuur van eigen organisatie
 *
 * Laag 1: statische controle op de migratie (draait altijd, ook offline).
 * Laag 2: live controle met de anon-sleutel (wordt overgeslagen zonder netwerk).
 */

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260802201226_e883539d-0b35-403e-ac56-2ad7e955bc7c.sql",
  ),
  "utf-8",
);

const BACKUP_TABLES = [
  "grootboekrekeningen_backup_20260420",
  "bank_tx_grootboek_backup_20260420",
] as const;

describe("backup-tabellen: onbevoegden kunnen niet lezen of schrijven", () => {
  it.each(BACKUP_TABLES)("%s heeft RLS aan", (table) => {
    expect(migrationSql).toContain(
      `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
    );
  });

  it.each(BACKUP_TABLES)("%s trekt schrijfrechten in voor anon en authenticated", (table) => {
    expect(migrationSql).toContain(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.${table} FROM anon, authenticated;`,
    );
  });

  it.each(BACKUP_TABLES)("%s geeft anon geen enkel recht", (table) => {
    expect(migrationSql).toContain(`REVOKE ALL ON public.${table} FROM anon;`);
    expect(migrationSql).not.toContain(`GRANT SELECT ON public.${table} TO anon`);
  });

  it.each(BACKUP_TABLES)("%s geeft alleen SELECT aan authenticated", (table) => {
    expect(migrationSql).toContain(`GRANT SELECT ON public.${table} TO authenticated;`);
    expect(migrationSql).not.toContain(`GRANT ALL ON public.${table} TO authenticated`);
  });

  it("leespolicies zijn org-gescoped via is_organization_member en alleen voor SELECT", () => {
    const readPolicies = [
      "grootboek_backup_org_members_can_read",
      "bank_tx_backup_org_members_can_read",
    ];
    for (const policy of readPolicies) {
      const start = migrationSql.indexOf(`CREATE POLICY "${policy}"`);
      expect(start).toBeGreaterThan(-1);
      const body = migrationSql.slice(start, migrationSql.indexOf(");", start));
      expect(body).toContain("FOR SELECT");
      expect(body).toContain("TO authenticated");
      expect(body).toContain("public.is_organization_member(auth.uid()");
      expect(body).toContain("organization_id IS NOT NULL");
    }
  });

  it("bevat geen schrijfpolicies op de backup-tabellen", () => {
    for (const table of BACKUP_TABLES) {
      const idx = migrationSql.indexOf(`ON public.${table}\nFOR INSERT`);
      expect(idx).toBe(-1);
      expect(migrationSql).not.toContain(`ON public.${table}\nFOR UPDATE`);
      expect(migrationSql).not.toContain(`ON public.${table}\nFOR DELETE`);
    }
  });
});

describe("storage 'invoices': alleen eigen map of eigen organisatie", () => {
  const policyBody = (name: string) => {
    const start = migrationSql.indexOf(`CREATE POLICY "${name}"`);
    expect(start).toBeGreaterThan(-1);
    const end = migrationSql.indexOf("CREATE POLICY", start + 1);
    return migrationSql.slice(start, end === -1 ? undefined : end);
  };

  it("oude, overlappende policies zijn verwijderd", () => {
    for (const old of [
      "Users can view own invoice files",
      "Users can view own invoices",
      "invoices_org_members_can_read",
      "invoices_org_members_can_read_sales",
      "Users can upload invoice files",
      "Users can upload own invoices",
      "Users can delete own invoice files",
    ]) {
      expect(migrationSql).toContain(`DROP POLICY IF EXISTS "${old}" ON storage.objects;`);
    }
  });

  it("lezen: eigen map of organisatielid van de gekoppelde factuur", () => {
    const body = policyBody("invoices_read_own_folder_or_org_member");
    expect(body).toContain("FOR SELECT");
    expect(body).toContain("TO authenticated");
    expect(body).toContain("bucket_id = 'invoices'");
    expect(body).toContain("(auth.uid())::text = (storage.foldername(name))[1]");
    expect(body).toContain("FROM public.purchase_invoices pi");
    expect(body).toContain("pi.file_path = storage.objects.name");
    expect(body).toContain("FROM public.sales_invoices si");
    expect(body).toContain("si.pdf_path = storage.objects.name");
    expect(body.match(/public\.is_organization_member\(auth\.uid\(\)/g)).toHaveLength(2);
    expect(body).not.toContain("TO anon");
  });

  it("uploaden en verwijderen blijven strikt beperkt tot de eigen map", () => {
    for (const name of ["invoices_upload_own_folder", "invoices_delete_own_folder"]) {
      const body = policyBody(name);
      expect(body).toContain("TO authenticated");
      expect(body).toContain("bucket_id = 'invoices'");
      expect(body).toContain("(auth.uid())::text = (storage.foldername(name))[1]");
      expect(body).not.toContain("is_organization_member");
    }
  });
});

// ---------------------------------------------------------------------------
// Laag 2: live regressie met de anon-sleutel (geen sessie = onbevoegde gebruiker)
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? "https://alxlbdhpbwlehbdbfejw.supabase.co";
const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

/** Geeft null terug als het netwerk niet beschikbaar is, zodat offline runs niet falen. */
async function tryFetch(input: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
}

const live = Boolean(ANON_KEY);

describe.skipIf(!live)("live: anonieme gebruiker heeft geen toegang", () => {
  const restGet = (table: string) =>
    tryFetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });

  it.each(BACKUP_TABLES)("kan %s niet lezen", async (table) => {
    const res = await restGet(table);
    if (!res) return;
    expect(res.ok).toBe(false);
    expect([401, 403, 404]).toContain(res.status);
  });

  it("kan geen bestanden in de invoices-bucket opsommen", async () => {
    const res = await tryFetch(`${SUPABASE_URL}/storage/v1/object/list/invoices`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix: "", limit: 1 }),
    });
    if (!res) return;
    const rows = res.ok ? await res.json() : [];
    expect(Array.isArray(rows) ? rows.length : 0).toBe(0);
  });

  it("kan geen bestand uit een andere map downloaden", async () => {
    const res = await tryFetch(
      `${SUPABASE_URL}/storage/v1/object/invoices/00000000-0000-0000-0000-000000000000/test.pdf`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } },
    );
    if (!res) return;
    expect(res.ok).toBe(false);
  });

  it("kan niet uploaden naar de invoices-bucket", async () => {
    const res = await tryFetch(
      `${SUPABASE_URL}/storage/v1/object/invoices/00000000-0000-0000-0000-000000000000/regressie.txt`,
      {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          "Content-Type": "text/plain",
        },
        body: "x",
      },
    );
    if (!res) return;
    expect(res.ok).toBe(false);
  });
});
