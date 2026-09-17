import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildAccountReport, type LedgerAccountReport, type LedgerPostingLike } from "@/lib/ledger-reporting";
import { CATEGORY_LABELS } from "@/lib/grootboek-saldi-utils";
import {
  buildTrialBalance,
  compareTrialBalanceRows,
  CSV_HEADERS,
  formatAmountNl,
  slugify,
  splitBalanceCents,
  trialBalanceCsvFilename,
  trialBalanceToCsv,
  type TrialBalance,
} from "@/lib/proef-saldibalans";

// Byte order mark als code point: een letterlijk teken in de bron is
// onzichtbaar en sneuvelt bij de eerste bewerking.
const BOM = String.fromCharCode(0xfeff);

/**
 * Fase 6C-b7 PR 3 — de pure laag van de proef- en saldibalans.
 *
 * De rapportagekern uit PR 1 draait hier ECHT mee: de fixtures zijn gewone
 * boekingsrijen die door `buildAccountReport()` gaan. Alleen de twee
 * faalscenario's die de kern per definitie niet kan produceren (punt 16)
 * gebruiken een handgemaakt rapport.
 */

/**
 * Commentaar weg, code over. De statische grenzen moeten bewijzen dat er geen
 * GEBRUIK is van een verboden bron — niet dat het woord nergens in een
 * toelichting voorkomt. Anders zou het commentaar "leest geen journal_entries"
 * zijn eigen test breken.
 */
function alleenCode(tekst: string): string {
  return tekst
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((r) => r.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const C1 = "client-1";
const Q1 = { from: "2027-01-01", toExclusive: "2027-04-01" };

let seq = 0;
function row(over: Partial<LedgerPostingLike> & Pick<LedgerPostingLike, "grootboekrekening_id">): LedgerPostingLike {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: C1,
    posting_group_id: "g-1",
    line_no: 1,
    posting_date: "2027-02-01",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "manual_journal",
    source_id: "mj-1",
    ...over,
  };
}
const grp = (g: string, date: string, legs: Array<[string, number, number]>) =>
  legs.map(([acc, d, c], i) =>
    row({ posting_group_id: g, line_no: i + 1, posting_date: date, grootboekrekening_id: acc, debit_amount: d, credit_amount: c }),
  );

const accounts = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true, client_id: null },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true, client_id: null },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true, client_id: null },
  { id: "gb-4999", nummer: 4999, omschrijving: "Oude rekening", categorie: "kosten", actief: false, client_id: null },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", actief: true, client_id: null },
  { id: "gb-0900", nummer: 900, omschrijving: "Privé-opnamen", categorie: "privé", actief: true, client_id: null },
  { id: "gb-9999", nummer: 9999, omschrijving: "Vrije tekst", categorie: "Kostem", actief: true, client_id: null },
  { id: "gb-7777", nummer: 7777, omschrijving: "Nooit gebruikt", categorie: "kosten", actief: true, client_id: null },
  { id: "gb-6666", nummer: 6666, omschrijving: "Andere administratie", categorie: "kosten", actief: true, client_id: "client-2" },
];

function balans(rows: LedgerPostingLike[], opties: { toonNul?: boolean } = {}): TrialBalance {
  const report = buildAccountReport({ rows, clientId: C1, period: Q1, accounts });
  return buildTrialBalance({
    report,
    accounts,
    clientId: C1,
    includeZeroAccounts: opties.toonNul ?? false,
  });
}
function ok(b: TrialBalance) {
  if (b.ok === false) throw new Error(`ongeldig: ${JSON.stringify(b.failures)}`);
  return b;
}
const rij = (b: ReturnType<typeof ok>, id: string) => b.rows.find((r) => r.account.id === id)!;

describe("proef-saldibalans — debet/credit-splitsing", () => {
  it("splitBalanceCents volgt de voorgeschreven regel", () => {
    expect(splitBalanceCents(12345)).toEqual({ debitCents: 12345, creditCents: 0 });
    expect(splitBalanceCents(-12345)).toEqual({ debitCents: 0, creditCents: 12345 });
    expect(splitBalanceCents(0)).toEqual({ debitCents: 0, creditCents: 0 });
  });

  it("4. een geldig, sluitend rapport levert rijen en totalen", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]])));
    expect(b.rows.map((r) => r.account.nummer)).toEqual([1600, 4000]);
    expect(b.totals.periodDebitCents).toBe(10000);
    expect(b.totals.periodCreditCents).toBe(10000);
  });

  it("5/7. debetsaldo komt in de debetkolom, credit blijft nul", () => {
    const b = ok(balans([
      ...grp("g-0", "2026-06-01", [["gb-4000", 500, 0], ["gb-1600", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 30, 0], ["gb-1600", 0, 30]]),
    ]));
    const k = rij(b, "gb-4000");
    expect(k.openingDebitCents).toBe(50000);
    expect(k.openingCreditCents).toBe(0);
    expect(k.closingDebitCents).toBe(53000);
    expect(k.closingCreditCents).toBe(0);
  });

  it("6/8. creditsaldo komt in de creditkolom als POSITIEF bedrag", () => {
    const b = ok(balans([
      ...grp("g-0", "2026-06-01", [["gb-4000", 500, 0], ["gb-1600", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 30, 0], ["gb-1600", 0, 30]]),
    ]));
    const c = rij(b, "gb-1600");
    expect(c.openingDebitCents).toBe(0);
    expect(c.openingCreditCents).toBe(50000);
    expect(c.closingCreditCents).toBe(53000);
    // Geen negatieve bedragen in de kolommen.
    expect(c.closingCreditCents).toBeGreaterThan(0);
  });

  it("9. een nulsaldo levert 0/0, geen kolomkeuze", () => {
    const b = ok(balans([
      ...grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1100", 0, 100]]),
      ...grp("g-2", "2027-02-02", [["gb-1100", 100, 0], ["gb-4000", 0, 100]]),
    ]));
    const k = rij(b, "gb-4000");
    expect([k.closingDebitCents, k.closingCreditCents]).toEqual([0, 0]);
    expect(k.periodDebitCents).toBe(10000);
    expect(k.periodCreditCents).toBe(10000);
  });

  it("10/11. periodekolommen zijn de bruto debet- en credittotalen", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-9999", 21, 0], ["gb-1600", 0, 121]])));
    expect(b.totals.periodDebitCents).toBe(12100);
    expect(b.totals.periodCreditCents).toBe(12100);
    expect(rij(b, "gb-1600").periodCreditCents).toBe(12100);
  });

  it("12/13/14. de drie paren sluiten", () => {
    const b = ok(balans([
      ...grp("g-0", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 121, 0], ["gb-1100", 0, 121]]),
      ...grp("g-2", "2027-03-01", [["gb-1100", 60, 0], ["gb-8000", 0, 60]]),
    ]));
    expect(b.totals.openingDebitCents).toBe(b.totals.openingCreditCents);
    expect(b.totals.periodDebitCents).toBe(b.totals.periodCreditCents);
    expect(b.totals.closingDebitCents).toBe(b.totals.closingCreditCents);
    expect(b.totals.openingDebitCents).toBe(50000);
  });
});

describe("proef-saldibalans — fail-closed", () => {
  it("15. een falende zelfcontrole van de kern levert GEEN cijfers", () => {
    // Twee halve groepen: de groepscontrole van de kern slaat aan.
    const rows = [
      row({ grootboekrekening_id: "gb-4000", debit_amount: 100, posting_group_id: "g-a" }),
      row({ grootboekrekening_id: "gb-1600", credit_amount: 100, posting_group_id: "g-b" }),
    ];
    const b = balans(rows);
    expect(b.ok).toBe(false);
    if (b.ok === false) {
      expect(b.failures[0].kind).toBe("kernel");
      expect("rows" in b).toBe(false);
      expect("totals" in b).toBe(false);
    }
  });

  it("16. een presentatiekant die niet verzoent, blokkeert eveneens", () => {
    // Handgemaakt rapport dat de kern nooit zou produceren: ok=true maar de
    // rollups sluiten niet. Dit bewijst dat de tweede controle echt bijt.
    const scheef: LedgerAccountReport = {
      ok: true,
      rollups: [
        {
          account: { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true, resolved: true },
          openingCents: 0, periodDebitCents: 10000, periodCreditCents: 0, closingCents: 10000, periodLineCount: 1,
        },
      ],
      totals: { openingCents: 0, periodDebitCents: 10000, periodCreditCents: 0, closingCents: 10000, rowCount: 1 },
    };
    const b = buildTrialBalance({ report: scheef });
    expect(b.ok).toBe(false);
    if (b.ok === false) {
      expect(b.failures.map((f) => f.kind).sort()).toEqual(["closing_unbalanced", "period_unbalanced"]);
    }
  });

  it("16b. een weggevallen rij met saldo breekt de verzoening (dat is het nut ervan)", () => {
    const heel: LedgerAccountReport = {
      ok: true,
      rollups: [
        {
          account: { id: "a", nummer: 1, omschrijving: "A", categorie: "activa", actief: true, resolved: true },
          openingCents: 0, periodDebitCents: 5000, periodCreditCents: 0, closingCents: 5000, periodLineCount: 1,
        },
        {
          account: { id: "b", nummer: 2, omschrijving: "B", categorie: "passiva", actief: true, resolved: true },
          openingCents: 0, periodDebitCents: 0, periodCreditCents: 5000, closingCents: -5000, periodLineCount: 1,
        },
      ],
      totals: { openingCents: 0, periodDebitCents: 5000, periodCreditCents: 5000, closingCents: 0, rowCount: 2 },
    };
    expect(buildTrialBalance({ report: heel }).ok).toBe(true);
    const half = { ...heel, rollups: [heel.ok === true ? heel.rollups[0] : never()] } as LedgerAccountReport;
    expect(buildTrialBalance({ report: half }).ok).toBe(false);
  });
});

function never(): never { throw new Error("onbereikbaar"); }

describe("proef-saldibalans — rijen en zichtbaarheid", () => {
  it("18. een inactieve rekening met saldo blijft staan", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-4999", 80, 0], ["gb-1600", 0, 80]])));
    expect(rij(b, "gb-4999").account.actief).toBe(false);
    expect(rij(b, "gb-4999").closingDebitCents).toBe(8000);
  });

  it("19. een niet-herleidbare rekening blijft staan, ook zonder saldo", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-ghost", 33, 0], ["gb-1600", 0, 33]])));
    const g = rij(b, "gb-ghost");
    expect(g.account.resolved).toBe(false);
    expect(g.account.omschrijving).toBe("Onbekende rekening");
    expect(g.closingDebitCents).toBe(3300);

    // Ook wanneer alles nul is (boekingen alleen vóór de periode, netto nul)
    // blijft hij zichtbaar, want zijn boekingen mogen niet uit beeld raken.
    const nul = ok(balans([
      ...grp("g-a", "2026-05-01", [["gb-ghost", 10, 0], ["gb-1600", 0, 10]]),
      ...grp("g-b", "2026-05-02", [["gb-1600", 10, 0], ["gb-ghost", 0, 10]]),
    ]));
    expect(nul.rows.map((r) => r.account.id)).toContain("gb-ghost");
    expect(rij(nul, "gb-ghost").isZero).toBe(true);
  });

  it("20. een vrije-tekstcategorie wordt 'onbekend', niet weggelaten", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-9999", 12, 0], ["gb-1600", 0, 12]])));
    expect(rij(b, "gb-9999").account.categorie).toBe("onbekend");
    expect(CATEGORY_LABELS[rij(b, "gb-9999").account.categorie]).toBe("Onbekend");
  });

  it("21. privé blijft privé, zonder balans- of W&V-indeling", () => {
    const b = ok(balans(grp("g-1", "2027-02-01", [["gb-0900", 40, 0], ["gb-1100", 0, 40]])));
    expect(rij(b, "gb-0900").account.categorie).toBe("privé");
    const bron = alleenCode(readFileSync("src/lib/proef-saldibalans.ts", "utf8"));
    expect(bron).not.toMatch(/eigen_vermogen|equity|balanceSheet|incomeStatement/i);
  });

  it("22. nulrekeningen zijn standaard verborgen", () => {
    const b = ok(balans([
      ...grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1100", 0, 100]]),
      // 1600 beweegt heen en terug vóór de periode: alles nul.
      ...grp("g-0a", "2026-06-01", [["gb-1600", 10, 0], ["gb-8000", 0, 10]]),
      ...grp("g-0b", "2026-06-02", [["gb-8000", 10, 0], ["gb-1600", 0, 10]]),
    ]));
    expect(b.rows.map((r) => r.account.id)).toEqual(["gb-1100", "gb-4000"]);
  });

  it("23. 'Toon nulrekeningen' voegt nulrijen én ongebruikte schemarekeningen toe", () => {
    const rows = grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1100", 0, 100]]);
    const b = ok(balans(rows, { toonNul: true }));
    const ids = b.rows.map((r) => r.account.id);
    expect(ids).toContain("gb-7777"); // nooit gebruikt, uit het schema
    expect(ids).not.toContain("gb-6666"); // hoort bij een andere administratie
    // De toegevoegde rijen zijn nul en dragen geen boekingen.
    expect(rij(b, "gb-7777")).toMatchObject({ isZero: true, hasPostings: false, closingDebitCents: 0 });
    // En ze veranderen geen enkel totaal.
    const zonder = ok(balans(rows));
    expect(b.totals).toEqual(zonder.totals);
  });

  it("sorteert op nummer, dan omschrijving, dan id — nooit op saldo", () => {
    const b = ok(balans([
      ...grp("g-1", "2027-02-01", [["gb-8000", 0, 900], ["gb-0900", 900, 0]]),
      ...grp("g-2", "2027-02-02", [["gb-4000", 1, 0], ["gb-1600", 0, 1]]),
      ...grp("g-3", "2027-02-03", [["gb-ghost", 5, 0], ["gb-1100", 0, 5]]),
    ]));
    // 900, 1100, 1600, 4000, 8000, daarna de rekening zonder nummer.
    expect(b.rows.map((r) => r.account.nummer)).toEqual([900, 1100, 1600, 4000, 8000, null]);
    const mk = (nummer: number | null, omschrijving: string, id: string) =>
      ({ account: { id, nummer, omschrijving, categorie: "activa", actief: null, resolved: true } }) as never;
    expect(compareTrialBalanceRows(mk(10, "B", "x"), mk(10, "A", "y"))).toBeGreaterThan(0);
    expect(compareTrialBalanceRows(mk(10, "A", "x"), mk(10, "A", "y"))).toBeLessThan(0);
  });
});

describe("proef-saldibalans — CSV", () => {
  const maak = (toonNul = false) => {
    const b = ok(balans([
      ...grp("g-0", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 121.5, 0], ["gb-1100", 0, 121.5]]),
    ], { toonNul }));
    return { b, csv: trialBalanceToCsv({ rows: b.rows, totals: b.totals, categoryLabel: (c) => CATEGORY_LABELS[c] }) };
  };

  it("33/34/35. puntkomma, kop, Nederlandse decimaalkomma", () => {
    const { csv } = maak();
    const regels = csv.trimEnd().split("\r\n");
    expect(regels[0]).toBe(CSV_HEADERS.map((h) => `"${h}"`).join(";"));
    expect(regels[0].split(";")).toHaveLength(9);
    expect(csv).toContain('"121,50"');
    expect(csv).not.toMatch(/\d+\.\d{2}/); // nergens een punt als decimaalscheider
  });

  it("34b. de BOM zit niet in de tekst zelf maar wordt bij download toegevoegd", () => {
    const { csv } = maak();
    expect(csv.startsWith(BOM)).toBe(false);
    const paginabron = readFileSync("src/pages/ProefSaldibalans.tsx", "utf8");
    // Expliciete escape in de bron, geen onzichtbaar teken dat bij een
    // bewerking stil kan wegvallen.
    expect(paginabron).toContain('const bom = "\\uFEFF";');
    // En nergens een echt, onzichtbaar BOM-teken in de bron.
    expect(paginabron.includes("\ufeff")).toBe(false);
    expect(paginabron).toContain("text/csv;charset=utf-8;");
  });

  it("32. exact dezelfde rijen en volgorde als het scherm, plus een totaalregel", () => {
    const { b, csv } = maak();
    const regels = csv.trimEnd().split("\r\n");
    expect(regels).toHaveLength(b.rows.length + 2); // kop + rijen + totaal
    b.rows.forEach((r, i) => {
      const velden = regels[i + 1].split(";");
      expect(velden[0]).toBe(`"${r.account.nummer ?? ""}"`);
      expect(velden[1]).toBe(`"${r.account.omschrijving}"`);
    });
    const totaal = regels[regels.length - 1].split(";");
    expect(totaal[3]).toBe(`"${formatAmountNl(b.totals.openingDebitCents)}"`);
    expect(totaal[8]).toBe(`"${formatAmountNl(b.totals.closingCreditCents)}"`);
  });

  it("32b. met 'Toon nulrekeningen' groeit de CSV mee met het scherm", () => {
    const zonder = maak(false);
    const met = maak(true);
    expect(met.b.rows.length).toBeGreaterThan(zonder.b.rows.length);
    expect(met.csv.trimEnd().split("\r\n")).toHaveLength(met.b.rows.length + 2);
    // De totalen blijven identiek: nulrijen tellen niet mee.
    expect(met.b.totals).toEqual(zonder.b.totals);
  });

  it("36. aanhalingstekens en puntkomma's in een omschrijving worden veilig ontsnapt", () => {
    const raar = [{ id: "gb-x", nummer: 4242, omschrijving: 'Kosten "extra"; en meer', categorie: "kosten", actief: true, client_id: null }];
    const report = buildAccountReport({
      rows: grp("g-1", "2027-02-01", [["gb-x", 10, 0], ["gb-1600", 0, 10]]),
      clientId: C1, period: Q1, accounts: [...raar, ...accounts],
    });
    const b = buildTrialBalance({ report });
    if (b.ok === false) throw new Error("onverwacht ongeldig");
    const csv = trialBalanceToCsv({ rows: b.rows, totals: b.totals, categoryLabel: (c) => CATEGORY_LABELS[c] });
    expect(csv).toContain('"Kosten ""extra""; en meer"');
    // De regel houdt precies negen velden, ondanks de puntkomma in de tekst.
    const regel = csv.split("\r\n").find((r) => r.includes("4242"))!;
    expect(regel.match(/(^|;)"/g)).toHaveLength(9);
  });

  it("37. geen euroteken of duizendtalscheiding in de bedragvelden", () => {
    const { csv } = maak();
    expect(csv).not.toContain("€");
    expect(csv).not.toMatch(/\d\.\d{3}/);
    expect(formatAmountNl(123456789)).toBe("1234567,89");
    expect(formatAmountNl(0)).toBe("0,00");
    expect(formatAmountNl(-500)).toBe("-5,00");
  });

  it("38. bestandsnaam bevat administratie en periode, zonder accenten of spaties", () => {
    expect(trialBalanceCsvFilename("Résidence Atlas", "01-02-2027 t/m 28-02-2027"))
      .toBe("proef-en-saldibalans-residence-atlas-01-02-2027-t-m-28-02-2027.csv");
    expect(trialBalanceCsvFilename("Klant Een", "2027")).toBe("proef-en-saldibalans-klant-een-2027.csv");
    expect(slugify("  ")).toBe("onbekend");
  });
});

describe("proef-saldibalans — statische grenzen", () => {
  const bestanden = [
    "src/lib/proef-saldibalans.ts",
    "src/pages/ProefSaldibalans.tsx",
    "src/components/overzichten/ProefSaldibalansTable.tsx",
  ].map((path) => ({ path, text: alleenCode(readFileSync(path, "utf8")) }));

  it("42/43. geen journal_entries en geen documenttotalen in het rapport", () => {
    for (const { path, text } of bestanden) {
      expect(text, path).not.toMatch(/journal_entries|useJournalEntries|journal-entry-utils|ledger-mutations/);
      expect(text, path).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount/);
      expect(text, path).not.toMatch(/usePurchaseInvoices|useSalesInvoices|useBankTransactions|snelstart-export/);
      const tabellen = [...text.matchAll(/from\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
      expect(tabellen, path).toEqual([]);
    }
  });

  it("de bedragen komen uitsluitend uit de rapportagekern", () => {
    const pagina = bestanden.find((b) => b.path.endsWith("ProefSaldibalans.tsx"))!.text;
    expect(pagina).toMatch(/buildAccountReport/);
    expect(pagina).toMatch(/buildTrialBalance/);
    expect(pagina).not.toMatch(/debit_amount|credit_amount|\.reduce\(/);
  });

  it("geen tekenomklap per categorie en geen reversal-filter", () => {
    for (const { path, text } of bestanden) {
      expect(text, path).not.toMatch(/reversal_of_posting_id/);
      // Geen tak die de categorie gebruikt om een bedrag te draaien.
      expect(text, path).not.toMatch(/categorie\s*===\s*["'](passiva|omzet)["'][^\n]*[-*]/);
    }
  });

  it("44/45/46. geen migratie, geen gegenereerde types, nav.ts ongewijzigd", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const gewijzigd = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
    expect(gewijzigd).not.toMatch(/supabase\/migrations\//);
    expect(gewijzigd).not.toMatch(/integrations\/supabase\/types\.ts/);
    expect(gewijzigd).not.toMatch(/components\/layout\/nav\.ts/);
    expect(gewijzigd).not.toMatch(/\.sql$/m);
  });
});
