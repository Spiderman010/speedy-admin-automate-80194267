import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Codex #299 (tweede bevinding): de per-rij-compare-and-set van de
 * exportmarkering gaat als `or=(and(id.eq.…,updated_at.eq.…),…)` in de URL.
 * Hier bouwt de ECHTE supabase-js-client die URL; alleen `fetch` is vervangen
 * (er gaat niets het netwerk op). Gemeten wordt de volledige URL met een host
 * van productielengte, uuid-id's en tijdstempels met microseconden en '+00:00'.
 */

const h = vi.hoisted(() => ({ urls: [] as string[], methods: [] as string[] }));

vi.mock("@/integrations/supabase/client", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    h.urls.push(url);
    h.methods.push(String(init?.method ?? "GET"));
    // RETURNING: alle gevraagde id's uit `id=in.(…)`.
    const inList = new URL(url).searchParams.get("id") ?? "";
    const ids = inList.replace(/^in\.\(/, "").replace(/\)$/, "").split(",").filter(Boolean).map((v) => v.replace(/^"|"$/g, ""));
    return new Response(JSON.stringify(ids.map((id) => ({ id }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Host van dezelfde lengte als de productie-ref (20 tekens), maar .invalid: nooit bereikbaar.
  return {
    supabase: createClient("https://aaaaaaaaaaaaaaaaaaaa.supabase.invalid", "ci-inert-not-a-real-supabase-key", {
      global: { fetch: fakeFetch as typeof fetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});

import { markPurchaseInvoicesExported, STATUS_UPDATE_CAS_BATCH_SIZE } from "@/hooks/usePurchaseInvoices";

const uuid = (i: number) => `${String(i).padStart(8, "0")}-1111-4222-8333-${String(i).padStart(12, "0")}`;
// Langste vorm die PostgREST teruggeeft: microseconden en een expliciete offset.
const ts = (i: number) => `2026-10-20T08:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1_000_000).padStart(6, "0")}+00:00`;

beforeEach(() => {
  h.urls.length = 0;
  h.methods.length = 0;
});

describe("exportmarkering — per-rij-CAS in begrensde verzoeken (Codex #299)", () => {
  it("2300 facturen met elk een eigen updated_at: ceil(2300/N) PATCH-verzoeken, elke URL < 8 KB", async () => {
    const ids = Array.from({ length: 2300 }, (_, i) => uuid(i));
    const read = new Map(ids.map((id, i) => [id, ts(i)]));
    await markPurchaseInvoicesExported({ organizationId: uuid(900001), clientId: uuid(900002), invoiceIds: ids, fetchedUpdatedAt: read });
    expect(h.methods.every((m) => m === "PATCH")).toBe(true);
    expect(h.urls.length).toBe(Math.ceil(2300 / STATUS_UPDATE_CAS_BATCH_SIZE));
    const longest = Math.max(...h.urls.map((u) => u.length));
    // Meetwaarde voor het rapport.
    console.info(`N=${STATUS_UPDATE_CAS_BATCH_SIZE}: langste URL ${longest} tekens, ${h.urls.length} verzoeken`);
    expect(longest).toBeLessThan(8000);
  });

  it("een tijdstempel met microseconden en '+00:00' gaat exact (gequote, '+' als %2B) mee in het paar", async () => {
    const id = uuid(7);
    const t = "2026-10-20T08:00:00.123456+00:00";
    await markPurchaseInvoicesExported({ organizationId: uuid(1), clientId: uuid(2), invoiceIds: [id], fetchedUpdatedAt: new Map([[id, t]]) });
    const [url] = h.urls;
    expect(url).toContain("%2B00%3A00"); // geen kale '+', die PostgREST als spatie zou lezen
    expect(url).not.toMatch(/\+00/);
    const or = new URL(url).searchParams.get("or");
    expect(or).toBe(`(and(id.eq."${id}",updated_at.eq."${t}"))`);
    expect(new URL(url).searchParams.get("status")).toBe("in.(gecontroleerd,betaald)");
  });
});
