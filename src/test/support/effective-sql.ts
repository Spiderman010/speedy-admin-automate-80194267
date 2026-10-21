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

function executable(file: string): string {
  return readFileSync(resolve(process.cwd(), MIGRATIONS, file), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

export function effectiveFunction(fn: string): { file: string; body: string } {
  const files = readdirSync(resolve(process.cwd(), MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = executable(file);
    const start = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    if (start < 0) continue;
    const end = sql.indexOf("\n$$;", start);
    found = { file, body: sql.slice(start, end < 0 ? undefined : end) };
  }
  if (!found) throw new Error(`Geen definitie van public.${fn} gevonden in ${MIGRATIONS}`);
  return found;
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
