// Voert de ECHTE bron van een Supabase Edge Function (supabase/functions/*/index.ts)
// uit in Vitest, zonder Deno en zonder netwerk.
//
// Hoe: de TypeScript-bron wordt uit de repo gelezen, met TypeScript zelf naar
// CommonJS getranspileerd en uitgevoerd met een nep-`require` die de Deno- en
// esm.sh-imports op in-process testdubbels afbeeldt. `Deno.env`, `fetch` en
// `crypto` worden als functie-globals meegegeven, zodat de code onder test
// nooit het echte netwerk raakt. De pure modules naast index.ts (intake-guards,
// chat-guards, ubl-extract) worden ongewijzigd meegeladen.
//
// Gebaseerd op het harnas van de nulmeting (SCRATCH/repro/B2/_edge-harness.ts),
// uitgebreid met rpc-aanroepen (has_min_role, is_organization_member) en de
// lidmaatschapstabel.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as purchaseGuards from "../../../supabase/functions/process-invoice/intake-guards";
import * as salesGuards from "../../../supabase/functions/process-sales-invoice/intake-guards";
import * as chatGuards from "../../../supabase/functions/ai-chat/chat-guards";
import { extractUblInvoice } from "../../../supabase/functions/process-invoice/ubl-extract";

type Dict = Record<string, unknown>;
export type Role = "read_only" | "assistant" | "accountant" | "owner";

const RANK: Record<Role, number> = { read_only: 1, assistant: 2, accountant: 3, owner: 4 };

export function loadModule(relPath: string, requireMap: Dict, globals: Dict): Dict {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  const { outputText: code } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
    fileName: relPath,
  });
  const module = { exports: {} as Dict };
  const req = (spec: string) => {
    if (!(spec in requireMap)) throw new Error(`[edge-harness] onverwachte import ${spec} in ${relPath}`);
    return requireMap[spec];
  };
  const names = Object.keys(globals);
  new Function("require", "module", "exports", ...names, code)(req, module, module.exports, ...names.map((n) => globals[n]));
  return module.exports;
}

export interface Recorded {
  getUserTokens: string[];
  reads: { service: boolean; table: string; filters: [string, unknown][] }[];
  rpcs: { service: boolean; fn: string; args: Dict }[];
  inserts: { service: boolean; table: string; row: Dict }[];
  uploads: { service: boolean; bucket: string; path: string; size: number; contentType?: string }[];
  removes: { service: boolean; bucket: string; paths: string[] }[];
  aiCalls: { url: string; body: any }[];
}

export interface FakeWorld {
  /** De gebruiker die auth.getUser teruggeeft (null = ongeldig token). */
  user: { id: string; email?: string } | null;
  /** Wat de verzoekclient (anon + JWT, dus RLS) voor `clients` ziet. */
  visibleClient: { id: string; organization_id: string | null } | null;
  /** Rol van de gebruiker per organisatie, zoals user_roles × organization_members. */
  roles: Record<string, Role>;
  /** Organisaties waarvan de gebruiker lid is (zonder rol telt ook). */
  memberships: string[];
  /**
   * H-03: na dit aantal has_min_role-aanroepen is de gebruiker zijn rol kwijt
   * (bijvoorbeeld uit de organisatie gezet terwijl de AI-aanroep liep).
   */
  roleLostAfterChecks?: number;
  /** Laat elke rpc een fout teruggeven ("error") of gooien ("throw"). */
  rpcFailure?: "error" | "throw";
  /** Laat de lidmaatschapsquery een fout teruggeven. */
  membershipQueryError?: boolean;
  /** Nep-AI-gateway. */
  ai: { status: number; toolArgs?: Dict | null; text?: string };
  /** Voor de UBL-route: het al geparste XML-object dat parseUblXml zou opleveren. */
  ublParsed?: unknown;
}

export const SERVICE_KEY = "fake-service-role-key";
export const ANON_KEY = "fake-anon-key";

const roleChecks = new WeakMap<FakeWorld, number>();

function rpcResult(world: FakeWorld, fn: string, args: Dict): { data: unknown; error: unknown } {
  if (world.rpcFailure === "error") return { data: null, error: { message: "rpc mislukt" } };
  if (world.rpcFailure === "throw") throw new Error("netwerkfout");
  const userOk = world.user !== null && args._user_id === world.user.id;
  if (fn === "has_min_role") {
    const checks = (roleChecks.get(world) ?? 0) + 1;
    roleChecks.set(world, checks);
    if (world.roleLostAfterChecks !== undefined && checks > world.roleLostAfterChecks) {
      return { data: false, error: null };
    }
    const role = world.roles[String(args._organization_id)];
    const member = world.memberships.includes(String(args._organization_id));
    return { data: Boolean(userOk && role && member && RANK[role] >= RANK[args._min as Role]), error: null };
  }
  if (fn === "is_organization_member") {
    return { data: Boolean(userOk && world.memberships.includes(String(args._organization_id))), error: null };
  }
  return { data: null, error: { message: `onbekende rpc ${fn}` } };
}

export function makeSupabaseFake(world: FakeWorld, rec: Recorded) {
  return (_url: string, key: string) => {
    const service = key === SERVICE_KEY;
    return {
      auth: {
        getUser: async (token: string) => {
          rec.getUserTokens.push(token);
          return world.user
            ? { data: { user: world.user }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } };
        },
      },
      rpc: (fn: string, args: Dict) => {
        rec.rpcs.push({ service, fn, args });
        return {
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
            try {
              return Promise.resolve(rpcResult(world, fn, args)).then(ok, ko);
            } catch (e) {
              return Promise.reject(e).then(ok, ko);
            }
          },
        };
      },
      from: (table: string) => {
        const filters: [string, unknown][] = [];
        let row: Dict | null = null;
        const result = () => {
          if (table === "organization_members") {
            if (world.membershipQueryError) return { data: null, error: { message: "query mislukt" } };
            const userId = filters.find(([c]) => c === "user_id")?.[1];
            const own = world.user && userId === world.user.id ? world.memberships : [];
            return { data: own.map((organization_id) => ({ organization_id })), error: null };
          }
          return { data: null, error: null };
        };
        const b: any = {
          select: () => b,
          eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
          order: () => b,
          limit: () => b,
          maybeSingle: async () => {
            rec.reads.push({ service, table, filters: [...filters] });
            if (table === "clients") return { data: world.visibleClient, error: null };
            return { data: null, error: null };
          },
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
            rec.reads.push({ service, table, filters: [...filters] });
            return Promise.resolve(result()).then(ok, ko);
          },
          insert: (r: Dict) => { row = r; rec.inserts.push({ service, table, row: r }); return b; },
          single: async () => ({ data: { id: "00000000-0000-4000-8000-0000000000aa", ...(row ?? {}) }, error: null }),
        };
        return b;
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, buf: ArrayBuffer, o?: { contentType?: string }) => {
            rec.uploads.push({ service, bucket, path, size: buf.byteLength, contentType: o?.contentType });
            return { error: null };
          },
          remove: async (paths: string[]) => { rec.removes.push({ service, bucket, paths }); return { error: null }; },
        }),
      },
    };
  };
}

export function makeAiFetch(world: FakeWorld, rec: Recorded) {
  return async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("https://ai.gateway.lovable.dev/")) {
      throw new Error(`[edge-harness] onverwachte uitgaande fetch ${url}`);
    }
    rec.aiCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const { status, toolArgs, text } = world.ai;
    const payload = toolArgs !== undefined
      ? { choices: [{ message: { tool_calls: toolArgs === null ? [] : [{ function: { name: "x", arguments: JSON.stringify(toolArgs) } }] } }] }
      : { choices: [{ message: { content: text ?? "" } }] };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (status >= 400 ? `gateway error ${status}` : JSON.stringify(payload)),
    };
  };
}

export function newRecorded(): Recorded {
  return { getUserTokens: [], reads: [], rpcs: [], inserts: [], uploads: [], removes: [], aiCalls: [] };
}

export const DEFAULT_ENV: Record<string, string> = {
  LOVABLE_API_KEY: "fake-lovable-key",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_ANON_KEY: ANON_KEY,
};

export type EdgeFunctionName = "process-invoice" | "process-sales-invoice" | "ai-chat";

/** Laadt een edge function en geeft haar request-handler terug (de functie die aan `serve` gaat). */
export function loadEdgeHandler(
  fn: EdgeFunctionName,
  world: FakeWorld,
  rec: Recorded,
  env: Record<string, string> = DEFAULT_ENV,
) {
  let handler: ((req: any) => Promise<Response>) | null = null;
  const serveMod = { serve: (h: any) => { handler = h; } };
  let uuidCounter = 0;
  const cryptoFake = { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}` };
  const Deno = { env: { get: (k: string) => env[k] } };
  const requireMap: Dict = {
    "https://deno.land/std@0.168.0/http/server.ts": serveMod,
    "https://esm.sh/@supabase/supabase-js@2.49.4": { createClient: makeSupabaseFake(world, rec) },
  };
  if (fn === "process-invoice") {
    requireMap["./intake-guards.ts"] = purchaseGuards;
    // De XML-parser van esm.sh is offline niet beschikbaar; parseUblXml levert
    // hier de ECHTE extractUblInvoice() op een al geparst object.
    requireMap["./ubl-parse.ts"] = {
      UBL_MIME_TYPES: new Set(["application/xml", "text/xml"]),
      UBL_MAX_BYTES: 1_000_000,
      parseUblXml: () => extractUblInvoice(world.ublParsed),
    };
  } else if (fn === "process-sales-invoice") {
    requireMap["./intake-guards.ts"] = salesGuards;
  } else {
    requireMap["./chat-guards.ts"] = chatGuards;
  }
  loadModule(`supabase/functions/${fn}/index.ts`, requireMap, { Deno, fetch: makeAiFetch(world, rec), crypto: cryptoFake });
  if (!handler) throw new Error("serve() is niet aangeroepen");
  return handler as (req: any) => Promise<Response>;
}

export function fakeFile(name: string, type: string, bytes: Uint8Array) {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** Minimale Request-vervanger: de functies gebruiken alleen method, headers.get en formData()/text(). */
export function fakeMultipartRequest(fields: Record<string, unknown>, authorization: string | null = "Bearer user-jwt") {
  return {
    method: "POST",
    headers: new Headers(authorization ? { authorization } : {}),
    formData: async () => ({ get: (k: string) => (k in fields ? fields[k] : null) }),
  };
}

export function fakeJsonRequest(body: unknown, authorization: string | null = "Bearer user-jwt") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    headers: new Headers(authorization ? { authorization } : {}),
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

export const pdfBytes = (n = 2048) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  return b;
};
