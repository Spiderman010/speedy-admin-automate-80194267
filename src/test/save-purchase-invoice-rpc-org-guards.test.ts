import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260721010000_save_purchase_invoice_with_lines.sql",
);
const migrationSql = readFileSync(migrationPath, "utf-8");

describe("save_purchase_invoice_with_lines organization guards", () => {
  it("allows same-organization payloads by only rejecting missing cross-organization client references", () => {
    expect(migrationSql).toContain("FROM public.clients c");
    expect(migrationSql).toContain("WHERE c.id = v_client_id");
    expect(migrationSql).toContain("AND c.organization_id = v_org");
    expect(migrationSql).toContain("RAISE EXCEPTION 'client bestaat niet binnen deze organisatie'");
  });

  it("rejects foreign suppliers before the header update", () => {
    expect(migrationSql).toContain("FROM public.leveranciers l");
    expect(migrationSql).toContain("WHERE l.id = v_leverancier_id");
    expect(migrationSql).toContain("AND l.organization_id = v_org");
    expect(migrationSql).toContain("RAISE EXCEPTION 'leverancier bestaat niet binnen deze organisatie'");
  });

  it("rejects foreign ledger accounts from line payloads before the header update", () => {
    expect(migrationSql).toContain("FROM jsonb_array_elements(_lines) AS elem");
    expect(migrationSql).toContain("FROM public.grootboekrekeningen g");
    expect(migrationSql).toContain("g.id = NULLIF(elem->>'grootboekrekening_id', '')::uuid");
    expect(migrationSql).toContain("AND g.organization_id = v_org");
    expect(migrationSql).toContain("RAISE EXCEPTION 'grootboekrekening bestaat niet binnen deze organisatie'");
  });

  it("keeps the header unchanged on rejection by validating references before UPDATE public.purchase_invoices", () => {
    const clientGuardIndex = migrationSql.indexOf("RAISE EXCEPTION 'client bestaat niet binnen deze organisatie'");
    const supplierGuardIndex = migrationSql.indexOf("RAISE EXCEPTION 'leverancier bestaat niet binnen deze organisatie'");
    const ledgerGuardIndex = migrationSql.indexOf("RAISE EXCEPTION 'grootboekrekening bestaat niet binnen deze organisatie'");
    const updateIndex = migrationSql.indexOf("UPDATE public.purchase_invoices");

    expect(clientGuardIndex).toBeGreaterThan(-1);
    expect(supplierGuardIndex).toBeGreaterThan(-1);
    expect(ledgerGuardIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(-1);
    expect(clientGuardIndex).toBeLessThan(updateIndex);
    expect(supplierGuardIndex).toBeLessThan(updateIndex);
    expect(ledgerGuardIndex).toBeLessThan(updateIndex);
  });
});
