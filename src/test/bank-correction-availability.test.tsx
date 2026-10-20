import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * "Rekening wijzigen" verschijnt alleen als `reclassify_bank_transaction` in
 * de database bestaat (migraties 20261018120000 / 20261018150000). Zonder die
 * functie zou elke poging in een weigering eindigen: dan geen knop.
 */

const { rpcSpy } = vi.hoisted(() => ({ rpcSpy: vi.fn() }));
let probeError: { code?: string; message: string } | null = null;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcSpy(...args),
    from: () => ({}),
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useBankTransactionPosting", () => ({
  useBankTransactionPosting: () => ({
    data: { posting_group_id: "group-1" },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import { bankCorrectionAvailable } from "@/hooks/useBankTransactionCorrection";
import { BankTransactionCorrectionAction } from "@/components/bank/BankTransactionCorrectionAction";

const transaction = {
  id: "tx-1",
  client_id: "c-1",
  organization_id: "org-1",
  match_status: "handmatig_geboekt",
  btw_percentage: 21,
} as any;

beforeEach(() => {
  probeError = { code: "22004", message: "Banktransactie, grootboekrekening, BTW-percentage en request_id zijn verplicht" };
  rpcSpy.mockReset();
  rpcSpy.mockImplementation(async (name: string) => {
    if (name === "has_min_role") return { data: true, error: null };
    if (name === "reclassify_bank_transaction") return { data: null, error: probeError };
    throw new Error(`onverwachte rpc ${name}`);
  });
});

function renderAction() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BankTransactionCorrectionAction transaction={transaction} allocationCount={0} />
    </QueryClientProvider>,
  );
}

const probeCalls = () => rpcSpy.mock.calls.filter((c) => c[0] === "reclassify_bank_transaction");

describe("bankCorrectionAvailable", () => {
  it("roept de functie aan met uitsluitend NULL-argumenten (stap 0 weigert dat zonder iets te lezen of te schrijven)", async () => {
    await bankCorrectionAvailable();
    expect(probeCalls()).toHaveLength(1);
    const args = probeCalls()[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "_btw_percentage", "_description", "_expected_posting_group_id", "_grootboekrekening_id",
      "_reason", "_request_id", "_transaction_id",
    ]);
    expect(Object.values(args).every((v) => v === null)).toBe(true);
  });

  it("22004 ⇒ beschikbaar; PGRST202 of 42883 ⇒ niet beschikbaar; iets anders ⇒ onbekend (werpt)", async () => {
    expect(await bankCorrectionAvailable()).toBe(true);
    probeError = { code: "PGRST202", message: "Could not find the function public.reclassify_bank_transaction" };
    expect(await bankCorrectionAvailable()).toBe(false);
    probeError = { code: "42883", message: "function does not exist" };
    expect(await bankCorrectionAvailable()).toBe(false);
    probeError = { code: "PGRST301", message: "JWT expired" };
    await expect(bankCorrectionAvailable()).rejects.toThrow();
    probeError = null; // de functie zou een aanroep met NULL nooit accepteren: onbekend, dus geen knop
    await expect(bankCorrectionAvailable()).rejects.toThrow();
  });
});

describe("BankTransactionCorrectionAction — alleen met uitgerolde RPC", () => {
  it("RPC aanwezig: de knop verschijnt", async () => {
    renderAction();
    expect(await screen.findByRole("button", { name: "Rekening wijzigen" })).toBeInTheDocument();
  });

  it("RPC ontbreekt (PGRST202): geen knop", async () => {
    probeError = { code: "PGRST202", message: "Could not find the function public.reclassify_bank_transaction" };
    renderAction();
    await waitFor(() => expect(probeCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Rekening wijzigen" })).toBeNull();
  });

  it("controle faalt (onbekend): geen knop — fail closed", async () => {
    probeError = { code: "PGRST301", message: "JWT expired" };
    renderAction();
    await waitFor(() => expect(probeCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Rekening wijzigen" })).toBeNull();
  });

  it("zonder accountantrol wordt de functie niet eens geprobeerd", async () => {
    rpcSpy.mockImplementation(async (name: string) =>
      name === "has_min_role" ? { data: false, error: null } : { data: null, error: probeError },
    );
    renderAction();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledWith("has_min_role", expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(probeCalls()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Rekening wijzigen" })).toBeNull();
  });
});
