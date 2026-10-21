/**
 * De live-laag van src/test/security-backup-and-storage-access.test.ts: wanneer
 * zij mag draaien, tegen welk project, en welke verzoeken zij mag doen
 * (nulmeting E-01 / B2-11).
 *
 * - Standaard staat zij UIT: niet lokaal, niet in CI. `npm run test` maakt geen
 *   verkeer naar een echt project.
 * - Aan alleen met BOEKASSIST_LIVE_SECURITY_TESTS=1 én een expliciete
 *   BOEKASSIST_LIVE_SECURITY_URL en BOEKASSIST_LIVE_SECURITY_ANON_KEY. Zij leest
 *   nooit `.env` of VITE_SUPABASE_* (die zijn in tests bovendien inert).
 * - De URL is precies een projectorigin: `https://<ref>.supabase.co` of een
 *   lokale stack (`http://127.0.0.1:54321`), zonder pad. Een eigen domein of
 *   proxy wordt geweigerd: daarachter is niet vast te stellen of het productie is.
 * - Productie (alxlbdhpbwlehbdbfejw, in de URL of als `ref` in de sleutel) wordt
 *   hard geweigerd, tenzij BOEKASSIST_LIVE_SECURITY_ALLOW_PRODUCTION de
 *   productieref zelf bevat. Ook dan gaat er naar productie NOOIT een upload:
 *   `attemptAnonUpload` weigert dat vóór er een verzoek is.
 * - Een 5xx telt nooit als "geweigerd" (`classifyRefusal`).
 */

export const PRODUCTION_REF = "alxlbdhpbwlehbdbfejw";

export const LIVE_SECURITY_ENV = {
  optIn: "BOEKASSIST_LIVE_SECURITY_TESTS",
  url: "BOEKASSIST_LIVE_SECURITY_URL",
  anonKey: "BOEKASSIST_LIVE_SECURITY_ANON_KEY",
  allowProduction: "BOEKASSIST_LIVE_SECURITY_ALLOW_PRODUCTION",
} as const;

export type LiveSecurityConfig =
  | { status: "off" }
  | { status: "refused"; reason: string }
  | { status: "on"; url: string; anonKey: string; production: boolean; uploadAllowed: boolean };

/** Een Supabase-project (`<ref>.supabase.co`) of een lokale stack. */
const SUPABASE_PROJECT_HOST = /^[a-z0-9]{20}\.supabase\.co$/;
const LOCAL_STACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** De `ref` uit een JWT-sleutel (oude anon/publishable keys), of null. */
export function keyProjectRef(key: string): string | null {
  const payload = key.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json?.ref === "string" ? json.ref : null;
  } catch {
    return null;
  }
}

/** Wijst deze URL of sleutel naar productie? */
export function targetsProduction(url: string, anonKey = ""): boolean {
  return url.toLowerCase().includes(PRODUCTION_REF) || keyProjectRef(anonKey) === PRODUCTION_REF;
}

const refused = (reason: string): LiveSecurityConfig => ({ status: "refused", reason });

export function resolveLiveSecurityConfig(env: Record<string, string | undefined>): LiveSecurityConfig {
  const E = LIVE_SECURITY_ENV;
  if (env[E.optIn] !== "1") return { status: "off" };

  const rawUrl = (env[E.url] ?? "").trim();
  const anonKey = (env[E.anonKey] ?? "").trim();
  if (!rawUrl) {
    return refused(`${E.optIn}=1 vereist een expliciete ${E.url}; de live-laag gebruikt nooit .env of VITE_SUPABASE_URL.`);
  }
  if (!anonKey) {
    return refused(`${E.optIn}=1 vereist ${E.anonKey} (de publishable key van dát project).`);
  }

  // Productie eerst: elke URL of sleutel die productie noemt, valt hier af.
  const production = targetsProduction(rawUrl, anonKey);
  if (production && env[E.allowProduction] !== PRODUCTION_REF) {
    return refused(
      `${rawUrl} is PRODUCTIE (${PRODUCTION_REF}): geweigerd. Richt de live-laag op een preview- of ` +
        `branchproject, of zet bewust ook ${E.allowProduction}=${PRODUCTION_REF}; ook dan wordt er ` +
        "tegen productie nooit geüpload.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refused(`${E.url} is geen geldige URL.`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    return refused(`${E.url} moet een kale projectorigin zijn (bijv. https://<ref>.supabase.co), zonder pad of query.`);
  }
  const host = url.hostname.toLowerCase();
  const supabaseProject = SUPABASE_PROJECT_HOST.test(host) && url.protocol === "https:" && !url.port;
  const localStack = LOCAL_STACK_HOSTS.has(host) && url.protocol === "http:";
  if (!supabaseProject && !localStack) {
    return refused(
      `${E.url} moet https://<ref>.supabase.co of een lokale stack (http://127.0.0.1:54321) zijn; achter een ` +
        "eigen domein of proxy is niet vast te stellen of het productie is.",
    );
  }
  return { status: "on", url: url.origin, anonKey, production, uploadAllowed: !production };
}

/** Gooit als een schrijfpoging naar productie zou gaan. */
export function assertNotProductionWrite(url: string, anonKey = ""): void {
  if (targetsProduction(url, anonKey)) {
    throw new Error(`[live-security] schrijfpoging naar productie geweigerd (${PRODUCTION_REF}): ${url}`);
  }
}

/**
 * De anonieme uploadpoging van de live-laag. Weigert productie vóór er één
 * verzoek is — ook als de configuratie dat ooit ten onrechte zou toelaten.
 */
export async function attemptAnonUpload(
  fetchImpl: typeof fetch,
  baseUrl: string,
  anonKey: string,
  objectPath: string,
): Promise<Response> {
  assertNotProductionWrite(baseUrl, anonKey);
  return fetchImpl(`${baseUrl}/storage/v1/object/invoices/${objectPath}`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "text/plain" },
    body: "x",
  });
}

export type RefusalVerdict = { refused: true } | { refused: false; reason: string };

/**
 * Is dit antwoord een echte weigering? Een 5xx is een storing en bewijst niets
 * over rechten; een 2xx betekent toegang; elke andere status moet expliciet
 * verwacht zijn.
 */
export function classifyRefusal(status: number, allowed: readonly number[]): RefusalVerdict {
  if (status >= 500) return { refused: false, reason: `HTTP ${status} is een storing, geen weigering` };
  if (status >= 200 && status < 300) return { refused: false, reason: `HTTP ${status}: de anonieme gebruiker kreeg toegang` };
  if (!allowed.includes(status)) return { refused: false, reason: `onverwachte status HTTP ${status} (verwacht: ${allowed.join(", ")})` };
  return { refused: true };
}
