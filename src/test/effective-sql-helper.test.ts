import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveFunction } from "@/test/support/effective-sql";

/**
 * Review H-4: de hulp die de EFFECTIEVE definitie leest, mag bij afwijkende
 * SQL-vormen nooit stil iets verkeerds teruggeven.
 */

let dir: string | null = null;
function migrations(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "effective-sql-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("effectiveFunction (review H-4)", () => {
  it("1. neemt de LAATSTE definitie op tijdstempel", () => {
    const d = migrations({
      "20260101000000_a.sql": "CREATE OR REPLACE FUNCTION public.f(x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n",
      "20260201000000_b.sql": "CREATE OR REPLACE FUNCTION public.f(x int) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;\n",
    });
    const r = effectiveFunction("f", d);
    expect(r.file).toBe("20260201000000_b.sql");
    expect(r.body).toContain("SELECT 2");
  });

  it("2. matcht zonder hoofdlettergevoeligheid, met extra witruimte, aanhalingstekens en zonder OR REPLACE", () => {
    const d = migrations({
      "20260101000000_a.sql": "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n",
      "20260201000000_b.sql": 'create   function  "public"."f" () returns int language sql as $$ SELECT 2 $$;\n',
    });
    expect(effectiveFunction("f", d).body).toContain("SELECT 2");
  });

  it("3. leest tot het sluitende dollar-tag van de definitie, ook bij een eigen tag", () => {
    const d = migrations({
      "20260101000000_a.sql":
        "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN RETURN 1; END\n$body$;\n" +
        "CREATE OR REPLACE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 99 $$;\n",
    });
    const r = effectiveFunction("f", d);
    expect(r.body).toContain("RETURN 1");
    expect(r.body).not.toContain("SELECT 99");
  });

  it("4. gooit een fout als het einde van het lichaam niet gevonden wordt", () => {
    const d = migrations({
      "20260101000000_a.sql": "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN RETURN 1; END\n",
    });
    expect(() => effectiveFunction("f", d)).toThrow(/Einde van het lichaam/);
  });

  it("5. gooit een fout als de functie na haar laatste definitie wordt verwijderd of hernoemd", () => {
    const create = "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n";
    const dropped = migrations({ "20260101000000_a.sql": create, "20260201000000_b.sql": "DROP FUNCTION IF EXISTS public.f();\n" });
    expect(() => effectiveFunction("f", dropped)).toThrow(/verwijderd of hernoemd/);
    rmSync(dropped, { recursive: true, force: true });
    const renamed = migrations({ "20260101000000_a.sql": create, "20260201000000_b.sql": "ALTER FUNCTION public.f() RENAME TO f_old;\n" });
    expect(() => effectiveFunction("f", renamed)).toThrow(/verwijderd of hernoemd/);
  });

  it("6. een DROP vóór de (her)definitie in hetzelfde bestand is gewoon de vervanging", () => {
    const d = migrations({
      "20260101000000_a.sql":
        "DROP FUNCTION IF EXISTS public.f();\nCREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;\n",
    });
    expect(effectiveFunction("f", d).body).toContain("SELECT 3");
  });

  it("7. een functie met een langere naam telt niet als dezelfde functie", () => {
    const d = migrations({
      "20260101000000_a.sql":
        "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n" +
        "CREATE OR REPLACE FUNCTION public.f_extra() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;\n" +
        "DROP FUNCTION IF EXISTS public.f_extra();\n",
    });
    expect(effectiveFunction("f", d).body).toContain("SELECT 1");
  });

  it("8. commentaar telt nooit als definitie", () => {
    const d = migrations({
      "20260101000000_a.sql": "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n",
      "20260201000000_b.sql": "-- CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;\n",
    });
    expect(effectiveFunction("f", d).body).toContain("SELECT 1");
  });
});
