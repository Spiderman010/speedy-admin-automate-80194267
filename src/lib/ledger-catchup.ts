/**
 * Historische grootboekvulling — de zuivere beoordelingslaag.
 *
 * WAT DIT WEL DOET
 * Per historisch bronrecord één vraag beantwoorden: is het al geboekt, kan de
 * BESTAANDE writer veilig geprobeerd worden, of is er een concrete reden om
 * het niet te proberen? Meer niet.
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen bedrag bepalen, geen debet-/creditregel samenstellen, geen BTW-,
 * debiteuren-, crediteuren- of bankrekening kiezen, geen boekjaar afleiden en
 * geen boekingsdatum bepalen. Dat blijft volledig van de bestaande
 * server-writers `post_purchase_invoice()` en `post_sales_invoice()`. Er wordt
 * hier ook nooit een rekeningNUMMER geraden — geen vaste nummerreeks voor
 * bank, debiteuren, crediteuren of BTW, in geen enkele vorm:
 * er wordt uitsluitend gekeken óf de expliciet ingestelde account-id bestaat.
 *
 * DE WRITER BLIJFT DE AUTORITEIT
 * Alles hieronder is UX: het voorkomt dat de gebruiker 83 keer een voorspelbare
 * weigering moet aanklikken. De writer valideert bij elke aanroep opnieuw en
 * alles — rechten, organisatie, bedragen, rekeningen, dubbele boeking — wordt
 * daar nog een keer gecontroleerd. Zegt deze laag "klaar" en weigert de writer
 * alsnog, dan is de writer degene die gelijk heeft en blijft het record
 * ongeboekt.
 *
 * De volgorde van de controles hieronder volgt bewust de volgorde in de
 * migraties 20260915140000 (inkoop) en 20260915160000 (verkoop), zodat de
 * getoonde reden dezelfde is als de reden waarop de writer zou afslaan.
 */

/** Exact de statussen die post_purchase_invoice() accepteert. */
export const CATCHUP_PURCHASE_POSTABLE_STATUSES = ["gecontroleerd", "betaald", "geexporteerd"] as const;
/** Exact de statussen die post_sales_invoice() accepteert. */
export const CATCHUP_SALES_POSTABLE_STATUSES = ["gecontroleerd", "betaald"] as const;

export type CatchupSource = "inkoop" | "verkoop";

/** Drie toestanden, meer zijn er niet: geboekt, boekbaar, of geblokkeerd. */
export type CatchupState = "geboekt" | "klaar" | "geblokkeerd";

export type CatchupBlockCode =
  | "status_niet_postbaar"
  | "geen_factuurdatum"
  | "boekjaar_afgesloten"
  | "bedragen_ontbreken"
  | "bedrag_niet_positief"
  | "btw_verlegd"
  | "geen_crediteurenrekening"
  | "geen_debiteurenrekening"
  | "geen_btw_rekening"
  | "geen_omzetrekening"
  | "geen_boekingsregels"
  | "regel_zonder_rekening"
  | "regel_bedrag_niet_positief"
  | "regels_sluiten_niet_aan"
  | "bedragen_sluiten_niet_aan";

export interface CatchupBlock {
  code: CatchupBlockCode;
  /** Toonbare reden, in dezelfde bewoording als de writer die zou geven. */
  label: string;
  /**
   * Ligt de oorzaak in de instellingen van de administratie (en niet in het
   * document zelf)? Dan kan de UI naar die instellingen wijzen.
   */
  configuratie?: true;
}

export interface CatchupRecord {
  id: string;
  source: CatchupSource;
  clientId: string;
  /** De ECHTE brondatum. Nooit vandaag, nooit herschreven. */
  date: string | null;
  /** Factuurnummer als dat er is, anders een herkenbare aanduiding. */
  reference: string;
  description: string;
  amountInclusive: number | null;
  /** De status van het brondocument zelf, ongewijzigd. */
  documentStatus: string;
  state: CatchupState;
  /** Leeg tenzij `state === "geblokkeerd"`. */
  blocks: CatchupBlock[];
  /** Gevuld zodra het record geboekt is: de boekingsgroep van de writer. */
  postingGroupId: string | null;
}

/** De administratie-instellingen waar de writers op controleren. */
export interface CatchupClientConfig {
  id: string;
  afgesloten_boekjaar: number | null;
  crediteuren_rekening_id: string | null;
  debiteuren_rekening_id: string | null;
  btw_te_vorderen_rekening_id: string | null;
  btw_te_betalen_rekening_id: string | null;
}

export interface CatchupPurchaseInvoice {
  id: string;
  client_id: string;
  status: string;
  invoice_date: string | null;
  invoice_number: string | null;
  supplier: string | null;
  amount_excl: number | null;
  amount_incl: number | null;
  btw_amount: number | null;
}

/** De regelaggregatie die de writer zelf ook in één SELECT ophaalt. */
export interface CatchupLineAggregate {
  count: number;
  sumExcl: number;
  withoutAccount: number;
  /**
   * Regels met `amount_excl <= 0`. De writer loopt de regels één voor één af
   * en weigert elke individuele regel die niet positief is — een grootboekregel
   * moet één positieve kant hebben, en een regel stilzwijgend overslaan zou de
   * aansluiting breken. De SOM zegt daar niets over: +120 en −20 tellen op tot
   * de kop van 100, waarna deze laag "klaar" zou zeggen terwijl de writer
   * voorspelbaar weigert.
   */
  nonPositiveAmountCount: number;
}

export interface CatchupSalesInvoice {
  id: string;
  client_id: string;
  status: string;
  invoice_date: string;
  invoice_number: string;
  customer_name: string | null;
  amount_excl: number | null;
  amount_incl: number | null;
  btw_amount: number | null;
  btw_verlegd: boolean;
  /** De omzetrekening staat op de factuurkop; er zijn geen regels. */
  grootboekrekening_id: string | null;
}

const GEEN_REGELS: CatchupLineAggregate = {
  count: 0, sumExcl: 0, withoutAccount: 0, nonPositiveAmountCount: 0,
};

/**
 * De writer rekent in NUMERIC en hanteert GEEN tolerantie. In JavaScript zijn
 * deze bedragen doubles, dus een vergelijking op hele centen is de enige die
 * hier hetzelfde antwoord geeft als de database; anders zou 0,1 + 0,2 een
 * factuur ten onrechte als "sluit niet aan" markeren terwijl de writer hem
 * gewoon accepteert.
 */
function cents(value: number): number {
  return Math.round(value * 100);
}

function gelijk(a: number, b: number): boolean {
  return cents(a) === cents(b);
}

/** COALESCE(btw_amount, 0) — exact zoals beide writers het doen. */
function btwVan(invoice: { btw_amount: number | null }): number {
  return invoice.btw_amount ?? 0;
}

function boekjaarVan(date: string): number {
  return Number(date.slice(0, 4));
}

function jaarAfgesloten(date: string, config: CatchupClientConfig): boolean {
  return config.afgesloten_boekjaar !== null && boekjaarVan(date) <= config.afgesloten_boekjaar;
}

export function evaluatePurchaseInvoice(input: {
  invoice: CatchupPurchaseInvoice;
  config: CatchupClientConfig;
  lines?: CatchupLineAggregate;
  /** De boekingsgroep uit purchase_invoice_postings, of null. */
  postingGroupId: string | null;
}): CatchupRecord {
  const { invoice, config, postingGroupId } = input;
  const lines = input.lines ?? GEEN_REGELS;
  const basis = {
    id: invoice.id,
    source: "inkoop" as const,
    clientId: invoice.client_id,
    date: invoice.invoice_date,
    reference: invoice.invoice_number?.trim() || "(geen factuurnummer)",
    description: invoice.supplier?.trim() || "(geen leverancier)",
    amountInclusive: invoice.amount_incl,
    documentStatus: invoice.status,
  };

  // Al geboekt wint van alles: de marker is de autoriteit over "is dit al
  // gebeurd", en een geboekte factuur mag nooit als opnieuw boekbaar gelden.
  if (postingGroupId) {
    return { ...basis, state: "geboekt", blocks: [], postingGroupId };
  }

  const blocks: CatchupBlock[] = [];

  if (!(CATCHUP_PURCHASE_POSTABLE_STATUSES as readonly string[]).includes(invoice.status)) {
    // Deze status wordt NOOIT automatisch aangepast om boeken mogelijk te
    // maken; goedkeuren is een menselijke handeling in de inkoopwerkplek.
    blocks.push({
      code: "status_niet_postbaar",
      label: `Factuur staat nog op '${invoice.status}' en kan pas na goedkeuring worden geboekt`,
    });
  }

  if (!invoice.invoice_date) {
    blocks.push({ code: "geen_factuurdatum", label: "Factuur heeft geen factuurdatum" });
  } else if (jaarAfgesloten(invoice.invoice_date, config)) {
    blocks.push({
      code: "boekjaar_afgesloten",
      label: `Boekjaar ${boekjaarVan(invoice.invoice_date)} is afgesloten voor deze administratie`,
    });
  }

  if (invoice.amount_excl === null || invoice.amount_incl === null) {
    blocks.push({ code: "bedragen_ontbreken", label: "Factuur mist bedragen" });
  } else {
    const btw = btwVan(invoice);
    if (invoice.amount_excl < 0 || btw < 0 || invoice.amount_incl <= 0) {
      blocks.push({
        code: "bedrag_niet_positief",
        label: "Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking",
      });
    }
    if (!gelijk(invoice.amount_excl + btw, invoice.amount_incl)) {
      blocks.push({
        code: "bedragen_sluiten_niet_aan",
        label: "Bedrag exclusief plus BTW sluit niet aan op het bedrag inclusief",
      });
    }
    if (btw > 0 && !config.btw_te_vorderen_rekening_id) {
      blocks.push({
        code: "geen_btw_rekening",
        label: "Geen rekening voor BTW te vorderen ingesteld voor deze administratie",
        configuratie: true,
      });
    }
    if (lines.count > 0 && !gelijk(lines.sumExcl, invoice.amount_excl)) {
      blocks.push({
        code: "regels_sluiten_niet_aan",
        label: "De boekingsregels sluiten niet aan op het factuurbedrag exclusief BTW",
      });
    }
  }

  if (!config.crediteuren_rekening_id) {
    blocks.push({
      code: "geen_crediteurenrekening",
      label: "Geen crediteurenrekening ingesteld voor deze administratie",
      configuratie: true,
    });
  }

  if (lines.count === 0) {
    blocks.push({ code: "geen_boekingsregels", label: "Factuur heeft geen boekingsregels" });
  } else if (lines.withoutAccount > 0) {
    blocks.push({
      code: "regel_zonder_rekening",
      label:
        lines.withoutAccount === 1
          ? "Eén boekingsregel heeft geen grootboekrekening"
          : `${lines.withoutAccount} boekingsregels hebben geen grootboekrekening`,
    });
  }

  // Per REGEL, niet op de som: de writer loopt de regels af en weigert elke
  // regel met amount_excl <= 0. Een factuur met +120 en −20 sluit op de kop
  // van 100 aan en zou zonder deze controle als "klaar" verschijnen, waarna de
  // writer hem voorspelbaar weigert. Los van `withoutAccount`, want een regel
  // kan beide gebreken hebben en de gebruiker moet ze allebei zien.
  if (lines.count > 0 && lines.nonPositiveAmountCount > 0) {
    blocks.push({
      code: "regel_bedrag_niet_positief",
      label:
        lines.nonPositiveAmountCount === 1
          ? "Eén boekingsregel heeft een bedrag van nul of lager; zo'n regel kan niet worden geboekt"
          : `${lines.nonPositiveAmountCount} boekingsregels hebben een bedrag van nul of lager; zulke regels kunnen niet worden geboekt`,
    });
  }

  return {
    ...basis,
    state: blocks.length === 0 ? "klaar" : "geblokkeerd",
    blocks,
    postingGroupId: null,
  };
}

export function evaluateSalesInvoice(input: {
  invoice: CatchupSalesInvoice;
  config: CatchupClientConfig;
  postingGroupId: string | null;
}): CatchupRecord {
  const { invoice, config, postingGroupId } = input;
  const basis = {
    id: invoice.id,
    source: "verkoop" as const,
    clientId: invoice.client_id,
    date: invoice.invoice_date,
    reference: invoice.invoice_number?.trim() || "(geen factuurnummer)",
    description: invoice.customer_name?.trim() || "(geen klant)",
    amountInclusive: invoice.amount_incl,
    documentStatus: invoice.status,
  };

  if (postingGroupId) {
    return { ...basis, state: "geboekt", blocks: [], postingGroupId };
  }

  const blocks: CatchupBlock[] = [];

  if (!(CATCHUP_SALES_POSTABLE_STATUSES as readonly string[]).includes(invoice.status)) {
    blocks.push({
      code: "status_niet_postbaar",
      label: `Factuur staat nog op '${invoice.status}' en kan pas na goedkeuring worden geboekt`,
    });
  }

  if (!invoice.invoice_date) {
    blocks.push({ code: "geen_factuurdatum", label: "Factuur heeft geen factuurdatum" });
  } else if (jaarAfgesloten(invoice.invoice_date, config)) {
    blocks.push({
      code: "boekjaar_afgesloten",
      label: `Boekjaar ${boekjaarVan(invoice.invoice_date)} is afgesloten voor deze administratie`,
    });
  }

  // Verlegde BTW wordt door de writer geweigerd (ERRCODE 0A000), niet stil als
  // een gewone factuur zonder BTW geboekt. Dat tonen we dus ook zo.
  if (invoice.btw_verlegd) {
    blocks.push({
      code: "btw_verlegd",
      label: "Verkoopfacturen met verlegde BTW kunnen nog niet worden geboekt",
    });
  }

  if (invoice.amount_excl === null || invoice.amount_incl === null) {
    blocks.push({ code: "bedragen_ontbreken", label: "Factuur mist bedragen" });
  } else {
    const btw = btwVan(invoice);
    if (invoice.amount_excl < 0 || btw < 0 || invoice.amount_incl <= 0) {
      blocks.push({
        code: "bedrag_niet_positief",
        label: "Negatieve of nulbedragen worden niet ondersteund; een creditnota vereist een tegenboeking",
      });
    }
    if (!gelijk(invoice.amount_excl + btw, invoice.amount_incl)) {
      blocks.push({
        code: "bedragen_sluiten_niet_aan",
        label: "Bedrag exclusief plus BTW sluit niet aan op het bedrag inclusief",
      });
    }
    if (btw > 0 && !config.btw_te_betalen_rekening_id) {
      blocks.push({
        code: "geen_btw_rekening",
        label: "Geen rekening voor BTW te betalen ingesteld voor deze administratie",
        configuratie: true,
      });
    }
  }

  if (!invoice.grootboekrekening_id) {
    blocks.push({ code: "geen_omzetrekening", label: "Geen omzetrekening ingesteld op deze factuur" });
  }

  if (!config.debiteuren_rekening_id) {
    blocks.push({
      code: "geen_debiteurenrekening",
      label: "Geen debiteurenrekening ingesteld voor deze administratie",
      configuratie: true,
    });
  }

  return {
    ...basis,
    state: blocks.length === 0 ? "klaar" : "geblokkeerd",
    blocks,
    postingGroupId: null,
  };
}

export interface CatchupSummary {
  totaal: number;
  geboekt: number;
  klaar: number;
  geblokkeerd: number;
}

export function summarize(records: readonly CatchupRecord[]): CatchupSummary {
  let geboekt = 0;
  let klaar = 0;
  let geblokkeerd = 0;
  for (const r of records) {
    if (r.state === "geboekt") geboekt++;
    else if (r.state === "klaar") klaar++;
    else geblokkeerd++;
  }
  return { totaal: records.length, geboekt, klaar, geblokkeerd };
}

/** Alleen de records die aan de writer mogen worden aangeboden. */
export function postableRecords(records: readonly CatchupRecord[]): CatchupRecord[] {
  return records.filter((r) => r.state === "klaar");
}

/**
 * Inkoop vóór verkoop. De bankafletteringen (PR 2) eisen een reeds geboekte
 * bronfactuur, dus facturen gaan eerst; binnen een soort op brondatum, zodat
 * de oudste historie het eerst wordt ingelopen.
 */
const SOURCE_ORDER: Record<CatchupSource, number> = { inkoop: 0, verkoop: 1 };

export function catchupRunOrder(records: readonly CatchupRecord[]): CatchupRecord[] {
  return [...records].sort((a, b) => {
    if (a.source !== b.source) return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface CatchupRunFailure {
  id: string;
  source: CatchupSource;
  reference: string;
  message: string;
}

export interface CatchupRunResult {
  attempted: number;
  posted: number;
  failures: CatchupRunFailure[];
  /** Vooraf geblokkeerd: nooit aan de writer aangeboden. */
  blocked: number;
}
