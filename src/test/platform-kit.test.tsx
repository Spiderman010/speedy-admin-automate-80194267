import { readFileSync, readdirSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { AuditTrailBlock } from "@/components/platform/AuditTrailBlock";
import { ReconciliationBlock } from "@/components/platform/ReconciliationBlock";
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";
import { visibleAuditEntries } from "@/lib/platform/audit-trail";
import { formatCents } from "@/lib/grootboek-saldi-utils";

/**
 * Platform Kit V1.
 *
 * De inzet van deze suite is niet "rendert de component iets", maar de belofte
 * waarop de hele kit rust: GEEN VAN DEZE COMPONENTEN BEDENKT BOEKHOUDING. Ze
 * tonen wat ze krijgen, ze rekenen niet, ze leiden niets af uit een
 * rekeningnummer of een categorie, en ze schrijven nergens naartoe.
 */

/** Niet-brekende spatie: `Intl` zet die tussen het euroteken en het bedrag. */
const nbsp = (s: string) => s.replace(/\u00a0/g, " ");
const tekst = (el: HTMLElement | null) => nbsp(el?.textContent ?? "");

// ── AccountingAmount ────────────────────────────────────────────────────────

describe("AccountingAmount", () => {
  it("1. toont exact de centen die het krijgt", () => {
    render(<AccountingAmount cents={123456} data-testid="b" />);
    expect(tekst(screen.getByTestId("b"))).toBe("€ 1.234,56");
  });

  it("2. een negatief bedrag blijft negatief — er wordt niets omgeklapt", () => {
    render(<AccountingAmount cents={-8000000} data-testid="b" />);
    expect(tekst(screen.getByTestId("b"))).toBe("€ -80.000,00");
  });

  it("3. nul is standaard een bedrag, en leeg alleen wanneer de beller dat vraagt", () => {
    const { rerender } = render(<AccountingAmount cents={0} data-testid="b" />);
    expect(tekst(screen.getByTestId("b"))).toBe("€ 0,00");
    rerender(<AccountingAmount cents={0} blankWhenZero data-testid="b" />);
    expect(screen.getByTestId("b").textContent).toBe("");
    // blankWhenZero raakt alleen de nul; 1 cent blijft gewoon een cent.
    rerender(<AccountingAmount cents={1} blankWhenZero data-testid="b" />);
    expect(tekst(screen.getByTestId("b"))).toBe("€ 0,01");
  });

  it("4. de opmaak is die van de rest van de app", () => {
    render(<AccountingAmount cents={4200} data-testid="b" />);
    const el = screen.getByTestId("b");
    expect(el.className).toContain("tabular-nums");
    expect(el.className).toContain("font-mono");
    expect(tekst(el)).toBe(nbsp(formatCents(4200)));
  });

  it("5. nadruk en demping zijn opmaak, geen ander getal", () => {
    const { rerender } = render(<AccountingAmount cents={999} emphasis data-testid="b" />);
    expect(screen.getByTestId("b").className).toContain("font-semibold");
    expect(tekst(screen.getByTestId("b"))).toBe("€ 9,99");
    rerender(<AccountingAmount cents={999} muted data-testid="b" />);
    expect(screen.getByTestId("b").className).toContain("text-muted-foreground");
    expect(tekst(screen.getByTestId("b"))).toBe("€ 9,99");
  });

  it("6. er wordt in de bron niet gerekend en geen teken omgeklapt", () => {
    const bron = readFileSync("src/components/platform/AccountingAmount.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    // Geen deling door 100, geen optelling, geen omkering van het teken.
    expect(bron).not.toMatch(/\/\s*100|\*\s*100/);
    expect(bron).not.toMatch(/cents\s*[+\-*/]|[+\-*/]\s*cents/);
    expect(bron).not.toMatch(/reduce|Math\.(abs|round|sign)/);
    // Geen tweede tekenmotor en geen afleiding uit de rekening.
    expect(bron).not.toMatch(/displayedCents|presentationSide|normalSide/);
    expect(bron).not.toMatch(/\.\s*(nummer|categorie|report_group|statement_type)\b/);
  });
});

// ── AccountingNotice ────────────────────────────────────────────────────────

describe("AccountingNotice", () => {
  it("7. toont de drie ernstniveaus, elk herkenbaar", () => {
    for (const severity of ["info", "warning", "blocking"] as const) {
      const { unmount } = render(
        <AccountingNotice severity={severity} title={`Kop ${severity}`} data-testid="n">
          Inhoud {severity}
        </AccountingNotice>,
      );
      const el = screen.getByTestId("n");
      expect(el.dataset.severity).toBe(severity);
      expect(el).toHaveTextContent(`Kop ${severity}`);
      expect(el).toHaveTextContent(`Inhoud ${severity}`);
      unmount();
    }
  });

  it("8. een waarschuwing is geen fout: aparte opmaak, niet de destructieve", () => {
    const { unmount } = render(
      <AccountingNotice severity="warning" data-testid="n">let op</AccountingNotice>,
    );
    const warning = screen.getByTestId("n").className;
    expect(warning).toContain("warning");
    unmount();

    render(<AccountingNotice severity="blocking" data-testid="n">fout</AccountingNotice>);
    const blocking = screen.getByTestId("n").className;
    expect(blocking).toContain("destructive");
    expect(blocking).not.toBe(warning);
  });

  it("9. de inhoud blijft toegankelijk", () => {
    render(
      <AccountingNotice severity="blocking" title="Rapport kan niet worden opgebouwd">
        De boekingscontrole sluit niet.
      </AccountingNotice>,
    );
    const melding = screen.getByRole("alert");
    expect(melding).toHaveTextContent("Rapport kan niet worden opgebouwd");
    expect(melding).toHaveTextContent("De boekingscontrole sluit niet.");
  });

  it("10. zonder titel verschijnt er geen lege kopregel", () => {
    render(<AccountingNotice severity="info" data-testid="n">alleen tekst</AccountingNotice>);
    expect(tekst(screen.getByTestId("n")).trim()).toBe("alleen tekst");
  });

  it("11. het icoon is te onderdrukken voor meldingen die er geen hadden", () => {
    const { rerender } = render(
      <AccountingNotice severity="warning" data-testid="n">met</AccountingNotice>,
    );
    expect(screen.getByTestId("n").querySelector("svg")).not.toBeNull();
    rerender(
      <AccountingNotice severity="warning" icon={null} data-testid="n">zonder</AccountingNotice>,
    );
    expect(screen.getByTestId("n").querySelector("svg")).toBeNull();
  });
});

// ── AuditTrailBlock ─────────────────────────────────────────────────────────

describe("AuditTrailBlock", () => {
  it("12. toont de meegegeven metadata", () => {
    render(
      <AuditTrailBlock
        data-testid="a"
        entries={[
          { label: "Datum tegenboeking", value: "01-06-2027", testId: "d" },
          { label: "Reden", value: "Onjuiste rekening", testId: "r" },
        ]}
      />,
    );
    expect(tekst(screen.getByTestId("d"))).toBe("01-06-2027");
    expect(tekst(screen.getByTestId("r"))).toBe("Onjuiste rekening");
    expect(screen.getByTestId("a")).toHaveTextContent("Datum tegenboeking");
  });

  it("13. zonder fallback verdwijnt een niet-vastgelegd veld helemaal", () => {
    render(
      <AuditTrailBlock
        data-testid="a"
        entries={[
          { label: "Datum tegenboeking", value: "01-06-2027", testId: "d" },
          { label: "Reden", value: null, testId: "r" },
          { label: "Bron", value: "   ", testId: "b" },
        ]}
      />,
    );
    expect(screen.getByTestId("d")).not.toBeNull();
    expect(screen.queryByTestId("r")).toBeNull();
    expect(screen.queryByTestId("b")).toBeNull();
    expect(screen.getByTestId("a")).not.toHaveTextContent("Reden");
  });

  it("14. met fallback blijft de regel staan en zegt zij dat er niets is vastgelegd", () => {
    render(
      <AuditTrailBlock
        data-testid="a"
        fallback="Niet vastgelegd"
        entries={[{ label: "Reden", value: null, testId: "r" }]}
      />,
    );
    expect(tekst(screen.getByTestId("r"))).toBe("Niet vastgelegd");
    expect(screen.getByTestId("r").dataset.missing).toBe("true");
  });

  it("15. er wordt nooit een datum, reden of gebruiker verzonnen", () => {
    render(
      <AuditTrailBlock
        data-testid="a"
        entries={[
          { label: "Datum tegenboeking", value: null, testId: "d" },
          { label: "Reden", value: undefined, testId: "r" },
        ]}
      />,
    );
    // Niets vastgelegd en geen fallback: het blok verdwijnt in zijn geheel.
    expect(screen.queryByTestId("a")).toBeNull();

    // Op de CODE, niet op het commentaar: de toelichting mag het woord
    // "gebruiker" gewoon gebruiken om uit te leggen dat er geen is.
    const code = (pad: string) =>
      readFileSync(pad, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

    const regel = code("src/lib/platform/audit-trail.ts");
    // Geen klok en geen sessie: niets dat een ontbrekende waarde kan invullen.
    expect(regel).not.toMatch(/new Date|Date\.now|toISOString|toLocale/);
    expect(regel).not.toMatch(/\bauth\b|useAuth|currentUser|supabase/i);
    // Geen actorveld in de vorm van de gegevens.
    expect(regel).not.toMatch(/\b(actor|userName|user_id|createdBy)\b/);
    // Eén plek waar een ontbrekende waarde vandaan komt: de fallback van de beller.
    expect(regel.match(/\?\?/g) ?? []).toHaveLength(0);

    const component = code("src/components/platform/AuditTrailBlock.tsx");
    expect(component).not.toMatch(/new Date|Date\.now/);
    expect(component).not.toMatch(/\b(actor|userName|user_id|createdBy)\b/);
  });

  it("16. de weglaatregel staat los van de opmaak en is als regel te controleren", () => {
    const entries = [
      { label: "Datum", value: "01-06-2027" },
      { label: "Reden", value: null },
      { label: "Bron", value: "" },
    ];
    expect(visibleAuditEntries(entries).map((e) => e.label)).toEqual(["Datum"]);
    expect(visibleAuditEntries(entries, "Niet vastgelegd").map((e) => e.value)).toEqual([
      "01-06-2027", "Niet vastgelegd", "Niet vastgelegd",
    ]);
    expect(visibleAuditEntries(entries, "Niet vastgelegd").map((e) => e.missing)).toEqual([
      false, true, true,
    ]);
  });
});

// ── ReconciliationBlock ─────────────────────────────────────────────────────

describe("ReconciliationBlock", () => {
  it("17. toont de meegegeven bedragen ongewijzigd", () => {
    render(
      <ReconciliationBlock
        data-testid="r"
        rows={[
          { label: "Beginsaldo", cents: 500000, testId: "open" },
          { label: "Mutaties 2026", cents: 25000, testId: "mut" },
        ]}
        result={{ label: "Eindsaldo", cents: 525000, testId: "eind" }}
      />,
    );
    expect(tekst(screen.getByTestId("open"))).toBe("€ 5.000,00");
    expect(tekst(screen.getByTestId("mut"))).toBe("€ 250,00");
    expect(tekst(screen.getByTestId("eind"))).toBe("€ 5.250,00");
  });

  it("18. DE COMPONENT REKENT NIET: een uitkomst die niet klopt wordt getoond zoals hij is", () => {
    render(
      <ReconciliationBlock
        data-testid="r"
        rows={[
          { label: "Beginsaldo", cents: 100000, testId: "open" },
          { label: "Mutaties", cents: 100000, testId: "mut" },
        ]}
        // 1.000 + 1.000 is geen 9.999,99 — en toch is dát wat er moet staan.
        result={{ label: "Eindsaldo", cents: 999999, testId: "eind" }}
      />,
    );
    expect(tekst(screen.getByTestId("eind"))).toBe("€ 9.999,99");
    // Geen stilzwijgende correctie naar € 2.000,00, en geen eigen oordeel.
    expect(tekst(screen.getByTestId("r"))).not.toContain("2.000,00");
    expect(screen.getByTestId("r").dataset.reconciled).toBeUndefined();
  });

  it("19. de uitspraak over aansluiten komt van de beller", () => {
    const { rerender } = render(
      <ReconciliationBlock
        data-testid="r"
        rows={[{ label: "A", cents: 1 }]}
        result={{ label: "B", cents: 1 }}
        reconciled
        mismatchNotice={<p data-testid="mismatch">klopt niet</p>}
      />,
    );
    expect(screen.getByTestId("r").dataset.reconciled).toBe("true");
    expect(screen.queryByTestId("mismatch")).toBeNull();

    rerender(
      <ReconciliationBlock
        data-testid="r"
        rows={[{ label: "A", cents: 1 }]}
        result={{ label: "B", cents: 1 }}
        reconciled={false}
        mismatchNotice={<p data-testid="mismatch">klopt niet</p>}
      />,
    );
    expect(screen.getByTestId("r").dataset.reconciled).toBe("false");
    expect(screen.getByTestId("mismatch")).toHaveTextContent("klopt niet");
  });

  it("20. twee uitkomstregels mogen, voor hetzelfde bedrag in twee oriëntaties", () => {
    render(
      <ReconciliationBlock
        data-testid="r"
        rows={[{ label: "Beginsaldo", cents: 0 }]}
        result={[
          { label: "Grootboeksaldo (debet-positief)", cents: -100000, testId: "gb" },
          { label: "Bedrag in Balans", cents: 100000, testId: "rap" },
        ]}
      />,
    );
    // Beide getallen komen van de beller; de component keert er geen één om.
    expect(tekst(screen.getByTestId("gb"))).toBe("€ -1.000,00");
    expect(tekst(screen.getByTestId("rap"))).toBe("€ 1.000,00");
  });

  it("21. er wordt in de bron niet opgeteld en niets geclassificeerd", () => {
    const bron = readFileSync("src/components/platform/ReconciliationBlock.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    expect(bron).not.toMatch(/reduce|\.sum|cents\s*[+\-]|[+\-]\s*cents/);
    expect(bron).not.toMatch(/displayedCents|presentationSide/);
    expect(bron).not.toMatch(/\.\s*(nummer|categorie|report_group|statement_type)\b/);
  });
});

// ── FinancialActionDialog ───────────────────────────────────────────────────

function DialoogHarness(props: Partial<React.ComponentProps<typeof FinancialActionDialog>> = {}) {
  const [open, setOpen] = useState(true);
  return (
    <FinancialActionDialog
      open={open}
      onOpenChange={setOpen}
      title="Tegenboeking maken"
      explanation="De database maakt de tegenboeking."
      consequences={["De originele boeking blijft staan.", "Er komt een nieuwe boeking bij."]}
      confirmLabel="Tegenboeking maken"
      pendingLabel="Bezig met boeken…"
      isPending={false}
      onConfirm={() => {}}
      confirmTestId="bevestig"
      cancelTestId="annuleer"
      consequencesTestId="gevolgen"
      {...props}
    />
  );
}

describe("FinancialActionDialog", () => {
  it("22. toont titel, uitleg en de gevolgen", () => {
    render(<DialoogHarness />);
    // De titel is de kop van de dialoog, niet zomaar ergens die tekst — het
    // bevestiglabel is hier bewust dezelfde zin.
    expect(screen.getByRole("heading", { name: "Tegenboeking maken" })).toBeInTheDocument();
    expect(screen.getByText("De database maakt de tegenboeking.")).toBeInTheDocument();
    const gevolgen = within(screen.getByTestId("gevolgen")).getAllByRole("listitem");
    expect(gevolgen.map((li) => li.textContent)).toEqual([
      "De originele boeking blijft staan.",
      "Er komt een nieuwe boeking bij.",
    ]);
  });

  it("23. bevestigen roept de beller aan, precies één keer per klik", () => {
    const onConfirm = vi.fn();
    render(<DialoogHarness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("bevestig"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("24. annuleren sluit en boekt niets", () => {
    const onConfirm = vi.fn();
    render(<DialoogHarness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("annuleer"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("bevestig")).toBeNull();
  });

  it("25. terwijl het loopt: beide knoppen uit, en de handler weigert alsnog", () => {
    const onConfirm = vi.fn();
    render(<DialoogHarness isPending onConfirm={onConfirm} />);
    const bevestig = screen.getByTestId("bevestig");
    expect(bevestig).toBeDisabled();
    expect(screen.getByTestId("annuleer")).toBeDisabled();
    expect(tekst(bevestig)).toBe("Bezig met boeken…");
    // Tweede slot: ook een rechtstreekse klik komt er niet doorheen.
    fireEvent.click(bevestig);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("26. een onvolledig formulier blokkeert de bevestiging, maar niet het annuleren", () => {
    const onConfirm = vi.fn();
    render(<DialoogHarness confirmDisabled onConfirm={onConfirm} />);
    expect(screen.getByTestId("bevestig")).toBeDisabled();
    expect(screen.getByTestId("annuleer")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("bevestig"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("27. de rode knop komt er alleen als de beller erom vraagt", () => {
    const { unmount } = render(<DialoogHarness />);
    const normaal = screen.getByTestId("bevestig").className;
    expect(normaal).not.toContain("destructive");
    unmount();

    render(<DialoogHarness intent="destructive" />);
    expect(screen.getByTestId("bevestig").className).toContain("destructive");
  });

  it("28. extra velden van de beller staan gewoon in de dialoog", () => {
    render(
      <DialoogHarness>
        <input aria-label="Datum tegenboeking" type="date" />
      </DialoogHarness>,
    );
    expect(screen.getByLabelText("Datum tegenboeking")).toBeInTheDocument();
  });

  it("29. er zit geen boekingspad in de schil zelf", () => {
    const bron = readFileSync("src/components/platform/FinancialActionDialog.tsx", "utf8");
    expect(bron).not.toMatch(/@\/integrations\/supabase/);
    expect(bron).not.toMatch(/useMutation|useQuery|\.rpc\(|\.from\(/);
    expect(bron).not.toMatch(/ledger_postings|post_[a-z_]*\(/);
  });
});

// ── De grens van de kit ─────────────────────────────────────────────────────

describe("de grens van de Platform Kit", () => {
  const bestanden = readdirSync("src/components/platform")
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `src/components/platform/${f}`)
    .concat(
      readdirSync("src/lib/platform")
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `src/lib/platform/${f}`),
    );

  it("30. er staan werkelijk componenten in de kit", () => {
    expect(bestanden.length).toBeGreaterThanOrEqual(6);
  });

  it.each(bestanden)("31. %s praat niet met de database en schrijft niets", (pad) => {
    const bron = readFileSync(pad, "utf8");
    expect(bron).not.toMatch(/@\/integrations\/supabase/);
    expect(bron).not.toMatch(/@\/hooks\/use[A-Z]/);
    expect(bron).not.toMatch(/useMutation|useQuery|queryClient/);
    expect(bron).not.toMatch(/\bsupabase\b|ledger_postings|\.rpc\(/);
  });

  it.each(bestanden)("32. %s leidt geen boekhoudkundige betekenis af", (pad) => {
    const bron = readFileSync(pad, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    // Geen classificatie uit rekeningnummer, naam of categorie.
    expect(bron).not.toMatch(/\.\s*(nummer|categorie|report_group|statement_type|omschrijving)\b/);
    // Geen nummerreeksen ("alles onder 3000 is activa").
    expect(bron).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)|(<=|<|>=|>)\s*\d{3,4}/);
    // Geen eigen periode- of administratiekeuze.
    expect(bron).not.toMatch(/clientId|organization_id|boekjaar|periodFromSelection/);
  });
});
