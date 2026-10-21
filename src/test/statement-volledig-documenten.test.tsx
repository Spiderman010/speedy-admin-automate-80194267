import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  reportDocumentCompleteness,
  type RefusedWorkItem,
  type ReportDocumentCompleteness,
} from "@/lib/ledger-completeness";
import type { UnpostedWorkItem } from "@/lib/year-close-readiness";
import { reportCompletenessView } from "@/lib/financial-statements-presentation";

/**
 * Herstel P7 — A3-11: "Volledig" op de balans en de W&V betekent niet langer
 * alleen "alles geclassificeerd". Het rapport heet pas volledig als er voor
 * de periode ook geen ongeboekt of door de schrijver geweigerd bronwerk is;
 * anders een telbare status ("Onvolledig: 1 bankregel nog niet geboekt; 1
 * verkoopfactuur met verlegde btw kan niet worden geboekt").
 *
 * Het scenario van de nulmeting (repro/A3/a3-statement-volledig.test.ts):
 * alleen de verkoop van 1.000 staat in het grootboek; de gecodeerde huur en
 * een verlegde factuur van 5.000 ontbreken. De engine zegt "complete", het
 * scherm zei groen "Volledig". Nu niet meer.
 */

const Y = 2026;
const jaar = (y: number) => ({ from: `${y}-01-01`, toExclusive: `${y + 1}-01-01` });
const open = (source: UnpostedWorkItem["source"], boekjaar: number | null, id = `${source}-${boekjaar}`): UnpostedWorkItem => ({ source, id, boekjaar });
const verlegd = (boekjaar: number | null): RefusedWorkItem => ({ source: "sales_invoice", id: `v-${boekjaar}`, boekjaar, reason: "btw_verlegd" });

describe("A3-11 — welk bronwerk hoort bij welk rapport", () => {
  const werk = [
    open("bank_transaction", Y, "b1"),
    open("bank_transaction", Y, "b2"),
    open("bank_transaction", Y, "b3"),
    open("purchase_invoice", Y),
    open("manual_journal", Y - 1),
    open("sales_invoice", Y + 1),
  ];

  it("1. balans: alles met boekjaar t/m het einde van de periode, ook eerdere jaren; later werk niet", () => {
    const d = reportDocumentCompleteness({ unposted: werk, refused: [], period: jaar(Y), statement: "balans" });
    expect(d.status).toBe("incomplete");
    expect(d.unposted).toEqual([
      { source: "purchase_invoice", count: 1 },
      { source: "bank_transaction", count: 3 },
      { source: "manual_journal", count: 1 },
    ]);
    expect(d.scope).toEqual({ fromYear: null, throughYear: Y });
    expect(d.summary).toBe("1 inkoopfactuur, 3 bankregels en 1 memoriaalboeking nog niet geboekt");
    expect(d.bankWorkOpen).toBe(true);
  });

  it("2. W&V: alleen het werk van de jaren in de periode — een memoriaal van vorig jaar raakt dit jaar niet", () => {
    const d = reportDocumentCompleteness({ unposted: werk, refused: [], period: jaar(Y), statement: "winst_verlies" });
    expect(d.unposted).toEqual([
      { source: "purchase_invoice", count: 1 },
      { source: "bank_transaction", count: 3 },
    ]);
    expect(d.scope).toEqual({ fromYear: Y, throughYear: Y });
  });

  it("3. een geweigerde (verlegde) verkoopfactuur maakt het rapport onvolledig en wordt apart benoemd", () => {
    const d = reportDocumentCompleteness({ unposted: [], refused: [verlegd(Y)], period: jaar(Y), statement: "balans" });
    expect(d.status).toBe("incomplete");
    expect(d.summary).toBe("1 verkoopfactuur met verlegde btw kan niet worden geboekt");
    const twee = reportDocumentCompleteness({ unposted: [open("bank_transaction", Y)], refused: [verlegd(Y), verlegd(null)], period: jaar(Y), statement: "winst_verlies" });
    expect(twee.summary).toBe("1 bankregel nog niet geboekt; 2 verkoopfacturen met verlegde btw kunnen niet worden geboekt");
  });

  it("4. een document zonder datum telt altijd mee; zonder open werk is het documentdeel volledig", () => {
    expect(reportDocumentCompleteness({ unposted: [open("purchase_invoice", null)], refused: [], period: jaar(Y), statement: "winst_verlies" }).status).toBe("incomplete");
    const leeg = reportDocumentCompleteness({ unposted: [open("sales_invoice", Y + 1)], refused: [verlegd(Y + 1)], period: jaar(Y), statement: "balans" });
    expect(leeg).toMatchObject({ status: "complete", summary: null, totalUnposted: 0, totalRefused: 0 });
  });
});

describe("A3-11 — het oordeel: classificatie én documenten", () => {
  const vol: ReportDocumentCompleteness = reportDocumentCompleteness({ unposted: [], refused: [], period: jaar(Y), statement: "balans" });
  const onvol = reportDocumentCompleteness({ unposted: [open("bank_transaction", Y)], refused: [verlegd(Y)], period: jaar(Y), statement: "balans" });

  it("5. het scenario van de nulmeting: engine 'complete' + open bronwerk → 'Onvolledig', telbaar, nooit groen", () => {
    const v = reportCompletenessView("complete", { state: "ready", value: onvol });
    expect(v).toMatchObject({ verdict: "incomplete", label: "Onvolledig", tone: "warning" });
    expect(v.reasons).toEqual(["1 bankregel nog niet geboekt; 1 verkoopfactuur met verlegde btw kan niet worden geboekt."]);
  });

  it("6. alleen 'Volledig' als de engine 'complete' zegt én er niets open staat", () => {
    expect(reportCompletenessView("complete", { state: "ready", value: vol })).toMatchObject({ verdict: "complete", label: "Volledig", tone: "success" });
    expect(reportCompletenessView("complete", { state: "pending" })).toMatchObject({ verdict: "pending", label: "Wordt gecontroleerd…", tone: "neutral" });
    expect(reportCompletenessView("complete", { state: "unknown" })).toMatchObject({ verdict: "unknown", label: "Niet vastgesteld", tone: "neutral" });
  });

  it("7. een concreet gebrek wint: ongeclassificeerd is 'Onvolledig', ook zolang het bronwerk nog laadt; met beide oorzaken staan ze er allebei", () => {
    expect(reportCompletenessView("incomplete", { state: "pending" }).verdict).toBe("incomplete");
    const beide = reportCompletenessView("incomplete", { state: "ready", value: onvol });
    expect(beide.reasons).toHaveLength(2);
    expect(beide.description).toMatch(/nog niet is geclassificeerd.*1 bankregel nog niet geboekt/);
  });

  it("8. een periode die geen heel boekjaar is blijft 'Controle vereist' (nooit groen), tenzij er concreet werk open staat", () => {
    expect(reportCompletenessView("ambiguous", { state: "ready", value: vol }).verdict).toBe("ambiguous");
    expect(reportCompletenessView("ambiguous", { state: "pending" }).verdict).toBe("ambiguous");
    expect(reportCompletenessView("ambiguous", { state: "ready", value: onvol }).verdict).toBe("incomplete");
  });
});

// ── De pagina's ──────────────────────────────────────────────────────────────

const YEAR = new Date().getFullYear();
const state = {
  unposted: [] as UnpostedWorkItem[],
  refused: [] as RefusedWorkItem[],
  pending: false,
  error: false,
};

const acc = (o: Record<string, unknown>) => ({ actief: true, client_id: null, organization_id: "org-1", ...o });
const ACCOUNTS = [
  acc({ id: "bank", nummer: 1100, omschrijving: "Bank", categorie: "activa", statement_type: "balans", report_group: "vlottende_activa", normal_side: "debet" }),
  acc({ id: "kapitaal", nummer: 900, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen", normal_side: "credit" }),
  acc({ id: "omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", statement_type: "winst_verlies", report_group: "netto_omzet", normal_side: "credit" }),
];
let n = 0;
const leg = (acct: string, d: string, c: string, date: string, g: string) => ({
  id: `r-${++n}`, client_id: "client-1", organization_id: "org-1", grootboekrekening_id: acct, posting_group_id: g,
  line_no: n, posting_date: date, boekjaar: Number(date.slice(0, 4)), debit_amount: d, credit_amount: c,
  currency: "EUR", source_type: "manual_journal", source_id: g,
});
const ROWS = [
  leg("bank", "5000.00", "0.00", `${YEAR}-01-02`, "g1"), leg("kapitaal", "0.00", "5000.00", `${YEAR}-01-02`, "g1"),
  leg("bank", "1000.00", "0.00", `${YEAR}-03-01`, "g2"), leg("omzet", "0.00", "1000.00", `${YEAR}-03-01`, "g2"),
];

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "client-1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant 2" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: ACCOUNTS, isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: () => ({ data: ROWS, isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
  useOpeningBalanceCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
}));
// De datahook levert ruwe items; de afbakening per periode en rapport doet de
// ECHTE pure functie, met precies de periode en het rapport die de pagina meegeeft.
vi.mock("@/hooks/useUnpostedSourceWork", async () => {
  const lib = await import("@/lib/ledger-completeness");
  return {
    useReportDocumentCompleteness: (_c: string | undefined, period: { from: string; toExclusive: string }, statement: "balans" | "winst_verlies") => ({
      data: state.pending || state.error
        ? undefined
        : lib.reportDocumentCompleteness({ unposted: state.unposted, refused: state.refused, period, statement }),
      isPending: state.pending,
      isError: state.error,
    }),
  };
});

import Balans from "@/pages/Balans";
import WinstVerlies from "@/pages/WinstVerlies";

const renderBalans = () => render(<MemoryRouter><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter><WinstVerlies /></MemoryRouter>);

describe("A3-11 — de balans en de W&V tonen 'Volledig' alleen zonder ongeboekt bronwerk", () => {
  beforeEach(() => {
    state.unposted = [];
    state.refused = [];
    state.pending = false;
    state.error = false;
  });

  it("9. zonder open bronwerk en volledig geclassificeerd: 'Volledig', groen, geen melding", () => {
    renderBalans();
    const badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "complete");
    expect(badge).toHaveTextContent("Volledig");
    expect(badge.className).toMatch(/green/);
    expect(screen.queryByTestId("statement-documents-notice")).toBeNull();
  });

  it("10. de nulmeting: een gecodeerde bankregel en een verlegde factuur van dit jaar → 'Onvolledig' met telbare zin en de weg naar de inhaalslag", () => {
    state.unposted = [open("bank_transaction", YEAR)];
    state.refused = [verlegd(YEAR)];
    renderBalans();
    const badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "incomplete");
    expect(badge).toHaveTextContent("Onvolledig");
    expect(badge.className).not.toMatch(/green/);
    const melding = screen.getByTestId("statement-documents-notice");
    expect(melding).toHaveTextContent("Onvolledig: 1 bankregel nog niet geboekt; 1 verkoopfactuur met verlegde btw kan niet worden geboekt");
    expect(melding).toHaveTextContent(`Bronwerk met boekjaar t/m ${YEAR}`);
    expect(screen.getByRole("link", { name: "Naar de bank-inhaalslag" })).toHaveAttribute("href", "/bank/inhaalslag");
    // De cijfers zelf blijven staan: dit is volledigheidsinformatie, geen blokkade.
    expect(screen.getByTestId("balans-activa-table")).toBeInTheDocument();
  });

  it("11. werk van een LATER jaar maakt de balans van dit jaar niet onvolledig", () => {
    state.unposted = [open("purchase_invoice", YEAR + 1)];
    renderBalans();
    expect(screen.getByTestId("statement-completeness")).toHaveAttribute("data-completeness", "complete");
  });

  it("12. werk van VORIG jaar: de balans (cumulatief) is onvolledig, de W&V van dit jaar niet", () => {
    state.unposted = [open("manual_journal", YEAR - 1)];
    const b = renderBalans();
    expect(screen.getByTestId("statement-completeness")).toHaveAttribute("data-completeness", "incomplete");
    b.unmount();
    renderWv();
    expect(screen.getByTestId("statement-completeness")).toHaveAttribute("data-completeness", "complete");
  });

  it("13. op de W&V telt open werk van dit jaar wél", () => {
    state.unposted = [open("purchase_invoice", YEAR), open("purchase_invoice", YEAR, "pi-2")];
    renderWv();
    expect(screen.getByTestId("statement-completeness")).toHaveAttribute("data-completeness", "incomplete");
    expect(screen.getByTestId("statement-documents-notice")).toHaveTextContent("Onvolledig: 2 inkoopfacturen nog niet geboekt");
    expect(screen.queryByRole("link", { name: "Naar de bank-inhaalslag" })).toBeNull();
  });

  it("14. zolang het bronwerk nog laadt: 'Wordt gecontroleerd…', nooit groen; bij een leesfout 'Niet vastgesteld' met uitleg", () => {
    state.pending = true;
    const a = renderBalans();
    let badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "pending");
    expect(badge.className).not.toMatch(/green/);
    a.unmount();
    state.pending = false;
    state.error = true;
    renderBalans();
    badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "unknown");
    expect(badge).toHaveTextContent("Niet vastgesteld");
    expect(screen.getByTestId("statement-documents-notice")).toHaveAttribute("data-status", "unknown");
  });
});
