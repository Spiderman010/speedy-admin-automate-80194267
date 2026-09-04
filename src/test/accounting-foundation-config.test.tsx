import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!(Element.prototype as any).hasPointerCapture) {
  (Element.prototype as any).hasPointerCapture = () => false;
  (Element.prototype as any).setPointerCapture = () => {};
  (Element.prototype as any).releasePointerCapture = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
}

// ── Shared mutable state ─────────────────────────────────────────────────────
const state = {
  clients: [] as any[],
  accounts: [] as any[],
};

const toastSpy = vi.fn();
const updateClientMutateAsync = vi.fn();
const addClientMutateAsync = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: state.clients, isLoading: false }),
  useAddClient: () => ({ mutateAsync: addClientMutateAsync }),
  useUpdateClient: () => ({ mutateAsync: updateClientMutateAsync }),
  useDeleteClient: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: state.accounts }),
}));
// Deterministic stand-in for the Popover/Command combobox: exposes the label as
// an input and reports a chosen id, mirroring the real onValueChange/onIdChange.
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange, placeholder }: any) => (
    <input
      aria-label={placeholder ?? "Grootboekrekening"}
      value={value ?? ""}
      onChange={(e) => {
        onValueChange?.(e.target.value);
        const match = state.accounts.find(
          (a: any) => `${a.nummer} - ${a.omschrijving}` === e.target.value,
        );
        onIdChange?.(match ? match.id : "");
      }}
    />
  ),
}));

import Klanten from "@/pages/Klanten";

const ACCOUNTS = [
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren" },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren" },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog" },
];

const makeClient = (over: Partial<any> = {}) => ({
  id: "c-1",
  name: "Klant Een",
  organization_id: "org-1",
  user_id: "u-1",
  country: "NL",
  btw_type: "plichtig",
  btw_vrijgesteld: false,
  ibans: [],
  verwerkingsfrequentie: "kwartaal",
  inkoop_dagboek: 700,
  verkoop_dagboek: 800,
  bank_dagboek: 1100,
  afgesloten_boekjaar: null,
  snelstart_inkoop_mailbox: null,
  debiteuren_rekening_id: null,
  crediteuren_rekening_id: null,
  ...over,
});

const debiteurenField = () => screen.getByLabelText("bv. 1300 - Debiteuren") as HTMLInputElement;
const crediteurenField = () => screen.getByLabelText("bv. 1600 - Crediteuren") as HTMLInputElement;

async function openEditDialog() {
  render(<Klanten />);
  fireEvent.click(screen.getByRole("button", { name: /bewerk klant een/i }));
  await screen.findByLabelText("bv. 1300 - Debiteuren");
}

beforeEach(() => {
  state.clients = [makeClient()];
  state.accounts = ACCOUNTS;
  toastSpy.mockReset();
  updateClientMutateAsync.mockReset().mockResolvedValue({});
  addClientMutateAsync.mockReset().mockResolvedValue({});
});

describe("Klanten — accounting configuratie", () => {
  // 7. debiteurenveld zichtbaar
  it("7. toont het debiteurenrekening-veld", async () => {
    await openEditDialog();
    expect(screen.getByText("Debiteurenrekening")).toBeInTheDocument();
    expect(debiteurenField()).toBeInTheDocument();
  });

  // 8. crediteurenveld zichtbaar
  it("8. toont het crediteurenrekening-veld", async () => {
    await openEditDialog();
    expect(screen.getByText("Crediteurenrekening")).toBeInTheDocument();
    expect(crediteurenField()).toBeInTheDocument();
  });

  // 9. bestaande waarde wordt geladen
  it("9. laadt bestaande rekeningen als label uit de FK", async () => {
    state.clients = [makeClient({ debiteuren_rekening_id: "gb-1300", crediteuren_rekening_id: "gb-1600" })];
    await openEditDialog();
    expect(debiteurenField()).toHaveValue("1300 - Debiteuren");
    expect(crediteurenField()).toHaveValue("1600 - Crediteuren");
  });

  it("9b. laat de velden leeg wanneer nog niets geconfigureerd is", async () => {
    await openEditDialog();
    expect(debiteurenField()).toHaveValue("");
    expect(crediteurenField()).toHaveValue("");
  });

  // 10, 11, 12. wijzigen + bestaande update mutation
  it("10-12. slaat gekozen debiteuren- en crediteurenrekening op via de bestaande update-mutation", async () => {
    await openEditDialog();
    fireEvent.change(debiteurenField(), { target: { value: "1300 - Debiteuren" } });
    fireEvent.change(crediteurenField(), { target: { value: "1600 - Crediteuren" } });
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));

    await waitFor(() => expect(updateClientMutateAsync).toHaveBeenCalledTimes(1));
    expect(updateClientMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "c-1",
        debiteuren_rekening_id: "gb-1300",
        crediteuren_rekening_id: "gb-1600",
      }),
    );
  });

  it("12b. stuurt null wanneer geen rekening gekozen is", async () => {
    await openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));
    await waitFor(() => expect(updateClientMutateAsync).toHaveBeenCalledTimes(1));
    expect(updateClientMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ debiteuren_rekening_id: null, crediteuren_rekening_id: null }),
    );
  });

  // 13. opslaanfout blijft zichtbaar
  it("13. toont de bestaande foutmelding wanneer opslaan mislukt", async () => {
    updateClientMutateAsync.mockRejectedValue(new Error("db down"));
    await openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Fout", description: "db down", variant: "destructive" }),
      ),
    );
  });

  // 14. andere clientconfig blijft intact
  it("14. laat de bestaande dagboekconfiguratie ongemoeid", async () => {
    await openEditDialog();
    fireEvent.change(debiteurenField(), { target: { value: "1300 - Debiteuren" } });
    fireEvent.click(screen.getByRole("button", { name: /^opslaan$/i }));
    await waitFor(() => expect(updateClientMutateAsync).toHaveBeenCalledTimes(1));
    expect(updateClientMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        inkoop_dagboek: 700,
        verkoop_dagboek: 800,
        bank_dagboek: 1100,
        name: "Klant Een",
      }),
    );
  });
});

// ── Migration static review (items 25-34) ───────────────────────────────────
describe("Migration — accounting foundation ledger links", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260904120000_add-accounting-foundation-ledger-links.sql"),
    "utf-8",
  );
  // Assert on executable SQL only — the header comment documents the rollback
  // and the safety rules, and would otherwise match the negative assertions.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("25. voegt exact drie kolommen toe", () => {
    const added = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(added).toHaveLength(3);
    expect(sql).toMatch(/ALTER TABLE public\.clients\s+ADD COLUMN IF NOT EXISTS debiteuren_rekening_id uuid;/);
    expect(sql).toMatch(/ALTER TABLE public\.clients\s+ADD COLUMN IF NOT EXISTS crediteuren_rekening_id uuid;/);
    expect(sql).toMatch(/ALTER TABLE public\.sales_invoices\s+ADD COLUMN IF NOT EXISTS grootboekrekening_id uuid;/);
  });

  it("26. gebruikt de juiste FK-targets", () => {
    const fks = sql.match(/REFERENCES public\.grootboekrekeningen \(id\)/g) ?? [];
    expect(fks).toHaveLength(3);
  });

  it("27. gebruikt ON DELETE SET NULL, nooit CASCADE", () => {
    const setNull = sql.match(/ON DELETE SET NULL/g) ?? [];
    expect(setNull).toHaveLength(3);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });

  it("28. backfillt 1300 organisatiegescoped", () => {
    expect(sql).toMatch(/grootboek\.nummer = 1300/);
    expect(sql).toMatch(/grootboek\.organization_id = client\.organization_id/);
  });

  it("29. backfillt 1600 organisatiegescoped", () => {
    expect(sql).toMatch(/grootboek\.nummer = 1600/);
  });

  it("30. lost ambiguïteit nooit willekeurig op", () => {
    // Elke backfill eist een unieke match; geen LIMIT 1 en geen willekeurige keuze.
    const uniqueGuards = sql.match(/match_count = 1/g) ?? [];
    expect(uniqueGuards).toHaveLength(3);
    expect(sql).not.toMatch(/LIMIT 1/i);
  });

  it("31. sales-backfill gebruikt exacte genormaliseerde labelmatch", () => {
    expect(sql).toMatch(/lower\(trim\(invoice\.ledger_account_text\)\) = lower\(trim\(grootboek\.nummer::text \|\| ' - ' \|\| grootboek\.omschrijving\)\)/);
    expect(sql).not.toMatch(/ILIKE|similarity|%'/);
  });

  it("32. zet geen NOT NULL", () => {
    expect(sql).not.toMatch(/SET NOT NULL/);
    expect(sql).not.toMatch(/uuid NOT NULL/);
  });

  it("33. bevat geen hardcoded UUID-default", () => {
    expect(sql).not.toMatch(/DEFAULT '[0-9a-f]{8}-/i);
    expect(sql).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i);
  });

  it("34. bevat geen ongerelateerde schemawijzigingen", () => {
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).not.toMatch(/CREATE TABLE/);
    expect(sql).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).not.toMatch(/ledger_account_text[^\n]*DROP/);
    // Alleen clients en sales_invoices worden aangepast.
    const altered = [...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["clients", "sales_invoices"]));
  });

  it("34b. documenteert een rollback in de header", () => {
    expect(raw).toMatch(/--\s*rollback:/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS debiteuren_rekening_id/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS crediteuren_rekening_id/);
    expect(raw).toMatch(/DROP COLUMN IF EXISTS grootboekrekening_id/);
  });
});
