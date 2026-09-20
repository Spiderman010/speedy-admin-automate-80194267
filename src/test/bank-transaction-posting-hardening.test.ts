import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Correctieve verharding van de directe bankboeking.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Of de rechten werkelijk zo staan, of de tenantpoort werkelijk twee
 * ononderscheidbare antwoorden geeft, en of de boeking tot op de cent klopt —
 * dat zijn uitspraken over PostgreSQL en niet met een reguliere expressie te
 * bewijzen. Die staan in `supabase/tests/bank-transaction-posting/` en draaien
 * tegen een echte database. Dit bestand bewaakt wat dáár niet te zien is: dat
 * de toegepaste migratie onaangeroerd blijft en dat de correctie blijft zeggen
 * wat zij hoort te zeggen.
 */

const MIGRATION_DIR = "supabase/migrations";
const APPLIED = `${MIGRATION_DIR}/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql`;
const SLUG = "_harden_bank_transaction_posting.sql";

const own = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(SLUG));
const MIGRATION = `${MIGRATION_DIR}/${own[0]}`;

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

const applied = readFileSync(resolve(process.cwd(), APPLIED), "utf8");
/** Alleen het lichaam: alles ná `$$;` is grants en commentaar, geen logica. */
function writerBody(text: string): string {
  const start = text.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transaction");
  const body = text.slice(start);
  return body.slice(0, body.indexOf("$$;") + 3);
}
const appliedWriter = writerBody(applied);
const newWriter = writerBody(sql);

describe("correctieve migratie — de directe bankboeking", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix ná de toegepaste migratie", () => {
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^\d{14}_harden_bank_transaction_posting\.sql$/);
    expect(own[0].slice(0, 14) > "20260920195805").toBe(true);
  });

  it("2. de markerrechten worden eerst volledig ingetrokken en daarna alleen lezen teruggegeven", () => {
    expect(flat).toMatch(
      /REVOKE ALL ON public\.bank_transaction_postings FROM anon, authenticated, service_role;/,
    );
    expect(flat).toMatch(
      /GRANT SELECT ON public\.bank_transaction_postings TO authenticated, service_role;/,
    );
    // Geen enkele schrijfgrant op de marker, voor geen enkele rol.
    expect(flat).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|ALL)[^;]*ON public\.bank_transaction_postings/);
    // De REVOKE staat vóór de GRANT; andersom zou de reset het leesrecht wissen.
    expect(sql.indexOf("REVOKE ALL ON public.bank_transaction_postings"))
      .toBeLessThan(sql.indexOf("GRANT SELECT ON public.bank_transaction_postings"));
  });

  it("3. elke applicatierol wordt bij de functie expliciet genoemd, niet alleen PUBLIC", () => {
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_bank_transaction\(uuid\) FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_bank_transaction\(uuid\) TO authenticated;/,
    );
    expect(flat).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.post_bank_transaction[^;]*service_role/);
    expect(flat).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.post_bank_transaction[^;]*anon/);
  });

  it("4. de rechten worden ook ná CREATE OR REPLACE nog eens gezet", () => {
    // CREATE OR REPLACE behoudt de bestaande ACL; de eindtoestand mag niet van
    // de volgorde in dit bestand afhangen.
    const revokes = [...sql.matchAll(/REVOKE ALL ON FUNCTION public\.post_bank_transaction/g)];
    expect(revokes.length).toBeGreaterThanOrEqual(2);
    expect(sql.lastIndexOf("GRANT EXECUTE ON FUNCTION public.post_bank_transaction"))
      .toBeGreaterThan(sql.indexOf("CREATE OR REPLACE FUNCTION public.post_bank_transaction"));
  });

  it("5. de tenantpoort geeft één tekst en één SQLSTATE voor onbekend én onbevoegd", () => {
    expect(flat).toMatch(
      /IF NOT FOUND OR v_tx\.organization_id IS NULL OR NOT public\.has_min_role\(v_uid, v_tx\.organization_id, 'read_only'\) THEN RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';/,
    );
    // De oude, verklappende melding bestaat niet meer.
    expect(sql).not.toMatch(/Banktransactie niet gevonden/);
    expect(sql).not.toMatch(/ERRCODE = 'P0002'/);
    // En er is maar één formulering van de generieke weigering.
    const generiek = [...sql.matchAll(/'Banktransactie niet beschikbaar'/g)];
    expect(generiek).toHaveLength(1);
  });

  it("6. de poort staat vóór elke inhoudelijke uitspraak over de transactie", () => {
    const poort = newWriter.indexOf("'Banktransactie niet beschikbaar'");
    expect(poort).toBeGreaterThan(0);
    for (const needle of [
      "Alleen handmatig gecodeerde banktransacties",
      "aan een factuur gekoppeld",
      "heeft nog geen grootboekrekening",
      "van nul kan niet geboekt worden",
      "Geen bankrekening (grootboek) ingesteld",
      "is afgesloten voor deze administratie",
      "Ongeldig BTW-percentage",
      "Deze banktransactie is al geboekt",
    ]) {
      expect(newWriter.indexOf(needle), needle).toBeGreaterThan(poort);
    }
  });

  it("7. de rolvloer blijft assistant en de leesdrempel gaat eraan vooraf", () => {
    expect(flat).toMatch(/has_min_role\(v_uid, v_tx\.organization_id, 'assistant'\)/);
    expect(newWriter.indexOf("'read_only'")).toBeLessThan(newWriter.indexOf("'assistant'"));
  });

  it("8. de grendel blijft op exact dezelfde plek: eerste aanraking van de rij", () => {
    expect(flat).toMatch(
      /SELECT \* INTO v_tx FROM public\.bank_transactions WHERE id = _transaction_id FOR UPDATE;/,
    );
    // De grendelende SELECT is de ENIGE plek waar de writer de banktransactie
    // leest: er gaat geen ongegrendelde peiling aan vooraf.
    const leest = [...newWriter.matchAll(/FROM public\.bank_transactions\b/g)];
    expect(leest).toHaveLength(1);
    // En de authenticatiecontrole komt nog vóór die grendel.
    expect(newWriter.indexOf("'Niet ingelogd'")).toBeLessThan(newWriter.indexOf("FOR UPDATE"));
  });

  it("9. de boekhouding is letterlijk overgenomen: bedragen, zijden en rekeningkeuze", () => {
    for (const needle of [
      "v_gross := round(abs(v_tx.amount), 2);",
      "v_net   := round(v_gross / (1 + v_pct / 100), 2);",
      "v_btw   := v_gross - v_net;",
      "CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE COALESCE(v_tx.btw_percentage, 0) END",
      "THEN v_client.btw_te_vorderen_rekening_id",
      "ELSE v_client.btw_te_betalen_rekening_id END",
      "'bank_transaction', v_tx.id, v_uid",
    ]) {
      expect(newWriter, needle).toContain(needle);
      expect(appliedWriter, `${needle} (toegepaste versie)`).toContain(needle);
    }
  });

  it("10. alles ná de poort is regel voor regel gelijk aan de toegepaste versie", () => {
    // Het enige verschil mag de poort zijn. Vanaf het eerste gemeenschappelijke
    // ankerpunt moet de rest woord voor woord overeenkomen.
    const anker = "SELECT * INTO v_client FROM public.clients WHERE id = v_tx.client_id;";
    const norm = (s: string) =>
      s.slice(s.indexOf(anker))
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r !== "" && !r.startsWith("--"))
        .join("\n");
    expect(norm(newWriter)).toBe(norm(appliedWriter));
  });

  it("11. de toegepaste migratie zelf wordt niet aangeraakt", () => {
    let changed: string[];
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      return; // geen origin/main beschikbaar
    }
    expect(changed).not.toContain(APPLIED);
    // En geen enkele andere bestaande migratie.
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

  it("12. er wordt niets verwijderd, afgekapt of geherstructureerd", () => {
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN|TRIGGER|POLICY)\b/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/);
    expect(sql).not.toMatch(/\bALTER TABLE\b/);
    expect(sql).not.toMatch(/\bDELETE FROM\b/);
    // De claimtrigger en de bevriezingsfunctie blijven van de toegepaste
    // migratie; deze correctie raakt ze niet aan.
    expect(sql).not.toMatch(/enforce_bank_transaction_source_claim/);
    expect(sql).not.toMatch(/prevent_posted_bank_transaction_mutation/);
  });

  it("13. de rollback en de leescontroles staan in het bestand, zonder verboden projectref", () => {
    expect(raw).toMatch(/-- rollback/);
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
    expect(raw).not.toContain("olumcwneiejjefhkzgmz");
    expect(raw).not.toContain("ycuofllsdssoezwwpqmv");
  });
});

describe("het PostgreSQL-bewijs hoort erbij en wijst niet naar productie", () => {
  const SUITE = "supabase/tests/bank-transaction-posting";

  it("14. de suite bestaat en waarschuwt tegen gebruik op een echte database", () => {
    const runner = readFileSync(`${SUITE}/run-proof.sh`, "utf8");
    expect(runner).toMatch(/THROWAWAY DATABASE ONLY/);
    expect(runner).toMatch(/alxlbdhpbwlehbdbfejw/); // uitsluitend als waarschuwing
    expect(runner).toMatch(/DROP DATABASE IF EXISTS/);
    // De toegepaste migratie wordt toegepast, niet gewijzigd.
    expect(runner).toContain("20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql");
    expect(runner).toContain("20260921140000_harden_bank_transaction_posting.sql");
  });

  it("15. het bewijs vergelijkt de volledige foutidentiteit, niet alleen een substring", () => {
    const proof = readFileSync(`${SUITE}/proof.sql`, "utf8");
    expect(proof).toMatch(/GET STACKED DIAGNOSTICS/);
    expect(proof).toContain("'42501 | Banktransactie niet beschikbaar'");
  });
});
