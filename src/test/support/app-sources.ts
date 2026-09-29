import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * De uitvoerbare app-code (src/ zonder tests en zonder de gegenereerde types,
 * plus de edge functions), met commentaar weggehaald: een bewering over de
 * CODE mag nooit op proza slagen.
 *
 * Bedoeld voor BLIJVENDE invarianten ("de app schrijft X nooit zelf"), in
 * plaats van eenmalige branch-uitspraken ("deze branch raakt src/ niet") die
 * elke latere, terechte wijziging laten omvallen — zie branch-sql-scope.ts.
 */
export function appSourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path === "src/test") continue;
      out.push(...appSourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && path !== "src/integrations/supabase/types.ts") {
      out.push(path);
    }
  }
  return out;
}

export function appCode(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** Alle app-bestanden (src + edge functions) waarvan de code aan `pattern` voldoet. */
export function appFilesMatching(pattern: RegExp): string[] {
  return [...appSourceFiles("src"), ...appSourceFiles("supabase/functions")].filter((f) => pattern.test(appCode(f)));
}
