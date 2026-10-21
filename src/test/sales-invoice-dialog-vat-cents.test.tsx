import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({}) } }));

import { SalesInvoiceDialog, type SalesInvoiceFormData } from "@/components/SalesInvoiceDialog";
import { deriveFromExcl, formatCents, toCents, vatAmountsFromExclText, btwCentsFromExclCents } from "@/lib/btw-calc";

/**
 * A3-10 — btw in de verkoopdialoog in hele centen, half-up.
 *
 * DE SERVERCONTROLE, LETTERLIJK NAGEBOUWD
 * `post_sales_invoice()` (20261002120000, ongewijzigd door P4 op dit punt):
 *   v_btw := COALESCE(btw_amount, 0);
 *   IF amount_excl + v_btw <> amount_incl THEN RAISE … (23514)
 * met amount_excl, btw_amount en amount_incl in numeric(12,2). De dialoog levert
 * tekst; Verkoop.tsx doet parseFloat, JSON brengt de kortste decimale weergave
 * naar PostgREST en PostgreSQL slaat die op in numeric(12,2): afronden op twee
 * decimalen, half weg van nul. `pgNumeric2` doet precies dat op de TEKST (geen
 * float), en de controle is daarna exacte gehele optelling — net als NUMERIC.
 *
 * HALF-UP, ONAFHANKELIJK NAGEREKEND
 * btw = round_half_up(excl × pct / 100) in centen: floor((2·c·p + 100) / 200),
 * zuiver geheel.
 */

/** PostgreSQL numeric(12,2)-invoer van een decimale tekst → hele centen (half weg van nul). */
function pgNumeric2(text: string): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`geen numeric-tekst: ${text}`);
  const [, sign, whole, fracRaw = ""] = m;
  const frac = (fracRaw + "000").slice(0, 3); // twee decimalen + de afrondingscijfer
  let cents = Number(whole) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1; // >= 5 op de derde decimaal: weg van nul
  return sign === "-" ? -cents : cents;
}

/** De servercontrole van post_sales_invoice(), exact. */
function serverAccepts(excl: string, btw: string, incl: string): boolean {
  return pgNumeric2(excl) + pgNumeric2(btw) === pgNumeric2(incl);
}

/** half-up(c × p / 100), zuiver geheel. */
const halfUp = (c: number, p: number) => Math.floor((2 * c * p + 100) / 200);

const PCTS = [9, 21] as const;
const MAX = 100_000; // € 0,01 … € 1.000,00

describe("A3-10 — uitputtend: elk bedrag van € 0,01 t/m € 1.000,00 bij 9% en 21%", () => {
  it("de nagebouwde servercontrole is zelf correct (de A3-weigering en een geldige boeking)", () => {
    // A3-probe: 21,50 / 4,51 / 26,02 → "sluit niet aan" (23514).
    expect(serverAccepts("21.50", "4.51", "26.02")).toBe(false);
    expect(serverAccepts("21.50", "4.52", "26.02")).toBe(true);
    // numeric(12,2) rondt bij opslag half weg van nul af.
    expect(pgNumeric2("21.555")).toBe(2156);
    expect(pgNumeric2("1.005")).toBe(101);
    expect(pgNumeric2("1.004")).toBe(100);
  });

  for (const pct of PCTS) {
    it(`verkoopdialoog-helper ${pct}%: excl + btw = incl, btw = half-up, en de servercontrole accepteert`, () => {
      const fouten: string[] = [];
      for (let c = 1; c <= MAX; c++) {
        const excl = formatCents(c);
        const out = vatAmountsFromExclText(excl, String(pct));
        if (!out) { fouten.push(`${excl}: geen uitkomst`); continue; }
        const b = pgNumeric2(out.btw_amount);
        const i = pgNumeric2(out.amount_incl);
        if (c + b !== i) fouten.push(`${excl}: ${excl} + ${out.btw_amount} ≠ ${out.amount_incl}`);
        if (b !== halfUp(c, pct)) fouten.push(`${excl}: btw ${out.btw_amount} ≠ half-up ${formatCents(halfUp(c, pct))}`);
        if (!serverAccepts(excl, out.btw_amount, out.amount_incl)) fouten.push(`${excl}: server weigert`);
        if (fouten.length > 5) break;
      }
      expect(fouten).toEqual([]);
    });

    it(`deriveFromExcl ${pct}% (inkoop-aanmaakdialoog): dezelfde garanties, 0 afwijkingen`, () => {
      const fouten: string[] = [];
      for (let c = 1; c <= MAX; c++) {
        const { btw, incl } = deriveFromExcl(c / 100, pct);
        const b = toCents(btw);
        const i = toCents(incl);
        if (c + b !== i) fouten.push(`${formatCents(c)}: excl + btw ≠ incl`);
        if (b !== halfUp(c, pct)) fouten.push(`${formatCents(c)}: btw ${btw} ≠ half-up`);
        if (fouten.length > 5) break;
      }
      expect(fouten).toEqual([]);
    });
  }

  it("btwCentsFromExclCents is exact half-up, ook voor negatieve bedragen (weg van nul)", () => {
    expect(btwCentsFromExclCents(2150, 21)).toBe(452); // 451,5 → 452
    expect(btwCentsFromExclCents(150, 21)).toBe(32);   // 31,5 → 32
    expect(btwCentsFromExclCents(1050, 9)).toBe(95);   // 94,5 → 95
    expect(btwCentsFromExclCents(-2150, 21)).toBe(-452);
    expect(btwCentsFromExclCents(0, 21)).toBe(0);
  });

  it("een excl met subcenten rekent zoals de database hem opslaat: 21,555 → 21,56 → btw 4,53, incl 26,09", () => {
    const out = vatAmountsFromExclText("21.555", "21")!;
    expect(out).toEqual({ btw_amount: "4.53", amount_incl: "26.09" });
    expect(serverAccepts("21.555", out.btw_amount, out.amount_incl)).toBe(true);
  });
});

// ── De echte dialoog ────────────────────────────────────────────────────────

const base: SalesInvoiceFormData = {
  client_id: "c1",
  customer_name: "Klant BV",
  invoice_number: "VF-1",
  invoice_date: "2026-03-01",
  due_date: "",
  amount_excl: "",
  btw_percentage: "21",
  btw_amount: "",
  amount_incl: "",
  notes: "",
};

function renderDialog(pct: string) {
  const onSave = vi.fn(async (_data: SalesInvoiceFormData, _file: File | null) => {});
  const utils = render(
    <SalesInvoiceDialog open onOpenChange={() => {}} clients={[{ id: "c1", name: "Klant 1" }]}
      onSave={onSave} editData={{ ...base, btw_percentage: pct }} />,
  );
  const [exclInput, btwInput, inclInput] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  return { onSave, exclInput, btwInput, inclInput, ...utils };
}

describe("A3-10 — de verkoopdialoog zelf", () => {
  it("21,50 bij 21%: btw 4,52 (half-up), incl 26,02 — en de server accepteert wat er wordt opgeslagen", async () => {
    const { onSave, exclInput, btwInput, inclInput } = renderDialog("21");
    fireEvent.change(exclInput, { target: { value: "21.50" } });
    fireEvent.blur(exclInput);
    expect(btwInput.value).toBe("4.52");
    expect(inclInput.value).toBe("26.02");
    fireEvent.click(screen.getByRole("button", { name: /Opslaan/ }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const f = onSave.mock.calls[0][0];
    expect(f).toMatchObject({ amount_excl: "21.50", btw_amount: "4.52", amount_incl: "26.02" });
    expect(serverAccepts(f.amount_excl, f.btw_amount, f.amount_incl)).toBe(true);
  });

  it("10,50 bij 9%: btw 0,95 (half-up van 0,945), incl 11,45", () => {
    const { exclInput, btwInput, inclInput } = renderDialog("9");
    fireEvent.change(exclInput, { target: { value: "10.50" } });
    fireEvent.blur(exclInput);
    expect(btwInput.value).toBe("0.95");
    expect(inclInput.value).toBe("11.45");
  });

  it("1,50 bij 21%: btw 0,32 en incl 1,82 (de float gaf incl 1,81)", () => {
    const { exclInput, btwInput, inclInput } = renderDialog("21");
    fireEvent.change(exclInput, { target: { value: "1.50" } });
    fireEvent.blur(exclInput);
    expect(btwInput.value).toBe("0.32");
    expect(inclInput.value).toBe("1.82");
  });

  it("Opslaan zonder het excl-veld te verlaten slaat toch een sluitende btw en incl op", async () => {
    const { onSave, exclInput } = renderDialog("21");
    fireEvent.change(exclInput, { target: { value: "299.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Opslaan/ }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const f = onSave.mock.calls[0][0];
    expect(f).toMatchObject({ amount_excl: "299.50", btw_amount: "62.90", amount_incl: "362.40" });
    expect(serverAccepts(f.amount_excl, f.btw_amount, f.amount_incl)).toBe(true);
  });

  it("de telling van A3 door de echte dialoog (10,50 … 299,50 bij 21%): 0 onbalans, 0 afwijkingen van half-up", () => {
    const { exclInput, btwInput, inclInput } = renderDialog("21");
    let onbalans = 0;
    let afwijking = 0;
    for (let i = 0; i < 290; i++) {
      const c = 1050 + i * 100;
      fireEvent.change(exclInput, { target: { value: formatCents(c) } });
      fireEvent.blur(exclInput);
      const b = pgNumeric2(btwInput.value);
      if (c + b !== pgNumeric2(inclInput.value)) onbalans++;
      if (b !== halfUp(c, 21)) afwijking++;
    }
    expect(onbalans).toBe(0);
    expect(afwijking).toBe(0);
  });
});
