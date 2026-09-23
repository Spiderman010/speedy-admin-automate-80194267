import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 6C-b11 PR D — de schrijvers toetsen de boekingsblokkade.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/writers-posting-lock/` en draait tegen een
 * echte PostgreSQL (37 bewijzen): zeven schrijvers op drie datums, de
 * bulk-preflight, de onafhankelijkheidsmatrix, en twee werkelijk gelijktijdige
 * sessies.
 *
 * Dit bestand bewaakt de VORM, en vooral de twee beloftes die deze PR
 * onderscheiden: de bestaande afsluittoets blijft overal staan, en de
 * nihil-verklaring doet bewust niet mee.
 */

const MIGRATION_SLUG = "_writers_respect_posting_lock.sql";
const MIGRATION_DIR = "supabase/migrations";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith(MIGRATION_SLUG),
);
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

const ruw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const sql = ruw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const code = sql.replace(/COMMENT ON [^;]*;/g, "");

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/** De zeven gedateerde schrijvers, met hun bron en hun autoritatieve datum. */
const SCHRIJVERS: readonly { functie: string; bron: string; datum: string }[] = [
  { functie: "post_purchase_invoice", bron: "20260915140000_add_purchase_ledger_posting.sql", datum: "v_inv.invoice_date" },
  { functie: "post_sales_invoice", bron: "20260915160000_add_sales_ledger_posting.sql", datum: "v_inv.invoice_date" },
  { functie: "post_bank_allocation", bron: "20260917120000_add_bank_settlement_posting.sql", datum: "v_tx.transaction_date" },
  { functie: "post_manual_journal", bron: "20260918120000_add_manual_journal_posting.sql", datum: "v_journal.posting_date" },
  { functie: "post_opening_balance", bron: "20260919120000_add_opening_balance_posting.sql", datum: "v_header.opening_date" },
  { functie: "reverse_posting_group", bron: "20260921120000_add_ledger_reversal_posting.sql", datum: "_posting_date" },
  { functie: "post_bank_transaction", bron: "20260921140000_harden_bank_transaction_posting.sql", datum: "v_tx.transaction_date" },
];

function body(bron: string, naam: string): string {
  const start = bron.indexOf(`CREATE OR REPLACE FUNCTION public.${naam}(`);
  if (start < 0) return "";
  // Tot de eigen afsluiter. De schrijvers eindigen op `$$;`, de gedeelde
  // bewering op `$fn$;` — op alleen de eerste zoeken laat dat fragment
  // doorlopen tot in de volgende functie, op de volgende CREATE zoeken sleept
  // juist de REVOKE/GRANT/COMMENT eronder mee.
  const einden = ["\n$$;\n", "\n$fn$;\n"]
    .map((afsluiter) => ({ afsluiter, index: bron.indexOf(afsluiter, start) }))
    .filter((e) => e.index > -1)
    .sort((a, b) => a.index - b.index);
  if (einden.length === 0) return bron.slice(start);
  return bron.slice(start, einden[0].index + einden[0].afsluiter.length);
}

function zonderCommentaar(tekst: string): string {
  return tekst
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("Migratie — de gedeelde bewering", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_writers_respect_posting_lock\.sql$/);
  });

  it("2. voegt precies één functie toe en herdefinieert de acht bekende", () => {
    const functies = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.sort()).toEqual(
      [
        "assert_posting_allowed",
        "bank_bulk_posting_candidates",
        ...SCHRIJVERS.map((s) => s.functie),
      ].sort(),
    );
    // Geen schema-ingrepen: dit is een gedragsmigratie, geen ontwerpwijziging.
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE TRIGGER|CREATE POLICY|CREATE (UNIQUE )?INDEX/);
  });

  it("3. de bewering is SECURITY DEFINER, vast zoekpad, en niet verleend", () => {
    const helper = body(sql, "assert_posting_allowed").replace(/\s+/g, " ");
    expect(helper).toContain("RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.assert_posting_allowed\(uuid, date\) FROM PUBLIC/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.assert_posting_allowed/);
  });

  it("4. zij leunt op posting_allowed() en verzint geen eigen grens", () => {
    const helper = body(sql, "assert_posting_allowed");
    expect(helper).toContain("IF public.posting_allowed(_client_id, _posting_date) THEN");
    // Geen tweede vergelijking op de blokkadedatum: dan konden helper en
    // bewering uit elkaar gaan lopen.
    expect(helper).not.toMatch(/_posting_date\s*(<=|>|>=|<)\s*/);
  });

  it("5. de melding noemt datum én grens, en gebruikt SQLSTATE 22023", () => {
    const helper = body(sql, "assert_posting_allowed");
    expect(helper).toContain(
      "'Boekingsdatum % valt binnen de boekingsblokkade t/m % voor deze administratie'",
    );
    // 22023 is bewust: de applicatie behandelt die code al als toonbare
    // validatiefout. Een nieuwe code zou hiervan "onbekende fout" maken.
    expect([...helper.matchAll(/ERRCODE = '(\w+)'/g)].map((m) => m[1])).toEqual(["22023", "22023"]);
  });

  it("6. zonder blokkade een neutrale melding — fail closed zonder te verklappen", () => {
    const helper = body(sql, "assert_posting_allowed");
    expect(helper).toContain("IF v_through IS NULL THEN");
    expect(helper).toContain("'De boekingsdatum kan niet worden beoordeeld voor deze administratie'");
  });
});

describe("De zeven schrijvers", () => {
  it.each(SCHRIJVERS)("7. $functie toetst de blokkade op $datum", ({ functie, datum }) => {
    const nieuw = body(sql, functie);
    expect(nieuw, `${functie} staat in de migratie`).not.toBe("");
    expect(nieuw).toContain(`PERFORM public.assert_posting_allowed(v_client.id, ${datum});`);
  });

  it.each(SCHRIJVERS)("8. $functie neemt de administratiegrendel vóór die toets", ({ functie }) => {
    /*
     * Zonder dit is er een gat: toetsen, een ander verzet de blokkade, en dan
     * alsnog boeken. `set_posting_lock()` neemt dezelfde grendel, dus zodra de
     * schrijver hem houdt kunnen de twee niet meer door elkaar lopen.
     */
    const nieuw = body(sql, functie);
    const grendel = nieuw.indexOf("PERFORM public.lock_ledger_client(v_client.id);");
    const toets = nieuw.indexOf("PERFORM public.assert_posting_allowed");
    expect(grendel, functie).toBeGreaterThan(-1);
    expect(grendel, functie).toBeLessThan(toets);
  });

  it.each(SCHRIJVERS)("9. $functie houdt zijn afgesloten-jaar-toets, en die gaat voor", ({ functie }) => {
    const nieuw = body(sql, functie);
    expect(nieuw).toMatch(/v_client\.afgesloten_boekjaar IS NOT NULL AND [\w.]+ <= v_client\.afgesloten_boekjaar/);
    expect(nieuw).toContain("'Boekjaar % is afgesloten voor deze administratie'");
    // De oude toets staat vóór de nieuwe, zodat elke bestaande weigering haar
    // bestaande reden houdt.
    expect(nieuw.indexOf("afgesloten_boekjaar IS NOT NULL")).toBeLessThan(
      nieuw.indexOf("assert_posting_allowed"),
    );
  });

  it.each(SCHRIJVERS)("10. $functie is verder byte-identiek aan zijn origineel", ({ functie, bron }) => {
    /*
     * De sterkste vorm van "er is verder niets veranderd": haal het toegevoegde
     * blok eruit en wat overblijft moet letterlijk de bestaande functie zijn.
     * Zo kan er geen regel in de herkeuring, de grendels of de foutmeldingen
     * zijn verschoven zonder dat deze test omvalt.
     */
    const origineel = zonderCommentaar(
      readFileSync(resolve(process.cwd(), `${MIGRATION_DIR}/${bron}`), "utf8"),
    );
    const teruggedraaid = body(sql, functie).replace(
      /\n *PERFORM public\.lock_ledger_client\(v_client\.id\);\n *PERFORM public\.assert_posting_allowed\([^;]*\);\n/,
      "",
    );
    expect(teruggedraaid.trim()).toBe(body(origineel, functie).trim());
  });
});

describe("De nihil-verklaring doet bewust niet mee", () => {
  it("11. declare_opening_balance_nil() wordt niet herdefinieerd", () => {
    expect(sql).not.toContain("FUNCTION public.declare_opening_balance_nil");
  });

  it("12. en de migratie legt uit waaróm — zodat het een keuze blijft, geen omissie", () => {
    /*
     * Zij schrijft geen grootboekregel en doet een uitspraak over een BOEKJAAR,
     * niet over een datum. Een datumgebonden blokkade opleggen aan iets wat
     * niet boekt, zou betekenen dat een blokkade t/m 31-12-2024 een
     * nihil-verklaring over 2024 tegenhoudt zonder dat er één boeking bij komt
     * kijken. Dit is de enige plek waar ik proza toets, en met opzet: het
     * gevaar hier is dat een latere PR de uitzondering "opruimt".
     */
    /*
     * Eerst de commentaarstreepjes weg, dán witruimte normaliseren. De
     * toelichting is over regels afgebroken, en tussen die regels staat telkens
     * `--`; alleen witruimte samentrekken laat dat middenin de zin staan.
     */
    const toelichting = ruw
      .split("\n")
      .map((regel) => regel.replace(/^\s*--\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(toelichting).toContain("declare_opening_balance_nil");
    expect(toelichting).toMatch(/uitspraak over een BOEKJAAR, niet een boeking op een DATUM/i);
  });
});

describe("De bulk-preflight is het eens met de schrijver", () => {
  const bulk = body(sql, "bank_bulk_posting_candidates");

  it("13. gebruikt exact dezelfde grens", () => {
    // `<=`, dus de blokkadedatum zelf telt mee — gelijk aan posting_allowed().
    expect(bulk.replace(/\s+/g, " ")).toContain(
      "WHEN c.posting_locked_through IS NOT NULL AND t.transaction_date <= c.posting_locked_through",
    );
    expect(bulk).not.toMatch(/t\.transaction_date < c\.posting_locked_through/);
  });

  it("14. en dezelfde formulering, zodat scherm en schrijver niet uiteenlopen", () => {
    expect(bulk).toContain("Boekingsdatum %s valt binnen de boekingsblokkade t/m %s voor deze administratie");
  });

  it("15. de afsluit-tak blijft ervóór staan, dus bestaande redenen wijzigen niet", () => {
    expect(bulk.indexOf("afgesloten_boekjaar")).toBeLessThan(bulk.indexOf("posting_locked_through"));
    expect(bulk).toContain("Boekjaar %s is afgesloten voor deze administratie.");
  });

  it("16. is verder byte-identiek aan het origineel", () => {
    const origineel = zonderCommentaar(
      readFileSync(resolve(process.cwd(), `${MIGRATION_DIR}/20260922120000_add_bank_bulk_posting.sql`), "utf8"),
    );
    const teruggedraaid = bulk
      .replace(
        /\n {6}WHEN c\.posting_locked_through IS NOT NULL\n {7}AND t\.transaction_date <= c\.posting_locked_through\n {56}THEN 'blocked'/,
        "",
      )
      .replace(
        /\n {6}WHEN c\.posting_locked_through IS NOT NULL\n {7}AND t\.transaction_date <= c\.posting_locked_through\n {56}THEN format\([^)]*\)/,
        "",
      );
    expect(teruggedraaid.trim()).toBe(body(origineel, "bank_bulk_posting_candidates").trim());
  });
});

describe("PR D raakt verder niets aan", () => {
  it("17. close_fiscal_year(), set_posting_lock() en de gebeurtenistabellen blijven ongemoeid", () => {
    expect(code).not.toMatch(/close_fiscal_year|set_posting_lock/);
    expect(code).not.toMatch(/fiscal_year_events|posting_lock_events|year_closures/);
  });

  it("18. geen heropening en geen nieuwe rechten", () => {
    const functies = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.filter((naam) => /reopen|heropen/i.test(naam))).toEqual([]);
    // De migratie verleent nergens iets bij.
    expect(sql).not.toMatch(/GRANT/);
  });

  it("19. de eerdere migraties zijn niet bewerkt", () => {
    changed
      .filter((f) => f.startsWith("supabase/migrations/"))
      .forEach((f) => expect(f).toBe(MIGRATION));
  });

  it("20. de app en de gegenereerde types zijn niet aangeraakt", () => {
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });
});
