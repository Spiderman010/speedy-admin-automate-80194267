import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

/**
 * Fase 6C-b6 (PR 2) — de regeltabel van een memoriaalboeking.
 *
 * De GrootboekCombobox wordt gemockt tot een eenvoudige knop: die component is
 * ongewijzigd (geen postableOnly-prop) en heeft zijn eigen dekking.
 */

vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({
    value,
    onValueChange,
    onIdChange,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    onIdChange?: (id: string) => void;
  }) => (
    <button
      type="button"
      role="combobox"
      onClick={() => {
        onValueChange("4000 - Kosten");
        onIdChange?.("gb-1");
      }}
    >
      {value || "Selecteer rekening..."}
    </button>
  ),
}));

import { MemoriaalLinesTable } from "@/components/memoriaal/MemoriaalLinesTable";
import { createEmptyLineRows, type ManualJournalLineRow } from "@/lib/manual-journal-utils";

function Harness({
  initial = createEmptyLineRows(2),
  readOnly = false,
}: {
  initial?: ManualJournalLineRow[];
  readOnly?: boolean;
}) {
  const [lines, setLines] = useState(initial);
  return <MemoriaalLinesTable lines={lines} readOnly={readOnly} onChange={setLines} />;
}

const rows = () => screen.getAllByTestId("memoriaal-line-row");
const debit = (n: number) => screen.getByLabelText(`Debet regel ${n}`) as HTMLInputElement;
const credit = (n: number) => screen.getByLabelText(`Credit regel ${n}`) as HTMLInputElement;

describe("MemoriaalLinesTable", () => {
  it("1. toont de gevraagde kolommen", () => {
    render(<Harness />);
    for (const header of ["Omschrijving", "Grootboekrekening", "Debet", "Credit"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("2. regel toevoegen voegt een lege regel toe", () => {
    render(<Harness />);
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    expect(rows()).toHaveLength(3);
  });

  it("3. regel verwijderen haalt precies die regel weg", () => {
    render(<Harness />);
    fireEvent.change(debit(1), { target: { value: "10,00" } });
    fireEvent.change(debit(2), { target: { value: "20,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Regel 1 verwijderen" }));
    expect(rows()).toHaveLength(1);
    expect(debit(1).value).toBe("20,00");
  });

  it("4. debet en credit sluiten elkaar uit", () => {
    render(<Harness />);
    fireEvent.change(credit(1), { target: { value: "50,00" } });
    expect(credit(1).value).toBe("50,00");
    fireEvent.change(debit(1), { target: { value: "100,00" } });
    expect(debit(1).value).toBe("100,00");
    expect(credit(1).value).toBe("");
  });

  it("5. totalen en verschil lopen mee met de invoer", () => {
    render(<Harness />);
    fireEvent.change(debit(1), { target: { value: "121,00" } });
    fireEvent.change(credit(2), { target: { value: "100,00" } });
    expect(screen.getByTestId("memoriaal-total-debit")).toHaveTextContent("121,00");
    expect(screen.getByTestId("memoriaal-total-credit")).toHaveTextContent("100,00");
    expect(screen.getByTestId("memoriaal-difference")).toHaveTextContent("21,00");
  });

  it("6. 'In balans' verschijnt alleen bij gelijke, niet-nul totalen", () => {
    render(<Harness />);
    expect(screen.queryByTestId("memoriaal-balanced")).toBeNull();
    fireEvent.change(debit(1), { target: { value: "100,00" } });
    expect(screen.queryByTestId("memoriaal-balanced")).toBeNull();
    fireEvent.change(credit(2), { target: { value: "100,00" } });
    expect(screen.getByTestId("memoriaal-balanced")).toHaveTextContent("In balans");
  });

  it("7. 0 tegen 0 is geen boeking en toont dus geen balansbadge", () => {
    render(<Harness />);
    fireEvent.change(debit(1), { target: { value: "0" } });
    fireEvent.change(credit(2), { target: { value: "0" } });
    expect(screen.queryByTestId("memoriaal-balanced")).toBeNull();
  });

  it("8. invoer wordt op blur nl-NL genormaliseerd", () => {
    render(<Harness />);
    fireEvent.change(debit(1), { target: { value: "1234.5" } });
    fireEvent.blur(debit(1));
    expect(debit(1).value).toBe("1234,50");
  });

  it("8b. blur rondt NIET af: 0,005 blijft staan zodat de RPC hem kan weigeren", () => {
    render(<Harness />);
    fireEvent.change(debit(1), { target: { value: "0,005" } });
    fireEvent.blur(debit(1));
    expect(debit(1).value).toBe("0,005");
  });

  it("9. elke invoer heeft een toegankelijk label met regelnummer", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Omschrijving regel 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Omschrijving regel 2")).toBeInTheDocument();
    expect(debit(2)).toBeInTheDocument();
    expect(credit(2)).toBeInTheDocument();
  });

  it("10. toont de terughoudende BTW-hint", () => {
    render(<Harness />);
    expect(screen.getByTestId("memoriaal-vat-hint")).toHaveTextContent(
      "BTW boek je als aparte regel op de BTW-rekening.",
    );
  });

  it("11. de rekeningkeuze gebruikt de bestaande GrootboekCombobox", () => {
    render(<Harness />);
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);
    fireEvent.click(comboboxes[0]);
    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("4000 - Kosten");
  });

  it("12. readOnly: alles uitgeschakeld, geen toevoegen of verwijderen", () => {
    render(<Harness readOnly />);
    expect(debit(1).disabled).toBe(true);
    expect(credit(1).disabled).toBe(true);
    expect((screen.getByLabelText("Omschrijving regel 1") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /regel toevoegen/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /verwijderen/i })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
