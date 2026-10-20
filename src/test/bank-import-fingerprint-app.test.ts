import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importvingerafdruk — de app-kant: alleen meesturen als de kolom bestaat
 * (deploy-volgorde), een weigering door de unieke index herkennen, en de
 * tijdelijke shim die alleen deze ene kolom toevoegt.
 */

const probe: { error: { code?: string; message?: string } | null } = { error: null };
const selects: string[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: (columns: string) => {
        selects.push(columns);
        return { limit: () => Promise.resolve({ error: probe.error }) };
      },
    }),
  },
}));

import {
  IMPORT_FINGERPRINT_INDEX,
  importFingerprintSupported,
  isImportFingerprintConflict,
  resetImportFingerprintSupportForTests,
  withImportFingerprint,
} from "@/hooks/bankImportFingerprint";

beforeEach(() => {
  probe.error = null;
  selects.length = 0;
  resetImportFingerprintSupportForTests();
});

describe("importFingerprintSupported", () => {
  it("kolom bestaat ⇒ ja, en dat wordt onthouden", async () => {
    expect(await importFingerprintSupported()).toBe(true);
    expect(await importFingerprintSupported()).toBe(true);
    expect(selects).toEqual(["import_fingerprint,import_source,bank_reference"]);
  });

  it("migratie nog niet toegepast (42703) ⇒ nee, zonder fout; de volgende import vraagt opnieuw", async () => {
    probe.error = { code: "42703", message: "column bank_transactions.import_fingerprint does not exist" };
    expect(await importFingerprintSupported()).toBe(false);
    probe.error = null;
    expect(await importFingerprintSupported()).toBe(true);
  });

  it("de kolom bank_reference ontbreekt ⇒ nee: alle drie of geen", async () => {
    probe.error = { message: "column bank_transactions.bank_reference does not exist" };
    expect(await importFingerprintSupported()).toBe(false);
  });

  it("een andere fout ⇒ werpt (de import stopt, fail-closed)", async () => {
    probe.error = { code: "PGRST301", message: "JWT expired" };
    await expect(importFingerprintSupported()).rejects.toThrow(/JWT expired/);
  });
});

describe("isImportFingerprintConflict", () => {
  it("alleen 23505 van deze index of kolom", () => {
    expect(isImportFingerprintConflict({ code: "23505", message: `duplicate key value violates unique constraint "${IMPORT_FINGERPRINT_INDEX}"` })).toBe(true);
    expect(isImportFingerprintConflict({ code: "23505", details: "Key (client_id, import_fingerprint)=(…) already exists." })).toBe(true);
    expect(isImportFingerprintConflict({ code: "23505", message: 'duplicate key value violates unique constraint "bank_transactions_pkey"' })).toBe(false);
    expect(isImportFingerprintConflict({ code: "42501", message: IMPORT_FINGERPRINT_INDEX })).toBe(false);
    expect(isImportFingerprintConflict(null)).toBe(false);
  });
});

describe("withImportFingerprint (tijdelijke shim)", () => {
  it("voegt alleen deze kolom toe, en alleen met een waarde", () => {
    const row = { client_id: "c", amount: -1, transaction_date: "2026-10-02" };
    expect(withImportFingerprint(row, "a".repeat(64))).toEqual({ ...row, import_fingerprint: "a".repeat(64) });
    expect(withImportFingerprint(row, null)).toBe(row);
    expect(withImportFingerprint(row, undefined)).toBe(row);
    expect(withImportFingerprint(row, "b".repeat(64), "camt053")).toEqual({ ...row, import_fingerprint: "b".repeat(64), import_source: "camt053" });
    expect(withImportFingerprint(row, null, null)).toBe(row);
    expect(withImportFingerprint(row, "c".repeat(64), "camt053", " ACCT-1 ")).toEqual({
      ...row, import_fingerprint: "c".repeat(64), import_source: "camt053", bank_reference: "ACCT-1",
    });
    expect(withImportFingerprint(row, null, null, "   ")).toBe(row);
  });
});
