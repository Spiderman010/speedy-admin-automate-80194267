import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { liveSecurityFetch } from "@/test/support/network-guard";
import {
  LIVE_SECURITY_ENV,
  PRODUCTION_REF,
  assertNotProductionWrite,
  attemptAnonUpload,
  classifyRefusal,
  resolveLiveSecurityConfig,
  type LiveSecurityConfig,
} from "@/test/support/live-security";

/**
 * Regressietests voor de security-fix:
 *  - backup-tabellen zijn niet leesbaar voor onbevoegden (anon geen rechten,
 *    authenticated alleen org-gescoped, schrijven volledig geblokkeerd)
 *  - storage bucket 'invoices': alleen eigen map of factuur van eigen organisatie
 *
 * Laag 1: statische controle op de migratie (draait altijd, ook offline).
 * Laag 2: live controle met de anon-sleutel — ALLEEN met een expliciete opt-in
 *         en nooit stilzwijgend tegen productie (zie support/live-security.ts).
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
//
// Standaard UIT. Alleen met een expliciete opt-in, tegen een expliciet opgegeven
// project (nulmeting E-01 / B2-11):
//   BOEKASSIST_LIVE_SECURITY_TESTS=1
//   BOEKASSIST_LIVE_SECURITY_URL=https://<preview-ref>.supabase.co   (of http://127.0.0.1:54321)
//   BOEKASSIST_LIVE_SECURITY_ANON_KEY=<publishable key van dát project>
// De uploadpoging (een schrijfactie) draait alleen met ook
//   BOEKASSIST_LIVE_SECURITY_ALLOW_UPLOAD=1
// Productie wordt hard geweigerd, tenzij ook
//   BOEKASSIST_LIVE_SECURITY_ALLOW_PRODUCTION=alxlbdhpbwlehbdbfejw
// is gezet; ook dan doet deze laag tegen productie geen upload. De laag leest
// nooit `.env` of VITE_SUPABASE_*, en omzeilt de netwerkwacht alleen voor dat
// ene project. Zonder netwerk wordt een test zichtbaar OVERGESLAGEN (nooit stil
// groen), en een 5xx telt nooit als weigering.
// ---------------------------------------------------------------------------

const live = resolveLiveSecurityConfig(process.env);

describe.runIf(live.status === "refused")("live: geweigerde configuratie", () => {
  it("de live-laag weigert hard, zonder één verzoek", () => {
    throw new Error(live.status === "refused" ? live.reason : "onbereikbaar");
  });
});

describe.runIf(live.status === "on")("live: anonieme gebruiker heeft geen toegang", () => {
  // Ook bij een overgeslagen describe verzamelt Vitest de tests: niets hier
  // mag zonder opt-in een verzoek doen of de wacht omzeilen.
  const cfg = live as Extract<LiveSecurityConfig, { status: "on" }>;
  const headers = () => ({ apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` });
  const offline = (what: string) => `${what}: ${cfg.url} niet bereikbaar (netwerkfout) — overgeslagen, niet geslaagd`;

  /** null = netwerkfout; de aanroeper slaat de test dan expliciet over. */
  async function tryLive(input: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await liveSecurityFetch(cfg.url)(input, init);
    } catch {
      return null;
    }
  }

  for (const table of BACKUP_TABLES) {
    it(`kan ${table} niet lezen`, async (ctx) => {
      const res = await tryLive(`${cfg.url}/rest/v1/${table}?select=id&limit=1`, { headers: headers() });
      if (!res) return ctx.skip(offline(`REST ${table}`));
      expect(classifyRefusal(res.status, [401, 403, 404]), `REST ${table}`).toEqual({ refused: true });
    });
  }

  it("kan geen bestanden in de invoices-bucket opsommen", async (ctx) => {
    const res = await tryLive(`${cfg.url}/storage/v1/object/list/invoices`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 1 }),
    });
    if (!res) return ctx.skip(offline("storage list"));
    expect(res.status, `storage list: HTTP ${res.status} is een storing, geen weigering`).toBeLessThan(500);
    if (res.ok) {
      // Een private bucket mag anoniem een lege lijst geven — maar nooit een bestand.
      const rows = await res.json();
      expect(Array.isArray(rows), "storage list: onverwacht antwoord").toBe(true);
      expect(rows, "storage list: de anonieme gebruiker ziet bestanden").toHaveLength(0);
    } else {
      expect(classifyRefusal(res.status, [400, 401, 403, 404]), "storage list").toEqual({ refused: true });
    }
  });

  it("kan geen bestand uit een andere map downloaden", async (ctx) => {
    const res = await tryLive(
      `${cfg.url}/storage/v1/object/invoices/00000000-0000-0000-0000-000000000000/test.pdf`,
      { headers: headers() },
    );
    if (!res) return ctx.skip(offline("storage download"));
    expect(classifyRefusal(res.status, [400, 401, 403, 404]), "storage download").toEqual({ refused: true });
  });

  it("kan niet uploaden naar de invoices-bucket (nooit tegen productie)", async (ctx) => {
    if (!cfg.uploadAllowed) return ctx.skip("upload-poging alleen met BOEKASSIST_LIVE_SECURITY_ALLOW_UPLOAD=1, en nooit tegen productie");
    assertNotProductionWrite(cfg.url, cfg.anonKey);
    const objectPath = `00000000-0000-0000-0000-000000000000/regressie-${Date.now()}.txt`;
    let res: Response | null;
    try {
      res = await attemptAnonUpload(liveSecurityFetch(cfg.url), cfg.url, cfg.anonKey, objectPath);
    } catch {
      res = null;
    }
    if (!res) return ctx.skip(offline("storage upload"));
    if (res.ok) {
      // Regressie: ruim het bestand meteen op (best effort) en faal daarna.
      await tryLive(`${cfg.url}/storage/v1/object/invoices/${objectPath}`, { method: "DELETE", headers: headers() });
    }
    expect(classifyRefusal(res.status, [400, 401, 403]), "storage upload").toEqual({ refused: true });
  });
});

// ---------------------------------------------------------------------------
// De veiligheidsregels van laag 2 zelf — offline, zonder één verzoek.
// ---------------------------------------------------------------------------

describe("live-laag: opt-in, productieweigering en uitslag (offline)", () => {
  const PREVIEW = "https://abcdefghijklmnopqrst.supabase.co";
  const PROD_URL = `https://${PRODUCTION_REF}.supabase.co`;
  const jwt = (payload: Record<string, unknown>) =>
    ["eyJhbGciOiJIUzI1NiJ9", btoa(JSON.stringify(payload)).replace(/=+$/, ""), "sig"].join(".");
  const PROD_KEY = jwt({ iss: "supabase", ref: PRODUCTION_REF, role: "anon" });
  const PREVIEW_KEY = jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "anon" });
  const E = LIVE_SECURITY_ENV;
  const on = (extra: Record<string, string>) => ({ [E.optIn]: "1", ...extra });

  it("zonder opt-in staat de laag uit — ook als .env/VITE_SUPABASE_* naar productie wijst", () => {
    expect(resolveLiveSecurityConfig({})).toEqual({ status: "off" });
    expect(resolveLiveSecurityConfig({ VITE_SUPABASE_URL: PROD_URL, VITE_SUPABASE_PUBLISHABLE_KEY: PROD_KEY })).toEqual({ status: "off" });
    expect(resolveLiveSecurityConfig({ [E.optIn]: "true", [E.url]: PREVIEW, [E.anonKey]: PREVIEW_KEY })).toEqual({ status: "off" });
    // De suite zelf draait zonder opt-in: deze run doet geen enkel live-verzoek.
    expect(live.status === "off" || process.env[E.optIn] === "1").toBe(true);
  });

  it("opt-in zonder expliciete URL of sleutel wordt geweigerd; .env telt niet mee", () => {
    const zonderUrl = resolveLiveSecurityConfig(on({ VITE_SUPABASE_URL: PREVIEW, [E.anonKey]: PREVIEW_KEY }));
    expect(zonderUrl.status).toBe("refused");
    expect(zonderUrl).toMatchObject({ reason: expect.stringContaining(E.url) });
    const zonderSleutel = resolveLiveSecurityConfig(on({ [E.url]: PREVIEW, VITE_SUPABASE_PUBLISHABLE_KEY: PREVIEW_KEY }));
    expect(zonderSleutel).toMatchObject({ status: "refused", reason: expect.stringContaining(E.anonKey) });
    expect(resolveLiveSecurityConfig(on({ [E.url]: "geen url", [E.anonKey]: PREVIEW_KEY })).status).toBe("refused");
    expect(resolveLiveSecurityConfig(on({ [E.url]: "ftp://example.com", [E.anonKey]: PREVIEW_KEY })).status).toBe("refused");
  });

  it("productie wordt hard geweigerd: in de URL (ook in hoofdletters of met pad) én via de sleutel", () => {
    for (const url of [PROD_URL, `${PROD_URL}/`, PROD_URL.toUpperCase(), `${PROD_URL}/rest/v1`]) {
      expect(resolveLiveSecurityConfig(on({ [E.url]: url, [E.anonKey]: PREVIEW_KEY })), url).toMatchObject({
        status: "refused",
        reason: expect.stringContaining("PRODUCTIE"),
      });
    }
    // Een eigen domein of proxy vóór productie: de sleutel verraadt het project.
    expect(resolveLiveSecurityConfig(on({ [E.url]: "https://api.example.com", [E.anonKey]: PROD_KEY }))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("PRODUCTIE"),
    });
  });

  it("alleen een kale projectorigin: https://<ref>.supabase.co of een lokale stack", () => {
    // Achter een eigen domein of proxy (en een sleutel zonder ref) is productie niet uit te sluiten.
    for (const url of [
      "https://api.example.com",
      "https://abcdefghijklmnopqrst.supabase.co.example.com",
      "http://abcdefghijklmnopqrst.supabase.co",
      "https://abcdefghijklmnopqrst.supabase.co:8443",
      `${PREVIEW}/rest/v1`,
      `${PREVIEW}/?x=1`,
      "https://user:geheim@abcdefghijklmnopqrst.supabase.co",
      "https://10.0.0.5",
    ]) {
      expect(resolveLiveSecurityConfig(on({ [E.url]: url, [E.anonKey]: "sb_publishable_zonder_ref" })), url).toMatchObject({ status: "refused" });
    }
    expect(resolveLiveSecurityConfig(on({ [E.url]: "http://127.0.0.1:54321", [E.anonKey]: "lokale-sleutel" }))).toEqual({
      status: "on",
      url: "http://127.0.0.1:54321",
      anonKey: "lokale-sleutel",
      production: false,
      uploadAllowed: false,
    });
  });

  it("de tweede opt-in moet de productieref zelf zijn — en ook dan geen upload", () => {
    expect(resolveLiveSecurityConfig(on({ [E.url]: PROD_URL, [E.anonKey]: PROD_KEY, [E.allowProduction]: "1" })).status).toBe("refused");
    expect(resolveLiveSecurityConfig(on({ [E.url]: PROD_URL, [E.anonKey]: PROD_KEY, [E.allowProduction]: "true" })).status).toBe("refused");
    expect(resolveLiveSecurityConfig(on({ [E.url]: PROD_URL, [E.anonKey]: PROD_KEY, [E.allowProduction]: PRODUCTION_REF }))).toEqual({
      status: "on",
      url: PROD_URL,
      anonKey: PROD_KEY,
      production: true,
      uploadAllowed: false,
    });
  });

  it("de uploadpoging vereist een eigen opt-in (ALLOW_UPLOAD=1), en nooit tegen productie (review H-4)", () => {
    // Zonder upload-opt-in: lezen mag, schrijven niet — ook niet op loopback (een tunnel kan productie zijn).
    for (const url of [`${PREVIEW}/`, "http://127.0.0.1:54321"]) {
      expect(resolveLiveSecurityConfig(on({ [E.url]: url, [E.anonKey]: "sb_publishable_zonder_ref" })), url).toMatchObject({ status: "on", uploadAllowed: false });
      expect(resolveLiveSecurityConfig(on({ [E.url]: url, [E.anonKey]: "sb_publishable_zonder_ref", [E.allowUpload]: "true" })), url).toMatchObject({ uploadAllowed: false });
    }
    expect(resolveLiveSecurityConfig(on({ [E.url]: `${PREVIEW}/`, [E.anonKey]: PREVIEW_KEY, [E.allowUpload]: "1" }))).toEqual({
      status: "on",
      url: PREVIEW,
      anonKey: PREVIEW_KEY,
      production: false,
      uploadAllowed: true,
    });
    // Productie met beide productie-opt-ins én de upload-opt-in: nog steeds geen upload.
    expect(
      resolveLiveSecurityConfig(on({ [E.url]: PROD_URL, [E.anonKey]: PROD_KEY, [E.allowProduction]: PRODUCTION_REF, [E.allowUpload]: "1" })),
    ).toMatchObject({ status: "on", production: true, uploadAllowed: false });
  });

  it("de uploadfunctie weigert productie vóór er één verzoek de deur uit gaat", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(attemptAnonUpload(fetchImpl as unknown as typeof fetch, PROD_URL, PREVIEW_KEY, "a/b.txt")).rejects.toThrow(/productie/);
    await expect(attemptAnonUpload(fetchImpl as unknown as typeof fetch, PREVIEW, PROD_KEY, "a/b.txt")).rejects.toThrow(/productie/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await attemptAnonUpload(fetchImpl as unknown as typeof fetch, PREVIEW, PREVIEW_KEY, "a/b.txt");
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PREVIEW}/storage/v1/object/invoices/a/b.txt`,
      expect.objectContaining({ method: "POST", body: "x" }),
    );
  });

  it("een 5xx is nooit een weigering, een 2xx is toegang, en alleen verwachte statussen tellen", () => {
    expect(classifyRefusal(500, [400, 401, 403, 404])).toEqual({ refused: false, reason: expect.stringContaining("storing") });
    expect(classifyRefusal(503, [400, 401, 403, 404])).toMatchObject({ refused: false });
    expect(classifyRefusal(200, [400, 401, 403, 404])).toEqual({ refused: false, reason: expect.stringContaining("toegang") });
    expect(classifyRefusal(409, [400, 401, 403, 404])).toEqual({ refused: false, reason: expect.stringContaining("onverwachte status") });
    expect(classifyRefusal(403, [400, 401, 403, 404])).toEqual({ refused: true });
    expect(classifyRefusal(404, [401, 403, 404])).toEqual({ refused: true });
  });

  it("de ongeguarde fetch: alleen met de opt-in, en alleen naar het opgegeven project", async () => {
    expect(() => liveSecurityFetch(PREVIEW, {})).toThrow(/BOEKASSIST_LIVE_SECURITY_TESTS=1/);
    const scoped = liveSecurityFetch(PREVIEW, { [E.optIn]: "1" });
    // Elk ander adres wordt geweigerd vóór er een verzoek is (geen netwerkfout, maar deze melding).
    await expect(scoped("https://boekassist-network-guard.invalid/x")).rejects.toThrow(/valt buiten het opgegeven project/);
    await expect(scoped(`${PROD_URL}/rest/v1/clients`)).rejects.toThrow(/valt buiten het opgegeven project/);
  });
});
