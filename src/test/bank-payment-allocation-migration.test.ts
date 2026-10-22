import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * P5 — atomaire betalingen: de vorm van de twee migraties en de grens van de app.
 *
 * Het échte gedrag (koppelen, ontkoppelen, weigeringen, rolmatrix, idempotentie,
 * legacy fail-closed, vangnet, foutinjectie na elke stap en bij COMMIT, races met
 * echte sessies zonder deadlock, rollback en opnieuw toepassen, PRE/POST
 * letterlijk en alleen-lezen) bewijst supabase/tests/bank-payment-allocation/
 * tegen een echte PostgreSQL. CI heeft geen PostgreSQL; deze test bewaakt wat
 * daar niet kan weglekken: de vorm, de rechten, de rollback en dat de app zelf
 * geen betaalstatus, restant of koppeling meer schrijft.
 */

const MIGRATION_DIR = "supabase/migrations";
const P5A = `${MIGRATION_DIR}/20261021180000_add_atomic_bank_payment_link.sql`;
const P5C = `${MIGRATION_DIR}/20261021183000_enforce_bank_payment_writer.sql`;
const SALES = `${MIGRATION_DIR}/20260915160000_add_sales_ledger_posting.sql`;
const HARNESS = "supabase/tests/bank-payment-allocation";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
/** Alleen uitvoerbare SQL: commentaarregels weg. */
const code = (p: string) => read(p).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
/** Zonder functielichamen: wat de migratie zelf, bij toepassen, doet. */
const topLevel = (p: string) => code(p).replace(/AS \$\$[\s\S]*?\$\$;/g, "AS $$…$$;").replace(/\$migratie\$[\s\S]*?\$migratie\$/g, "");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const rollbackOf = (p: string) => {
  const raw = read(p);
  const block = raw.slice(raw.indexOf("-- ROLLBACK-BEGIN\n") + "-- ROLLBACK-BEGIN\n".length, raw.indexOf("-- ROLLBACK-END"));
  return block.split("\n").map((l) => l.replace(/^-- ?/, "")).join("\n");
};
const bodyOf = (sql: string, header: string) => {
  const start = sql.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  const from = sql.indexOf("AS $$", start) + "AS $$".length;
  return sql.slice(from, sql.indexOf("$$;", from));
};

const RPCS = [
  "public.link_bank_payment(uuid, text, uuid, numeric, uuid)",
  "public.unlink_bank_payment(uuid, uuid, uuid)",
];
const INTERNAL = [
  "bank_payment_min_role", "bank_payment_writer_active", "bank_payment_allocation_writer_active",
  "bank_payment_tx_released", "bank_payment_assert_consistent", "stamp_bank_payment_record",
  "prevent_bank_payment_record_mutation", "guard_bank_allocation_write", "enforce_bank_allocation_integrity",
  "enforce_bank_match_rejection_not_linked", "verify_bank_payment_event",
];

describe("P5a 20261021180000 — vorm", () => {
  it("1. bestaat één keer en sorteert na afwijzingen, PR 0, PR 1/PR 2 en de importvingerafdruk", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const pos = files.indexOf("20261021180000_add_atomic_bank_payment_link.sql");
    expect(pos).toBeGreaterThanOrEqual(0);
    for (const prefix of ["20261010120000_", "20261017120000_", "20261018180000_", "20261020120000_", "20261021170000_"]) {
      expect(files.findIndex((f) => f.startsWith(prefix)), prefix).toBeLessThan(pos);
    }
    expect(files.indexOf("20261021183000_enforce_bank_payment_writer.sql")).toBe(pos + 1);
  });

  it("2. geen backfill: bovenop functies en vereisten alleen DDL, rechten en commentaar — geen INSERT/UPDATE/DELETE/TRUNCATE", () => {
    const top = topLevel(P5A);
    expect(top).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE (?:TABLE |public\.))/i);
    // De standaard voor created_by gaat apart, zodat bestaande rijen NIET worden ingevuld.
    expect(top).toMatch(/ADD COLUMN IF NOT EXISTS created_by uuid;/);
    expect(top).not.toMatch(/ADD COLUMN IF NOT EXISTS created_by uuid[^;]*DEFAULT/i);
    expect(top).toMatch(/ALTER COLUMN created_by SET DEFAULT auth\.uid\(\);/);
  });

  it("3. de RPC's: plpgsql, VOLATILE, SECURITY DEFINER, vaste search_path; alleen authenticated mag uitvoeren", () => {
    const sql = code(P5A);
    for (const sig of RPCS) {
      const name = sig.slice("public.".length, sig.indexOf("("));
      const header = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), sql.indexOf("AS $$", sql.indexOf(`FUNCTION public.${name}(`)));
      expect(header, name).toMatch(/LANGUAGE plpgsql\nVOLATILE\nSECURITY DEFINER\nSET search_path = public\n$/);
      expect(sql, name).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql, name).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`);
    }
    expect([...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([^ ]+\([^)]*\)) TO (\w+)/g)].map((m) => `${m[1]} ${m[2]}`).sort())
      .toEqual(RPCS.map((s) => `${s} authenticated`).sort());
  });

  it("4. elke interne hulp- en triggerfunctie: alles ingetrokken van PUBLIC, anon, authenticated én service_role", () => {
    const sql = code(P5A);
    for (const fn of INTERNAL) {
      expect(sql, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated, service_role;`));
    }
    const defined = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...INTERNAL, "link_bank_payment", "unlink_bank_payment", "prevent_posted_sales_invoice_mutation"].sort());
  });

  it("5. geen trigger op bank_transactions en geen herdefinitie van een schrijver (zie de struikeldraden van PR 2 en PR H)", () => {
    const sql = code(P5A);
    expect(sql).not.toMatch(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER[^;]*\bON\s+(?:public\.)?bank_transactions\b/i);
    for (const writer of ["post_bank_allocation", "post_bank_transaction", "post_sales_invoice", "post_purchase_invoice",
                          "reverse_posting_group", "reclassify_bank_transaction", "enforce_bank_transaction_release_hold"]) {
      expect(sql, writer).not.toMatch(new RegExp(`FUNCTION\\s+public\\.${writer}\\s*\\(`));
    }
  });

  it("6. de verkooptrigger is letterlijk het origineel plus precies één toegestane overgang (ontkoppelen via de schrijver)", () => {
    const original = bodyOf(read(SALES), "CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()");
    const p5a = bodyOf(read(P5A).split("\n").filter((l) => !l.startsWith("-- ")).join("\n"),
      "CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()");
    expect(md5(original)).toBe("aad983904aba6df9519d332389427b4e");
    expect(md5(p5a)).toBe("d7fa08d5356e5f0152928aa7f03438ad");
    const added = `  -- P5a: unlinking a payment through the payment writer (proof: session flag
  -- plus a payment event for this invoice in this transaction) may move
  -- betaald back to gecontroleerd — the only state it can have come from.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'gecontroleerd' AND NEW.status = 'betaald')
     AND NOT (OLD.status = 'betaald' AND NEW.status = 'gecontroleerd'
              AND public.bank_payment_writer_active('verkoop', OLD.id))`;
    const was = `  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'gecontroleerd' AND NEW.status = 'betaald')`;
    expect(original.split(was)).toHaveLength(2);
    expect(p5a).toBe(original.replace(was, added));
    // De vereistencontrole aanvaardt alleen deze twee versies (STOP bij een onbekende productieversie).
    expect(read(P5A)).toContain("IF v_md5 NOT IN ('aad983904aba6df9519d332389427b4e', 'd7fa08d5356e5f0152928aa7f03438ad') THEN");
  });

  it("7. de rollback herstelt de verkooptrigger byte-voor-byte en laat claims, gebeurtenissen en created_by staan", () => {
    const rb = rollbackOf(P5A);
    expect(md5(bodyOf(rb, "CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()"))).toBe("aad983904aba6df9519d332389427b4e");
    for (const sig of RPCS) expect(rb).toContain(`DROP FUNCTION IF EXISTS ${sig};`);
    expect(rb).not.toMatch(/DROP TABLE|DROP COLUMN/i);
    // Eerst de oorspronkelijke functie terug, dan pas de hulpfunctie weg waar de P5a-versie op leunt.
    expect(rb.indexOf("CREATE OR REPLACE FUNCTION public.prevent_posted_sales_invoice_mutation()"))
      .toBeLessThan(rb.indexOf("DROP FUNCTION IF EXISTS public.bank_payment_writer_active(text, uuid);"));
  });

  it("8. rolvloer in één CASE: verkoop owner (D2), inkoop koppelen assistant, ontkoppelen accountant", () => {
    const body = bodyOf(code(P5A), "CREATE OR REPLACE FUNCTION public.bank_payment_min_role(");
    expect(body.replace(/\s+/g, " ")).toContain(
      "WHEN _invoice_type = 'verkoop' THEN 'owner'::public.app_role WHEN _invoice_type = 'inkoop' AND _action = 'link' THEN 'assistant'::public.app_role WHEN _invoice_type = 'inkoop' AND _action = 'unlink' THEN 'accountant'::public.app_role ELSE 'owner'::public.app_role",
    );
  });
});

describe("P5c 20261021183000 — vorm", () => {
  it("1. intrekken zoals journal_entries: alles weg, alleen SELECT terug; policies blijven", () => {
    const sql = code(P5C);
    expect(sql).toContain("REVOKE ALL ON TABLE public.bank_transaction_allocations FROM PUBLIC, anon, authenticated, service_role;");
    expect(sql).toContain("GRANT SELECT ON TABLE public.bank_transaction_allocations TO authenticated, service_role;");
    expect(sql).not.toMatch(/DROP POLICY|CREATE POLICY|ALTER POLICY/i);
  });

  it("2. geen backfill en geen trigger op bank_transactions", () => {
    expect(topLevel(P5C)).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE (?:TABLE |public\.))/i);
    expect(code(P5C)).not.toMatch(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER[^;]*\bON\s+(?:public\.)?bank_transactions\b/i);
  });

  it("3. de guards zijn SECURITY DEFINER zonder EXECUTE voor applicatierollen, op alle drie de tabellen", () => {
    const sql = code(P5C);
    for (const fn of ["enforce_bank_allocation_writer", "enforce_invoice_payment_state"]) {
      expect(sql, fn).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.bank_transaction_allocations\nFOR EACH ROW EXECUTE FUNCTION public\.enforce_bank_allocation_writer\(\);/);
    for (const t of ["purchase_invoices", "sales_invoices"]) {
      expect(sql, t).toMatch(new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t}\\nFOR EACH ROW EXECUTE FUNCTION public\\.enforce_invoice_payment_state\\(\\);`));
    }
  });

  it("4. de rollback zet de rechten letterlijk terug volgens PRE 2 (STOP zonder die uitvoer) en haalt alleen de eigen guards weg", () => {
    const rb = rollbackOf(P5C);
    expect(rb).not.toMatch(/GRANT ALL/i);
    expect(rb).toContain("v_pre2 text := '<<PRE 2-UITVOER>>';");
    expect(rb).toMatch(/RAISE EXCEPTION 'STOP: de uitvoer van PRE 2 ontbreekt/);
    // Eerst de STOP-toets, dan pas iets weghalen of intrekken.
    expect(rb.indexOf("STOP:")).toBeLessThan(rb.indexOf("DROP TRIGGER"));
    expect(rb.indexOf("STOP:")).toBeLessThan(rb.indexOf("REVOKE ALL"));
    expect(rb).not.toMatch(/link_bank_payment|bank_payment_events|DROP TABLE/i);
  });
});

describe("harnas en uitrolmateriaal", () => {
  it("het harnas draait beide migraties twee keer, de rollbacks letterlijk, en PRE/POST alleen-lezen", () => {
    const sh = read(`${HARNESS}/run-proof.sh`);
    expect(sh.match(/run -f "\$MA"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sh.match(/run -f "\$MC"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sh).toContain("default_transaction_read_only=on");
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      expect(existsSync(resolve(process.cwd(), `supabase/rollout/20261021180000_add_atomic_bank_payment_link/${f}`)), f).toBe(true);
      expect(existsSync(resolve(process.cwd(), `supabase/rollout/20261021183000_enforce_bank_payment_writer/${f}`)), f).toBe(true);
    }
    // De echte RLS van de brontabellen, niet het vereenvoudigde dubbel (F1a-N2).
    expect(read(`${HARNESS}/build.sh`)).toContain("20260613001452_ac57e447-1ab9-4125-9cc8-070054d55750.sql");
    // Alleen libpq-omgeving; nooit een projectref in uitvoerbare code.
    for (const f of readdirSync(resolve(process.cwd(), HARNESS))) {
      const text = read(`${HARNESS}/${f}`).split("\n").filter((l) => !/^\s*(#|--)/.test(l)).join("\n");
      expect(text, f).not.toMatch(/alxlbdhpbwlehbdbfejw|supabase\.co/);
    }
  });

  it("het uitrolmateriaal is alleen lezen", () => {
    for (const dir of ["20261021180000_add_atomic_bank_payment_link", "20261021183000_enforce_bank_payment_writer"]) {
      for (const f of ["preflight.sql", "postcheck.sql"]) {
        // String-literals (bv. has_table_privilege(..., 'INSERT,UPDATE')) zijn geen opdrachten.
        const sql = code(`supabase/rollout/${dir}/${f}`).replace(/'(?:[^']|'')*'/g, "''");
        expect(sql, `${dir}/${f}`).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i);
      }
    }
    expect(read("supabase/rollout/20261021180000_add_atomic_bank_payment_link/herstelvoorstel.md")).toMatch(/NIET TOEGEPAST/);
  });
});

describe("de app schrijft geen betaalstatus, restant of koppeling meer zelf", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (full.endsWith(join("src", "test"))) continue;
        sourceFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(full) && !full.endsWith("integrations/supabase/types.ts")) {
        out.push(full);
      }
    }
    return out;
  }
  const files = [...sourceFiles(resolve(process.cwd(), "src")), ...sourceFiles(resolve(process.cwd(), "supabase/functions"))];
  const strip = (t: string) => t.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  it("geen insert, upsert, update of delete op bank_transaction_allocations", () => {
    const hits = files.filter((f) => /\.from\(\s*["'`]bank_transaction_allocations["'`]\s*\)[^;]*\.(insert|upsert|update|delete)\s*\(/.test(strip(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("Bank, Facturen en Verkoop zetten geen restant en geen status betaald meer", () => {
    for (const page of ["src/pages/Bank.tsx", "src/pages/Facturen.tsx", "src/pages/Verkoop.tsx"]) {
      const text = strip(read(page));
      // Restant komt alleen uit het antwoord van de database (lokale weergave) of als
      // beginwaarde bij het aanmaken (= totaal; P5c staat precies dat toe).
      const writes = [...text.matchAll(/remaining_amount\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim())
        .filter((v) => !v.startsWith("result.invoiceRemaining") && !/^form\.amount_incl \? parseFloat\(form\.amount_incl\) : form\.amount_excl/.test(v));
      expect(writes, page).toEqual([]);
      expect(text, page).not.toMatch(/status\s*:\s*["']betaald["']/);
      expect(text, page).not.toMatch(/useUpsertBankTransactionAllocation|useDeleteAllocationsForTransaction/);
    }
  });

  it("de betaalschrijver is de enige aanroeper van link/unlink_bank_payment, via de shim", () => {
    const callers = files.filter((f) => /["'`](un)?link_bank_payment["'`]/.test(strip(readFileSync(f, "utf8"))));
    expect(callers.map((f) => f.slice(f.indexOf("src/")))).toEqual(["src/hooks/useBankPaymentLink.ts"]);
  });
});
