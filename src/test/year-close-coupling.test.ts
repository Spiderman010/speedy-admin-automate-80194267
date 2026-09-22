import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * De koppeling tussen "boekjaar afgesloten" en "er mag niet meer worden
 * geboekt" — vastgepind zoals zij VANDAAG is.
 *
 * WAAROM DIT BESTAAT. `docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md` stelt voor die
 * twee begrippen uit elkaar te halen: afsluiten wordt een administratieve
 * gebeurtenis die kan worden teruggedraaid, en het schrijfverbod verhuist naar
 * een aparte, instelbare boekingsblokkade. Die operatie raakt ACHT schrijvers,
 * en de regel staat bij alle acht letterlijk in de code in plaats van in één
 * gedeelde functie.
 *
 * Het risico is dus niet dat de refactor fout gaat, maar dat hij ergens NIET
 * gebeurt: één schrijver die zijn oude toets houdt, weigert straks nog steeds
 * een correctie in een heropend boekjaar — en dat merk je pas in productie,
 * bij precies de klant die de correctie nodig heeft.
 *
 * Deze test telt daarom. Zij bewijst nu dat het er acht zijn en dat zij
 * identiek zijn, en zij valt om zodra dat verandert. Bij de uitrol hoort zij
 * mee te bewegen: dat is het moment om te bevestigen dat elke schrijver
 * bewust is meegenomen.
 *
 * ER WORDT HIER NIETS VOORGESCHREVEN. Dit is een waarneming van de bestaande
 * code, geen eis aan toekomstige code.
 */

const MIGRATIES = "supabase/migrations";

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
function uitvoerbaar(bestand: string): string {
  return readFileSync(resolve(process.cwd(), `${MIGRATIES}/${bestand}`), "utf8")
    .split("\n")
    .filter((regel) => !regel.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * De acht schrijfwegen naar het grootboek die vandaag op het watermerk
 * stuiten, met de lokale variabele waarin het boekjaar staat.
 */
const SCHRIJVERS: readonly { migratie: string; functie: string; jaarVariabele: string }[] = [
  { migratie: "20260915140000_add_purchase_ledger_posting.sql", functie: "post_purchase_invoice", jaarVariabele: "v_boekjaar" },
  { migratie: "20260915160000_add_sales_ledger_posting.sql", functie: "post_sales_invoice", jaarVariabele: "v_boekjaar" },
  { migratie: "20260917120000_add_bank_settlement_posting.sql", functie: "post_bank_allocation", jaarVariabele: "v_boekjaar" },
  { migratie: "20260918120000_add_manual_journal_posting.sql", functie: "post_manual_journal", jaarVariabele: "v_boekjaar" },
  { migratie: "20260919120000_add_opening_balance_posting.sql", functie: "post_opening_balance", jaarVariabele: "v_header.boekjaar" },
  { migratie: "20260919120000_add_opening_balance_posting.sql", functie: "declare_opening_balance_nil", jaarVariabele: "v_header.boekjaar" },
  { migratie: "20260921120000_add_ledger_reversal_posting.sql", functie: "reverse_posting_group", jaarVariabele: "v_boekjaar" },
  { migratie: "20260921140000_harden_bank_transaction_posting.sql", functie: "post_bank_transaction", jaarVariabele: "v_boekjaar" },
];

/** De body van één functie, van haar definitie tot de volgende definitie. */
function functieBody(sql: string, naam: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${naam}`);
  if (start < 0) return "";
  const volgende = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
  return sql.slice(start, volgende < 0 ? undefined : volgende);
}

describe("Afgesloten boekjaar = schrijfverbod, zoals het vandaag is", () => {
  it("1. alle acht schrijvers dragen de toets, elk in hun eigen functie", () => {
    for (const { migratie, functie, jaarVariabele } of SCHRIJVERS) {
      const body = functieBody(uitvoerbaar(migratie), functie);
      expect(body, `${functie} bestaat`).not.toBe("");
      expect(body.replace(/\s+/g, " "), functie).toContain(
        `v_client.afgesloten_boekjaar IS NOT NULL AND ${jaarVariabele} <= v_client.afgesloten_boekjaar`,
      );
    }
  });

  it("2. het zijn er precies acht — geen negende schrijfweg die we zouden missen", () => {
    // Elke migratie doorzoeken, zodat een nieuwe schrijver met dezelfde toets
    // deze test laat omvallen in plaats van stilletjes buiten beeld te blijven.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const gevonden: string[] = [];
    for (const bestand of readdirSync(resolve(process.cwd(), MIGRATIES)).filter((f) => f.endsWith(".sql"))) {
      const sql = uitvoerbaar(bestand);
      for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)) {
        const body = functieBody(sql, match[1]);
        if (/v_client\.afgesloten_boekjaar IS NOT NULL AND [\w.]+ <= v_client\.afgesloten_boekjaar/.test(body)) {
          gevonden.push(match[1]);
        }
      }
    }
    expect([...new Set(gevonden)].sort()).toEqual(SCHRIJVERS.map((s) => s.functie).sort());
  });

  it("3. de weigering is bij alle acht dezelfde tekst en dezelfde SQLSTATE", () => {
    for (const { migratie, functie } of SCHRIJVERS) {
      const body = functieBody(uitvoerbaar(migratie), functie).replace(/\s+/g, " ");
      expect(body, functie).toContain("'Boekjaar % is afgesloten voor deze administratie'");
      expect(body, functie).toMatch(/is afgesloten voor deze administratie'[^;]*ERRCODE = '22023'/);
    }
  });

  it("4. elke schrijver heeft op dat punt de ECHTE boekhoudkundige datum bij de hand", () => {
    /*
     * Dit is het feit waarop het ontwerp leunt: een blokkade op datumniveau
     * ("dicht t/m 31-12-2024") is haalbaar zonder één schrijver te
     * herstructureren, omdat de datum er al is. Zou een schrijver alleen een
     * jaartal kennen, dan was de datumkorrel voor hem onbereikbaar.
     */
    const datumBron: Record<string, RegExp> = {
      post_purchase_invoice: /EXTRACT\(YEAR FROM v_inv\.invoice_date\)/,
      post_sales_invoice: /EXTRACT\(YEAR FROM v_inv\.invoice_date\)/,
      post_bank_allocation: /EXTRACT\(YEAR FROM v_tx\.transaction_date\)/,
      post_manual_journal: /EXTRACT\(YEAR FROM v_journal\.posting_date\)/,
      post_opening_balance: /opening_date/,
      // De nihil-verklaring is de uitzondering en dat is geen slordigheid: zij
      // schrijft GEEN grootboekregel. Zij laadt de kop wel volledig (`SELECT *`),
      // dus `opening_date` is bereikbaar, maar de toets gaat over het BOEKJAAR
      // waarover zij een uitspraak doet. Zie sectie E2 van het ontwerpdocument:
      // voor deze ene schrijver is de boekjaarstatus de juiste beheersmaatregel
      // en niet de datumgebonden boekingsblokkade.
      declare_opening_balance_nil: /SELECT \* INTO v_header\s+FROM public\.opening_balances/,
      reverse_posting_group: /EXTRACT\(YEAR FROM _posting_date\)/,
      post_bank_transaction: /EXTRACT\(YEAR FROM v_tx\.transaction_date\)/,
    };
    for (const { migratie, functie } of SCHRIJVERS) {
      const body = functieBody(uitvoerbaar(migratie), functie);
      expect(body, functie).toMatch(datumBron[functie]);
    }
  });

  it("5. PR D: elke gedateerde schrijver handhaaft de boekingsblokkade, de nihil-verklaring niet", () => {
    /*
     * HERSCHREVEN BIJ PR D. De invariant van PR C luidde: "de helper bestaat,
     * maar geen schrijver gebruikt hem". PR D heeft de handhaving aangezet, en
     * daarmee wordt de bewering scherper in plaats van zwakker:
     *
     *   - de zeven GEDATEERDE schrijvers toetsen de blokkade;
     *   - declare_opening_balance_nil doet dat met opzet NIET (zij schrijft
     *     geen grootboekregel en doet een uitspraak over een boekjaar);
     *   - en alle acht dragen nog steeds hun oude afgesloten-jaar-toets.
     */
    const PRD = "20260928120000_enforce_posting_lock.sql";
    const sql = uitvoerbaar(PRD);

    // De helper is er precies één keer, en de assertie ook.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const bestanden = readdirSync(resolve(process.cwd(), MIGRATIES)).filter((f) => f.endsWith(".sql"));
    expect(
      bestanden.filter((b) => /CREATE OR REPLACE FUNCTION public\.posting_allowed\(/.test(uitvoerbaar(b))),
      "posting_allowed() is precies één keer gedefinieerd",
    ).toHaveLength(1);
    expect(
      bestanden.filter((b) =>
        /CREATE OR REPLACE FUNCTION public\.assert_posting_allowed\(/.test(uitvoerbaar(b)),
      ),
      "assert_posting_allowed() is precies één keer gedefinieerd",
    ).toEqual([PRD]);

    // Eén tekst, één SQLSTATE, en de grendel vóór het oordeel.
    const helper = functieBody(sql, "assert_posting_allowed").replace(/\s+/g, " ");
    expect(helper).toContain(
      "'Boekingsdatum % valt binnen de boekingsblokkade t/m % voor deze administratie'",
    );
    expect(helper).toMatch(/valt binnen de boekingsblokkade[^;]*ERRCODE = '22023'/);
    expect(helper.indexOf("lock_ledger_client")).toBeGreaterThan(-1);
    expect(helper.indexOf("lock_ledger_client")).toBeLessThan(helper.indexOf("posting_allowed(_client_id"));

    // De zeven gedateerde schrijvers, met de datum waarop zij toetsen.
    const GEDATEERD: Record<string, string> = {
      post_purchase_invoice: "v_inv.client_id, v_inv.invoice_date",
      post_sales_invoice: "v_inv.client_id, v_inv.invoice_date",
      post_bank_allocation: "v_alloc.client_id, v_tx.transaction_date",
      post_manual_journal: "v_journal.client_id, v_journal.posting_date",
      post_opening_balance: "v_header.client_id, v_header.opening_date",
      // De tegenboeking toetst haar EIGEN datum, niet die van het origineel.
      reverse_posting_group: "v_client_id, _posting_date",
      post_bank_transaction: "v_tx.client_id, v_tx.transaction_date",
    };
    for (const [functie, argumenten] of Object.entries(GEDATEERD)) {
      const body = functieBody(sql, functie);
      expect(body, `${functie} is in PR D herdefinieerd`).not.toBe("");
      expect(body.replace(/\s+/g, " "), functie).toContain(
        `PERFORM public.assert_posting_allowed(${argumenten});`,
      );
      // En de oude grendel staat er nog, ongewijzigd.
      expect(body.replace(/\s+/g, " "), `${functie} houdt het jaarwatermerk`).toMatch(
        /v_client\.afgesloten_boekjaar IS NOT NULL AND [\w.]+ <= v_client\.afgesloten_boekjaar/,
      );
      expect(body, functie).toContain("'Boekjaar % is afgesloten voor deze administratie'");
    }

    // De uitzondering: nergens in de migraties raakt de nihil-verklaring de
    // blokkade aan.
    for (const bestand of bestanden) {
      const nil = functieBody(uitvoerbaar(bestand), "declare_opening_balance_nil");
      if (nil === "") continue;
      expect(nil, "declare_opening_balance_nil blijft buiten de boekingsblokkade").not.toMatch(
        /posting_allowed|posting_locked_through/,
      );
      expect(nil.replace(/\s+/g, " ")).toContain(
        "v_client.afgesloten_boekjaar IS NOT NULL AND v_header.boekjaar <= v_client.afgesloten_boekjaar",
      );
    }
  });


  it("6. het watermerk kan vandaag niet omlaag — heropenen bestaat niet", () => {
    const sql = uitvoerbaar("20260924120000_add_year_close_writer.sql");
    const trigger = functieBody(sql, "enforce_year_close_watermark").replace(/\s+/g, " ");
    expect(trigger).toContain(
      "NEW.afgesloten_boekjaar IS NULL OR NEW.afgesloten_boekjaar < OLD.afgesloten_boekjaar",
    );
    // En er is geen enkele functie die het terugdraaien zou kunnen doen.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.\w*(reopen|heropen)\w*/i);
  });

  it("7. de bulk-preflight herhaalt de regel zelf, buiten de schrijver om", () => {
    /*
     * Risico 6 uit het ontwerpdocument, hier vastgelegd zodat het niet wordt
     * vergeten: deze read-only kandidatenlijst toetst het watermerk met eigen
     * SQL in plaats van via de schrijver. Verhuist de regel, dan moet deze
     * plek apart mee.
     */
    const sql = uitvoerbaar("20260922120000_add_bank_bulk_posting.sql").replace(/\s+/g, " ");
    expect(sql).toContain(
      "EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar",
    );
  });
});
