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
  if (posted >= eligible) return "complete";
  return "incomplete";
}

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
      // onderscheiden en telt hier gewoon als postbaar.
      note: "Verlegde BTW op inkoop is niet herkenbaar in de gegevens en is hier niet apart geteld.",
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
      note: null,
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
        bankAwaiting > 0
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
      note: null,
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
