/**
 * Administratie-gereedheid — van bestaande leesmodellen naar bewijsregels.
 *
 * WAT DIT WEL DOET
 * Per onderwerp één regel opbouwen uit een uitkomst die een BESTAAND leesmodel
 * al heeft vastgesteld, en die uitkomst vertalen naar één van zes toestanden
 * met een korte, feitelijke uitleg en een link naar het bronscherm.
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen eigen boekhoudregel, geen eigen "gereed"-berekening, geen bedrag, geen
 * totaaloordeel over de administratie. Het oordeel per regel komt uit:
 *   - rekeningschema        → `accountsForClient()` (de grens van de database);
 *   - grootboekinstellingen → `computeClientReadiness()` (alleen de configuratievelden);
 *   - beginbalans           → `OpeningBalanceCompleteness.severity`;
 *   - grootboekvolledigheid → `LedgerCompleteness` (statussen per bron, `mayBeIncomplete`);
 *   - historische boekingen → `summarize()` over de catch-up-records;
 *   - bank                  → aantal en datums uit de bestaande bankleeshook, alleen informatief.
 *
 * NIET TE BEPALEN IS GEEN GEBLOKKEERD, EN NOOIT IN ORDE
 * Kon een bron niet worden gelezen, of zegt het model zelf dat het het niet
 * weet, dan is de regel `niet_te_bepalen`. Een mislukte bron levert hier per
 * constructie nooit `in_orde` op.
 */

import { accountsForClient, type ClientScopedAccountLike } from "./account-scope";
import { computeClientReadiness, type GrootboekSlim } from "./client-readiness";
import type { CatchupSummary } from "./ledger-catchup";
import type { LedgerCompleteness, OpeningBalanceCompleteness } from "./ledger-completeness";
import type { Tables } from "@/integrations/supabase/types";

export type EvidenceStatus = "in_orde" | "aandacht" | "geblokkeerd" | "niet_te_bepalen" | "informatief" | "laden";

export const EVIDENCE_STATUS_LABELS: Readonly<Record<EvidenceStatus, string>> = {
  in_orde: "In orde",
  aandacht: "Aandacht nodig",
  geblokkeerd: "Geblokkeerd",
  niet_te_bepalen: "Niet te bepalen",
  informatief: "Informatief",
  laden: "Laden…",
};

export type EvidenceKey =
  | "rekeningschema"
  | "instellingen"
  | "beginbalans"
  | "volledigheid"
  | "historisch"
  | "bank";

export interface EvidenceLink {
  label: string;
  to: string;
}

export interface EvidenceRow {
  key: EvidenceKey;
  title: string;
  status: EvidenceStatus;
  /** Korte, feitelijke uitleg — uitsluitend wat het bronmodel zelf zegt. */
  summary: string;
  /** Losse feiten uit het model (aantallen, ontbrekende instellingen). */
  details: string[];
  /** Welk bestaand leesmodel deze regel voedt. */
  source: string;
  links: EvidenceLink[];
  /** Een lezing die opnieuw kan worden geprobeerd (alleen bij een leesfout). */
  retryable: boolean;
}

/** De leesuitkomst van één bron: aan het laden, mislukt, of gelezen. */
export type SourceRead<T> = { kind: "loading" } | { kind: "error"; message?: string } | { kind: "ok"; value: T };

const READ_FAILED = "De gegevens konden niet worden gelezen; daarom is hier niets over te zeggen.";

function pending(key: EvidenceKey, title: string, source: string, links: EvidenceLink[]): EvidenceRow {
  return { key, title, status: "laden", summary: "Gegevens worden gelezen.", details: [], source, links, retryable: false };
}

function failed(key: EvidenceKey, title: string, source: string, links: EvidenceLink[], message?: string): EvidenceRow {
  return {
    key,
    title,
    status: "niet_te_bepalen",
    summary: READ_FAILED,
    details: message ? [message] : [],
    source,
    links,
    retryable: true,
  };
}

function plural(n: number, een: string, meer: string): string {
  return `${n} ${n === 1 ? een : meer}`;
}

// ── Rekeningschema ──────────────────────────────────────────────────────────

const REKENINGSCHEMA_LINKS: EvidenceLink[] = [{ label: "Naar rekeningschema", to: "/grootboek" }];

export function rekeningschemaRow(
  read: SourceRead<readonly (ClientScopedAccountLike & { actief?: boolean | null })[]>,
  clientId: string,
): EvidenceRow {
  const title = "Rekeningschema";
  const source = "useGrootboekrekeningen + accountsForClient()";
  if (read.kind === "loading") return pending("rekeningschema", title, source, REKENINGSCHEMA_LINKS);
  if (read.kind === "error") return failed("rekeningschema", title, source, REKENINGSCHEMA_LINKS, read.message);
  const scoped = accountsForClient(read.value, clientId);
  const actief = scoped.filter((a) => a.actief !== false).length;
  if (scoped.length === 0) {
    return {
      key: "rekeningschema", title, source, links: REKENINGSCHEMA_LINKS, retryable: false,
      status: "geblokkeerd",
      summary: "Er zijn geen grootboekrekeningen die deze administratie mag gebruiken; zonder rekeningen kan niets worden geboekt.",
      details: [],
    };
  }
  return {
    key: "rekeningschema", title, source, links: REKENINGSCHEMA_LINKS, retryable: false,
    status: "in_orde",
    summary: `${plural(scoped.length, "grootboekrekening", "grootboekrekeningen")} beschikbaar voor deze administratie, waarvan ${actief} actief.`,
    details: [],
  };
}

// ── Grootboekinstellingen van de administratie ──────────────────────────────

const INSTELLINGEN_LINKS: EvidenceLink[] = [{ label: "Naar instellingen bij Administraties", to: "/klanten" }];

/**
 * Hergebruikt `computeClientReadiness()` uitsluitend voor de
 * configuratievelden. Die hangen alleen van de administratie zelf af; de
 * documentlijsten worden leeg doorgegeven en de tellingen die daaruit volgen
 * worden hier bewust NIET gebruikt of getoond.
 */
export function instellingenRow(
  read: SourceRead<{ client: Tables<"clients">; accounts: readonly GrootboekSlim[] }>,
): EvidenceRow {
  const title = "Grootboekinstellingen";
  const source = "useClients + computeClientReadiness() (configuratievelden)";
  if (read.kind === "loading") return pending("instellingen", title, source, INSTELLINGEN_LINKS);
  if (read.kind === "error") return failed("instellingen", title, source, INSTELLINGEN_LINKS, read.message);
  const { configMissingReasons } = computeClientReadiness(read.value.client, [], [], [], [], [...read.value.accounts]);
  if (configMissingReasons.length > 0) {
    return {
      key: "instellingen", title, source, links: INSTELLINGEN_LINKS, retryable: false,
      status: "aandacht",
      summary: `${plural(configMissingReasons.length, "instelling ontbreekt", "instellingen ontbreken")} bij deze administratie.`,
      details: configMissingReasons,
    };
  }
  return {
    key: "instellingen", title, source, links: INSTELLINGEN_LINKS, retryable: false,
    status: "in_orde",
    summary: "Dagboeken, debiteuren-, crediteuren-, BTW- en bankrekening zijn ingesteld.",
    details: [],
  };
}

// ── Beginbalans ─────────────────────────────────────────────────────────────

const BEGINBALANS_LINKS: EvidenceLink[] = [{ label: "Naar beginbalans", to: "/grootboek/beginbalans" }];

export function beginbalansRow(read: SourceRead<OpeningBalanceCompleteness>): EvidenceRow {
  const title = "Beginbalans";
  const source = "useOpeningBalanceCompleteness()";
  if (read.kind === "loading") return pending("beginbalans", title, source, BEGINBALANS_LINKS);
  if (read.kind === "error") return failed("beginbalans", title, source, BEGINBALANS_LINKS, read.message);
  const ob = read.value;
  const status: EvidenceStatus =
    ob.severity === "complete" ? "in_orde" : ob.severity === "incomplete" ? "aandacht" : "niet_te_bepalen";
  const jaar = ob.year === null ? "" : ` (boekjaar ${ob.year})`;
  return {
    key: "beginbalans", title, source, links: BEGINBALANS_LINKS, retryable: ob.state === "unknown",
    status,
    summary: `${ob.label}${jaar}.`,
    details: ob.note ? [ob.note] : [],
  };
}

// ── Grootboek- en rapportagevolledigheid ────────────────────────────────────

const VOLLEDIGHEID_LINKS: EvidenceLink[] = [{ label: "Naar grootboeksaldi", to: "/grootboek/saldi" }];

const SOURCE_STATUS_TEXT = {
  complete: "volledig",
  incomplete: "onvolledig",
  empty: "geen postbare documenten",
  unknown: "niet te bepalen",
} as const;

export function volledigheidRow(read: SourceRead<LedgerCompleteness>): EvidenceRow {
  const title = "Grootboek- en rapportagevolledigheid";
  const source = "useLedgerCompleteness()";
  if (read.kind === "loading") return pending("volledigheid", title, source, VOLLEDIGHEID_LINKS);
  if (read.kind === "error") return failed("volledigheid", title, source, VOLLEDIGHEID_LINKS, read.message);
  const c = read.value;
  const details = c.sources.map((s) => {
    const basis = `${s.label}: ${s.posted} van ${s.eligible} geboekt — ${SOURCE_STATUS_TEXT[s.status]}`;
    const geweigerd = s.refused && s.refusedLabel ? `; ${s.refused} ${s.refusedLabel}` : "";
    return basis + geweigerd;
  });
  if (c.sources.some((s) => s.status === "unknown")) {
    return {
      key: "volledigheid", title, source, links: VOLLEDIGHEID_LINKS, retryable: false,
      status: "niet_te_bepalen",
      summary: "Van ten minste één bron is de volledigheid niet vast te stellen.",
      details,
    };
  }
  if (c.mayBeIncomplete) {
    return {
      key: "volledigheid", title, source, links: VOLLEDIGHEID_LINKS, retryable: false,
      status: "aandacht",
      summary: `${plural(c.totalOutstanding, "postbaar document staat", "postbare documenten staan")} nog niet in het grootboek; saldi en rapporten kunnen onvolledig zijn.`,
      details,
    };
  }
  if (c.sources.every((s) => s.status === "empty")) {
    return {
      key: "volledigheid", title, source, links: VOLLEDIGHEID_LINKS, retryable: false,
      status: "informatief",
      summary: "Er zijn nog geen postbare documenten; er is dus ook nog niets in het grootboek te verwachten.",
      details,
    };
  }
  return {
    key: "volledigheid", title, source, links: VOLLEDIGHEID_LINKS, retryable: false,
    status: "in_orde",
    summary: "Alle postbare documenten staan in het grootboek.",
    details,
  };
}

// ── Openstaande historische boekingen (catch-up) ────────────────────────────

const HISTORISCH_LINKS: EvidenceLink[] = [
  { label: "Naar Review", to: "/review" },
  { label: "Naar historische boekingen", to: "/grootboek/historisch" },
];

export function historischRow(read: SourceRead<CatchupSummary>, periodLabel: string): EvidenceRow {
  const title = "Openstaande historische boekingen";
  const source = "useLedgerCatchup() → summarize()";
  if (read.kind === "loading") return pending("historisch", title, source, HISTORISCH_LINKS);
  if (read.kind === "error") return failed("historisch", title, source, HISTORISCH_LINKS, read.message);
  const s = read.value;
  const details = [
    `Klaar om te boeken: ${s.klaar}`,
    `Geblokkeerd: ${s.geblokkeerd}`,
    `Niet te bepalen: ${s.onbekend}`,
    `Geboekt: ${s.geboekt}`,
  ];
  const base = { key: "historisch" as const, title, source, links: HISTORISCH_LINKS, retryable: false, details };
  if (s.totaal === 0) {
    return { ...base, status: "informatief", summary: `Geen inkoop- of verkoopfacturen in ${periodLabel}.` };
  }
  // Volgorde: een concreet beletsel eerst; "niet te bepalen" telt nooit als geblokkeerd.
  if (s.geblokkeerd > 0) {
    return { ...base, status: "geblokkeerd", summary: `${plural(s.geblokkeerd, "factuur is", "facturen zijn")} geblokkeerd voor boeken (${periodLabel}).` };
  }
  if (s.onbekend > 0) {
    return { ...base, status: "niet_te_bepalen", summary: `Van ${plural(s.onbekend, "factuur", "facturen")} is de boekbaarheid niet te bepalen (${periodLabel}).` };
  }
  if (s.klaar > 0) {
    return { ...base, status: "aandacht", summary: `${plural(s.klaar, "factuur is", "facturen zijn")} klaar om te boeken maar nog niet geboekt (${periodLabel}).` };
  }
  return { ...base, status: "in_orde", summary: `Alle ${s.totaal} facturen in ${periodLabel} zijn geboekt.` };
}

// ── Bank ────────────────────────────────────────────────────────────────────

const BANK_LINKS: EvidenceLink[] = [{ label: "Naar Bank", to: "/bank" }];

export interface BankEvidence {
  total: number;
  /** Oudste en nieuwste transactiedatum uit de bestaande bankleeshook; null zonder transacties. */
  firstDate: string | null;
  lastDate: string | null;
  /** De IBAN's die op de administratie zijn vastgelegd. */
  ibans: readonly string[];
}

function nlDatum(iso: string): string {
  const [j, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${j}`;
}

/**
 * Bank is bewust ALTIJD informatief: geen bestaand leesmodel bewijst dat een
 * import volledig is (bijvoorbeeld of een spaarrekening al is ingelezen). Er
 * wordt dus alleen getoond wat er ligt.
 */
export function bankRow(read: SourceRead<BankEvidence>): EvidenceRow {
  const title = "Bankgegevens en import";
  const source = "useClients (ibans) + usePaginatedBankTransactions()";
  if (read.kind === "loading") return pending("bank", title, source, BANK_LINKS);
  if (read.kind === "error") return failed("bank", title, source, BANK_LINKS, read.message);
  const b = read.value;
  const details = [
    b.ibans.length > 0 ? `Vastgelegde IBAN's: ${b.ibans.join(", ")}` : "Geen IBAN vastgelegd bij deze administratie.",
  ];
  const summary =
    b.total === 0
      ? "Nog geen banktransacties geïmporteerd."
      : `${plural(b.total, "banktransactie", "banktransacties")} geïmporteerd` +
        (b.firstDate && b.lastDate ? `, van ${nlDatum(b.firstDate)} t/m ${nlDatum(b.lastDate)}.` : ".");
  return {
    key: "bank", title, source, links: BANK_LINKS, retryable: false,
    status: "informatief",
    summary: `${summary} Of elke rekening volledig is ingelezen, is uit de bestaande gegevens niet af te leiden.`,
    details,
  };
}

/** Telling per toestand over de regels — geen oordeel over de administratie. */
export function countByStatus(rows: readonly EvidenceRow[]): Record<EvidenceStatus, number> {
  const out: Record<EvidenceStatus, number> = {
    in_orde: 0, aandacht: 0, geblokkeerd: 0, niet_te_bepalen: 0, informatief: 0, laden: 0,
  };
  for (const r of rows) out[r.status] += 1;
  return out;
}
