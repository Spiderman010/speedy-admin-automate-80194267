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

/**
 * Het TWEEDE niveau van de taxonomie (migratie 20260923120000).
 *
 * `report_group` hierboven is de CATEGORIE — die zeven balanswaarden zijn
 * precies de zeven gevraagde balanscategorieën. Wat ontbrak was de GROEP
 * daarbinnen: "Liquide middelen", "Voorraden", "Handelsdebiteuren" enzovoort.
 * Die staat hieronder, per categorie, in dezelfde volgorde als de database ze
 * in `grootboekrekeningen_subgroup_pair_check` toestaat. Wijkt deze kaart ooit
 * af van die CHECK, dan wint de database en weigert het opslaan; een test legt
 * beide naast elkaar.
 *
 * Een subgroep is NOOIT verplicht: "categorie gekozen, groep nog niet" is een
 * normale toestand, en het is precies de toestand waarin elke bestaande,
 * handmatig ingevulde classificatie terechtkomt. Er wordt niets herschreven.
 */
export const SUBGROUPS_BY_GROUP = {
  vaste_activa: [
    "immateriele_vaste_activa", "materiele_vaste_activa", "financiele_vaste_activa",
  ],
  vlottende_activa: [
    "voorraden", "handelsdebiteuren", "overige_vorderingen",
    "belastingen_premies_te_ontvangen", "overlopende_activa", "liquide_middelen",
  ],
  eigen_vermogen: [
    "ondernemingsvermogen", "geplaatst_kapitaal", "agio",
    "algemene_reserve", "overige_reserves", "onverdeeld_resultaat",
  ],
  prive: ["prive_opnamen", "prive_stortingen"],
  voorzieningen: ["voorzieningen_algemeen"],
  langlopende_schulden: ["leningen", "financiele_lease", "overige_langlopende_schulden"],
  kortlopende_schulden: [
    "handelscrediteuren", "belastingen_premies_te_betalen", "omzetbelasting",
    "loonheffingen", "schulden_aan_personeel", "rekening_courant",
    "overige_kortlopende_schulden", "overlopende_passiva",
  ],
  netto_omzet: [
    "omzet_hoog_tarief", "omzet_laag_tarief", "omzet_vrijgesteld",
    "omzet_buitenland", "overige_omzet",
  ],
  kostprijs_omzet: ["inkopen", "kostprijs_omzet_direct", "voorraadmutaties", "uitbesteed_werk"],
  personeelskosten: [
    "lonen_en_salarissen", "sociale_lasten", "pensioenlasten", "overige_personeelskosten",
  ],
  // Huisvesting, verkoop, auto en kantoor staan hier bewust als subgroepen en
  // niet als eigen categorie: promoveren zou het bestaande vijftien-waarden-
  // domein wijzigen en daarmee opgeslagen classificaties én de statement-engine
  // ongeldig maken. Het formulier toont ze wél onder die vier kopjes.
  overige_bedrijfskosten: [
    "huur", "gas_water_elektra", "onderhoud_huisvesting", "overige_huisvestingskosten",
    "reclame_en_marketing", "reis_en_representatiekosten", "overige_verkoopkosten",
    "auto_brandstof", "auto_onderhoud", "auto_verzekering", "auto_lease",
    "auto_motorrijtuigenbelasting", "auto_overige",
    "kantoorbenodigdheden", "telefoon_en_internet", "automatisering_software",
    "administratie_accountancy", "bankkosten", "verzekeringen", "overige_algemene_kosten",
  ],
  afschrijvingen: [
    "afschrijving_immateriele_vaste_activa", "afschrijving_materiele_vaste_activa",
  ],
  financiele_baten_lasten: [
    "rentebaten", "rentelasten", "bank_financieringskosten", "overige_financiele_baten_lasten",
  ],
  belastingen: ["vennootschapsbelasting"],
  overig_resultaat: ["overige_baten", "overige_lasten"],
} as const satisfies Readonly<Record<ReportGroup, readonly string[]>>;

export type ReportSubgroup =
  (typeof SUBGROUPS_BY_GROUP)[keyof typeof SUBGROUPS_BY_GROUP][number];

export const REPORT_SUBGROUP_LABELS: Readonly<Record<ReportSubgroup, string>> = {
  immateriele_vaste_activa: "Immateriële vaste activa",
  materiele_vaste_activa: "Materiële vaste activa",
  financiele_vaste_activa: "Financiële vaste activa",
  voorraden: "Voorraden",
  handelsdebiteuren: "Handelsdebiteuren",
  overige_vorderingen: "Overige vorderingen",
  belastingen_premies_te_ontvangen: "Belastingen en premies te ontvangen",
  overlopende_activa: "Overlopende activa",
  liquide_middelen: "Liquide middelen",
  ondernemingsvermogen: "Ondernemingsvermogen",
  geplaatst_kapitaal: "Geplaatst kapitaal",
  agio: "Agio",
  algemene_reserve: "Algemene reserve",
  overige_reserves: "Overige reserves",
  onverdeeld_resultaat: "Onverdeeld resultaat",
  prive_opnamen: "Privé-opnamen",
  prive_stortingen: "Privé-stortingen",
  voorzieningen_algemeen: "Voorzieningen",
  leningen: "Leningen",
  financiele_lease: "Financiële lease",
  overige_langlopende_schulden: "Overige langlopende schulden",
  handelscrediteuren: "Handelscrediteuren",
  belastingen_premies_te_betalen: "Belastingen en premies te betalen",
  omzetbelasting: "Omzetbelasting",
  loonheffingen: "Loonheffingen",
  schulden_aan_personeel: "Schulden aan personeel",
  rekening_courant: "Rekening-courant",
  overige_kortlopende_schulden: "Overige kortlopende schulden",
  overlopende_passiva: "Overlopende passiva",
  omzet_hoog_tarief: "Omzet hoog tarief",
  omzet_laag_tarief: "Omzet laag tarief",
  omzet_vrijgesteld: "Omzet vrijgesteld",
  omzet_buitenland: "Omzet buitenland",
  overige_omzet: "Overige omzet",
  inkopen: "Inkopen",
  kostprijs_omzet_direct: "Kostprijs omzet",
  voorraadmutaties: "Voorraadmutaties",
  uitbesteed_werk: "Uitbesteed werk",
  lonen_en_salarissen: "Lonen en salarissen",
  sociale_lasten: "Sociale lasten",
  pensioenlasten: "Pensioenlasten",
  overige_personeelskosten: "Overige personeelskosten",
  huur: "Huur",
  gas_water_elektra: "Gas/water/elektra",
  onderhoud_huisvesting: "Onderhoud huisvesting",
  overige_huisvestingskosten: "Overige huisvestingskosten",
  reclame_en_marketing: "Reclame en marketing",
  reis_en_representatiekosten: "Reis- en representatiekosten",
  overige_verkoopkosten: "Overige verkoopkosten",
  auto_brandstof: "Brandstof",
  auto_onderhoud: "Onderhoud",
  auto_verzekering: "Verzekering",
  auto_lease: "Lease",
  auto_motorrijtuigenbelasting: "Motorrijtuigenbelasting",
  auto_overige: "Overige autokosten",
  kantoorbenodigdheden: "Kantoorbenodigdheden",
  telefoon_en_internet: "Telefoon en internet",
  automatisering_software: "Automatisering/software",
  administratie_accountancy: "Administratie/accountancy",
  bankkosten: "Bankkosten",
  verzekeringen: "Verzekeringen",
  overige_algemene_kosten: "Overige algemene kosten",
  afschrijving_immateriele_vaste_activa: "Afschrijving immateriële vaste activa",
  afschrijving_materiele_vaste_activa: "Afschrijving materiële vaste activa",
  rentebaten: "Rentebaten",
  rentelasten: "Rentelasten",
  bank_financieringskosten: "Bank-/financieringskosten",
  overige_financiele_baten_lasten: "Overige financiële baten en lasten",
  vennootschapsbelasting: "Vennootschapsbelasting",
  overige_baten: "Overige baten",
  overige_lasten: "Overige lasten",
};

/**
 * Alleen presentatie: de tussenkopjes waaronder `overige_bedrijfskosten` in
 * het formulier wordt getoond, zodat de gevraagde indeling (Huisvesting,
 * Verkoop, Auto, Kantoor) zichtbaar is zonder dat er een derde niveau wordt
 * opgeslagen. Een subgroep zonder kopje valt onder "Overige".
 */
export const SUBGROUP_CLUSTER_LABELS: Readonly<Partial<Record<ReportSubgroup, string>>> = {
  huur: "Huisvestingskosten",
  gas_water_elektra: "Huisvestingskosten",
  onderhoud_huisvesting: "Huisvestingskosten",
  overige_huisvestingskosten: "Huisvestingskosten",
  reclame_en_marketing: "Verkoopkosten",
  reis_en_representatiekosten: "Verkoopkosten",
  overige_verkoopkosten: "Verkoopkosten",
  auto_brandstof: "Autokosten",
  auto_onderhoud: "Autokosten",
  auto_verzekering: "Autokosten",
  auto_lease: "Autokosten",
  auto_motorrijtuigenbelasting: "Autokosten",
  auto_overige: "Autokosten",
  kantoorbenodigdheden: "Kantoorkosten",
  telefoon_en_internet: "Kantoorkosten",
  automatisering_software: "Kantoorkosten",
  administratie_accountancy: "Kantoorkosten",
  bankkosten: "Kantoorkosten",
  verzekeringen: "Kantoorkosten",
  overige_algemene_kosten: "Kantoorkosten",
};

/**
 * De gebruikelijke zijde per balansgroep — METADATA, geen berekening.
 *
 * Dit wordt uitsluitend gebruikt om een LEEG veld "Normale zijde" een voorstel
 * te geven. Het raakt geen enkele boeking aan, het wordt nooit over een reeds
 * ingevulde zijde heen gezet, en de statement-engine leidt er niets uit af:
 * die leest de opgeslagen `normal_side`. Het saldo van een rekening komt en
 * blijft uit `ledger_postings`.
 *
 * W&V-groepen staan er bewust niet in: baten en lasten lopen per groep beide
 * kanten op en een voorstel zou daar vaker misleiden dan helpen.
 */
const DEBIT_NORMAL_BALANS_GROUPS: readonly ReportGroup[] = ["vaste_activa", "vlottende_activa"];
const CREDIT_NORMAL_BALANS_GROUPS: readonly ReportGroup[] = [
  "eigen_vermogen", "voorzieningen", "langlopende_schulden", "kortlopende_schulden",
];

export function defaultNormalSideFor(
  group: ReportGroup | null,
  subgroup: ReportSubgroup | null,
): NormalSide | null {
  // Privé is de uitzondering die het waard is om apart te noemen: opnamen zijn
  // debet-normaal, stortingen credit-normaal, binnen één en dezelfde groep.
  if (subgroup === "prive_opnamen") return "debet";
  if (subgroup === "prive_stortingen") return "credit";
  if (group === null) return null;
  if (DEBIT_NORMAL_BALANS_GROUPS.includes(group)) return "debet";
  if (CREDIT_NORMAL_BALANS_GROUPS.includes(group)) return "credit";
  return null;
}

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

export function isReportSubgroup(value: unknown): value is ReportSubgroup {
  return typeof value === "string" && value in REPORT_SUBGROUP_LABELS;
}

/** De groepen binnen één categorie; zonder categorie is er geen keuze. */
export function subgroupsFor(group: ReportGroup | null): readonly ReportSubgroup[] {
  if (group === null || !isReportGroup(group)) return [];
  return SUBGROUPS_BY_GROUP[group] as readonly ReportSubgroup[];
}

/**
 * Hoort deze groep bij deze categorie? Dit is de regel die een combinatie als
 * `Vlottende activa` + `Loonheffingen` onmogelijk maakt.
 */
export function isSubgroupAllowed(group: ReportGroup | null, subgroup: unknown): boolean {
  if (group === null) return false;
  return (subgroupsFor(group) as readonly string[]).includes(subgroup as string);
}

/** Het bewerkbare deel van het formulier dat over classificatie gaat. */
export interface ClassificationForm {
  statementType: StatementType | null;
  /** De Categorie (`report_group` in de database). */
  reportGroup: ReportGroup | null;
  /** De Groep binnen die categorie. Altijd optioneel. */
  reportSubgroup: ReportSubgroup | null;
  normalSide: NormalSide | null;
  /** Ruwe tekst uit het invoerveld: "" betekent leeg (NULL), niet 0. */
  reportSort: string;
}

export const EMPTY_CLASSIFICATION: ClassificationForm = {
  statementType: null,
  reportGroup: null,
  reportSubgroup: null,
  normalSide: null,
  reportSort: "",
};

/** De opgeslagen velden van een rekening, zoals de database ze teruggeeft. */
export interface StoredClassification {
  statement_type?: string | null;
  report_group?: string | null;
  report_subgroup?: string | null;
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
  const group = storedGroup !== null && isGroupAllowed(statementType, storedGroup) ? storedGroup : null;
  const storedSubgroup = isReportSubgroup(account.report_subgroup) ? account.report_subgroup : null;
  return {
    statementType,
    // Een groep zonder passend overzicht is per definitie ongeldig (de
    // database staat hem niet toe); hij wordt dus niet geladen.
    reportGroup: group,
    // Idem voor de subgroep: een waarde die niet bij de geladen categorie
    // hoort, wordt leeg getoond en dus nooit ongemerkt opnieuw opgeslagen. De
    // opgeslagen waarde blijft in de database staan tot iemand bewust opslaat;
    // `classificationConflicts()` maakt haar zichtbaar.
    reportSubgroup: isSubgroupAllowed(group, storedSubgroup) ? storedSubgroup : null,
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
  const group = isGroupAllowed(next, form.reportGroup) ? form.reportGroup : null;
  return {
    ...form,
    statementType: next,
    reportGroup: group,
    // Valt de categorie weg, dan kan de groep niet blijven hangen: zij bestaat
    // alleen binnen haar eigen categorie en wordt nooit "omgezet".
    reportSubgroup: isSubgroupAllowed(group, form.reportSubgroup) ? form.reportSubgroup : null,
  };
}

/** De groep wisselt. Een groep van het andere overzicht wordt geweigerd. */
export function onReportGroupChange(
  form: ClassificationForm,
  next: ReportGroup | null,
): ClassificationForm {
  if (next === null) return { ...form, reportGroup: null, reportSubgroup: null };
  if (!isGroupAllowed(form.statementType, next)) return form;
  return {
    ...form,
    reportGroup: next,
    reportSubgroup: isSubgroupAllowed(next, form.reportSubgroup) ? form.reportSubgroup : null,
  };
}

/**
 * De groep wisselt. Een groep van een andere categorie wordt geweigerd — zo
 * kan `Vlottende activa` + `Loonheffingen` niet ontstaan.
 *
 * Kiest iemand een groep terwijl de normale zijde nog leeg is, dan wordt het
 * voorstel uit `defaultNormalSideFor()` ingevuld. Alleen als hij leeg is: een
 * zijde die iemand zelf heeft gekozen, wordt nooit overschreven.
 */
export function onReportSubgroupChange(
  form: ClassificationForm,
  next: ReportSubgroup | null,
): ClassificationForm {
  if (next === null) return { ...form, reportSubgroup: null };
  if (!isSubgroupAllowed(form.reportGroup, next)) return form;
  return {
    ...form,
    reportSubgroup: next,
    normalSide: form.normalSide ?? defaultNormalSideFor(form.reportGroup, next),
  };
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
    a.reportSubgroup === b.reportSubgroup &&
    a.normalSide === b.normalSide &&
    // NaN (ongeldige invoer) is nooit gelijk aan wat dan ook: dan is er dus
    // wél getypt en telt de classificatie als aangeraakt.
    ((aSort === null && bSort === null) || aSort === bSort)
  );
}

export interface ClassificationIssues {
  reportGroup?: string;
  reportSubgroup?: string;
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
      issues.reportGroup = "Een rapportagecategorie kan niet zonder overzicht bestaan.";
    }
  } else if (form.reportGroup === null) {
    issues.reportGroup = `Kies een categorie binnen ${STATEMENT_TYPE_LABELS[form.statementType]}.`;
  } else if (!isGroupAllowed(form.statementType, form.reportGroup)) {
    issues.reportGroup = `Deze categorie hoort niet bij ${STATEMENT_TYPE_LABELS[form.statementType]}.`;
  }

  // De groep is optioneel, maar een groep die niet bij haar categorie hoort is
  // dat nooit — dat is precies de combinatie die de database weigert.
  if (form.reportSubgroup !== null && !isSubgroupAllowed(form.reportGroup, form.reportSubgroup)) {
    issues.reportSubgroup = form.reportGroup === null
      ? "Een groep kan niet zonder categorie bestaan."
      : `Deze groep hoort niet bij ${REPORT_GROUP_LABELS[form.reportGroup]}.`;
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
  report_subgroup: ReportSubgroup | null;
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
    return {
      statement_type: null, report_group: null, report_subgroup: null,
      normal_side: null, report_sort: null,
    };
  }
  const sort = parseReportSort(form.reportSort);
  return {
    statement_type: form.statementType,
    report_group: form.reportGroup,
    // Nog een keer afgedwongen, ook al kwam validateClassification() leeg
    // terug: een groep die niet bij haar categorie hoort gaat de deur niet uit.
    report_subgroup: isSubgroupAllowed(form.reportGroup, form.reportSubgroup)
      ? form.reportSubgroup
      : null,
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
  const group = account!.report_group as ReportGroup;
  const base = `${STATEMENT_TYPE_SHORT_LABELS[statementType]} · ${REPORT_GROUP_LABELS[group]}`;
  // De groep hoort erbij zodra zij is ingevuld — en alleen wanneer zij
  // werkelijk bij haar categorie hoort.
  const subgroup = account!.report_subgroup;
  return isSubgroupAllowed(group, subgroup)
    ? `${base} · ${REPORT_SUBGROUP_LABELS[subgroup as ReportSubgroup]}`
    : base;
}

/** Het groepslabel apart, of `null` zolang er geen geldige groep is. */
export function subgroupLabel(account: StoredClassification | null | undefined): string | null {
  if (!isClassified(account)) return null;
  const group = account!.report_group as ReportGroup;
  const subgroup = account!.report_subgroup;
  return isSubgroupAllowed(group, subgroup)
    ? REPORT_SUBGROUP_LABELS[subgroup as ReportSubgroup]
    : null;
}

/**
 * Opgeslagen waarden die deze versie niet kan plaatsen.
 *
 * DIT WIJZIGT NIETS. Een classificatie die iemand zelf heeft ingevuld, blijft
 * staan zoals zij staat; deze functie stelt alleen vast dát er iets niet
 * klopt, zodat het scherm het kan melden in plaats van het stil weg te
 * poetsen. Het herstellen is mensenwerk: pas bij een bewuste opslagactie
 * verandert er iets in de database.
 */
export type ClassificationConflict =
  | "unknown_statement_type"
  | "unknown_group"
  | "group_not_in_statement"
  | "unknown_subgroup"
  | "subgroup_not_in_group"
  | "subgroup_without_group";

export const CLASSIFICATION_CONFLICT_LABELS: Readonly<Record<ClassificationConflict, string>> = {
  unknown_statement_type: "Onbekend rapport opgeslagen.",
  unknown_group: "Onbekende categorie opgeslagen.",
  group_not_in_statement: "De opgeslagen categorie hoort niet bij het opgeslagen rapport.",
  unknown_subgroup: "Onbekende groep opgeslagen.",
  subgroup_not_in_group: "De opgeslagen groep hoort niet bij de opgeslagen categorie.",
  subgroup_without_group: "Er is een groep opgeslagen zonder categorie.",
};

export function classificationConflicts(
  account: StoredClassification | null | undefined,
): ClassificationConflict[] {
  if (!account) return [];
  const conflicts: ClassificationConflict[] = [];

  const statementType = isStatementType(account.statement_type) ? account.statement_type : null;
  if (account.statement_type != null && statementType === null) {
    conflicts.push("unknown_statement_type");
  }

  const group = isReportGroup(account.report_group) ? account.report_group : null;
  if (account.report_group != null && group === null) {
    conflicts.push("unknown_group");
  } else if (group !== null && statementType !== null && !isGroupAllowed(statementType, group)) {
    conflicts.push("group_not_in_statement");
  }

  const subgroup = isReportSubgroup(account.report_subgroup) ? account.report_subgroup : null;
  if (account.report_subgroup != null && subgroup === null) {
    conflicts.push("unknown_subgroup");
  } else if (subgroup !== null) {
    if (group === null) conflicts.push("subgroup_without_group");
    else if (!isSubgroupAllowed(group, subgroup)) conflicts.push("subgroup_not_in_group");
  }

  return conflicts;
}

export const CONFLICT_BADGE_LABEL = "Controle nodig";

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
