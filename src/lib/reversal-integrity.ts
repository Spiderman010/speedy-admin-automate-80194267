import type { LedgerPostingLike } from "./ledger-reporting";

/**
 * Tegenboekingslineage — zes controles, allemaal LEZEND.
 *
 * Dit is een DIAGNOSE, geen reparatie: er wordt niets geschreven, niets
 * geboekt en niets hersteld. Wat eruit komt is een lijst bevindingen die een
 * mens leest.
 *
 * WAT HIER NIET STAAT, EN WAAROM
 * De controle "een boekingsgroep sluit niet" staat bewust NIET in dit bestand.
 * Die geldt voor élke boekingsgroep en wordt al gedaan door
 * `evaluateLedgerIntegrity()` (`boekingsgroep_niet_in_balans`). Hem hier
 * herhalen zou twee plekken opleveren die hetzelfde beweren en die uit elkaar
 * kunnen gaan lopen — precies wat de diagnostiekconsole moet voorkomen.
 *
 * WAT DE DATABASE AL AFDWINGT
 * De claimtrigger `enforce_reversal_source_claim()` en de partiële unieke index
 * `idx_ledger_postings_reversal_of_posting` maken elk van de toestanden
 * hieronder onbereikbaar via de normale weg. Dit bestand is er voor wat
 * dáárnaast kan ontstaan: gegevens van vóór de migratie, een herstelactie in de
 * SQL-editor, of een toekomstige schrijver die het patroon verkeerd overneemt.
 * Een controle die nooit iets vindt is hier het gewenste resultaat.
 *
 * SCOPE — één administratie
 * De aanroeper geeft de grootboekregels van één administratie mee. Een
 * verwijzing naar een regel buiten die verzameling is daarom niet te
 * onderscheiden van een verwijzing naar een regel die niet bestaat, en de
 * melding zegt dat ook zo. Krijgt deze functie een bredere verzameling, dan
 * wordt kruisverwijzing tussen administraties wél als zodanig herkend.
 */

export type ReversalFindingKind =
  /** 1. De claim wijst naar een oorspronkelijke groep zonder grootboekregels. */
  | "claim_zonder_origineel"
  /** 2. De claim wijst naar een tegenboekingsgroep zonder grootboekregels. */
  | "claim_zonder_tegenboeking"
  /** 3. Een tegenregel verwijst niet naar een bestaande oorspronkelijke regel. */
  | "tegenregel_zonder_origineel"
  /** 4. De tegenregel negeert de oorspronkelijke regel niet exact. */
  | "tegenboeking_negeert_niet_exact"
  /** 5. De lineage loopt over administraties of organisaties heen. */
  | "lineage_buiten_administratie"
  /** 6. Dezelfde oorspronkelijke regel of groep is meer dan eens tegengeboekt. */
  | "dubbele_tegenboeking";

export const REVERSAL_FINDING_TITLES: Readonly<Record<ReversalFindingKind, string>> = {
  claim_zonder_origineel: "Tegenboekingsclaim zonder oorspronkelijke boeking",
  claim_zonder_tegenboeking: "Tegenboekingsclaim zonder tegenboeking",
  tegenregel_zonder_origineel: "Tegenregel zonder oorspronkelijke regel",
  tegenboeking_negeert_niet_exact: "Tegenboeking negeert de oorspronkelijke boeking niet exact",
  lineage_buiten_administratie: "Tegenboeking verwijst buiten de eigen administratie",
  dubbele_tegenboeking: "Dubbele tegenboeking",
};

export interface ReversalFinding {
  kind: ReversalFindingKind;
  /** Waar de bevinding over gaat: een boekingsgroep-id of een regel-id. */
  subject: string;
  detail: string;
  reference: { soort: "boekingsgroep" | "grootboekregel"; id: string };
}

/** Eén rij uit `public.ledger_reversal_postings`. */
export interface ReversalMarkerLike {
  original_posting_group_id: string;
  reversal_posting_group_id: string;
  organization_id: string;
  client_id: string;
  line_count: number;
}

export type ReversalPostingLike = Pick<
  LedgerPostingLike,
  | "id"
  | "client_id"
  | "grootboekrekening_id"
  | "posting_group_id"
  | "debit_amount"
  | "credit_amount"
  | "currency"
  | "source_type"
  | "source_id"
  | "reversal_of_posting_id"
>;

export interface ReversalIntegrityInput {
  markers: readonly ReversalMarkerLike[];
  /** Alle grootboekregels van de administratie; nooit een periodeselectie. */
  postings: readonly ReversalPostingLike[];
}

export interface ReversalIntegrityReport {
  findings: ReversalFinding[];
  /** Hoeveel tegenboekingen er zijn — ook (juist) als er geen bevindingen zijn. */
  reversalCount: number;
  byKind: Record<ReversalFindingKind, number>;
}

/** De bronsoort die de tegenboekingsmotor schrijft. Nergens anders afgeleid. */
export const REVERSAL_SOURCE_TYPE = "reversal";

function emptyByKind(): Record<ReversalFindingKind, number> {
  return {
    claim_zonder_origineel: 0,
    claim_zonder_tegenboeking: 0,
    tegenregel_zonder_origineel: 0,
    tegenboeking_negeert_niet_exact: 0,
    lineage_buiten_administratie: 0,
    dubbele_tegenboeking: 0,
  };
}

/**
 * Exacte centenvergelijking, zoals de rapportagekern. Een tekstuele numeric
 * ("121.00") en een number (121) moeten hetzelfde bedrag zijn; float-gelijkheid
 * zou hier stilzwijgend verkeerde uitkomsten geven.
 */
function cents(value: number | string): number {
  if (typeof value === "number") return Math.round(value * 100);
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(trimmed);
  if (!match) return Number.NaN;
  const [, sign, whole, frac = ""] = match;
  const scaled = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return sign === "-" ? -scaled : scaled;
}

export function evaluateReversalIntegrity(input: ReversalIntegrityInput): ReversalIntegrityReport {
  const findings: ReversalFinding[] = [];

  const rowsPerGroup = new Map<string, ReversalPostingLike[]>();
  for (const row of input.postings) {
    const bucket = rowsPerGroup.get(row.posting_group_id) ?? [];
    bucket.push(row);
    rowsPerGroup.set(row.posting_group_id, bucket);
  }
  const perId = new Map(input.postings.map((r) => [r.id, r]));

  // ── 1 + 2 + 6(groep). Per claim, in een vaste volgorde. ───────────────────
  const gezieneOriginelen = new Set<string>();
  const markers = [...input.markers].sort((a, b) =>
    a.original_posting_group_id.localeCompare(b.original_posting_group_id),
  );

  for (const marker of markers) {
    if (gezieneOriginelen.has(marker.original_posting_group_id)) {
      findings.push({
        kind: "dubbele_tegenboeking",
        subject: marker.original_posting_group_id,
        detail:
          "Deze boekingsgroep wordt door meer dan één tegenboekingsclaim geclaimd; " +
          "een boeking wordt hoogstens één keer tegengeboekt.",
        reference: { soort: "boekingsgroep", id: marker.original_posting_group_id },
      });
      continue;
    }
    gezieneOriginelen.add(marker.original_posting_group_id);

    const origineel = rowsPerGroup.get(marker.original_posting_group_id);
    const tegen = rowsPerGroup.get(marker.reversal_posting_group_id);

    if (!origineel) {
      findings.push({
        kind: "claim_zonder_origineel",
        subject: marker.original_posting_group_id,
        detail:
          "Er is een tegenboeking vastgelegd, maar bij de oorspronkelijke boekingsgroep " +
          "staat geen enkele grootboekregel in deze administratie.",
        reference: { soort: "boekingsgroep", id: marker.original_posting_group_id },
      });
    }

    if (!tegen) {
      findings.push({
        kind: "claim_zonder_tegenboeking",
        subject: marker.reversal_posting_group_id,
        detail:
          "Er is een tegenboeking vastgelegd, maar bij de tegenboekingsgroep staat " +
          "geen enkele grootboekregel in deze administratie.",
        reference: { soort: "boekingsgroep", id: marker.reversal_posting_group_id },
      });
      continue;
    }

    // Structureel: even veel regels als de claim zegt, en even veel als het
    // origineel. Een tegenboeking die regels mist, negeert niet volledig.
    if (tegen.length !== marker.line_count || (origineel && tegen.length !== origineel.length)) {
      findings.push({
        kind: "tegenboeking_negeert_niet_exact",
        subject: marker.reversal_posting_group_id,
        detail:
          `De tegenboeking heeft ${tegen.length} regel(s), terwijl de claim er ${marker.line_count} noemt` +
          (origineel ? ` en de oorspronkelijke boeking er ${origineel.length} heeft.` : "."),
        reference: { soort: "boekingsgroep", id: marker.reversal_posting_group_id },
      });
    }

    if (marker.client_id && tegen.some((r) => r.client_id !== marker.client_id)) {
      findings.push({
        kind: "lineage_buiten_administratie",
        subject: marker.reversal_posting_group_id,
        detail: "De tegenboekingsgroep bevat regels van een andere administratie dan de claim.",
        reference: { soort: "boekingsgroep", id: marker.reversal_posting_group_id },
      });
    }
  }

  // ── 3 + 4 + 5 + 6(regel). Per tegenregel. ─────────────────────────────────
  const tegenregels = input.postings
    .filter((r) => r.source_type === REVERSAL_SOURCE_TYPE)
    .sort((a, b) => a.id.localeCompare(b.id));

  const gezieneOrigineleRegels = new Set<string>();

  for (const row of tegenregels) {
    if (!row.reversal_of_posting_id) {
      findings.push({
        kind: "tegenregel_zonder_origineel",
        subject: row.id,
        detail: "Deze tegenregel verwijst naar geen enkele oorspronkelijke grootboekregel.",
        reference: { soort: "grootboekregel", id: row.id },
      });
      continue;
    }

    if (gezieneOrigineleRegels.has(row.reversal_of_posting_id)) {
      findings.push({
        kind: "dubbele_tegenboeking",
        subject: row.reversal_of_posting_id,
        detail: "Deze oorspronkelijke grootboekregel wordt door meer dan één tegenregel tegengeboekt.",
        reference: { soort: "grootboekregel", id: row.reversal_of_posting_id },
      });
      continue;
    }
    gezieneOrigineleRegels.add(row.reversal_of_posting_id);

    const origineel = perId.get(row.reversal_of_posting_id);
    if (!origineel) {
      findings.push({
        kind: "tegenregel_zonder_origineel",
        subject: row.id,
        detail:
          "Deze tegenregel verwijst naar een grootboekregel die niet in deze administratie bestaat.",
        reference: { soort: "grootboekregel", id: row.id },
      });
      continue;
    }

    if (origineel.client_id !== row.client_id) {
      findings.push({
        kind: "lineage_buiten_administratie",
        subject: row.id,
        detail: "Deze tegenregel verwijst naar een grootboekregel van een andere administratie.",
        reference: { soort: "grootboekregel", id: row.id },
      });
      continue;
    }

    const debet = cents(row.debit_amount);
    const credit = cents(row.credit_amount);
    const origDebet = cents(origineel.debit_amount);
    const origCredit = cents(origineel.credit_amount);

    const rekeningGelijk = row.grootboekrekening_id === origineel.grootboekrekening_id;
    const valutaGelijk = row.currency === origineel.currency;
    const bedragenGewisseld =
      Number.isFinite(debet) &&
      Number.isFinite(credit) &&
      Number.isFinite(origDebet) &&
      Number.isFinite(origCredit) &&
      debet === origCredit &&
      credit === origDebet;

    if (!rekeningGelijk || !valutaGelijk || !bedragenGewisseld) {
      const redenen: string[] = [];
      if (!rekeningGelijk) redenen.push("een andere grootboekrekening");
      if (!valutaGelijk) redenen.push("een andere valuta");
      if (!bedragenGewisseld) redenen.push("debet en credit die niet exact zijn verwisseld");
      findings.push({
        kind: "tegenboeking_negeert_niet_exact",
        subject: row.id,
        detail: `Deze tegenregel heeft ${redenen.join(" en ")} ten opzichte van de oorspronkelijke regel.`,
        reference: { soort: "grootboekregel", id: row.id },
      });
    }
  }

  const byKind = emptyByKind();
  for (const f of findings) byKind[f.kind]++;

  return { findings, reversalCount: markers.length, byKind };
}
