import { describe, expect, it } from "vitest";
import {
  formatLedgerLabel,
  parseLegacyAccountNumber,
  suggestLedgerAccountFromLegacyText,
  type LedgerAccountCandidate,
} from "@/lib/legacy-ledger-suggestion";

/**
 * De enige toegestane afleiding van legacy-tekst naar een rekening: een exact
 * rekeningnummer met precies één boekbare kandidaat. Alles daarbuiten geeft
 * geen suggestie — een verkeerde rekening is erger dan geen rekening.
 */

const acc = (over: Partial<LedgerAccountCandidate> = {}): LedgerAccountCandidate => ({
  id: "gb-4602", nummer: 4602, omschrijving: "Telefoonkosten", client_id: null, ...over,
});

const TELEFOON = acc();
const KANTOOR = acc({ id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten" });

describe("parseLegacyAccountNumber", () => {
  it("1. leest het nummer vooraan, in de vorm die de app zelf schrijft", () => {
    expect(parseLegacyAccountNumber("4602 - Telefoonkosten")).toBe(4602);
    expect(parseLegacyAccountNumber("  4602 - Telefoonkosten")).toBe(4602);
    expect(parseLegacyAccountNumber("4602")).toBe(4602);
    expect(parseLegacyAccountNumber("4602: Telefoon")).toBe(4602);
  });

  it("2. tekst zonder nummer vooraan levert niets op", () => {
    expect(parseLegacyAccountNumber("Telefoonkosten")).toBeNull();
    expect(parseLegacyAccountNumber("Telefoon 4602")).toBeNull();
    expect(parseLegacyAccountNumber("")).toBeNull();
    expect(parseLegacyAccountNumber(null)).toBeNull();
    expect(parseLegacyAccountNumber(undefined)).toBeNull();
  });

  it("3. een ánder nummer is een ander nummer — geen prefix-matching", () => {
    // "46021" mag nooit als 4602 gelden.
    expect(parseLegacyAccountNumber("46021 - Iets")).toBe(46021);
  });
});

describe("suggestLedgerAccountFromLegacyText", () => {
  it("4. precies één treffer geeft een suggestie, mét het echte id", () => {
    const uitkomst = suggestLedgerAccountFromLegacyText("4602 - Telefoonkosten", [TELEFOON, KANTOOR], "client-1");
    expect(uitkomst.kind).toBe("uniek");
    if (uitkomst.kind !== "uniek") return;
    expect(uitkomst.account.id).toBe("gb-4602");
    expect(uitkomst.label).toBe("4602 - Telefoonkosten");
  });

  it("5. de omschrijving in de tekst doet er niet toe; het nummer beslist", () => {
    // Zelfde nummer, andere tekst erachter: de rekening in de administratie is
    // gezaghebbend, en de suggestie draagt háár label — niet de oude tekst.
    const uitkomst = suggestLedgerAccountFromLegacyText("4602 - Telefoon oud", [TELEFOON], "client-1");
    expect(uitkomst.kind).toBe("uniek");
    if (uitkomst.kind !== "uniek") return;
    expect(uitkomst.label).toBe("4602 - Telefoonkosten");
  });

  it("6. geen enkele treffer geeft geen suggestie", () => {
    expect(suggestLedgerAccountFromLegacyText("9999 - Onbekend", [TELEFOON, KANTOOR], "client-1"))
      .toEqual({ kind: "geen", reason: "geen_match" });
  });

  it("7. meerdere treffers geven geen suggestie", () => {
    // Zelfde nummer, twee rekeningen die beide boekbaar zijn: niet eenduidig.
    const dubbel = [TELEFOON, acc({ id: "gb-dup", nummer: 4602, omschrijving: "Telefoon klant", client_id: "client-1" })];
    expect(suggestLedgerAccountFromLegacyText("4602 - Telefoonkosten", dubbel, "client-1"))
      .toEqual({ kind: "geen", reason: "meerdere_matches" });
  });

  it("8. tekst zonder nummer geeft geen suggestie — geen matching op omschrijving", () => {
    expect(suggestLedgerAccountFromLegacyText("Telefoonkosten", [TELEFOON], "client-1"))
      .toEqual({ kind: "geen", reason: "geen_nummer" });
  });

  it("9. lege tekst geeft geen suggestie", () => {
    expect(suggestLedgerAccountFromLegacyText("", [TELEFOON], "client-1")).toEqual({ kind: "geen", reason: "geen_tekst" });
    expect(suggestLedgerAccountFromLegacyText(null, [TELEFOON], "client-1")).toEqual({ kind: "geen", reason: "geen_tekst" });
    expect(suggestLedgerAccountFromLegacyText("   ", [TELEFOON], "client-1")).toEqual({ kind: "geen", reason: "geen_tekst" });
  });

  it("10. rekeningen van een ándere administratie tellen niet mee", () => {
    const vreemd = acc({ id: "gb-vreemd", nummer: 4602, client_id: "client-2" });
    expect(suggestLedgerAccountFromLegacyText("4602 - Telefoonkosten", [vreemd], "client-1"))
      .toEqual({ kind: "geen", reason: "geen_match" });
    // Diezelfde rekening is voor haar eigen administratie wél eenduidig.
    expect(suggestLedgerAccountFromLegacyText("4602 - Telefoonkosten", [vreemd], "client-2").kind).toBe("uniek");
  });

  it("11. een organisatiebrede rekening telt voor elke administratie", () => {
    expect(suggestLedgerAccountFromLegacyText("4602 - x", [TELEFOON], "client-9").kind).toBe("uniek");
  });

  it("12. het label heeft exact de vorm van de rekeningkiezer", () => {
    expect(formatLedgerLabel(4602, "Telefoonkosten")).toBe("4602 - Telefoonkosten");
  });

  it("13. er wordt nergens geraden: geen enkele niet-exacte invoer levert een id op", () => {
    const geenSuggestie = [
      "Telefoonkosten", "telefoon", "46", "460", "46021 - Telefoonkosten",
      "rekening 4602", "-4602", "",
    ];
    for (const tekst of geenSuggestie) {
      expect(suggestLedgerAccountFromLegacyText(tekst, [TELEFOON], "client-1").kind, tekst).toBe("geen");
    }
  });
});
