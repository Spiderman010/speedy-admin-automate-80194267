import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UBL invoice upload integration", () => {
  const server = readFileSync("supabase/functions/process-invoice/index.ts", "utf8");
  const parser = readFileSync("supabase/functions/process-invoice/ubl-parse.ts", "utf8");
  const ui = readFileSync("src/pages/Facturen.tsx", "utf8");

  it("validates XML before writing to invoice storage", () => {
    const parsed = server.indexOf("ublExtracted = parseUblXml(");
    const stored = server.indexOf('.from("invoices")');
    expect(parsed).toBeGreaterThan(-1);
    expect(stored).toBeGreaterThan(parsed);
    expect(server).toContain("if (fileBuffer.byteLength > UBL_MAX_BYTES)");
  });
  it("never calls AI OCR for valid UBL", () => {
    const direct = server.indexOf("if (ublExtracted)");
    const ai = server.indexOf('await fetch("https://ai.gateway.lovable.dev/', direct);
    const end = server.indexOf("// Normalize Dutch VAT number", ai);
    expect(direct).toBeGreaterThan(-1);
    expect(ai).toBeGreaterThan(direct);
    expect(server.slice(ai, end)).toContain("    }\n\n");
    expect(server).toContain("extracted = ublExtracted;");
  });
  it("rejects DTDs and entity declarations and limits XML size", () => {
    expect(parser).toContain("XMLValidator.validate(xml)");
    expect(parser).toContain("processEntities: false");
    expect(parser).toContain("DOCTYPE|ENTITY");
    expect(parser).toContain("UBL_MAX_BYTES");
  });
  it("makes XML and UBL available in the file picker and MIME check", () => {
    expect(ui).toContain('accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.ubl"');
    expect(ui).toContain('"application/xml", "text/xml"');
  });
});
