import { describe, it, expect } from "vitest";
import { deriveFromExcl, deriveFromIncl, round2 } from "@/lib/btw-calc";

describe("btw-calc", () => {
  describe("deriveFromExcl (excl + pct → btw + incl)", () => {
    it("21% standaardgeval", () => {
      expect(deriveFromExcl(100, 21)).toEqual({ btw: 21, incl: 121 });
    });
    it("9% laag tarief", () => {
      expect(deriveFromExcl(50, 9)).toEqual({ btw: 4.5, incl: 54.5 });
    });
    it("0% (vrijgesteld/verlegd)", () => {
      expect(deriveFromExcl(123.45, 0)).toEqual({ btw: 0, incl: 123.45 });
    });
    it("afronding half-up op 2 decimalen bij 21%", () => {
      // 33.33 * 0.21 = 6.9993 → 7.00; incl = 40.33
      expect(deriveFromExcl(33.33, 21)).toEqual({ btw: 7, incl: 40.33 });
    });
    it("afronding bij 9% (tricky)", () => {
      // 12.34 * 0.09 = 1.1106 → 1.11; incl = 13.45
      expect(deriveFromExcl(12.34, 9)).toEqual({ btw: 1.11, incl: 13.45 });
    });
  });

  describe("deriveFromIncl (incl + pct → excl + btw)", () => {
    it("21% standaardgeval", () => {
      expect(deriveFromIncl(121, 21)).toEqual({ excl: 100, btw: 21 });
    });
    it("9% laag tarief", () => {
      expect(deriveFromIncl(54.5, 9)).toEqual({ excl: 50, btw: 4.5 });
    });
    it("0%", () => {
      expect(deriveFromIncl(99.99, 0)).toEqual({ excl: 99.99, btw: 0 });
    });
    it("afronding: incl 100 bij 21% → excl 82.64, btw 17.36 (sluit terug)", () => {
      const { excl, btw } = deriveFromIncl(100, 21);
      expect(excl).toBe(82.64);
      expect(btw).toBe(17.36);
      expect(round2(excl + btw)).toBe(100); // sluit exact
    });
    it("afronding: incl 10 bij 9% sluit terug", () => {
      const { excl, btw } = deriveFromIncl(10, 9);
      expect(round2(excl + btw)).toBe(10);
    });
  });

  describe("wisselen van BTW% blijft consistent", () => {
    it("excl vast, wissel 21 → 9 → 0 herberekent btw/incl", () => {
      const excl = 200;
      expect(deriveFromExcl(excl, 21)).toEqual({ btw: 42, incl: 242 });
      expect(deriveFromExcl(excl, 9)).toEqual({ btw: 18, incl: 218 });
      expect(deriveFromExcl(excl, 0)).toEqual({ btw: 0, incl: 200 });
    });
    it("incl vast, wissel BTW% herberekent excl", () => {
      const incl = 121;
      expect(deriveFromIncl(incl, 21).excl).toBe(100);
      expect(deriveFromIncl(incl, 9).excl).toBe(111.01); // 121/1.09 = 111.0091
      expect(deriveFromIncl(incl, 0).excl).toBe(121);
    });
  });

  describe("round-trip stabiliteit", () => {
    it("excl → incl → excl blijft binnen 1 cent bij 21%", () => {
      for (const excl of [1, 9.99, 33.33, 100, 1234.56]) {
        const { incl } = deriveFromExcl(excl, 21);
        const back = deriveFromIncl(incl, 21).excl;
        expect(Math.abs(back - excl)).toBeLessThanOrEqual(0.01);
      }
    });
  });
});
