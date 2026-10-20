import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("server purchase invoice upload MIME guard", () => {
  it("rejects unsupported types before file storage and OCR", () => {
    const source = readFileSync("supabase/functions/process-invoice/index.ts", "utf8");
    const guard = source.indexOf("if (!supportedMimeTypes.has(file.type))");
    const storage = source.indexOf('.from("invoices")');
    const ocr = source.indexOf("// Convert file to base64 for AI vision");
    expect(guard).toBeGreaterThan(-1);
    expect(storage).toBeGreaterThan(guard);
    expect(ocr).toBeGreaterThan(storage);
    for (const mime of ["application/pdf", "image/jpeg", "image/png", "image/webp"]) {
      expect(source).toContain(mime);
    }
    expect(source).toContain("const mimeType = file.type;");
  });
});
