import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("purchase invoice batch intake", () => {
  it("shows unsupported files as rejected even when valid files are processed", () => {
    const source = readFileSync("src/pages/Facturen.tsx", "utf8");
    const filter = source.indexOf("const rejectedFiles = files.filter(");
    const progress = source.indexOf("setUploadProgress(rejectedFiles.map(", filter);
    const processing = source.indexOf("for (const file of validFiles)", progress);
    expect(filter).toBeGreaterThan(-1);
    expect(progress).toBeGreaterThan(filter);
    expect(processing).toBeGreaterThan(progress);
    expect(source.slice(progress, processing)).toContain("bestandstype niet ondersteund");
    expect(source).toContain("PDF, JPG, PNG, WebP of UBL/XML");
  });
});
