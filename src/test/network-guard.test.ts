import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoBlockedNetworkAttempts,
  createNetworkGuard,
  isAllowedTestTarget,
  liveSecurityFetch,
  takeBlockedNetworkAttempts,
} from "@/test/support/network-guard";

/**
 * De netwerkwacht van de suite (src/test/setup.ts → support/network-guard.ts).
 * Nulmeting E-01 / B2-11: een test mag nooit stilletjes het netwerk op.
 *
 * De wacht wordt hier eerst op een nagebouwde omgeving getest (geen enkel echt
 * verzoek), daarna op de echte, geïnstalleerde wacht met adressen die alleen
 * maar geweigerd kunnen worden (`.invalid`). Die opzettelijke pogingen worden in
 * elke test zelf opgeruimd, zodat de afterEach-controle van setup.ts niet afgaat.
 */

const PROD = "https://alxlbdhpbwlehbdbfejw.supabase.co";

describe("isAllowedTestTarget", () => {
  it.each([
    "http://127.0.0.1:54321/rest/v1/clients",
    "http://127.0.0.2/",
    "http://localhost:3000/api",
    "http://[::1]:8080/",
    "ws://127.0.0.1:54321/realtime/v1",
    "data:text/plain,hallo",
    "blob:http://localhost:3000/0000",
  ])("laat loopback en niet-netwerkadressen door: %s", (target) => {
    expect(isAllowedTestTarget(target)).toBe(true);
  });

  it.each([
    `${PROD}/rest/v1/clients`,
    `${PROD}/storage/v1/object/invoices/x.txt`,
    "https://example.com/",
    "wss://alxlbdhpbwlehbdbfejw.supabase.co/realtime/v1",
    "http://10.0.0.1/",
    "http://0.0.0.0/",
    "ftp://127.0.0.1/",
    "geen url",
  ])("weigert al het andere: %s", (target) => {
    expect(isAllowedTestTarget(target)).toBe(false);
  });

  it("een relatief adres telt via de basis van het document (jsdom: localhost)", () => {
    expect(isAllowedTestTarget("/api/x", "http://localhost:3000/")).toBe(true);
    expect(isAllowedTestTarget("/api/x", `${PROD}/`)).toBe(false);
  });
});

function fakeEnv() {
  const fetchCalls: unknown[][] = [];
  class FakeXHR {
    opened: unknown[][] = [];
    open(...args: unknown[]) {
      this.opened.push(args);
    }
  }
  class FakeWebSocket {
    constructor(public url: string) {}
  }
  const env: any = {
    URL,
    location: { href: "http://localhost:3000/" },
    fetch: vi.fn(async (...args: unknown[]) => {
      fetchCalls.push(args);
      return { ok: true, status: 200 };
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
  };
  const nativeFetch = env.fetch;
  const logs: string[] = [];
  const guard = createNetworkGuard(env, { log: (m) => logs.push(m), currentTest: () => "nagebouwde test" });
  return { env, guard, logs, fetchCalls, nativeFetch, FakeWebSocket };
}

describe("createNetworkGuard (nagebouwde omgeving, geen echt verzoek)", () => {
  it("fetch naar productie faalt hard, wordt gelogd en vastgelegd; de echte fetch wordt nooit aangeroepen", async () => {
    const { env, guard, logs, nativeFetch } = fakeEnv();
    await expect(env.fetch(`${PROD}/rest/v1/clients?select=id`)).rejects.toThrow(
      /\[network-guard\] BLOCKED fetch https:\/\/alxlbdhpbwlehbdbfejw\.supabase\.co\/rest\/v1\/clients/,
    );
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("(test: nagebouwde test)");
    expect(guard.take()).toEqual([
      { channel: "fetch", target: `${PROD}/rest/v1/clients?select=id`, test: "nagebouwde test" },
    ]);
    expect(guard.blocked).toHaveLength(0);
  });

  it("ook een upload-POST als Request- of URL-object wordt geweigerd", async () => {
    const { env, guard, nativeFetch } = fakeEnv();
    await expect(env.fetch({ url: `${PROD}/storage/v1/object/invoices/a/regressie.txt` }, { method: "POST", body: "x" })).rejects.toThrow(/BLOCKED fetch/);
    await expect(env.fetch(new URL(`${PROD}/storage/v1/object/list/invoices`))).rejects.toThrow(/BLOCKED fetch/);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(guard.take().map((a) => a.target)).toEqual([
      `${PROD}/storage/v1/object/invoices/a/regressie.txt`,
      `${PROD}/storage/v1/object/list/invoices`,
    ]);
  });

  it("loopback en relatieve adressen gaan ongewijzigd door naar de echte fetch", async () => {
    const { env, guard, fetchCalls } = fakeEnv();
    const init = { method: "GET" };
    await expect(env.fetch("http://127.0.0.1:54321/rest/v1/x", init)).resolves.toEqual({ ok: true, status: 200 });
    await env.fetch("/lokaal");
    expect(fetchCalls).toEqual([["http://127.0.0.1:54321/rest/v1/x", init], ["/lokaal", undefined]]);
    expect(guard.blocked).toHaveLength(0);
  });

  it("XMLHttpRequest.open naar een externe host gooit; naar loopback gaat hij door", () => {
    const { env, guard } = fakeEnv();
    const xhr = new env.XMLHttpRequest();
    expect(() => xhr.open("POST", `${PROD}/storage/v1/object/invoices/x`)).toThrow(/BLOCKED xhr/);
    xhr.open("GET", "http://localhost:3000/ok");
    expect(xhr.opened).toEqual([["GET", "http://localhost:3000/ok"]]);
    expect(guard.take().map((a) => a.channel)).toEqual(["xhr"]);
  });

  it("new WebSocket naar een externe host gooit; naar loopback wordt hij gewoon gebouwd", () => {
    const { env, guard, FakeWebSocket } = fakeEnv();
    expect(() => new env.WebSocket("wss://alxlbdhpbwlehbdbfejw.supabase.co/realtime/v1")).toThrow(/BLOCKED websocket/);
    const ws = new env.WebSocket("ws://127.0.0.1:54321/realtime/v1");
    expect(ws).toBeInstanceOf(FakeWebSocket);
    expect(ws.url).toBe("ws://127.0.0.1:54321/realtime/v1");
    expect(guard.take().map((a) => a.channel)).toEqual(["websocket"]);
  });
});

describe("de geïnstalleerde wacht van de suite", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    // Opzettelijke pogingen van deze tests opruimen vóór de controle van setup.ts.
    takeBlockedNetworkAttempts();
    consoleError.mockClear();
  });

  it("globale fetch naar een externe host faalt hard en wordt gelogd", async () => {
    await expect(fetch("https://boekassist-network-guard.invalid/x")).rejects.toThrow(/\[network-guard\] BLOCKED fetch/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("BLOCKED fetch https://boekassist-network-guard.invalid/x"));
    const attempts = takeBlockedNetworkAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].test).toContain("globale fetch naar een externe host faalt hard");
  });

  it("globale XMLHttpRequest en WebSocket naar een externe host falen hard", () => {
    expect(() => new XMLHttpRequest().open("GET", "https://boekassist-network-guard.invalid/x")).toThrow(/BLOCKED xhr/);
    expect(() => new WebSocket("wss://boekassist-network-guard.invalid/x")).toThrow(/BLOCKED websocket/);
    expect(takeBlockedNetworkAttempts().map((a) => a.channel)).toEqual(["xhr", "websocket"]);
  });

  it("een opgevangen weigering (zoals de oude tryFetch) laat de test tóch falen", async () => {
    const tryFetch = async (url: string) => {
      try {
        return await fetch(url);
      } catch {
        return null;
      }
    };
    expect(await tryFetch("https://boekassist-network-guard.invalid/x")).toBeNull();
    // Dit is precies de controle die setup.ts na elke test doet.
    expect(() => assertNoBlockedNetworkAttempts("in deze test")).toThrow(/1 geweigerde netwerkpoging\(en\) in deze test: fetch https:\/\/boekassist-network-guard\.invalid\/x/);
    expect(() => assertNoBlockedNetworkAttempts("in deze test")).not.toThrow();
  });

  it("de ongeguarde fetch is er alleen met de expliciete live-opt-in, en alleen voor één origin", async () => {
    const project = "https://abcdefghijklmnopqrst.supabase.co";
    expect(() => liveSecurityFetch(project, {})).toThrow(/BOEKASSIST_LIVE_SECURITY_TESTS=1/);
    expect(() => liveSecurityFetch(project, { BOEKASSIST_LIVE_SECURITY_TESTS: "true" })).toThrow(/BOEKASSIST_LIVE_SECURITY_TESTS=1/);
    const scoped = liveSecurityFetch(project, { BOEKASSIST_LIVE_SECURITY_TESTS: "1" });
    expect(typeof scoped).toBe("function");
    // Een ander adres wordt geweigerd vóór er een verzoek is — ook een subdomein-truc.
    for (const target of [`${PROD}/rest/v1/clients`, "https://abcdefghijklmnopqrst.supabase.co.invalid/x", "http://abcdefghijklmnopqrst.supabase.co/x"]) {
      await expect(scoped(target), target).rejects.toThrow(/valt buiten het opgegeven project/);
    }
    // De omzeiling gaat langs de wacht, dus er is ook niets geweigerd of gelogd.
    expect(takeBlockedNetworkAttempts()).toEqual([]);
  });
});
