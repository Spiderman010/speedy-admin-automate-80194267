import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";

/**
 * Importvingerafdruk (migratie 20261020120000) — de app-kant.
 *
 * Deploy-volgorde: deze app kan in productie staan vóórdat de migratie is
 * toegepast. PostgREST weigert dan het hele INSERT-verzoek zodra het een
 * onbekende kolom noemt. Daarom vraagt de import eerst of de kolom bestaat en
 * stuurt hij de vingerafdruk alleen dan mee; zonder kolom werkt de import
 * precies zoals vóór deze migratie.
 *
 * TIJDELIJKE SHIM: `types.ts` kent `import_fingerprint` pas na regeneratie uit
 * het productieschema (nooit met de hand). Tot dan voegt `withImportFingerprint`
 * de kolommen toe met een smalle cast, uitsluitend voor `import_fingerprint`,
 * `import_source` en `bank_reference`. Verwijderen
 * in een kleine vervolg-PR zodra de types zijn bijgewerkt.
 */

export const IMPORT_FINGERPRINT_INDEX = "bank_transactions_client_import_fingerprint_key";

let supportedCache: boolean | null = null;

/** Of de database de kolom kent. Ja wordt onthouden; nee wordt bij de volgende import opnieuw gevraagd. */
export async function importFingerprintSupported(): Promise<boolean> {
  if (supportedCache) return true;
  const probe = supabase.from("bank_transactions") as unknown as {
    select: (columns: string) => { limit: (n: number) => Promise<{ error: { code?: string; message?: string } | null }> };
  };
  const { error } = await probe.select("import_fingerprint,import_source,bank_reference").limit(1);
  if (!error) {
    supportedCache = true;
    return true;
  }
  // 42703: kolom bestaat (nog) niet. Iets anders: onbekend — de aanroeper beslist.
  if (error.code === "42703" || /import_(fingerprint|source)|bank_reference/.test(error.message ?? "")) return false;
  throw new Error(error.message || "Kon niet bepalen of dubbele imports server-side worden geweigerd.");
}

/** Alleen voor tests. */
export function resetImportFingerprintSupportForTests() {
  supportedCache = null;
}

export function withImportFingerprint<T extends Partial<TablesInsert<"bank_transactions">>>(
  row: T,
  fingerprint: string | null | undefined,
  source?: "mt940" | "camt053" | null,
  bankReference?: string | null,
): T {
  const reference = bankReference?.trim() || null;
  if (!fingerprint && !source && !reference) return row;
  return {
    ...row,
    ...(fingerprint ? { import_fingerprint: fingerprint } : {}),
    ...(source ? { import_source: source } : {}),
    ...(reference ? { bank_reference: reference } : {}),
  } as T;
}

/** Een weigering door de unieke index: deze regel staat er al (bijvoorbeeld door een gelijktijdige import). */
export function isImportFingerprintConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string; details?: string } | null;
  if (!e || e.code !== "23505") return false;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return text.includes(IMPORT_FINGERPRINT_INDEX) || text.includes("import_fingerprint");
}
