import { describe, expect, it } from "vitest";
import {
  buildLedgerMutations,
  filterLedgerMutations,
  getLedgerYearRange,
  collectLedgerYears,
  PURCHASE_LEDGER_STATUSES,
  SALES_LEDGER_STATUSES,
  type PurchaseInvoiceLike,
  type SalesInvoiceLike,
  type JournalEntryLike,
  type BankTransactionLike,
  type LedgerAccountLike,
} from "@/lib/ledger-mutations";

const accounts: LedgerAccountLike[] = [
  { id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten" },
  { id: "gb-1605", nummer: 1605, omschrijving: "Vraagposten inkopen" },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog" },
];

const purchase = (over: Partial<PurchaseInvoiceLike> = {}): PurchaseInvoiceLike => ({
  id: "pi-1",
  client_id: "c1",
  status: "gecontroleerd",
  invoice_date: "2026-03-10",
  supplier: "Acme B.V.",
  invoice_number: "F-2026-001",
  amount_incl: 121,
  amount_excl: 100,
  btw_amount: 21,
  grootboekrekening_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  ...over,
});

const sales = (over: Partial<SalesInvoiceLike> = {}): SalesInvoiceLike => ({
  id: "si-1",
  client_id: "c1",
  status: "gecontroleerd",
  invoice_date: "2026-04-01",
  customer_name: "Klant X",
  invoice_number: "V-2026-001",
  amount_incl: 1210,
  amount_excl: 1000,
  btw_amount: 210,
  ledger_account_text: "8000 - Omzet hoog",
  ...over,
});

const journal = (over: Partial<JournalEntryLike> = {}): JournalEntryLike => ({
  id: "je-1",
  client_id: "c1",
  entry_date: "2026-05-05",
  amount: 121,
  btw_amount: 21,
  description: "Handmatige boeking",
  invoice_number: "J-001",
  grootboekrekening_id: "gb-4400",
  ledger_account_text: "4400 - Kantoorkosten",
  ...over,
});

const bank = (over: Partial<BankTransactionLike> = {}): BankTransactionLike => ({
  id: "bt-1",
  client_id: "c1",
  transaction_date: "2026-06-06",
  amount: -75,
  match_status: "handmatig_geboekt",
  description: "Betaling kantoorartikelen",
  reference: null,
  counter_account: null,
  camt_counterparty_name: null,
  grootboekrekening_id: "gb-4400",
  ...over,
});

const bySource = (input: Parameters<typeof buildLedgerMutations>[0], source: string) =>
  buildLedgerMutations(input).mutations.filter((m) => m.source === source);

// ── Inkoop (1–6) ─────────────────────────────────────────────────────────────
describe("Inkoop", () => {
  it("1. gecontroleerd telt mee", () => {
    const { mutations } = buildLedgerMutations({ purchaseInvoices: [purchase({ status: "gecontroleerd" })] });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("purchase");
    expect(mutations[0].sourceId).toBe("pi-1");
  });

  it("2. betaald telt mee", () => {
    expect(bySource({ purchaseInvoices: [purchase({ status: "betaald" })] }, "purchase")).toHaveLength(1);
  });

  it("3. geexporteerd telt mee", () => {
    expect(bySource({ purchaseInvoices: [purchase({ status: "geexporteerd" })] }, "purchase")).toHaveLength(1);
  });

  it("4. te_controleren telt NIET mee", () => {
    expect(bySource({ purchaseInvoices: [purchase({ status: "te_controleren" })] }, "purchase")).toHaveLength(0);
  });

  it("5. gebruikt invoice_date als boekdatum", () => {
    const [m] = bySource({ purchaseInvoices: [purchase({ invoice_date: "2026-02-28" })] }, "purchase");
    expect(m.date).toBe("2026-02-28");
  });

  it("5b. factuur zonder invoice_date telt niet mee", () => {
    expect(bySource({ purchaseInvoices: [purchase({ invoice_date: null })] }, "purchase")).toHaveLength(0);
  });

  it("6. valt terug op ledger_account_text wanneer er geen FK is", () => {
    const [m] = bySource({ purchaseInvoices: [purchase({ grootboekrekening_id: null })], accounts }, "purchase");
    expect(m.ledgerAccountId).toBeNull();
    expect(m.ledgerAccountLabel).toBe("4400 - Kantoorkosten");
  });

  it("6b. gebruikt de opgeloste rekening wanneer er wél een FK is", () => {
    const [m] = bySource(
      { purchaseInvoices: [purchase({ grootboekrekening_id: "gb-4400", ledger_account_text: "oude tekst" })], accounts },
      "purchase",
    );
    expect(m.ledgerAccountId).toBe("gb-4400");
    expect(m.ledgerAccountLabel).toBe("4400 - Kantoorkosten");
  });

  it("6c. bedrag is incl. BTW, met excl. als fallback; richting is out", () => {
    const [m] = bySource({ purchaseInvoices: [purchase()] }, "purchase");
    expect(m.amount).toBe(121);
    expect(m.vatAmount).toBe(21);
    expect(m.direction).toBe("out");
    const [fallback] = bySource({ purchaseInvoices: [purchase({ amount_incl: null })] }, "purchase");
    expect(fallback.amount).toBe(100);
  });

  it("6d. leverancier is de omschrijving, factuurnummer de referentie", () => {
    const [m] = bySource({ purchaseInvoices: [purchase()] }, "purchase");
    expect(m.description).toBe("Acme B.V.");
    expect(m.reference).toBe("F-2026-001");
  });
});

// ── Verkoop (7–12) ───────────────────────────────────────────────────────────
describe("Verkoop", () => {
  it("7. gecontroleerd telt mee", () => {
    expect(bySource({ salesInvoices: [sales({ status: "gecontroleerd" })] }, "sales")).toHaveLength(1);
  });

  it("8. betaald telt mee", () => {
    expect(bySource({ salesInvoices: [sales({ status: "betaald" })] }, "sales")).toHaveLength(1);
  });

  it("9. geexporteerd telt mee", () => {
    expect(bySource({ salesInvoices: [sales({ status: "geexporteerd" })] }, "sales")).toHaveLength(1);
  });

  it("10. concept telt NIET mee", () => {
    expect(bySource({ salesInvoices: [sales({ status: "concept" })] }, "sales")).toHaveLength(0);
  });

  it("11. verzonden telt NIET mee", () => {
    expect(bySource({ salesInvoices: [sales({ status: "verzonden" })] }, "sales")).toHaveLength(0);
  });

  it("12. ledgerAccountId blijft altijd null (geen FK-kolom in het schema)", () => {
    const [m] = bySource({ salesInvoices: [sales()], accounts }, "sales");
    expect(m.ledgerAccountId).toBeNull();
    // Vrije tekst wordt getoond, maar nooit teruggematcht op een rekeningnummer.
    expect(m.ledgerAccountLabel).toBe("8000 - Omzet hoog");
  });

  it("12b. zonder vrije tekst blijft het label leeg — geen fuzzy match", () => {
    const [m] = bySource({ salesInvoices: [sales({ ledger_account_text: null })], accounts }, "sales");
    expect(m.ledgerAccountId).toBeNull();
    expect(m.ledgerAccountLabel).toBeNull();
  });

  it("12c. gebruikt invoice_date, klantnaam en factuurnummer; richting is in", () => {
    const [m] = bySource({ salesInvoices: [sales()] }, "sales");
    expect(m.date).toBe("2026-04-01");
    expect(m.description).toBe("Klant X");
    expect(m.reference).toBe("V-2026-001");
    expect(m.amount).toBe(1210);
    expect(m.direction).toBe("in");
  });
});

// ── Handmatig (13–16) ────────────────────────────────────────────────────────
describe("Handmatige boekingen", () => {
  it("13. telt altijd mee", () => {
    expect(bySource({ journalEntries: [journal()] }, "journal")).toHaveLength(1);
  });

  it("14. gebruikt entry_date als boekdatum", () => {
    const [m] = bySource({ journalEntries: [journal({ entry_date: "2026-01-02" })] }, "journal");
    expect(m.date).toBe("2026-01-02");
  });

  it("15. behoudt de grootboekrekening_id en lost het label op", () => {
    const [m] = bySource({ journalEntries: [journal()], accounts }, "journal");
    expect(m.ledgerAccountId).toBe("gb-4400");
    expect(m.ledgerAccountLabel).toBe("4400 - Kantoorkosten");
  });

  it("15b. valt terug op ledger_account_text zonder FK", () => {
    const [m] = bySource(
      { journalEntries: [journal({ grootboekrekening_id: null, ledger_account_text: "7000 - Inkopen" })], accounts },
      "journal",
    );
    expect(m.ledgerAccountId).toBeNull();
    expect(m.ledgerAccountLabel).toBe("7000 - Inkopen");
  });

  it("16. behoudt het BTW-bedrag en voegt geen richting toe", () => {
    const [m] = bySource({ journalEntries: [journal({ btw_amount: 21 })] }, "journal");
    expect(m.vatAmount).toBe(21);
    expect(m.amount).toBe(121);
    expect(m.direction).toBe("neutral");
  });
});

// ── Bank (17–24) ─────────────────────────────────────────────────────────────
describe("Bank", () => {
  it("17. handmatig_geboekt + rekening + geen allocaties telt mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({ bankTransactions: [bank()], accounts });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("bank");
    expect(excludedBank.total).toBe(0);
  });

  it("18. handmatig_geboekt MET allocatie telt NIET mee (settlement)", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank()],
      allocations: [{ bank_transaction_id: "bt-1" }],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.settled).toBe(1);
  });

  it("19. handmatig_geboekt zonder rekening telt NIET mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank({ grootboekrekening_id: null })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.invalidManual).toBe(1);
  });

  it("19b. handmatig_geboekt met stale (onbekende) rekening telt NIET mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank({ grootboekrekening_id: "gb-bestaat-niet" })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.invalidManual).toBe(1);
  });

  it("20. gematcht telt NIET mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank({ match_status: "gematcht" })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.settled).toBe(1);
  });

  it("20b. gematcht telt ook niet mee mét een eigen rekening", () => {
    const { mutations } = buildLedgerMutations({
      bankTransactions: [bank({ match_status: "gematcht", grootboekrekening_id: "gb-4400" })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
  });

  it("21. suggestie telt NIET mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank({ match_status: "suggestie" })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.suggested).toBe(1);
  });

  it("22. niet_gematcht telt NIET mee", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      bankTransactions: [bank({ match_status: "niet_gematcht" })],
      accounts,
    });
    expect(mutations).toHaveLength(0);
    expect(excludedBank.unmatched).toBe(1);
  });

  it("23. het ondertekende bedrag blijft behouden (in én uit)", () => {
    const { mutations } = buildLedgerMutations({
      bankTransactions: [
        bank({ id: "bt-out", amount: -75 }),
        bank({ id: "bt-in", amount: 250 }),
      ],
      accounts,
    });
    const out = mutations.find((m) => m.sourceId === "bt-out")!;
    const inn = mutations.find((m) => m.sourceId === "bt-in")!;
    expect(out.amount).toBe(-75);
    expect(out.direction).toBe("out");
    expect(inn.amount).toBe(250);
    expect(inn.direction).toBe("in");
  });

  it("24. gebruikt transaction_date als boekdatum", () => {
    const { mutations } = buildLedgerMutations({
      bankTransactions: [bank({ transaction_date: "2026-09-09" })],
      accounts,
    });
    expect(mutations[0].date).toBe("2026-09-09");
  });

  it("24b. exclusieredenen worden per categorie geteld", () => {
    const { excludedBank } = buildLedgerMutations({
      bankTransactions: [
        bank({ id: "a", match_status: "niet_gematcht" }),
        bank({ id: "b", match_status: "suggestie" }),
        bank({ id: "c", match_status: "gematcht" }),
        bank({ id: "d", grootboekrekening_id: null }),
        bank({ id: "e" }), // telt wel mee
      ],
      accounts,
    });
    expect(excludedBank).toEqual({ total: 4, unmatched: 1, suggested: 1, settled: 1, invalidManual: 1 });
  });

  it("24c. zonder rekeningenlijst volstaat een niet-lege grootboekrekening_id", () => {
    const { mutations } = buildLedgerMutations({ bankTransactions: [bank({ grootboekrekening_id: "gb-onbekend" })] });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].ledgerAccountId).toBe("gb-onbekend");
    expect(mutations[0].ledgerAccountLabel).toBeNull();
  });
});

// ── Allocaties (25) ──────────────────────────────────────────────────────────
describe("Allocaties", () => {
  it("25. een allocatierij produceert nooit een zelfstandige mutatie", () => {
    const { mutations } = buildLedgerMutations({
      allocations: [{ bank_transaction_id: "bt-1" }, { bank_transaction_id: "bt-2" }],
    });
    expect(mutations).toHaveLength(0);
  });

  it("25b. allocaties zonder bijbehorende banktransactie veranderen niets", () => {
    const { mutations } = buildLedgerMutations({
      purchaseInvoices: [purchase()],
      allocations: [{ bank_transaction_id: "onbekend" }],
      accounts,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("purchase");
  });
});

// ── Dubbeltelling (26–30) ────────────────────────────────────────────────────
describe("Dubbeltellingsbescherming", () => {
  it("26. inkoopfactuur €121 + afgeletterde bankbetaling → alleen de factuur", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      purchaseInvoices: [purchase({ amount_incl: 121 })],
      bankTransactions: [bank({ id: "bt-pay", amount: -121, match_status: "gematcht" })],
      allocations: [{ bank_transaction_id: "bt-pay" }],
      accounts,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("purchase");
    expect(mutations[0].amount).toBe(121);
    expect(excludedBank.settled).toBe(1);
  });

  it("27. verkoopfactuur €1.210 + afgeletterde ontvangst → alleen de factuur", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      salesInvoices: [sales({ amount_incl: 1210 })],
      bankTransactions: [bank({ id: "bt-rcv", amount: 1210, match_status: "gematcht" })],
      allocations: [{ bank_transaction_id: "bt-rcv" }],
      accounts,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("sales");
    expect(mutations[0].amount).toBe(1210);
    expect(excludedBank.settled).toBe(1);
  });

  it("28. deelbetaling → factuur één keer volledig, bank niet", () => {
    const { mutations, excludedBank } = buildLedgerMutations({
      purchaseInvoices: [purchase({ amount_incl: 121 })],
      bankTransactions: [bank({ id: "bt-partial", amount: -50, match_status: "gematcht" })],
      allocations: [{ bank_transaction_id: "bt-partial" }],
      accounts,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("purchase");
    // De factuur telt voor het volle bedrag; de deelbetaling telt niet apart mee.
    expect(mutations[0].amount).toBe(121);
    expect(excludedBank.settled).toBe(1);
  });

  it("29. handmatige bankuitgave zonder factuur → alleen de bankmutatie", () => {
    const { mutations } = buildLedgerMutations({
      bankTransactions: [bank({ amount: -60, match_status: "handmatig_geboekt" })],
      accounts,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("bank");
    expect(mutations[0].amount).toBe(-60);
  });

  it("30. handmatige journaalboeking → alleen de journaalmutatie", () => {
    const { mutations } = buildLedgerMutations({ journalEntries: [journal()], accounts });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].source).toBe("journal");
  });

  it("30b. alle vier de bronnen samen leveren precies vier mutaties", () => {
    const { mutations } = buildLedgerMutations({
      purchaseInvoices: [purchase()],
      salesInvoices: [sales()],
      journalEntries: [journal()],
      bankTransactions: [bank()],
      accounts,
    });
    expect(mutations).toHaveLength(4);
    expect(new Set(mutations.map((m) => m.source))).toEqual(new Set(["purchase", "sales", "journal", "bank"]));
    // Ids zijn uniek over bronnen heen.
    expect(new Set(mutations.map((m) => m.id)).size).toBe(4);
  });

  it("30c. sorteert op datum aflopend", () => {
    const { mutations } = buildLedgerMutations({
      purchaseInvoices: [purchase({ invoice_date: "2026-03-10" })],
      salesInvoices: [sales({ invoice_date: "2026-04-01" })],
      journalEntries: [journal({ entry_date: "2026-05-05" })],
      bankTransactions: [bank({ transaction_date: "2026-06-06" })],
      accounts,
    });
    expect(mutations.map((m) => m.date)).toEqual(["2026-06-06", "2026-05-05", "2026-04-01", "2026-03-10"]);
  });

  it("30d. lege input levert een lege lijst zonder te crashen", () => {
    expect(buildLedgerMutations({})).toEqual({
      mutations: [],
      excludedBank: { total: 0, unmatched: 0, suggested: 0, settled: 0, invalidManual: 0 },
    });
  });
});

// ── Filters ──────────────────────────────────────────────────────────────────
describe("Filters", () => {
  const all = buildLedgerMutations({
    purchaseInvoices: [purchase({ invoice_date: "2025-03-10" })],
    salesInvoices: [sales({ invoice_date: "2026-04-01" })],
    journalEntries: [journal({ entry_date: "2026-05-05" })],
    bankTransactions: [bank({ transaction_date: "2026-06-06" })],
    accounts,
  }).mutations;

  it("halfopen jaarrange volgt getYearDateRange-semantiek", () => {
    expect(getLedgerYearRange(2026)).toEqual({ from: "2026-01-01", to: "2027-01-01" });
    expect(getLedgerYearRange("all")).toBeNull();
    expect(getLedgerYearRange(undefined)).toBeNull();
  });

  it("filtert op jaar met halfopen grenzen", () => {
    expect(filterLedgerMutations(all, { year: 2025 }).map((m) => m.source)).toEqual(["purchase"]);
    expect(filterLedgerMutations(all, { year: 2026 })).toHaveLength(3);
    expect(filterLedgerMutations(all, { year: "all" })).toHaveLength(4);
  });

  it("31-12 valt binnen het jaar, 01-01 van het volgende jaar niet", () => {
    const edge = buildLedgerMutations({
      journalEntries: [
        journal({ id: "je-eind", entry_date: "2026-12-31" }),
        journal({ id: "je-nieuw", entry_date: "2027-01-01" }),
      ],
    }).mutations;
    expect(filterLedgerMutations(edge, { year: 2026 }).map((m) => m.sourceId)).toEqual(["je-eind"]);
  });

  it("filtert op bron", () => {
    expect(filterLedgerMutations(all, { source: "bank" })).toHaveLength(1);
    expect(filterLedgerMutations(all, { source: "purchase" })).toHaveLength(1);
    expect(filterLedgerMutations(all, { source: "all" })).toHaveLength(4);
  });

  it("filtert op rekening en sluit rijen zonder FK uit (o.a. verkoop)", () => {
    const filtered = filterLedgerMutations(all, { ledgerAccountId: "gb-4400" });
    // Journal + bank hebben gb-4400; inkoop heeft hier geen FK, verkoop nooit.
    expect(filtered.map((m) => m.source).sort()).toEqual(["bank", "journal"]);
    expect(filtered.every((m) => m.ledgerAccountId === "gb-4400")).toBe(true);
  });

  it("zoekt over omschrijving, referentie en rekeninglabel", () => {
    expect(filterLedgerMutations(all, { search: "acme" }).map((m) => m.source)).toEqual(["purchase"]);
    expect(filterLedgerMutations(all, { search: "V-2026-001" }).map((m) => m.source)).toEqual(["sales"]);
    expect(filterLedgerMutations(all, { search: "kantoorkosten" }).length).toBeGreaterThan(0);
    expect(filterLedgerMutations(all, { search: "bestaat-niet" })).toHaveLength(0);
  });

  it("combineert filters met AND-semantiek", () => {
    expect(filterLedgerMutations(all, { year: 2026, source: "journal" })).toHaveLength(1);
    expect(filterLedgerMutations(all, { year: 2025, source: "journal" })).toHaveLength(0);
  });

  it("collectLedgerYears geeft aanwezige jaren, nieuwste eerst", () => {
    expect(collectLedgerYears(all)).toEqual([2026, 2025]);
    expect(collectLedgerYears([])).toEqual([]);
  });

  it("statusconstanten bevatten exact de bewezen statussen", () => {
    expect([...PURCHASE_LEDGER_STATUSES]).toEqual(["gecontroleerd", "betaald", "geexporteerd"]);
    expect([...SALES_LEDGER_STATUSES]).toEqual(["gecontroleerd", "betaald", "geexporteerd"]);
  });
});
