import { describe, expect, it } from "vitest";
import {
  applyCreditInput,
  applyDebitInput,
  buildHeaderPayload,
  buildSaveLinesPayload,
  classifyManualJournalError,
  createEmptyHeaderForm,
  createEmptyLineRow,
  createEmptyLineRows,
  firstBlockingReason,
  isManualJournalDirty,
  lineTotals,
  manualJournalListAmount,
  resolveAccountLabel,
  toLineRows,
  type ManualJournalHeaderForm,
  type ManualJournalLineRow,
} from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — pure logica van de memoriaalpagina.
 *
 * Deze tests bewaken twee dingen: dat de UI de invoer correct optelt en
 * blokkeert, en vooral dat de payload naar save_manual_journal_lines() niets
 * meestuurt wat de database zelf afleidt (organization_id, user_id) en
 * bedragen niet stilletjes afrondt.
 */

function row(over: Partial<ManualJournalLineRow> = {}): ManualJournalLineRow {
  return { ...createEmptyLineRow(), ...over };
}

const okHeader: ManualJournalHeaderForm = {
  client_id: "c-1",
  posting_date: "2027-03-31",
  description: "Afschrijving maart",
  reference: "MEM-2027-03",
};

const balanced = (): ManualJournalLineRow[] => [
  row({ grootboekrekening_id: "gb-1", grootboek_label: "4000 - Kosten", debit_input: "100,00" }),
  row({ grootboekrekening_id: "gb-2", grootboek_label: "1600 - Crediteuren", credit_input: "100,00" }),
];

const gate = (over: Partial<Parameters<typeof firstBlockingReason>[0]> = {}) =>
  firstBlockingReason({
    journalId: "mj-1",
    markerUnavailable: false,
    markerPending: false,
    canPost: true,
    isDirty: false,
    header: okHeader,
    lines: balanced(),
    ...over,
  });

describe("manual-journal-utils — totalen en balans", () => {
  it("1. telt debet en credit op en berekent het verschil", () => {
    const totals = lineTotals([
      row({ debit_input: "100,00" }),
      row({ debit_input: "21,00" }),
      row({ credit_input: "121,00" }),
    ]);
    expect(totals.debit).toBe(121);
    expect(totals.credit).toBe(121);
    expect(totals.difference).toBe(0);
    expect(totals.isBalanced).toBe(true);
  });

  it("2. ongebalanceerd → verschil en isBalanced false", () => {
    const totals = lineTotals([row({ debit_input: "100" }), row({ credit_input: "99,99" })]);
    expect(totals.difference).toBe(0.01);
    expect(totals.isBalanced).toBe(false);
  });

  it("3. 0 = 0 is geen boeking: 'In balans' verschijnt niet bij lege regels", () => {
    const totals = lineTotals(createEmptyLineRows(2));
    expect(totals.debit).toBe(0);
    expect(totals.credit).toBe(0);
    expect(totals.isBalanced).toBe(false);
  });

  it("4. accepteert zowel komma als punt (nl-NL invoerconventie van de app)", () => {
    expect(lineTotals([row({ debit_input: "1234,56" })]).debit).toBe(1234.56);
    expect(lineTotals([row({ debit_input: "1234.56" })]).debit).toBe(1234.56);
  });
});

describe("manual-journal-utils — zijde-exclusieve invoer", () => {
  it("5. een bedrag op debet wist credit", () => {
    const next = applyDebitInput(row({ credit_input: "50,00" }), "100,00");
    expect(next.debit_input).toBe("100,00");
    expect(next.credit_input).toBe("");
  });

  it("6. een bedrag op credit wist debet", () => {
    const next = applyCreditInput(row({ debit_input: "50,00" }), "100,00");
    expect(next.credit_input).toBe("100,00");
    expect(next.debit_input).toBe("");
  });

  it("7. wissen of 0 raakt de andere zijde niet (anders kun je een typefout niet herstellen)", () => {
    expect(applyDebitInput(row({ credit_input: "50,00" }), "").credit_input).toBe("50,00");
    expect(applyDebitInput(row({ credit_input: "50,00" }), "0").credit_input).toBe("50,00");
  });
});

describe("manual-journal-utils — payload", () => {
  it("8. bouwt de regels met sort_order op volgorde en trimt de omschrijving", () => {
    const payload = buildSaveLinesPayload([
      row({ grootboekrekening_id: "gb-1", omschrijving: "  Kosten  ", debit_input: "100,00" }),
      row({ grootboekrekening_id: "gb-2", omschrijving: "   ", credit_input: "100,00" }),
    ]);
    expect(payload).toEqual([
      { sort_order: 0, grootboekrekening_id: "gb-1", omschrijving: "Kosten", debit_amount: 100, credit_amount: 0 },
      { sort_order: 1, grootboekrekening_id: "gb-2", omschrijving: null, debit_amount: 0, credit_amount: 100 },
    ]);
  });

  it("9. lekt geen organization_id, user_id of client_id in de regelpayload", () => {
    const payload = buildSaveLinesPayload(balanced());
    for (const line of payload) {
      expect(Object.keys(line).sort()).toEqual([
        "credit_amount",
        "debit_amount",
        "grootboekrekening_id",
        "omschrijving",
        "sort_order",
      ]);
    }
  });

  it("10. rondt niet af: 0,005 gaat onafgerond mee zodat de RPC hem kan weigeren", () => {
    expect(buildSaveLinesPayload([row({ debit_input: "0,005" })])[0].debit_amount).toBe(0.005);
  });

  it("11. de koppayload bevat geen organization_id (trigger leidt hem af) en trimt tekst", () => {
    const payload = buildHeaderPayload({ ...okHeader, description: "  Tekst  ", reference: "   " });
    expect(payload).toEqual({
      client_id: "c-1",
      posting_date: "2027-03-31",
      description: "Tekst",
      reference: null,
    });
    expect(Object.keys(payload)).not.toContain("organization_id");
    expect(Object.keys(payload)).not.toContain("user_id");
  });
});

describe("manual-journal-utils — dirty-vergelijking", () => {
  it("12. zonder opgeslagen toestand is het formulier altijd dirty", () => {
    expect(isManualJournalDirty(okHeader, balanced(), null, null)).toBe(true);
  });

  it("13. identieke inhoud is niet dirty, ook met andere React-keys", () => {
    const a = balanced();
    const b = balanced();
    expect(isManualJournalDirty(okHeader, a, { ...okHeader }, b)).toBe(false);
  });

  it("14. een gewijzigd bedrag, regelvolgorde of kopveld is dirty", () => {
    const persisted = balanced();
    const changedAmount = balanced();
    changedAmount[0] = { ...changedAmount[0], debit_input: "101,00" };
    expect(isManualJournalDirty(okHeader, changedAmount, okHeader, persisted)).toBe(true);

    const reordered = [...balanced()].reverse();
    expect(isManualJournalDirty(okHeader, reordered, okHeader, persisted)).toBe(true);

    expect(
      isManualJournalDirty({ ...okHeader, description: "Anders" }, balanced(), okHeader, persisted),
    ).toBe(true);
  });

  it("15. verschillende schrijfwijze van hetzelfde bedrag is niet dirty", () => {
    const persisted = [row({ grootboekrekening_id: "gb-1", debit_input: "100,00" })];
    const typed = [row({ grootboekrekening_id: "gb-1", debit_input: "100" })];
    expect(isManualJournalDirty(okHeader, typed, okHeader, persisted)).toBe(false);
  });
});

describe("manual-journal-utils — firstBlockingReason", () => {
  it("16. volledig in orde → null", () => {
    expect(gate()).toBeNull();
  });

  it("17. deploy-venster en laden gaan vóór alle andere redenen", () => {
    expect(gate({ markerUnavailable: true, lines: [] })).toBe(
      "Boeken in het grootboek is nog niet beschikbaar voor memoriaalboekingen.",
    );
    expect(gate({ markerPending: true, lines: [] })).toBe("Boekingsstatus wordt geladen…");
  });

  it("18. nog niet opgeslagen / niet-opgeslagen wijzigingen blokkeren boeken", () => {
    expect(gate({ journalId: null })).toBe("Sla de memoriaalboeking eerst op.");
    expect(gate({ isDirty: true })).toBe("Er zijn niet-opgeslagen wijzigingen. Sla eerst op.");
  });

  it("19. rolcontrole: onbekend blokkeert, geen accountant blokkeert", () => {
    expect(gate({ canPost: undefined })).toBe("Rechten worden gecontroleerd…");
    expect(gate({ canPost: false })).toBe("Alleen een accountant kan een memoriaalboeking boeken.");
  });

  it("20. kopvelden: datum en omschrijving zijn verplicht om te boeken", () => {
    expect(gate({ header: { ...okHeader, posting_date: "" } })).toBe("Vul een boekingsdatum in.");
    expect(gate({ header: { ...okHeader, description: "   " } })).toBe("Vul een omschrijving in.");
  });

  it("21. minder dan twee regels", () => {
    expect(gate({ lines: [balanced()[0]] })).toBe("Een memoriaalboeking heeft minimaal twee regels.");
  });

  it("22. regel zonder rekening", () => {
    const lines = balanced();
    lines[1] = { ...lines[1], grootboekrekening_id: null };
    expect(gate({ lines })).toBe("Elke regel heeft een grootboekrekening nodig.");
  });

  it("23. regel zonder bedrag, beide zijden gevuld, negatief bedrag", () => {
    const empty = balanced();
    empty[1] = { ...empty[1], credit_input: "" };
    expect(gate({ lines: empty })).toBe("Elke regel heeft een bedrag nodig.");

    const both = balanced();
    both[0] = { ...both[0], credit_input: "100,00" };
    expect(gate({ lines: both })).toBe("Een regel kan niet tegelijk debet en credit zijn.");

    const negative = balanced();
    negative[0] = { ...negative[0], debit_input: "-100,00" };
    expect(gate({ lines: negative })).toBe(
      "Negatieve bedragen worden niet ondersteund; boek het bedrag op de andere zijde.",
    );
  });

  it("24. totaal 0 en niet in balans", () => {
    const zero = [
      row({ grootboekrekening_id: "gb-1", debit_input: "0,00", credit_input: "" }),
      row({ grootboekrekening_id: "gb-2", credit_input: "0,00" }),
    ];
    expect(gate({ lines: zero })).toBe("Elke regel heeft een bedrag nodig.");

    const unbalanced = balanced();
    unbalanced[1] = { ...unbalanced[1], credit_input: "99,00" };
    expect(gate({ lines: unbalanced })).toBe("Debet en credit zijn niet gelijk.");
  });
});

describe("manual-journal-utils — overige helpers", () => {
  it("25. lijstbedrag: geboekt = claimtabel, concept = de ingevulde zijde", () => {
    expect(manualJournalListAmount({ total_amount: 250 }, balanced())).toBe(250);
    expect(manualJournalListAmount(null, balanced())).toBe(100);
    expect(manualJournalListAmount(null, [row({ credit_input: "75,00" })])).toBe(75);
    expect(manualJournalListAmount(null, createEmptyLineRows(2))).toBe(0);
  });

  it("26. rekeninglabel wordt opgelost, onbekend blijft leeg", () => {
    const accounts = [{ id: "gb-1", nummer: 4000, omschrijving: "Kosten" }];
    expect(resolveAccountLabel("gb-1", accounts)).toBe("4000 - Kosten");
    expect(resolveAccountLabel("gb-x", accounts)).toBe("");
    expect(resolveAccountLabel(null, accounts)).toBe("");
  });

  it("27. databaseregels worden omgezet naar invoerregels; 0 blijft leeg, niet '0,00'", () => {
    const rows = toLineRows(
      [
        {
          id: "l-1",
          manual_journal_id: "mj-1",
          organization_id: "org-1",
          user_id: "u-1",
          sort_order: 0,
          grootboekrekening_id: "gb-1",
          omschrijving: "Kosten",
          debit_amount: 100,
          credit_amount: 0,
          created_at: "2027-03-31T00:00:00Z",
        },
      ],
      [{ id: "gb-1", nummer: 4000, omschrijving: "Kosten" }],
    );
    expect(rows[0].debit_input).toBe("100,00");
    expect(rows[0].credit_input).toBe("");
    expect(rows[0].grootboek_label).toBe("4000 - Kosten");
    expect(rows[0].id).toBe("l-1");
  });

  it("28. een leeg formulier start met twee regels en de gekozen administratie", () => {
    expect(createEmptyLineRows().length).toBe(2);
    expect(createEmptyHeaderForm("c-9").client_id).toBe("c-9");
  });

  it("29. foutclassificatie: schema, duplicaat, rechten, validatie en onbekend", () => {
    expect(classifyManualJournalError({ code: "PGRST205", message: "schema cache" }).kind).toBe("schema");
    expect(classifyManualJournalError({ code: "23505", message: "Deze memoriaalboeking is al geboekt" }).kind).toBe("duplicate");
    expect(classifyManualJournalError({ code: "42501", message: "Geen rechten om …" })).toEqual({
      kind: "permission",
      message: "Geen rechten om …",
    });
    expect(
      classifyManualJournalError({ code: "23514", message: "Memoriaalboeking is niet in balans: debet 100.00 is ongelijk aan credit 99.00" }),
    ).toEqual({
      kind: "validation",
      message: "Memoriaalboeking is niet in balans: debet 100.00 is ongelijk aan credit 99.00",
    });
    // Rauwe driver-/PostgreSQL-codes worden nooit letterlijk getoond.
    expect(classifyManualJournalError({ message: "XX000 internal" }).message).toBe(
      "Boeken is niet gelukt. Probeer het opnieuw.",
    );
    expect(classifyManualJournalError(null).message).toBe("Boeken is niet gelukt. Probeer het opnieuw.");
  });
});
