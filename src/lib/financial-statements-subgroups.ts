/**
 * Het tweede taxonomieniveau zichtbaar maken in Balans en W&V.
 *
 * WAT DIT WEL DOET
 * De regels die de engine al heeft berekend OPDELEN in secties per
 * `report_subgroup`. Meer niet.
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen enkel bedrag herrekenen, geen saldo bepalen, geen teken omklappen, geen
 * regel weglaten en geen regel herordenen. `FinancialStatementGroup.totalCents`
 * gaat ONGEWIJZIGD door; de subtotalen zijn sommen van precies dezelfde
 * `displayedCents` die de engine al optelde (`financial-statements.ts`, waar
 * `totalCents` letterlijk `lines.reduce((s, l) => s + l.displayedCents, 0)` is).
 * De partitie is uitputtend en disjunct, dus Σ subtotalen = groepstotaal geldt
 * per constructie — en `totalsMatch` controleert dat alsnog, zodat een fout
 * zichtbaar wordt in plaats van stil een cent te verplaatsen.
 *
 * GEEN REKENING VERDWIJNT
 * Elke regel van de groep komt in precies één sectie terecht. Een rekening
 * zonder groep, met een onbekende groep, of met een groep die niet bij haar
 * categorie hoort, valt in de sectie "Nog niet ingedeeld" — nooit buiten beeld.
 *
 * ER WORDT NIETS AFGELEID
 * Geen rekeningnummer, geen naamfragment, geen `categorie`. De indeling komt
 * uitsluitend uit de opgeslagen `report_subgroup`.
 */

import type {
  FinancialStatementAccountLine,
  FinancialStatementGroup,
} from "./financial-statements";
import {
  REPORT_SUBGROUP_LABELS,
  SUBGROUP_CLUSTER_LABELS,
  isSubgroupAllowed,
  subgroupsFor,
  type ReportGroup,
  type ReportSubgroup,
} from "./reporting-classification";

/** De sleutel van de vangnetsectie. Geen taxonomiewaarde, dus niet botsend. */
export const UNASSIGNED_SUBGROUP_KEY = "__unassigned__";
export const UNASSIGNED_SUBGROUP_LABEL = "Nog niet ingedeeld";

export interface StatementSubgroupSection {
  /** Een `ReportSubgroup`, of `UNASSIGNED_SUBGROUP_KEY`. */
  key: string;
  label: string;
  /**
   * Alleen presentatie: het tussenkopje waaronder deze groep hoort
   * (Huisvestingskosten, Verkoopkosten, Autokosten, Kantoorkosten). Wordt
   * nergens opgeslagen en is geen derde taxonomieniveau.
   */
  clusterLabel: string | null;
  /** De vangnetsectie: categorie bekend, groep (nog) niet. */
  isFallback: boolean;
  /** De regels van de engine, in de volgorde van de engine. */
  lines: FinancialStatementAccountLine[];
  /** Som van `displayedCents` van precies deze regels. */
  subtotalCents: number;
}

export interface StatementGroupSections {
  /** De groep van de engine, ongewijzigd doorgegeven. */
  group: FinancialStatementGroup;
  sections: StatementSubgroupSection[];
  /**
   * Is er werkelijk iets in te delen? `false` betekent: één vangnetsectie met
   * alles erin — dan heeft een tweede niveau tonen geen betekenis en blijft de
   * tabel precies zoals zij was.
   */
  hasSubgroups: boolean;
  /** Zelfcontrole: Σ subtotalen === group.totalCents. */
  totalsMatch: boolean;
}

/** De opgeslagen velden die deze laag nodig heeft; meer leest zij niet. */
export interface SubgroupAccountLike {
  id: string;
  report_subgroup?: string | null;
}

/**
 * De kaart rekening-id → opgeslagen subgroep. Een rekening die niet in de
 * lijst staat, of die geen subgroep heeft, levert `null` — en belandt dus in
 * het vangnet.
 */
export function buildSubgroupIndex(
  accounts: readonly SubgroupAccountLike[],
): ReadonlyMap<string, string | null> {
  const index = new Map<string, string | null>();
  for (const account of accounts) {
    index.set(account.id, account.report_subgroup ?? null);
  }
  return index;
}

/**
 * Eén groep opdelen.
 *
 * De sectievolgorde is die van de taxonomie zelf (`subgroupsFor`), niet die van
 * het toeval: zo staat "Liquide middelen" altijd op dezelfde plek binnen
 * Vlottende activa, ongeacht welke rekening er als eerste in het rapport
 * opdook. Binnen een sectie blijft de volgorde van de engine staan, die op
 * `report_sort` en daarna rekeningnummer sorteert — daar wordt niets aan
 * veranderd. Het vangnet staat altijd achteraan.
 */
export function subgroupSectionsFor(
  group: FinancialStatementGroup,
  subgroupByAccountId: ReadonlyMap<string, string | null>,
): StatementGroupSections {
  const perSubgroup = new Map<ReportSubgroup, FinancialStatementAccountLine[]>();
  const fallback: FinancialStatementAccountLine[] = [];

  for (const line of group.lines) {
    const stored = subgroupByAccountId.get(line.accountId) ?? null;
    // Een onbekende of niet-passende waarde is GEEN geldige indeling, maar mag
    // de regel evenmin laten verdwijnen: zij valt in het vangnet.
    if (stored !== null && isSubgroupAllowed(group.key as ReportGroup, stored)) {
      const key = stored as ReportSubgroup;
      const bestaand = perSubgroup.get(key);
      if (bestaand) bestaand.push(line);
      else perSubgroup.set(key, [line]);
    } else {
      fallback.push(line);
    }
  }

  const sections: StatementSubgroupSection[] = [];
  for (const key of subgroupsFor(group.key as ReportGroup)) {
    const lines = perSubgroup.get(key);
    // Een lege subgroep krijgt geen kopje: een rapport toont wat er is.
    if (!lines) continue;
    sections.push({
      key,
      label: REPORT_SUBGROUP_LABELS[key],
      clusterLabel: SUBGROUP_CLUSTER_LABELS[key] ?? null,
      isFallback: false,
      lines,
      subtotalCents: sumDisplayed(lines),
    });
  }

  if (fallback.length > 0) {
    sections.push({
      key: UNASSIGNED_SUBGROUP_KEY,
      label: UNASSIGNED_SUBGROUP_LABEL,
      clusterLabel: null,
      isFallback: true,
      lines: fallback,
      subtotalCents: sumDisplayed(fallback),
    });
  }

  const hasSubgroups = sections.some((s) => !s.isFallback);

  return {
    group,
    sections,
    hasSubgroups,
    totalsMatch: sumSubtotals(sections) === group.totalCents,
  };
}

export function subgroupSectionsForGroups(
  groups: readonly FinancialStatementGroup[],
  accounts: readonly SubgroupAccountLike[],
): StatementGroupSections[] {
  const index = buildSubgroupIndex(accounts);
  return groups.map((group) => subgroupSectionsFor(group, index));
}

/**
 * Wordt er in dit rapport überhaupt iets ingedeeld? Zo niet — de toestand
 * vandaag, waarin niemand nog een groep heeft gekozen — dan blijft de tabel
 * ongewijzigd en verschijnt er geen leeg tweede niveau.
 */
export function anySubgroupsPresent(sections: readonly StatementGroupSections[]): boolean {
  return sections.some((s) => s.hasSubgroups);
}

/** Elke regel van de groep komt precies één keer terug. */
export function sectionsCoverAllLines(sections: StatementGroupSections): boolean {
  const ids: string[] = [];
  for (const section of sections.sections) {
    for (const line of section.lines) ids.push(line.accountId);
  }
  if (ids.length !== sections.group.lines.length) return false;
  const uniek = new Set(ids);
  if (uniek.size !== ids.length) return false;
  for (const line of sections.group.lines) {
    if (!uniek.has(line.accountId)) return false;
  }
  return true;
}

function sumDisplayed(lines: readonly FinancialStatementAccountLine[]): number {
  let totaal = 0;
  for (const line of lines) totaal += line.displayedCents;
  return totaal;
}

function sumSubtotals(sections: readonly StatementSubgroupSection[]): number {
  let totaal = 0;
  for (const section of sections) totaal += section.subtotalCents;
  return totaal;
}
