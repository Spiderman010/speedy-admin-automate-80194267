// Balans/W&V PR 4 — presentatiehelpers voor de zichtbare jaarrekeningrapporten.
//
// Puur: labels, statusduiding en CSV. Hier wordt NIET gerekend. Elk bedrag komt
// kant-en-klaar uit financial-statements.ts (PR 3), dat op zijn beurt alleen de
// rollups van buildAccountReport() hergroepeert. Geen tweede rekenbron, geen
// tekenomklap, geen totaal dat hier ontstaat.

import { CSV_SEPARATOR, formatAmountNl } from "@/lib/proef-saldibalans";
import { formatCents } from "@/lib/grootboek-saldi-utils";
import type {
  BalanceSheetResult,
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
 * De tekst bij een beginbalansbijdrage op W&V-rekeningen.
 *
 * Let op het verschil tussen "geen beginbalansposten" en "beginbalansposten die
 * elkaar opheffen". `cents` is een SALDO: staat er in een cutover €700 opbrengst
 * tegenover €700 kosten, dan is het saldo 0 terwijl er wel degelijk €1.400 aan
 * openingsbedragen in dit rapport zit. Daarom bepaalt `insidePeriod` (uit de
 * diagnostics van de engine) óf er iets te melden valt, en het saldo alleen
 * hoevéél. `null` betekent "niet vastgesteld" en wordt NOOIT als nul getoond.
 */
export function openingContributionNotice(
  cents: number | null,
  insidePeriod: boolean,
): string | null {
  if (cents === null) {
    return "De bijdrage van beginbalansposten aan deze winst-en-verliesrekening is niet vastgesteld.";
  }
  if (!insidePeriod) return null;
  if (cents === 0) {
    return "Deze winst-en-verliesrekening bevat openings-/cutoverbedragen die per saldo tegen elkaar wegvallen.";
  }
  // Dezelfde omrekening als het resultaat zelf: de W&V toont een resultaat als
  // −(getekende mutatie), dus de bijdrage áán dat resultaat ook. Geen vrije
  // tekenkeuze, maar exact de presentatieregel van de engine.
  return `Deze winst-en-verliesrekening bevat ${formatCents(-cents)} aan openings-/cutoverbedragen.`;
}

/**
 * Bedragen op het scherm gebruiken de bestaande app-formatter (`formatCents`,
 * dezelfde die de grootboeksaldi tonen), zodat het minteken en de
 * euro-notatie overal in BoekAssist gelijk zijn. De CSV gebruikt bewust
 * `formatAmountNl` — de exportconventie van de proef- en saldibalans, zonder
 * valutateken en Excel-vriendelijk. Beide lezen dezelfde centen uit de engine,
 * dus scherm en export kunnen niet uit elkaar lopen; alleen de weergave
 * verschilt.
 */
export { formatCents } from "@/lib/grootboek-saldi-utils";

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

export type { FinancialStatementSystemLine };
