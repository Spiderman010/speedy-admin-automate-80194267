import {
  CATCHUP_PURCHASE_POSTABLE_STATUSES,
  CATCHUP_SALES_POSTABLE_STATUSES,
  type CatchupBlock,
  type CatchupRecord,
} from "./ledger-catchup";
import { INTEGRITY_TITLES, type IntegrityFinding } from "./ledger-integrity";
import { isClassified } from "./reporting-classification";
import { signedAmountCents, type LedgerPostingLike } from "./ledger-reporting";

/**
 * Accounting Diagnostics — één model, geen tweede regelset.
 *
 * Dit bestand BEDENKT GEEN BOEKHOUDREGELS. Alles wat hier binnenkomt is al
 * beoordeeld door bestaande logica:
 *
 *   • `evaluatePurchaseInvoice()` / `evaluateSalesInvoice()` (ledger-catchup.ts)
 *     — één-op-één de guards van `post_purchase_invoice()` en
 *     `post_sales_invoice()`;
 *   • `evaluateLedgerIntegrity()` (ledger-integrity.ts) — de vier
 *     integriteitscontroles uit /grootboek/integriteit;
 *   • `isClassified()` (reporting-classification.ts) — uitsluitend de twee
 *     expliciete velden, nooit een rekeningnummer of `categorie`;
 *   • `signedAmountCents()` (ledger-reporting.ts) — hele centen, zoals de kern.
 *
 * Wat hier WEL gebeurt: die uitkomsten vertalen naar één gedeeld item-model met
 * één centrale ernstladder, en twee dingen toevoegen die geen van de bestaande
 * lagen kende omdat ze daar niet thuishoorden: "klaar maar nog niet geboekt"
 * (werk, geen bederf) en "rekening met activiteit zonder classificatie".
 *
 * Zou iemand hier een regel bijschrijven die de writers niet kennen, dan gaan
 * de diagnose en de werkelijkheid uit elkaar lopen. Dat is precies wat dit
 * bestand moet voorkomen.
 */

export type DiagnosticSeverity = "ok" | "warning" | "error";

export type DiagnosticDomain = "purchase" | "sales" | "ledger";

export interface DiagnosticItem {
  code: string;
  severity: DiagnosticSeverity;
  domain: DiagnosticDomain;
  recordId?: string;
  reference?: string;
  message: string;
  targetUrl?: string;
}

/**
 * DE ERNSTLADDER, één keer vastgelegd.
 *
 *   error   — een gebroken invariant, of een toestand die het boeken
 *             aantoonbaar blokkeert. Iets is stuk of kan nooit slagen.
 *   warning — open werk of ontbrekende inrichting. Niets is stuk; er moet nog
 *             iets gebeuren.
 *   ok      — een gezonde, afgeronde toestand.
 *
 * Geen enkel component mag hier zelf een ernst aan toekennen; alles loopt via
 * de functies hieronder.
 */

/** Codes die altijd "open werk" zijn, ongeacht de status van het document. */
const ALTIJD_WAARSCHUWING = new Set<string>([
  // De factuur is nog niet goedgekeurd. Dat is de normale gang van zaken.
  "status_niet_postbaar",
]);

/** Codes die altijd een gebroken toestand zijn. */
const ALTIJD_ERROR = new Set<string>([
  // Boeken in een afgesloten jaar mag niet en wordt nooit toegestaan.
  "boekjaar_afgesloten",
]);

/**
 * De ernst van één blokkade uit `evaluatePurchase/SalesInvoice()`.
 *
 * De kern van de afweging: een document dat nog in bewerking is (niet-postbare
 * status) is niet kapot — daar wordt nog aan gewerkt. Hetzelfde gebrek op een
 * GOEDGEKEURDE factuur is wél een fout: die is af verklaard terwijl de writer
 * hem voorspelbaar weigert.
 *
 * Ontbrekende administratie-instellingen zijn nooit bederf: de factuur klopt,
 * de inrichting is nog niet af.
 */
export function severityForBlock(block: CatchupBlock, isPostableStatus: boolean): DiagnosticSeverity {
  if (ALTIJD_ERROR.has(block.code)) return "error";
  if (ALTIJD_WAARSCHUWING.has(block.code)) return "warning";
  if (block.configuratie) return "warning";
  return isPostableStatus ? "error" : "warning";
}

export function isPostablePurchaseStatus(status: string): boolean {
  return (CATCHUP_PURCHASE_POSTABLE_STATUSES as readonly string[]).includes(status);
}

export function isPostableSalesStatus(status: string): boolean {
  return (CATCHUP_SALES_POSTABLE_STATUSES as readonly string[]).includes(status);
}

/** De ernst van een bevinding uit de integriteitscontrole. */
export function severityForIntegrityFinding(finding: IntegrityFinding): DiagnosticSeverity {
  return finding.severity === "error" ? "error" : "warning";
}

export interface DocumentDiagnosticsInput {
  records: readonly CatchupRecord[];
  /** Boekingsgroepen die werkelijk grootboekregels hebben. */
  existingPostingGroups: ReadonlySet<string>;
  /** Boekingsgroepen waarvan debet en credit gelijk zijn. */
  balancedPostingGroups: ReadonlySet<string>;
}

function targetForRecord(record: CatchupRecord): string | undefined {
  // Alleen bestaande routes. Voor verkoop bestaat geen detailroute per factuur;
  // het overzicht is wat er is, en een verzonnen URL is erger dan geen URL.
  return record.source === "inkoop" ? `/facturen/inkoop/${record.id}` : "/verkoop";
}

/**
 * Eén document → nul of meer diagnostische items.
 *
 * Alle blokkades komen ongewijzigd uit de bestaande beoordeling; hier wordt
 * alleen de ernst bepaald en de bestemming toegevoegd. Daarnaast twee
 * toestanden die de beoordeling niet kent omdat ze over de KETEN gaan en niet
 * over het document: klaar-maar-niet-geboekt, en geboekt-en-sluitend.
 */
export function diagnosticsForDocument(
  record: CatchupRecord,
  input: Pick<DocumentDiagnosticsInput, "existingPostingGroups" | "balancedPostingGroups">,
): DiagnosticItem[] {
  const domain: DiagnosticDomain = record.source === "inkoop" ? "purchase" : "sales";
  const postable =
    record.source === "inkoop"
      ? isPostablePurchaseStatus(record.documentStatus)
      : isPostableSalesStatus(record.documentStatus);
  const targetUrl = targetForRecord(record);
  const basis = { domain, recordId: record.id, reference: record.reference, targetUrl };

  if (record.state === "geboekt") {
    const groupId = record.postingGroupId!;
    // De marker claimt een groep die niet bestaat. Dit is dezelfde bevinding
    // als in /grootboek/integriteit; hier hangt zij aan het document, zodat je
    // ziet wélke factuur het betreft.
    if (!input.existingPostingGroups.has(groupId)) {
      return [{
        ...basis,
        code: "marker_zonder_boekingsgroep",
        severity: "error",
        message: `Gemarkeerd als geboekt, maar boekingsgroep ${groupId} heeft geen grootboekregels.`,
      }];
    }
    if (!input.balancedPostingGroups.has(groupId)) {
      return [{
        ...basis,
        code: "geboekt_maar_groep_niet_in_balans",
        severity: "error",
        message: `Geboekt, maar boekingsgroep ${groupId} is niet in balans.`,
      }];
    }
    return [{
      ...basis,
      code: "geboekt_en_sluitend",
      severity: "ok",
      message: "Geboekt, met een sluitende boekingsgroep.",
    }];
  }

  if (record.state === "klaar") {
    return [{
      ...basis,
      code: "klaar_niet_geboekt",
      severity: "warning",
      message: "Klaar maar nog niet geboekt.",
    }];
  }

  return record.blocks.map((block) => ({
    ...basis,
    code: block.code,
    severity: severityForBlock(block, postable),
    message: block.label,
  }));
}

export interface LedgerDiagnosticsAccount {
  id: string;
  nummer: number;
  omschrijving: string;
  /** `null` = organisatiebreed. */
  client_id: string | null;
  statement_type: string | null;
  report_group: string | null;
}

export interface LedgerDiagnosticsInput {
  /** De bevindingen uit /grootboek/integriteit, ongewijzigd. */
  integrityFindings: readonly IntegrityFinding[];
  postings: readonly LedgerPostingLike[];
  accounts: readonly LedgerDiagnosticsAccount[];
  clientId: string;
  /** Boekingsgroep → hoeveel markers hem claimen. */
  markerClaimsPerGroup: ReadonlyMap<string, number>;
}

/** Boekingsgroep → saldo in hele centen. Gedeeld door meerdere controles. */
export function postingGroupBalances(postings: readonly LedgerPostingLike[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const row of postings) {
    per.set(row.posting_group_id, (per.get(row.posting_group_id) ?? 0) + signedAmountCents(row));
  }
  return per;
}

export function diagnosticsForLedger(input: LedgerDiagnosticsInput): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  // 1 + 2. Onbalans en wezen komen ongewijzigd uit de bestaande controle.
  for (const finding of input.integrityFindings) {
    if (finding.reference.soort !== "boekingsgroep") continue;
    items.push({
      code: finding.kind,
      severity: severityForIntegrityFinding(finding),
      domain: "ledger",
      recordId: finding.reference.id,
      reference: finding.subject,
      message: `${INTEGRITY_TITLES[finding.kind]}: ${finding.detail}`,
      targetUrl: "/grootboek/integriteit",
    });
  }

  // 3. Twee markers die dezelfde boekingsgroep claimen. Elke groep hoort bij
  //    precies één brondocument; meer betekent dat één document een groep
  //    claimt die niet van hem is.
  for (const [groupId, claims] of input.markerClaimsPerGroup) {
    if (claims > 1) {
      items.push({
        code: "dubbele_groepsclaim",
        severity: "error",
        domain: "ledger",
        recordId: groupId,
        reference: groupId,
        message: `Boekingsgroep ${groupId} wordt door ${claims} boekingsmarkers geclaimd; een groep hoort bij één document.`,
        targetUrl: "/grootboek/integriteit",
      });
    }
  }

  // 4 + 5. Verwijst een grootboekregel naar een rekening die niet bestaat, of
  //        naar een rekening van een ándere administratie? Beide zijn uit de
  //        opgeslagen rijen af te lezen en beide breken de boeking.
  const perId = new Map(input.accounts.map((a) => [a.id, a]));
  const onbekend = new Set<string>();
  const buitenBereik = new Set<string>();
  for (const row of input.postings) {
    const account = perId.get(row.grootboekrekening_id);
    if (!account) onbekend.add(row.grootboekrekening_id);
    else if (account.client_id !== null && account.client_id !== input.clientId) {
      buitenBereik.add(account.id);
    }
  }
  for (const id of [...onbekend].sort()) {
    items.push({
      code: "regel_zonder_bestaande_rekening",
      severity: "error",
      domain: "ledger",
      recordId: id,
      reference: id,
      message: `Grootboekregels verwijzen naar rekening ${id}, die niet in het rekeningschema staat.`,
    });
  }
  for (const id of [...buitenBereik].sort()) {
    const account = perId.get(id)!;
    items.push({
      code: "rekening_buiten_administratie",
      severity: "error",
      domain: "ledger",
      recordId: id,
      reference: `${account.nummer} - ${account.omschrijving}`,
      message: "Er is geboekt op een rekening die bij een andere administratie hoort.",
      targetUrl: `/grootboek/saldi/${id}`,
    });
  }

  // 6. Rekeningen mét grootboekactiviteit maar zonder volledige
  //    rapportageclassificatie. Uitsluitend de expliciete velden — nooit een
  //    rekeningnummer, nooit `categorie`. Dit is open werk, geen bederf: de
  //    bedragen kloppen, ze hebben alleen nog geen plaats in balans of W&V.
  const metActiviteit = new Set(input.postings.map((r) => r.grootboekrekening_id));
  const ongeclassificeerd = [...metActiviteit]
    .map((id) => perId.get(id))
    .filter((a): a is LedgerDiagnosticsAccount => !!a && !isClassified(a))
    .sort((a, b) => a.nummer - b.nummer);
  for (const account of ongeclassificeerd) {
    items.push({
      code: "activiteit_zonder_classificatie",
      severity: "warning",
      domain: "ledger",
      recordId: account.id,
      reference: `${account.nummer} - ${account.omschrijving}`,
      message: "Heeft grootboekactiviteit maar nog geen volledige rapportageclassificatie; telt niet mee in balans of W&V.",
      targetUrl: `/grootboek/saldi/${account.id}`,
    });
  }

  return items;
}

// ── Samenvatting ────────────────────────────────────────────────────────────

export interface DomainSummary {
  total: number;
  posted: number;
  ready: number;
  blocked: number;
  errors: number;
  warnings: number;
  /** Per code, zodat het overzicht exact hetzelfde telt als de detailtabs. */
  byCode: Record<string, number>;
}

/**
 * De samenvatting wordt AFGELEID uit dezelfde items als de detailtabs. Er is
 * geen tweede telling die kan gaan afwijken — dat is de hele reden dat deze
 * functie de items als invoer neemt en niet de ruwe data.
 */
export function summarizeDiagnostics(
  items: readonly DiagnosticItem[],
  records: readonly CatchupRecord[],
): DomainSummary {
  const byCode: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const item of items) {
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
    if (item.severity === "error") errors++;
    else if (item.severity === "warning") warnings++;
  }
  let posted = 0;
  let ready = 0;
  let blocked = 0;
  for (const r of records) {
    if (r.state === "geboekt") posted++;
    else if (r.state === "klaar") ready++;
    else blocked++;
  }
  return { total: records.length, posted, ready, blocked, errors, warnings, byCode };
}

export interface LedgerSummary {
  postingGroups: number;
  balancedGroups: number;
  unbalancedGroups: number;
  orphanMarkers: number;
  accountsMissingClassification: number;
  errors: number;
  warnings: number;
}

export function summarizeLedger(
  items: readonly DiagnosticItem[],
  balances: ReadonlyMap<string, number>,
): LedgerSummary {
  let errors = 0;
  let warnings = 0;
  let orphanMarkers = 0;
  let accountsMissingClassification = 0;
  for (const item of items) {
    if (item.severity === "error") errors++;
    else if (item.severity === "warning") warnings++;
    if (item.code === "marker_zonder_boekingsgroep") orphanMarkers++;
    if (item.code === "activiteit_zonder_classificatie") accountsMissingClassification++;
  }
  let balanced = 0;
  let unbalanced = 0;
  for (const saldo of balances.values()) {
    if (saldo === 0) balanced++;
    else unbalanced++;
  }
  return {
    postingGroups: balances.size,
    balancedGroups: balanced,
    unbalancedGroups: unbalanced,
    orphanMarkers,
    accountsMissingClassification,
    errors,
    warnings,
  };
}
