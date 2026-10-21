/**
 * Netwerkwacht voor de hele testsuite (nulmeting E-01 / B2-11).
 *
 * WAAROM DIT BESTAAT
 * De getrackte `.env` bevat de productie-URL en -sleutel, en een lokale
 * `npm run test` deed daardoor live verzoeken naar productie, inclusief een
 * uploadpoging naar de storage-bucket. `vitest.config.ts` maakt de
 * Supabase-omgeving nu inert; deze wacht is de tweede laag: geen enkele test
 * mag nog stilletjes het netwerk op.
 *
 * WAT HIJ DOET
 * - `fetch`, `XMLHttpRequest` en `WebSocket` naar een host die geen loopback
 *   is, falen hard met een duidelijke fout (`[network-guard] BLOCKED …`).
 * - Elke geweigerde poging wordt gelogd en vastgelegd; `src/test/setup.ts`
 *   laat de test daarna alsnog falen — ook als de code onder test de fout zelf
 *   opvangt, zoals de oude `tryFetch` in de securitytest deed (vals groen).
 * - Loopback (`localhost`, `127.0.0.0/8`, `::1`) en `data:`/`blob:` blijven
 *   toegestaan: de inerte Supabase-URL van de tests is `http://127.0.0.1:54321`.
 *
 * DE ENIGE UITZONDERING
 * De expliciet aangezette live-laag van
 * `src/test/security-backup-and-storage-access.test.ts` haalt met
 * `liveSecurityFetch(origin)` de oorspronkelijke `fetch` op, en dan alleen voor
 * die ene, expliciet opgegeven projectorigin. Dat lukt alleen met
 * `BOEKASSIST_LIVE_SECURITY_TESTS=1`; zonder die opt-in gooit de functie.
 *
 * NODE-SOCKETS (review H-1)
 * Ook `net.Socket.prototype.connect` wordt bewaakt. Daarlangs lopen
 * `node:http`, `node:https`, `node:tls` en undici: een TCP-verbinding naar een
 * host die geen loopback is, krijgt een `[network-guard] BLOCKED socket`-fout
 * (asynchroon, als een gewone verbindingsfout) en wordt gelogd en vastgelegd.
 * Unix-sockets (`path`) en loopback blijven toegestaan.
 */

import net from "node:net";

export type NetworkChannel = "fetch" | "xhr" | "websocket" | "socket";

export interface BlockedNetworkAttempt {
  channel: NetworkChannel;
  target: string;
  test: string | undefined;
}

export interface NetworkGuard {
  /** De geweigerde pogingen sinds de laatste `take()`. */
  readonly blocked: readonly BlockedNetworkAttempt[];
  /** Geeft de geweigerde pogingen terug en maakt de lijst leeg. */
  take(): BlockedNetworkAttempt[];
  /** De `fetch` van vóór de installatie (alleen voor de opt-in live-laag). */
  readonly nativeFetch: typeof fetch | undefined;
  /** Legt een geweigerde poging vast en logt haar; geeft de melding terug. */
  record(channel: NetworkChannel, target: string): string;
}

export interface NetworkGuardOptions {
  log: (message: string) => void;
  currentTest?: () => string | undefined;
}

export const LIVE_SECURITY_OPT_IN = "BOEKASSIST_LIVE_SECURITY_TESTS";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Mag een test dit adres benaderen? Alleen loopback (en `data:`/`blob:`, die
 * nooit het netwerk op gaan). Een adres dat niet te ontleden is, mag niet.
 */
export function isAllowedTestTarget(target: string, base?: string, UrlCtor: typeof URL = URL): boolean {
  let url: URL;
  try {
    url = new UrlCtor(target, base);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function targetOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") {
    return (input as { url: string }).url; // Request
  }
  return String(input); // URL en al het andere
}

/**
 * Installeert de wacht op `env` (in de suite: `globalThis`). Exporteerbaar met
 * een eigen `env` zodat de wacht zelf getest kan worden zonder netwerk.
 */
export function createNetworkGuard(env: any, options: NetworkGuardOptions): NetworkGuard {
  const NativeURL: typeof URL = env.URL ?? URL;
  const blocked: BlockedNetworkAttempt[] = [];
  const base = (): string | undefined => {
    const href = env.location?.href;
    return typeof href === "string" ? href : undefined;
  };

  const check = (channel: NetworkChannel, input: unknown): void => {
    const target = targetOf(input);
    if (isAllowedTestTarget(target, base(), NativeURL)) return;
    const test = options.currentTest?.();
    blocked.push({ channel, target, test });
    const message =
      `[network-guard] BLOCKED ${channel} ${target}${test ? ` (test: ${test})` : ""} — ` +
      "tests draaien offline; alleen loopback is toegestaan (zie src/test/support/network-guard.ts)";
    options.log(message);
    throw new Error(message);
  };

  const nativeFetch: typeof fetch | undefined = typeof env.fetch === "function" ? env.fetch : undefined;
  if (nativeFetch) {
    env.fetch = function guardedFetch(input: unknown, init?: unknown) {
      try {
        check("fetch", input);
      } catch (error) {
        return Promise.reject(error);
      }
      return Reflect.apply(nativeFetch, env, [input, init]);
    };
  }

  const xhrProto = env.XMLHttpRequest?.prototype;
  if (xhrProto && typeof xhrProto.open === "function") {
    const nativeOpen = xhrProto.open;
    xhrProto.open = function guardedOpen(this: unknown, method: string, url: unknown, ...rest: unknown[]) {
      check("xhr", url);
      return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    };
  }

  if (typeof env.WebSocket === "function") {
    env.WebSocket = new Proxy(env.WebSocket, {
      construct(target, args, newTarget) {
        check("websocket", args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  return {
    blocked,
    take: () => blocked.splice(0, blocked.length),
    nativeFetch,
    record: (channel: NetworkChannel, target: string) => {
      const test = options.currentTest?.();
      blocked.push({ channel, target, test });
      const message =
        `[network-guard] BLOCKED ${channel} ${target}${test ? ` (test: ${test})` : ""} — ` +
        "tests draaien offline; alleen loopback is toegestaan (zie src/test/support/network-guard.ts)";
      options.log(message);
      return message;
    },
  };
}

/** Het doel van `socket.connect(...)`: null voor een Unix-socket (`path`). */
export function socketConnectTarget(args: unknown[]): { host: string; port: string } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // interne aanroep met normalizedArgs
  if (first && typeof first === "object") {
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === "string" && o.path) return null;
    return { host: typeof o.host === "string" && o.host ? o.host : "localhost", port: String(o.port ?? "") };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null; // pad
  const host = typeof args[1] === "string" && args[1] ? (args[1] as string) : "localhost";
  return { host, port: String(first ?? "") };
}

/** Hosts die de live-laag (liveSecurityFetch) bewust mag bereiken. */
const liveAllowedHosts = new Set<string>();

/**
 * Bewaakt `SocketCtor.prototype.connect` (standaard `net.Socket`). Exporteerbaar
 * met een eigen klasse, zodat de wacht zelf getest kan worden.
 */
export function guardSocketConnect(
  SocketCtor: { prototype: { connect: (...args: any[]) => unknown } },
  record: (channel: NetworkChannel, target: string) => string,
): void {
  const proto = SocketCtor.prototype as { connect: (...args: any[]) => unknown; __networkGuard?: boolean; destroy?: (e: Error) => void };
  if (proto.__networkGuard) return;
  const nativeConnect = proto.connect;
  proto.connect = function guardedConnect(this: any, ...args: unknown[]) {
    const t = socketConnectTarget(args);
    if (t) {
      const host = t.host.replace(/^\[|\]$/g, "").toLowerCase();
      const urlHost = host.includes(":") ? `[${host}]` : host;
      if (!isAllowedTestTarget(`http://${urlHost}/`) && !liveAllowedHosts.has(host)) {
        const message = record("socket", `${urlHost}:${t.port}`);
        const error = new Error(message);
        process.nextTick(() => (typeof this.destroy === "function" ? this.destroy(error) : undefined));
        return this;
      }
    }
    return Reflect.apply(nativeConnect, this, args);
  };
  Object.defineProperty(proto, "__networkGuard", { value: true });
}

// ── De ene wacht van de suite ────────────────────────────────────────────────

const GLOBAL_KEY = Symbol.for("boekassist.test.networkGuard");

function installed(): NetworkGuard | undefined {
  return (globalThis as Record<symbol, NetworkGuard | undefined>)[GLOBAL_KEY];
}

/** Idempotent: installeert de wacht één keer op `globalThis` (src/test/setup.ts). */
export function installNetworkGuard(options: Partial<NetworkGuardOptions> = {}): NetworkGuard {
  const existing = installed();
  if (existing) return existing;
  const guard = createNetworkGuard(globalThis, {
    log: options.log ?? ((message) => console.error(message)),
    currentTest: options.currentTest,
  });
  (globalThis as Record<symbol, NetworkGuard | undefined>)[GLOBAL_KEY] = guard;
  guardSocketConnect(net.Socket, guard.record);
  return guard;
}

/** De geweigerde pogingen sinds de vorige aanroep (en de lijst weer leeg). */
export function takeBlockedNetworkAttempts(): BlockedNetworkAttempt[] {
  return installed()?.take() ?? [];
}

/** Gooit als er sinds de vorige controle een netwerkpoging is geweigerd. */
export function assertNoBlockedNetworkAttempts(where: string): void {
  const attempts = takeBlockedNetworkAttempts();
  if (attempts.length === 0) return;
  const list = attempts.map((a) => `${a.channel} ${a.target}`).join(", ");
  throw new Error(
    `[network-guard] ${attempts.length} geweigerde netwerkpoging(en) ${where}: ${list}. ` +
      "Tests mogen het netwerk niet op; mock de datalaag of gebruik een loopback-adres.",
  );
}

/**
 * De oorspronkelijke `fetch`, uitsluitend voor de expliciet aangezette live-laag
 * van de securitytest, en alleen naar `allowedOrigin` (het project uit
 * BOEKASSIST_LIVE_SECURITY_URL): elk ander adres wordt geweigerd vóór er een
 * verzoek is. Zonder `BOEKASSIST_LIVE_SECURITY_TESTS=1` gooit deze functie.
 */
export function liveSecurityFetch(
  allowedOrigin: string,
  env: Record<string, string | undefined> = process.env,
): typeof fetch {
  if (env[LIVE_SECURITY_OPT_IN] !== "1") {
    throw new Error(`[network-guard] de ongeguarde fetch is alleen beschikbaar met ${LIVE_SECURITY_OPT_IN}=1`);
  }
  const origin = new URL(allowedOrigin).origin;
  // Native fetch (undici) gaat via net.Socket: alleen dit ene project mag erdoor.
  liveAllowedHosts.add(new URL(allowedOrigin).hostname.replace(/^\[|\]$/g, "").toLowerCase());
  const guard = installed();
  const native = guard ? guard.nativeFetch : globalThis.fetch;
  if (!native) throw new Error("[network-guard] er is geen fetch beschikbaar");
  return (input, init) => {
    const target = targetOf(input);
    let sameOrigin = false;
    try {
      sameOrigin = new URL(target).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return Promise.reject(new Error(`[network-guard] live-laag: ${target} valt buiten het opgegeven project ${origin}`));
    }
    return Reflect.apply(native, globalThis, [input, init]);
  };
}
