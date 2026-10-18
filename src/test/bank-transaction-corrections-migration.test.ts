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
 * Bankcorrecties v1.1 — PR 1: de backendfundering.
 *
 * Het échte gedrag (correcties via de echte schrijvers, de vrijgave-hold op
 * elk schrijfpad, fouten na elke stap en bij COMMIT, twee gelijktijdige
 * sessies, de volgorde van mutaties en grendels, rollback en opnieuw
 * toepassen) wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/bank-transaction-corrections/. CI heeft geen PostgreSQL;
 * deze test bewaakt de vorm van de migratie, haar grenzen en de samenhang met
 * het harnas en de uitrolcontroles.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261018120000_add_bank_transaction_corrections.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
/** SHA-256 van de migratie zoals beoordeeld. */
const REVIEWED_SHA256 = "4d297951c1da5a5c3147c42d24d869d488f73aae264cd9b8c0e8507803c92bf2";
const HARNESS = "supabase/tests/bank-transaction-corrections";
const ROLLOUT = "supabase/rollout/20261018120000_add_bank_transaction_corrections";

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
/** Zonder commentaar: de kop beschrijft juist wat er NIET gebeurt. */
const sql = raw
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const RPCS = ["reclassify_bank_transaction", "release_bank_transaction_posting", "return_bank_transaction_to_workflow"] as const;
const RPC_SIGNATURES: Record<(typeof RPCS)[number], string> = {
  reclassify_bank_transaction: "uuid, uuid, uuid, numeric, uuid, text, text",
  release_bank_transaction_posting: "uuid, uuid, uuid, text",
  return_bank_transaction_to_workflow: "uuid, uuid, text",
};
const TRIGGER_FUNCTIONS = [
  "enforce_bank_allocation_not_released",
  "enforce_bank_transaction_posting_event",
  "enforce_bank_transaction_posting_marker_delete",
  "enforce_bank_transaction_posting_marker_lineage",
  "enforce_bank_transaction_release_hold",
  "prevent_bank_transaction_posting_event_mutation",
  "prevent_bank_transaction_posting_marker_mutation",
] as const;
const ALL = [...RPCS, ...TRIGGER_FUNCTIONS];

/** Trigger → [tabel, ENABLE ALWAYS?]. Weigerende triggers ALWAYS, valideringstriggers niet. */
const TRIGGERS: Record<string, [string, boolean]> = {
  enforce_bank_transaction_posting_event_trigger: ["bank_transaction_posting_events", false],
  prevent_bank_transaction_posting_event_mutation_trigger: ["bank_transaction_posting_events", true],
  prevent_bank_transaction_posting_event_truncate_trigger: ["bank_transaction_posting_events", true],
  prevent_bank_transaction_posting_marker_update_trigger: ["bank_transaction_postings", true],
  prevent_bank_transaction_posting_marker_truncate_trigger: ["bank_transaction_postings", true],
  enforce_bank_transaction_posting_marker_delete_trigger: ["bank_transaction_postings", true],
  enforce_bank_transaction_posting_marker_lineage_trigger: ["bank_transaction_postings", true],
  enforce_bank_transaction_release_hold_trigger: ["bank_transactions", true],
  validate_bank_allocation_not_released_trigger: ["bank_transaction_allocations", false],
};

/** Het lichaam tussen `AS $$` en `$$;` van één functie — letterlijk, dus gelijk aan prosrc. */
function rawBody(name: string): string {
  const m = raw.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));
  if (!m) throw new Error(`functie ${name} niet gevonden`);
  return m[1];
}

/** Hetzelfde lichaam zonder commentaarregels. */
function body(name: string): string {
  return rawBody(name)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

/** De kop van één functie: alles van CREATE tot en met `AS $$`. */
function header(name: string): string {
  return raw.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$`))?.[0] ?? "";
}

/** Uitvoerbare SQL zonder commentaarregels en zonder de inhoud van stringliterals. */
function statements(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** SQL buiten de functielichamen: daar mag geen enkele datamutatie staan. */
const topLevel = sql.replace(/AS \$\$[\s\S]*?\$\$;/g, "AS $$ … $$;").replace(/\$migratie\$[\s\S]*?\$migratie\$/g, "…");

function git(...args: string[]): string[] | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("migratie 20261018120000 — vorm", () => {
  it("1. bestaat één keer, en sorteert na PR 0, 20261010120000 en PR H", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_add_bank_transaction_corrections.sql"))).toEqual([FILE]);
    const positie = files.indexOf(FILE);
    for (const prefix of ["20260921120000_", "20261002120000_", "20261010120000_", "20261017120000_"]) {
      const voorganger = files.findIndex((f) => f.startsWith(prefix));
      expect(voorganger, prefix).toBeGreaterThanOrEqual(0);
      expect(voorganger, prefix).toBeLessThan(positie);
    }
  });

  it("2. byte-voor-byte de beoordeelde versie (SHA-256 over de ruwe bytes)", () => {
    const sha256 = createHash("sha256").update(readFileSync(resolve(process.cwd(), MIGRATION))).digest("hex");
    expect(sha256).toBe(REVIEWED_SHA256);
  });

  it("3. precies tien functies: drie RPC's en zeven triggerfuncties, alle plpgsql, SECURITY DEFINER, vaste search_path, nooit STABLE", () => {
    const defs = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(/g)].map((m) => m[1]);
    expect(defs.sort()).toEqual(ALL.map((n) => `public.${n}`).sort());
    for (const name of ALL) {
      const h = header(name);
      expect(h, name).toMatch(/LANGUAGE plpgsql\n(?:VOLATILE\n)?SECURITY DEFINER\nSET search_path = public\nAS \$\$$/);
      expect(h, name).not.toMatch(/STABLE|IMMUTABLE/);
    }
    for (const name of TRIGGER_FUNCTIONS) expect(header(name), name).toMatch(/RETURNS trigger\n/);
    for (const name of RPCS) expect(header(name), name).toMatch(/RETURNS TABLE \(\n {2}outcome +text,\n {2}replayed +boolean,/);
    // De hold leest na het wachten op de rijgrendel een verse snapshot: expliciet VOLATILE.
    expect(header("enforce_bank_transaction_release_hold")).toMatch(/\nVOLATILE\n/);
  });

  it("4. uitvoerrecht: alleen de drie RPC's voor authenticated; triggerfuncties voor niemand", () => {
    for (const name of RPCS) {
      const sig = RPC_SIGNATURES[name];
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}(${sig})\n  FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${sig})\n  TO authenticated;`);
    }
    for (const name of TRIGGER_FUNCTIONS) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated, service_role;`);
    }
    const grants = statements(sql).filter((s) => /^GRANT\b/i.test(s));
    expect(grants.map((g) => g.replace(/\s+/g, " "))).toEqual([
      "GRANT SELECT ON TABLE public.bank_transaction_posting_events TO authenticated, service_role",
      ...RPCS.map((n) => `GRANT EXECUTE ON FUNCTION public.${n}(${RPC_SIGNATURES[n]}) TO authenticated`),
    ]);
  });

  it("5. negen triggers, idempotent; ENABLE ALWAYS precies voor de weigerende, niet voor de validerende", () => {
    expect(sql.match(/CREATE (?:CONSTRAINT )?TRIGGER/g)).toHaveLength(Object.keys(TRIGGERS).length);
    for (const [trigger, [table, always]] of Object.entries(TRIGGERS)) {
      expect(sql, trigger).toContain(`DROP TRIGGER IF EXISTS ${trigger} ON public.${table};`);
      expect(sql, trigger).toMatch(new RegExp(`CREATE (?:CONSTRAINT )?TRIGGER ${trigger}\\n`));
      const enabled = sql.includes(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${trigger};`);
      expect(enabled, trigger).toBe(always);
    }
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER enforce_bank_transaction_posting_marker_lineage_trigger\nAFTER DELETE ON public\.bank_transaction_postings\nDEFERRABLE INITIALLY DEFERRED\n/);
    expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role/i);
  });

  it("6. de gebeurtenistabel: append-only, alleen lezen voor applicatierollen, RLS vanaf read_only, idempotentiesleutel en volgorde", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.bank_transaction_posting_events \(/);
    expect(sql).toMatch(/seq +bigint GENERATED ALWAYS AS IDENTITY/);
    expect(sql).toContain("UNIQUE (actor_id, request_id, event_type)");
    expect(sql).toContain("CHECK (event_type IN ('posted', 'reclassified', 'reposted', 'released', 'returned', 'unchanged'))");
    // Eén request_id is één handeling (alleen het returned vóór een herboeking deelt hem).
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS bank_transaction_posting_events_request_once\s+ON public\.bank_transaction_posting_events \(actor_id, request_id\)\s+WHERE NOT \(event_type = 'returned' AND request_kind = 'reclassify'\);/);
    for (const col of ["superseded_posting_group_id", "reversal_posting_group_id", "replacement_posting_group_id", "seq"]) {
      expect(sql, col).toMatch(new RegExp(`UNIQUE \\(${col}\\)`));
    }
    expect(sql).toContain("REVOKE ALL ON TABLE public.bank_transaction_posting_events FROM PUBLIC, anon, authenticated, service_role;");
    expect(sql).toContain("REVOKE ALL ON SEQUENCE public.bank_transaction_posting_events_seq_seq FROM PUBLIC, anon, authenticated, service_role;");
    expect(sql).toContain("ALTER TABLE public.bank_transaction_posting_events ENABLE ROW LEVEL SECURITY;");
    const policies = statements(sql).filter((s) => /^CREATE POLICY/i.test(s));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/FOR SELECT TO authenticated\s+USING \(public\.has_min_role\(auth\.uid\(\), organization_id, ''\)\)/);
    expect(sql).toMatch(/has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)/);
    // Elke vervangen groep heeft een tegenboeking; een vrijgave heeft geen opvolger.
    expect(sql).toMatch(/event_type = 'released' AND request_kind = 'release'\s+AND superseded_posting_group_id IS NOT NULL AND reversal_posting_group_id IS NOT NULL\s+AND replacement_posting_group_id IS NULL/);
  });
});

describe("de RPC's — volgorde van controles en mutaties", () => {
  it("7. autorisatie vóór onthulling: argumenten → rijgrendel → leesdrempel → schrijfdrempel → herhaling op (actor, request_id) → tenant → blokkade → administratie FOR SHARE → toestand", () => {
    for (const name of RPCS) {
      const b = body(name);
      const order = [
        b.indexOf("IF v_uid IS NULL THEN"),
        b.indexOf("current_setting('transaction_isolation') <> 'read committed'"),
        b.search(/FROM public\.bank_transactions bt\s+WHERE bt\.id = _transaction_id\s+FOR UPDATE;/),
        b.indexOf("RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';"),
        b.search(/WHERE e\.actor_id = v_uid AND e\.request_id = _request_id/),
        // Tenantconsistentie zonder grendel vóór de blokkade: die zegt of grendelt nooit iets van een andere tenant.
        b.search(/IF NOT EXISTS \(SELECT 1 FROM public\.clients c\s+WHERE c\.id = v_tx\.client_id AND c\.organization_id = v_tx\.organization_id\) THEN\s+RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';/),
        b.indexOf("PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);"),
        b.search(/FROM public\.clients c\s+WHERE c\.id = v_tx\.client_id\s+FOR SHARE;/),
        b.search(/FROM public\.bank_transaction_(postings m|posting_events e\s+WHERE e\.bank_transaction_id = v_tx\.id)/),
      ];
      for (const [i, pos] of order.entries()) expect(pos, `${name} stap ${i}`).toBeGreaterThan(0);
      expect([...order].sort((x, y) => x - y), name).toEqual(order);
    }
  });

  it("8. geen EXCEPTION-blok in de RPC's: elke fout draait de hele aanroep terug", () => {
    for (const name of RPCS) expect(body(name), name).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
  });

  it("9. grootboekregels uitsluitend via de bestaande schrijvers, op de oorspronkelijke transactiedatum", () => {
    expect(raw).not.toMatch(/INSERT INTO public\.ledger_postings/);
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_reversal_postings|UPDATE public\.ledger_|DELETE FROM public\.ledger_/);
    expect(body("reclassify_bank_transaction")).toContain("v_new_group := public.post_bank_transaction(v_tx.id);");
    for (const name of ["reclassify_bank_transaction", "release_bank_transaction_posting"]) {
      expect(body(name), name).toContain("public.reverse_posting_group(v_marker.posting_group_id, v_tx.transaction_date, v_reason)");
    }
  });

  it("10. de mutaties in vaste volgorde; de vrijgave legt haar gebeurtenis als allerlaatste vast, herboeken na vrijgave begint met returned", () => {
    const rc = body("reclassify_bank_transaction");
    const steps = [
      rc.indexOf("v_reversal := public.reverse_posting_group("),
      rc.indexOf("DELETE FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id;"),
      rc.indexOf("'reclassify', 'returned',"),
      rc.indexOf("UPDATE public.bank_transactions bt SET"),
      rc.indexOf("v_new_group := public.post_bank_transaction(v_tx.id);"),
      rc.lastIndexOf("INSERT INTO public.bank_transaction_posting_events ("),
    ];
    for (const pos of steps) expect(pos).toBeGreaterThan(0);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);

    const rel = body("release_bank_transaction_posting");
    const r = [
      rel.indexOf("v_reversal := public.reverse_posting_group("),
      rel.indexOf("DELETE FROM public.bank_transaction_postings m"),
      rel.indexOf("match_status         = 'niet_gematcht'"),
      rel.indexOf("INSERT INTO public.bank_transaction_posting_events ("),
    ];
    for (const pos of r) expect(pos).toBeGreaterThan(0);
    expect([...r].sort((x, y) => x - y)).toEqual(r);
  });

  it("11. rollen: eerste boeking assistant; elke handeling op een geboekte of vrijgegeven transactie accountant mét toelichting (T9)", () => {
    const rc = body("reclassify_bank_transaction");
    expect(rc).toMatch(/IF v_state <> 'S0' THEN\s+IF NOT public\.has_min_role\(v_uid, v_tx\.organization_id, 'accountant'\) THEN/);
    expect(rc).toMatch(/IF v_reason IS NULL THEN\s+RAISE EXCEPTION 'Een toelichting \(1 tot 500 tekens\) is verplicht/);
    for (const name of ["release_bank_transaction_posting", "return_bank_transaction_to_workflow"]) {
      const b = body(name);
      expect(b, name).toMatch(/IF NOT public\.has_min_role\(v_uid, v_tx\.organization_id, 'accountant'\) THEN/);
      expect(b, name).toMatch(/IF v_reason IS NULL THEN\s+RAISE EXCEPTION 'Een toelichting \(1 tot 500 tekens\) is verplicht/);
    }
  });

  it("12. besluiten in de code: 0/9/21 procent (D11), vrijgesteld alleen 0, rekening actief (T8), configuratiedrift weigert (D7), koppelingen buiten v1", () => {
    const rc = body("reclassify_bank_transaction");
    expect(rc).toContain("IF _btw_percentage NOT IN (0, 9, 21) THEN");
    expect(rc).toMatch(/IF COALESCE\(v_client\.btw_vrijgesteld, false\) AND _btw_percentage <> 0 THEN/);
    expect(rc).toMatch(/IF NOT FOUND OR NOT COALESCE\(v_account\.actief, false\) THEN/);
    // De rekening FOR SHARE tot COMMIT, ná de reikwijdtetoets: geen deactivering tussen toets en boeking.
    const scope = rc.indexOf("IF NOT public.posting_account_ok(_grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN");
    const lock = rc.search(/FROM public\.grootboekrekeningen g\s+WHERE g\.id = _grootboekrekening_id\s+FOR SHARE;/);
    expect(scope).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(scope);
    expect(rc).toContain("IF v_line_acct IS DISTINCT FROM v_client.bank_rekening_id THEN");
    expect(rc).toContain("IF v_line_acct IS DISTINCT FROM v_vat_acct THEN");
    for (const name of RPCS) {
      expect(body(name), name).toMatch(/FROM public\.bank_transaction_allocations a WHERE a\.bank_transaction_id = v_tx\.id\) THEN\s+RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie'/);
    }
    // Ook een oudere koppeling via de match (geen koppelingsrij): de RPC herrekent geen facturen.
    for (const name of ["reclassify_bank_transaction", "release_bank_transaction_posting"]) {
      expect(body(name), name).toMatch(/IF v_tx\.matched_invoice_id IS NOT NULL AND v_tx\.match_status IS DISTINCT FROM 'suggestie' THEN\s+RAISE EXCEPTION 'Deze banktransactie is via de match aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';/);
    }
  });

  it("12b. een bestaande storno op een latere datum: herboeken (S2/S3), vrijgeven (S2) en terugzetten weigeren — anders staat de periode daartussen dubbel", () => {
    const rule = /SELECT r\.posting_date INTO v_rev_date\s+FROM public\.ledger_reversal_postings r\s+WHERE r\.reversal_posting_group_id = [^;]+;\s+IF v_rev_date IS DISTINCT FROM v_tx\.transaction_date THEN\s+RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %:[^']*memoriaalboeking\.',\s+v_rev_date, v_tx\.transaction_date\s+USING ERRCODE = '22023';/;
    for (const name of RPCS) expect(body(name), name).toMatch(rule);
    expect(body("reclassify_bank_transaction")).toMatch(/IF v_state IN \('S2', 'S3'\) THEN\s+SELECT r\.posting_date INTO v_rev_date/);
    expect(body("release_bank_transaction_posting")).toMatch(/IF v_state = 'S2' THEN\s+SELECT r\.posting_date INTO v_rev_date/);
    // De eigen storno van de RPC staat altijd op de transactiedatum (zie test 9).
  });

  it("12c. ook een herclassificatie die niets hoeft te doen legt haar aanvraag vast: een herhaling geeft exact dat antwoord", () => {
    const rc = body("reclassify_bank_transaction");
    const insert = rc.indexOf("_request_id, v_uid, 'reclassify', 'unchanged',");
    const answer = rc.indexOf("RETURN QUERY SELECT 'unchanged'::text, false, v_marker.posting_group_id, NULL::uuid, NULL::uuid, v_event;");
    expect(insert).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(insert);
    expect(rc).toContain("v_prev.event_type NOT IN ('posted', 'reclassified', 'reposted', 'unchanged')");
  });

  it("13. een verouderde toestand is 55000, nooit 40001; geen 23505 uit eigen code", () => {
    for (const name of RPCS) {
      const b = body(name);
      expect(b, name).toContain("'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000'");
      expect(b, name).not.toMatch(/ERRCODE = '(40001|23505)'/);
    }
  });

  it("14. de administratiegrendel alleen via assert_posting_allowed; geen directe aanroep van de interne grendelfuncties", () => {
    for (const name of ALL) {
      expect(body(name), name).not.toMatch(/\block_ledger_client\s*\(|(?<!assert_)\bposting_allowed\s*\(/);
    }
    for (const name of RPCS) expect(body(name), name).toContain("PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);");
  });
});

describe("de triggers — integriteit, geen autorisatie", () => {
  it("15. geen auth.uid(), rol of current_user in een triggerfunctie (patterns §5B)", () => {
    for (const name of TRIGGER_FUNCTIONS) {
      expect(body(name), name).not.toMatch(/auth\.uid|has_min_role|current_user|session_user/);
    }
  });

  it("16. de marker: losmaken alleen na een tegenboeking, en bij COMMIT een gebeurtenis uit dezelfde transactie", () => {
    expect(body("enforce_bank_transaction_posting_marker_delete")).toMatch(
      /FROM public\.ledger_reversal_postings r\s+WHERE r\.original_posting_group_id = OLD\.posting_group_id/,
    );
    expect(body("enforce_bank_transaction_posting_marker_lineage")).toMatch(
      /e\.superseded_posting_group_id = OLD\.posting_group_id\s+AND e\.created_xact_id = pg_current_xact_id\(\)/,
    );
  });

  it("17. de hold: vrijgegeven = laatste gebeurtenis released én elke directe bankgroep al vervangen; identiteit bevroren zodra er historie is", () => {
    const b = body("enforce_bank_transaction_release_hold");
    expect(b).toMatch(/ORDER BY e\.seq DESC\s+LIMIT 1;/);
    expect(b).toMatch(/IF v_last = 'released' AND v_coding_changed\s+AND NOT EXISTS \(/);
    expect(b).toMatch(/IF v_identity_changed THEN/);
    for (const f of ["match_status", "grootboekrekening_id", "btw_percentage", "matched_invoice_id", "match_confidence",
                     "amount", "transaction_date", "client_id", "organization_id", "user_id"]) {
      expect(b, f).toMatch(new RegExp(`NEW\\.${f}\\s+IS DISTINCT FROM OLD\\.${f}`));
    }
    // De koppelingshold: eerst READ COMMITTED en tenant (neutraal), dan de hold.
    const a = body("enforce_bank_allocation_not_released");
    expect(a.indexOf("transaction_isolation")).toBeLessThan(a.indexOf("FOR KEY SHARE"));
    expect(a.indexOf("'Banktransactie niet beschikbaar' USING ERRCODE = '42501'")).toBeLessThan(a.indexOf("v_last = 'released'"));
  });
});

describe("wat de migratie niet doet", () => {
  it("18. geen datamutatie buiten de functies, geen wijziging van bestaande tabellen of functies", () => {
    // Zonder de inhoud van stringliterals: het COMMENT ON-commentaar noemt juist wat er geweigerd wordt.
    const code = statements(topLevel).join(";\n");
    for (const stmt of statements(topLevel)) expect(stmt.slice(0, 60)).not.toMatch(/^(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY)\b/i);
    for (const stmt of statements(topLevel).filter((s) => /^ALTER TABLE/i.test(s))) {
      expect(stmt.replace(/\s+/g, " ")).toMatch(/^ALTER TABLE public\.\w+ ENABLE (ALWAYS TRIGGER \w+|ROW LEVEL SECURITY)$/);
    }
    expect(code).not.toMatch(/\bADD COLUMN\b|\bDROP COLUMN\b|\bRENAME\b|\bALTER COLUMN\b|ALTER FUNCTION|DROP TABLE|CASCADE/i);
    // Geen enkele bestaande functie opnieuw gedefinieerd.
    const bestaand = new Set<string>();
    for (const f of readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((x) => x.endsWith(".sql") && x !== FILE)) {
      const text = readFileSync(resolve(process.cwd(), MIGRATION_DIR, f), "utf8");
      for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)) bestaand.add(m[1].toLowerCase());
    }
    for (const name of ALL) expect(bestaand.has(name), name).toBe(false);
  });

  it("19. faalt gesloten zonder de tabellen, schrijvers, kolommen en PR 0", () => {
    for (const t of ["bank_transactions", "bank_transaction_postings", "bank_transaction_allocations", "ledger_postings", "ledger_reversal_postings"]) {
      expect(sql).toContain(`to_regclass('public.${t}') IS NULL`);
    }
    for (const p of ["post_bank_transaction(uuid)", "reverse_posting_group(uuid,date,text)", "assert_posting_allowed(uuid,date)",
                     "enforce_bank_direct_posting_without_allocations()", "enforce_bank_allocation_not_directly_posted()"]) {
      expect(sql, p).toContain(`to_regprocedure('public.${p}') IS NULL`);
    }
  });

  it("20. een gedocumenteerde functionele rollback: RPC's, markerbewaking en hold weg, de gebeurtenistabel en haar bewaking blijven", () => {
    const block = raw.match(/-- ROLLBACK-BEGIN\n([\s\S]*?)-- ROLLBACK-END/)?.[1] ?? "";
    const lines = block.split("\n").filter(Boolean).map((l) => l.replace(/^-- {3}/, ""));
    expect(lines.slice(0, 3)).toEqual(RPCS.slice().reverse().map((n) => `DROP FUNCTION IF EXISTS public.${n}(${RPC_SIGNATURES[n]});`));
    const dropped = lines.map((l) => l.match(/DROP (?:TRIGGER|FUNCTION) IF EXISTS (?:public\.)?(\w+)/)?.[1]);
    for (const [trigger, [table]] of Object.entries(TRIGGERS)) {
      expect(dropped.includes(trigger), trigger).toBe(table !== "bank_transaction_posting_events");
    }
    expect(dropped).not.toContain("enforce_bank_transaction_posting_event");
    expect(dropped).not.toContain("prevent_bank_transaction_posting_event_mutation");
    expect(block).not.toMatch(/DROP TABLE|CASCADE/i);
    expect(raw).not.toMatch(/olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/);
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
  });
});

describe("harnas en uitrolcontroles", () => {
  it("21. het echt-PostgreSQL-harnas: echte keten incl. PR 0, negatieve controle vóór de migratie, twee keer toepassen, fouten, volgorde, races, rollback en opnieuw toepassen", () => {
    const run = readFileSync(resolve(process.cwd(), `${HARNESS}/run-proof.sh`), "utf8");
    expect(run).toMatch(/THROWAWAY DATABASE ONLY/);
    for (const f of [
      "20260917120000_add_bank_settlement_posting", "20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39",
      "20260921120000_add_ledger_reversal_posting", "20260922120000_add_bank_bulk_posting",
      "20260928120000_enforce_posting_lock", "20261002120000_decouple_year_watermark_from_posting",
      "20261017120000_guard_direct_bank_posting_against_allocations",
    ]) {
      expect(run, f).toContain(f);
    }
    expect(run.indexOf('"$HERE/pre.sql"')).toBeLessThan(run.indexOf('run -f "$M"'));
    expect(run.match(/^run -f "\$M"/gm)).toHaveLength(3);
    expect(run.match(/^run -c "\$ROLLBACK"/gm)).toHaveLength(2);
    for (const f of ["proof.sql", "faults.sql", "order.sql", "concurrency.sql", "rollback.sql", "final.sql"]) {
      expect(run, f).toContain(`"$HERE/${f}"`);
    }
    // Een bewijs dat stil wegvalt telt als fout.
    expect(run).toContain("proof.expected");
  });

  it("22. het harnas boekt uitsluitend via de echte schrijvers en RPC's", () => {
    const fixtures = readFileSync(resolve(process.cwd(), `${HARNESS}/fixtures.sql`), "utf8");
    expect(fixtures).not.toMatch(/INSERT INTO public\.(ledger_postings|bank_transaction_postings|bank_allocation_postings|ledger_reversal_postings|bank_transaction_posting_events)/);
    expect(fixtures).toMatch(/SET LOCAL ROLE %I/);
  });

  it("23. PRE en POST bestaan, zijn alleen-lezen (elke opdracht is een SELECT) en noemen het juiste project", () => {
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      const path = resolve(process.cwd(), `${ROLLOUT}/${f}`);
      expect(existsSync(path), f).toBe(true);
      const text = readFileSync(path, "utf8");
      const stmts = statements(text);
      expect(stmts.length, f).toBeGreaterThan(5);
      for (const s of stmts) expect(s.slice(0, 60), f).toMatch(/^(SELECT|WITH)\b/i);
      expect(text, f).toContain("alxlbdhpbwlehbdbfejw");
      for (const line of text.split("\n").filter((l) => /olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/.test(l))) {
        expect(line, f).toMatch(/nooit|never/i);
      }
    }
    expect(readFileSync(resolve(process.cwd(), `${ROLLOUT}/preflight.sql`), "utf8")).toMatch(/AS stop;/);
  });

  it("24. POST pint alle tien functielichamen: md5 per functie is die van het lichaam in de migratie", () => {
    const post = readFileSync(resolve(process.cwd(), `${ROLLOUT}/postcheck.sql`), "utf8");
    for (const name of ALL) {
      const md5 = createHash("md5").update(rawBody(name), "utf8").digest("hex");
      expect(post, name).toMatch(new RegExp(`\\('${name}',\\s+'${md5}',\\s+(true|false)\\)`));
    }
  });
});

describe("branch-grenzen", () => {
  const changed = git("diff", "--name-only", "origin/main...HEAD");
  const introducedHere =
    git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD")?.includes(MIGRATION) ?? false;

  it("25. geen bestaande migratie gewijzigd, verwijderd, hernoemd of van type veranderd", (ctx) => {
    const existing = git("diff", "--name-only", "--diff-filter=MDRT", "origin/main...HEAD", "--", MIGRATION_DIR);
    if (!existing) return ctx.skip();
    expect(existing).toEqual([]);
  });

  it("26. op de branch die PR 1 invoert: geen app, geen gegenereerde types, geen packages; fundering en schrijvers onaangeroerd", (ctx) => {
    if (!changed || !introducedHere) return ctx.skip();
    for (const f of [
      "src/integrations/supabase/types.ts", "package.json", "package-lock.json",
      "src/pages/Bank.tsx", "src/pages/Facturen.tsx", "src/pages/Verkoop.tsx",
      "supabase/functions/mcp/index.ts", ".lovable/mcp/manifest.json",
    ]) {
      expect(changed, f).not.toContain(f);
    }
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed.filter((f) => f.startsWith("supabase/functions/"))).toEqual([]);
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });
});
