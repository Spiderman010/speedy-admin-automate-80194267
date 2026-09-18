import {
  deriveOpeningBalanceState,
  type OpeningBalanceMarker,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";
import type { LedgerPeriod } from "@/lib/ledger-reporting";

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

export type LedgerSourceKey = "purchase_invoice" | "sales_invoice" | "bank_allocation" | "manual_journal";

export interface LedgerCompletenessCounts {
  purchase: { eligible: number; posted: number };
  /** `refusedVerlegd`: postbare status maar btw_verlegd = true — de schrijver weigert ze. */
  sales: { eligible: number; posted: number; refusedVerlegd: number };
  /** `awaitingInvoice`: koppelingen waarvan de factuur zelf nog niet geboekt is. */
  bank: { eligible: number; posted: number; awaitingInvoice: number };
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
  /** Er is wél een bewering, maar voor een ander boekjaar dan het rapportjaar. */
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
  other_year: "Ander boekjaar",
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
    case "posted": {
      const assertionYear = derived.marker.boekjaar;
      if (assertionYear !== year) {
        return make("other_year", "incomplete", {
          assertionYear,
          note: `De beginbalans van deze administratie is geboekt voor boekjaar ${assertionYear}, niet voor rapportjaar ${year}.`,
        });
      }
      return make("posted", "complete", { assertionYear });
    }
    case "nil": {
      const assertionYear = derived.header.boekjaar;
      if (assertionYear !== year) {
        return make("other_year", "incomplete", {
          assertionYear,
          note: `De nihil-verklaring van deze administratie geldt voor boekjaar ${assertionYear}, niet voor rapportjaar ${year}.`,
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
