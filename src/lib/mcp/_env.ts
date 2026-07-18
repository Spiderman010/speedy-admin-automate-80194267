// Env accessor that works both at Vite build-time (manifest extract, no Deno)
// and at Deno runtime inside the Supabase Edge Function.
// Supabase Edge Runtime does not populate `process.env`; use Deno.env.get first.
export function getEnv(name: string): string {
  const d = (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } }).Deno;
  const v = d?.env?.get?.(name) ?? (typeof process !== "undefined" ? process.env?.[name] : undefined);
  return v ?? "";
}
