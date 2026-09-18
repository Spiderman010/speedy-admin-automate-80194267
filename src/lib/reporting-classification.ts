/**
 * Balans/W&V PR 2 — rapportageclassificatie van een grootboekrekening.
 *
 * Pure regels boven de vier live schemavelden die PR 1 heeft toegevoegd:
 * `statement_type`, `report_group`, `normal_side` en `report_sort`. Geen query,
 * geen Supabase, geen React: alleen de toestandsregels, de validatie en de
 * payload. De database blijft gezaghebbend — dezelfde regels staan daar als
 * CHECK-constraints (grootboekrekeningen_reporting_pair_check en zusjes); dit
 * bestand zorgt dat een ongeldige combinatie de deur niet eens uit gaat.
 *
 * `categorie` komt in dit bestand niet voor en wordt nergens gelezen: er wordt
 * NIETS afgeleid uit nummer, omschrijving, categorie of rekeningbereik. Een
 * classificatie ontstaat uitsluitend doordat iemand haar invult.
 */

export type StatementType = "balans" | "winst_verlies";
export type NormalSide = "debet" | "credit";

export const BALANS_GROUPS = [
  "vaste_activa",
  "vlottende_activa",
  "eigen_vermogen",
  "voorzieningen",
  "langlopende_schulden",
  "kortlopende_schulden",
  "prive",
] as const;

export const WINST_VERLIES_GROUPS = [
  "netto_omzet",
  "kostprijs_omzet",
  "personeelskosten",
  "afschrijvingen",
  "overige_bedrijfskosten",
  "financiele_baten_lasten",
  "belastingen",
  "overig_resultaat",
] as const;

export type BalansGroup = (typeof BALANS_GROUPS)[number];
export type WinstVerliesGroup = (typeof WINST_VERLIES_GROUPS)[number];
export type ReportGroup = BalansGroup | WinstVerliesGroup;

export const STATEMENT_TYPE_LABELS: Readonly<Record<StatementType, string>> = {
  balans: "Balans",
  winst_verlies: "Winst-en-verliesrekening",
};

/** Kort label voor de tabel; het volledige label is voor het formulier. */
export const STATEMENT_TYPE_SHORT_LABELS: Readonly<Record<StatementType, string>> = {
  balans: "Balans",
  winst_verlies: "W&V",
};

export const REPORT_GROUP_LABELS: Readonly<Record<ReportGroup, string>> = {
  vaste_activa: "Vaste activa",
  vlottende_activa: "Vlottende activa",
  eigen_vermogen: "Eigen vermogen",
  voorzieningen: "Voorzieningen",
  langlopende_schulden: "Langlopende schulden",
  kortlopende_schulden: "Kortlopende schulden",
  prive: "Privé",
  netto_omzet: "Netto-omzet",
  kostprijs_omzet: "Kostprijs omzet",
  personeelskosten: "Personeelskosten",
  afschrijvingen: "Afschrijvingen",
  overige_bedrijfskosten: "Overige bedrijfskosten",
  financiele_baten_lasten: "Financiële baten en lasten",
  belastingen: "Belastingen",
  overig_resultaat: "Overig resultaat",
};

export const NORMAL_SIDE_LABELS: Readonly<Record<NormalSide, string>> = {
  debet: "Debet",
  credit: "Credit",
};

export const UNCLASSIFIED_LABEL = "Niet geclassificeerd";
export const CLASSIFIED_LABEL = "Geclassificeerd";

/**
 * Radix Select kan geen lege string als waarde dragen, dus krijgen "geen
 * keuze" en "niet geclassificeerd" een expliciete sentinel. Die sentinel
 * bestaat alleen in het formulier en wordt nooit opgeslagen.
 */
export const NONE_VALUE = "__none__";

export function isStatementType(value: unknown): value is StatementType {
  return value === "balans" || value === "winst_verlies";
}

export function isNormalSide(value: unknown): value is NormalSide {
  return value === "debet" || value === "credit";
}

export function isReportGroup(value: unknown): value is ReportGroup {
  return (
    (BALANS_GROUPS as readonly string[]).includes(value as string) ||
    (WINST_VERLIES_GROUPS as readonly string[]).includes(value as string)
  );
}

/** De groepen die bij één overzicht horen; zonder overzicht is er geen keuze. */
export function groupsFor(statementType: StatementType | null): readonly ReportGroup[] {
  if (statementType === "balans") return BALANS_GROUPS;
  if (statementType === "winst_verlies") return WINST_VERLIES_GROUPS;
  return [];
}

/** Hoort deze groep bij dit overzicht? Onbekende combinaties zijn nooit geldig. */
export function isGroupAllowed(statementType: StatementType | null, group: unknown): boolean {
  if (statementType === null) return false;
  return (groupsFor(statementType) as readonly string[]).includes(group as string);
}

/** Het bewerkbare deel van het formulier dat over classificatie gaat. */
export interface ClassificationForm {
  statementType: StatementType | null;
  reportGroup: ReportGroup | null;
  normalSide: NormalSide | null;
  /** Ruwe tekst uit het invoerveld: "" betekent leeg (NULL), niet 0. */
  reportSort: string;
}

export const EMPTY_CLASSIFICATION: ClassificationForm = {
  statementType: null,
  reportGroup: null,
  normalSide: null,
  reportSort: "",
};

/** De opgeslagen velden van een rekening, zoals de database ze teruggeeft. */
export interface StoredClassification {
  statement_type?: string | null;
  report_group?: string | null;
  normal_side?: string | null;
  report_sort?: number | null;
}

/**
 * Databasewaarden → formulier. Een waarde die niet (meer) tot het domein
 * behoort, wordt niet stilzwijgend overgenomen: ze wordt leeg getoond, zodat
 * niemand per ongeluk een onbekende combinatie opnieuw opslaat.
 */
export function classificationFromAccount(account: StoredClassification | null | undefined): ClassificationForm {
  if (!account) return { ...EMPTY_CLASSIFICATION };
  const statementType = isStatementType(account.statement_type) ? account.statement_type : null;
  const storedGroup = isReportGroup(account.report_group) ? account.report_group : null;
  return {
    statementType,
    // Een groep zonder passend overzicht is per definitie ongeldig (de
    // database staat hem niet toe); hij wordt dus niet geladen.
    reportGroup: storedGroup !== null && isGroupAllowed(statementType, storedGroup) ? storedGroup : null,
    normalSide: isNormalSide(account.normal_side) ? account.normal_side : null,
    reportSort:
      typeof account.report_sort === "number" && Number.isFinite(account.report_sort)
        ? String(account.report_sort)
        : "",
  };
}

/**
 * Het overzicht wisselt. Een groep die niet bij het nieuwe overzicht hoort,
 * wordt gewist — nooit omgezet naar een "gelijkwaardige" groep, want die
 * bestaat niet. Terug naar "niet geclassificeerd" wist de hele classificatie,
 * inclusief zijde en sortering: dat is wat expliciet resetten betekent.
 */
export function onStatementTypeChange(
  form: ClassificationForm,
  next: StatementType | null,
): ClassificationForm {
  if (next === null) return { ...EMPTY_CLASSIFICATION };
  if (next === form.statementType) return { ...form, statementType: next };
  return {
    ...form,
    statementType: next,
    reportGroup: isGroupAllowed(next, form.reportGroup) ? form.reportGroup : null,
  };
}

/** De groep wisselt. Een groep van het andere overzicht wordt geweigerd. */
export function onReportGroupChange(
  form: ClassificationForm,
  next: ReportGroup | null,
): ClassificationForm {
  if (next === null) return { ...form, reportGroup: null };
  if (!isGroupAllowed(form.statementType, next)) return form;
  return { ...form, reportGroup: next };
}

/**
 * Een tekst-discriminant (`kind`), net als ParsedAmount in
 * opening-balance-utils.ts: deze repo draait met `strict: false`, en dan
 * versmalt TypeScript een boolean-vlag niet betrouwbaar.
 */
export type ReportSortParse =
  | { kind: "ok"; value: number | null }
  | { kind: "invalid"; message: string };

/**
 * Sortering: leeg is toegestaan (NULL), 0 is een geldige waarde en geen
 * synoniem voor leeg, negatief is verboden (de database weigert het ook), en
 * alleen hele getallen tellen.
 */
export function parseReportSort(raw: string): ReportSortParse {
  const text = raw.trim();
  if (text === "") return { kind: "ok", value: null };
  if (!/^-?\d+$/.test(text)) {
    return { kind: "invalid", message: "Sortering moet een heel getal zijn (of leeg blijven)." };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { kind: "invalid", message: "Sortering is te groot." };
  }
  if (value < 0) {
    return { kind: "invalid", message: "Sortering kan niet negatief zijn." };
  }
  return { kind: "ok", value };
}

/**
 * Zijn twee classificaties dezelfde? De sortering wordt op waarde vergeleken,
 * niet op tekst, zodat "" en "  " gelijk zijn en "07" gelijk is aan "7".
 *
 * Hiermee kan de pagina onderscheiden of iemand de classificatie werkelijk
 * heeft aangeraakt. Dat is belangrijk voor twee dingen die anders stilletjes
 * misgaan: een onaangeroerde classificatie mag niet worden overschreven (een
 * `normal_side` of `report_sort` die het schema toestaat zonder overzicht zou
 * bij een hernoeming verdwijnen), en een opgeslagen waarde die deze versie
 * niet kent mag het bewerken van nummer of omschrijving niet blokkeren.
 */
export function sameClassification(a: ClassificationForm, b: ClassificationForm): boolean {
  const sortValue = (form: ClassificationForm): number | null => {
    const parsed = parseReportSort(form.reportSort);
    return parsed.kind === "ok" ? parsed.value : Number.NaN;
  };
  const aSort = sortValue(a);
  const bSort = sortValue(b);
  return (
    a.statementType === b.statementType &&
    a.reportGroup === b.reportGroup &&
    a.normalSide === b.normalSide &&
    // NaN (ongeldige invoer) is nooit gelijk aan wat dan ook: dan is er dus
    // wél getypt en telt de classificatie als aangeraakt.
    ((aSort === null && bSort === null) || aSort === bSort)
  );
}

export interface ClassificationIssues {
  reportGroup?: string;
  reportSort?: string;
}

/**
 * Alles wat het opslaan tegenhoudt. Leeg object = opslaan mag. De regels zijn
 * exact die van de database: een overzicht zonder groep is onvolledig, een
 * groep zonder overzicht kan niet bestaan, en een groep hoort bij haar eigen
 * overzicht.
 */
export function validateClassification(form: ClassificationForm): ClassificationIssues {
  const issues: ClassificationIssues = {};

  if (form.statementType === null) {
    if (form.reportGroup !== null) {
      issues.reportGroup = "Een rapportagegroep kan niet zonder overzicht bestaan.";
    }
  } else if (form.reportGroup === null) {
    issues.reportGroup = `Kies een groep binnen ${STATEMENT_TYPE_LABELS[form.statementType]}.`;
  } else if (!isGroupAllowed(form.statementType, form.reportGroup)) {
    issues.reportGroup = `Deze groep hoort niet bij ${STATEMENT_TYPE_LABELS[form.statementType]}.`;
  }

  const sort = parseReportSort(form.reportSort);
  if (sort.kind === "invalid") issues.reportSort = sort.message;

  return issues;
}

export function hasClassificationIssues(issues: ClassificationIssues): boolean {
  return Object.keys(issues).length > 0;
}

export interface ClassificationPayload {
  statement_type: StatementType | null;
  report_group: ReportGroup | null;
  normal_side: NormalSide | null;
  report_sort: number | null;
}

/**
 * Formulier → payload. Wordt alleen aangeroepen nadat validateClassification()
 * leeg terugkwam; toch wordt hier nóg een keer afgedwongen dat een groep
 * zonder passend overzicht niet meegaat. Niet geclassificeerd betekent alle
 * vier de velden expliciet NULL — ook zijde en sortering, zodat er geen
 * onzichtbare restwaarde achterblijft.
 */
export function buildClassificationPayload(form: ClassificationForm): ClassificationPayload {
  if (form.statementType === null || !isGroupAllowed(form.statementType, form.reportGroup)) {
    return { statement_type: null, report_group: null, normal_side: null, report_sort: null };
  }
  const sort = parseReportSort(form.reportSort);
  return {
    statement_type: form.statementType,
    report_group: form.reportGroup,
    normal_side: form.normalSide,
    report_sort: sort.kind === "ok" ? sort.value : null,
  };
}

/** Geclassificeerd = overzicht én passende groep. Half is niet geclassificeerd. */
export function isClassified(account: StoredClassification | null | undefined): boolean {
  if (!account) return false;
  const statementType = isStatementType(account.statement_type) ? account.statement_type : null;
  return statementType !== null && isGroupAllowed(statementType, account.report_group);
}

/** Het label voor de tabel: de groep, of "Niet geclassificeerd". */
export function classificationLabel(account: StoredClassification | null | undefined): string {
  if (!isClassified(account)) return UNCLASSIFIED_LABEL;
  return REPORT_GROUP_LABELS[account!.report_group as ReportGroup];
}

/** "Balans · Vaste activa" — de volledige plaats, voor titels en aria-labels. */
export function classificationFullLabel(account: StoredClassification | null | undefined): string {
  if (!isClassified(account)) return UNCLASSIFIED_LABEL;
  const statementType = account!.statement_type as StatementType;
  return `${STATEMENT_TYPE_SHORT_LABELS[statementType]} · ${REPORT_GROUP_LABELS[account!.report_group as ReportGroup]}`;
}

export type ClassificationFilter = "alle" | "geclassificeerd" | "niet_geclassificeerd";

export function matchesClassificationFilter(
  account: StoredClassification | null | undefined,
  filter: ClassificationFilter,
): boolean {
  if (filter === "alle") return true;
  return filter === "geclassificeerd" ? isClassified(account) : !isClassified(account);
}

/**
 * Meldingen die de hooks zelf opwerpen (src/hooks/useGrootboekrekeningen.ts).
 * Een expliciete lijst, geen heuristiek: alleen wat hier letterlijk in staat
 * wordt doorgegeven, al het andere krijgt een neutrale tekst.
 */
const APP_ERROR_MESSAGES: ReadonlySet<string> = new Set(["Niet ingelogd"]);

/**
 * Een databasefout wordt nooit rauw getoond: een CHECK-naam, een SQLSTATE of
 * een PostgreSQL-zin is geen boodschap voor een gebruiker en lekt de
 * schemastructuur. De bekende weigeringen krijgen hun eigen Nederlandse tekst,
 * de rest een neutrale.
 */
export function classificationErrorMessage(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === "string" ? raw.code : "";
  const message = typeof raw?.message === "string" ? raw.message : "";

  // Meldingen die de applicatie zélf opwerpt, staan hier met naam en toenaam.
  // Ze komen nooit van de database, dus ze kunnen niets lekken — en ze zijn
  // het enige dat de gebruiker vertelt wat er te doen valt.
  if (APP_ERROR_MESSAGES.has(message)) return message;

  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "Je hebt geen rechten om de rapportageclassificatie te wijzigen.";
  }
  if (/grootboekrekeningen_reporting_pair_check/.test(message)) {
    return "Deze combinatie van overzicht en groep is niet toegestaan.";
  }
  if (/grootboekrekeningen_statement_type_check/.test(message)) {
    return "Dit overzicht bestaat niet.";
  }
  if (/grootboekrekeningen_report_group_check/.test(message)) {
    return "Deze rapportagegroep bestaat niet.";
  }
  if (/grootboekrekeningen_normal_side_check/.test(message)) {
    return "De normale zijde kan alleen debet of credit zijn.";
  }
  if (/grootboekrekeningen_report_sort_check/.test(message)) {
    return "Sortering kan niet negatief zijn.";
  }
  if (code === "23505" || /duplicate key/i.test(message)) {
    return "Dit rekeningnummer bestaat al.";
  }
  return "Opslaan is niet gelukt. Probeer het opnieuw.";
}

/** Voor logging: nooit de servertekst, alleen de code. */
export function safeClassificationErrorCode(error: unknown): string {
  const raw = error as { code?: unknown } | null;
  return typeof raw?.code === "string" && raw.code !== "" ? raw.code : "onbekend";
}
