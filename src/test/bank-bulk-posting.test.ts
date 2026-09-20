import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "./support/branch-sql-scope";
import {
  BANK_BULK_MAX_BATCH,
  bulkErrorMessage,
  chunkTransactionIds,
  isDeployWindowError,
  readyTransactionIds,
  rejectedResults,
  summariseBulkResults,
  summariseCandidates,
  type BankBulkCandidate,
  type BankBulkResult,
} from "@/lib/bank-bulk-posting";

/**
 * Bank-inhaalslag — de grenzen van de bulklaag.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Of een gedeeltelijke mislukking werkelijk per regel geïsoleerd is, of twee
 * gelijktijdige partijen samen één boekingsgroep opleveren, en of de rechten
 * werkelijk zo staan — dat zijn uitspraken over PostgreSQL. Die staan in
 * `supabase/tests/bank-bulk-posting/` en draaien tegen een echte database
 * (80 bewijzen). Dit bestand bewaakt wat daar niet te zien is: dat de bulklaag
 * geen tweede boekhoudmotor wordt.
 */

const MIGRATION_DIR = "supabase/migrations";
const SLUG = "_add_bank_bulk_posting.sql";

const own = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(SLUG));
const MIGRATION = `${MIGRATION_DIR}/${own[0]}`;

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

const hook = readFileSync(resolve(process.cwd(), "src/hooks/useBankBulkPosting.ts"), "utf8");
const pure = readFileSync(resolve(process.cwd(), "src/lib/bank-bulk-posting.ts"), "utf8");

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

describe("de bulklaag schrijft zelf geen boekhouding", () => {
  it("1. de migratie schrijft nergens rechtstreeks in ledger_postings", () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.ledger_postings/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.ledger_postings/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.ledger_postings/i);
  });

  it("2. en schrijft evenmin rechtstreeks in de markertabel", () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.bank_transaction_postings/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.bank_transaction_postings/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.bank_transaction_postings/i);
  });

  it("3. de bulkfunctie roept de bestaande schrijver aan — dat is haar enige schrijfhandeling", () => {
    expect(flat).toMatch(/v_group := public\.post_bank_transaction\(v_item\.id\);/);
    const bulk = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk"));
    const schrijfacties = bulk.match(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/gi) ?? [];
    expect(schrijfacties).toEqual([]);
  });

  it("4. de BTW-formule van de schrijver wordt nergens herhaald", () => {
    // Geen deling door (1 + pct/100), geen btw = bruto - netto, geen round(,2).
    expect(sql).not.toMatch(/1\s*\+\s*\w*pct\w*\s*\/\s*100/i);
    expect(sql).not.toMatch(/\bround\s*\(/i);
    expect(sql).not.toMatch(/btw_vrijgesteld\s*THEN\s*0/i);
    expect(pure).not.toMatch(/\/\s*\(\s*1\s*\+/);
  });

  it("5. er wordt geen debet- of creditzijde gekozen en geen rekening toegewezen", () => {
    expect(sql).not.toMatch(/debit_amount/i);
    expect(sql).not.toMatch(/credit_amount/i);
    expect(sql).not.toMatch(/posting_account_ok/i);
    expect(sql).not.toMatch(/bank_rekening_id\s*,/i);
  });

  it("6. er staat nergens een hard rekeningnummer of een klantnaam in", () => {
    for (const bestand of [sql, pure, hook]) {
      expect(bestand).not.toMatch(/\b(1100|1200|1300|1600|1670|1680|4400|8000)\b/);
      expect(bestand).not.toMatch(/AA\s*Secure/i);
      expect(bestand).not.toMatch(/agio/i);
    }
  });

  it("7. de frontend stuurt uitsluitend id's naar de bulkfunctie", () => {
    expect(hook).toMatch(/rpc\("post_bank_transactions_bulk",\s*\{\s*_transaction_ids: chunk,\s*\}\)/);
    expect(hook).not.toMatch(/_amount|_btw|_grootboekrekening|debit|credit/i);
    expect(hook).not.toMatch(/\.from\("ledger_postings"\)/);
    expect(hook).not.toMatch(/\.from\("bank_transaction_postings"\)/);
  });

  it("8. en roept de enkelvoudige schrijver niet per regel aan", () => {
    expect(hook).not.toMatch(/rpc\("post_bank_transaction"/);
  });
});

describe("de bulkfunctie — vorm en grenzen", () => {
  it("9. bestaat precies één keer, met een UTC-tijdstempelprefix ná de geharde schrijver", () => {
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^\d{14}_add_bank_bulk_posting\.sql$/);
    expect(own[0].slice(0, 14) > "20260921140000").toBe(true);
  });

  it("10. draait met de rechten van de aanroeper, met een vast zoekpad", () => {
    expect(flat).toMatch(/CREATE OR REPLACE FUNCTION public\.post_bank_transactions_bulk\(_transaction_ids uuid\[\]\)/);
    expect(flat).toMatch(/post_bank_transactions_bulk[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = public/);
    expect(flat).toMatch(/bank_bulk_posting_candidates[\s\S]*?SECURITY INVOKER[\s\S]*?SET search_path = public/);
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });

  it("11. de rechten worden expliciet per rol ingetrokken en alleen aan authenticated teruggegeven", () => {
    for (const fn of ["post_bank_transactions_bulk\\(uuid\\[\\]\\)", "bank_bulk_posting_candidates\\(uuid, integer\\)"]) {
      expect(flat).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon, authenticated, service_role;`),
      );
      expect(flat).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO authenticated;`));
    }
    expect(flat).not.toMatch(/GRANT EXECUTE[^;]*TO[^;]*(anon|service_role|PUBLIC)/);
  });

  it("12. de bovengrens staat in de migratie en in de frontend op hetzelfde getal", () => {
    expect(flat).toMatch(/c_max_batch constant integer := 500;/);
    expect(BANK_BULK_MAX_BATCH).toBe(500);
    expect(flat).toMatch(/cardinality\(_transaction_ids\) > c_max_batch/);
  });

  it("13. een lege of onvolledige lijst wordt geweigerd vóór er iets geboekt wordt", () => {
    const bulk = flat.slice(flat.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk"));
    const eersteAanroep = bulk.indexOf("public.post_bank_transaction(v_item.id)");
    for (const bewaking of [
      "Geen banktransacties opgegeven",
      "De lijst met banktransacties bevat een lege waarde",
      "Maximaal % banktransacties per keer",
    ]) {
      const index = bulk.indexOf(bewaking);
      expect(index, bewaking).toBeGreaterThan(-1);
      expect(index, `${bewaking} moet vóór de eerste boeking staan`).toBeLessThan(eersteAanroep);
    }
  });

  it("14. elke regel draait in een eigen subtransactie, met de uitgestelde controles erbinnen", () => {
    expect(flat).toMatch(/BEGIN v_group := public\.post_bank_transaction\(v_item\.id\);/);
    expect(flat).toMatch(/SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;/);
    expect(flat).toMatch(/EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS/);
  });

  it("15. dubbele id's worden één keer verwerkt, in volgorde van eerste voorkomen", () => {
    expect(flat).toMatch(/SELECT DISTINCT ON \(u\.id\) u\.id, u\.ord FROM unnest\(_transaction_ids\) WITH ORDINALITY/);
    expect(flat).toMatch(/ORDER BY u\.id, u\.ord/);
    expect(flat).toMatch(/\) d ORDER BY d\.ord/);
  });

  it("16. er wordt nergens opnieuw geprobeerd na een weigering", () => {
    expect(sql).not.toMatch(/\bLOOP\b[\s\S]*\bCONTINUE\b/i);
    expect(sql).not.toMatch(/retry|opnieuw proberen|herkansing[^:]*:=/i);
    // Precies één werkelijke AANROEP van de schrijver in het hele bestand (de
    // overige vermeldingen zijn de vereistencontrole en de COMMENT-teksten).
    expect(sql.match(/:=\s*public\.post_bank_transaction\(/g) ?? []).toHaveLength(1);
  });

  it("17. een 23505 wordt alleen idempotent genoemd als de claim zichtbaar is", () => {
    expect(flat).toMatch(/IF v_state = '23505' AND v_marker IS NOT NULL THEN outcome := 'already_posted'/);
    expect(flat).toMatch(/ELSE v_marker := NULL;/);
  });

  it("18. succes wordt pas gemeld als de claim bevestigd is", () => {
    expect(flat).toMatch(
      /IF v_marker IS NULL OR v_marker IS DISTINCT FROM v_group THEN RAISE EXCEPTION 'De boeking van deze banktransactie kon niet worden bevestigd'/,
    );
  });

  it("19. alleen de eigen woordenschat van de schrijver gaat ongeschonden naar buiten", () => {
    expect(flat).toMatch(
      /WHEN v_state IN \('28000', '42501', '22023', '23514', '23505', 'P0002'\) THEN v_msg ELSE 'Boeken is niet gelukt voor deze banktransactie\.'/,
    );
  });
});

describe("de preflight leest, en beslist niets", () => {
  it("20. is STABLE en bevat geen enkele schrijfhandeling", () => {
    const pre = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk"),
    );
    expect(pre).toMatch(/\bSTABLE\b/);
    expect(pre).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("21. kent precies vier werkstroomtoestanden", () => {
    const pre = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk"),
    );
    const toestanden = new Set((pre.match(/'(posted|ready|review_needed|blocked)'/g) ?? []).map((s) => s));
    expect([...toestanden].sort()).toEqual(["'blocked'", "'posted'", "'ready'", "'review_needed'"]);
  });

  it("22. leidt niets af uit een omschrijving of een tegenrekening", () => {
    const pre = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk"),
    );
    expect(pre).not.toMatch(/ILIKE|~\*|position\(/i);
    expect(pre).not.toMatch(/counter_account\s*(=|LIKE)/i);
  });
});

describe("de zuivere laag", () => {
  const rij = (over: Partial<BankBulkCandidate>): BankBulkCandidate => ({
    transaction_id: "t",
    transaction_date: "2027-03-01",
    amount: -121,
    description: null,
    counter_account: null,
    match_status: "handmatig_geboekt",
    grootboekrekening_id: "g",
    btw_percentage: null,
    is_posted: false,
    is_allocated: false,
    posting_group_id: null,
    workflow_state: "ready",
    reason: null,
    ...over,
  });

  it("23. telt de toestanden zoals de server ze geeft, zonder ze te herclassificeren", () => {
    const rows = [
      rij({ transaction_id: "a" }),
      rij({ transaction_id: "b", workflow_state: "blocked", reason: "x" }),
      rij({ transaction_id: "c", workflow_state: "review_needed", reason: "y" }),
      rij({ transaction_id: "d", workflow_state: "posted", is_posted: true, posting_group_id: "g1" }),
      rij({ transaction_id: "e" }),
    ];
    expect(summariseCandidates(rows)).toEqual({
      total: 5,
      ready: 2,
      reviewNeeded: 1,
      blocked: 1,
      posted: 1,
    });
    expect(readyTransactionIds(rows)).toEqual(["a", "e"]);
  });

  it("24. knipt een lange lijst in partijen van hoogstens de bovengrens, elke id één keer", () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    const chunks = chunkTransactionIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("25. laat een partij van 342 regels één verzoek blijven", () => {
    expect(chunkTransactionIds(Array.from({ length: 342 }, (_, i) => `x${i}`))).toHaveLength(1);
  });

  it("26. vat de uitkomsten samen zonder een weigering als succes te tellen", () => {
    const results: BankBulkResult[] = [
      { ordinal: 1, transaction_id: "a", outcome: "posted", posting_group_id: "g1", error_code: null, message: null },
      { ordinal: 2, transaction_id: "b", outcome: "rejected", posting_group_id: null, error_code: "22023", message: "nee" },
      { ordinal: 3, transaction_id: "c", outcome: "already_posted", posting_group_id: "g2", error_code: null, message: null },
    ];
    expect(summariseBulkResults(results)).toEqual({ total: 3, posted: 1, alreadyPosted: 1, rejected: 1 });
    expect(rejectedResults(results).map((r) => r.transaction_id)).toEqual(["b"]);
  });

  it("27. herkent het deploy-venster en meldt dat als iets anders dan 'niets te doen'", () => {
    expect(isDeployWindowError({ code: "PGRST202" })).toBe(true);
    expect(isDeployWindowError({ code: "42883" })).toBe(true);
    expect(isDeployWindowError({ code: "22023" })).toBe(false);
    expect(bulkErrorMessage({ code: "PGRST202", message: "x" })).toBe(
      "Bulkboeken is nog niet beschikbaar voor deze omgeving.",
    );
  });

  it("28. toont de Nederlandse melding van de database, maar nooit een ruwe driverfout", () => {
    expect(bulkErrorMessage({ message: "Deze banktransactie is al geboekt" })).toBe(
      "Deze banktransactie is al geboekt",
    );
    expect(bulkErrorMessage({ message: "22023 iets technisch" })).toBe("Boeken is niet gelukt. Probeer het opnieuw.");
    expect(bulkErrorMessage(null)).toBe("Boeken is niet gelukt. Probeer het opnieuw.");
  });
});

describe("de grenzen van deze branch", () => {
  it("29. de migratie is additief en laat de grootboekfundering met rust", () => {
    const changed = changedFiles();
    if (!changed) return; // geen origin/main beschikbaar
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });

  it("30. geen bestaande migratie wordt gewijzigd en types.ts blijft met rust", () => {
    const changed = changedFiles();
    if (!changed) return;
    const bestaand = new Set(
      execFileSync("git", ["ls-tree", "--name-only", "origin/main", `${MIGRATION_DIR}/`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean),
    );
    expect(changed.filter((f) => f.startsWith(`${MIGRATION_DIR}/`) && bestaand.has(f))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  it("31. er wordt niets verwijderd, afgekapt of geherstructureerd", () => {
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN|TRIGGER|POLICY)\b/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/);
    expect(sql).not.toMatch(/\bALTER TABLE\b/);
    expect(sql).not.toMatch(/\bDELETE FROM\b/);
    // De claimtrigger, de bevriezing en de schrijver zelf blijven onaangeroerd.
    expect(sql).not.toMatch(/enforce_bank_transaction_source_claim/);
    expect(sql).not.toMatch(/prevent_posted_bank_transaction_mutation/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_bank_transaction\(/);
  });

  it("32. de rollback en de leescontroles staan in het bestand, zonder verboden projectref", () => {
    expect(raw).toMatch(/-- rollback/);
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
    expect(raw).not.toContain("olumcwneiejjefhkzgmz");
    expect(raw).not.toContain("ycuofllsdssoezwwpqmv");
  });

  it("33. deze branch voegt geen pagina, route of navigatie-item toe", () => {
    const changed = changedFiles();
    if (!changed) return;
    expect(changed.filter((f) => f.startsWith("src/pages/"))).toEqual([]);
    expect(changed).not.toContain("src/App.tsx");
    expect(changed).not.toContain("src/lib/nav.ts");
    expect(changed).not.toContain("package.json");
    expect(changed).not.toContain("package-lock.json");
  });
});
