import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { GrootboekAccountMutations } from "@/components/grootboek/GrootboekAccountMutations";
import { buildRunningBalance, type LedgerPostingLike } from "@/lib/ledger-reporting";

/**
 * Fase 6C-b7 PR 2 — mutaties per rekening. buildRunningBalance uit PR 1
 * draait echt; de component sorteert niets zelf.
 */

let seq = 0;
const p = (over: Partial<LedgerPostingLike> & Pick<LedgerPostingLike, "grootboekrekening_id">): LedgerPostingLike => {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: "c-1",
    posting_group_id: "g-1",
    line_no: 1,
    posting_date: "2027-03-01",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "manual_journal",
    source_id: "mj-1",
    ...over,
  };
};
const grp = (g: string, date: string, legs: Array<[string, number, number]>, over: Partial<LedgerPostingLike> = {}) =>
  legs.map(([acc, d, c], i) =>
    p({ posting_group_id: g, line_no: i + 1, posting_date: date, grootboekrekening_id: acc, debit_amount: d, credit_amount: c, ...over }),
  );

const accounts = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", actief: true },
];
const Q1 = { from: "2027-01-01", toExclusive: "2027-04-01" };

function renderFor(rows: LedgerPostingLike[], accountId = "gb-1100") {
  const running = buildRunningBalance({ rows, clientId: "c-1", accountId, period: Q1, accounts });
  render(
    <MemoryRouter>
      <GrootboekAccountMutations clientId="client-1" accountsById={new Map()} running={running} periodLabel="2027 Q1" />
    </MemoryRouter>,
  );
  return running;
}
const mutationRows = () => screen.getAllByTestId("mutation-row");
// formatEuro gebruikt een harde spatie (U+00A0); normaliseren voor exacte vergelijking.
const cellText = (row: HTMLElement, i: number) => (row.querySelectorAll("td")[i].textContent ?? "").replace(/\u00a0/g, " ");

describe("GrootboekAccountMutations", () => {
  it("16. beginsaldo wordt getoond in de samenvatting én als eerste regel", () => {
    renderFor([
      ...grp("g-0", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 120, 0], ["gb-1100", 0, 120]]),
    ]);
    expect(screen.getByTestId("account-summary")).toHaveTextContent("Beginsaldo");
    expect(screen.getByTestId("account-summary")).toHaveTextContent("€ 500,00");
    expect(screen.getByTestId("mutation-opening")).toHaveTextContent("€ 500,00");
    expect(screen.getByTestId("account-header")).toHaveTextContent("1100");
    expect(screen.getByTestId("account-header")).toHaveTextContent("Bank");
    expect(screen.getByTestId("account-header")).toHaveTextContent("Activa");
    expect(screen.getByTestId("account-header")).toHaveTextContent("2027 Q1");
  });

  it("17. debet- en credittotalen en eindsaldo = begin + debet − credit", () => {
    renderFor([
      ...grp("g-0", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...grp("g-1", "2027-02-01", [["gb-4000", 120, 0], ["gb-1100", 0, 120]]),
      ...grp("g-2", "2027-02-05", [["gb-1100", 30, 0], ["gb-8000", 0, 30]]),
    ]);
    const summary = screen.getByTestId("account-summary");
    const dd = summary.querySelectorAll("dd");
    expect(dd[0]).toHaveTextContent("€ 500,00");
    expect(dd[1]).toHaveTextContent("€ 30,00");
    expect(dd[2]).toHaveTextContent("€ 120,00");
    expect(dd[3]).toHaveTextContent("€ 410,00");
  });

  it("18. lopend saldo is deterministisch in de vaste volgorde, onafhankelijk van de invoer", () => {
    const rows = [
      ...grp("g-b", "2027-02-01", [["gb-1100", 0, 20], ["gb-4000", 20, 0]]),
      ...grp("g-a", "2027-02-01", [["gb-1100", 50, 0], ["gb-8000", 0, 50]]),
      ...grp("g-z", "2026-12-01", [["gb-1100", 100, 0], ["gb-8000", 0, 100]]),
      ...grp("g-c", "2027-03-01", [["gb-1100", 0, 5], ["gb-4000", 5, 0]]),
    ];
    const shuffled = [rows[7], rows[2], rows[5], rows[0], rows[6], rows[3], rows[1], rows[4]];
    renderFor(shuffled);
    const r = mutationRows();
    expect(r.map((x) => cellText(x, 5))).toEqual(["€ 150,00", "€ 130,00", "€ 125,00"]);
    expect(r[0]).toHaveTextContent("01-02-2027");
    expect(cellText(r[0], 3)).toBe("€ 50,00");
    expect(cellText(r[0], 4)).toBe("");
  });

  it("19. bronbadge per regel, neutraal", () => {
    renderFor(grp("g-1", "2027-02-01", [["gb-1100", 10, 0], ["gb-8000", 0, 10]], { source_type: "bank_allocation", source_id: "al-1" }));
    expect(mutationRows()[0]).toHaveTextContent("Bank");
  });

  it("20. alle vier de brontypen krijgen een label en een werkende link", () => {
    renderFor([
      ...grp("g-p", "2027-01-10", [["gb-1100", 1, 0], ["gb-8000", 0, 1]], { source_type: "purchase_invoice", source_id: "pi-1" }),
      ...grp("g-s", "2027-01-11", [["gb-1100", 1, 0], ["gb-8000", 0, 1]], { source_type: "sales_invoice", source_id: "si-1" }),
      ...grp("g-b", "2027-01-12", [["gb-1100", 1, 0], ["gb-8000", 0, 1]], { source_type: "bank_allocation", source_id: "al-1" }),
      ...grp("g-m", "2027-01-13", [["gb-1100", 1, 0], ["gb-8000", 0, 1]], { source_type: "manual_journal", source_id: "mj-1" }),
    ]);
    const r = mutationRows();
    expect(r.map((x) => x.getAttribute("data-source-type"))).toEqual(["purchase_invoice", "sales_invoice", "bank_allocation", "manual_journal"]);
    const hrefs = r.map((x) => x.querySelector("a")?.getAttribute("href"));
    expect(hrefs).toEqual(["/facturen/inkoop/pi-1", "/verkoop", "/bank", "/grootboek/memoriaal"]);
    expect(screen.getAllByRole("link", { name: /Open bron \((Inkoop|Verkoop|Bank|Memoriaal)\)/ })).toHaveLength(4);
  });

  it("21. onbekend brontype → 'Bron niet beschikbaar', geen link, geen crash", () => {
    renderFor([
      ...grp("g-1", "2027-02-01", [["gb-1100", 10, 0], ["gb-8000", 0, 10]], { source_type: "reversal", source_id: "x" }),
      ...grp("g-2", "2027-02-02", [["gb-1100", 10, 0], ["gb-8000", 0, 10]], { source_type: "purchase_invoice", source_id: null }),
    ]);
    const unavailable = screen.getAllByTestId("source-unavailable");
    expect(unavailable).toHaveLength(2);
    expect(unavailable[0]).toHaveTextContent("Bron niet beschikbaar");
    expect(mutationRows()[0].querySelector("a")).toBeNull();
  });

  it("22. een tegenboeking telt gewoon mee en saldeert naar nul", () => {
    const original = grp("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1100", 0, 100]]);
    const reversal = grp("g-2", "2027-02-05", [["gb-1100", 100, 0], ["gb-4000", 0, 100]], { source_type: "reversal" })
      .map((x, i) => ({ ...x, reversal_of_posting_id: original[i].id }));
    const running = renderFor([...original, ...reversal]);
    expect(running.closingCents).toBe(0);
    const r = mutationRows();
    expect(r).toHaveLength(2);
    expect(cellText(r[1], 5)).toBe("€ 0,00");
  });

  it("23. geen legacy journal_entries-inhoud: de component kent alleen ledger-rijen", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const text = readFileSync("src/components/grootboek/GrootboekAccountMutations.tsx", "utf8");
    expect(text).not.toMatch(/journal_entries|useJournalEntries|ledger-mutations|entry_date|ledger_account_text/);
    expect(text).not.toMatch(/\.sort\(/);
  });

  it("geen mutaties in de periode → lege staat, samenvatting toont wel het beginsaldo", () => {
    renderFor(grp("g-0", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]));
    expect(screen.getByText("Geen mutaties op deze rekening in de gekozen periode.")).toBeInTheDocument();
    expect(screen.getByTestId("account-summary")).toHaveTextContent("€ 500,00");
  });
});
