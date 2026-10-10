/**
 * Bankafstemming-overzicht — van bestaande leesmodellen naar feiten.
 *
 * WAT DIT WEL DOET
 * Twee secties opbouwen uit uitkomsten die al bestaan:
 *   - Bankgegevens/import → `client.ibans` + aantal en oudste/nieuwste datum uit
 *     de bestaande bankleeshook (`usePaginatedBankTransactions`);
 *   - Kruisposten (1200)  → de rekening uit het rekeningschema binnen de
 *     administratiegrens (`accountsForClient()`), en haar eindsaldo uit de
 *     bestaande rapportagekern (`buildAccountReport()` over alle jaren).
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen afstemming, geen matching, geen eigen saldo- of verschilberekening en
 * nooit de bewering dat een rekening volledig is ingelezen of afgestemd: geen
 * bestaand model bewijst dat. Banktransacties dragen geen eigen IBAN (alleen
 * de tegenrekening), dus er wordt ook niet per bankrekening gesplitst.
 *
 * Een bron die niet gelezen kon worden, of een kern die zijn eigen controle
 * niet haalt, is `niet_te_bepalen` — nooit een getoond saldo.
 */

import { accountsForClient, type ClientScopedAccountLike } from "./account-scope";
import type { LedgerAccountReport } from "./ledger-reporting";

export type BankOverviewStatus = "informatief" | "aandacht" | "niet_te_bepalen" | "laden";

export const BANK_OVERVIEW_STATUS_LABELS: Readonly<Record<BankOverviewStatus, string>> = {
  informatief: "Informatief",
  aandacht: "Aandacht nodig",
  niet_te_bepalen: "Niet te bepalen",
  laden: "Laden…",
};

/** De leesuitkomst van één bron. */
export type SourceRead<T> = { kind: "loading" } | { kind: "error"; message?: string } | { kind: "ok"; value: T };

const READ_FAILED = "De gegevens konden niet worden gelezen; daarom is hier niets over te zeggen.";

/** Het rekeningnummer waar dit overzicht om vraagt. Er wordt geen vervangende rekening gezocht. */
export const KRUISPOSTEN_NUMMER = 1200;

function plural(n: number, een: string, meer: string): string {
  return `${n} ${n === 1 ? een : meer}`;
}

function nlDatum(iso: string): string {
  const [j, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${j}`;
}

// ── Bankgegevens en import ──────────────────────────────────────────────────

export interface BankImportFacts {
  total: number;
  firstDate: string | null;
  lastDate: string | null;
  ibans: readonly string[];
}

export interface BankImportSection {
  status: BankOverviewStatus;
  summary: string;
  /** Vastgelegde IBAN's, ongewijzigd; leeg wanneer onbekend of niet vastgelegd. */
  ibans: readonly string[];
  total: number | null;
  firstDate: string | null;
  lastDate: string | null;
  retryable: boolean;
  errorMessage?: string;
}

export function bankImportSection(read: SourceRead<BankImportFacts>): BankImportSection {
  const empty = { ibans: [], total: null, firstDate: null, lastDate: null };
  if (read.kind === "loading") return { ...empty, status: "laden", summary: "Gegevens worden gelezen.", retryable: false };
  if (read.kind === "error") {
    return { ...empty, status: "niet_te_bepalen", summary: READ_FAILED, retryable: true, errorMessage: read.message };
  }
  const f = read.value;
  const summary =
    f.total === 0
      ? "Nog geen banktransacties geïmporteerd voor deze administratie."
      : `${plural(f.total, "banktransactie", "banktransacties")} geïmporteerd voor deze administratie` +
        (f.firstDate && f.lastDate ? `, van ${nlDatum(f.firstDate)} t/m ${nlDatum(f.lastDate)}.` : ".");
  return {
    status: "informatief",
    summary:
      `${summary} Banktransacties dragen geen eigen IBAN, dus dit is één telling voor alle rekeningen samen; ` +
      "of een rekening volledig is ingelezen, is uit de bestaande gegevens niet af te leiden.",
    ibans: f.ibans,
    total: f.total,
    firstDate: f.firstDate,
    lastDate: f.lastDate,
    retryable: false,
  };
}

// ── Kruisposten (1200) ──────────────────────────────────────────────────────

export interface KruispostenAccountLike extends ClientScopedAccountLike {
  id: string;
  nummer: number | string | null;
  omschrijving: string;
  actief?: boolean | null;
}

export interface KruispostenRow {
  accountId: string;
  nummer: string;
  omschrijving: string;
  actief: boolean;
  /** Eindsaldo over alle jaren uit `buildAccountReport()`; null wanneer er geen grootboekregels zijn. */
  closingCents: number | null;
  /** Aantal grootboekregels op de rekening, uit dezelfde rollup. */
  lineCount: number;
}

export interface KruispostenSection {
  status: BankOverviewStatus;
  summary: string;
  rows: KruispostenRow[];
  /** De rekening bestaat niet in het rekeningschema van deze administratie. */
  absent: boolean;
  retryable: boolean;
  errorMessage?: string;
}

export type KruispostenReportRead =
  | { kind: "loading" }
  | { kind: "error"; message?: string }
  | { kind: "ok"; value: LedgerAccountReport };

function isKruisposten(a: KruispostenAccountLike): boolean {
  return a.nummer !== null && String(a.nummer).trim() === String(KRUISPOSTEN_NUMMER);
}

export function kruispostenSection(
  accountsRead: SourceRead<readonly KruispostenAccountLike[]>,
  reportRead: KruispostenReportRead,
  clientId: string,
): KruispostenSection {
  const none = { rows: [], absent: false };
  if (accountsRead.kind === "error") {
    return { ...none, status: "niet_te_bepalen", summary: READ_FAILED, retryable: true, errorMessage: accountsRead.message };
  }
  if (accountsRead.kind === "loading") return { ...none, status: "laden", summary: "Gegevens worden gelezen.", retryable: false };

  const matches = accountsForClient(accountsRead.value, clientId).filter(isKruisposten);
  if (matches.length === 0) {
    return {
      rows: [],
      absent: true,
      status: "informatief",
      summary: `Rekening ${KRUISPOSTEN_NUMMER} bestaat niet in het rekeningschema van deze administratie; er wordt geen saldo getoond.`,
      retryable: false,
    };
  }

  if (reportRead.kind === "error") {
    return { ...none, status: "niet_te_bepalen", summary: READ_FAILED, retryable: true, errorMessage: reportRead.message };
  }
  if (reportRead.kind === "loading") return { ...none, status: "laden", summary: "Gegevens worden gelezen.", retryable: false };
  const report = reportRead.value;
  if (!report.ok) {
    return {
      ...none,
      status: "niet_te_bepalen",
      summary: "Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit; er wordt geen saldo getoond.",
      retryable: false,
    };
  }

  const rows: KruispostenRow[] = matches.map((a) => {
    const rollup = report.rollups.find((r) => r.account.id === a.id);
    return {
      accountId: a.id,
      nummer: String(a.nummer),
      omschrijving: a.omschrijving,
      actief: a.actief !== false,
      closingCents: rollup ? rollup.closingCents : null,
      lineCount: rollup ? rollup.periodLineCount : 0,
    };
  });

  if (rows.some((r) => r.closingCents !== null && r.closingCents !== 0)) {
    return {
      rows,
      absent: false,
      status: "aandacht",
      summary: `Het saldo van rekening ${KRUISPOSTEN_NUMMER} is niet nul.`,
      retryable: false,
    };
  }
  return {
    rows,
    absent: false,
    status: "informatief",
    summary: rows.every((r) => r.closingCents === null)
      ? `Er zijn geen grootboekregels geboekt op rekening ${KRUISPOSTEN_NUMMER}.`
      : `Het saldo van rekening ${KRUISPOSTEN_NUMMER} is nul.`,
    retryable: false,
  };
}
