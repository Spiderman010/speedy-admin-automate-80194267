import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Controle administratie — de gebruikersstroom.
 *
 * Wat hier bewaakt wordt is niet de opmaak maar de belofte van het scherm: er
 * gebeurt niets tot de gebruiker erom vraagt, er wordt nooit "akkoord" gezegd
 * over iets wat niet gecontroleerd kon worden, en er gaat geen enkele
 * schrijfactie de deur uit. De bedragen en oordelen komen uit de échte kern en
 * de échte motoren; alleen de datahooks zijn gemockt.
 */

const state = {
  rows: [] as Record<string, unknown>[],
  accounts: [] as Record<string, unknown>[],
  integrityError: false,
};

const writeCalls: string[] = [];

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "client-1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant A" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: state.accounts, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  LEDGER_POSTINGS_QUERY_KEY: "ledger-postings",
  useLedgerPostings: (opts: { clientId?: string; period: { toExclusive: string }; enabled?: boolean }) => ({
    data: opts?.clientId && opts?.enabled !== false
      ? state.rows.filter((r) => r.client_id === opts.clientId && (r.posting_date as string) < opts.period.toExclusive)
      : undefined,
    isPending: false, isError: false, error: null,
  }),
}));
vi.mock("@/hooks/useLedgerIntegrity", () => ({
  LEDGER_INTEGRITY_QUERY_KEY: "ledger-integrity",
  useLedgerIntegrity: () => ({
    data: state.integrityError
      ? undefined
      : {
          findings: [], errorCount: 0, warningCount: 0,
          byKind: {
            factuur_zonder_regels: 0, legacy_tekst_zonder_rekening: 0,
            marker_zonder_boekingsgroep: 0, boekingsgroep_niet_in_balans: 0,
          },
        },
    isPending: false,
    isError: state.integrityError,
  }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({
    data: {
      sources: [
        { key: "purchase_invoice", label: "Inkoopfacturen", posted: 2, eligible: 2, outstanding: 0, status: "complete", refused: null, refusedLabel: null, note: null },
      ],
      mayBeIncomplete: false,
      totalOutstanding: 0,
    },
    isPending: false, isError: false,
  }),
  useOpeningBalanceCompleteness: () => ({
    data: {
      state: "posted", year: 2026, assertionYear: 2026, draftCount: 0,
      label: "Geboekt", severity: "complete", note: null,
    },
    isPending: false, isError: false,
  }),
}));
// Elke schrijfpoging valt op.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, order: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
        insert: () => { writeCalls.push("insert"); throw new Error("mag niet"); },
        update: () => { writeCalls.push("update"); throw new Error("mag niet"); },
        delete: () => { writeCalls.push("delete"); throw new Error("mag niet"); },
        upsert: () => { writeCalls.push("upsert"); throw new Error("mag niet"); },
      };
      return chain;
    },
    rpc: (fn: string) => { writeCalls.push(`rpc:${fn}`); return Promise.resolve({ data: null, error: null }); },
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));

import Controle from "@/pages/Controle";

const YEAR = new Date().getFullYear();
const VORIG = YEAR - 1;

let seq = 0;
function entry(debit: string, credit: string, amount: string, date: string, client = "client-1") {
  seq++;
  const group = `g-${seq}`;
  const base = {
    client_id: client, posting_group_id: group, posting_date: date,
    boekjaar: Number(date.slice(0, 4)), currency: "EUR", source_type: "manual_journal",
  };
  return [
    { ...base, id: `${group}-1`, line_no: 1, grootboekrekening_id: debit, debit_amount: amount, credit_amount: "0.00" },
    { ...base, id: `${group}-2`, line_no: 2, grootboekrekening_id: credit, debit_amount: "0.00", credit_amount: amount },
  ];
}

const acc = <T extends { id: string }>(over: T) => ({
  nummer: 1000, omschrijving: "Rekening", categorie: "activa", actief: true, client_id: null,
  statement_type: null as string | null, report_group: null as string | null,
  report_subgroup: null as string | null, normal_side: null, report_sort: null,
  ...over,
});

const BANK = acc({
  id: "a-bank", nummer: 1100, omschrijving: "Bank",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});
const KAPITAAL = acc({
  id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva",
  statement_type: "balans", report_group: "eigen_vermogen", report_subgroup: "ondernemingsvermogen",
});
const OMZET = acc({
  id: "a-omzet", nummer: 8200, omschrijving: "Omzet", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_hoog_tarief",
});

function gezond() {
  state.accounts = [BANK, KAPITAAL, OMZET];
  state.rows = [
    ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
    ...entry(BANK.id, OMZET.id, "1210.00", `${YEAR}-03-01`),
  ];
}

const toon = () => render(<MemoryRouter><Controle /></MemoryRouter>);

beforeEach(() => {
  writeCalls.length = 0;
  state.integrityError = false;
  gezond();
});

describe("de gebruiker start de controle zelf", () => {
  it("11. bij openen draait er geen controle", () => {
    toon();
    expect(screen.queryByTestId("controle-rapport")).toBeNull();
    expect(screen.getByTestId("controle-uitvoeren")).toBeInTheDocument();
    // Geen uitspraak over de boekhouding vóór de klik.
    expect(screen.queryByTestId("controle-alles-akkoord")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Akkoord|Blokkade/);
  });

  it("12. na de klik verschijnt het rapport met administratie en periode", () => {
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    expect(screen.getByTestId("controle-rapport")).toBeInTheDocument();
    expect(screen.getByTestId("controle-context").textContent).toContain("Klant A");
    expect(screen.getByTestId("controle-context").textContent).toContain(String(YEAR));
  });

  it("13. de samenvatting telt uitgevoerd, akkoord, waarschuwingen en blokkades", () => {
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    const uitgevoerd = Number(screen.getByTestId("controle-uitgevoerd").textContent?.replace(/\D/g, ""));
    const akkoord = Number(screen.getByTestId("controle-akkoord").textContent?.replace(/\D/g, ""));
    const waarschuwingen = Number(screen.getByTestId("controle-waarschuwingen").textContent?.replace(/\D/g, ""));
    const blokkades = Number(screen.getByTestId("controle-blokkades").textContent?.replace(/\D/g, ""));
    expect(uitgevoerd).toBeGreaterThanOrEqual(8);
    expect(akkoord + waarschuwingen + blokkades).toBe(uitgevoerd);
    // Het aantal getoonde bevindingen komt overeen met het aantal controles.
    expect(screen.getAllByTestId("controle-bevinding")).toHaveLength(uitgevoerd);
  });

  it("14. een gezonde administratie leest als 'alles akkoord'", () => {
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    expect(screen.getByTestId("controle-alles-akkoord")).toBeInTheDocument();
    expect(screen.queryByTestId("controle-onvolledig")).toBeNull();
  });

  it("15. elke doorklik wijst naar een bestaande route", () => {
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    const bestaande = new Set([
      "/grootboek", "/grootboek/integriteit", "/grootboek/beginbalans",
      "/grootboek/balans", "/grootboek/winst-verlies",
      "/overzichten/proef-saldibalans", "/bank/inhaalslag",
    ]);
    const links = screen.queryAllByTestId("controle-drilldown");
    for (const link of links) {
      expect(bestaande, link.getAttribute("href") ?? "").toContain(link.getAttribute("href"));
    }
  });
});

describe("fail closed op het scherm", () => {
  it("16. een technische storing meldt zich, en niet als 'alles akkoord'", () => {
    state.integrityError = true;
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    const melding = screen.getByTestId("controle-onvolledig");
    expect(melding.textContent).toContain("Integriteitscontrole");
    // Het onderscheid dat telt: technische storing ≠ boekhoudkundige bevinding.
    expect(melding.textContent).toContain("technische storing");
    expect(screen.queryByTestId("controle-alles-akkoord")).toBeNull();
  });

  it("17. de storing staat boven de telling, niet eronder", () => {
    state.integrityError = true;
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    const rapport = screen.getByTestId("controle-rapport");
    const melding = screen.getByTestId("controle-onvolledig");
    const telling = screen.getByTestId("controle-telling");
    expect(rapport.contains(melding)).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING: de telling komt ná de melding.
    expect(melding.compareDocumentPosition(telling) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("de controle wijzigt niets", () => {
  it("18. er gaat geen enkele schrijfactie of RPC de deur uit", () => {
    toon();
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    fireEvent.click(screen.getByTestId("controle-uitvoeren"));
    expect(writeCalls).toEqual([]);
  });

  it("19. de pagina is in de route-tabel opgenomen en staat onder Rapportages", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain('path="/overzichten/controle"');
    // Geen nieuw nav-item: de pagina erft "Rapportages" via /overzichten.
    const nav = readFileSync("src/components/layout/nav.ts", "utf8");
    expect(nav).not.toContain("/overzichten/controle");
    expect(nav).toContain('url: "/overzichten"');
    // En zij is bereikbaar vanaf de rapportagehub.
    const hub = readFileSync("src/pages/Overzichten.tsx", "utf8");
    expect(hub).toContain('href: "/overzichten/controle"');
  });
});
