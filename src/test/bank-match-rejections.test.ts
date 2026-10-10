import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRejectionIndex,
  isRejectedCandidate,
  withoutRejectedCandidates,
} from "@/lib/bank-match-rejections";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * Bank-matchafwijzingen — contract over de migratie en de pure onderdrukkingsregel.
 *
 * Het échte gedrag (RLS, isolatie, idempotentie, "niets anders verandert") wordt
 * bewezen tegen een echte PostgreSQL in supabase/tests/bank-match-rejections/
 * (52 bewijzen). CI heeft geen PostgreSQL; deze tests bewaken de vorm van de
 * migratie en de regel die de matcher straks gebruikt.
 */

const MIGRATION = "supabase/migrations/20261010120000_add_bank_match_rejections.sql";
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
/** Zonder commentaar: de kop beschrijft juist wat er NIET gebeurt. */
const sql = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

function changedFiles(): string[] | null {
  try {
    return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("migratie 20261010120000 — vorm", () => {
  it("1. is de nieuwste migratie en sorteert na de vorige", () => {
    const files = readdirSync(resolve(process.cwd(), "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(files.at(-1)).toBe("20261010120000_add_bank_match_rejections.sql");
  });

  it("2. één tabel met de identiteit (transactie, soort, factuur), afgeleide organisatie/administratie en afwijzer", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.bank_match_rejections/);
    for (const col of [
      /organization_id\s+uuid\s+NOT NULL REFERENCES public\.organizations/,
      /client_id\s+uuid\s+NOT NULL REFERENCES public\.clients/,
      /bank_transaction_id uuid\s+NOT NULL REFERENCES public\.bank_transactions \(id\) ON DELETE CASCADE/,
      /invoice_type\s+text\s+NOT NULL/,
      /invoice_id\s+uuid\s+NOT NULL/,
      /rejected_by\s+uuid\s+NOT NULL REFERENCES auth\.users/,
    ]) {
      expect(sql).toMatch(col);
    }
    expect(sql).toMatch(/CHECK \(invoice_type IN \('inkoop', 'verkoop'\)\)/);
    expect(sql).toMatch(/CONSTRAINT bank_match_rejections_unique UNIQUE \(bank_transaction_id, invoice_type, invoice_id\)/);
  });

  it("3. organisatie en administratie komen uit de banktransactie; een afwijkende waarde wordt geweigerd", () => {
    expect(sql).toMatch(/FROM public\.bank_transactions bt\s+WHERE bt\.id = NEW\.bank_transaction_id/);
    expect(sql).toMatch(/NEW\.organization_id <> v_tx_org[\s\S]*RAISE EXCEPTION 'Organisatie hoort niet bij deze banktransactie'/);
    expect(sql).toMatch(/NEW\.client_id <> v_tx_client[\s\S]*RAISE EXCEPTION 'Administratie hoort niet bij deze banktransactie'/);
    expect(sql).toMatch(/NEW\.organization_id := v_tx_org;/);
    expect(sql).toMatch(/NEW\.client_id := v_tx_client;/);
  });

  it("4. de factuur moet bij dezelfde administratie horen, en een bevestigde koppeling kan niet worden afgewezen", () => {
    expect(sql).toMatch(/purchase_invoices pi\s+WHERE pi\.id = NEW\.invoice_id AND pi\.client_id = v_tx_client/);
    expect(sql).toMatch(/sales_invoices si\s+WHERE si\.id = NEW\.invoice_id AND si\.client_id = v_tx_client/);
    expect(sql).toMatch(/FROM public\.bank_transaction_allocations a\s+WHERE a\.bank_transaction_id = NEW\.bank_transaction_id AND a\.invoice_id = NEW\.invoice_id/);
  });

  it("5. één neutrale fout voor onbekend, zonder organisatie of vreemd (geen tenant-orakel)", () => {
    const neutral = sql.match(/RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501'/g) ?? [];
    expect(neutral).toHaveLength(1);
    expect(sql).not.toMatch(/niet gevonden/i);
  });

  it("6. RLS: lezen vanaf read_only, invoegen en weghalen vanaf assistant, afwijzer = aanroeper; geen UPDATE", () => {
    expect(sql).toMatch(/ALTER TABLE public\.bank_match_rejections ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/role_bank_match_rejections_select[\s\S]*?FOR SELECT TO authenticated[\s\S]*?'read_only'/);
    expect(sql).toMatch(/role_bank_match_rejections_insert[\s\S]*?FOR INSERT TO authenticated[\s\S]*?'assistant'\)\s+AND rejected_by = auth\.uid\(\)/);
    expect(sql).toMatch(/role_bank_match_rejections_delete[\s\S]*?FOR DELETE TO authenticated[\s\S]*?'assistant'/);
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/REVOKE ALL ON public\.bank_match_rejections FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, DELETE ON public\.bank_match_rejections TO authenticated;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.bank_match_rejections TO service_role;/);
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*bank_match_rejections/);
  });

  it("7. de triggerfunctie is SECURITY DEFINER met vaste search_path en voor geen applicatierol aanroepbaar", () => {
    expect(sql).toMatch(/enforce_bank_match_rejection_scope\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.enforce_bank_match_rejection_scope\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  });

  it("8. raakt niets anders: geen schrijfactie of ALTER op transacties, afletteringen, facturen of grootboek", () => {
    for (const table of ["bank_transactions", "bank_transaction_allocations", "purchase_invoices", "sales_invoices", "ledger_postings"]) {
      expect(sql, table).not.toMatch(new RegExp(`(UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE|TRUNCATE)\\s+(public\\.)?${table}\\b`, "i"));
    }
    expect(sql).not.toMatch(/match_status|matched_invoice_id|match_confidence/);
    expect(sql).not.toMatch(/ledger_postings/);
  });

  it("9. vereisten fail closed, een gedocumenteerde rollback, en geen projectrefs", () => {
    expect(sql).toMatch(/to_regproc\('public\.has_min_role'\) IS NULL/);
    expect(raw).toMatch(/-- ROLLBACK-BEGIN\n-- {3}DROP TABLE IF EXISTS public\.bank_match_rejections;\n-- {3}DROP FUNCTION IF EXISTS public\.enforce_bank_match_rejection_scope\(\);\n-- ROLLBACK-END/);
    expect(raw).not.toMatch(/olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/);
  });

  it("10. er is een echt-PostgreSQL-bewijs dat deze migratie twee keer toepast en de rollback uitvoert", () => {
    const run = readFileSync(resolve(process.cwd(), "supabase/tests/bank-match-rejections/run-proof.sh"), "utf8");
    expect(run).toMatch(/20261010120000_add_bank_match_rejections\.sql/);
    expect(run.match(/^run -f "\$M"/gm)).toHaveLength(2);
    expect(run).toMatch(/ROLLBACK-BEGIN/);
    expect(run).toMatch(/THROWAWAY DATABASE ONLY/);
  });
});

describe("branch-grenzen", () => {
  it("11. geen gegenereerde types, packages of MCP-functie; fundering en schrijvers onaangeroerd", (ctx) => {
    const changed = changedFiles();
    if (!changed) return ctx.skip();
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed).not.toContain("package-lock.json");
    expect(changed).not.toContain("supabase/functions/mcp/index.ts");
    expect(changed).not.toContain(".lovable/mcp/manifest.json");
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
    // Precies één nieuwe migratie, en geen bestaande gewijzigd.
    const migrations = changed.filter((f) => f.startsWith("supabase/migrations/"));
    expect(migrations).toEqual([MIGRATION]);
  });

  it("12. geen UI-schrijfpad zonder gegenereerde types: niemand praat al met de tabel", () => {
    const src = execFileSync("git", ["grep", "-l", "bank_match_rejections", "--", "src"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(src).toEqual(["src/lib/bank-match-rejections.ts", "src/test/bank-match-rejections.test.ts"]);
    const lib = readFileSync(resolve(process.cwd(), "src/lib/bank-match-rejections.ts"), "utf8");
    expect(lib).not.toMatch(/integrations\/supabase|\.from\(|\.rpc\(|as any|: any\b/);
  });
});

describe("onderdrukkingsregel", () => {
  const rows = [
    { bank_transaction_id: "tx-1", invoice_type: "inkoop" as const, invoice_id: "pi-1" },
    { bank_transaction_id: "tx-2", invoice_type: "verkoop" as const, invoice_id: "si-9" },
  ];
  const index = buildRejectionIndex(rows);

  it("13. een afgewezen factuur wordt voor dezelfde transactie niet meer aangeboden", () => {
    expect(isRejectedCandidate(index, "tx-1", { id: "pi-1", type: "inkoop" })).toBe(true);
    const candidates = [
      { id: "pi-1", type: "inkoop" as const, score: 190 },
      { id: "pi-2", type: "inkoop" as const, score: 100 },
    ];
    expect(withoutRejectedCandidates(index, "tx-1", candidates)).toEqual([{ id: "pi-2", type: "inkoop", score: 100 }]);
  });

  it("14. alleen een exacte overeenkomst telt: andere transactie, andere soort of andere factuur onderdrukt niets", () => {
    expect(isRejectedCandidate(index, "tx-3", { id: "pi-1", type: "inkoop" })).toBe(false);
    expect(isRejectedCandidate(index, "tx-1", { id: "pi-1", type: "verkoop" })).toBe(false);
    expect(isRejectedCandidate(index, "tx-1", { id: "pi-2", type: "inkoop" })).toBe(false);
  });

  it("15. volgorde en velden van de overige kandidaten blijven ongewijzigd; zonder afwijzingen is alles er nog", () => {
    const candidates = [
      { id: "a", type: "verkoop" as const, reasons: ["Exact bedrag"] },
      { id: "si-9", type: "verkoop" as const, reasons: [] },
      { id: "b", type: "verkoop" as const, reasons: ["Naam"] },
    ];
    const out = withoutRejectedCandidates(index, "tx-2", candidates);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0]).toBe(candidates[0]);
    expect(withoutRejectedCandidates(buildRejectionIndex([]), "tx-2", candidates)).toEqual(candidates);
  });

  it("16. een herhaalde afwijzing (dezelfde rij twee keer) verandert de uitkomst niet", () => {
    const twice = buildRejectionIndex([...rows, rows[0]]);
    expect(twice.size).toBe(2);
    expect(withoutRejectedCandidates(twice, "tx-1", [{ id: "pi-1", type: "inkoop" as const }])).toEqual([]);
  });
});
