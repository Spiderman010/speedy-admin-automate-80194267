import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fase 6C-b5a — bankgrootboekconfiguratie per administratie.
 *
 * Schema-only: deze fase voegt alleen de kolom toe. De applicatie leest of
 * schrijft bank_rekening_id nog nergens — dat gebeurt pas in de opvolg-PR,
 * ná het toepassen van deze migratie op productie en het opnieuw genereren
 * van de types. Zo kan een gewone klantopslag nooit een kolom versturen die
 * in productie nog niet bestaat. De afletteringsboeking zelf is 6C-b5b.
 *
 * De migratietests zijn structureel: er is geen DB-harnas in deze repo.
 */

const MIGRATION = "supabase/migrations/20260916120000_add_client_bank_ledger_config.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — bankgrootboekconfiguratie", () => {
  it("1. voegt exact één kolom toe, nullable en zonder default", () => {
    const added = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(added).toHaveLength(1);
    expect(sql).toMatch(/ALTER TABLE public\.clients\s+ADD COLUMN IF NOT EXISTS bank_rekening_id uuid;/);
    // Alleen de kolomdefinitie beoordelen: elders bevat de trigger legitiem
    // "IS NOT NULL", wat een bredere regex ten onrechte zou vangen.
    const colDefs = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS ([^\n;]+)/g)].map((m) => m[1]);
    expect(colDefs).toEqual(["bank_rekening_id uuid"]);
    expect(sql).not.toMatch(/SET NOT NULL/);
    expect(sql).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i);
  });

  it("2. mapt geen enkel rekeningnummer automatisch (geen backfill)", () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.clients/i);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    // Geen verzonnen standaardnummers in uitvoerbare SQL. COMMENT-teksten
    // worden uitgesloten: die documenteren juist dát er niet gemapt wordt.
    const withoutComments = sql.replace(/COMMENT ON [^']*'[^']*';/g, "");
    expect(withoutComments).not.toMatch(/\b(1100|1101|1000)\b/);
    // Ook niet afgeleid uit het SnelStart-dagboek of uit categorie.
    expect(withoutComments).not.toMatch(/bank_dagboek|categorie/);
  });

  it("3. koppelt met een FK ON DELETE SET NULL, idempotent toegevoegd", () => {
    expect(sql).toMatch(
      /clients_bank_rekening_id_fkey[\s\S]*?REFERENCES public\.grootboekrekeningen \(id\)\s+ON DELETE SET NULL/,
    );
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).not.toMatch(/ON DELETE RESTRICT/);
    // Herhaalbaar: de constraint wordt alleen toegevoegd als hij nog niet bestaat.
    expect(sql).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1\s*FROM pg_constraint c[\s\S]*?c\.conname = 'clients_bank_rekening_id_fkey'/,
    );
    expect(sql).toMatch(/RAISE NOTICE 'Constraint clients_bank_rekening_id_fkey already exists, skipping'/);
  });

  it("4. indexeert de kolom met IF NOT EXISTS", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_clients_bank_rekening_id\s+ON public\.clients \(bank_rekening_id\);/,
    );
    const bareIdx = sql.match(/CREATE INDEX (?!IF NOT EXISTS)/g) ?? [];
    expect(bareIdx).toHaveLength(0);
  });

  it("5. valideert rekeningbereik op organisatie ÉN administratie", () => {
    // posting_account_ok laat een gedeelde rekening (client_id IS NULL) toe en
    // weigert de rekening van een andere organisatie of administratie.
    expect(sql).toMatch(
      /public\.posting_account_ok\(NEW\.bank_rekening_id, NEW\.organization_id, NEW\.id\)/,
    );
    // Niet de lossere org-only controle van debiteuren/crediteuren.
    expect(sql).not.toMatch(/ledger_link_org_ok\(NEW\.bank_rekening_id/);
    expect(sql).toMatch(
      /RAISE EXCEPTION 'bank_rekening_id verwijst naar een grootboekrekening buiten deze organisatie of van een andere administratie'\s+USING ERRCODE = '23514'/,
    );
  });

  it("6. laat NULL expliciet toe, zodat ON DELETE SET NULL blijft werken", () => {
    expect(sql).toMatch(/NEW\.bank_rekening_id IS NOT NULL\s+AND NOT public\.posting_account_ok/);
  });

  it("7. laat de vier bestaande controles ongemoeid", () => {
    expect(sql).toMatch(/public\.ledger_link_org_ok\(NEW\.debiteuren_rekening_id, NEW\.organization_id\)/);
    expect(sql).toMatch(/public\.ledger_link_org_ok\(NEW\.crediteuren_rekening_id, NEW\.organization_id\)/);
    expect(sql).toMatch(
      /public\.posting_account_ok\(NEW\.btw_te_vorderen_rekening_id, NEW\.organization_id, NEW\.id\)/,
    );
    expect(sql).toMatch(
      /public\.posting_account_ok\(NEW\.btw_te_betalen_rekening_id, NEW\.organization_id, NEW\.id\)/,
    );
    // De gedeelde predicaten zelf worden niet geherdefinieerd, en er komt geen
    // tweede SECURITY DEFINER-functie bij.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(ledger_link_org_ok|posting_account_ok)/);
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(fns).toEqual(["enforce_client_ledger_org"]);
  });

  it("8. hangt de trigger opnieuw op mét de nieuwe én alle bestaande kolommen", () => {
    // Zonder dit zou een update die alléén bank_rekening_id wijzigt de
    // validatie volledig overslaan.
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public\.clients;/);
    const m = sql.match(
      /CREATE TRIGGER validate_client_ledger_org_trigger\s+BEFORE INSERT OR UPDATE OF([\s\S]*?)ON public\.clients/,
    );
    expect(m).not.toBeNull();
    const cols = (m![1]).split(",").map((c) => c.trim()).filter(Boolean);
    expect(cols).toEqual([
      "debiteuren_rekening_id",
      "crediteuren_rekening_id",
      "btw_te_vorderen_rekening_id",
      "btw_te_betalen_rekening_id",
      "bank_rekening_id",
      "organization_id",
    ]);
    // Naamvolgorde: nog steeds ná set_organization_id_trigger.
    expect("validate_client_ledger_org_trigger" > "set_organization_id_trigger").toBe(true);
  });

  it("9. blijft SECURITY DEFINER met vast search_path en zonder PUBLIC-rechten", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.enforce_client_ledger_org"));
    expect(fn.slice(0, 300)).toMatch(/SECURITY DEFINER/);
    expect(fn.slice(0, 300)).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_client_ledger_org\(\) FROM PUBLIC;/);
    expect(sql).not.toMatch(/GRANT EXECUTE/);
  });

  it("10. raakt alleen public.clients aan en voegt geen boekingslogica toe", () => {
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["clients"]));
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
    // 6C-b5a is configuratie: geen ledger_postings-writer, geen marker.
    // De COMMENT-tekst beschrijft juist wél waarvoor de kolom bedoeld is en
    // wordt daarom uitgesloten van deze negatieve assertie.
    const withoutComments = sql.replace(/COMMENT ON [^']*'[^']*';/g, "");
    expect(withoutComments).not.toMatch(/ledger_postings|settlement|afletter/i);
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
  });

  it("11. documenteert een rollback", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS bank_rekening_id/);
    expect(raw).toMatch(/DROP CONSTRAINT IF EXISTS clients_bank_rekening_id_fkey/);
    expect(raw).toMatch(/DROP INDEX IF EXISTS public\.idx_clients_bank_rekening_id/);
    expect(raw).toMatch(/DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger/);
  });

  it("12. documenteert de kolom en de fasesplitsing", () => {
    expect(sql).toMatch(/COMMENT ON COLUMN public\.clients\.bank_rekening_id IS/);
    expect(raw).toMatch(/6C-b5a/);
    expect(raw).toMatch(/6C-b5b/);
  });
});
