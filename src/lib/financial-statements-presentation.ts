// Balans/W&V PR 4 — presentatiehelpers voor de zichtbare jaarrekeningrapporten.
//
// Puur: labels, statusduiding en CSV. Hier wordt NIET gerekend. Elk bedrag komt
// kant-en-klaar uit financial-statements.ts (PR 3), dat op zijn beurt alleen de
// rollups van buildAccountReport() hergroepeert. Geen tweede rekenbron, geen
// tekenomklap, geen totaal dat hier ontstaat.

import { CSV_SEPARATOR, formatAmountNl } from "@/lib/proef-saldibalans";
import type {
  BalanceSheetResult,
  FinancialStatementAccountLine,
  FinancialStatementGroup,
  FinancialStatementSystemLine,
  ProfitLossResult,
  StatementCompleteness,
  UnclassifiedAccount,
  UnclassifiedReason,
} from "@/lib/financial-statements";

// ── Status ──────────────────────────────────────────────────────────────────

export interface CompletenessPresentation {
  label: string;
  /** Badge-variant; "ambiguous" wordt nooit groen. */
  tone: "success" | "warning" | "neutral";
  description: string;
}

export const COMPLETENESS_PRESENTATION: Readonly<Record<StatementCompleteness, CompletenessPresentation>> = {
  complete: {
    label: "Volledig",
    tone: "success",
    description: "Alle grootboekactiviteit in deze periode is geclassificeerd.",
  },
  incomplete: {
    label: "Onvolledig",
    tone: "warning",
    description: "Er is grootboekactiviteit die nog niet is geclassificeerd.",
  },
  unknown: {
    label: "Niet vastgesteld",
    tone: "neutral",
    description: "De volledigheid kon niet worden bepaald.",
  },
  ambiguous: {
    label: "Controle vereist",
    tone: "warning",
    description:
      "De periode is geen volledig boekjaar, dus de splitsing tussen lopend en eerder resultaat is niet als boekjaar te duiden.",
  },
};

export const UNCLASSIFIED_REASON_LABELS: Readonly<Record<UnclassifiedReason, string>> = {
  missing_statement_type: "Geen rapport gekozen",
  missing_report_group: "Geen of onbekende groep",
  invalid_group_for_statement: "Groep hoort niet bij het gekozen rapport",
  missing_normal_side: "Normale zijde ontbreekt",
  unresolved_account: "Rekening staat niet in het rekeningschema",
  account_not_supplied: "Rekening niet meegeladen",
};

export const UNCLASSIFIED_WARNING =
  "Dit rapport is niet volledig zolang actieve grootboekrekeningen niet zijn geclassificeerd.";

/** Rekeninglabel zoals elders in de app: "1100 - Bank". */
export function accountLabel(nummer: number | null, omschrijving: string): string {
  return nummer === null ? omschrijving : `${nummer} - ${omschrijving}`;
}

/**
 * De tekst bij een beginbalansbijdrage op W&V-rekeningen. `null` betekent
 * "niet vastgesteld" en wordt NOOIT als nul gepresenteerd.
 */
export function openingContributionNotice(cents: number | null): string | null {
  if (cents === null) {
    return "De bijdrage van beginbalansposten aan deze winst-en-verliesrekening is niet vastgesteld.";
  }
  if (cents === 0) return null;
  // Het bedrag komt uit de engine; hier wordt alleen het teken gedraaid voor
  // leesbaarheid (een opbrengst staat credit, dus negatief in de kern).
  return `Deze winst-en-verliesrekening bevat ${formatEuroCents(-cents)} aan openings-/cutoverbedragen.`;
}

/** Centen → "€ 1.234,56" met nl-NL-scheiding; negatief blijft negatief. */
export function formatEuroCents(cents: number): string {
  const negatief = cents < 0;
  const absolute = Math.abs(cents);
  const euros = Math.trunc(absolute / 100);
  const rest = String(absolute % 100).padStart(2, "0");
  const gegroepeerd = euros.toLocaleString("nl-NL");
  return `${negatief ? "-" : ""}€ ${gegroepeerd},${rest}`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvVeld(waarde: string): string {
  // Zelfde regel als de proef- en saldibalans: quoten zodra een scheidingsteken,
  // aanhalingsteken of regeleinde in de waarde zit.
  return /[";\r\n]/.test(waarde) ? `"${waarde.replace(/"/g, '""')}"` : waarde;
}

function csvRegel(velden: readonly string[]): string {
  return velden.map(csvVeld).join(CSV_SEPARATOR);
}

export const STATEMENT_CSV_HEADERS = ["Onderdeel", "Rekeningnummer", "Omschrijving", "Bedrag"] as const;

function slugify(waarde: string): string {
  return (
    waarde
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "rapport"
  );
}

export function statementCsvFilename(soort: "balans" | "winst-verlies", clientName: string, periodLabel: string): string {
  return `${soort}-${slugify(clientName)}-${slugify(periodLabel)}.csv`;
}

function groupRegels(sectie: string, groups: readonly FinancialStatementGroup[]): string[] {
  const regels: string[] = [];
  for (const g of groups) {
    for (const l of g.lines) {
      regels.push(csvRegel([`${sectie} — ${g.label}`, l.accountNumber === null ? "" : String(l.accountNumber), l.accountName, formatAmountNl(l.displayedCents)]));
    }
    regels.push(csvRegel([`${sectie} — ${g.label}`, "", "Subtotaal", formatAmountNl(g.totalCents)]));
  }
  return regels;
}

function unclassifiedRegels(accounts: readonly UnclassifiedAccount[], bedrag: (a: UnclassifiedAccount) => number): string[] {
  return accounts.map((a) =>
    csvRegel([
      `Niet geclassificeerd — ${UNCLASSIFIED_REASON_LABELS[a.reason]}`,
      a.accountNumber === null ? "" : String(a.accountNumber),
      a.accountName,
      formatAmountNl(bedrag(a)),
    ]),
  );
}

/**
 * De balans als CSV — exact de regels die op het scherm staan, inclusief de
 * systeemregels en de niet-geclassificeerde sectie. Er wordt niets opgeteld dat
 * niet al uit de engine kwam.
 */
export function balanceSheetToCsv(input: {
  balanceSheet: BalanceSheetResult;
  unclassified: readonly UnclassifiedAccount[];
}): string {
  const { balanceSheet, unclassified } = input;
  const regels = [csvRegel(STATEMENT_CSV_HEADERS)];
  regels.push(...groupRegels("Activa", balanceSheet.assetGroups));
  regels.push(csvRegel(["Activa", "", "Totaal activa", formatAmountNl(balanceSheet.totalAssetsCents)]));
  regels.push(...groupRegels("Passiva", balanceSheet.liabilityEquityGroups));
  for (const l of balanceSheet.systemLines) {
    regels.push(csvRegel(["Passiva — systeemregel", "", l.label, formatAmountNl(l.displayedCents)]));
  }
  regels.push(csvRegel(["Passiva", "", "Totaal passiva", formatAmountNl(balanceSheet.totalLiabilitiesEquityCents)]));
  regels.push(csvRegel(["Controle", "", "Verschil", formatAmountNl(balanceSheet.differenceCents)]));
  regels.push(...unclassifiedRegels(unclassified, (a) => a.rawSignedClosingCents));
  return `${regels.join("\r\n")}\r\n`;
}

/** De winst-en-verliesrekening als CSV — dezelfde regels als het scherm. */
export function profitLossToCsv(input: {
  profitLoss: ProfitLossResult;
  unclassified: readonly UnclassifiedAccount[];
}): string {
  const { profitLoss, unclassified } = input;
  const regels = [csvRegel(STATEMENT_CSV_HEADERS)];
  regels.push(...groupRegels("Winst-en-verliesrekening", profitLoss.groups));
  regels.push(csvRegel(["Resultaat", "", "Opbrengsten", formatAmountNl(profitLoss.revenueCents)]));
  regels.push(csvRegel(["Resultaat", "", "Kosten", formatAmountNl(profitLoss.expenseCents)]));
  regels.push(csvRegel(["Resultaat", "", "Resultaat", formatAmountNl(profitLoss.netResultCents)]));
  regels.push(...unclassifiedRegels(unclassified, (a) => a.rawSignedMovementCents));
  return `${regels.join("\r\n")}\r\n`;
}

/** Alleen regels met een bedrag of met activiteit; puur een weergavefilter. */
export function visibleLines(lines: readonly FinancialStatementAccountLine[], toonNul: boolean): FinancialStatementAccountLine[] {
  return toonNul ? [...lines] : lines.filter((l) => l.displayedCents !== 0 || l.hasActivity);
}

/** Groepen zonder zichtbare regels en zonder saldo hoeven niet te verschijnen. */
export function visibleGroups(groups: readonly FinancialStatementGroup[], toonNul: boolean): FinancialStatementGroup[] {
  if (toonNul) return [...groups];
  return groups
    .map((g) => ({ ...g, lines: visibleLines(g.lines, toonNul) }))
    .filter((g) => g.lines.length > 0 || g.totalCents !== 0);
}

export type { FinancialStatementSystemLine };
