import { describe, it, expect } from "vitest";
import { computeClientReadiness } from "@/lib/client-readiness";
import type { Tables } from "@/integrations/supabase/types";
import type { GrootboekSlim } from "@/lib/client-readiness";

type Client = Tables<"clients">;
type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type Vraagpost = Tables<"vraagposten">;

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "c-1",
    name: "Test Klant",
    bank_dagboek: 100,
    inkoop_dagboek: 20,
    verkoop_dagboek: 70,
    ...overrides,
  } as Client;
}

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "tx-1",
    client_id: "c-1",
    match_status: "gematcht",
    grootboekrekening_id: null,
    amount: -100,
    user_id: "u-1",
    transaction_date: "2024-01-15",
    ...overrides,
  } as BankTransaction;
}

function makeInvoice(overrides: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: "inv-1",
    client_id: "c-1",
    status: "te_controleren",
    user_id: "u-1",
    supplier: "Test BV",
    ...overrides,
  } as PurchaseInvoice;
}

function makeSales(overrides: Partial<SalesInvoice> = {}): SalesInvoice {
  return {
    id: "si-1",
    client_id: "c-1",
    status: "concept",
    user_id: "u-1",
    customer_name: "Klant X",
    invoice_number: "V1",
    invoice_date: "2024-01-01",
    ...overrides,
  } as SalesInvoice;
}

function makeVraagpost(overrides: Partial<Vraagpost> = {}): Vraagpost {
  return {
    id: "vp-1",
    client_id: "c-1",
    status: "open",
    user_id: "u-1",
    categorie: "overig",
    source_type: "handmatig",
    titel: "Test vraag",
    ...overrides,
  } as Vraagpost;
}

const gb4400: GrootboekSlim = { id: "gb-4400", nummer: 4400, omschrijving: "Kosten", client_id: "c-1" };
const gb1799: GrootboekSlim = { id: "gb-1799", nummer: 1799, omschrijving: "Onbekend", client_id: null };
const allAccounts: GrootboekSlim[] = [gb4400, gb1799];

describe("computeClientReadiness", () => {
  it("client with zero blockers is klaar", () => {
    const client = makeClient();
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.status).toBe("klaar");
    expect(r.bankGeblokkeerd).toBe(0);
  });

  it("suggestie transaction counts as bank blocker", () => {
    const client = makeClient();
    const tx = makeTx({ match_status: "suggestie" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.bankGeblokkeerd).toBe(1);
    expect(r.status).toBe("niet_klaar");
  });

  it("niet_gematcht counts as bank blocker", () => {
    const client = makeClient();
    const tx = makeTx({ match_status: "niet_gematcht" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.bankGeblokkeerd).toBe(1);
    expect(r.status).toBe("niet_klaar");
  });

  it("handmatig_geboekt without ledger counts as bank blocker", () => {
    const client = makeClient();
    const tx = makeTx({ match_status: "handmatig_geboekt", grootboekrekening_id: null });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.bankGeblokkeerd).toBe(1);
    expect(r.status).toBe("niet_klaar");
  });

  it("handmatig_geboekt with valid ledger does not block", () => {
    const client = makeClient();
    const tx = makeTx({ match_status: "handmatig_geboekt", grootboekrekening_id: "gb-4400" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.bankGeblokkeerd).toBe(0);
  });

  it("missing bank_dagboek gives config_ontbreekt", () => {
    const client = makeClient({ bank_dagboek: null });
    const r = computeClientReadiness(client, [], [], [], [], allAccounts);
    expect(r.configMissingBankDagboek).toBe(true);
    expect(r.status).toBe("config_ontbreekt");
  });

  it("missing inkoop_dagboek gives config_ontbreekt", () => {
    const client = makeClient({ inkoop_dagboek: null });
    const r = computeClientReadiness(client, [], [], [], [], allAccounts);
    expect(r.configMissingInkoopDagboek).toBe(true);
    expect(r.status).toBe("config_ontbreekt");
  });

  it("missing verkoop_dagboek gives config_ontbreekt", () => {
    const client = makeClient({ verkoop_dagboek: null });
    const r = computeClientReadiness(client, [], [], [], [], allAccounts);
    expect(r.configMissingVerkoopDagboek).toBe(true);
    expect(r.status).toBe("config_ontbreekt");
  });

  it("config_ontbreekt takes precedence over niet_klaar when both apply", () => {
    const client = makeClient({ bank_dagboek: null });
    const tx = makeTx({ match_status: "suggestie" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.status).toBe("config_ontbreekt");
    expect(r.bankGeblokkeerd).toBe(1);
  });

  it("purchase invoice te_controleren is counted as inkoop blocker", () => {
    const client = makeClient();
    const inv = makeInvoice({ status: "te_controleren" });
    const r = computeClientReadiness(client, [], [inv], [], [], allAccounts);
    expect(r.inkoopTeControleren).toBe(1);
    expect(r.status).toBe("niet_klaar");
  });

  it("open vraagpost is counted as blocker", () => {
    const client = makeClient();
    const vp = makeVraagpost({ status: "open" });
    const r = computeClientReadiness(client, [], [], [], [vp], allAccounts);
    expect(r.openVraagposten).toBe(1);
    expect(r.status).toBe("niet_klaar");
  });

  it("opgelost vraagpost is not counted", () => {
    const client = makeClient();
    const vp = makeVraagpost({ status: "opgelost" });
    const r = computeClientReadiness(client, [], [], [], [vp], allAccounts);
    expect(r.openVraagposten).toBe(0);
    expect(r.status).toBe("klaar");
  });

  it("genegeerd vraagpost is not counted", () => {
    const client = makeClient();
    const vp = makeVraagpost({ status: "genegeerd" });
    const r = computeClientReadiness(client, [], [], [], [vp], allAccounts);
    expect(r.openVraagposten).toBe(0);
  });

  it("transactions belonging to other client are ignored", () => {
    const client = makeClient({ id: "c-1" });
    const tx = makeTx({ client_id: "c-other", match_status: "suggestie" });
    const r = computeClientReadiness(client, [tx], [], [], [], allAccounts);
    expect(r.bankGeblokkeerd).toBe(0);
    expect(r.status).toBe("klaar");
  });

  it("sales invoice concept is counted as verkoopConcept (informational only)", () => {
    const client = makeClient();
    const si = makeSales({ status: "concept" });
    const r = computeClientReadiness(client, [], [], [si], [], allAccounts);
    expect(r.verkoopConcept).toBe(1);
    expect(r.status).toBe("klaar");
  });

  it("missing 1799 is flagged but does not change status alone", () => {
    const client = makeClient();
    const r = computeClientReadiness(client, [], [], [], [], [gb4400]);
    expect(r.configMissing1799).toBe(true);
    expect(r.status).toBe("klaar");
  });

  it("1799 with null client_id is shared and found for any client", () => {
    const client = makeClient({ id: "c-other" });
    const r = computeClientReadiness(client, [], [], [], [], [gb4400, gb1799]);
    expect(r.configMissing1799).toBe(false);
  });
});
