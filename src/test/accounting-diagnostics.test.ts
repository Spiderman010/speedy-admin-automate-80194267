import { describe, expect, it } from "vitest";
import {
  diagnosticsForDocument,
  diagnosticsForLedger,
  postingGroupBalances,
  severityForBlock,
  summarizeDiagnostics,
  summarizeLedger,
  type LedgerDiagnosticsAccount,
} from "@/lib/accounting-diagnostics";
import {
  aggregateInvoiceLines,
  evaluatePurchaseInvoice,
  evaluateSalesInvoice,
  type CatchupBlock,
  type CatchupClientConfig,
  type CatchupPurchaseInvoice,
  type CatchupSalesInvoice,
} from "@/lib/ledger-catchup";
import { evaluateLedgerIntegrity } from "@/lib/ledger-integrity";
import type { LedgerPostingLike } from "@/lib/ledger-reporting";

/**
 * De diagnostiek is een VERTALING van bestaande beoordelingen, geen tweede
 * regelset. Daarom lopen deze tests door de échte `evaluatePurchaseInvoice()`,
 * `evaluateSalesInvoice()` en `evaluateLedgerIntegrity()` — zou iemand daar een
 * regel veranderen, dan verandert de uitkomst hier mee, precies zoals bedoeld.
 */

const CLIENT = "client-1";

const volledigeConfig: CatchupClientConfig = {
  id: CLIENT, afgesloten_boekjaar: null,
  crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb",
  btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb",
};

const inkoop = (over: Partial<CatchupPurchaseInvoice> = {}): CatchupPurchaseInvoice => ({
  id: "pi-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev BV", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});

const verkoop = (over: Partial<CatchupSalesInvoice> = {}): CatchupSalesInvoice => ({
  id: "si-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "V-1", customer_name: "Klant BV", amount_excl: 200, amount_incl: 242,
  btw_amount: 42, btw_verlegd: false, grootboekrekening_id: "omzet-1", ...over,
});

const regels = (over: Partial<{ amount_excl: number | null; grootboekrekening_id: string | null }>[] = [{}]) =>
  aggregateInvoiceLines(over.map((o) => ({ amount_excl: 100, grootboekrekening_id: "gb-1", ...o })));

const GEEN_GROEPEN = { existingPostingGroups: new Set<string>(), balancedPostingGroups: new Set<string>() };

const pi = (
  invoice = inkoop(),
  config = volledigeConfig,
  lines = regels(),
  postingGroupId: string | null = null,
) => evaluatePurchaseInvoice({ invoice, config, lines, postingGroupId });

const si = (invoice = verkoop(), config = volledigeConfig, postingGroupId: string | null = null) =>
  evaluateSalesInvoice({ invoice, config, postingGroupId });

const codes = (items: { code: string }[]) => items.map((i) => i.code);
const bij = (items: { code: string; severity: string }[], code: string) =>
  items.find((i) => i.code === code)!;

// ─────────────────────────────────────────────────────────────────────────────
describe("inkoopdiagnostiek", () => {
  it("1. postbare factuur zonder opgeslagen regels → fout", () => {
    const items = diagnosticsForDocument(pi(inkoop(), volledigeConfig, aggregateInvoiceLines([])), GEEN_GROEPEN);
    expect(codes(items)).toContain("geen_boekingsregels");
    expect(bij(items, "geen_boekingsregels").severity).toBe("error");
    expect(items[0].domain).toBe("purchase");
    expect(items[0].targetUrl).toBe("/facturen/inkoop/pi-1");
  });

  it("2. regel zonder rekening → fout bij goedgekeurd, waarschuwing bij concept", () => {
    const goedgekeurd = diagnosticsForDocument(
      pi(inkoop(), volledigeConfig, regels([{ grootboekrekening_id: null }])), GEEN_GROEPEN,
    );
    expect(bij(goedgekeurd, "regel_zonder_rekening").severity).toBe("error");

    const concept = diagnosticsForDocument(
      pi(inkoop({ status: "te_controleren" }), volledigeConfig, regels([{ grootboekrekening_id: null }])), GEEN_GROEPEN,
    );
    expect(bij(concept, "regel_zonder_rekening").severity).toBe("warning");
    // De status zelf is werk, geen bederf.
    expect(bij(concept, "status_niet_postbaar").severity).toBe("warning");
  });

  it("3. regel met bedrag ≤ 0 wordt gemeld met de ernst van de writer", () => {
    const items = diagnosticsForDocument(
      pi(inkoop(), volledigeConfig, regels([{ amount_excl: 120 }, { amount_excl: -20 }])), GEEN_GROEPEN,
    );
    expect(bij(items, "regel_bedrag_niet_positief").severity).toBe("error");
  });

  it("4. regels die niet op de kop aansluiten → fout", () => {
    const items = diagnosticsForDocument(
      pi(inkoop(), volledigeConfig, regels([{ amount_excl: 90 }])), GEEN_GROEPEN,
    );
    expect(bij(items, "regels_sluiten_niet_aan").severity).toBe("error");
  });

  it("5. excl + btw ≠ incl → fout", () => {
    const items = diagnosticsForDocument(pi(inkoop({ amount_incl: 120 })), GEEN_GROEPEN);
    expect(bij(items, "bedragen_sluiten_niet_aan").severity).toBe("error");
  });

  it("6. ontbrekende crediteurenrekening → waarschuwing, geen bederf", () => {
    const items = diagnosticsForDocument(
      pi(inkoop(), { ...volledigeConfig, crediteuren_rekening_id: null }), GEEN_GROEPEN,
    );
    expect(bij(items, "geen_crediteurenrekening").severity).toBe("warning");
  });

  it("7. ontbrekende BTW-rekening bij BTW > 0 → waarschuwing", () => {
    const items = diagnosticsForDocument(
      pi(inkoop(), { ...volledigeConfig, btw_te_vorderen_rekening_id: null }), GEEN_GROEPEN,
    );
    expect(bij(items, "geen_btw_rekening").severity).toBe("warning");
  });

  it("8. afgesloten boekjaar → fout, ook bij een concept", () => {
    const items = diagnosticsForDocument(
      pi(inkoop({ status: "te_controleren", invoice_date: "2025-06-01" }), { ...volledigeConfig, afgesloten_boekjaar: 2025 }),
      GEEN_GROEPEN,
    );
    expect(bij(items, "boekjaar_afgesloten").severity).toBe("error");
  });

  it("9. klaar maar niet geboekt is werk, geen bederf", () => {
    const items = diagnosticsForDocument(pi(), GEEN_GROEPEN);
    expect(codes(items)).toEqual(["klaar_niet_geboekt"]);
    expect(items[0].severity).toBe("warning");
    expect(items[0].message).toBe("Klaar maar nog niet geboekt.");
  });

  it("10. marker zonder boekingsgroep → fout, op het document", () => {
    const items = diagnosticsForDocument(pi(inkoop(), volledigeConfig, regels(), "pg-weg"), GEEN_GROEPEN);
    expect(codes(items)).toEqual(["marker_zonder_boekingsgroep"]);
    expect(items[0].severity).toBe("error");
    expect(items[0].message).toContain("pg-weg");
  });

  it("11. geboekt met sluitende groep → in orde", () => {
    const items = diagnosticsForDocument(pi(inkoop(), volledigeConfig, regels(), "pg-1"), {
      existingPostingGroups: new Set(["pg-1"]),
      balancedPostingGroups: new Set(["pg-1"]),
    });
    expect(codes(items)).toEqual(["geboekt_en_sluitend"]);
    expect(items[0].severity).toBe("ok");
  });

  it("11b. geboekt met een groep die niet sluit → fout", () => {
    const items = diagnosticsForDocument(pi(inkoop(), volledigeConfig, regels(), "pg-1"), {
      existingPostingGroups: new Set(["pg-1"]),
      balancedPostingGroups: new Set<string>(),
    });
    expect(codes(items)).toEqual(["geboekt_maar_groep_niet_in_balans"]);
    expect(items[0].severity).toBe("error");
  });
});

describe("verkoopdiagnostiek", () => {
  it("12. ontbrekende omzetrekening → fout op een goedgekeurde factuur", () => {
    const items = diagnosticsForDocument(si(verkoop({ grootboekrekening_id: null })), GEEN_GROEPEN);
    expect(bij(items, "geen_omzetrekening").severity).toBe("error");
    expect(items[0].domain).toBe("sales");
    expect(items[0].targetUrl).toBe("/verkoop");
  });

  it("13. ontbrekende debiteurenrekening → waarschuwing", () => {
    const items = diagnosticsForDocument(si(verkoop(), { ...volledigeConfig, debiteuren_rekening_id: null }), GEEN_GROEPEN);
    expect(bij(items, "geen_debiteurenrekening").severity).toBe("warning");
  });

  it("14. ontbrekende BTW-te-betalen-rekening → waarschuwing", () => {
    const items = diagnosticsForDocument(si(verkoop(), { ...volledigeConfig, btw_te_betalen_rekening_id: null }), GEEN_GROEPEN);
    expect(bij(items, "geen_btw_rekening").severity).toBe("warning");
  });

  it("15. verlegde BTW wordt gemeld zoals de writer hem weigert", () => {
    const items = diagnosticsForDocument(si(verkoop({ btw_verlegd: true })), GEEN_GROEPEN);
    expect(bij(items, "btw_verlegd").severity).toBe("error");
  });

  it("16. niet-postbare status en ontbrekende bedragen", () => {
    const concept = diagnosticsForDocument(si(verkoop({ status: "concept" })), GEEN_GROEPEN);
    expect(bij(concept, "status_niet_postbaar").severity).toBe("warning");

    const zonderBedrag = diagnosticsForDocument(si(verkoop({ amount_incl: null })), GEEN_GROEPEN);
    expect(bij(zonderBedrag, "bedragen_ontbreken").severity).toBe("error");
  });

  it("17. klaar maar niet geboekt, en geboekt + sluitend", () => {
    expect(codes(diagnosticsForDocument(si(), GEEN_GROEPEN))).toEqual(["klaar_niet_geboekt"]);
    const geboekt = diagnosticsForDocument(si(verkoop(), volledigeConfig, "pg-2"), {
      existingPostingGroups: new Set(["pg-2"]), balancedPostingGroups: new Set(["pg-2"]),
    });
    expect(geboekt[0].severity).toBe("ok");
  });

  it("18. marker zonder boekingsgroep → fout", () => {
    const items = diagnosticsForDocument(si(verkoop(), volledigeConfig, "pg-weg"), GEEN_GROEPEN);
    expect(items[0].code).toBe("marker_zonder_boekingsgroep");
    expect(items[0].severity).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("grootboekdiagnostiek", () => {
  const rekening = (over: Partial<LedgerDiagnosticsAccount> = {}): LedgerDiagnosticsAccount => ({
    id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten", client_id: null,
    statement_type: "winst_verlies", report_group: "overige_bedrijfskosten", ...over,
  });

  const groep = (id: string, credit = "100.00"): LedgerPostingLike[] => {
    const base = {
      client_id: CLIENT, posting_group_id: id, posting_date: "2026-04-01",
      boekjaar: 2026, currency: "EUR", source_type: "manual_journal",
    };
    return [
      { ...base, id: `${id}-1`, line_no: 1, grootboekrekening_id: "gb-1", debit_amount: "100.00", credit_amount: "0.00" },
      { ...base, id: `${id}-2`, line_no: 2, grootboekrekening_id: "gb-1", debit_amount: "0.00", credit_amount: credit },
    ];
  };

  const ledger = (over: Partial<Parameters<typeof diagnosticsForLedger>[0]> = {}) =>
    diagnosticsForLedger({
      integrityFindings: [], postings: [], accounts: [rekening()], clientId: CLIENT,
      markerClaimsPerGroup: new Map(), ...over,
    });

  it("19. een niet-sluitende groep komt uit de bestaande controle als fout", () => {
    const postings = groep("pg-scheef", "90.00");
    const integrity = evaluateLedgerIntegrity({
      purchaseInvoices: [], purchaseLines: [], markers: [], postings,
    });
    const items = ledger({ integrityFindings: integrity.findings, postings });
    expect(bij(items, "boekingsgroep_niet_in_balans").severity).toBe("error");
  });

  it("20. een sluitende groep levert niets op", () => {
    const postings = groep("pg-1");
    const integrity = evaluateLedgerIntegrity({ purchaseInvoices: [], purchaseLines: [], markers: [], postings });
    expect(ledger({ integrityFindings: integrity.findings, postings })).toEqual([]);
  });

  it("21. wees-marker → fout", () => {
    const integrity = evaluateLedgerIntegrity({
      purchaseInvoices: [], purchaseLines: [],
      markers: [{ soort: "inkoop", posting_group_id: "pg-weg" }], postings: [],
    });
    const items = ledger({ integrityFindings: integrity.findings });
    expect(bij(items, "marker_zonder_boekingsgroep").severity).toBe("error");
  });

  it("22. twee markers op dezelfde groep → fout", () => {
    const items = ledger({ markerClaimsPerGroup: new Map([["pg-1", 2]]) });
    expect(bij(items, "dubbele_groepsclaim").severity).toBe("error");
    expect(items[0].message).toContain("2 boekingsmarkers");
    // Eén claim is normaal.
    expect(ledger({ markerClaimsPerGroup: new Map([["pg-1", 1]]) })).toEqual([]);
  });

  it("23. regel naar een onbekende rekening → fout", () => {
    const postings = groep("pg-1").map((r) => ({ ...r, grootboekrekening_id: "gb-onbekend" }));
    const items = ledger({ postings });
    expect(bij(items, "regel_zonder_bestaande_rekening").severity).toBe("error");
  });

  it("24. geboekt op een rekening van een andere administratie → fout", () => {
    const items = ledger({ postings: groep("pg-1"), accounts: [rekening({ client_id: "client-2" })] });
    expect(bij(items, "rekening_buiten_administratie").severity).toBe("error");
    // Een rekening van DEZE administratie is gewoon goed.
    expect(ledger({ postings: groep("pg-1"), accounts: [rekening({ client_id: CLIENT })] })).toEqual([]);
  });

  it("25. activiteit zonder volledige classificatie → waarschuwing", () => {
    const items = ledger({ postings: groep("pg-1"), accounts: [rekening({ statement_type: null, report_group: null })] });
    expect(bij(items, "activiteit_zonder_classificatie").severity).toBe("warning");
    expect(items[0].reference).toBe("4400 - Kantoorkosten");
    expect(items[0].targetUrl).toBe("/grootboek/saldi/gb-1");
  });

  it("26. een halve classificatie telt niet als geclassificeerd", () => {
    const items = ledger({
      postings: groep("pg-1"),
      accounts: [rekening({ statement_type: "balans", report_group: "netto_omzet" })],
    });
    // Groep hoort niet bij het overzicht → niet geclassificeerd.
    expect(codes(items)).toContain("activiteit_zonder_classificatie");
  });

  it("27. classificatie wordt NOOIT afgeleid uit nummer of categorie", () => {
    // Een rekening met een "kosten"-nummer maar zonder expliciete velden blijft
    // ongeclassificeerd; een rekening met een willekeurig nummer maar mét
    // expliciete velden is gewoon geclassificeerd.
    const zonder = ledger({ postings: groep("pg-1"), accounts: [rekening({ nummer: 4602, statement_type: null, report_group: null })] });
    expect(codes(zonder)).toContain("activiteit_zonder_classificatie");
    const met = ledger({ postings: groep("pg-1"), accounts: [rekening({ nummer: 1, statement_type: "balans", report_group: "vaste_activa" })] });
    expect(codes(met)).not.toContain("activiteit_zonder_classificatie");
  });

  it("28. een rekening zónder activiteit wordt niet gemeld", () => {
    const items = ledger({ postings: [], accounts: [rekening({ statement_type: null, report_group: null })] });
    expect(items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ernstladder en samenvatting", () => {
  it("29. de ernst van een blokkade hangt af van de status, behalve bij config en boekjaar", () => {
    const doc: CatchupBlock = { code: "regels_sluiten_niet_aan", label: "x" };
    expect(severityForBlock(doc, true)).toBe("error");
    expect(severityForBlock(doc, false)).toBe("warning");
    expect(severityForBlock({ code: "geen_crediteurenrekening", label: "x", configuratie: true }, true)).toBe("warning");
    expect(severityForBlock({ code: "boekjaar_afgesloten", label: "x" }, false)).toBe("error");
    expect(severityForBlock({ code: "status_niet_postbaar", label: "x" }, false)).toBe("warning");
  });

  it("30. het overzicht telt exact dezelfde items als het detailtabblad", () => {
    const records = [
      pi(inkoop({ id: "a" }), volledigeConfig, aggregateInvoiceLines([])),
      pi(inkoop({ id: "b" })),
      pi(inkoop({ id: "c" }), volledigeConfig, regels(), "pg-1"),
    ];
    const items = records.flatMap((r) =>
      diagnosticsForDocument(r, {
        existingPostingGroups: new Set(["pg-1"]), balancedPostingGroups: new Set(["pg-1"]),
      }),
    );
    const summary = summarizeDiagnostics(items, records);

    expect(summary.total).toBe(3);
    expect(summary.posted).toBe(1);
    expect(summary.ready).toBe(1);
    expect(summary.blocked).toBe(1);
    // De tellingen komen uit de items, niet uit een tweede berekening.
    expect(summary.errors).toBe(items.filter((i) => i.severity === "error").length);
    expect(summary.warnings).toBe(items.filter((i) => i.severity === "warning").length);
    expect(summary.byCode.geen_boekingsregels).toBe(1);
    expect(summary.byCode.klaar_niet_geboekt).toBe(1);
    expect(summary.byCode.geboekt_en_sluitend).toBe(1);
  });

  it("31. de grootboeksamenvatting telt groepen en bevindingen uit dezelfde bron", () => {
    const postings = [
      ...[["pg-ok", "100.00"], ["pg-scheef", "90.00"]].flatMap(([id, credit]) => {
        const base = {
          client_id: CLIENT, posting_group_id: id, posting_date: "2026-04-01",
          boekjaar: 2026, currency: "EUR", source_type: "manual_journal",
        };
        return [
          { ...base, id: `${id}-1`, line_no: 1, grootboekrekening_id: "gb-1", debit_amount: "100.00", credit_amount: "0.00" },
          { ...base, id: `${id}-2`, line_no: 2, grootboekrekening_id: "gb-1", debit_amount: "0.00", credit_amount: credit },
        ];
      }),
    ];
    const integrity = evaluateLedgerIntegrity({
      purchaseInvoices: [], purchaseLines: [],
      markers: [{ soort: "inkoop", posting_group_id: "pg-weg" }], postings,
    });
    const items = diagnosticsForLedger({
      integrityFindings: integrity.findings, postings, clientId: CLIENT,
      accounts: [{ id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten", client_id: null, statement_type: null, report_group: null }],
      markerClaimsPerGroup: new Map(),
    });
    const summary = summarizeLedger(items, postingGroupBalances(postings));

    expect(summary.postingGroups).toBe(2);
    expect(summary.balancedGroups).toBe(1);
    expect(summary.unbalancedGroups).toBe(1);
    expect(summary.orphanMarkers).toBe(1);
    expect(summary.accountsMissingClassification).toBe(1);
    expect(summary.errors).toBe(items.filter((i) => i.severity === "error").length);
  });
});
