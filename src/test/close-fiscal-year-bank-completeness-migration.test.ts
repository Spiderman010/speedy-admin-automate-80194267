import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Herstel P7 — de jaarafsluiting telt ook gecodeerde, nog niet geboekte
 * bankregels (A3-02) en alleen werk van de eigen organisatie (B1-04).
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/close-bank-completeness/` en draait
 * tegen een echte PostgreSQL met de echte migratieketen (86 bewijzen, inclusief
 * negatieve controle, gelijktijdigheid, rollback en uitrolcontroles). Dat valt
 * niet met reguliere expressies te bewijzen.
 *
 * Dit bestand bewaakt de VORM, en vooral twee dingen die een review anders met
 * de hand moet narekenen:
 *   • de twee md5-constanten van de anti-clobber horen echt bij de lichamen
 *     die zij beweren te beschermen (PR E vóór, dit bestand ná);
 *   • het nieuwe lichaam is het PR E-lichaam met UITSLUITEND de gedocumenteerde
 *     wijzigingen — geen guard, grendel of gebeurtenis die stil verdwijnt.
 */

const MIGRATION_DIR = "supabase/migrations";
const SLUG = "_close_fiscal_year_direct_bank_completeness.sql";
const ROLLOUT = "supabase/rollout/20261021200000_close_fiscal_year_direct_bank_completeness";
const HARNESS = "supabase/tests/close-bank-completeness";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const own = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(SLUG));
const MIGRATION = `${MIGRATION_DIR}/${own[0]}`;
const PR_E = `${MIGRATION_DIR}/20261001120000_add_fiscal_year_reopen.sql`;

const text = read(MIGRATION);
const prE = read(PR_E);

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
function code(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** prosrc zoals PostgreSQL hem opslaat: exact de tekst tussen `AS $$` en `$$;`. */
function prosrc(sql: string, fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  if (start < 0) throw new Error(`${fn} niet gevonden`);
  const open = sql.indexOf("AS $$", start) + "AS $$".length;
  const close = sql.indexOf("\n$$;", open) + 1;
  return sql.slice(open, close);
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

const bodyP7 = prosrc(text, "close_fiscal_year");
const bodyPrE = prosrc(prE, "close_fiscal_year");

describe("P7 — close_fiscal_year telt de directe bankschrijver en alleen de eigen organisatie", () => {
  it("1. bestaat precies één keer, binnen het P7-venster 20261021200000–20261021205959", () => {
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^20261021(20[0-5]\d[0-5]\d)_close_fiscal_year_direct_bank_completeness\.sql$/);
  });

  it("2. herdefinieert uitsluitend close_fiscal_year(): geen tabel, kolom, index, trigger, policy of data", () => {
    const sql = code(text).replace(/COMMENT ON [^;]*;/g, "");
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies).toEqual(["close_fiscal_year"]);
    // Buiten het functielichaam en de vereistencontrole staat er niets uitvoerends.
    const buiten = sql.replace(/AS \$\$[\s\S]*?\n\$\$;/g, "").replace(/DO \$migratie\$[\s\S]*?\$migratie\$;/g, "");
    expect(buiten).not.toMatch(/\b(CREATE\s+(TABLE|INDEX|TRIGGER|POLICY|VIEW)|ALTER\s+TABLE|DROP\s|TRUNCATE|INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM)\b/i);
    expect(buiten).toMatch(/REVOKE ALL ON FUNCTION public\.close_fiscal_year\(uuid, integer\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(buiten).toMatch(/GRANT EXECUTE ON FUNCTION public\.close_fiscal_year\(uuid, integer\) TO authenticated;/);
  });

  it("3. SECURITY DEFINER en SET search_path = public blijven staan", () => {
    const kop = text.slice(text.indexOf("CREATE OR REPLACE FUNCTION public.close_fiscal_year("), text.indexOf("AS $$"));
    expect(kop).toMatch(/SECURITY DEFINER/);
    expect(kop).toMatch(/SET search_path = public/);
  });

  it("4. de anti-clobber pint precies het PR E-lichaam (vóór) en het eigen lichaam (ná), en staat vóór de CREATE OR REPLACE", () => {
    const voor = text.match(/v_voor constant text := '([0-9a-f]{32})'/)?.[1];
    const na = text.match(/v_na\s+constant text := '([0-9a-f]{32})'/)?.[1];
    expect(voor).toBe(md5(bodyPrE));
    expect(na).toBe(md5(bodyP7));
    expect(voor).toBe("14cdfaa498bbbc305e95dbf0faa52e26");
    expect(na).toBe("8b87b888e2468a58ecf378a643121151");
    const sql = code(text);
    expect(sql.indexOf("md5(p.prosrc)")).toBeGreaterThan(-1);
    expect(sql.indexOf("md5(p.prosrc)")).toBeLessThan(sql.indexOf("CREATE OR REPLACE FUNCTION public.close_fiscal_year("));
  });

  it("5. het nieuwe lichaam is PR E met UITSLUITEND de organisatiefilters, de banktak en de bijgestelde weigeringstekst", () => {
    const zonderCommentaar = (s: string) => code(s).split("\n");
    const toegevoegd = new Set([
      "    AND lp.organization_id = v_org",
      "      AND lp.organization_id = v_org",
      "      AND (pi.organization_id = v_org OR pi.organization_id IS NULL)",
      "      AND (si.organization_id = v_org OR si.organization_id IS NULL)",
      "      AND (a.organization_id = v_org OR a.organization_id IS NULL)",
      "      AND mj.organization_id = v_org",
    ]);
    // De banktak: van de extra UNION ALL tot het sluiten van de CTE.
    const p7 = zonderCommentaar(bodyP7);
    const takStart = p7.findIndex((l) => l.includes("FROM public.bank_transactions bt") && !l.includes("LEFT JOIN"));
    expect(takStart).toBeGreaterThan(0);
    const unionVoorTak = p7.lastIndexOf("    UNION ALL", takStart);
    const takEinde = p7.findIndex((l, i) => i > takStart && l === "  )");
    const tak = p7.slice(unionVoorTak - 1, takEinde); // inclusief de lege regel ervoor
    const rest = [...p7.slice(0, unionVoorTak - 1), ...p7.slice(takEinde)].filter((l) => !toegevoegd.has(l));
    const prELines = zonderCommentaar(bodyPrE);
    const oud = "    RAISE EXCEPTION 'Er % nog % postbaar brondocument(en) open met boekjaar t/m %; afsluiten zou % voorgoed onboekbaar maken.',";
    const nieuw = "    RAISE EXCEPTION 'Er % nog % postbaar brondocument(en) open met boekjaar t/m %; een afsluiting verklaart het boekjaar volledig, dus boek % eerst.',";
    expect(rest.map((l) => (l === nieuw ? oud : l))).toEqual(prELines);
    // De tak zelf: precies de documentvoorwaarden van de directe bankschrijver.
    const takCode = tak.join("\n");
    expect(takCode).toMatch(/bt\.client_id = _client_id/);
    expect(takCode).toMatch(/\(bt\.organization_id = v_org OR bt\.organization_id IS NULL\)/);
    expect(takCode).toMatch(/bt\.match_status = 'handmatig_geboekt'/);
    expect(takCode).toMatch(/bt\.grootboekrekening_id IS NOT NULL/);
    expect(takCode).toMatch(/bt\.amount <> 0/);
    expect(takCode).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.bank_transaction_allocations a\s+WHERE a\.bank_transaction_id = bt\.id\s*\)/);
    expect(takCode).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.bank_transaction_postings m\s+WHERE m\.bank_transaction_id = bt\.id\s*\)/);
    expect(takCode).toMatch(/EXTRACT\(YEAR FROM bt\.transaction_date\)::integer/);
    // Geen configuratie- of datumgrendel in de telling (net als bij facturen).
    expect(takCode).not.toMatch(/bank_rekening_id|posting_locked_through|posting_allowed|btw_percentage/);
  });

  it("6. de banktak volgt de LAATSTE definitie van post_bank_transaction(): dezelfde vier documentweigeringen", () => {
    const definities = readdirSync(resolve(process.cwd(), MIGRATION_DIR))
      .filter((f) => f.endsWith(".sql") && f !== own[0])
      .sort()
      .filter((f) => read(`${MIGRATION_DIR}/${f}`).includes("CREATE OR REPLACE FUNCTION public.post_bank_transaction(_transaction_id uuid)"));
    const laatste = code(read(`${MIGRATION_DIR}/${definities[definities.length - 1]}`));
    const schrijver = laatste.slice(
      laatste.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transaction(_transaction_id uuid)"),
    );
    const lichaam = schrijver.slice(0, schrijver.indexOf("\n$$;"));
    expect(lichaam).toMatch(/IF v_tx\.match_status <> 'handmatig_geboekt' THEN\s+RAISE EXCEPTION/);
    expect(lichaam).toMatch(/IF EXISTS \(SELECT 1 FROM public\.bank_transaction_allocations WHERE bank_transaction_id = v_tx\.id\) THEN\s+RAISE EXCEPTION/);
    expect(lichaam).toMatch(/IF v_tx\.grootboekrekening_id IS NULL THEN\s+RAISE EXCEPTION/);
    expect(lichaam).toMatch(/IF v_tx\.amount = 0 THEN\s+RAISE EXCEPTION/);
    expect(lichaam).toMatch(/INSERT INTO public\.bank_transaction_postings/);
  });

  it("7. de rollback in het uitrolmateriaal is een bewaking plus letterlijk PR E-sectie 4 (regels 262–561)", () => {
    const rollback = read(`${ROLLOUT}/rollback.sql`);
    const sectie4 = prE.split("\n").slice(261, 561).join("\n");
    expect(sectie4.startsWith("CREATE OR REPLACE FUNCTION public.close_fiscal_year(")).toBe(true);
    expect(sectie4).toMatch(/COMMENT ON FUNCTION public\.close_fiscal_year\(uuid, integer\) IS\n'[^']*Rolvloer: accountant\.';$/);
    expect(rollback.includes(sectie4)).toBe(true);
    const guard = rollback.slice(0, rollback.indexOf(sectie4));
    expect(guard).toMatch(/NOT IN \('8b87b888e2468a58ecf378a643121151', '14cdfaa498bbbc305e95dbf0faa52e26'\)/);
    expect(guard).toMatch(/RAISE EXCEPTION 'Rollback geweigerd/);
  });

  it("8. preflight, postcheck en impact zijn ALLEEN LEZEN", () => {
    for (const f of ["preflight.sql", "postcheck.sql", "impact.sql"]) {
      const sql = code(read(`${ROLLOUT}/${f}`));
      expect(sql, f).toMatch(/\bSELECT\b/);
      expect(sql, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|COPY|CALL|DO)\b/i);
    }
  });

  it("9. het harnas past de migratie twee keer toe, draait een negatieve controle en gebruikt alleen de libpq-omgeving", () => {
    const sh = read(`${HARNESS}/run-proof.sh`);
    const stappen = sh.slice(sh.indexOf("# ── de migratie onder test, TWEE keer"));
    expect(stappen.match(/^run -f "\$M"/gm)?.length ?? 0).toBeGreaterThanOrEqual(3); // twee keer + opnieuw na de rollback
    expect(sh.indexOf('"$HERE/pre.sql"')).toBeLessThan(sh.indexOf("# ── de migratie onder test, TWEE keer"));
    expect(sh).toMatch(/\$\{PGHOST:\?set PGHOST\}/);
    expect(sh).not.toMatch(/psql[^\n]*\s-h\s/);
    expect(sh).not.toMatch(/supabase\.co|alxlbdhpbwlehbdbfejw\.supabase/);
  });
});
