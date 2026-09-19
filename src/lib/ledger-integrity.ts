import { signedAmountCents, type LedgerPostingLike } from "./ledger-reporting";

/**
 * Grootboekintegriteit — vier controles, twee ernstgraden.
 *
 * Dit is een DIAGNOSE, geen reparatie. Er wordt niets geschreven, niets
 * geboekt, niets hersteld en niets gebackfilled: de uitkomst is een lijst
 * bevindingen die een mens leest en waar een mens naar handelt.
 *
 *   1. Gecontroleerde inkoopfactuur + geen persistente regels   → ERROR
 *   2. Legacy-rekeningtekst + geen echte grootboekrekening      → WAARSCHUWING
 *   3. Boekingsmarker + ontbrekende boekingsgroep               → ERROR
 *   4. Boekingsgroep + debet ≠ credit                           → ERROR
 *
 * WAAROM DEZE TWEE GRADEN VERSCHILLEN
 * Een ERROR is een toestand die niet hoort te kunnen bestaan of die het boeken
 * aantoonbaar blokkeert: een goedgekeurde factuur zonder regels kan de writer
 * nooit accepteren, een marker zonder groep betekent dat het grootboek iets
 * claimt wat er niet is, en een groep die niet in balans is breekt de dubbele
 * boekhouding zelf. Een WAARSCHUWING is werk dat nog gedaan moet worden maar
 * niets kapot maakt: oude factuurtekst zonder gekozen rekening.
 *
 * REGEL 4 IS GEEN VERVANGING van de zelfcontrole in `ledger-reporting.ts`. Die
 * laat een rapport fail-closed omvallen zodra een groep niet sluit; deze
 * controle zegt er alleen bij WELKE groep het is, zodat iemand het kan
 * opzoeken. Daarom wordt hier dezelfde `signedAmountCents` gebruikt: hele
 * centen, precies zoals de kern rekent, zodat de twee nooit iets anders
 * kunnen zeggen.
 */

export type IntegritySeverity = "error" | "waarschuwing";

export type IntegrityKind =
  /** 1. Postbare inkoopfactuur zonder opgeslagen boekingsregels. */
  | "factuur_zonder_regels"
  /** 2. Oude rekeningtekst terwijl geen enkele regel een echte rekening heeft. */
  | "legacy_tekst_zonder_rekening"
  /** 3. Een boekingsmarker wijst naar een boekingsgroep die niet bestaat. */
  | "marker_zonder_boekingsgroep"
  /** 4. Binnen één boekingsgroep is de som debet ≠ credit. */
  | "boekingsgroep_niet_in_balans";

export const INTEGRITY_SEVERITY: Readonly<Record<IntegrityKind, IntegritySeverity>> = {
  factuur_zonder_regels: "error",
  legacy_tekst_zonder_rekening: "waarschuwing",
  marker_zonder_boekingsgroep: "error",
  boekingsgroep_niet_in_balans: "error",
};

export const INTEGRITY_TITLES: Readonly<Record<IntegrityKind, string>> = {
  factuur_zonder_regels: "Goedgekeurde factuur zonder boekingsregels",
  legacy_tekst_zonder_rekening: "Oude rekeningtekst zonder gekozen grootboekrekening",
  marker_zonder_boekingsgroep: "Boekingsmarker zonder grootboekregels",
  boekingsgroep_niet_in_balans: "Boekingsgroep is niet in balans",
};

export interface IntegrityFinding {
  kind: IntegrityKind;
  severity: IntegritySeverity;
  /** Waar de bevinding over gaat: factuurnummer, boekingsgroep-id, … */
  subject: string;
  /** Eén zin die zegt wat er aan de hand is. */
  detail: string;
  /** Id van het onderliggende record, voor een doorverwijzing. */
  reference: { soort: "inkoopfactuur" | "boekingsgroep"; id: string };
}

/** Exact de statussen die `post_purchase_invoice()` accepteert. */
export const INTEGRITY_POSTABLE_PURCHASE_STATUSES = ["gecontroleerd", "betaald", "geexporteerd"] as const;

export interface IntegrityPurchaseInvoice {
  id: string;
  status: string;
  invoice_number: string | null;
  supplier: string | null;
  ledger_account_text: string | null;
}

export interface IntegrityLine {
  purchase_invoice_id: string;
  grootboekrekening_id: string | null;
}

export interface IntegrityMarker {
  /** Welke soort brondocument deze marker claimt. */
  soort: "inkoop" | "verkoop" | "bank" | "memoriaal";
  posting_group_id: string;
}

export interface LedgerIntegrityInput {
  purchaseInvoices: readonly IntegrityPurchaseInvoice[];
  purchaseLines: readonly IntegrityLine[];
  markers: readonly IntegrityMarker[];
  postings: readonly LedgerPostingLike[];
}

export interface LedgerIntegrityReport {
  findings: IntegrityFinding[];
  errorCount: number;
  warningCount: number;
  /** Aantallen per soort, ook wanneer nul — zodat een schoon rapport dat toont. */
  byKind: Record<IntegrityKind, number>;
}

function emptyByKind(): Record<IntegrityKind, number> {
  return {
    factuur_zonder_regels: 0,
    legacy_tekst_zonder_rekening: 0,
    marker_zonder_boekingsgroep: 0,
    boekingsgroep_niet_in_balans: 0,
  };
}

const MARKER_LABEL: Readonly<Record<IntegrityMarker["soort"], string>> = {
  inkoop: "inkoopfactuur",
  verkoop: "verkoopfactuur",
  bank: "bankkoppeling",
  memoriaal: "memoriaalboeking",
};

function factuurAanduiding(invoice: IntegrityPurchaseInvoice): string {
  const nummer = invoice.invoice_number?.trim();
  const leverancier = invoice.supplier?.trim();
  if (nummer && leverancier) return `${nummer} — ${leverancier}`;
  return nummer || leverancier || invoice.id;
}

export function evaluateLedgerIntegrity(input: LedgerIntegrityInput): LedgerIntegrityReport {
  const findings: IntegrityFinding[] = [];

  // ── Regels per inkoopfactuur ──────────────────────────────────────────────
  const regelsPerFactuur = new Map<string, IntegrityLine[]>();
  for (const line of input.purchaseLines) {
    const bucket = regelsPerFactuur.get(line.purchase_invoice_id) ?? [];
    bucket.push(line);
    regelsPerFactuur.set(line.purchase_invoice_id, bucket);
  }

  for (const invoice of input.purchaseInvoices) {
    const regels = regelsPerFactuur.get(invoice.id) ?? [];
    const postbaar = (INTEGRITY_POSTABLE_PURCHASE_STATUSES as readonly string[]).includes(invoice.status);

    // 1. Goedgekeurd maar geen enkele opgeslagen regel. Een factuur op
    //    'te_controleren' hoort nog geen regels te hebben; die is gewoon nog
    //    niet verwerkt en is dus géén bevinding.
    if (postbaar && regels.length === 0) {
      findings.push({
        kind: "factuur_zonder_regels",
        severity: INTEGRITY_SEVERITY.factuur_zonder_regels,
        subject: factuurAanduiding(invoice),
        detail:
          `Status is '${invoice.status}', maar er staan geen boekingsregels in de database. ` +
          "De boekingsfunctie weigert deze factuur.",
        reference: { soort: "inkoopfactuur", id: invoice.id },
      });
    }

    // 2. Oude rekeningtekst terwijl geen enkele regel een echte rekening
    //    draagt. Werk dat nog moet gebeuren, geen kapotte toestand.
    const heeftEchteRekening = regels.some((l) => !!l.grootboekrekening_id);
    if (invoice.ledger_account_text?.trim() && !heeftEchteRekening) {
      findings.push({
        kind: "legacy_tekst_zonder_rekening",
        severity: INTEGRITY_SEVERITY.legacy_tekst_zonder_rekening,
        subject: factuurAanduiding(invoice),
        detail:
          `De factuur draagt de tekst "${invoice.ledger_account_text.trim()}", maar geen enkele boekingsregel ` +
          "heeft een gekozen grootboekrekening. Tekst is geen rekening.",
        reference: { soort: "inkoopfactuur", id: invoice.id },
      });
    }
  }

  // ── Boekingsgroepen ───────────────────────────────────────────────────────
  const saldoPerGroep = new Map<string, number>();
  for (const row of input.postings) {
    const huidig = saldoPerGroep.get(row.posting_group_id) ?? 0;
    saldoPerGroep.set(row.posting_group_id, huidig + signedAmountCents(row));
  }

  // 3. Een marker claimt een boekingsgroep die niet bestaat. De triggers in de
  //    database bewaken de ándere richting (grootboekregels zonder marker);
  //    deze kant is nergens afgedwongen.
  for (const marker of input.markers) {
    if (!saldoPerGroep.has(marker.posting_group_id)) {
      findings.push({
        kind: "marker_zonder_boekingsgroep",
        severity: INTEGRITY_SEVERITY.marker_zonder_boekingsgroep,
        subject: marker.posting_group_id,
        detail:
          `Een ${MARKER_LABEL[marker.soort]} is gemarkeerd als geboekt, maar bij deze boekingsgroep ` +
          "staat geen enkele grootboekregel.",
        reference: { soort: "boekingsgroep", id: marker.posting_group_id },
      });
    }
  }

  // 4. Debet ≠ credit binnen één groep — de dubbele boekhouding zelf.
  //    Gesorteerd, zodat de uitkomst niet van de rijvolgorde afhangt.
  for (const groupId of [...saldoPerGroep.keys()].sort()) {
    const saldo = saldoPerGroep.get(groupId)!;
    if (saldo !== 0) {
      findings.push({
        kind: "boekingsgroep_niet_in_balans",
        severity: INTEGRITY_SEVERITY.boekingsgroep_niet_in_balans,
        subject: groupId,
        detail: `Debet en credit verschillen ${Math.abs(saldo)} cent binnen deze boekingsgroep.`,
        reference: { soort: "boekingsgroep", id: groupId },
      });
    }
  }

  const byKind = emptyByKind();
  let errorCount = 0;
  let warningCount = 0;
  for (const f of findings) {
    byKind[f.kind]++;
    if (f.severity === "error") errorCount++;
    else warningCount++;
  }

  return { findings, errorCount, warningCount, byKind };
}
