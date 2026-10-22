import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * De EFFECTIEVE definitie van een databasefunctie: het lichaam uit de LAATSTE
 * migratie (op tijdstempel) die haar met CREATE OR REPLACE definieert.
 *
 * WAAROM DIT BESTAAT (nulmeting E-04)
 * Statische tests lazen de migratie waarin een schrijver ooit ontstond. Werd
 * die schrijver later herdefinieerd (PR D, PR H), dan bleven zij iets beweren
 * wat niet meer gold — bijvoorbeeld dat een afgesloten boekjaar wordt
 * geweigerd, terwijl sinds 20261002120000 alleen de boekingsblokkade dat doet.
 * Wie iets over het huidige gedrag zegt, leest de laatste definitie.
 *
 * Commentaarregels zijn weggelaten: een bewering over CODE mag nooit op proza
 * slagen. Het gedrag zelf staat in de harnassen onder supabase/tests/.
 */

const MIGRATIONS = "supabase/migrations";

function executable(dir: string, file: string): string {
  return readFileSync(resolve(dir, file), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `public.<fn>` in elke schrijfwijze: hoofdletters, witruimte, aanhalingstekens. */
function qualifiedName(fn: string): string {
  return `(?:"?public"?\\s*\\.\\s*)"?${escapeRegex(fn)}"?`;
}

/**
 * Review H-4: robuust tegen afwijkende SQL-vormen. Zoekt hoofdletterongevoelig
 * `CREATE [OR REPLACE] FUNCTION public.<fn>(`, leest het lichaam tot het
 * SLUITENDE dollar-tag van die definitie (welk tag ook), en weigert luid:
 *   - als het einde van het lichaam niet te vinden is (anders zou de rest van
 *     het bestand stil als lichaam gelden);
 *   - als NA de laatste definitie een DROP FUNCTION of ALTER FUNCTION … RENAME
 *     van dezelfde functie staat (dan is die definitie niet meer effectief).
 */
export function effectiveFunction(fn: string, dir: string = resolve(process.cwd(), MIGRATIONS)): { file: string; body: string } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const create = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qualifiedName(fn)}\\s*\\(`, "gi");
  const removal = new RegExp(
    `(?:DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${qualifiedName(fn)}\\b|ALTER\\s+FUNCTION\\s+${qualifiedName(fn)}\\s*(?:\\([^)]*\\))?\\s*RENAME\\b)`,
    "gi",
  );
  let found: { file: string; body: string; at: number } | null = null;
  const removals: { file: string; at: number }[] = [];
  for (const file of files) {
    const sql = executable(dir, file);
    for (const m of sql.matchAll(create)) found = { file, body: "", at: m.index ?? 0 };
    if (found?.file === file) {
      const start = found.at;
      const open = /AS\s+(\$[A-Za-z_0-9]*\$)/i.exec(sql.slice(start));
      if (!open) throw new Error(`Geen lichaam (AS $tag$) gevonden voor public.${fn} in ${file}`);
      const bodyStart = start + open.index + open[0].length;
      const end = sql.indexOf(open[1], bodyStart);
      if (end < 0) throw new Error(`Einde van het lichaam van public.${fn} (${open[1]}) niet gevonden in ${file}`);
      found.body = sql.slice(start, end);
    }
    for (const m of sql.matchAll(removal)) removals.push({ file, at: m.index ?? 0 });
  }
  if (!found) throw new Error(`Geen definitie van public.${fn} gevonden in ${MIGRATIONS}`);
  const last = found;
  const later = removals.find((r) => r.file > last.file || (r.file === last.file && r.at > last.at));
  if (later) throw new Error(`public.${fn} wordt na ${last.file} nog verwijderd of hernoemd (${later.file}); de definitie is niet effectief`);
  return { file: last.file, body: last.body };
}

/**
 * De afsprakenset van PR H voor een gedateerde schrijver, op zijn effectieve
 * definitie: géén weigering op het jaarwatermerk meer, wél de boekingsblokkade
 * op de eigen gezaghebbende datum, vóór de eerste grootboekregel.
 */
export function postingGuardOf(fn: string, assertCall: string) {
  const { file, body } = effectiveFunction(fn);
  const lock = body.indexOf(assertCall);
  const firstLedgerInsert = body.indexOf("INSERT INTO public.ledger_postings");
  return {
    file,
    watermarkRefusal: /afgesloten_boekjaar\s+IS NOT NULL AND|<=\s*v_client\.afgesloten_boekjaar|Boekjaar % is afgesloten voor deze administratie/.test(body),
    lockCalled: lock >= 0,
    lockBeforeLedger: lock >= 0 && firstLedgerInsert > lock,
  };
}
