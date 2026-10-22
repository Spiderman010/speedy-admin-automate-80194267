import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertBranchSqlKeepsLedgerFoundation, assertBranchTouchesNoExistingWriter } from "./support/branch-sql-scope";

/**
 * P4 — 20261021170000: btw- en NaN-validatie in de schrijvers (fail-closed).
 *
 * Het gedrag (NULL-btw geweigerd en expliciet 0 geboekt, vrijgesteld met btw
 * geweigerd, NaN geweigerd door elke schrijver en elke CHECK, de rollback
 * byte-gelijk) wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/writer-vat-nan-validation/ (91 bewijzen, met negatieve
 * controles op de oude keten). Deze test bewaakt dat de migratie letterlijk de
 * vorige lichamen is met precies de beoordeelde wijzigingen, dat de hashes uit
 * de bestanden zelf volgen, en dat het uitrolmateriaal alleen leest.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261021170000_btw_en_nan_validatie_in_schrijvers.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
const PRH = `${MIGRATION_DIR}/20261002120000_decouple_year_watermark_from_posting.sql`;
const BULK = `${MIGRATION_DIR}/20260922120000_add_bank_bulk_posting.sql`;
const ROLLOUT = "supabase/rollout/20261021170000_btw_en_nan_validatie_in_schrijvers";
const HARNESS = "supabase/tests/writer-vat-nan-validation";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const raw = read(MIGRATION);
const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");

/** Eén functie, van haar CREATE tot en met de afsluitende `$$;`. */
function definition(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return "";
  const end = text.indexOf("\n$$;\n", start);
  return text.slice(start, end + "\n$$;\n".length);
}
/** prosrc: de tekst tussen `AS $$` en `$$;`. */
const prosrc = (def: string) => def.slice(def.indexOf("AS $$") + "AS $$".length, def.lastIndexOf("$$;"));
/** Alleen uitvoerbare SQL: commentaarregels weg. */
const code = (t: string) => t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const SOURCES: Record<string, string> = {
  post_purchase_invoice: PRH,
  post_sales_invoice: PRH,
  post_bank_transaction: PRH,
  bank_bulk_posting_candidates: PRH,
  post_bank_transactions_bulk: BULK,
};
const NAMES = Object.keys(SOURCES);

/** De beoordeelde wijzigingen per functie, ten opzichte van haar vorige definitie — elk exact één keer. */
const HUNKS: Record<string, [string, string][]> = {
  post_purchase_invoice: [
    ["  v_bad_accounts     integer;\n",
     "  v_bad_accounts     integer;\n  v_subcent          integer;\n"],
    ["    RAISE EXCEPTION 'Inkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';\n  END IF;\n\n",
     "    RAISE EXCEPTION 'Inkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';\n  END IF;\n\n  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG. In PostgreSQL is 'NaN' = 'NaN'\n  -- waar en is NaN groter dan elk getal: een NaN-bedrag glipt door elke toets\n  -- hieronder (ook \"sluit aan\") en zou als NaN in het grootboek belanden. Een\n  -- regelbedrag (numeric zonder schaal) kan bovendien ±oneindig zijn.\n  IF v_inv.amount_excl = 'NaN'::numeric OR v_btw = 'NaN'::numeric OR v_inv.amount_incl = 'NaN'::numeric\n     OR EXISTS (SELECT 1 FROM public.purchase_invoice_lines l\n                WHERE l.purchase_invoice_id = v_inv.id\n                  AND l.amount_excl IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) THEN\n    RAISE EXCEPTION 'Inkoopfactuur heeft een bedrag dat geen getal is (NaN); herstel de bedragen voordat u boekt'\n      USING ERRCODE = '22023';\n  END IF;\n\n"],
    ["    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'\n      USING ERRCODE = '22023';\n",
     "    RAISE EXCEPTION 'Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking'\n      USING ERRCODE = '22023';\n  END IF;\n\n  -- F1c-N1 (20261021170000) — BTW-VRIJGESTELD; ontwerpbesluit D4 is OPEN. Een\n  -- vrijgestelde administratie boekt geen voorbelasting. Hoe btw op haar\n  -- inkopen dan wél wordt verwerkt (bijvoorbeeld als kosten), is nog niet\n  -- besloten: tot dat besluit wordt zo'n factuur geweigerd — niet stil met\n  -- voorbelasting en niet stil zonder btw geboekt. Zonder btw boekt zij zoals\n  -- altijd.\n  IF v_client.btw_vrijgesteld AND v_btw > 0 THEN\n    RAISE EXCEPTION 'Deze administratie is btw-vrijgesteld en kan geen voorbelasting boeken, maar de factuur bevat een btw-bedrag van %. Hoe btw op inkopen van een vrijgestelde administratie wordt verwerkt, is nog niet besloten; boeken is daarom niet mogelijk', v_btw\n      USING ERRCODE = '0A000';\n"],
    ["    RAISE EXCEPTION 'Geen rekening voor BTW te vorderen ingesteld voor deze administratie' USING ERRCODE = '22023';\n",
     "    RAISE EXCEPTION 'Geen rekening voor BTW te vorderen ingesteld voor deze administratie' USING ERRCODE = '22023';\n  END IF;\n\n  -- A3-16 (20261021170000) — HELE CENTEN. Een regelbedrag met fracties van een\n  -- cent wordt door het grootboek (numeric(12,2)) bij het boeken afgerond; de\n  -- boeking wijkt dan stil af van de bron, of de groepsbalans weigert. Hier\n  -- weigeren, vóór de aansluittoets (die de som al op centen afrondt).\n  SELECT COUNT(*) INTO v_subcent\n  FROM public.purchase_invoice_lines l\n  WHERE l.purchase_invoice_id = v_inv.id\n    AND l.amount_excl <> round(l.amount_excl, 2);\n\n  IF v_subcent > 0 THEN\n    RAISE EXCEPTION '% boekingsregel(s) met een bedrag in fracties van een cent; rond elke regel af op hele centen en boek daarna opnieuw', v_subcent\n      USING ERRCODE = '22023';\n"],
  ],
  post_sales_invoice: [
    ["    RAISE EXCEPTION 'Verkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';\n",
     "    RAISE EXCEPTION 'Verkoopfactuur mist bedragen; boeken is niet mogelijk' USING ERRCODE = '22004';\n  END IF;\n\n  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG. 'NaN' = 'NaN' is waar en NaN\n  -- is groter dan elk getal: zonder deze toets glipt een NaN-bedrag door elke\n  -- controle hieronder en belandt het als NaN in het grootboek.\n  IF v_inv.amount_excl = 'NaN'::numeric OR v_btw = 'NaN'::numeric OR v_inv.amount_incl = 'NaN'::numeric THEN\n    RAISE EXCEPTION 'Verkoopfactuur heeft een bedrag dat geen getal is (NaN); herstel de bedragen voordat u boekt'\n      USING ERRCODE = '22023';\n"],
  ],
  post_bank_transaction: [
    ["\n  -- ── Vanaf hier is alles een letterlijke kopie van 20260920195805 ──────────\n",
     "\n  -- ── Vanaf hier een letterlijke kopie van 20260920195805, op de toetsen van ──\n  -- ── 20261021170000 (NaN-bedrag, btw-percentage) na ──────────────────────────\n"],
    ["    RAISE EXCEPTION 'Een banktransactie van nul kan niet geboekt worden' USING ERRCODE = '22023';\n",
     "    RAISE EXCEPTION 'Een banktransactie van nul kan niet geboekt worden' USING ERRCODE = '22023';\n  END IF;\n\n  -- A3-01 (20261021170000) — NaN IS GEEN BEDRAG: 'NaN' = 'NaN' is waar en NaN\n  -- is groter dan elk getal, dus zonder deze toets kwam een NaN-boeking door\n  -- elke controle hieronder, tot en met de groepsbalans.\n  IF v_tx.amount = 'NaN'::numeric THEN\n    RAISE EXCEPTION 'Het bedrag van deze banktransactie is geen getal (NaN); boeken is niet mogelijk' USING ERRCODE = '22023';\n"],
    ["    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';\n  END IF;\n\n",
     "    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';\n  END IF;\n\n  -- E-06 (20261021170000) — GEEN STILLE 0%. Een ontbrekend btw-percentage\n  -- (NULL) werd hier als 0% geboekt: een kostenpost van 21% kwam dan zonder\n  -- voorbelasting in het grootboek. Elke codeerroute in de app vraagt een\n  -- expliciete keuze — ook \"Geen BTW\" (0), ook bij een vrijgestelde\n  -- administratie — en deze schrijver dwingt precies die regel af.\n  IF v_tx.btw_percentage IS NULL THEN\n    RAISE EXCEPTION 'Het BTW-percentage van deze banktransactie is nog niet gekozen; kies 0 (geen BTW), 9 of 21 procent en boek daarna opnieuw'\n      USING ERRCODE = '22004';\n  END IF;\n\n  -- A3-01: NaN of ±oneindig is geen percentage. Bij een vrijgestelde\n  -- administratie werd zo'n waarde hieronder stil 0.\n  IF v_tx.btw_percentage IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN\n    RAISE EXCEPTION 'Ongeldig BTW-percentage (%) op deze banktransactie', v_tx.btw_percentage USING ERRCODE = '22023';\n  END IF;\n\n"],
    ["  -- BTW: vrijgestelde administraties boeken nooit BTW.\n  v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE COALESCE(v_tx.btw_percentage, 0) END;\n",
     "  -- BTW: vrijgestelde administraties boeken nooit BTW.\n  v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE v_tx.btw_percentage END;\n"],
  ],
  bank_bulk_posting_candidates: [
    ["       AND t.transaction_date <= c.posting_locked_through\n                                                        THEN 'blocked'\n",
     "       AND t.transaction_date <= c.posting_locked_through\n                                                        THEN 'blocked'\n      WHEN t.btw_percentage IS NULL                     THEN 'review_needed'\n"],
    ["                                                                    t.transaction_date, c.posting_locked_through)\n",
     "                                                                    t.transaction_date, c.posting_locked_through)\n      WHEN t.btw_percentage IS NULL                     THEN 'Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.'\n"],
  ],
  post_bank_transactions_bulk: [
    ["        -- interne details bevatten en wordt neutraal gemeld.\n",
     "        -- interne details bevatten en wordt neutraal gemeld.\n        -- 22004 (20261021170000): het nog niet gekozen btw-percentage, en de\n        -- ontbrekende datum of administratie van assert_posting_allowed();\n        -- geen van beide noemt een id of andermans gegevens.\n"],
    ["        message := CASE\n          WHEN v_state IN ('28000', '42501', '22023', '23514', '23505', 'P0002') THEN v_msg\n",
     "        message := CASE\n          WHEN v_state IN ('28000', '42501', '22023', '23514', '23505', 'P0002', '22004') THEN v_msg\n"],
  ],
};

function changedFiles(): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("20261021170000 — vorm", () => {
  it("1. bestaat één keer, in het P4-venster, en sorteert na de keten die zij vereist (PR 2 en verder)", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_btw_en_nan_validatie_in_schrijvers.sql"))).toEqual([FILE]);
    expect(FILE >= "20261021170000" && FILE < "20261021180000").toBe(true);
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261018150000_keep_bank_description_on_correction.sql"));
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261020120000_add_bank_transaction_import_fingerprint.sql"));
  });

  it("2. elk lichaam is letterlijk de vorige definitie met precies de beoordeelde wijzigingen", () => {
    for (const name of NAMES) {
      const previous = definition(read(SOURCES[name]), name);
      expect(previous, `${name}: vorige definitie`).not.toBe("");
      let expected = previous;
      for (const [oud, nieuw] of HUNKS[name]) {
        expect(expected.split(oud).length - 1, `${name}: ${oud.slice(0, 60)}`).toBe(1);
        expected = expected.replace(oud, nieuw);
      }
      expect(definition(raw, name), name).toBe(expected);
    }
    // Precies vijf definities, in deze volgorde.
    expect([...code(raw).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\(/g)].map((m) => m[1])).toEqual([
      "post_purchase_invoice", "post_sales_invoice", "post_bank_transaction", "bank_bulk_posting_candidates", "post_bank_transactions_bulk",
    ]);
  });

  it("3. de wijzigingen voegen alleen weigeringen en één preflight-arm toe — geen schrijfhandeling, geen nieuwe rekening", () => {
    for (const name of NAMES) {
      for (const [oud, nieuw] of HUNKS[name]) {
        // Een invoeging: wat er na de context bijkomt. Een vervanging: de hele nieuwe tekst.
        const erbij = code(nieuw.startsWith(oud) ? nieuw.slice(oud.length) : nieuw);
        expect(erbij, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|EXECUTE|PERFORM|NOTIFY)\b/i);
        expect(erbij, name).not.toMatch(/_rekening_id/);
      }
    }
    // De drie nieuwe toetsen van de bankschrijver staan in het BTW-blok, ná rechten, tenant en blokkade.
    const bank = code(definition(raw, "post_bank_transaction"));
    const plek = (s: string) => bank.indexOf(s);
    expect(plek("IF v_tx.btw_percentage IS NULL THEN")).toBeGreaterThan(plek("PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);"));
    expect(plek("IF v_tx.btw_percentage IS NULL THEN")).toBeGreaterThan(plek("'Geen rechten om te boeken voor deze organisatie'"));
    expect(plek("IF v_tx.btw_percentage IS NULL THEN")).toBeLessThan(plek("v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE v_tx.btw_percentage END;"));
    expect(bank).toContain("USING ERRCODE = '22004'");
    expect(bank).not.toMatch(/COALESCE\(v_tx\.btw_percentage/);
    // De inkoopschrijver: de vrijgesteld-toets vóór de configuratie, nooit een voorbelastingregel voor vrijgesteld.
    const inkoop = code(definition(raw, "post_purchase_invoice"));
    expect(inkoop.indexOf("IF v_client.btw_vrijgesteld AND v_btw > 0 THEN")).toBeLessThan(inkoop.indexOf("Geen crediteurenrekening ingesteld"));
    expect(inkoop.indexOf("IF v_client.btw_vrijgesteld AND v_btw > 0 THEN")).toBeGreaterThan(inkoop.indexOf("PERFORM public.assert_posting_allowed("));
  });

  it("4. de VÓÓR-hashes zijn md5 van de vorige lichamen en de NÁ-hashes md5 van de lichamen in dit bestand", () => {
    const pre = code(raw.slice(0, raw.indexOf("-- ── 1.")));
    for (const name of NAMES) {
      const voor = pre.match(new RegExp(`v_voor := CASE v_naam[^;]*WHEN '${name}'\\s+THEN '([0-9a-f]{32})'`))?.[1];
      const na = pre.match(new RegExp(`v_na := CASE v_naam[^;]*WHEN '${name}'\\s+THEN '([0-9a-f]{32})'`))?.[1];
      expect(voor, `${name}: vóór`).toBe(md5(prosrc(definition(read(SOURCES[name]), name))));
      expect(na, `${name}: ná`).toBe(md5(prosrc(definition(raw, name))));
      // Dezelfde hashes in de postcheck (ná) en de rollbackbewaking (vóór en ná).
      expect(read(`${ROLLOUT}/postcheck.sql`), `${name}: postcheck`).toContain(`'${na}'`);
      expect(read(`${ROLLOUT}/preflight.sql`), `${name}: preflight`).toContain(`'${voor}'`);
      expect(read(`${ROLLOUT}/rollback.sql`), `${name}: rollback ná`).toContain(`'${na}'`);
      expect(read(`${ROLLOUT}/rollback.sql`), `${name}: rollback vóór`).toContain(`'${voor}'`);
    }
    expect(pre).toContain("IF v_hash <> v_voor AND v_hash <> v_na THEN");
    expect(raw.indexOf("IF v_hash <> v_voor AND v_hash <> v_na THEN")).toBeLessThan(raw.indexOf("CREATE OR REPLACE FUNCTION public.post_purchase_invoice("));
    // PR 2 vereist, zonder een cast die bij het plannen al faalt.
    expect(pre).toContain("p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')");
    expect(pre).toContain("'067939e0c44a672c26ec8883717ef6d2'");
    expect(pre).not.toMatch(/'[^']*'::regprocedure/);
  });

  it("5. buiten de vijf lichamen: alleen voorwaarden, rechten, vijf CHECK's NOT VALID en hun commentaar — geen data, geen VALIDATE", () => {
    let rest = raw;
    for (const name of NAMES) rest = rest.replace(definition(raw, name), "");
    const c = code(rest);
    expect(c).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE|DROP\s|CREATE\s+TRIGGER|CREATE\s+POLICY|ALTER\s+COLUMN|RENAME|VALIDATE\s+CONSTRAINT|SET\s+DEFAULT)\b/i);
    const checks = [...c.matchAll(/ALTER TABLE (public\.\w+)\s+ADD CONSTRAINT (\w+)\s+CHECK \(([^;]*)\) NOT VALID;/g)].map((m) => [m[1], m[2]]);
    expect(checks).toEqual([
      ["public.ledger_postings", "ledger_postings_amounts_not_nan"],
      ["public.purchase_invoices", "purchase_invoices_amounts_not_nan"],
      ["public.sales_invoices", "sales_invoices_amounts_not_nan"],
      ["public.purchase_invoice_lines", "purchase_invoice_lines_amount_finite"],
      ["public.bank_transactions", "bank_transactions_amount_not_nan"],
    ]);
    // Elke ADD CONSTRAINT idempotent achter een IF NOT EXISTS op pg_constraint.
    for (const [, naam] of checks) {
      expect(c).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint\\s+WHERE conrelid = '[\\w.]+'::regclass AND conname = '${naam}'\\) THEN`));
      expect(c).toContain(`COMMENT ON CONSTRAINT ${naam} ON`);
    }
    // Rechten: authenticated wordt niet eerst ingetrokken (geen venster), het eindbeeld is expliciet.
    for (const sig of ["post_purchase_invoice(uuid)", "post_sales_invoice(uuid)", "post_bank_transaction(uuid)",
                       "bank_bulk_posting_candidates(uuid, integer)", "post_bank_transactions_bulk(uuid[])"]) {
      expect(c).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, service_role;`);
      expect(c).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
    // De kop documenteert de latere VALIDATE, Q7, de volgorde en de rollback.
    for (const [, naam] of checks) expect(raw).toMatch(new RegExp(`--\\s+ALTER TABLE public\\.\\w+\\s+VALIDATE CONSTRAINT ${naam};`));
    expect(raw).toMatch(/-- rollback: voer supabase\/rollout\/20261021170000_btw_en_nan_validatie_in_schrijvers\/rollback\.sql/);
    expect(raw).toContain("SET lock_timeout = '5s';");
    expect(raw).toContain("telling Q7");
  });

  it("6. de bulk laat 22004 ongeschonden door; alles daarbuiten blijft neutraal", () => {
    const bulk = code(definition(raw, "post_bank_transactions_bulk")).replace(/\s+/g, " ");
    expect(bulk).toContain("WHEN v_state IN ('28000', '42501', '22023', '23514', '23505', 'P0002', '22004') THEN v_msg ELSE 'Boeken is niet gelukt voor deze banktransactie.'");
  });

  it("7. de preflight-arm staat vlak vóór ELSE, met precies de reden die de app toont", () => {
    const pre = code(definition(raw, "bank_bulk_posting_candidates")).replace(/\s+/g, " ");
    const app = read("src/lib/bank-bulk-posting.ts");
    const reden = "Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.";
    expect(app).toContain(`"${reden}"`);
    expect(pre).toContain("WHEN t.btw_percentage IS NULL THEN 'review_needed' ELSE 'ready'");
    expect(pre).toContain(`WHEN t.btw_percentage IS NULL THEN '${reden}' ELSE NULL`);
  });
});

describe("20261021170000 — uitrolmateriaal en harnas", () => {
  it("8. preflight en postcheck lezen alleen", () => {
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      const c = code(read(`${ROLLOUT}/${f}`)).replace(/'(?:[^']|'')*'/g, "''");
      expect(c, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|SET|COPY|CALL|DO)\b/i);
      for (const stmt of c.split(";").map((s) => s.trim()).filter(Boolean)) {
        expect(stmt.toUpperCase().startsWith("SELECT") || stmt.toUpperCase().startsWith("WITH"), `${f}: ${stmt.slice(0, 40)}`).toBe(true);
      }
    }
  });

  it("9. de rollback: bewaking vóór alles, de vorige lichamen letterlijk, alleen de eigen constraints weg", () => {
    const rb = read(`${ROLLOUT}/rollback.sql`);
    expect(rb.indexOf("DO $rollback$")).toBeLessThan(rb.indexOf("CREATE OR REPLACE FUNCTION"));
    for (const name of NAMES) {
      expect(definition(rb, name), name).toBe(definition(read(SOURCES[name]), name));
    }
    const drops = [...code(rb).matchAll(/DROP\s+(\w+)\s+(?:IF EXISTS\s+)?(\w+)/gi)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
    expect(drops).toEqual([
      "CONSTRAINT ledger_postings_amounts_not_nan",
      "CONSTRAINT purchase_invoices_amounts_not_nan",
      "CONSTRAINT sales_invoices_amounts_not_nan",
      "CONSTRAINT purchase_invoice_lines_amount_finite",
      "CONSTRAINT bank_transactions_amount_not_nan",
    ]);
    // Buiten de (letterlijk herstelde) lichamen: geen data.
    let buiten = rb;
    for (const name of NAMES) buiten = buiten.replace(definition(rb, name), "");
    expect(code(buiten)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
  });

  it("10. het harnas bestaat, is wegwerp en noemt geen productie", () => {
    for (const f of ["run-proof.sh", "build-chain.sh", "helpers.sql", "pre.sql", "proof.sql", "after-rollback.sql", "final.sql"]) {
      expect(existsSync(resolve(process.cwd(), `${HARNESS}/${f}`)), f).toBe(true);
      expect(read(`${HARNESS}/${f}`), f).not.toMatch(/alxlbdhpbwlehbdbfejw\.supabase|supabase\.co/);
    }
    expect(read(`${HARNESS}/run-proof.sh`)).toMatch(/THROWAWAY DATABASE ONLY/);
    expect(read(`${HARNESS}/run-proof.sh`)).toContain('"${PGHOST:?set PGHOST}"');
  });

  it("11. de branch tast de grootboekfundering en de oude schrijvermigraties niet aan", () => {
    const changed = changedFiles();
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });
});
