import { describe, expect, it } from "vitest";
import {
  accountCategoryNote,
  amountForRpc,
  applyBoekjaarChange,
  areLinesDirty,
  buildHeaderInsertPayload,
  buildHeaderUpdatePayload,
  buildSaveLinesPayload,
  AMOUNT_OVERFLOW_MESSAGE,
  classifyOpeningBalanceError,
  CONFLICT_TWO_NIL,
  createEmptyLineRow,
  createEmptyLineRows,
  createHeaderForm,
  DEADLOCK_MESSAGE,
  dbAmountToCents,
  deriveOpeningBalanceState,
  firstNilBlockingReason,
  firstPostingBlockingReason,
  formatCentsInput,
  headerIssues,
  isBlankLine,
  isHeaderDirty,
  lineBlocksSave,
  lineIssues,
  lineTotals,
  NETWORK_MESSAGE,
  parseExactAmount,
  POST_CONFIRM_POINTS,
  safeErrorMetadata,
  SCHEMA_UNAVAILABLE_MESSAGE,
  STALE_MESSAGE,
  toLineRows,
  type OpeningBalanceAccountRef,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
  type OpeningBalanceMarker,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — pure logica van de beginbalans-UI.
 *
 * Exacte centen, nooit float-gelijkheid; geen afronding van invoer; de
 * toestand uitsluitend uit claimtabel en kop; de poorten als UX-hint; de
 * foutvertaling naar Nederlands zonder rauwe SQLSTATE.
 */

const accounts: OpeningBalanceAccountRef[] = [
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true, client_id: null },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true, client_id: null },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog", categorie: "omzet", actief: true, client_id: null },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true, client_id: null },
  { id: "gb-651", nummer: 651, omschrijving: "Privé-stortingen", categorie: "privé", actief: true, client_id: null },
  { id: "gb-oud", nummer: 1999, omschrijving: "Oude rekening", categorie: "activa", actief: false, client_id: null },
  { id: "gb-ander", nummer: 1234, omschrijving: "Van andere klant", categorie: "activa", actief: true, client_id: "c-2" },
];
const accountsById = new Map(accounts.map((a) => [a.id, a]));

const line = (over: Partial<OpeningBalanceLineRow> = {}): OpeningBalanceLineRow => ({
  ...createEmptyLineRow(),
  ...over,
});

const header = (over: Partial<OpeningBalanceHeaderForm> = {}): OpeningBalanceHeaderForm => ({
  boekjaar: "2027",
  opening_date: "2027-01-01",
  description: "Beginbalans 2027",
  reference: "",
  ...over,
});

const headerRow = (over: Partial<OpeningBalanceRow> = {}): OpeningBalanceRow => ({
  id: "ob-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: 2027,
  opening_date: "2027-01-01",
  description: "Beginbalans 2027",
  reference: null,
  nil_declaration: false,
  nil_declared_at: null,
  nil_declared_by: null,
  created_at: "2027-01-01T00:00:00Z",
  updated_at: "2027-01-01T00:00:00Z",
  ...over,
});

const markerRow = (over: Partial<OpeningBalanceMarker> = {}): OpeningBalanceMarker => ({
  opening_balance_id: "ob-1",
  posting_group_id: "g-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: 2027,
  opening_date: "2027-01-01",
  line_count: 2,
  total_amount: 1000,
  created_at: "2027-01-02T00:00:00Z",
  ...over,
});

const balanced = (): OpeningBalanceLineRow[] => [
  line({ grootboekrekening_id: "gb-1300", grootboek_label: "1300 - Debiteuren", debit_input: "1000,00" }),
  line({ grootboekrekening_id: "gb-1600", grootboek_label: "1600 - Crediteuren", credit_input: "1000,00" }),
];

const gate = (over: Partial<Parameters<typeof firstPostingBlockingReason>[0]> = {}) =>
  firstPostingBlockingReason({
    openingBalanceId: "ob-1",
    markerUnavailable: false,
    stateUncertain: false,
    canPost: true,
    isDirty: false,
    isSaving: false,
    header: header(),
    lines: balanced(),
    accountsById,
    clientId: "c-1",
    ...over,
  });

describe("parseExactAmount — exacte centen", () => {
  it("11/12. leest komma- en puntinvoer exact als centen", () => {
    expect(parseExactAmount("1234,56")).toEqual({ kind: "ok", cents: 123456 });
    expect(parseExactAmount("1234.56")).toEqual({ kind: "ok", cents: 123456 });
    expect(parseExactAmount("12")).toEqual({ kind: "ok", cents: 1200 });
    expect(parseExactAmount("0,1")).toEqual({ kind: "ok", cents: 10 });
    expect(parseExactAmount(",5")).toEqual({ kind: "ok", cents: 50 });
    expect(parseExactAmount(" 7 ")).toEqual({ kind: "ok", cents: 700 });
    expect(parseExactAmount("")).toEqual({ kind: "empty" });
    expect(parseExactAmount("   ")).toEqual({ kind: "empty" });
  });

  it("16. bekende float-valkuilen zijn in centen exact (0,29 + 0,01 = 0,30)", () => {
    const totals = lineTotals([line({ debit_input: "0,29" }), line({ debit_input: "0,01" }), line({ credit_input: "0,30" })]);
    expect(totals.debitCents).toBe(30);
    expect(totals.creditCents).toBe(30);
    expect(totals.differenceCents).toBe(0);
    expect(totals.isBalanced).toBe(true);
  });

  it("14. negatief is ongeldig, met de waarde die de RPC te zien krijgt", () => {
    expect(parseExactAmount("-5")).toEqual({ kind: "invalid", reason: "negative", value: -5 });
    expect(parseExactAmount("-0,50")).toEqual({ kind: "invalid", reason: "negative", value: -0.5 });
    // -0 is gewoon nul.
    expect(parseExactAmount("-0")).toEqual({ kind: "ok", cents: 0 });
  });

  it("15. meer dan twee betekenisvolle decimalen wordt NIET afgerond maar als ongeldig gemeld", () => {
    expect(parseExactAmount("0,005")).toEqual({ kind: "invalid", reason: "decimals", value: 0.005 });
    expect(parseExactAmount("1,234")).toEqual({ kind: "invalid", reason: "decimals", value: 1.234 });
    // Alleen nullen na de tweede decimaal is wél een tweedecimaal bedrag.
    expect(parseExactAmount("1,500")).toEqual({ kind: "ok", cents: 150 });
  });

  it("een bedrag boven de kolomgrens (numeric(12,2)) is ongeldig, niet afgekapt", () => {
    expect(parseExactAmount("9999999999,99")).toEqual({ kind: "ok", cents: 999999999999 });
    expect(parseExactAmount("10000000000")).toEqual({ kind: "invalid", reason: "too-large", value: 10000000000 });
    expect(parseExactAmount("99999999999999999999")).toMatchObject({ kind: "invalid", reason: "too-large" });
    expect(lineIssues(line({ debit_input: "10000000000" }), accountsById, "c-1")[0].code).toBe("too-large");
  });

  it("onleesbare tekst is ongeldig zonder waarde", () => {
    expect(parseExactAmount("abc")).toEqual({ kind: "invalid", reason: "unparseable", value: null });
    expect(parseExactAmount("1.234,56")).toEqual({ kind: "invalid", reason: "unparseable", value: null });
    expect(parseExactAmount("-")).toEqual({ kind: "invalid", reason: "unparseable", value: null });
    expect(parseExactAmount(",")).toEqual({ kind: "invalid", reason: "unparseable", value: null });
  });

  it("formatCentsInput en dbAmountToCents zijn elkaars spiegel", () => {
    expect(formatCentsInput(123456)).toBe("1234,56");
    expect(formatCentsInput(5)).toBe("0,05");
    expect(formatCentsInput(-2100)).toBe("-21,00");
    expect(dbAmountToCents(0.29)).toBe(29);
    expect(dbAmountToCents("1234.56")).toBe(123456);
    expect(dbAmountToCents(null)).toBe(0);
  });

  it("amountForRpc: geldig exact, ongeldig onafgerond, leeg 0, onleesbaar null", () => {
    expect(amountForRpc("1234,56")).toBe(1234.56);
    expect(amountForRpc("0,005")).toBe(0.005);
    expect(amountForRpc("-5")).toBe(-5);
    expect(amountForRpc("")).toBe(0);
    expect(amountForRpc("abc")).toBeNull();
  });
});

describe("lineTotals — totalen en verschil", () => {
  it("17. gelijk en groter dan nul is in balans, verschil 0", () => {
    const t = lineTotals(balanced());
    expect(t).toEqual({ debitCents: 100000, creditCents: 100000, differenceCents: 0, invalidLineCount: 0, isBalanced: true });
  });

  it("18. verschil is getekend: debet − credit", () => {
    const lines = balanced();
    lines[1] = { ...lines[1], credit_input: "1021,00" };
    const t = lineTotals(lines);
    expect(t.differenceCents).toBe(-2100);
    expect(t.isBalanced).toBe(false);
  });

  it("19. 0 tegen 0 is geen balans", () => {
    expect(lineTotals(createEmptyLineRows(2)).isBalanced).toBe(false);
  });

  it("ongeldige regels tellen niet mee en blokkeren de balans", () => {
    const lines = balanced();
    lines.push(line({ debit_input: "0,005" }));
    const t = lineTotals(lines);
    expect(t.invalidLineCount).toBe(1);
    expect(t.debitCents).toBe(100000);
    expect(t.isBalanced).toBe(false);
  });
});

describe("lineIssues — zichtbare regelfouten", () => {
  it("13. debet én credit gevuld is een fout", () => {
    const issues = lineIssues(line({ debit_input: "10", credit_input: "5" }), accountsById, "c-1");
    expect(issues.map((i) => i.code)).toEqual(["both-sides"]);
  });

  it("14/15. negatief en te veel decimalen worden gemeld, niet gecorrigeerd", () => {
    expect(lineIssues(line({ debit_input: "-5" }), accountsById, "c-1")[0].code).toBe("negative");
    expect(lineIssues(line({ credit_input: "0,005" }), accountsById, "c-1")[0].code).toBe("decimals");
  });

  it("10. inactieve of andermans rekening op een bestaande regel wordt gemeld", () => {
    expect(lineIssues(line({ grootboekrekening_id: "gb-oud" }), accountsById, "c-1")[0].code).toBe("inactive-account");
    expect(lineIssues(line({ grootboekrekening_id: "gb-ander" }), accountsById, "c-1")[0].code).toBe("out-of-scope-account");
    expect(lineIssues(line({ grootboekrekening_id: "gb-weg" }), accountsById, "c-1")[0].code).toBe("unknown-account");
    expect(lineIssues(line({ grootboekrekening_id: "gb-1300" }), accountsById, "c-1")).toEqual([]);
  });

  it("een lege regel of een regel zonder rekening is geen fout (concept)", () => {
    expect(lineIssues(line(), accountsById, "c-1")).toEqual([]);
    expect(lineIssues(line({ debit_input: "10" }), accountsById, "c-1")).toEqual([]);
  });

  it("alleen onleesbare invoer blokkeert opslaan", () => {
    expect(lineBlocksSave(line({ debit_input: "abc" }))).toBe(true);
    expect(lineBlocksSave(line({ debit_input: "0,005" }))).toBe(false);
    expect(lineBlocksSave(line({ debit_input: "-5" }))).toBe(false);
  });
});

describe("accountCategoryNote — alleen een hint", () => {
  it("33/34/35. omzet, kosten en privé krijgen een niet-blokkerende opmerking", () => {
    expect(accountCategoryNote("omzet")).toMatch(/Omzetrekening/);
    expect(accountCategoryNote("kosten")).toMatch(/Kostenrekening/);
    expect(accountCategoryNote("privé")).toMatch(/Privérekening/);
    expect(accountCategoryNote(" Kosten ")).toMatch(/Kostenrekening/);
  });

  it("activa, passiva en vrije tekst krijgen niets", () => {
    expect(accountCategoryNote("activa")).toBeNull();
    expect(accountCategoryNote("passiva")).toBeNull();
    expect(accountCategoryNote("iets anders")).toBeNull();
    expect(accountCategoryNote(undefined)).toBeNull();
  });

  it("33. een omzetregel blokkeert boeken niet", () => {
    const lines = balanced();
    lines[0] = { ...lines[0], grootboekrekening_id: "gb-8000" };
    expect(gate({ lines })).toBeNull();
  });
});

describe("payloads", () => {
  it("25. de regel-payload bevat uitsluitend regelgegevens, in volgorde, met onafgeronde bedragen", () => {
    const payload = buildSaveLinesPayload([
      line({ description: " Debiteuren ", grootboekrekening_id: "gb-1300", debit_input: "1000,00" }),
      line({ grootboekrekening_id: "gb-1600", credit_input: "999,995" }),
      line(), // blanco: wordt niet opgeslagen
    ]);
    expect(payload).toEqual([
      { sort_order: 0, grootboekrekening_id: "gb-1300", description: "Debiteuren", debit_amount: 1000, credit_amount: 0 },
      { sort_order: 1, grootboekrekening_id: "gb-1600", description: null, debit_amount: 0, credit_amount: 999.995 },
    ]);
    for (const p of payload) {
      expect(Object.keys(p).sort()).toEqual(["credit_amount", "debit_amount", "description", "grootboekrekening_id", "sort_order"]);
    }
  });

  it("de kop-payload bevat nooit organization_id, user_id of nihil-kolommen", () => {
    const insert = buildHeaderInsertPayload(header({ reference: " REF " }), "c-1");
    expect(insert).toEqual({ client_id: "c-1", boekjaar: 2027, opening_date: "2027-01-01", description: "Beginbalans 2027", reference: "REF" });
    const update = buildHeaderUpdatePayload(header({ description: "  " }));
    expect(update).toEqual({ boekjaar: 2027, opening_date: "2027-01-01", description: null, reference: null });
    for (const key of Object.keys({ ...insert, ...update })) {
      expect(key).not.toMatch(/nil_|organization_id|user_id/);
    }
  });

  it("isBlankLine herkent alleen volledig lege rijen", () => {
    expect(isBlankLine(line())).toBe(true);
    expect(isBlankLine(line({ description: "x" }))).toBe(false);
    expect(isBlankLine(line({ debit_input: "0" }))).toBe(false);
  });
});

describe("kop", () => {
  it("3/4. een nieuwe kop begint op 1 januari van het boekjaar met een zinvolle omschrijving", () => {
    expect(createHeaderForm(2027)).toEqual({
      boekjaar: "2027",
      opening_date: "2027-01-01",
      description: "Beginbalans 2027",
      reference: "",
    });
  });

  it("boekjaar wijzigen zet de datum terug naar 1 januari en laat de standaardomschrijving meelopen", () => {
    const next = applyBoekjaarChange(createHeaderForm(2027), "2026");
    expect(next).toEqual({ boekjaar: "2026", opening_date: "2026-01-01", description: "Beginbalans 2026", reference: "" });
    // Een eigen omschrijving blijft staan.
    const own = applyBoekjaarChange(header({ description: "Overname uit Excel" }), "2026");
    expect(own.description).toBe("Overname uit Excel");
    // Half getypt jaar: datum blijft, geen crash.
    expect(applyBoekjaarChange(header(), "20").opening_date).toBe("2027-01-01");
  });

  it("5. jaar en datum die niet bij elkaar horen worden gemeld", () => {
    expect(headerIssues(header())).toEqual([]);
    expect(headerIssues(header({ opening_date: "2026-12-31" }))[0]).toMatch(/valt niet in boekjaar 2027/);
    expect(headerIssues(header({ boekjaar: "1999" }))[0]).toMatch(/tussen 2000 en 2100/);
    expect(headerIssues(header({ opening_date: "" }))[0]).toMatch(/openingsdatum/i);
  });

  it("dirty-detectie vergelijkt de payload, niet de tekst", () => {
    expect(isHeaderDirty(header(), header())).toBe(false);
    expect(isHeaderDirty(header({ description: "Beginbalans 2027 " }), header())).toBe(false);
    expect(isHeaderDirty(header({ reference: "X" }), header())).toBe(true);
    expect(isHeaderDirty(header(), null)).toBe(true);
    expect(areLinesDirty(createEmptyLineRows(2), [])).toBe(false);
    expect(areLinesDirty([line({ debit_input: "100" })], [line({ debit_input: "100,00" })])).toBe(false);
    expect(areLinesDirty([line({ debit_input: "100" })], [])).toBe(true);
  });

  it("6. databaseregels worden aangevuld tot minimaal twee rijen, met labels uit de volledige lijst", () => {
    const rows = toLineRows(
      [{
        id: "l-1", opening_balance_id: "ob-1", organization_id: "org-1", client_id: "c-1", user_id: "u-1",
        sort_order: 0, grootboekrekening_id: "gb-oud", description: null, debit_amount: 12.5, credit_amount: 0,
        created_at: "", updated_at: "",
      }],
      accountsById,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].grootboek_label).toBe("1999 - Oude rekening");
    expect(rows[0].debit_input).toBe("12,50");
    expect(rows[0].credit_input).toBe("");
    expect(rows[1].id).toBeNull();
    expect(toLineRows(undefined, accountsById)).toHaveLength(2);
  });
});

describe("deriveOpeningBalanceState — vier toestanden, nooit samengevoegd", () => {
  it("2. geen kop → none", () => {
    expect(deriveOpeningBalanceState({ headers: [], marker: null, boekjaar: 2027 })).toEqual({ kind: "none", otherDrafts: [] });
  });

  it("precies één concept voor het jaar → draft", () => {
    const h = headerRow();
    const s = deriveOpeningBalanceState({ headers: [h], marker: null, boekjaar: 2027 });
    expect(s.kind).toBe("draft");
    expect(s.kind === "draft" && s.header.id).toBe("ob-1");
  });

  it("44. meer dan één concept voor het jaar → multiple-drafts, er wordt niet gekozen", () => {
    const s = deriveOpeningBalanceState({
      headers: [headerRow(), headerRow({ id: "ob-2", opening_date: "2027-01-02" })],
      marker: null,
      boekjaar: 2027,
    });
    expect(s.kind).toBe("multiple-drafts");
    expect(s.kind === "multiple-drafts" && s.drafts.map((d) => d.id)).toEqual(["ob-1", "ob-2"]);
  });

  it("concepten voor een ander jaar worden apart gemeld", () => {
    const s = deriveOpeningBalanceState({ headers: [headerRow({ boekjaar: 2026, opening_date: "2026-01-01" })], marker: null, boekjaar: 2027 });
    expect(s.kind).toBe("none");
    expect(s.kind === "none" && s.otherDrafts.map((d) => d.boekjaar)).toEqual([2026]);
  });

  it("29. een claimrij → posted, ongeacht het gekozen jaar", () => {
    const s = deriveOpeningBalanceState({ headers: [headerRow()], marker: markerRow(), boekjaar: 2030 });
    expect(s.kind).toBe("posted");
    expect(s.kind === "posted" && s.header?.id).toBe("ob-1");
    // Ook als de kop (nog) niet in de lijst zit blijft het geboekt.
    const s2 = deriveOpeningBalanceState({ headers: [], marker: markerRow(), boekjaar: 2027 });
    expect(s2.kind).toBe("posted");
    expect(s2.kind === "posted" && s2.header).toBeNull();
  });

  it("41. nil_declaration + nil_declared_at → nil; nooit 'geen beginbalans'", () => {
    const s = deriveOpeningBalanceState({
      headers: [headerRow({ nil_declaration: true, nil_declared_at: "2027-01-05T10:00:00Z", nil_declared_by: "u-9" })],
      marker: null,
      boekjaar: 2030,
    });
    expect(s.kind).toBe("nil");
  });

  it("43. geboekt én nihil is onmogelijk → conflict, alleen-lezen", () => {
    const s = deriveOpeningBalanceState({
      headers: [headerRow({ nil_declaration: true, nil_declared_at: "2027-01-05T10:00:00Z", nil_declared_by: "u-9" })],
      marker: markerRow({ opening_balance_id: "ob-2" }),
      boekjaar: 2027,
    });
    expect(s.kind).toBe("conflict");
  });

  it("twee nihil-verklaringen zijn een eigen conflict; achtergebleven concepten blijven zichtbaar", () => {
    const nil = (id: string) => headerRow({ id, nil_declaration: true, nil_declared_at: "2027-01-05T10:00:00Z", nil_declared_by: "u-9" });
    expect(deriveOpeningBalanceState({ headers: [nil("a"), nil("b")], marker: null, boekjaar: 2027 })).toEqual({ kind: "conflict", message: CONFLICT_TWO_NIL });
    const posted = deriveOpeningBalanceState({ headers: [headerRow(), headerRow({ id: "rest" })], marker: markerRow(), boekjaar: 2027 });
    expect(posted.kind === "posted" && posted.leftoverDrafts.map((d) => d.id)).toEqual(["rest"]);
    const nilState = deriveOpeningBalanceState({ headers: [nil("a"), headerRow({ id: "rest" })], marker: null, boekjaar: 2027 });
    expect(nilState.kind === "nil" && nilState.leftoverDrafts.map((d) => d.id)).toEqual(["rest"]);
  });

  it("een halve nihil-verklaring (vlag zonder tijdstip) is een conflict, geen nihil", () => {
    const s = deriveOpeningBalanceState({ headers: [headerRow({ nil_declaration: true })], marker: null, boekjaar: 2027 });
    expect(s.kind).toBe("conflict");
  });
});

describe("firstPostingBlockingReason — UX-poort", () => {
  it("in balans, opgeslagen, accountant → geen reden", () => {
    expect(gate()).toBeNull();
  });

  it("18. niet in balans → geblokkeerd, met het verschil", () => {
    const lines = balanced();
    lines[1] = { ...lines[1], credit_input: "999,00" };
    expect(gate({ lines })).toMatch(/niet gelijk \(verschil €\s1,00\)/);
  });

  it("19. nul totaal → geblokkeerd", () => {
    const lines = [
      line({ grootboekrekening_id: "gb-1300", debit_input: "0" }),
      line({ grootboekrekening_id: "gb-1600", credit_input: "0" }),
    ];
    expect(gate({ lines })).toBe("Elke regel heeft een bedrag nodig.");
  });

  it("20. ontbrekende rekening → geblokkeerd", () => {
    const lines = balanced();
    lines[0] = { ...lines[0], grootboekrekening_id: null };
    expect(gate({ lines })).toBe("Elke regel heeft een grootboekrekening nodig.");
  });

  it("13/14/15. ongeldige regel → geblokkeerd met de regelfout", () => {
    const both = balanced();
    both[0] = { ...both[0], credit_input: "1" };
    expect(gate({ lines: both })).toMatch(/tegelijk debet en credit/);
    const neg = balanced();
    neg[0] = { ...neg[0], debit_input: "-1000" };
    expect(gate({ lines: neg })).toMatch(/Negatieve bedragen/);
    const dec = balanced();
    dec[0] = { ...dec[0], debit_input: "1000,005" };
    expect(gate({ lines: dec })).toMatch(/Maximaal twee decimalen/);
  });

  it("kop: omschrijving, boekjaar en datum zijn verplicht en moeten kloppen", () => {
    expect(gate({ header: header({ description: " " }) })).toBe("Vul een omschrijving in.");
    expect(gate({ header: header({ opening_date: "2026-06-30" }) })).toMatch(/valt niet in boekjaar/);
    expect(gate({ header: header({ boekjaar: "" }) })).toMatch(/boekjaar/i);
  });

  it("22/24. geen accountant of onbekende rol → geblokkeerd", () => {
    expect(gate({ canPost: false })).toBe("Alleen een accountant kan een beginbalans boeken.");
    expect(gate({ canPost: undefined })).toBe("Rechten worden gecontroleerd…");
  });

  it("niet opgeslagen, bezig met opslaan of onzekere toestand → geblokkeerd", () => {
    expect(gate({ openingBalanceId: null })).toBe("Sla de beginbalans eerst op.");
    expect(gate({ isDirty: true })).toBe("Er zijn niet-opgeslagen wijzigingen. Sla eerst op.");
    expect(gate({ isSaving: true })).toBe("Opslaan is nog bezig…");
    expect(gate({ stateUncertain: true })).toBe("Boekingsstatus wordt geladen…");
    expect(gate({ markerUnavailable: true })).toBe(SCHEMA_UNAVAILABLE_MESSAGE);
  });

  it("10. een inactieve of andermans rekening blokkeert boeken (de database keurt opnieuw)", () => {
    const inactive = balanced();
    inactive[0] = { ...inactive[0], grootboekrekening_id: "gb-oud" };
    expect(gate({ lines: inactive })).toMatch(/inactief/);
    const foreign = balanced();
    foreign[0] = { ...foreign[0], grootboekrekening_id: "gb-ander" };
    expect(gate({ lines: foreign })).toMatch(/andere administratie/);
  });

  it("32. er wordt nooit een sluitregel toegevoegd: de poort verandert de regels niet", () => {
    const lines = balanced();
    lines[1] = { ...lines[1], credit_input: "500,00" };
    const before = JSON.stringify(lines);
    gate({ lines });
    expect(JSON.stringify(lines)).toBe(before);
    expect(lineTotals(lines).differenceCents).toBe(50000);
  });

  it("de bevestigingstekst noemt grootboek, onveranderbaar, geen terugdraaifunctie en compenserende boeking", () => {
    const text = POST_CONFIRM_POINTS.join(" ");
    expect(text).toMatch(/grootboek/);
    expect(text).toMatch(/onveranderbaar/);
    expect(text).toMatch(/geen functie om .* terug te draaien/);
    expect(text).toMatch(/compenserende boeking/);
  });
});

describe("firstNilBlockingReason", () => {
  const nilGate = (over: Partial<Parameters<typeof firstNilBlockingReason>[0]> = {}) =>
    firstNilBlockingReason({
      openingBalanceId: "ob-1",
      markerUnavailable: false,
      stateUncertain: false,
      canDeclare: true,
      isHeaderDirty: false,
      isSaving: false,
      header: header(),
      savedLineCount: 0,
      lines: createEmptyLineRows(2),
      ...over,
    });

  it("kop opgeslagen, geen regels, accountant → geen reden", () => {
    expect(nilGate()).toBeNull();
  });

  it("37. opgeslagen of getypte regels blokkeren de nihil-verklaring", () => {
    expect(nilGate({ savedLineCount: 2 })).toMatch(/2 opgeslagen regel/);
    expect(nilGate({ lines: [line({ debit_input: "10" })] })).toMatch(/nog regels in het formulier/);
  });

  it("36. alleen een accountant; onbekend is niet toegestaan", () => {
    expect(nilGate({ canDeclare: false })).toMatch(/Alleen een accountant/);
    expect(nilGate({ canDeclare: undefined })).toBe("Rechten worden gecontroleerd…");
  });

  it("kop moet bestaan, opgeslagen zijn en kloppen", () => {
    expect(nilGate({ openingBalanceId: null })).toBe("Sla de beginbalans eerst op (zonder regels).");
    expect(nilGate({ isHeaderDirty: true })).toMatch(/niet-opgeslagen wijzigingen/);
    expect(nilGate({ header: header({ opening_date: "2026-01-01" }) })).toMatch(/valt niet in boekjaar/);
  });
});

describe("classifyOpeningBalanceError — Nederlandse meldingen, nooit een SQLSTATE", () => {
  it("42501 → rechten, met de databasemelding als die Nederlands is", () => {
    const c = classifyOpeningBalanceError({ code: "42501", message: "Geen rechten om een beginbalans te boeken voor deze organisatie (accountant vereist)" });
    expect(c.kind).toBe("permission");
    expect(c.message).toMatch(/accountant vereist/);
    expect(classifyOpeningBalanceError({ code: "42501", message: "permission denied for table opening_balances" }).message).not.toMatch(/permission denied/);
  });

  it("22023 / 23514 / 22004 / P0002 → validatie met de servertekst", () => {
    expect(classifyOpeningBalanceError({ code: "22023", message: "Bedragen mogen maximaal twee decimalen hebben" })).toMatchObject({ kind: "validation", message: "Bedragen mogen maximaal twee decimalen hebben" });
    expect(classifyOpeningBalanceError({ code: "23514", message: "Beginbalans is niet in balans: debet 100.00 is ongelijk aan credit 99.00 (verschil 1.00)" }).message).toMatch(/verschil 1.00/);
    expect(classifyOpeningBalanceError({ code: "22004", message: "Beginbalans heeft geen datum of boekjaar; boeken is niet mogelijk" }).kind).toBe("validation");
    expect(classifyOpeningBalanceError({ code: "P0002", message: "Beginbalans niet gevonden" }).kind).toBe("validation");
  });

  it("48. de weigering wegens eerdere grootboekfeiten komt letterlijk door", () => {
    const c = classifyOpeningBalanceError({
      code: "22023",
      message: "Er staan al boekingen vóór 2027-01-01 in het grootboek van deze administratie (laatste: 2026-11-30); een beginbalans moet het eerste feit zijn",
    });
    expect(c.kind).toBe("validation");
    expect(c.message).toMatch(/eerste feit/);
  });

  it("een Engelse CHECK-schending wordt per constraint vertaald", () => {
    const c = classifyOpeningBalanceError({
      code: "23514",
      message: 'new row for relation "opening_balances" violates check constraint "opening_balances_boekjaar_matches_date_check"',
    });
    expect(c.message).toMatch(/kalenderjaren/);
    expect(c.message).not.toMatch(/violates/);
  });

  it("47. 23505 → duplicaat, per index vertaald of met de servertekst", () => {
    expect(classifyOpeningBalanceError({ code: "23505", message: "Deze beginbalans is al geboekt" })).toMatchObject({ kind: "duplicate", message: "Deze beginbalans is al geboekt" });
    expect(classifyOpeningBalanceError({ code: "23505", message: 'duplicate key value violates unique constraint "uniq_opening_balance_postings_client"' }).message).toBe("Deze administratie heeft al een geboekte beginbalans.");
    expect(classifyOpeningBalanceError({ code: "23505", message: 'duplicate key value violates unique constraint "uniq_opening_balance_nil_per_client"' }).message).toMatch(/nihil-verklaring/);
  });

  it("45. 40001 → stale, met opnieuw-laden-tekst", () => {
    expect(classifyOpeningBalanceError({ code: "40001", message: "De beginbalans is tussentijds gewijzigd; probeer opnieuw" })).toMatchObject({ kind: "stale", message: STALE_MESSAGE });
  });

  it("46. 40P01 → deadlock met de vaste, herhaalbare melding", () => {
    expect(classifyOpeningBalanceError({ code: "40P01", message: "deadlock detected" })).toMatchObject({ kind: "deadlock", message: DEADLOCK_MESSAGE });
    expect(DEADLOCK_MESSAGE).toBe("Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw.");
  });

  it("schemacache-fouten → neutrale deploy-venstertekst", () => {
    for (const err of [
      { code: "PGRST202", message: "Could not find the function public.post_opening_balance in the schema cache" },
      { code: "PGRST205", message: "Could not find the table 'public.opening_balances' in the schema cache" },
      { code: "42P01", message: 'relation "public.opening_balances" does not exist' },
    ]) {
      expect(classifyOpeningBalanceError(err)).toMatchObject({ kind: "schema", message: SCHEMA_UNAVAILABLE_MESSAGE });
    }
  });

  it("22003, netwerkfouten en een verlopen sessie krijgen een eigen Nederlandse tekst", () => {
    expect(classifyOpeningBalanceError({ code: "22003", message: "numeric field overflow" })).toMatchObject({ kind: "validation", message: AMOUNT_OVERFLOW_MESSAGE });
    expect(classifyOpeningBalanceError(new TypeError("Failed to fetch"))).toMatchObject({ kind: "unknown", message: NETWORK_MESSAGE });
    expect(classifyOpeningBalanceError({ message: "NetworkError when attempting to fetch resource." }).message).toBe(NETWORK_MESSAGE);
    expect(classifyOpeningBalanceError({ code: "PGRST301", message: "JWT expired" })).toMatchObject({ kind: "permission" });
    expect(classifyOpeningBalanceError({ code: "PGRST301", message: "JWT expired" }).message).not.toMatch(/JWT/);
  });

  it("onbekend → nooit een rauwe SQLSTATE of lege tekst", () => {
    expect(classifyOpeningBalanceError({ code: "XX000", message: "XX000: internal error" }).message).toBe("De actie is niet gelukt. Probeer het opnieuw.");
    expect(classifyOpeningBalanceError(undefined).message).toBe("De actie is niet gelukt. Probeer het opnieuw.");
    expect(classifyOpeningBalanceError(new Error("Netwerk weg")).message).toBe("Netwerk weg");
  });

  it("veilige metadata bevat code en soort, nooit de melding", () => {
    const meta = safeErrorMetadata({ code: "23514", message: "Beginbalans is niet in balans: debet 100.00 is ongelijk aan credit 99.00" });
    expect(meta).toEqual({ code: "23514", kind: "validation" });
    expect(JSON.stringify(meta)).not.toMatch(/100\.00/);
  });
});
