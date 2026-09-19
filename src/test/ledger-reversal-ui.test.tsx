import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  classifyReversalError,
  firstReversalFormIssue,
  MAX_REVERSAL_REASON_LENGTH,
  normalizeReversalReason,
  postingGroupLines,
  previewReversalLines,
  reversalAvailability,
  reversalAwareSourceLabel,
  summarizePostingGroup,
  type PostingGroupSummary,
} from "@/lib/ledger-reversal-ui";
import type { LedgerPostingLike } from "@/lib/ledger-reporting";

/**
 * 6C-b9 PR 2 — de correctieflow.
 *
 * De harde eis die elk van deze tests bewaakt: het scherm legt uit, de database
 * beslist. Er gaat nooit een bedrag, een rekening of een zijde de deur uit —
 * alleen een id, een datum en een toelichting.
 */

// ── De gemockte Supabase-client ─────────────────────────────────────────────
// Elke tabelaanroep en elke RPC wordt geteld, zodat een test kan bewijzen dat
// er NIET geschreven wordt en dat de RPC exact één keer en met exact de juiste
// waarden wordt aangeroepen.

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
  rpcResult: () => ({ data: "new-group-id", error: null }),
};

function tableStub(table: string) {
  const write = (op: string) => () => {
    rec.tableCalls.push({ table, op });
    throw new Error(`De applicatie mag niet ${op} op ${table}`);
  };
  const result =
    table === "ledger_postings"
      ? { data: rec.rows, error: null }
      : { data: rec.marker, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
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
  useToast: () => ({ toast: (t: { title?: string; description?: string }) => void toasts.push(t) }),
}));

// De echte component, ná de mocks.
const { LedgerPostingGroupSheet } = await import("@/components/grootboek/LedgerPostingGroupSheet");

// ── Fixtures ────────────────────────────────────────────────────────────────

const GROUP = "group-1";

function row(over: Partial<LedgerPostingLike> & { id: string }): LedgerPostingLike {
  return {
    client_id: "client-1",
    grootboekrekening_id: "acc-1",
    posting_group_id: GROUP,
    line_no: 1,
    posting_date: "2027-03-01",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "purchase_invoice",
    source_id: "doc-1",
    source_line_id: null,
    reversal_of_posting_id: null,
    ...over,
  };
}

/** Het voorbeeld uit de opdracht: 4602 100 debet, 1680 21 debet, 1600 121 credit. */
function inkoopGroep(sourceType = "purchase_invoice"): LedgerPostingLike[] {
  return [
    row({ id: "r1", line_no: 1, grootboekrekening_id: "acc-4602", debit_amount: 100, source_type: sourceType, description: "Kosten" }),
    row({ id: "r2", line_no: 2, grootboekrekening_id: "acc-1680", debit_amount: 21, source_type: sourceType, description: "BTW" }),
    row({ id: "r3", line_no: 3, grootboekrekening_id: "acc-1600", credit_amount: 121, source_type: sourceType, description: "Crediteuren" }),
  ];
}

const ACCOUNTS = new Map([
  ["acc-4602", { id: "acc-4602", nummer: 4602, omschrijving: "Kosten" }],
  ["acc-1680", { id: "acc-1680", nummer: 1680, omschrijving: "BTW te vorderen" }],
  ["acc-1600", { id: "acc-1600", nummer: 1600, omschrijving: "Crediteuren" }],
]);

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LedgerPostingGroupSheet
        open
        onOpenChange={() => undefined}
        clientId="client-1"
        postingGroupId={GROUP}
        accountsById={ACCOUNTS}
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
  rec.rpcResult = () => ({ data: "new-group-id", error: null });
  toasts.length = 0;
});
afterEach(cleanup);

async function openConfirm() {
  const knop = await screen.findByTestId("reversal-open-button");
  fireEvent.click(knop);
  return screen.findByTestId("reversal-confirm-button");
}

// ── 1-5  wanneer is de actie er wel en niet? ────────────────────────────────

describe("de correctieactie wordt alleen aangeboden waar dat mag", () => {
  it("1. een geboekte, ondersteunde boeking toont de actie 'Tegenboeken'", async () => {
    renderSheet();
    expect(await screen.findByTestId("reversal-open-button")).toHaveTextContent("Tegenboeken");
  });

  it("2. een tegenboeking zelf toont geen actie, maar een uitleg", async () => {
    rec.rows = inkoopGroep("reversal").map((r) => ({ ...r, reversal_of_posting_id: "orig-row" }));
    renderSheet();
    const uitleg = await screen.findByTestId("reversal-unsupported");
    expect(uitleg).toHaveTextContent(/tegenboeking van een tegenboeking wordt niet ondersteund/i);
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("3. een beginbalans toont geen actie, maar een uitleg", async () => {
    rec.rows = inkoopGroep("opening_balance");
    renderSheet();
    const uitleg = await screen.findByTestId("reversal-unsupported");
    expect(uitleg).toHaveTextContent(/beginbalans/i);
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("4. een al tegengeboekte boeking toont de status en géén tweede actie", async () => {
    rec.marker = {
      original_posting_group_id: GROUP, reversal_posting_group_id: "rev-9",
      posting_date: "2027-06-01", reason: "Onjuiste kostenrekening", created_at: "2027-06-01T10:00:00Z",
    };
    renderSheet();
    expect(await screen.findByTestId("reversal-already")).toHaveTextContent(/tegengeboekt/i);
    expect(screen.getByTestId("reversal-group-id")).toHaveTextContent("rev-9");
    expect(screen.queryByTestId("reversal-open-button")).toBeNull();
  });

  it("5. de oorspronkelijke regels staan er onveranderd, met hun eigen bedragen", async () => {
    renderSheet();
    const regels = await screen.findAllByTestId("posting-group-line");
    expect(regels).toHaveLength(3);
    expect(regels[0]).toHaveTextContent("4602");
    expect(regels[0]).toHaveTextContent("100,00");
    expect(regels[2]).toHaveTextContent("1600");
    expect(regels[2]).toHaveTextContent("121,00");
  });
});

// ── 6-9  de bevestiging ─────────────────────────────────────────────────────

describe("de bevestiging", () => {
  it("6. zegt expliciet dat de oorspronkelijke boeking blijft bestaan", async () => {
    renderSheet();
    await openConfirm();
    expect(screen.getByTestId("reversal-original-remains")).toHaveTextContent(
      "De oorspronkelijke boeking blijft bestaan. Er wordt een nieuwe tegenboeking gemaakt.",
    );
  });

  it("7. de boekingsdatum is verplicht: zonder datum blijft bevestigen uit", async () => {
    renderSheet();
    const bevestig = await openConfirm();
    expect(screen.getByTestId("reversal-date-input")).toHaveValue("");
    expect(bevestig).toBeDisabled();
    expect(screen.getByTestId("reversal-form-issue")).toHaveTextContent(/kies een boekingsdatum/i);
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    expect(bevestig).not.toBeDisabled();
  });

  it("8. een toelichting van meer dan 500 tekens wordt client-side geblokkeerd", async () => {
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    fireEvent.change(screen.getByTestId("reversal-reason-input"), { target: { value: "x".repeat(501) } });
    expect(bevestig).toBeDisabled();
    expect(screen.getByTestId("reversal-form-issue")).toHaveTextContent(/maximaal 500 tekens/i);
    expect(rec.rpcCalls.filter((c) => c.fn === "reverse_posting_group")).toHaveLength(0);
  });

  it("9. de RPC krijgt exact de boekingsgroep, de datum en de toelichting — en niets anders", async () => {
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    fireEvent.change(screen.getByTestId("reversal-reason-input"), { target: { value: "  Onjuiste rekening  " } });
    fireEvent.click(bevestig);
    await waitFor(() => expect(rec.rpcCalls.some((c) => c.fn === "reverse_posting_group")).toBe(true));
    const call = rec.rpcCalls.find((c) => c.fn === "reverse_posting_group")!;
    expect(call.args).toEqual({
      _posting_group_id: GROUP,
      _posting_date: "2027-06-01",
      _reason: "Onjuiste rekening",
    });
    // Geen bedrag, geen rekening, geen zijde: de database leidt alles zelf af.
    expect(JSON.stringify(call.args)).not.toMatch(/debit|credit|amount|acc-/);
  });
});

// ── 10-12  wat er daarna gebeurt ────────────────────────────────────────────

describe("na de bevestiging", () => {
  it("10. er wordt nergens in het grootboek geschreven", async () => {
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    fireEvent.click(bevestig);
    await waitFor(() => expect(rec.rpcCalls.some((c) => c.fn === "reverse_posting_group")).toBe(true));
    expect(rec.tableCalls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("11/12. de claim wordt opnieuw opgehaald en de nieuwe boekingsgroep wordt gemeld", async () => {
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    // De server heeft na de RPC een claim; de refetch moet die zien.
    rec.rpcResult = () => {
      rec.marker = {
        original_posting_group_id: GROUP, reversal_posting_group_id: "rev-42",
        posting_date: "2027-06-01", reason: null, created_at: "2027-06-01T10:00:00Z",
      };
      return { data: "rev-42", error: null };
    };
    fireEvent.click(bevestig);
    await waitFor(() => expect(toasts.some((t) => t.title === "Tegenboeking gemaakt")).toBe(true));
    expect(toasts.find((t) => t.title === "Tegenboeking gemaakt")!.description).toContain("rev-42");
    // En de actie is daarna weg.
    await waitFor(() => expect(screen.queryByTestId("reversal-open-button")).toBeNull());
    expect(await screen.findByTestId("reversal-group-id")).toHaveTextContent("rev-42");
  });

  it("18. een dubbelklik vuurt de RPC niet twee keer af", async () => {
    let los: (() => void) | null = null;
    rec.rpcResult = () => ({ data: "rev-1", error: null });
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    // De RPC blijft hangen tot wij hem loslaten; zolang mag er niets tweede gebeuren.
    const traag = new Promise<{ data: unknown; error: unknown }>((resolve) => {
      los = () => resolve({ data: "rev-1", error: null });
    });
    rec.rpcResult = () => traag as unknown as { data: unknown; error: unknown };
    fireEvent.click(bevestig);
    fireEvent.click(bevestig);
    fireEvent.click(bevestig);
    await waitFor(() => expect(bevestig).toBeDisabled());
    expect(rec.rpcCalls.filter((c) => c.fn === "reverse_posting_group")).toHaveLength(1);
    los!();
    await waitFor(() => expect(rec.rpcCalls.filter((c) => c.fn === "reverse_posting_group")).toHaveLength(1));
  });
});

// ── 13-17  de foutafhandeling ───────────────────────────────────────────────

describe("serverfouten worden begrijpelijk gemeld zonder hun betekenis te verbergen", () => {
  async function faal(error: { code: string; message: string }) {
    rec.rpcResult = () => ({ data: null, error });
    renderSheet();
    const bevestig = await openConfirm();
    fireEvent.change(screen.getByTestId("reversal-date-input"), { target: { value: "2027-06-01" } });
    fireEvent.click(bevestig);
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    return toasts[toasts.length - 1];
  }

  it("13. al tegengeboekt", async () => {
    const t = await faal({ code: "23505", message: "Deze boekingsgroep is al tegengeboekt" });
    expect(`${t.title} ${t.description}`).toMatch(/al tegengeboekt/i);
  });

  it("14. afgesloten boekjaar", async () => {
    const t = await faal({ code: "22023", message: "Boekjaar 2027 is afgesloten voor deze administratie" });
    expect(t.description).toBe("Boekjaar 2027 is afgesloten voor deze administratie");
  });

  it("15. onvoldoende rechten", async () => {
    const t = await faal({
      code: "42501",
      message: "Geen rechten om een tegenboeking te maken voor deze organisatie (accountant vereist)",
    });
    expect(t.description).toMatch(/accountant vereist/i);
  });

  it("16. een niet-beschikbare boeking lekt geen tenantdetail", async () => {
    const t = await faal({ code: "42501", message: "Boekingsgroep niet beschikbaar" });
    expect(t.description).toBe(
      "Deze boeking is niet beschikbaar. Controleer of je de juiste administratie hebt geopend.",
    );
    expect(`${t.title} ${t.description}`).not.toMatch(/organisatie|administratie van|bestaat/i);
  });

  it("17. een onbekende serverfout wordt veilig afgehandeld", async () => {
    const t = await faal({ code: "XX000", message: 'ERROR: relation "x" does not exist' });
    expect(t.description).toBe("De tegenboeking is niet gelukt. Probeer het opnieuw.");
    expect(t.description).not.toMatch(/relation|ERROR:/);
  });
});

// ── de pure laag ────────────────────────────────────────────────────────────

describe("de pure laag", () => {
  it("telt af wat er is geboekt, in hele centen", () => {
    const s = summarizePostingGroup(GROUP, inkoopGroep());
    expect(s).toMatchObject({
      lineCount: 3, debitCents: 12100, creditCents: 12100, balanced: true,
      postingDate: "2027-03-01", boekjaar: 2027, currency: "EUR", sourceType: "purchase_invoice",
    });
  });

  it("een groep die het oneens is over datum, valuta of bronsoort levert null op dat veld", () => {
    const gemengd = [
      ...inkoopGroep(),
      row({ id: "r4", line_no: 4, currency: "USD", posting_date: "2027-04-01", source_type: "manual_journal" }),
    ];
    const s = summarizePostingGroup(GROUP, gemengd);
    expect(s.currency).toBeNull();
    expect(s.postingDate).toBeNull();
    expect(s.sourceType).toBeNull();
  });

  it("23. het voorbeeld verwisselt debet en credit, en zegt dat het een voorbeeld is", () => {
    const preview = previewReversalLines(GROUP, inkoopGroep());
    expect(preview).toEqual([
      { originalRowId: "r1", grootboekrekeningId: "acc-4602", debitCents: 0, creditCents: 10000 },
      { originalRowId: "r2", grootboekrekeningId: "acc-1680", debitCents: 0, creditCents: 2100 },
      { originalRowId: "r3", grootboekrekeningId: "acc-1600", debitCents: 12100, creditCents: 0 },
    ]);
  });

  it("de regels houden de vaste grootboekvolgorde", () => {
    const shuffled = [...inkoopGroep()].reverse();
    expect(postingGroupLines(GROUP, shuffled).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("een onbekende toestand telt nooit als 'mag wel'", () => {
    const basis: PostingGroupSummary = summarizePostingGroup(GROUP, inkoopGroep());
    const onzeker = reversalAvailability({
      summary: basis, existingReversalGroupId: null, markerUnavailable: false,
      markerPending: true, canReverse: true, roleUnavailable: false,
    });
    expect(onzeker.kind).toBe("unknown");
    const rolOnbekend = reversalAvailability({
      summary: basis, existingReversalGroupId: null, markerUnavailable: false,
      markerPending: false, canReverse: undefined, roleUnavailable: false,
    });
    expect(rolOnbekend.kind).toBe("unknown");
    const geenRecht = reversalAvailability({
      summary: basis, existingReversalGroupId: null, markerUnavailable: false,
      markerPending: false, canReverse: false, roleUnavailable: false,
    });
    expect(geenRecht.kind).toBe("not_allowed");
  });

  it("een niet-sluitende groep wordt niet aangeboden", () => {
    const scheef = summarizePostingGroup(GROUP, inkoopGroep().slice(0, 2));
    const uitkomst = reversalAvailability({
      summary: scheef, existingReversalGroupId: null, markerUnavailable: false,
      markerPending: false, canReverse: true, roleUnavailable: false,
    });
    expect(uitkomst.kind).toBe("not_reversible");
  });

  it("de toelichting wordt getrimd en lege tekst wordt null", () => {
    expect(normalizeReversalReason("  hoi \n")).toBe("hoi");
    expect(normalizeReversalReason("   ")).toBeNull();
    expect(MAX_REVERSAL_REASON_LENGTH).toBe(500);
  });

  it("het formulier controleert alleen de VORM, nooit een boekhoudregel", () => {
    expect(firstReversalFormIssue({ postingDate: "", reason: "" })).toMatch(/boekingsdatum/i);
    expect(firstReversalFormIssue({ postingDate: "geen datum", reason: "" })).toMatch(/geldige datum/i);
    expect(firstReversalFormIssue({ postingDate: "2027-06-01", reason: "" })).toBeNull();
    const bron = readFileSync("src/lib/ledger-reversal-ui.ts", "utf8");
    const start = bron.indexOf("export function firstReversalFormIssue");
    const formBlok = bron.slice(start, bron.indexOf("\n}", start));
    expect(formBlok).not.toMatch(/afgesloten|boekjaar|accountant|balans/);
  });

  it("de bronsoort 'reversal' krijgt een leesbaar label", () => {
    expect(reversalAwareSourceLabel("reversal")).toBe("Tegenboeking");
    expect(reversalAwareSourceLabel("purchase_invoice")).toBe("Inkoop");
    expect(reversalAwareSourceLabel("")).toBe("Onbekende bron");
  });

  it("de foutvertaling bewaart de betekenis van de server", () => {
    expect(classifyReversalError({ code: "22023", message: "Deze boekingsgroep is zelf een tegenboeking" }).kind)
      .toBe("reversal_of_reversal");
    expect(classifyReversalError({ code: "22023", message: "Een geboekte beginbalans kan niet worden tegengeboekt" }).kind)
      .toBe("opening_balance");
    expect(classifyReversalError({ code: "23514", message: "Boekingsgroep is niet in balans: debet 1 credit 2" }).kind)
      .toBe("corrupt");
    expect(classifyReversalError({ code: "PGRST205", message: "schema cache" }).kind).toBe("schema");
    expect(classifyReversalError(new TypeError("Failed to fetch")).kind).toBe("network");
  });
});

// ── 19-22  de rest van de applicatie blijft ongemoeid ───────────────────────

describe("scope", () => {
  let changed: string[] | null = null;
  try {
    changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean);
  } catch {
    changed = null;
  }
  const branchIt = changed === null ? it.skip : it;

  branchIt("19/20. de boekstromen van inkoop en verkoop zijn niet aangeraakt", () => {
    for (const f of [
      "src/hooks/usePurchaseInvoicePosting.ts",
      "src/hooks/useSalesInvoicePosting.ts",
      "src/lib/ledger-catchup.ts",
      "src/hooks/useLedgerCatchup.ts",
    ]) {
      if (existsSync(f)) expect(changed, f).not.toContain(f);
    }
  });

  branchIt("21. de diagnostiek is niet herontworpen", () => {
    expect(changed).not.toContain("src/lib/accounting-diagnostics.ts");
    expect(changed).not.toContain("src/lib/reversal-integrity.ts");
    expect(changed).not.toContain("src/pages/DiagnosticsAccounting.tsx");
  });

  branchIt("22. geen migratie, geen SQL, geen handmatige typewijziging, geen dependency", () => {
    expect(changed!.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed!.filter((f) => f.endsWith(".sql"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  branchIt("24. geen enkel bestand in deze branch schrijft in ledger_postings", () => {
    for (const f of changed!.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f) && existsSync(f))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/ledger_postings[\s\S]{0,200}\.\s*(insert|upsert|update|delete)\s*\(/);
    }
  });

  it("de correctie-UI kent geen enkele boekhoudregel van de schrijver", () => {
    for (const f of [
      "src/lib/ledger-reversal-ui.ts",
      "src/hooks/useLedgerReversal.ts",
      "src/components/grootboek/ReversalConfirmDialog.tsx",
      "src/components/grootboek/LedgerPostingGroupSheet.tsx",
    ]) {
      // Uitsluitend uitvoerbare code: een toelichting mag deze woorden noemen,
      // de code mag er niets uit afleiden.
      const text = readFileSync(f, "utf8")
        .split("\n")
        .filter((r) => !r.trimStart().startsWith("//") && !r.trimStart().startsWith("*") && !r.trimStart().startsWith("/*"))
        .join("\n");
      // Geen rekeningnummerreeksen, geen afgeleide bronsoort, geen eigen
      // boekjaar-/rolregels: dat is allemaal de database.
      expect(text, f).not.toMatch(/\b1[1-9]00\b/);
      expect(text, f).not.toMatch(/afgesloten_boekjaar/);
      expect(text, f).not.toMatch(/\bcategorie\b/);
    }
  });
});
