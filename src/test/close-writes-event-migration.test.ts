import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * 6C-b11 PR B — de afsluiting schrijft haar gebeurtenis.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/close-writes-event/` en draait tegen een
 * echte PostgreSQL (36 bewijzen): één gedeeld tijdstip, één gedeelde actor,
 * een herhaling die niets toevoegt, en een gebeurtenis die bij een storing de
 * hele afsluiting meesleept. Dat valt niet met reguliere expressies te
 * bewijzen en wordt hier dus ook niet geprobeerd.
 *
 * Dit bestand bewaakt de VORM: dat de gebeurtenis alleen op de nieuwe-afsluiting
 * tak staat, dat er geen tweede `now()` of `auth.uid()` in sluipt, en dat deze
 * PR verder van niets afblijft.
 */

const MIGRATION_SLUG = "_close_writes_fiscal_year_event.sql";
const MIGRATION_DIR = "supabase/migrations";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith(MIGRATION_SLUG),
);
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/**
 * Alleen de uitvoerende SQL, zonder de `COMMENT ON … IS '…'`-tekst. Die is
 * uitvoerbaar maar inhoudelijk proza en noemt juist de dingen waarvan hier het
 * ontbreken wordt getoetst.
 */
const code = sql.replace(/COMMENT ON [^;]*;/g, "");

/** De body van de schrijver zelf. */
const writer = sql.slice(
  sql.indexOf("CREATE OR REPLACE FUNCTION public.close_fiscal_year"),
  sql.indexOf("REVOKE ALL ON FUNCTION public.close_fiscal_year"),
);

/** Het schrijfblok: alles vanaf de INSERT in year_closures. */
const schrijfblok = writer.slice(writer.indexOf("INSERT INTO public.year_closures"));

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/**
 * De schrijver zoals 6C-b10 hem definieerde — om verschillen tegen af te zetten.
 * Op dezelfde manier van commentaar ontdaan als de nieuwe, anders vergelijkt
 * test 10 toelichting met code in plaats van code met code.
 */
const origineel = readFileSync(
  resolve(process.cwd(), `${MIGRATION_DIR}/20260924120000_add_year_close_writer.sql`),
  "utf8",
)
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — de afsluiting legt haar gebeurtenis vast", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_close_writes_fiscal_year_event\.sql$/);
  });

  it("2. herdefinieert uitsluitend close_fiscal_year(), en maakt niets nieuws", () => {
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies).toEqual(["close_fiscal_year"]);
    expect(sql).not.toMatch(/CREATE TABLE/);
    expect(sql).not.toMatch(/CREATE TRIGGER/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/);
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/ALTER TABLE/);
  });

  it("3. schrijft precies één gebeurtenis, in het schrijfblok van de nieuwe afsluiting", () => {
    const inserts = [...writer.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["year_closures", "fiscal_year_events"]);
  });

  it("4. de gebeurtenis staat NA de terugkeer van de idempotente weg", () => {
    /*
     * Dit is de hele idempotentiegarantie, en zij is structureel in plaats van
     * voorwaardelijk: de `created = false`-weg keert terug vóór het
     * schrijfblok, dus die tak kan de INSERT per constructie niet bereiken.
     * Er is geen `IF` die vergeten kan worden.
     */
    const idempotenteReturn = writer.indexOf("RETURN QUERY SELECT v_existing.client_id");
    const gebeurtenis = writer.indexOf("INSERT INTO public.fiscal_year_events");
    expect(idempotenteReturn).toBeGreaterThan(-1);
    expect(gebeurtenis).toBeGreaterThan(idempotenteReturn);
    // En op die weg staat een kale RETURN, zodat er niets achteraan komt.
    expect(writer.slice(idempotenteReturn, gebeurtenis)).toMatch(/\bRETURN;/);
  });

  it("5. gebruikt ÉÉN tijdstip en ÉÉN actor, allebei uit de weggeschreven rij", () => {
    const f = schrijfblok.replace(/\s+/g, " ");
    expect(f).toContain("v_row.closed_at");
    expect(f).toContain("v_row.closed_by");
    // Geen tweede klok en geen tweede sessie-uitvraag in het schrijfblok: die
    // zouden bewijs en gebeurtenis op microseconden uit elkaar laten lopen.
    expect(schrijfblok).not.toMatch(/now\(\)/);
    expect(schrijfblok).not.toMatch(/auth\.uid\(\)/);
    expect(schrijfblok).not.toMatch(/clock_timestamp|statement_timestamp|transaction_timestamp/);
  });

  it("6. de gebeurtenis draagt geen reden en is niet gebackfild", () => {
    const waarden = schrijfblok.slice(schrijfblok.indexOf("INSERT INTO public.fiscal_year_events"));
    expect(waarden.replace(/\s+/g, " ")).toContain("'closed'");
    expect(waarden.replace(/\s+/g, " ")).toMatch(/NULL, false\)/);
    // backfilled = false houdt deze rij buiten de partiële unieke index van
    // PR A, zodat closed → reopened → closed mogelijk blijft.
    expect(waarden).not.toMatch(/backfilled[^,)]*true/);
  });

  it("7. het bewijs krijgt de status expliciet mee", () => {
    // De kolom heeft weliswaar DEFAULT 'closed', maar expliciet is hier beter:
    // het maakt de bedoeling leesbaar op de plek waar zij geldt, en het blijft
    // juist als de default ooit verandert.
    expect(schrijfblok.replace(/\s+/g, " ")).toContain(
      "INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by, status)",
    );
    expect(schrijfblok.replace(/\s+/g, " ")).toContain("VALUES (_client_id, _fiscal_year, v_org, v_uid, 'closed')");
  });
});

describe("PR B raakt verder niets aan", () => {
  it("8. handtekening, retourvorm en beveiliging zijn letterlijk die van 6C-b10", () => {
    const kop = writer.slice(0, writer.indexOf("AS $$"));
    expect(kop).toContain("_client_id   uuid");
    expect(kop).toContain("_fiscal_year integer");
    expect(kop.replace(/\s+/g, " ")).toContain(
      "RETURNS TABLE ( client_id uuid, organization_id uuid, fiscal_year integer, closed_at timestamptz, closed_by uuid, created boolean )",
    );
    expect(kop.replace(/\s+/g, " ")).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public");
  });

  it("9. de rechten worden niet verbreed", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.close_fiscal_year\(uuid, integer\) FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.close_fiscal_year\(uuid, integer\) TO authenticated/);
    // Geen enkele directe schrijfrechtverlening op de gebeurtenissen.
    expect(sql).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* ON public\.fiscal_year_events/);
    expect(sql).not.toMatch(/GRANT ALL/);
  });

  it("10. de rest van de schrijver is byte-identiek aan 6C-b10", () => {
    /*
     * De sterkste vorm van "er is verder niets veranderd": neem de nieuwe
     * schrijver, haal het toegevoegde gebeurtenisblok en de statuskolom eruit,
     * en wat overblijft moet letterlijk de oude functie zijn. Zo kan er geen
     * regel in de herkeuring, de grendels of de foutmeldingen zijn verschoven
     * zonder dat deze test omvalt.
     */
    const oudeWriter = origineel.slice(
      origineel.indexOf("CREATE OR REPLACE FUNCTION public.close_fiscal_year"),
      origineel.indexOf("REVOKE ALL ON FUNCTION public.close_fiscal_year"),
    );
    const teruggedraaid = writer
      // het toegevoegde gebeurtenisblok eruit
      .replace(/\n *INSERT INTO public\.fiscal_year_events[\s\S]*?v_row\.closed_by, NULL, false\);\n/, "")
      // en de statuskolom terug naar de oude vorm
      .replace(
        "(client_id, fiscal_year, organization_id, closed_by, status)\n  VALUES (_client_id, _fiscal_year, v_org, v_uid, 'closed')",
        "(client_id, fiscal_year, organization_id, closed_by)\n  VALUES (_client_id, _fiscal_year, v_org, v_uid)",
      );
    // Randwitruimte telt niet mee: de twee fragmenten zijn uit verschillende
    // bestanden gesneden en de bewering gaat over de code ertussen.
    expect(teruggedraaid.trim()).toBe(oudeWriter.trim());
  });

  it("11. de eerdere migraties zijn niet bewerkt", () => {
    expect(changed).not.toContain("supabase/migrations/20260924120000_add_year_close_writer.sql");
    expect(changed).not.toContain("supabase/migrations/20260925120000_add_fiscal_year_lifecycle_events.sql");
  });

  it("12. geen heropening, geen boekingsblokkade, geen watermerkversoepeling", () => {
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.filter((naam) => /reopen|heropen|posting_lock|posting_allowed/i.test(naam))).toEqual([]);
    expect(code).not.toMatch(/posting_allowed|posting_lock|locked_through/i);
    expect(code).not.toMatch(/prevent_year_closure_mutation|enforce_year_close_watermark/);
    expect(code).not.toMatch(/'reopened'/);
  });

  it("13. geen enkele schrijver, het grootboek of de bulk-preflight wordt geraakt", () => {
    // De schrijver LEEST het grootboek — de jaarvolgorde en de controle op
    // ongebalanceerde boekingsgroepen doen dat al sinds 6C-b10. Wat hij niet
    // doet, en nooit heeft gedaan, is erin schrijven.
    expect(sql).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.ledger_postings/);
    expect(sql).not.toMatch(/post_purchase_invoice|post_sales_invoice|post_bank|post_manual_journal/);
    expect(sql).not.toMatch(/post_opening_balance|declare_opening_balance_nil|reverse_posting_group/);
    expect(sql).not.toMatch(/bank_bulk_posting_candidates/);
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("14. de app is niet aangeraakt en de gegenereerde types evenmin", () => {
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  it("15. de koppelingstest bestaat nog en pint de schrijvers nog steeds", () => {
    /*
     * Was: "dit bestand is niet gewijzigd". Dat was waar over PR B, maar het
     * is geen invariant — PR D schrijft die test zelf voor te verscherpen.
     * Wat de assertie beschermde: de koppelingstest mag niet verdwijnen en
     * mag de oude jaargrendel niet loslaten.
     */
    const koppeling = readFileSync(
      resolve(process.cwd(), "src/test/year-close-coupling.test.ts"),
      "utf8",
    );
    expect(koppeling).toContain("afgesloten_boekjaar IS NOT NULL");
    expect(koppeling).toContain("declare_opening_balance_nil");
  });

});
