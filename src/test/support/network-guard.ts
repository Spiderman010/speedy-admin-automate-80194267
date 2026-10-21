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
 * BEKENDE GRENS
 * Directe `node:http`/`node:https`/`node:net`-verbindingen worden niet
 * onderschept; geen test gebruikt ze (nulmeting E §5). Draai de suite lokaal
 * daarom ook zonder netwerk (`unshare -rn`, zie AGENTS.md).
 */

export type NetworkChannel = "fetch" | "xhr" | "websocket";

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
  };
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
