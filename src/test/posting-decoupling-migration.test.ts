import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertBranchSqlKeepsLedgerFoundation, assertBranchTouchesNoExistingWriter } from "./support/branch-sql-scope";
import { appFilesMatching } from "./support/app-sources";

/**
 * 6C-b11 PR H — de ontkoppeling: het jaarwatermerk is geen boekingstoets meer.
 *
 * Wat hier bewaakt wordt, in twee lagen:
 *
 *   1. DE MIGRATIE ZELF is afgeleid, niet geschreven: elk lichaam is dat van
 *      PR D (20260928120000) met uitsluitend het watermerkblok weg. Deze test
 *      leidt dat opnieuw af en eist gelijkheid. Eén extra of ontbrekende regel
 *      in welke schrijver dan ook laat hem omvallen.
 *
 *   2. DE INVARIANT NA DE ONTKOPPELING, gelezen uit de LAATSTE definitie van
 *      elke functie over alle migraties heen (niet uit één bestand): de zeven
 *      gedateerde schrijvers toetsen de blokkade en niet het watermerk; de
 *      nihilverklaring houdt haar levenscyclusregel; de levenscyclusfuncties
 *      raken de blokkade niet en de blokkadefuncties de levenscyclus niet.
 *
 * De gedragsbewijzen (weigert vóór, boekt ná; rollback exact) staan in
 * supabase/tests/posting-decoupled/ tegen een echte PostgreSQL.
 */

const MIGRATION_DIR = "supabase/migrations";
const MIGRATION = `${MIGRATION_DIR}/20261002120000_decouple_year_watermark_from_posting.sql`;
const PRD = `${MIGRATION_DIR}/20260928120000_enforce_posting_lock.sql`;

const lees = (pad: string) => readFileSync(resolve(process.cwd(), pad), "utf8");
const sql = lees(MIGRATION);
const prd = lees(PRD);

/** Commentaar weg en witruimte genormaliseerd: een bewering over CODE. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((r) => !r.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Eén functie, van haar CREATE tot en met de afsluitende `$$;`. */
function functie(text: string, naam: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${naam}(`);
  if (start < 0) return "";
  const end = text.indexOf("\n$$;\n", start);
  return text.slice(start, end + "\n$$;\n".length);
}

const SCHRIJVERS = [
  "post_purchase_invoice",
  "post_sales_invoice",
  "post_bank_allocation",
  "post_manual_journal",
  "post_opening_balance",
  "reverse_posting_group",
  "post_bank_transaction",
] as const;

const GUARD = /IF v_client\.afgesloten_boekjaar IS NOT NULL AND [\w.]+ <= v_client\.afgesloten_boekjaar THEN\s*RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', [\w.]+\s*USING ERRCODE = '22023'; END IF;/;

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const changed = git("diff", "--name-only", "origin/main...HEAD");
const introducedHere = git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD").includes(MIGRATION);

describe("De migratie is afgeleid uit PR D", () => {
  it("1. bestaat, ligt na elke andere migratie en definieert precies acht functies", () => {
    const alle = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(alle[alle.length - 1]).toBe("20261002120000_decouple_year_watermark_from_posting.sql");
    const namen = [...code(sql).matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(namen).toEqual([...SCHRIJVERS, "bank_bulk_posting_candidates"]);
  });

  it("2. elke gedateerde schrijver is PR D met uitsluitend het watermerkblok weg", () => {
    for (const naam of SCHRIJVERS) {
      const oud = code(functie(prd, naam));
      const nieuw = code(functie(sql, naam));
      expect(oud, `${naam} in PR D`).not.toBe("");
      expect(nieuw, `${naam} in PR H`).not.toBe("");
      expect(oud, `${naam}: PR D droeg het watermerkblok`).toMatch(GUARD);
      // Afgeleid: PR D zonder het blok moet LETTERLIJK het nieuwe lichaam zijn.
      const afgeleid = oud.replace(GUARD, "").replace(/\s+/g, " ").trim();
      expect(nieuw, `${naam}: alleen het watermerkblok verschilt`).toBe(afgeleid);
      expect(nieuw, naam).not.toMatch(/afgesloten_boekjaar/);
      expect(nieuw, naam).not.toMatch(/is afgesloten voor deze administratie/);
    }
  });

  it("3. de blokkadetoets staat bij alle zeven ongewijzigd op zijn plek, vóór de eerste grootboekregel", () => {
    const ARGUMENTEN: Record<string, string> = {
      post_purchase_invoice: "v_inv.client_id, v_inv.invoice_date",
      post_sales_invoice: "v_inv.client_id, v_inv.invoice_date",
      post_bank_allocation: "v_alloc.client_id, v_tx.transaction_date",
      post_manual_journal: "v_journal.client_id, v_journal.posting_date",
      post_opening_balance: "v_header.client_id, v_header.opening_date",
      reverse_posting_group: "v_client_id, _posting_date",
      post_bank_transaction: "v_tx.client_id, v_tx.transaction_date",
    };
    for (const naam of SCHRIJVERS) {
      const body = code(functie(sql, naam));
      const toets = `PERFORM public.assert_posting_allowed(${ARGUMENTEN[naam]});`;
      expect(body, naam).toContain(toets);
      expect(body.indexOf(toets), `${naam}: toets vóór INSERT`).toBeLessThan(body.indexOf("INSERT INTO public.ledger_postings"));
      expect(body.indexOf("Geen rechten"), `${naam}: rechten vóór de toets`).toBeLessThan(body.indexOf(toets));
    }
  });

  it("4. de bulk-preflight is PR D met uitsluitend de twee watermerk-armen weg", () => {
    const oud = code(functie(prd, "bank_bulk_posting_candidates"));
    const nieuw = code(functie(sql, "bank_bulk_posting_candidates"));
    const ARM = /WHEN c\.afgesloten_boekjaar IS NOT NULL AND EXTRACT\(YEAR FROM t\.transaction_date\)::integer <= c\.afgesloten_boekjaar THEN .*?(?= WHEN c\.posting_locked_through)/g;
    expect(oud.match(ARM)).toHaveLength(2);
    expect(nieuw).toBe(oud.replace(ARM, "").replace(/\s+/g, " ").trim());
    expect(nieuw).not.toMatch(/afgesloten_boekjaar/);
    expect(nieuw).toContain("WHEN c.posting_locked_through IS NOT NULL AND t.transaction_date <= c.posting_locked_through THEN 'blocked'");
  });

  it("5. faalt gesloten: zonder blokkadetoets in een schrijver wordt het watermerk daar niet weggehaald", () => {
    const vereisten = code(sql.slice(0, sql.indexOf("-- ── 1.")));
    for (const naam of SCHRIJVERS) expect(vereisten).toContain(`'${naam}'`);
    expect(vereisten).toContain("position('assert_posting_allowed(' IN v_src) = 0");
    expect(vereisten).toMatch(/RAISE EXCEPTION 'PR H geweigerd/);
    for (const f of ["posting_allowed(uuid,date)", "assert_posting_allowed(uuid,date)", "set_posting_lock(uuid,date,text)", "reopen_fiscal_year(uuid,integer,text)"]) {
      expect(vereisten, f).toContain(`to_regprocedure('public.${f}')`);
    }
  });

  it("5b. anti-clobber: elke doelfunctie heeft precies één toegestane VÓÓR- en één NÁ-hash, exact vergeleken", () => {
    const vereisten = code(sql.slice(0, sql.indexOf("-- ── 1.")));
    const DOEL = [...SCHRIJVERS, "bank_bulk_posting_candidates"];
    const MD5 = /^[0-9a-f]{32}$/;
    const voor = new Map<string, string>();
    const na = new Map<string, string>();
    const blokVoor = vereisten.slice(vereisten.indexOf("v_voor := CASE v_naam"), vereisten.indexOf("END;", vereisten.indexOf("v_voor := CASE v_naam")));
    const blokNa = vereisten.slice(vereisten.indexOf("v_na := CASE v_naam"), vereisten.indexOf("END;", vereisten.indexOf("v_na := CASE v_naam")));
    for (const naam of DOEL) {
      const mv = blokVoor.match(new RegExp(`WHEN '${naam}' THEN '([0-9a-f]+)'`));
      const mn = blokNa.match(new RegExp(`WHEN '${naam}' THEN '([0-9a-f]+)'`));
      expect(mv?.[1], `${naam}: VÓÓR-hash`).toMatch(MD5);
      expect(mn?.[1], `${naam}: NÁ-hash`).toMatch(MD5);
      expect(mv![1], `${naam}: vóór ≠ ná`).not.toBe(mn![1]);
      voor.set(naam, mv![1]);
      na.set(naam, mn![1]);
    }
    // Acht verschillende functies, zestien verschillende hashes.
    expect(new Set([...voor.values(), ...na.values()]).size).toBe(16);
    // De hash komt uit md5(prosrc), en de vergelijking is exact: geen LIKE,
    // position(), substring of prefix. Een derde lichaam kan dus nooit slagen.
    expect(vereisten).toContain("SELECT md5(p.prosrc) INTO v_hash");
    expect(vereisten).toContain("IF v_hash <> v_voor AND v_hash <> v_na THEN RAISE EXCEPTION 'PR H geweigerd: public.%() heeft een onbekend lichaam");
    expect(vereisten).toMatch(/Niets is gewijzigd\. Onderzoek handmatig/);
    const hashToets = vereisten.slice(vereisten.indexOf("Anti-clobber") >= 0 ? 0 : 0);
    expect(hashToets.slice(hashToets.indexOf("v_voor := CASE"))).not.toMatch(/v_hash (LIKE|ILIKE|~)|position\([^)]*v_hash|left\(v_hash|substr/);
    // En de toets staat vóór elke CREATE OR REPLACE.
    expect(sql.indexOf("v_hash <> v_voor")).toBeLessThan(sql.indexOf("CREATE OR REPLACE FUNCTION public.post_purchase_invoice("));
  });

  it("5c. de VÓÓR-hashes zijn md5 van de PR D-lichamen en de NÁ-hashes md5 van de lichamen in dit bestand", () => {
    /*
     * prosrc is exact de tekst tussen de dollar-quotes: vanaf de newline na
     * `AS $$` tot en met de newline vóór `$$;`. Dat is hier na te rekenen, dus
     * de hashes in de migratie zijn geen overgeschreven getallen maar een
     * afgeleide van de bestanden zelf — en ze vallen om zodra iemand aan een
     * lichaam of aan een hash sleutelt.
     */
    const prosrc = (text: string, naam: string) => {
      const f = functie(text, naam);
      const start = f.indexOf("AS $$") + "AS $$".length;
      const end = f.lastIndexOf("$$;");
      return f.slice(start, end);
    };
    const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");
    const vereisten = code(sql.slice(0, sql.indexOf("-- ── 1.")));
    for (const naam of [...SCHRIJVERS, "bank_bulk_posting_candidates"]) {
      const v = vereisten.match(new RegExp(`v_voor := CASE v_naam[^;]*WHEN '${naam}' THEN '([0-9a-f]{32})'`))![1];
      const n = vereisten.match(new RegExp(`v_na := CASE v_naam[^;]*WHEN '${naam}' THEN '([0-9a-f]{32})'`))![1];
      expect(md5(prosrc(prd, naam)), `${naam}: vóór = md5(PR D)`).toBe(v);
      expect(md5(prosrc(sql, naam)), `${naam}: ná = md5(PR H)`).toBe(n);
    }
  });

  it("6. raakt niets anders: geen tabel, geen kolom, geen recht, geen levenscyclus- of blokkadefunctie", () => {
    // Buiten de acht (letterlijk overgenomen) functielichamen staat geen DDL
    // en geen DML: alleen de vereisten-controle en één COMMENT.
    let buiten = sql;
    for (const naam of [...SCHRIJVERS, "bank_bulk_posting_candidates"]) buiten = buiten.replace(functie(sql, naam), "");
    const c = code(buiten);
    expect(c).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP |TRUNCATE|GRANT |REVOKE |CREATE TRIGGER|CREATE POLICY|UPDATE public\.|INSERT INTO|DELETE FROM/);
    expect(c).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    for (const naam of ["declare_opening_balance_nil", "close_fiscal_year", "reopen_fiscal_year", "set_posting_lock", "posting_allowed", "assert_posting_allowed", "enforce_year_close_watermark", "prevent_year_closure_mutation", "post_bank_transactions_bulk"]) {
      expect(c, naam).not.toContain(`CREATE OR REPLACE FUNCTION public.${naam}(`);
    }
    // Alleen de COMMENT van de assertie; haar lichaam blijft.
    expect(c).toContain("COMMENT ON FUNCTION public.assert_posting_allowed(uuid, date) IS");
    // Geen resultaatboeking, geen doorrol, geen automatische blokkade.
    expect(c).not.toMatch(/result_cents|resultaat_rekening|carry_forward|doorrol|9998|9999/i);
    expect(c).not.toMatch(/SET posting_locked_through|SET afgesloten_boekjaar/);
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });

  it("7. geen bestaande migratie gewijzigd; de gegenereerde types onaangeroerd", () => {
    expect(git("diff", "--name-only", "--diff-filter=MDR", "origin/main...HEAD", "--", MIGRATION_DIR)).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    if (introducedHere) {
      // De branch die PR H invoert raakt geen UI: dit is een backendstap.
      expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    }
  });
});

// ── De invariant, over alle migraties heen ──────────────────────────────────

/** De LAATSTE definitie van elke publieke functie, in migratievolgorde. */
function laatsteDefinities(): Map<string, string> {
  const map = new Map<string, string>();
  for (const bestand of readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    const tekst = lees(`${MIGRATION_DIR}/${bestand}`);
    for (const m of tekst.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)) {
      map.set(m[1], code(functie(tekst, m[1])));
    }
  }
  return map;
}

const definities = laatsteDefinities();
const LEVENSCYCLUS = ["close_fiscal_year", "reopen_fiscal_year", "enforce_year_close_watermark", "prevent_year_closure_mutation"];
const BLOKKADE = ["set_posting_lock", "posting_allowed", "assert_posting_allowed", "enforce_posting_lock_change"];

describe("De invariant na de ontkoppeling", () => {
  it("8. geen enkele gedateerde schrijver toetst het watermerk nog; alle zeven toetsen de blokkade", () => {
    for (const naam of SCHRIJVERS) {
      const body = definities.get(naam) ?? "";
      expect(body, naam).not.toBe("");
      expect(body, `${naam}: geen watermerktoets`).not.toMatch(/afgesloten_boekjaar/);
      expect(body, `${naam}: wel de blokkadetoets`).toContain("PERFORM public.assert_posting_allowed(");
    }
  });

  it("9. de nihilverklaring houdt haar levenscyclusregel en kent de blokkade niet", () => {
    const nil = definities.get("declare_opening_balance_nil") ?? "";
    expect(nil).toMatch(GUARD);
    expect(nil).not.toMatch(/posting_allowed|posting_locked_through|INSERT INTO public\.ledger_postings/);
  });

  it("10. elke functie die een grootboekregel schrijft, is een van de zeven en toetst de blokkade", () => {
    const schrijvers = [...definities.entries()]
      .filter(([, body]) => body.includes("INSERT INTO public.ledger_postings"))
      .map(([naam]) => naam)
      .sort();
    expect(schrijvers).toEqual([...SCHRIJVERS].sort());
    for (const naam of schrijvers) {
      expect(definities.get(naam), naam).toContain("assert_posting_allowed(");
    }
    // De bulk-orkestratie en de preflight schrijven niet en oordelen niet zelf.
    expect(definities.get("post_bank_transactions_bulk")).toContain("public.post_bank_transaction(");
    expect(definities.get("post_bank_transactions_bulk")).not.toMatch(/afgesloten_boekjaar|posting_locked_through|INSERT INTO public\.ledger_postings/);
    expect(definities.get("bank_bulk_posting_candidates")).not.toMatch(/afgesloten_boekjaar/);
    expect(definities.get("bank_bulk_posting_candidates")).toContain("posting_locked_through");
  });

  it("11. de levenscyclusfuncties dragen het watermerk en raken de blokkade niet", () => {
    for (const naam of LEVENSCYCLUS) {
      const body = definities.get(naam) ?? "";
      expect(body, naam).not.toBe("");
      expect(body, `${naam}: geen blokkade`).not.toMatch(/posting_locked_through|set_posting_lock|posting_lock_events|posting_allowed/);
    }
    // Het watermerk wordt gezet, verlaagd en bewaakt door precies deze drie;
    // de vierde bewaakt year_closures.status en hoeft het niet te noemen.
    for (const naam of ["close_fiscal_year", "reopen_fiscal_year", "enforce_year_close_watermark"]) {
      expect(definities.get(naam), `${naam}: het watermerk is levenscyclus`).toMatch(/afgesloten_boekjaar/);
    }
  });

  it("12. de blokkadefuncties raken de levenscyclus niet", () => {
    for (const naam of BLOKKADE) {
      const body = definities.get(naam) ?? "";
      expect(body, naam).not.toBe("");
      expect(body, naam).not.toMatch(/afgesloten_boekjaar|year_closures|fiscal_year_events|close_fiscal_year|reopen_fiscal_year/);
    }
  });

  it("13. de app roept nergens een schrijver buiten deze zeven om, en kent geen eigen grootboek-INSERT", () => {
    expect(appFilesMatching(/\.from\(\s*["'`]ledger_postings["'`]\s*\)[^;]*\.(insert|update|upsert|delete)\s*\(/)).toEqual([]);
    const rpcs = new Set<string>();
    for (const f of appFilesMatching(/\.rpc\(\s*["'`]post_|\.rpc\(\s*["'`]reverse_posting_group/)) {
      for (const m of lees(f).matchAll(/\.rpc\(\s*["'`](post_\w+|reverse_posting_group)["'`]/g)) rpcs.add(m[1]);
    }
    for (const naam of rpcs) {
      expect([...SCHRIJVERS, "post_bank_transactions_bulk"] as string[], naam).toContain(naam);
    }
  });
});
