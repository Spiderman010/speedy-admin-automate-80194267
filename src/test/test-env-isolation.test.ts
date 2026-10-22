import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nulmeting E-01 / B2-11 — de testomgeving raakt nooit een echt Supabase-project.
 *
 * De getrackte `.env` bevat de productie-URL en de publishable key, en Vitest
 * laadt die in `import.meta.env`. Voorheen kreeg elke lokale `npm run test` daardoor
 * de productiewaarden; `vitest.config.ts` (`test.env`) overschrijft ze nu in elke
 * testworker. Deze test bewijst dat met de getrackte `.env` op zijn plek, zonder
 * dat de shell iets overschrijft (en ook als de shell iets anders zet).
 */

const PRODUCTION_REF = "alxlbdhpbwlehbdbfejw";
const INERT_KEY = "ci-inert-not-a-real-supabase-key";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

describe("testomgeving: Supabase is inert", () => {
  it("import.meta.env wijst naar loopback, met een inerte sleutel", () => {
    expect(LOOPBACK).toContain(new URL(String(import.meta.env.VITE_SUPABASE_URL)).hostname);
    expect(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY).toBe(INERT_KEY);
    expect(import.meta.env.VITE_SUPABASE_ANON_KEY).toBe(INERT_KEY);
    expect(String(import.meta.env.VITE_SUPABASE_PROJECT_ID)).not.toContain(PRODUCTION_REF);
  });

  it("process.env ook, en geen enkele VITE_-Supabase-variabele noemt productie", () => {
    expect(LOOPBACK).toContain(new URL(String(process.env.VITE_SUPABASE_URL)).hostname);
    expect(process.env.VITE_SUPABASE_PUBLISHABLE_KEY).toBe(INERT_KEY);
    // VITE_* is wat Vite uit `.env` laadt en wat de app leest (import.meta.env).
    const supabaseVars = Object.keys(process.env).filter((k) => /^VITE_.*SUPABASE/i.test(k));
    expect(supabaseVars.length).toBeGreaterThan(0);
    for (const key of supabaseVars) {
      expect(String(process.env[key]).includes(PRODUCTION_REF), key).toBe(false);
      expect(/\.supabase\.co\b/.test(String(process.env[key])), key).toBe(false);
    }
  });

  it("de waarden uit de getrackte .env komen niet in de tests terecht", (ctx) => {
    const path = resolve(process.cwd(), ".env");
    if (!existsSync(path)) return ctx.skip(".env ontbreekt hier (bijv. gequarantaineerd in CI)");
    const fromFile = new Map<string, string>();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
      if (m && m[2]) fromFile.set(m[1], m[2]);
    }
    const checked = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PROJECT_ID"].filter((k) => fromFile.has(k));
    expect(checked.length).toBeGreaterThan(0);
    for (const key of checked) {
      // Alleen een boolean: de waarde zelf komt nooit in de testuitvoer.
      expect(import.meta.env[key] === fromFile.get(key), `${key} komt uit .env`).toBe(false);
      expect(process.env[key] === fromFile.get(key), `${key} komt uit .env`).toBe(false);
    }
  });

  it("de Supabase-client van de app wordt met de inerte URL gebouwd", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const client = supabase as unknown as { supabaseUrl: string; storageUrl: URL; authUrl: URL };
    expect(new URL(client.supabaseUrl).hostname).toBe("127.0.0.1");
    expect(client.storageUrl.hostname).toBe("127.0.0.1");
    expect(client.authUrl.hostname).toBe("127.0.0.1");
  });
});
