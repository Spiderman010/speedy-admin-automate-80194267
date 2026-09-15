import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeClientReadiness } from "@/lib/client-readiness";
import type { Tables } from "@/integrations/supabase/types";
import type { GrootboekSlim } from "@/lib/client-readiness";

/**
 * Fase 6C-b2a — BTW-grootboekconfiguratie per administratie.
 *
 * De migratietests zijn structureel (er is geen DB-harnas in deze repo); de
 * semantiek is daarnaast bewezen met echte PostgreSQL-probes, zie de PR.
 */

const MIGRATION = "supabase/migrations/20260915120000_add_client_vat_ledger_config.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — BTW-grootboekconfiguratie", () => {
  it("1. voegt exact twee kolommen toe, nullable en zonder default", () => {
    const added = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(added).toHaveLength(2);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS btw_te_vorderen_rekening_id uuid;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS btw_te_betalen_rekening_id uuid;/);
    // Alleen de kolomdefinities beoordelen: elders bevat de trigger legitiem
    // "IS NOT NULL", wat een bredere regex ten onrechte zou vangen.
    const colDefs = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS ([^\n;]+)/g)].map((m) => m[1]);
    expect(colDefs).toEqual(["btw_te_vorderen_rekening_id uuid", "btw_te_betalen_rekening_id uuid"]);
  });

  it("2. mapt geen enkel rekeningnummer automatisch (geen backfill)", () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.clients/i);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    // Geen verzonnen standaardnummers in uitvoerbare SQL. COMMENT-teksten
    // worden uitgesloten: die documenteren juist dát er niet gemapt wordt.
    // Let op: de COMMENT-tekst bevat zelf een puntkomma, dus het statement moet
    // via de string-literal worden afgebakend, niet via de eerste ";".
    const withoutComments = sql.replace(/COMMENT ON [^']*'[^']*';/g, "");
    expect(withoutComments).not.toMatch(/\b(1520|1530|1500|1510)\b/);
  });

  it("3. koppelt beide met een FK ON DELETE SET NULL", () => {
    expect(sql).toMatch(
      /clients_btw_te_vorderen_rekening_id_fkey[\s\S]*?REFERENCES public\.grootboekrekeningen \(id\)\s+ON DELETE SET NULL/,
    );
    expect(sql).toMatch(
      /clients_btw_te_betalen_rekening_id_fkey[\s\S]*?REFERENCES public\.grootboekrekeningen \(id\)\s+ON DELETE SET NULL/,
    );
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });

  it("4. indexeert beide kolommen", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_clients_btw_te_vorderen_rekening_id/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_clients_btw_te_betalen_rekening_id/);
  });

  it("5. valideert rekeningbereik op organisatie ÉN administratie", () => {
    // posting_account_ok laat een gedeelde rekening (client_id IS NULL) toe en
    // weigert de rekening van een andere administratie.
    expect(sql).toMatch(
      /public\.posting_account_ok\(NEW\.btw_te_vorderen_rekening_id, NEW\.organization_id, NEW\.id\)/,
    );
    expect(sql).toMatch(
      /public\.posting_account_ok\(NEW\.btw_te_betalen_rekening_id, NEW\.organization_id, NEW\.id\)/,
    );
  });

  it("6. laat NULL toe, zodat ON DELETE SET NULL blijft werken", () => {
    expect(sql).toMatch(/NEW\.btw_te_vorderen_rekening_id IS NOT NULL\s+AND NOT public\.posting_account_ok/);
    expect(sql).toMatch(/NEW\.btw_te_betalen_rekening_id IS NOT NULL\s+AND NOT public\.posting_account_ok/);
  });

  it("7. laat de bestaande debiteuren/crediteuren-controles ongemoeid", () => {
    expect(sql).toMatch(/public\.ledger_link_org_ok\(NEW\.debiteuren_rekening_id, NEW\.organization_id\)/);
    expect(sql).toMatch(/public\.ledger_link_org_ok\(NEW\.crediteuren_rekening_id, NEW\.organization_id\)/);
    // De gedeelde functies zelf worden niet geherdefinieerd.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(ledger_link_org_ok|posting_account_ok)/);
  });

  it("8. hangt de trigger opnieuw op mét de nieuwe kolommen in UPDATE OF", () => {
    // Zonder dit zou een update die alléén een BTW-koppeling wijzigt de
    // validatie volledig overslaan.
    expect(sql).toMatch(
      /CREATE TRIGGER validate_client_ledger_org_trigger\s+BEFORE INSERT OR UPDATE OF[\s\S]*?btw_te_vorderen_rekening_id,[\s\S]*?btw_te_betalen_rekening_id,[\s\S]*?organization_id/,
    );
    // Naamvolgorde: nog steeds ná set_organization_id_trigger.
    expect("validate_client_ledger_org_trigger" > "set_organization_id_trigger").toBe(true);
  });

  it("9. blijft SECURITY DEFINER met vast search_path en zonder PUBLIC-rechten", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.enforce_client_ledger_org"));
    expect(fn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(fn.slice(0, 300)).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_client_ledger_org\(\) FROM PUBLIC;/);
  });

  it("10. raakt alleen public.clients aan en is idempotent herhaalbaar", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["clients"]));
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
    const bareIdx = sql.match(/CREATE INDEX (?!IF NOT EXISTS)/g) ?? [];
    expect(bareIdx).toHaveLength(0);
  });

  it("11. documenteert een rollback", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS btw_te_vorderen_rekening_id/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS btw_te_betalen_rekening_id/);
  });
});

// ── Readiness ───────────────────────────────────────────────────────────────

type Client = Tables<"clients">;

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "c-1",
    name: "Test Klant",
    bank_dagboek: 100,
    inkoop_dagboek: 20,
    verkoop_dagboek: 70,
    debiteuren_rekening_id: "gb-1300",
    crediteuren_rekening_id: "gb-1600",
    btw_te_vorderen_rekening_id: "gb-btw-v",
    btw_te_betalen_rekening_id: "gb-btw-b",
    // 6C-b5a added a fifth required configuration field; the "fully
    // configured" fixture below must include it too, or its "klaar"
    // assertion would be testing an outdated definition of complete config.
    bank_rekening_id: "gb-bank",
    ...overrides,
  } as Client;
}

const accounts: GrootboekSlim[] = [
  { id: "gb-1799", nummer: 1799, omschrijving: "Onbekend", client_id: null },
];

describe("Client-readiness — BTW-rekeningen", () => {
  it("12. een volledig geconfigureerde klant blijft klaar", () => {
    const r = computeClientReadiness(makeClient(), [], [], [], [], accounts);
    expect(r.configMissingBtwTeVorderenRekening).toBe(false);
    expect(r.configMissingBtwTeBetalenRekening).toBe(false);
    expect(r.configMissingReasons).toEqual([]);
    expect(r.status).toBe("klaar");
  });

  it("13. ontbrekende BTW te vorderen geeft config_ontbreekt", () => {
    const r = computeClientReadiness(
      makeClient({ btw_te_vorderen_rekening_id: null } as Partial<Client>),
      [], [], [], [], accounts,
    );
    expect(r.configMissingBtwTeVorderenRekening).toBe(true);
    expect(r.configMissingBtwTeBetalenRekening).toBe(false);
    expect(r.configMissingReasons).toContain("BTW te vorderen (voorbelasting) ontbreekt");
    expect(r.status).toBe("config_ontbreekt");
  });

  it("14. ontbrekende BTW te betalen geeft config_ontbreekt", () => {
    const r = computeClientReadiness(
      makeClient({ btw_te_betalen_rekening_id: null } as Partial<Client>),
      [], [], [], [], accounts,
    );
    expect(r.configMissingBtwTeBetalenRekening).toBe(true);
    expect(r.configMissingReasons).toContain("BTW te betalen (af te dragen BTW) ontbreekt");
    expect(r.status).toBe("config_ontbreekt");
  });

  it("15. meldt de BTW-redenen naast de bestaande redenen, in vaste volgorde", () => {
    const r = computeClientReadiness(
      makeClient({
        bank_dagboek: null,
        debiteuren_rekening_id: null,
        btw_te_vorderen_rekening_id: null,
        btw_te_betalen_rekening_id: null,
      } as Partial<Client>),
      [], [], [], [], accounts,
    );
    expect(r.configMissingReasons).toEqual([
      "Bank-dagboek ontbreekt",
      "Debiteurenrekening ontbreekt",
      "BTW te vorderen (voorbelasting) ontbreekt",
      "BTW te betalen (af te dragen BTW) ontbreekt",
    ]);
  });

  it("16. een gedeactiveerde/verwijderde rekening (FK SET NULL) wordt als ontbrekend gemeld", () => {
    // ON DELETE SET NULL maakt de kolom leeg; readiness moet dat oppikken in
    // plaats van een verweesde id te tonen.
    const r = computeClientReadiness(
      makeClient({ btw_te_vorderen_rekening_id: null } as Partial<Client>),
      [], [], [], [], accounts,
    );
    expect(r.configMissingBtwTeVorderenRekening).toBe(true);
  });
});
