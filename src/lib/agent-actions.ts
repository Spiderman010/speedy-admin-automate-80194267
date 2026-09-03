/**
 * Prototype-laag voor de AI-boekingsagent op /ai-chat.
 *
 * BELANGRIJK: alles in dit bestand is mock/demo. Er worden geen echte
 * mutaties uitgevoerd (geen supabase update/insert/rpc). De typen zijn zo
 * opgezet dat de echte hooks later 1-op-1 aangesloten kunnen worden.
 */

export type AgentActionStatus =
  | "proposed"
  | "awaiting_confirmation"
  | "confirmed"
  | "success"
  | "error"
  | "cancelled";

export interface BookingLinePreview {
  omschrijving: string;
  grootboek: string;
  amount_excl: number;
  btw_percentage: number;
}

export type PurchaseInvoiceStatus = "te_controleren" | "gecontroleerd" | "geexporteerd";

export interface AgentInvoiceContext {
  invoice_id: string;
  leverancier: string;
  invoice_number: string;
  administratie: string;
  amount_incl: number;
  status: PurchaseInvoiceStatus;
}

export type AgentAction =
  | {
      id: string;
      type: "change_purchase_invoice_status";
      status: AgentActionStatus;
      payload: {
        invoice: AgentInvoiceContext;
        current_status: PurchaseInvoiceStatus;
        new_status: PurchaseInvoiceStatus;
      };
    }
  | {
      id: string;
      type: "save_purchase_invoice_lines";
      status: AgentActionStatus;
      payload: {
        invoice: AgentInvoiceContext;
        lines: BookingLinePreview[];
      };
    };

export const STATUS_LABELS: Record<PurchaseInvoiceStatus, string> = {
  te_controleren: "Te controleren",
  gecontroleerd: "Gecontroleerd",
  geexporteerd: "Geëxporteerd",
};

/** Demo-context; alleen presentatie, geen query naar de database. */
export const DEMO_INVOICE: AgentInvoiceContext = {
  invoice_id: "demo-inv-1042",
  leverancier: "KPN",
  invoice_number: "INV-2026-1042",
  administratie: "Demo Administratie B.V.",
  amount_incl: 121,
  status: "te_controleren",
};

const DEMO_LINES: BookingLinePreview[] = [
  { omschrijving: "Telefoniekosten", grootboek: "4500", amount_excl: 100, btw_percentage: 21 },
];

export function lineTotals(lines: BookingLinePreview[]) {
  const excl = lines.reduce((sum, l) => sum + l.amount_excl, 0);
  const btw = lines.reduce((sum, l) => sum + (l.amount_excl * l.btw_percentage) / 100, 0);
  return { excl, btw, incl: excl + btw };
}

function newId() {
  return `action-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AgentTurn {
  reply: string;
  action?: AgentAction;
}

/**
 * Zeer eenvoudige, lokale intentieherkenning voor het prototype.
 * Later vervangbaar door tool-calling vanuit de agent.
 */
export function buildAgentTurn(userText: string): AgentTurn {
  const text = userText.toLowerCase();

  const wantsStatus =
    text.includes("status") || text.includes("gecontroleerd") || text.includes("controleer");
  const wantsLines =
    text.includes("boekingsregel") ||
    text.includes("boekingsvoorstel") ||
    text.includes("regels") ||
    text.includes("boeken");

  if (wantsLines) {
    return {
      reply:
        "Ik heb een boekingsvoorstel opgesteld voor deze factuur. Controleer de regels hieronder en bevestig om ze op te slaan.",
      action: {
        id: newId(),
        type: "save_purchase_invoice_lines",
        status: "awaiting_confirmation",
        payload: { invoice: DEMO_INVOICE, lines: DEMO_LINES },
      },
    };
  }

  if (wantsStatus) {
    const naarGecontroleerd = !text.includes("te controleren") || text.includes("gecontroleerd");
    const current: PurchaseInvoiceStatus = naarGecontroleerd ? "te_controleren" : "gecontroleerd";
    const next: PurchaseInvoiceStatus = naarGecontroleerd ? "gecontroleerd" : "te_controleren";
    return {
      reply: `Ik kan de status wijzigen van ${STATUS_LABELS[current]} naar ${STATUS_LABELS[next]}.`,
      action: {
        id: newId(),
        type: "change_purchase_invoice_status",
        status: "awaiting_confirmation",
        payload: { invoice: DEMO_INVOICE, current_status: current, new_status: next },
      },
    };
  }

  return {
    reply:
      "Ik kan in dit prototype twee acties voorstellen: de status van een inkoopfactuur wijzigen of boekingsregels opslaan. Vraag bijvoorbeeld: \u201eZet status op gecontroleerd\u201d of \u201eMaak een boekingsvoorstel\u201d.",
  };
}

/**
 * Mock-uitvoering. Geeft afwisselend een fout terug wanneer de gebruiker
 * de demo-fout wil zien (omschrijving bevat "fout"), zodat de errorstate
 * getoond kan worden. Er gebeurt niets in de database.
 */
export async function mockExecuteAction(
  action: AgentAction,
  options?: { forceError?: boolean },
): Promise<{ ok: boolean }> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { ok: !options?.forceError };
}

export const SUGGESTED_PROMPTS = [
  "Controleer deze factuur",
  "Maak een boekingsvoorstel",
  "Zet status op gecontroleerd",
];
