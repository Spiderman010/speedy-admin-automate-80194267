import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * 20261020120000 — database-afgedwongen idempotentie per afschriftregel.
 *
 * Het échte gedrag (23505 op de partiële unieke index, ook onder RLS en onder
 * twee echt gelijktijdige sessies; historische exacte duplicaten die de
 * migratie niet laten falen; 23514 op de vorm; rollback en opnieuw toepassen)
 * wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/bank-import-fingerprint/ (58 bewijzen). CI heeft geen
 * PostgreSQL; deze test bewaakt de vorm van de migratie, haar grenzen en de
 * samenhang met het harnas en de uitrolcontroles.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261020120000_add_bank_transaction_import_fingerprint.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
/** SHA-256 van de migratie zoals beoordeeld en voor productie overgedragen. */
const REVIEWED_SHA256 = "6c29f55653f49a7fd0bed86c00e3e6ab8f909ae8adf9f8dc9d7e2886e437312f";
const HARNESS = "supabase/tests/bank-import-fingerprint";
const ROLLOUT = "supabase/rollout/20261020120000_add_bank_transaction_import_fingerprint";

const INDEX = "bank_transactions_client_import_fingerprint_key";
const CHECK = "bank_transactions_import_fingerprint_format";
const SOURCE_CHECK = "bank_transactions_import_source_known";
/** Zoals PostgreSQL ze teruggeeft (pg_get_constraintdef / pg_get_indexdef): wat harnas en POST vergelijken. */
const CANONICAL_CHECK = "CHECK (((import_fingerprint IS NULL) OR (import_fingerprint ~ '^[0-9a-f]{64}$'::text)))";
const CANONICAL_SOURCE_CHECK =
  "CHECK (((import_source IS NULL) OR (import_source = ANY (ARRAY['mt940'::text, 'camt053'::text]))))";
const CANONICAL_INDEX =
  "CREATE UNIQUE INDEX bank_transactions_client_import_fingerprint_key ON public.bank_transactions USING btree (client_id, import_fingerprint) WHERE (import_fingerprint IS NOT NULL)";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const raw = read(MIGRATION);

/** Zonder commentaarregels: de kop beschrijft juist wat er NIET gebeurt, en bevat de rollback. */
function executable(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}
const sql = executable(raw);

/** Uitvoerbare SQL zonder commentaar en zonder de inhoud van stringliterals, per opdracht. */
function statements(text: string): string[] {
  return executable(text)
    .replace(/\$e\$[\s\S]*?\$e\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function git(...args: string[]): string[] | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("migratie 20261020120000 — vorm", () => {
  it("1. bestaat één keer, en sorteert na bank_transactions, de rolpolicies en de laatste bankmigraties", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_add_bank_transaction_import_fingerprint.sql"))).toEqual([FILE]);
    const positie = files.indexOf(FILE);
    for (const prefix of ["20260411182021_", "20260613001452_", "20261017120000_", "20261018180000_"]) {
      const voorganger = files.findIndex((f) => f.startsWith(prefix));
      expect(voorganger, prefix).toBeGreaterThanOrEqual(0);
      expect(voorganger, prefix).toBeLessThan(positie);
    }
  });

  it("2. byte-voor-byte de beoordeelde versie (SHA-256 over de ruwe bytes)", () => {
    const sha256 = createHash("sha256").update(readFileSync(resolve(process.cwd(), MIGRATION))).digest("hex");
    expect(sha256).toBe(REVIEWED_SHA256);
  });

  it("3. drie kolommen, import_fingerprint, import_source en bank_reference: optioneel text, idempotent, geen standaardwaarde, geen NOT NULL", () => {
    for (const col of ["import_fingerprint", "import_source", "bank_reference"]) {
      expect(sql, col).toContain(`ALTER TABLE public.bank_transactions\n  ADD COLUMN IF NOT EXISTS ${col} text;`);
      const add = sql.match(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}[^;]*;`))?.[0] ?? "";
      expect(add, col).not.toMatch(/DEFAULT|NOT NULL|GENERATED/i);
      expect(sql, col).toContain(`COMMENT ON COLUMN public.bank_transactions.${col} IS`);
    }
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(3);
  });

  it("4. de CHECK: exact 64 kleine hex-tekens of NULL, idempotent via pg_constraint", () => {
    expect(sql).toContain(
      `ADD CONSTRAINT ${CHECK}\n      CHECK (import_fingerprint IS NULL OR import_fingerprint ~ '^[0-9a-f]{64}$');`,
    );
    expect(sql).toMatch(new RegExp(`IF NOT EXISTS \\(\\s+SELECT 1 FROM pg_constraint\\s+WHERE conname = '${CHECK}'`));
    expect(sql).not.toMatch(/NOT VALID/i);
  });

  it("4b. de CHECK op import_source: alleen 'mt940', 'camt053' of NULL, idempotent via pg_constraint", () => {
    expect(sql).toContain(
      `ADD CONSTRAINT ${SOURCE_CHECK}\n      CHECK (import_source IS NULL OR import_source IN ('mt940', 'camt053'));`,
    );
    expect(sql).toMatch(new RegExp(`IF NOT EXISTS \\(\\s+SELECT 1 FROM pg_constraint\\s+WHERE conname = '${SOURCE_CHECK}'`));
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(2);
  });

  it("5. de index: UNIQUE, partieel, op (client_id, import_fingerprint), niet CONCURRENTLY", () => {
    expect(sql).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}\n  ON public.bank_transactions (client_id, import_fingerprint)\n  WHERE import_fingerprint IS NOT NULL;`,
    );
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CONCURRENTLY|NULLS NOT DISTINCT/i);
  });

  it("6. faalt gesloten zonder bank_transactions of client_id", () => {
    expect(sql).toContain("to_regclass('public.bank_transactions') IS NULL");
    expect(sql).toMatch(/attname = 'client_id' AND NOT attisdropped/);
  });
});

describe("wat de migratie niet doet", () => {
  it("7. additief: geen DROP, UPDATE, DELETE, TRUNCATE, RENAME of backfill buiten commentaar", () => {
    for (const s of statements(raw)) {
      expect(s).not.toMatch(/\b(DROP|UPDATE|DELETE|TRUNCATE|RENAME|INSERT|COPY)\b/i);
    }
    expect(sql).not.toMatch(/\bALTER COLUMN\b|\bSET (?:DEFAULT|NOT NULL)\b/i);
  });

  it("8. ALTER TABLE uitsluitend op public.bank_transactions, en alleen ADD COLUMN / ADD CONSTRAINT", () => {
    const alters = sql.match(/ALTER TABLE[^;]*/g) ?? [];
    expect(alters).toHaveLength(5);
    expect(alters.map((a) => a.replace(/\s+/g, " ").replace(/ CHECK .*$/, " CHECK"))).toEqual([
      "ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS import_fingerprint text",
      `ALTER TABLE public.bank_transactions ADD CONSTRAINT ${CHECK} CHECK`,
      "ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS import_source text",
      `ALTER TABLE public.bank_transactions ADD CONSTRAINT ${SOURCE_CHECK} CHECK`,
      "ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS bank_reference text",
    ]);
    for (const t of ["bank_transaction_allocations", "ledger_postings", "clients"]) {
      expect(sql, t).not.toMatch(new RegExp(`ALTER TABLE[^;]*\\b${t}\\b`));
    }
  });

  it("9. geen policy-, rechten-, trigger-, functie- of RLS-wijziging", () => {
    expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b/i);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP) POLICY\b/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/\bCREATE (?:OR REPLACE )?(FUNCTION|TRIGGER|PROCEDURE|VIEW|TABLE)\b/i);
    expect(sql).not.toMatch(/session_replication_role|DISABLE TRIGGER/i);
  });

  it("10. een gedocumenteerde rollback die exact de index, beide CHECKs en alle drie kolommen weghaalt; geen verkeerde projectrefs", () => {
    const block = raw.match(/-- ROLLBACK-BEGIN\n([\s\S]*?)-- ROLLBACK-END/)?.[1] ?? "";
    const lines = block.split("\n").filter(Boolean).map((l) => l.replace(/^-- {3}/, ""));
    expect(lines).toEqual([
      `DROP INDEX IF EXISTS public.${INDEX};`,
      `ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS ${CHECK};`,
      `ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS ${SOURCE_CHECK};`,
      "ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS import_fingerprint;",
      "ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS import_source;",
      "ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS bank_reference;",
    ]);
    expect(raw).not.toMatch(/olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/);
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
  });
});

describe("harnas en uitrolcontroles", () => {
  const run = read(`${HARNESS}/run-proof.sh`);

  it("11. het harnas: wegwerpdatabase, historische rijen vóór de migratie, migratie twee keer, rollback twee keer, opnieuw vooruit", () => {
    expect(run).toMatch(/THROWAWAY DATABASE ONLY/);
    expect(run).toContain(`$MIG/${FILE}`);
    expect(run).toContain("FP_MIGRATION");
    for (const f of ["opening-balance/bootstrap.sql", "bank-transaction-posting/bootstrap-extra.sql", "year-close/fixtures.sql"]) {
      expect(run, f).toContain(f);
    }
    const firstApply = run.indexOf('run -f "$M"');
    expect(run.indexOf('"$HERE/fixtures.sql"')).toBeGreaterThan(0);
    expect(run.indexOf('"$HERE/fixtures.sql"')).toBeLessThan(firstApply);
    expect(run.match(/^run -f "\$M"/gm)).toHaveLength(3);
    expect(run.match(/^run -c "\$ROLLBACK"/gm)).toHaveLength(2);
    expect(run).toContain("sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' \"$M\"");
    expect(run).toContain("concurrency.sql");
    expect(run).toContain("rollback.sql");
    expect(run).toContain("preflight.sql");
    expect(run).toContain("postcheck.sql");
    expect(run).toMatch(/ok IS NOT TRUE/);
  });

  it("12. de historische rijen hebben geen vingerafdruk en bevatten identieke betalingen én een dubbele import", () => {
    const fixtures = read(`${HARNESS}/fixtures.sql`);
    const seed = fixtures.match(/INSERT INTO public\.bank_transactions\n {2}\(id,[\s\S]*?\);\n/)?.[0] ?? "";
    expect(seed).not.toBe("");
    expect(seed).not.toContain("import_fingerprint");
    expect(seed).not.toContain("import_source");
    expect(seed).not.toContain("bank_reference");
    expect(seed.match(/'PARKEREN Q-PARK', -4\.50, 'NL00BANK0000000001', NULL/g)?.length).toBeGreaterThanOrEqual(2);
    expect(seed.match(/'NTRFNONREF\/\/BANKREF-0001'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("13. de echte gelijktijdigheid: twee dblink-sessies, pg_sleep, COMMIT én ROLLBACK, met tijdstempels", () => {
    const c = read(`${HARNESS}/concurrency.sql`);
    expect(c).toContain("proof.open_session('a'");
    expect(c).toContain("proof.open_session('b'");
    expect(c).toContain("pg_sleep(2)");
    expect(c).toContain("pg_blocking_pids");
    expect(c).toContain("clock_timestamp()");
    expect(c).toMatch(/race_round\('C1',[^;]*'COMMIT'\)/);
    expect(c).toMatch(/race_round\('C2',[^;]*'ROLLBACK'\)/);
  });

  it("14. harnas en POST vergelijken met dezelfde canonieke definities van beide CHECKs en de index", () => {
    const proof = read(`${HARNESS}/proof.sql`);
    const post = read(`${ROLLOUT}/postcheck.sql`);
    for (const text of [proof, post]) {
      expect(text).toContain(CANONICAL_CHECK);
      expect(text).toContain(CANONICAL_SOURCE_CHECK);
      expect(text).toContain(CANONICAL_INDEX);
    }
  });

  it("15. PRE en POST bestaan, zijn alleen-lezen en noemen het juiste project en de editor", () => {
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      const path = resolve(process.cwd(), `${ROLLOUT}/${f}`);
      expect(existsSync(path), f).toBe(true);
      const text = readFileSync(path, "utf8");
      const stmts = statements(text);
      expect(stmts.length, f).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s.slice(0, 60), f).toMatch(/^(SELECT|WITH)\b/i);
        expect(s, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|SET)\b/i);
      }
      expect(text, f).toContain("alxlbdhpbwlehbdbfejw");
      expect(text, f).toContain("Lovable Cloud SQL editor");
      for (const line of text.split("\n").filter((l) => /olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/.test(l))) {
        expect(line, f).toMatch(/nooit|never/i);
      }
    }
    const pre = read(`${ROLLOUT}/preflight.sql`);
    expect(pre).toMatch(/STOP/);
    expect(pre).toContain("'//'");
    expect(statements(pre).length).toBeGreaterThanOrEqual(6);
    const post = read(`${ROLLOUT}/postcheck.sql`);
    expect(statements(post)).toHaveLength(1);
    expect(post).toContain("NULL::bigint AS pre_banktransacties");
    expect(post).toContain("NULL::bigint AS pre_policies");
    expect(pre).toContain("AS kolom_fingerprint_nog_afwezig");
    expect(pre).toContain("AS kolom_source_nog_afwezig");
    expect(pre).toContain("AS kolom_bankreferentie_nog_afwezig");
    for (const col of [
      "bron_kolom_nullable", "bron_geen_standaardwaarde", "bron_check_exact", "bestaande_rijen_bron_null",
      "bankreferentie_kolom_nullable", "bankreferentie_geen_standaardwaarde", "bestaande_rijen_bankreferentie_null",
    ]) {
      expect(post, col).toContain(`AS ${col}`);
    }
  });
});

describe("branch-grenzen", () => {
  const changed = git("diff", "--name-only", "origin/main...HEAD");

  it("16. geen bestaande migratie gewijzigd, verwijderd, hernoemd of van type veranderd", (ctx) => {
    const existing = git("diff", "--name-only", "--diff-filter=MDRT", "origin/main...HEAD", "--", MIGRATION_DIR);
    if (!existing) return ctx.skip();
    expect(existing).toEqual([]);
  });

  it("17. SQL op deze branch laat de grootboekfundering en de schrijvers ongemoeid; geen gegenereerde types", (ctx) => {
    if (!changed) return ctx.skip();
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });
});
