import { describe, expect, it } from "vitest";
import {
  CATCHUP_PURCHASE_POSTABLE_STATUSES,
  CATCHUP_SALES_POSTABLE_STATUSES,
  catchupRunOrder,
  evaluatePurchaseInvoice,
  evaluateSalesInvoice,
  postableRecords,
  summarize,
  type CatchupClientConfig,
  type CatchupPurchaseInvoice,
  type CatchupSalesInvoice,
} from "@/lib/ledger-catchup";

/**
 * Historische grootboekvulling — de beoordeling per bronrecord.
 *
 * Elke test hieronder spiegelt één guard uit de bestaande writers
 * (migraties 20260915140000 en 20260915160000). De writer blijft de
 * autoriteit; deze laag mag alleen nooit "klaar" zeggen waar de writer
 * voorspelbaar weigert, en nooit "geblokkeerd" waar hij zou boeken.
 */

const CLIENT = "client-1";

const VOLLEDIGE_CONFIG: CatchupClientConfig = {
  id: CLIENT,
  afgesloten_boekjaar: null,
  crediteuren_rekening_id: "cred-1",
  debiteuren_rekening_id: "deb-1",
  btw_te_vorderen_rekening_id: "btw-v-1",
  btw_te_betalen_rekening_id: "btw-b-1",
};

const INKOOP: CatchupPurchaseInvoice = {
  id: "pi-1",
  client_id: CLIENT,
  status: "gecontroleerd",
  invoice_date: "2026-03-01",
  invoice_number: "F-100",
  supplier: "Leverancier BV",
  amount_excl: 100,
  amount_incl: 121,
  btw_amount: 21,
};

/** Eén regel die exact op het bedrag exclusief BTW aansluit, mét rekening. */
const GOEDE_REGELS = { count: 1, sumExcl: 100, withoutAccount: 0 };

const VERKOOP: CatchupSalesInvoice = {
  id: "si-1",
  client_id: CLIENT,
  status: "gecontroleerd",
  invoice_date: "2026-03-01",
  invoice_number: "V-100",
  customer_name: "Klant BV",
  amount_excl: 200,
  amount_incl: 242,
  btw_amount: 42,
  btw_verlegd: false,
  grootboekrekening_id: "omzet-1",
};

const inkoop = (over: Partial<CatchupPurchaseInvoice> = {}) => ({ ...INKOOP, ...over });
const verkoop = (over: Partial<CatchupSalesInvoice> = {}) => ({ ...VERKOOP, ...over });
const config = (over: Partial<CatchupClientConfig> = {}) => ({ ...VOLLEDIGE_CONFIG, ...over });

const evalInkoop = (
  invoice = INKOOP,
  cfg = VOLLEDIGE_CONFIG,
  lines = GOEDE_REGELS,
  postingGroupId: string | null = null,
) => evaluatePurchaseInvoice({ invoice, config: cfg, lines, postingGroupId });

const evalVerkoop = (invoice = VERKOOP, cfg = VOLLEDIGE_CONFIG, postingGroupId: string | null = null) =>
  evaluateSalesInvoice({ invoice, config: cfg, postingGroupId });

const codes = (r: { blocks: readonly { code: string }[] }) => r.blocks.map((b) => b.code);

// ─────────────────────────────────────────────────────────────────────────────
describe("inkoop — de statussen van de writer, letterlijk", () => {
  it("1. de postbare statussen zijn exact die van post_purchase_invoice()", () => {
    expect([...CATCHUP_PURCHASE_POSTABLE_STATUSES]).toEqual(["gecontroleerd", "betaald", "geexporteerd"]);
  });

  it("2. 'te_controleren' is geblokkeerd, met de status letterlijk in de reden", () => {
    const r = evalInkoop(inkoop({ status: "te_controleren" }));
    expect(r.state).toBe("geblokkeerd");
    expect(codes(r)).toContain("status_niet_postbaar");
    expect(r.blocks[0].label).toContain("te_controleren");
    // En de status van het document zelf blijft ongewijzigd doorgegeven.
    expect(r.documentStatus).toBe("te_controleren");
  });

  it("3. een gecontroleerde, complete factuur is klaar", () => {
    const r = evalInkoop();
    expect(r.state).toBe("klaar");
    expect(r.blocks).toEqual([]);
  });

  it("4. elke postbare status is klaar; 'concept' niet", () => {
    for (const status of CATCHUP_PURCHASE_POSTABLE_STATUSES) {
      expect(evalInkoop(inkoop({ status })).state, status).toBe("klaar");
    }
    expect(evalInkoop(inkoop({ status: "concept" })).state).toBe("geblokkeerd");
  });
});

describe("inkoop — configuratie en documentgebreken", () => {
  it("5. een geboekte factuur is geboekt, ook als hij verder gebreken heeft", () => {
    // De marker is de autoriteit over "is dit al gebeurd". Een geboekte
    // factuur mag nooit opnieuw als boekbaar gelden — dat is de kern van de
    // idempotentie.
    const r = evalInkoop(inkoop({ status: "te_controleren", amount_incl: null }), VOLLEDIGE_CONFIG, GOEDE_REGELS, "pg-1");
    expect(r.state).toBe("geboekt");
    expect(r.blocks).toEqual([]);
    expect(r.postingGroupId).toBe("pg-1");
    expect(postableRecords([r])).toEqual([]);
  });

  it("6. ontbrekende BTW-rekening blokkeert zodra er BTW is", () => {
    const zonder = config({ btw_te_vorderen_rekening_id: null });
    const metBtw = evalInkoop(INKOOP, zonder);
    expect(metBtw.state).toBe("geblokkeerd");
    expect(codes(metBtw)).toContain("geen_btw_rekening");
    expect(metBtw.blocks.find((b) => b.code === "geen_btw_rekening")?.configuratie).toBe(true);

    // Zonder BTW vraagt de writer die rekening niet, dus dan is er niets aan de hand.
    const zonderBtw = evaluatePurchaseInvoice({
      invoice: inkoop({ amount_excl: 100, amount_incl: 100, btw_amount: 0 }),
      config: zonder,
      lines: GOEDE_REGELS,
      postingGroupId: null,
    });
    expect(zonderBtw.state).toBe("klaar");
  });

  it("7. ontbrekende crediteurenrekening blokkeert altijd", () => {
    const r = evalInkoop(INKOOP, config({ crediteuren_rekening_id: null }));
    expect(codes(r)).toContain("geen_crediteurenrekening");
    expect(r.blocks.find((b) => b.code === "geen_crediteurenrekening")?.configuratie).toBe(true);
  });

  it("8. een regel zonder grootboekrekening blokkeert (geen kostenrekening geraden)", () => {
    const r = evalInkoop(INKOOP, VOLLEDIGE_CONFIG, { count: 2, sumExcl: 100, withoutAccount: 1 });
    expect(r.state).toBe("geblokkeerd");
    expect(codes(r)).toContain("regel_zonder_rekening");
  });

  it("9. helemaal geen boekingsregels blokkeert", () => {
    const r = evalInkoop(INKOOP, VOLLEDIGE_CONFIG, { count: 0, sumExcl: 0, withoutAccount: 0 });
    expect(codes(r)).toContain("geen_boekingsregels");
    // Bij nul regels is "sluiten niet aan" geen zinvolle tweede klacht.
    expect(codes(r)).not.toContain("regels_sluiten_niet_aan");
  });

  it("10. regels die niet op het factuurbedrag aansluiten blokkeren", () => {
    const r = evalInkoop(INKOOP, VOLLEDIGE_CONFIG, { count: 1, sumExcl: 99, withoutAccount: 0 });
    expect(codes(r)).toContain("regels_sluiten_niet_aan");
  });

  it("11. excl + BTW moet op incl aansluiten, zonder tolerantie", () => {
    const r = evalInkoop(inkoop({ amount_excl: 100, btw_amount: 21, amount_incl: 120 }));
    expect(codes(r)).toContain("bedragen_sluiten_niet_aan");
    // Maar wél in centen, anders zou 0,1 + 0,2 een geldige factuur afkeuren
    // terwijl de writer (NUMERIC) hem gewoon accepteert.
    const fijn = evaluatePurchaseInvoice({
      invoice: inkoop({ amount_excl: 0.1, btw_amount: 0.2, amount_incl: 0.3 }),
      config: VOLLEDIGE_CONFIG,
      lines: { count: 1, sumExcl: 0.1, withoutAccount: 0 },
      postingGroupId: null,
    });
    expect(codes(fijn)).not.toContain("bedragen_sluiten_niet_aan");
  });

  it("12. ontbrekende bedragen en niet-positieve bedragen blokkeren", () => {
    expect(codes(evalInkoop(inkoop({ amount_incl: null })))).toContain("bedragen_ontbreken");
    const nul = evalInkoop(inkoop({ amount_excl: 0, btw_amount: 0, amount_incl: 0 }), VOLLEDIGE_CONFIG, {
      count: 1, sumExcl: 0, withoutAccount: 0,
    });
    expect(codes(nul)).toContain("bedrag_niet_positief");
  });

  it("13. een afgesloten boekjaar wordt nooit omzeild", () => {
    const r = evalInkoop(inkoop({ invoice_date: "2025-06-01" }), config({ afgesloten_boekjaar: 2025 }));
    expect(r.state).toBe("geblokkeerd");
    expect(codes(r)).toContain("boekjaar_afgesloten");
    expect(r.blocks.find((b) => b.code === "boekjaar_afgesloten")?.label).toContain("2025");
    // Het jaar ná het afgesloten jaar mag wel.
    expect(evalInkoop(inkoop({ invoice_date: "2026-06-01" }), config({ afgesloten_boekjaar: 2025 })).state).toBe("klaar");
  });

  it("14. zonder factuurdatum kan er geen boekingsdatum zijn", () => {
    const r = evalInkoop(inkoop({ invoice_date: null }));
    expect(codes(r)).toContain("geen_factuurdatum");
    // De echte brondatum wordt doorgegeven, nooit vervangen door vandaag.
    expect(r.date).toBeNull();
    expect(evalInkoop().date).toBe("2026-03-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("verkoop — dezelfde regels, de verkoopvariant", () => {
  it("15. de postbare statussen zijn exact die van post_sales_invoice()", () => {
    expect([...CATCHUP_SALES_POSTABLE_STATUSES]).toEqual(["gecontroleerd", "betaald"]);
    // 'geexporteerd' is wél postbaar bij inkoop, niet bij verkoop.
    expect(evalVerkoop(verkoop({ status: "geexporteerd" })).state).toBe("geblokkeerd");
  });

  it("16. een concept-verkoopfactuur is geblokkeerd, een gecontroleerde is klaar", () => {
    expect(evalVerkoop(verkoop({ status: "concept" })).state).toBe("geblokkeerd");
    expect(evalVerkoop().state).toBe("klaar");
  });

  it("17. verlegde BTW wordt geweigerd, niet stil als factuur zonder BTW geboekt", () => {
    const r = evalVerkoop(verkoop({ btw_verlegd: true }));
    expect(r.state).toBe("geblokkeerd");
    expect(codes(r)).toContain("btw_verlegd");
  });

  it("18. ontbrekende omzetrekening op de factuur blokkeert", () => {
    const r = evalVerkoop(verkoop({ grootboekrekening_id: null }));
    expect(codes(r)).toContain("geen_omzetrekening");
  });

  it("19. ontbrekende debiteuren- of BTW-te-betalen-rekening blokkeert", () => {
    expect(codes(evalVerkoop(VERKOOP, config({ debiteuren_rekening_id: null })))).toContain("geen_debiteurenrekening");
    expect(codes(evalVerkoop(VERKOOP, config({ btw_te_betalen_rekening_id: null })))).toContain("geen_btw_rekening");
    // Zonder BTW is die rekening niet nodig.
    const zonderBtw = evaluateSalesInvoice({
      invoice: verkoop({ amount_excl: 200, btw_amount: 0, amount_incl: 200 }),
      config: config({ btw_te_betalen_rekening_id: null }),
      postingGroupId: null,
    });
    expect(zonderBtw.state).toBe("klaar");
  });

  it("20. een geboekte verkoopfactuur is geboekt en wordt niet opnieuw aangeboden", () => {
    const r = evalVerkoop(VERKOOP, VOLLEDIGE_CONFIG, "pg-9");
    expect(r.state).toBe("geboekt");
    expect(r.postingGroupId).toBe("pg-9");
    expect(postableRecords([r])).toEqual([]);
  });

  it("21. een afgesloten boekjaar blokkeert ook de verkoop", () => {
    expect(codes(evalVerkoop(verkoop({ invoice_date: "2024-02-01" }), config({ afgesloten_boekjaar: 2024 }))))
      .toContain("boekjaar_afgesloten");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("samenvatting, selectie en volgorde", () => {
  const geboekt = evalInkoop(INKOOP, VOLLEDIGE_CONFIG, GOEDE_REGELS, "pg-1");
  const klaar = evalInkoop(inkoop({ id: "pi-2" }));
  const geblokkeerd = evalInkoop(inkoop({ id: "pi-3", status: "te_controleren" }));

  it("22. de telling is per toestand en telt alles precies één keer", () => {
    const s = summarize([geboekt, klaar, geblokkeerd]);
    expect(s).toEqual({ totaal: 3, geboekt: 1, klaar: 1, geblokkeerd: 1 });
  });

  it("23. alleen 'klaar' wordt aan de writer aangeboden", () => {
    expect(postableRecords([geboekt, klaar, geblokkeerd]).map((r) => r.id)).toEqual(["pi-2"]);
  });

  it("24. inkoop gaat vóór verkoop, daarbinnen op brondatum", () => {
    const a = evalInkoop(inkoop({ id: "pi-laat", invoice_date: "2026-09-01" }));
    const b = evalInkoop(inkoop({ id: "pi-vroeg", invoice_date: "2026-01-01" }));
    const c = evalVerkoop(verkoop({ id: "si-vroeg", invoice_date: "2026-01-01" }));
    expect(catchupRunOrder([c, a, b]).map((r) => r.id)).toEqual(["pi-vroeg", "pi-laat", "si-vroeg"]);
  });

  it("25. de evaluatie raadt nooit een rekeningNUMMER", () => {
    // Geen enkele blokkade-reden mag een vast rekeningnummer noemen; de
    // configuratie is altijd een expliciete account-id.
    const alle = [
      evalInkoop(inkoop({ status: "te_controleren" })),
      evalInkoop(INKOOP, config({ crediteuren_rekening_id: null, btw_te_vorderen_rekening_id: null })),
      evalVerkoop(verkoop({ grootboekrekening_id: null }), config({ debiteuren_rekening_id: null })),
    ];
    for (const r of alle) {
      for (const b of r.blocks) {
        expect(b.label, b.code).not.toMatch(/\b(1100|1300|1520|1600|1799)\b/);
      }
    }
  });
});
