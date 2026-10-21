import {
  deriveOpeningBalanceState,
  type OpeningBalanceMarker,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";
import type { LedgerPeriod } from "@/lib/ledger-reporting";
import type { UnpostedWorkItem, UnpostedWorkSource } from "@/lib/year-close-readiness";

// Fase 6C-b7 PR 2 — volledigheid van het grootboek (metadata, geen geld).
//
// Het grootboek bevat uitsluitend wat expliciet is geboekt. Deze module telt
// per bronsoort hoeveel documenten geboekt zijn tegenover hoeveel er in
// aanmerking komen, zodat het scherm eerlijk kan waarschuwen dat een saldo
// onvolledig kan zijn. Alles hier is een aantal (integer); er komt nooit een
// bedrag uit, en niets hiervan mag ooit een grootboektotaal beïnvloeden.
//
// Wat een schrijver weigert, is geen "nog niet geboekt": een verkoopfactuur
// met btw_verlegd wordt door post_sales_invoice() geweigerd (6C-b4) en telt
// daarom apart als "geweigerd". Voor inkoop is verlegde BTW niet detecteerbaar
// (geen veld), dus daar zeggen we dat eerlijk in plaats van een getal te
// verzinnen.

/** Statussen die post_purchase_invoice() accepteert (6C-b3). */
export const PURCHASE_POSTABLE_STATUSES = ["gecontroleerd", "betaald", "geexporteerd"] as const;
/** Statussen die post_sales_invoice() accepteert (6C-b4). */
export const SALES_POSTABLE_STATUSES = ["gecontroleerd", "betaald"] as const;

/**
 * De status die post_bank_transaction() (de directe bankschrijver) accepteert.
 * Een banktransactie is voor die schrijver postbaar zodra zij handmatig
 * gecodeerd is, een grootboekrekening en een bedrag <> 0 heeft, en NIET aan een
 * factuur is gekoppeld (dan hoort zij bij de afletteringstak). Een marker in
 * bank_transaction_postings betekent "geboekt". Precies dezelfde regel staat in
 * controle D van close_fiscal_year() (20261021200000, herstel P7 / A3-02).
 * Net als bij facturen tellen configuratie en boekingsblokkade NIET mee: het
 * gaat om werk dat nog geboekt moet worden, niet om de vraag of dat vandaag kan.
 */
export const DIRECT_BANK_POSTABLE_STATUS = "handmatig_geboekt" as const;

export type LedgerSourceKey =
  | "purchase_invoice"
  | "sales_invoice"
  | "bank_allocation"
  | "bank_transaction"
  | "manual_journal";

export interface LedgerCompletenessCounts {
  purchase: { eligible: number; posted: number };
  /** `refusedVerlegd`: postbare status maar btw_verlegd = true — de schrijver weigert ze. */
  sales: { eligible: number; posted: number; refusedVerlegd: number };
  /** `awaitingInvoice`: koppelingen waarvan de factuur zelf nog niet geboekt is. */
  bank: { eligible: number; posted: number; awaitingInvoice: number };
  /**
   * De directe bankschrijver (post_bank_transaction): gecodeerde bankregels
   * zonder koppeling, en hoeveel daarvan een marker hebben. Verplicht: wie de
   * tellingen levert, moet ook deze bron tellen — een weggelaten bron is geen
   * "niets open".
   */
  bankDirect: { eligible: number; posted: number };
  manual: { total: number; posted: number };
}

export type LedgerSourceStatus = "complete" | "incomplete" | "empty" | "unknown";

export interface LedgerSourceCompleteness {
  key: LedgerSourceKey;
  label: string;
  posted: number;
  eligible: number;
  /** Nog niet geboekt maar wél postbaar. */
  outstanding: number;
  status: LedgerSourceStatus;
  /** Documenten die de schrijver bewust weigert — géén "nog niet geboekt". */
  refused: number | null;
  refusedLabel: string | null;
  /** Eerlijke kanttekening wanneer een deel niet veilig telbaar is. */
  note: string | null;
}

export interface LedgerCompleteness {
  sources: LedgerSourceCompleteness[];
  /** Ten minste één bron heeft postbare, nog niet geboekte documenten of een onbekende status. */
  mayBeIncomplete: boolean;
  totalOutstanding: number;
}

function statusFor(posted: number, eligible: number): LedgerSourceStatus {
  if (eligible === 0 && posted === 0) return "empty";
  // Meer geboekt dan postbaar kan niet kloppen (bv. een marker zonder
  // postbaar document): dan weten we het niet, en zeggen we dat.
  if (posted > eligible) return "unknown";
  if (posted === eligible) return "complete";
  return "incomplete";
}

const INCONSISTENT_NOTE = "Geboekt overtreft postbaar; de tellingen zijn niet consistent en de volledigheid is onbekend.";

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function computeLedgerCompleteness(counts: LedgerCompletenessCounts): LedgerCompleteness {
  const purchasePosted = nonNegative(counts.purchase.posted);
  const purchaseEligible = nonNegative(counts.purchase.eligible);
  const salesPosted = nonNegative(counts.sales.posted);
  const salesEligible = nonNegative(counts.sales.eligible);
  const salesRefused = nonNegative(counts.sales.refusedVerlegd);
  const bankPosted = nonNegative(counts.bank.posted);
  const bankEligible = nonNegative(counts.bank.eligible);
  const bankAwaiting = nonNegative(counts.bank.awaitingInvoice);
  const directPosted = nonNegative(counts.bankDirect.posted);
  const directEligible = nonNegative(counts.bankDirect.eligible);
  const manualPosted = nonNegative(counts.manual.posted);
  const manualTotal = nonNegative(counts.manual.total);

  const sources: LedgerSourceCompleteness[] = [
    {
      key: "purchase_invoice",
      label: "Inkoopfacturen",
      posted: purchasePosted,
      eligible: purchaseEligible,
      outstanding: Math.max(0, purchaseEligible - purchasePosted),
      status: statusFor(purchasePosted, purchaseEligible),
      refused: null,
      refusedLabel: null,
      // Inkoop heeft geen veld voor verlegde BTW; zo'n factuur is niet te
      // onderscheiden en telt hier als "niet in het grootboek". Ook andere
      // weigeringen van de schrijver (regel zonder rekening, afgesloten
      // boekjaar) zijn hier niet vooraf te zien.
      note:
        purchasePosted > purchaseEligible
          ? INCONSISTENT_NOTE
          : "Telt facturen met een postbare status die niet in het grootboek staan; verlegde BTW op inkoop is niet herkenbaar en niet apart geteld.",
    },
    {
      key: "sales_invoice",
      label: "Verkoopfacturen",
      posted: salesPosted,
      eligible: salesEligible,
      outstanding: Math.max(0, salesEligible - salesPosted),
      status: statusFor(salesPosted, salesEligible),
      refused: salesRefused,
      refusedLabel: salesRefused > 0 ? "geweigerd (BTW verlegd)" : null,
      note: salesPosted > salesEligible ? INCONSISTENT_NOTE : null,
    },
    {
      key: "bank_allocation",
      label: "Bankafletteringen",
      posted: bankPosted,
      eligible: bankEligible,
      outstanding: Math.max(0, bankEligible - bankPosted),
      status: statusFor(bankPosted, bankEligible),
      refused: null,
      refusedLabel: null,
      note:
        bankPosted > bankEligible
          ? INCONSISTENT_NOTE
          : bankAwaiting > 0
            ? `${bankAwaiting} koppeling${bankAwaiting === 1 ? "" : "en"} wacht${bankAwaiting === 1 ? "" : "en"} op het boeken van de factuur.`
            : null,
    },
    {
      key: "bank_transaction",
      label: "Gecodeerde bankregels",
      posted: directPosted,
      eligible: directEligible,
      outstanding: Math.max(0, directEligible - directPosted),
      status: statusFor(directPosted, directEligible),
      refused: null,
      refusedLabel: null,
      // Een regel die nog niet gecodeerd is (niet_gematcht, suggestie) of op
      // 'gematcht' staat zonder koppeling, kan geen enkele schrijver boeken; die
      // telt hier dus niet als postbaar. Dat staat er eerlijk bij.
      note:
        directPosted > directEligible
          ? INCONSISTENT_NOTE
          : "Telt handmatig gecodeerde bankregels zonder factuurkoppeling; nog niet gecodeerde regels en 'gematcht' zonder koppeling tellen hier niet mee.",
    },
    {
      key: "manual_journal",
      label: "Memoriaalboekingen",
      posted: manualPosted,
      eligible: manualTotal,
      outstanding: Math.max(0, manualTotal - manualPosted),
      status: statusFor(manualPosted, manualTotal),
      refused: null,
      refusedLabel: null,
      note: manualPosted > manualTotal ? INCONSISTENT_NOTE : null,
    },
  ];

  const totalOutstanding = sources.reduce((s, x) => s + x.outstanding, 0);
  const mayBeIncomplete = sources.some((s) => s.status === "incomplete" || s.status === "unknown");
  return { sources, mayBeIncomplete, totalOutstanding };
}

/** Wanneer de tellingen zelf niet opgehaald konden worden: eerlijk 'onbekend'. */
export function unknownLedgerCompleteness(): LedgerCompleteness {
  const unknown = (key: LedgerSourceKey, label: string): LedgerSourceCompleteness => ({
    key,
    label,
    posted: 0,
    eligible: 0,
    outstanding: 0,
    status: "unknown",
    refused: null,
    refusedLabel: null,
    note: "Volledigheid kon niet worden bepaald.",
  });
  return {
    sources: [
      unknown("purchase_invoice", "Inkoopfacturen"),
      unknown("sales_invoice", "Verkoopfacturen"),
      unknown("bank_allocation", "Bankafletteringen"),
      unknown("bank_transaction", "Gecodeerde bankregels"),
      unknown("manual_journal", "Memoriaalboekingen"),
    ],
    mayBeIncomplete: true,
    totalOutstanding: 0,
  };
}

// ── Beginbalans (6C-b8 PR 3) ────────────────────────────────────────────────
//
// Een eigen dimensie naast de documenttellingen: heeft deze administratie
// voor het rapportjaar een beginbalans-bewering? Uitsluitend afgeleid uit de
// domeintabellen (opening_balances + opening_balance_postings), nooit uit
// source_type-rijen in het grootboek en nooit uit bedragen. "Niet ingesteld"
// en "nihil" zijn verschillende boekhoudkundige uitspraken en worden nooit
// samengevoegd; wat niet te controleren is, heet "onbekend".

export type OpeningBalanceCompletenessState =
  | "not_set"
  | "draft"
  | "posted"
  | "nil"
  /** Geboekt voor een eerder boekjaar: de beginpositie loopt via het grootboek door. */
  | "posted_prior"
  /** Nihil verklaard voor een eerder boekjaar. */
  | "nil_prior"
  /** Er is wél een bewering, maar voor een LATER boekjaar dan het rapportjaar. */
  | "other_year"
  | "conflict"
  /** Rapportperiode beslaat meer dan één kalenderjaar: niet te bepalen. */
  | "ambiguous"
  | "unknown";

export interface OpeningBalanceCompleteness {
  state: OpeningBalanceCompletenessState;
  /** Rapportjaar waarvoor de bewering is gezocht; null wanneer niet eenduidig. */
  year: number | null;
  /** Boekjaar van de gevonden bewering (geboekt/nihil), ook als dat een ander jaar is. */
  assertionYear: number | null;
  /** Aantal concepten voor het rapportjaar. */
  draftCount: number;
  label: string;
  /** Rapportvolledigheid: geboekt en nihil zijn 'complete', de rest niet. */
  severity: "complete" | "incomplete" | "unknown";
  note: string | null;
}

export const OPENING_BALANCE_STATE_LABELS: Readonly<Record<OpeningBalanceCompletenessState, string>> = {
  not_set: "Niet ingesteld",
  draft: "Concept",
  posted: "Geboekt",
  nil: "Nihil",
  posted_prior: "Geboekt (eerder boekjaar)",
  nil_prior: "Nihil (eerder boekjaar)",
  other_year: "Later boekjaar",
  conflict: "Conflict",
  ambiguous: "Niet te bepalen voor meerdere boekjaren",
  unknown: "Onbekend",
};

/**
 * Het kalenderjaar van een half-open periode [from, toExclusive), of null als
 * de periode meer dan één kalenderjaar raakt. Rekent op ISO-datums (JJJJ-MM-DD)
 * en verzint geen gebroken boekjaar.
 */
export function reportYearForPeriod(period: LedgerPeriod): number | null {
  const fromYear = Number(period.from.slice(0, 4));
  const end = new Date(`${period.toExclusive}T00:00:00Z`);
  if (!Number.isFinite(fromYear) || Number.isNaN(end.getTime())) return null;
  end.setUTCDate(end.getUTCDate() - 1);
  const toYear = end.getUTCFullYear();
  return fromYear === toYear ? fromYear : null;
}

export function computeOpeningBalanceCompleteness(input: {
  headers: readonly OpeningBalanceRow[];
  marker: OpeningBalanceMarker | null;
  year: number | null;
}): OpeningBalanceCompleteness {
  const { headers, marker, year } = input;
  const base = { year, assertionYear: null as number | null, draftCount: 0, note: null as string | null };
  const make = (
    state: OpeningBalanceCompletenessState,
    severity: OpeningBalanceCompleteness["severity"],
    extra: Partial<OpeningBalanceCompleteness> = {},
  ): OpeningBalanceCompleteness => ({
    ...base,
    state,
    severity,
    label: OPENING_BALANCE_STATE_LABELS[state],
    ...extra,
  });

  if (year === null) {
    return make("ambiguous", "unknown", {
      note: "De rapportperiode beslaat meer dan één kalenderjaar; kies één boekjaar om de beginbalansstatus te zien.",
    });
  }
  const derived = deriveOpeningBalanceState({ headers, marker, boekjaar: year });
  switch (derived.kind) {
    case "conflict":
      return make("conflict", "unknown", { note: derived.message });
    // Per administratie bestaat hoogstens één bewering, ooit. Een bewering voor
    // een EERDER boekjaar is daarmee de beginpositie van elk later jaar: het
    // grootboek voert haar via de gewone rekenkunde door (beginsaldo = alles
    // vóór de periode). Een bewering voor een LATER boekjaar zegt niets over
    // dit rapportjaar en telt niet als passend.
    case "posted": {
      const assertionYear = derived.marker.boekjaar;
      if (assertionYear > year) {
        return make("other_year", "incomplete", {
          assertionYear,
          note: `De beginbalans van deze administratie is geboekt voor boekjaar ${assertionYear}, na rapportjaar ${year}.`,
        });
      }
      if (assertionYear < year) {
        return make("posted_prior", "complete", {
          assertionYear,
          note: `Geboekt voor boekjaar ${assertionYear}; de beginpositie van ${year} volgt via het grootboek uit de jaren ervoor.`,
        });
      }
      return make("posted", "complete", { assertionYear });
    }
    case "nil": {
      const assertionYear = derived.header.boekjaar;
      if (assertionYear > year) {
        return make("other_year", "incomplete", {
          assertionYear,
          note: `De nihil-verklaring van deze administratie geldt voor boekjaar ${assertionYear}, na rapportjaar ${year}.`,
        });
      }
      if (assertionYear < year) {
        return make("nil_prior", "complete", {
          assertionYear,
          note: `Bewust op nihil gezet voor boekjaar ${assertionYear}; de beginpositie van ${year} volgt via het grootboek uit de jaren ervoor.`,
        });
      }
      return make("nil", "complete", {
        assertionYear,
        note: "Bewust vastgelegd: geen beginbalans nodig; er is niets in het grootboek geboekt.",
      });
    }
    case "draft":
      return make("draft", "incomplete", { draftCount: 1, note: "Er is een concept dat nog niet is geboekt." });
    case "multiple-drafts":
      return make("draft", "incomplete", {
        draftCount: derived.drafts.length,
        note: `Er zijn ${derived.drafts.length} concepten voor dit boekjaar; geen ervan is geboekt.`,
      });
    case "none":
      return make("not_set", "incomplete", {
        note:
          derived.otherDrafts.length > 0
            ? "Geen beginbalans voor dit boekjaar; er bestaan wel concepten voor een ander boekjaar."
            : "Geen beginbalans-bewering voor dit boekjaar: niet geboekt en niet op nihil verklaard.",
      });
  }
}

/** Wanneer de domeintabellen niet gelezen konden worden: eerlijk 'onbekend', nooit 'niet ingesteld'. */
export function unknownOpeningBalanceCompleteness(year: number | null): OpeningBalanceCompleteness {
  return {
    state: "unknown",
    year,
    assertionYear: null,
    draftCount: 0,
    label: OPENING_BALANCE_STATE_LABELS.unknown,
    severity: "unknown",
    note: "Kon beginbalansstatus niet controleren.",
  };
}

// ── Bronwerk per rapportperiode (herstel P7, A3-11) ─────────────────────────
//
// "Volledig" op de balans en de winst-en-verliesrekening betekende alleen
// "alle grootboekactiviteit is geclassificeerd" (de statement-engine weet niets
// van documenten). Een rapport mag pas volledig heten als er ook geen
// ongeboekt bronwerk is dat erin thuishoort. Deze functie telt dat werk per
// rapportperiode, uitsluitend met de bestaande definities:
//   • postbaar maar nog niet geboekt — exact `fetchUnpostedSourceWork()`, de
//     bron van de jaarafsluiting (vijf schrijvers, incl. gecodeerde bankregels);
//   • door de schrijver GEWEIGERD — een verkoopfactuur met verlegde btw
//     (post_sales_invoice weigert die altijd). Die staat nooit in het
//     grootboek, dus een rapport met zo'n factuur is aantoonbaar niet volledig.
// Welk werk bij welk rapport hoort, volgt uit het boekjaar (de boekhoudkundige
// datum, nooit created_at):
//   • balans (stand op de einddatum): boekjaar t/m het laatste jaar van de periode;
//   • W&V (mutatie in de periode): boekjaar binnen de jaren van de periode.
// Boekjaar = kalenderjaar, dus een kwartaal telt het werk van het hele jaar
// mee: strenger, nooit soepeler. Een document zonder datum telt altijd mee.

export interface RefusedWorkItem {
  source: "sales_invoice";
  id: string;
  /** Uit invoice_date; null = onbekend (telt dan altijd mee). */
  boekjaar: number | null;
  reason: "btw_verlegd";
}

export type ReportStatementKind = "balans" | "winst_verlies";

export interface ReportDocumentCompleteness {
  status: "complete" | "incomplete";
  /** Postbaar, nog niet geboekt, per bron (alleen bronnen met > 0), in vaste volgorde. */
  unposted: Array<{ source: UnpostedWorkSource; count: number }>;
  /** Door de schrijver geweigerd: staat niet in het grootboek. */
  refused: Array<{ source: "sales_invoice"; reason: "btw_verlegd"; count: number }>;
  totalUnposted: number;
  totalRefused: number;
  /** Er staat bankwerk open (gecodeerde bankregels of bankafletteringen): de bank-inhaalslag helpt. */
  bankWorkOpen: boolean;
  /** De meegetelde boekjaren, inclusief; `fromYear` null = alle eerdere jaren. */
  scope: { fromYear: number | null; throughYear: number };
  /** Telbare zin, bv. "3 bankregels en 1 inkoopfactuur nog niet geboekt"; null als alles geboekt is. */
  summary: string | null;
}

const SOURCE_ORDER: readonly UnpostedWorkSource[] = [
  "purchase_invoice",
  "sales_invoice",
  "bank_transaction",
  "bank_allocation",
  "manual_journal",
];

const SOURCE_NOUN: Readonly<Record<UnpostedWorkSource, [string, string]>> = {
  purchase_invoice: ["inkoopfactuur", "inkoopfacturen"],
  sales_invoice: ["verkoopfactuur", "verkoopfacturen"],
  bank_transaction: ["bankregel", "bankregels"],
  bank_allocation: ["bankaflettering", "bankafletteringen"],
  manual_journal: ["memoriaalboeking", "memoriaalboekingen"],
};

function telling(n: number, [enkel, meervoud]: [string, string]): string {
  return `${n} ${n === 1 ? enkel : meervoud}`;
}

function opsomming(delen: readonly string[]): string {
  if (delen.length <= 1) return delen.join("");
  return `${delen.slice(0, -1).join(", ")} en ${delen[delen.length - 1]}`;
}

/** De kalenderjaren van een half-open periode [from, toExclusive). */
export function periodYears(period: LedgerPeriod): { fromYear: number; throughYear: number } {
  const fromYear = Number(period.from.slice(0, 4));
  const end = new Date(`${period.toExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return { fromYear, throughYear: end.getUTCFullYear() };
}

export function reportDocumentCompleteness(input: {
  unposted: readonly UnpostedWorkItem[];
  refused: readonly RefusedWorkItem[];
  period: LedgerPeriod;
  statement: ReportStatementKind;
}): ReportDocumentCompleteness {
  const { fromYear, throughYear } = periodYears(input.period);
  const lowerBound = input.statement === "balans" ? null : fromYear;
  const hoortErbij = (boekjaar: number | null | undefined) =>
    boekjaar === null || boekjaar === undefined ||
    (boekjaar <= throughYear && (lowerBound === null || boekjaar >= lowerBound));

  const perBron = new Map<UnpostedWorkSource, number>();
  for (const item of input.unposted) {
    if (!hoortErbij(item.boekjaar)) continue;
    perBron.set(item.source, (perBron.get(item.source) ?? 0) + 1);
  }
  const unposted = SOURCE_ORDER.filter((s) => (perBron.get(s) ?? 0) > 0).map((source) => ({
    source,
    count: perBron.get(source)!,
  }));
  const geweigerd = input.refused.filter((r) => hoortErbij(r.boekjaar)).length;
  const refused = geweigerd > 0 ? [{ source: "sales_invoice" as const, reason: "btw_verlegd" as const, count: geweigerd }] : [];

  const totalUnposted = unposted.reduce((n, u) => n + u.count, 0);
  const delen: string[] = [];
  if (totalUnposted > 0) {
    delen.push(`${opsomming(unposted.map((u) => telling(u.count, SOURCE_NOUN[u.source])))} nog niet geboekt`);
  }
  if (geweigerd > 0) {
    delen.push(
      `${telling(geweigerd, ["verkoopfactuur", "verkoopfacturen"])} met verlegde btw ${geweigerd === 1 ? "kan" : "kunnen"} niet worden geboekt`,
    );
  }
  return {
    status: totalUnposted + geweigerd > 0 ? "incomplete" : "complete",
    unposted,
    refused,
    totalUnposted,
    totalRefused: geweigerd,
    bankWorkOpen: unposted.some((u) => u.source === "bank_transaction" || u.source === "bank_allocation"),
    scope: { fromYear: lowerBound, throughYear },
    summary: delen.length > 0 ? delen.join("; ") : null,
  };
}
