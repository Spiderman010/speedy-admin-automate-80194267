import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertBranchSqlLeavesReportingAlone } from "./support/branch-sql-scope";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LedgerPostingLike } from "@/lib/ledger-reporting";

/**
 * De correctieflow, van de kant van de gebruiker.
 *
 * De inzet van deze PR is één zin: een accountant mag nooit denken dat hij een
 * bestaande journaalpost bewerkt of weggooit. Dat betekent drie duidelijk
 * verschillende toestanden — normale boeking, teruggedraaid origineel, en de
 * tegenboeking zelf — die elk hun eigen woorden en hun eigen navigatie hebben.
 *
 * De boekhouding zelf komt in dit bestand niet voor: er wordt geen bedrag
 * gecontroleerd en geen regel berekend. Wat hier telt is wat er te zien is, en
 * wat er WEL en NIET naar de database gaat.
 */

interface Recorder {
  rpcCalls: { fn: string; args: unknown }[];
  tableCalls: { table: string; op: string }[];
  rows: LedgerPostingLike[];
  marker: Record<string, unknown> | null;
  canReverse: boolean;
  rpcResult: () => { data: unknown; error: unknown };
}

const rec: Recorder = {
  rpcCalls: [], tableCalls: [], rows: [], marker: null, canReverse: true,
  rpcResult: () => ({ data: "rev-9", error: null }),
};

function tableStub(table: string) {
  const write = (op: string) => () => {
    rec.tableCalls.push({ table, op });
    throw new Error(`De applicatie mag niet ${op} op ${table}`);
  };
  // De markertabel wordt op twee verschillende kolommen bevraagd; het dubbel
  // bootst dat filter na, zodat een groep nooit tegelijk origineel én
  // tegenboeking kan lijken.
  let eqKolom: string | null = null;
  let eqWaarde: unknown = null;
  const markerResult = () => {
    if (!rec.marker) return { data: null, error: null };
    if (eqKolom && (rec.marker as Record<string, unknown>)[eqKolom] !== eqWaarde) {
      return { data: null, error: null };
    }
    return { data: rec.marker, error: null };
  };
  const result = () =>
    table === "ledger_postings" ? { data: rec.rows, error: null } : markerResult();
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (kolom: string, waarde: unknown) => {
      eqKolom = kolom;
      eqWaarde = waarde;
      return chain;
    },
    order: () => chain,
    maybeSingle: () => Promise.resolve(result()),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    insert: write("insert"), update: write("update"), delete: write("delete"), upsert: write("upsert"),
  };
  rec.tableCalls.push({ table, op: "select" });
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => tableStub(table),
    rpc: (fn: string, args: unknown) => {
      rec.rpcCalls.push({ fn, args });
      if (fn === "has_min_role") return Promise.resolve({ data: rec.canReverse, error: null });
      return Promise.resolve(rec.rpcResult());
    },
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
const toasts: { title?: string; description?: string }[] = [];
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string }) => void toasts.push(t) }),
}));

const { LedgerPostingGroupSheet } = await import("@/components/grootboek/LedgerPostingGroupSheet");

const GROUP = "group-1";
const REVERSAL_GROUP = "rev-9";

function row(over: Partial<LedgerPostingLike> & { id: string }): LedgerPostingLike {
  return {
    client_id: "client-1", grootboekrekening_id: "acc-1", posting_group_id: GROUP, line_no: 1,
    posting_date: "2027-03-01", boekjaar: 2027, debit_amount: 0, credit_amount: 0, currency: "EUR",
    description: null, source_type: "purchase_invoice", source_id: "doc-1", source_line_id: null,
    reversal_of_posting_id: null, ...over,
  };
}

function inkoopGroep(sourceType = "purchase_invoice"): LedgerPostingLike[] {
  return [
    row({ id: "r1", line_no: 1, grootboekrekening_id: "acc-4602", debit_amount: 100, source_type: sourceType }),
    row({ id: "r2", line_no: 2, grootboekrekening_id: "acc-1680", debit_amount: 21, source_type: sourceType }),
    row({ id: "r3", line_no: 3, grootboekrekening_id: "acc-1600", credit_amount: 121, source_type: sourceType }),
  ];
}

const ACCOUNTS = new Map([
  ["acc-4602", { id: "acc-4602", nummer: 4602, omschrijving: "Kosten" }],
  ["acc-1680", { id: "acc-1680", nummer: 1680, omschrijving: "BTW te vorderen" }],
  ["acc-1600", { id: "acc-1600", nummer: 1600, omschrijving: "Crediteuren" }],
]);

/** De marker zoals de database hem vastlegt. */
const marker = (over: Record<string, unknown> = {}) => ({
  original_posting_group_id: GROUP,
  reversal_posting_group_id: REVERSAL_GROUP,
  posting_date: "2027-06-01",
  reason: "Onjuiste kostenrekening",
  created_at: "2027-06-01T10:00:00Z",
  ...over,
});

const navigatie: string[] = [];

function renderSheet(groupId = GROUP, metNavigatie = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LedgerPostingGroupSheet
        open
        onOpenChange={() => undefined}
        clientId="client-1"
        postingGroupId={groupId}
        accountsById={ACCOUNTS}
        onNavigateToGroup={metNavigatie ? (id) => void navigatie.push(id) : undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rec.rpcCalls = [];
  rec.tableCalls = [];
  rec.rows = inkoopGroep();
  rec.marker = null;
  rec.canReverse = true;
  rec.rpcResult = () => ({ data: REVERSAL_GROUP, error: null });
  toasts.length = 0;
  navigatie.length = 0;
});
afterEach(cleanup);

// ── de drie toestanden ──────────────────────────────────────────────────────

describe("een gewone boeking", () => {
  it("1. biedt 'Tegenboeking maken' aan", async () => {
    renderSheet();
    const knop = await screen.findByTestId("reversal-open-button");
    expect(knop).toHaveTextContent("Tegenboeking maken");
    expect(await screen.findByTestId("posting-group-status")).toHaveTextContent("Geboekt");
  });

  it("1b. geen enkele AANGEBODEN handeling heet bewerken, verwijderen of ongedaan maken", async () => {
    renderSheet();
    await screen.findByTestId("reversal-open-button");
    /*
     * Het gaat om wat de gebruiker kan DOEN. De uitleg mag die woorden juist
     * wél gebruiken — het paneel stelt expliciet gerust dat grootboekregels
     * nooit worden gewijzigd of verwijderd — maar geen knop mag zo heten.
     */
    for (const knop of screen.getAllByRole("button")) {
      const naam = `${knop.textContent ?? ""} ${knop.getAttribute("aria-label") ?? ""}`;
      expect(naam, naam).not.toMatch(/bewerk|verwijder|ongedaan/i);
    }
  });

  it("1c. de actieknop is niet de destructieve (verwijder)variant", () => {
    const bron = readFileSync("src/components/grootboek/LedgerPostingGroupSheet.tsx", "utf8");
    const blok = bron.slice(bron.indexOf('data-testid="reversal-action-area"'));
    expect(blok.slice(0, blok.indexOf("</div>"))).not.toMatch(/variant="destructive"/);
  });
});

describe("een teruggedraaid origineel", () => {
  beforeEach(() => { rec.marker = marker(); });

  it("2. toont de status 'Teruggedraaid'", async () => {
    renderSheet();
    expect(await screen.findByTestId("posting-group-status")).toHaveTextContent("Teruggedraaid");
    expect(await screen.findByTestId("reversal-already")).toHaveTextContent(/teruggedraaid/i);
  });

  it("3. biedt géén tweede tegenboekingsactie aan", async () => {
    renderSheet();
    await screen.findByTestId("reversal-already");
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("8/9. toont de vastgelegde reden en de datum van de tegenboeking", async () => {
    renderSheet();
    await screen.findByTestId("reversal-already");
    expect(screen.getByTestId("reversal-reason")).toHaveTextContent("Onjuiste kostenrekening");
    expect(screen.getByTestId("reversal-date")).toHaveTextContent("01-06-2027");
  });

  it("6. verwijst naar de tegenboeking en kan ernaartoe navigeren", async () => {
    renderSheet();
    await screen.findByTestId("reversal-already");
    expect(screen.getByTestId("reversal-group-id")).toHaveTextContent(REVERSAL_GROUP);
    fireEvent.click(screen.getByTestId("reversal-goto-reversal"));
    expect(navigatie).toEqual([REVERSAL_GROUP]);
  });

  it("10. een ontbrekende reden wordt als ontbrekend getoond, niet verzonnen", async () => {
    rec.marker = marker({ reason: null });
    renderSheet();
    await screen.findByTestId("reversal-already");
    expect(screen.getByTestId("reversal-reason")).toHaveTextContent("Niet vastgelegd");
    // en er wordt geen andere tekst als reden opgevoerd
    expect(screen.getByTestId("reversal-reason").textContent?.trim()).toBe("Niet vastgelegd");
  });
});

describe("de tegenboeking zelf", () => {
  beforeEach(() => {
    // Deze groep IS de tegenboeking: de marker matcht op reversal_posting_group_id.
    rec.marker = marker();
    rec.rows = inkoopGroep("reversal").map((r) => ({ ...r, posting_group_id: REVERSAL_GROUP }));
  });

  it("4. toont de status 'Tegenboeking'", async () => {
    renderSheet(REVERSAL_GROUP);
    expect(await screen.findByTestId("posting-group-status")).toHaveTextContent("Tegenboeking");
    expect(await screen.findByTestId("reversal-is-reversal")).toBeInTheDocument();
  });

  it("5. biedt geen tegenboekingsactie aan", async () => {
    renderSheet(REVERSAL_GROUP);
    await screen.findByTestId("reversal-is-reversal");
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("7. verwijst naar het origineel en kan ernaartoe navigeren", async () => {
    renderSheet(REVERSAL_GROUP);
    await screen.findByTestId("reversal-is-reversal");
    expect(screen.getByTestId("reversal-original-group-id")).toHaveTextContent(GROUP);
    fireEvent.click(screen.getByTestId("reversal-goto-original"));
    expect(navigatie).toEqual([GROUP]);
  });

  it("8b/9b. toont ook hier de vastgelegde datum en reden", async () => {
    renderSheet(REVERSAL_GROUP);
    await screen.findByTestId("reversal-is-reversal");
    expect(screen.getByTestId("reversal-date")).toHaveTextContent("01-06-2027");
    expect(screen.getByTestId("reversal-reason")).toHaveTextContent("Onjuiste kostenrekening");
  });

  it("zonder navigatiecallback blijft de verwijzing zichtbaar, zonder knop", async () => {
    renderSheet(REVERSAL_GROUP, false);
    await screen.findByTestId("reversal-is-reversal");
    expect(screen.getByTestId("reversal-original-group-id")).toHaveTextContent(GROUP);
    expect(screen.queryByTestId("reversal-goto-original")).toBeNull();
  });
});

// ── de bevestiging ──────────────────────────────────────────────────────────

describe("de bevestiging", () => {
  async function openConfirm() {
    renderSheet();
    fireEvent.click(await screen.findByTestId("reversal-open-button"));
    return screen.findByTestId("reversal-confirm-button");
  }

  it("11/12. zegt dat het origineel blijft en dat er een nieuwe spiegelboeking komt", async () => {
    await openConfirm();
    const melding = screen.getByTestId("reversal-original-remains");
    expect(melding).toHaveTextContent(/originele boeking blijft ongewijzigd bestaan/i);
    expect(melding).toHaveTextContent(/nieuwe, spiegelbeeldige boeking/i);
  });

  it("11b. en benoemt dat ook een tegenboeking definitief in de audittrail staat", async () => {
    await openConfirm();
    expect(screen.getByTestId("reversal-append-only")).toHaveTextContent(/audittrail/i);
    expect(screen.getByTestId("reversal-append-only")).toHaveTextContent(/niet worden teruggenomen/i);
  });

  it("11c. noemt de boekingsgroep waar het om gaat", async () => {
    await openConfirm();
    expect(screen.getByTestId("reversal-original-group")).toHaveTextContent(GROUP);
  });

  it("13. de primaire actie heet 'Tegenboeking boeken', de secundaire 'Annuleren'", async () => {
    const knop = await openConfirm();
    expect(knop).toHaveTextContent("Tegenboeking boeken");
    expect(screen.getByText("Annuleren")).toBeInTheDocument();
  });

  it("13b. de primaire actie is niet de destructieve variant", () => {
    const bron = readFileSync("src/components/grootboek/ReversalConfirmDialog.tsx", "utf8");
    const blok = bron.slice(bron.indexOf("<DialogFooter>"));
    expect(blok).not.toMatch(/variant="destructive"/);
  });

  it("de datum en de reden dragen de afgesproken labels", async () => {
    await openConfirm();
    expect(screen.getByText(/Datum tegenboeking/)).toBeInTheDocument();
    expect(screen.getByText(/^Reden/)).toBeInTheDocument();
  });
});

// ── dubbelklikbescherming en het contract ───────────────────────────────────

describe("er gaat nooit meer dan één tegenboeking de deur uit", () => {
  async function vuurDrieKlikken() {
    renderSheet();
    fireEvent.click(await screen.findByTestId("reversal-open-button"));
    const bevestig = await screen.findByTestId("reversal-confirm-button");
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    fireEvent.click(bevestig);
    fireEvent.click(bevestig);
    fireEvent.click(bevestig);
    await waitFor(() =>
      expect(rec.rpcCalls.filter((c) => c.fn === "reverse_posting_group").length).toBeGreaterThan(0),
    );
    return rec.rpcCalls.filter((c) => c.fn === "reverse_posting_group");
  }

  it("14/15. drie klikken binnen één tick leveren één RPC-aanroep op", async () => {
    const calls = await vuurDrieKlikken();
    expect(calls).toHaveLength(1);
  });

  it("16. de RPC krijgt exact het bestaande contract: drie waarden, geen bedrag", async () => {
    const calls = await vuurDrieKlikken();
    expect(calls[0].args).toEqual({
      _posting_group_id: GROUP,
      _posting_date: "2027-06-01",
      _reason: null,
    });
    const serialised = JSON.stringify(calls[0].args);
    expect(serialised).not.toMatch(/debit|credit|amount|grootboekrekening|100|121/);
  });

  it("15b. de synchrone grendel staat in de component en is niet verzwakt", () => {
    const bron = readFileSync("src/components/grootboek/LedgerPostingGroupSheet.tsx", "utf8");
    expect(bron).toMatch(/const inFlight = useRef\(false\)/);
    expect(bron).toMatch(/if \(!postingGroupId \|\| inFlight\.current \|\| reverse\.isPending\) return;/);
  });
});

// ── de grenzen ──────────────────────────────────────────────────────────────

describe("de UI schrijft niet en rekent niet", () => {
  const bestanden = {
    sheet: readFileSync("src/components/grootboek/LedgerPostingGroupSheet.tsx", "utf8"),
    dialog: readFileSync("src/components/grootboek/ReversalConfirmDialog.tsx", "utf8"),
    mutaties: readFileSync("src/components/grootboek/GrootboekAccountMutations.tsx", "utf8"),
    lib: readFileSync("src/lib/ledger-reversal-ui.ts", "utf8"),
  };

  it("17. geen insert, update of delete op ledger_postings", async () => {
    renderSheet();
    await screen.findByTestId("reversal-open-button");
    expect(rec.tableCalls.filter((c) => c.op !== "select")).toEqual([]);
    for (const [naam, bron] of Object.entries(bestanden)) {
      expect(bron, naam).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
      expect(bron, naam).not.toMatch(/from\(["']ledger_postings["']\)/);
    }
  });

  it("18. de beginbalansbeperking is ongewijzigd en komt uit de opgeslagen bronsoort", async () => {
    rec.rows = inkoopGroep("opening_balance");
    renderSheet();
    expect(await screen.findByTestId("reversal-unsupported")).toHaveTextContent(/beginbalans/i);
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("18b. en een tegenboeking blijft een niet-ondersteunde bron voor een tweede tegenboeking", async () => {
    rec.rows = inkoopGroep("reversal");
    renderSheet();
    await screen.findByTestId("reversal-unsupported");
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("de rolcontrole blijft één aanroep van has_min_role", async () => {
    renderSheet();
    await screen.findByTestId("reversal-open-button");
    const rol = rec.rpcCalls.filter((c) => c.fn === "has_min_role");
    expect(rol.length).toBeGreaterThan(0);
    expect(rol[0].args).toMatchObject({ _min: "accountant" });
  });
});

describe("scope", () => {
  it("19/20. geen migratie, en geen rekenlaag aangeraakt", (ctx) => {
    let changed: string[];
    let toon: (p: string) => string;
    try {
      execFileSync("git", ["rev-parse", "origin/main"], { stdio: ["ignore", "pipe", "ignore"] });
      toon = (p) => execFileSync("git", ["show", `origin/main:${p}`], { encoding: "utf8" });
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      ctx.skip();
      return;
    }
    /*
     * Geen "geen SQL in deze branch" meer: PR D (de handhaving van de
     * boekingsblokkade) herdefinieert `reverse_posting_group()` terecht. Wat
     * deze weergave-PR werkelijk beschermt, is de tegenboekingsmotor zelf:
     * strenger mag, maar het bewijsspoor mag niet verdwijnen.
     */
    assertBranchSqlLeavesReportingAlone(changed);
    for (const f of changed.filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(f, "utf8");
      expect(sql, f).not.toMatch(/DROP FUNCTION[^;]*reverse_posting_group/i);
      if (/FUNCTION public\.reverse_posting_group/.test(sql)) {
        expect(sql, `${f}: de tegenboeking blijft haar bewijsspoor schrijven`).toContain(
          "ledger_reversal_postings",
        );
      }
    }
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    // Elke rekenlaag blijft byte-voor-byte gelijk; deze PR is presentatie.
    for (const p of [
      "src/lib/ledger-reporting.ts",
      "src/lib/financial-statements.ts",
      "src/lib/financial-statements-presentation.ts",
      "src/hooks/useLedgerReversal.ts",
    ]) {
      expect(readFileSync(p, "utf8"), p).toBe(toon(p));
    }
  });
});
