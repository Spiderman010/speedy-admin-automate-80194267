// Gedragstests van de ECHTE edge-function-handlers process-invoice en
// process-sales-invoice (supabase/functions/*/index.ts), uitgevoerd via
// ./support/edge-function-harness.ts: geen Deno, geen netwerk, nep-Supabase-
// client en nep-AI-gateway. Nulmeting: A2-06/B2-01 (rolcheck vóór elke
// schrijfactie), A2-01/B2-04 (saldo), A2-11 (verkoop verzint niets), B2-05.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import {
  DEFAULT_ENV, fakeFile, fakeMultipartRequest, loadEdgeHandler, newRecorded, pdfBytes,
  type FakeWorld, type Role,
} from "./support/edge-function-harness";
import { INTAKE_FORBIDDEN_MESSAGE, INTAKE_ROLE_CHECK_FAILED_MESSAGE } from "../../supabase/functions/process-invoice/intake-guards";
import { SALES_INCOMPLETE_MESSAGE } from "../../supabase/functions/process-sales-invoice/intake-guards";

const ORG_A = "00000000-0000-4000-8000-00000000a001";
const ORG_B = "00000000-0000-4000-8000-00000000a002";
const CLIENT_A = "00000000-0000-4000-8000-00000000c001";
const USER = { id: "00000000-0000-4000-8000-0000000000e9", email: "medewerker@kantoor.test" };

const PURCHASE_OCR = {
  supplier: "Leverancier BV", invoice_number: "F-1", invoice_date: "2026-10-01",
  amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21,
};
const SALES_OCR = {
  customer_name: "Afnemer BV", invoice_number: "V-1", invoice_date: "2026-10-01",
  amount_excl: 1000, btw_amount: 210, amount_incl: 1210, btw_percentage: 21,
};

function world(role: Role | null, partial: Partial<FakeWorld> = {}): FakeWorld {
  return {
    user: USER,
    visibleClient: { id: CLIENT_A, organization_id: ORG_A },
    roles: role ? { [ORG_A]: role } : {},
    memberships: [ORG_A],
    ai: { status: 200, toolArgs: PURCHASE_OCR },
    ...partial,
  };
}

const pdfUpload = () => fakeMultipartRequest({ file: fakeFile("factuur.pdf", "application/pdf", pdfBytes()), client_id: CLIENT_A });

async function call(fn: "process-invoice" | "process-sales-invoice", w: FakeWorld, req = pdfUpload()) {
  const rec = newRecorded();
  const res = await loadEdgeHandler(fn, w, rec)(req);
  return { rec, status: res.status, body: await res.json() };
}

describe("process-invoice: rolcheck vóór elke schrijfactie (A2-06/B2-01)", () => {
  it("read_only krijgt 403 met een neutrale melding; geen upload, geen insert, geen AI-aanroep", async () => {
    const { rec, status, body } = await call("process-invoice", world("read_only"));
    expect(status).toBe(403);
    expect(body).toEqual({ error: INTAKE_FORBIDDEN_MESSAGE });
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
    expect(rec.aiCalls).toEqual([]);
  });

  it("de rol wordt getoetst in de organisatie van de opgeslagen klantrij, via de gebruikersclient (vóór de schrijfacties en opnieuw vóór de insert)", async () => {
    const { rec } = await call("process-invoice", world("assistant"));
    const check = { service: false, fn: "has_min_role", args: { _user_id: USER.id, _organization_id: ORG_A, _min: "assistant" } };
    expect(rec.rpcs).toEqual([check, check]);
  });

  it("H-03: wie zijn rol verliest terwijl de AI-aanroep loopt, krijgt 403 en er wordt niets ingevoegd", async () => {
    const { status, body, rec } = await call("process-invoice", world("assistant", { roleLostAfterChecks: 1 }));
    expect(status).toBe(403);
    expect(body).toEqual({ error: INTAKE_FORBIDDEN_MESSAGE });
    expect(rec.aiCalls).toHaveLength(1);
    expect(rec.inserts).toEqual([]);
  });

  it("Codex-2: het al geüploade bestand wordt met de service role verwijderd vóór de weigering (geen weesbestand)", async () => {
    const { status, rec } = await call("process-invoice", world("assistant", { roleLostAfterChecks: 1 }));
    expect(status).toBe(403);
    expect(rec.uploads).toHaveLength(1);
    expect(rec.removes).toEqual([{ service: true, bucket: "invoices", paths: [rec.uploads[0].path] }]);
  });

  it("bij een geslaagde intake wordt niets verwijderd", async () => {
    const { status, rec } = await call("process-invoice", world("assistant"));
    expect(status).toBe(200);
    expect(rec.removes).toEqual([]);
  });

  it("assistant in een ándere organisatie dan die van de klant telt niet", async () => {
    const { status, rec } = await call("process-invoice", world(null, { roles: { [ORG_B]: "owner" }, memberships: [ORG_A, ORG_B] }));
    expect(status).toBe(403);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });

  it("een ex-lid (rol nog in user_roles, lidmaatschap weg) wordt geweigerd", async () => {
    const { status, rec } = await call("process-invoice", world("assistant", { memberships: [] }));
    expect(status).toBe(403);
    expect(rec.uploads).toEqual([]);
  });

  it("kan de rol niet worden vastgesteld, dan 500 en niets opgeslagen (fail-closed)", async () => {
    for (const rpcFailure of ["error", "throw"] as const) {
      const { status, body, rec } = await call("process-invoice", world("owner", { rpcFailure }));
      expect(status).toBe(500);
      expect(body).toEqual({ error: INTAKE_ROLE_CHECK_FAILED_MESSAGE });
      expect(rec.uploads).toEqual([]);
      expect(rec.inserts).toEqual([]);
    }
  });

  it("een niet-zichtbare klant geeft dezelfde neutrale 403, zonder rolquery", async () => {
    const { status, body, rec } = await call("process-invoice", world("owner", { visibleClient: null }));
    expect(status).toBe(403);
    expect(body).toEqual({ error: INTAKE_FORBIDDEN_MESSAGE });
    expect(rec.rpcs).toEqual([]);
    expect(rec.uploads).toEqual([]);
  });

  it("ook een UBL-bestand van een read_only-lid wordt geweigerd vóór parsen en opslaan", async () => {
    const xml = fakeFile("f.xml", "application/xml", new TextEncoder().encode("<Invoice/>"));
    const { status, rec } = await call("process-invoice", world("read_only"), fakeMultipartRequest({ file: xml, client_id: CLIENT_A }));
    expect(status).toBe(403);
    expect(rec.uploads).toEqual([]);
  });

  it.each(["assistant", "accountant", "owner"] as const)("%s mag uploaden: upload + insert via de service role", async (role) => {
    const { status, rec } = await call("process-invoice", world(role));
    expect(status).toBe(200);
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0]).toMatchObject({ service: true, bucket: "invoices", path: `${USER.id}/${CLIENT_A}/00000000-0000-4000-8000-000000000001.pdf` });
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]).toMatchObject({ service: true, table: "purchase_invoices" });
  });
});

describe("process-invoice: insert-payload (A2-01/B2-04/B2-05)", () => {
  it("alleen een leverancier herkend ⇒ amount_incl en remaining_amount NULL (was: saldo 0 ⇒ 'Betaald')", async () => {
    const { rec } = await call("process-invoice", world("assistant", { ai: { status: 200, toolArgs: { supplier: "Leverancier X BV" } } }));
    expect(rec.inserts[0].row).toMatchObject({
      supplier: "Leverancier X BV", amount_incl: null, remaining_amount: null, status: "te_controleren",
      organization_id: ORG_A, client_id: CLIENT_A, user_id: USER.id,
    });
  });

  it("geen tool call van de AI ⇒ 'Onbekend', alles NULL, saldo NULL", async () => {
    const { rec } = await call("process-invoice", world("assistant", { ai: { status: 200, toolArgs: null } }));
    expect(rec.inserts[0].row).toMatchObject({ supplier: "Onbekend", amount_incl: null, remaining_amount: null });
  });

  it("0 % btw blijft 0 en saldo = incl.", async () => {
    const { rec } = await call("process-invoice", world("assistant", {
      ai: { status: 200, toolArgs: { supplier: "X", amount_excl: 500, btw_amount: 0, amount_incl: 500, btw_percentage: 0, invoice_date: "2026-10-01" } },
    }));
    expect(rec.inserts[0].row).toMatchObject({ btw_amount: 0, btw_percentage: 0, remaining_amount: 500 });
    expect((rec.inserts[0].row.ocr_data as any).validation).toEqual({ ok: true, issues: [] });
  });

  it("inconsistente totalen en een ongeldige datum ⇒ saldo NULL, datum NULL, bevindingen in ocr_data.validation", async () => {
    const { status, rec } = await call("process-invoice", world("assistant", {
      ai: { status: 200, toolArgs: { supplier: "X", amount_excl: 100, btw_amount: 21, amount_incl: 5000, invoice_date: "2026-02-31" } },
    }));
    expect(status).toBe(200);
    const row = rec.inserts[0].row as any;
    expect(row).toMatchObject({ amount_incl: 5000, remaining_amount: null, invoice_date: null, status: "te_controleren" });
    expect(row.ocr_data.validation.ok).toBe(false);
    expect(row.ocr_data.validation.issues.map((i: any) => i.code)).toEqual(["totalen_kloppen_niet", "datum_ongeldig"]);
  });

  it("de UBL-route krijgt dezelfde validatie (consistente UBL: saldo = te betalen bedrag)", async () => {
    const ublParsed = {
      Invoice: {
        ID: "000123", IssueDate: "2026-10-20",
        AccountingSupplierParty: { Party: { PartyName: { Name: "Leverancier BV" } } },
        InvoiceLine: [{ Item: { Name: "Onderhoud", ClassifiedTaxCategory: { Percent: "21" } }, LineExtensionAmount: "100.00" }],
        LegalMonetaryTotal: { TaxExclusiveAmount: "100.00", PayableAmount: "121.00" },
        TaxTotal: { TaxAmount: "21.00" },
      },
    };
    const xml = fakeFile("f.xml", "application/xml", new TextEncoder().encode("<Invoice/>"));
    const { status, rec } = await call("process-invoice", world("assistant", { ublParsed }), fakeMultipartRequest({ file: xml, client_id: CLIENT_A }));
    expect(status).toBe(200);
    expect(rec.aiCalls).toEqual([]);
    expect(rec.inserts[0].row).toMatchObject({ invoice_number: "000123", amount_incl: 121, remaining_amount: 121, btw_percentage: 21 });
    expect((rec.inserts[0].row.ocr_data as any).validation.ok).toBe(true);
  });
});

describe("process-sales-invoice: rolvloer SALES_WRITE_MIN_ROLE = owner (D2 open)", () => {
  it.each(["read_only", "assistant", "accountant"] as const)("%s krijgt 403; geen AI-aanroep, geen upload, geen insert", async (role) => {
    const { status, body, rec } = await call("process-sales-invoice", world(role, { ai: { status: 200, toolArgs: SALES_OCR } }));
    expect(status).toBe(403);
    expect(body).toEqual({ error: INTAKE_FORBIDDEN_MESSAGE });
    expect(rec.aiCalls).toEqual([]);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });

  it("de handler vraagt has_min_role met _min = 'owner' in de organisatie van de klantrij (vóór de AI en opnieuw vóór de upload)", async () => {
    const { rec } = await call("process-sales-invoice", world("owner", { ai: { status: 200, toolArgs: SALES_OCR } }));
    const check = { service: false, fn: "has_min_role", args: { _user_id: USER.id, _organization_id: ORG_A, _min: "owner" } };
    expect(rec.rpcs).toEqual([check, check]);
  });

  it("H-03: wie zijn rol verliest terwijl de AI-aanroep loopt, krijgt 403; geen upload en geen insert", async () => {
    const { status, body, rec } = await call("process-sales-invoice", world("owner", { roleLostAfterChecks: 1, ai: { status: 200, toolArgs: SALES_OCR } }));
    expect(status).toBe(403);
    expect(body).toEqual({ error: INTAKE_FORBIDDEN_MESSAGE });
    expect(rec.aiCalls).toHaveLength(1);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });

  it("H-04: werkt ook als alleen SUPABASE_PUBLISHABLE_KEY is gezet (alias van SUPABASE_ANON_KEY)", async () => {
    const { SUPABASE_ANON_KEY: anon, ...rest } = DEFAULT_ENV;
    const rec = newRecorded();
    const res = await loadEdgeHandler("process-sales-invoice", world("owner", { ai: { status: 200, toolArgs: SALES_OCR } }), rec, {
      ...rest, SUPABASE_PUBLISHABLE_KEY: anon,
    })(pdfUpload());
    expect(res.status).toBe(200);
    expect(rec.inserts).toHaveLength(1);
    const missing = newRecorded();
    const none = await loadEdgeHandler("process-sales-invoice", world("owner"), missing, rest)(pdfUpload());
    expect(none.status).toBe(500);
    expect(missing.uploads).toEqual([]);
  });

  it("owner: upload en insert via de service role, status concept, saldo = incl.", async () => {
    const { status, rec } = await call("process-sales-invoice", world("owner", { ai: { status: 200, toolArgs: SALES_OCR } }));
    expect(status).toBe(200);
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0]).toMatchObject({ service: true, bucket: "invoices", path: `${USER.id}/sales/${CLIENT_A}/00000000-0000-4000-8000-000000000001.pdf` });
    expect(rec.inserts[0]).toMatchObject({ service: true, table: "sales_invoices" });
    expect(rec.inserts[0].row).toMatchObject({ invoice_number: "V-1", invoice_date: "2026-10-01", remaining_amount: 1210, status: "concept" });
  });

  it("kan de rol niet worden vastgesteld, dan 500 en niets opgeslagen", async () => {
    const { status, rec } = await call("process-sales-invoice", world("owner", { rpcFailure: "error", ai: { status: 200, toolArgs: SALES_OCR } }));
    expect(status).toBe(500);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });
});

describe("process-sales-invoice: geen verzonnen waarden (A2-11) en geen 'Betaald' zonder bedrag (A2-01)", () => {
  it.each([
    ["alleen een klantnaam", { customer_name: "Klant Q" }],
    ["geen factuurnummer", { ...SALES_OCR, invoice_number: undefined }],
    ["ongeldige factuurdatum", { ...SALES_OCR, invoice_date: "2026-02-31" }],
    ["geen tool call", null],
  ])("%s ⇒ 422, niets opgeslagen (ook geen bestand), geen VF-nummer en geen datum van vandaag", async (_label, toolArgs) => {
    const { status, body, rec } = await call("process-sales-invoice", world("owner", { ai: { status: 200, toolArgs } }));
    expect(status).toBe(422);
    expect(body.error).toBe(SALES_INCOMPLETE_MESSAGE);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/VF-\d/);
  });

  it("geen bedrag herkend ⇒ saldo NULL in plaats van 0", async () => {
    const { status, rec } = await call("process-sales-invoice", world("owner", {
      ai: { status: 200, toolArgs: { customer_name: "Klant Q", invoice_number: "V-9", invoice_date: "2026-10-01" } },
    }));
    expect(status).toBe(200);
    expect(rec.inserts[0].row).toMatchObject({ amount_incl: null, remaining_amount: null });
  });

  it("inconsistente bedragen ⇒ opgeslagen als concept met saldo NULL en een zichtbare notitie", async () => {
    const { rec } = await call("process-sales-invoice", world("owner", {
      ai: { status: 200, toolArgs: { ...SALES_OCR, amount_incl: 5000 } },
    }));
    const row = rec.inserts[0].row as any;
    expect(row).toMatchObject({ amount_incl: 5000, remaining_amount: null, status: "concept" });
    expect(row.notes).toMatch(/^Automatische controle bij het inlezen:/);
  });

  it("0 % btw blijft 0 (geen NULL)", async () => {
    const { rec } = await call("process-sales-invoice", world("owner", {
      ai: { status: 200, toolArgs: { ...SALES_OCR, amount_excl: 500, btw_amount: 0, amount_incl: 500, btw_percentage: 0 } },
    }));
    expect(rec.inserts[0].row).toMatchObject({ btw_amount: 0, btw_percentage: 0, remaining_amount: 500 });
  });

  it("faalt de AI-gateway, dan blijft er geen weesbestand achter (upload pas na de extractie)", async () => {
    const { status, rec } = await call("process-sales-invoice", world("owner", { ai: { status: 402 } }));
    expect(status).toBe(402);
    expect(rec.uploads).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });
});
