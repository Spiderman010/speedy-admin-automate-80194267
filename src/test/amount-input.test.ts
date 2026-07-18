import { describe, it, expect } from "vitest";
import { parseAmountInput, parseAmountInputOrZero, formatAmountInput } from "@/lib/amount-input";

describe("amount-input helpers", () => {
  it("parseAmountInput returns null for empty / invalid", () => {
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("   ")).toBeNull();
    expect(parseAmountInput(",")).toBeNull();
    expect(parseAmountInput("-")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
    expect(parseAmountInput(null)).toBeNull();
    expect(parseAmountInput(undefined)).toBeNull();
  });

  it("parseAmountInput accepts comma and dot decimals", () => {
    expect(parseAmountInput("12,50")).toBe(12.5);
    expect(parseAmountInput("12.50")).toBe(12.5);
    expect(parseAmountInput("  12,50  ")).toBe(12.5);
    expect(parseAmountInput("1000")).toBe(1000);
    expect(parseAmountInput("-3,25")).toBe(-3.25);
  });

  it("parseAmountInputOrZero substitutes 0 for empty/invalid", () => {
    expect(parseAmountInputOrZero("")).toBe(0);
    expect(parseAmountInputOrZero("abc")).toBe(0);
    expect(parseAmountInputOrZero("12,5")).toBe(12.5);
  });

  it("formatAmountInput returns empty string for nil/NaN (never '0')", () => {
    expect(formatAmountInput(null)).toBe("");
    expect(formatAmountInput(undefined)).toBe("");
    expect(formatAmountInput(Number.NaN)).toBe("");
  });

  it("formatAmountInput renders NL-style with 2 decimals", () => {
    expect(formatAmountInput(0)).toBe("0,00");
    expect(formatAmountInput(12.5)).toBe("12,50");
    expect(formatAmountInput(1234.5)).toBe("1234,50"); // no grouping in input
  });

  it("round-trip: type comma-value, blur formats, re-parse matches", () => {
    const typed = "12,50";
    const parsed = parseAmountInput(typed);
    expect(parsed).toBe(12.5);
    const formatted = formatAmountInput(parsed!);
    expect(formatted).toBe("12,50");
    expect(parseAmountInput(formatted)).toBe(12.5);
  });
});
