import type { BookingTemplate } from "@/hooks/useBookingTemplates";
import type { Tables } from "@/integrations/supabase/types";

type Grootboekrekening = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "omschrijving">;

export interface BookingTemplateFormState {
  zoekterm: string;
  zoek_in: string;
  actie: string;
  ledger_account_text: string;
  grootboekrekening_id: string | null;
  geldt_voor: string;
  client_id_filter: string | null;
  prioriteit: number;
  actief: boolean;
}

export interface BookingTemplateTransaction {
  description?: string | null;
  reference?: string | null;
  counterAccount?: string | null;
  matchConfidence: number | null;
  matchStatus: "gematcht" | "suggestie" | "niet_gematcht" | "handmatig_geboekt";
}

export interface AppliedBookingTemplateFields {
  grootboekrekeningId?: string | null;
  grootboekText?: string | null;
  templateName?: string | null;
}

function formatLedgerLabel(account: Grootboekrekening) {
  return `${account.nummer} - ${account.omschrijving}`;
}

export function createEmptyBookingTemplateFormState(): BookingTemplateFormState {
  return {
    zoekterm: "",
    zoek_in: "alles",
    actie: "grootboek",
    ledger_account_text: "",
    grootboekrekening_id: null,
    geldt_voor: "alle",
    client_id_filter: null,
    prioriteit: 0,
    actief: true,
  };
}

export function getBookingTemplateLedgerLabel(
  template: Pick<BookingTemplate, "ledger_account_text" | "grootboekrekening_id">,
  accounts?: Grootboekrekening[],
) {
  if (template.grootboekrekening_id && accounts) {
    const ledger = accounts.find((account) => account.id === template.grootboekrekening_id);
    if (ledger) return formatLedgerLabel(ledger);
  }

  return template.ledger_account_text ?? "";
}

export function resolveBookingTemplateLedger(
  template: Pick<BookingTemplate, "actie" | "grootboekrekening_id">,
  accounts?: Grootboekrekening[],
) {
  if (template.actie !== "grootboek" || !template.grootboekrekening_id || !accounts) {
    return null;
  }

  return accounts.find((account) => account.id === template.grootboekrekening_id) ?? null;
}

export function toBookingTemplateFormState(
  template: BookingTemplate,
  accounts?: Grootboekrekening[],
): BookingTemplateFormState {
  return {
    zoekterm: template.zoekterm || "",
    zoek_in: template.zoek_in || "alles",
    actie: template.actie || "grootboek",
    ledger_account_text: getBookingTemplateLedgerLabel(template, accounts),
    grootboekrekening_id: template.grootboekrekening_id ?? null,
    geldt_voor: template.geldt_voor || "alle",
    client_id_filter: template.client_id_filter,
    prioriteit: template.prioriteit || 0,
    actief: template.actief ?? true,
  };
}

export function buildBookingTemplateMutationPayload(form: BookingTemplateFormState) {
  const isGrootboekAction = form.actie === "grootboek";

  return {
    zoekterm: form.zoekterm,
    zoek_in: form.zoek_in,
    actie: form.actie,
    ledger_account_text: isGrootboekAction ? (form.ledger_account_text || null) : null,
    grootboekrekening_id: isGrootboekAction ? form.grootboekrekening_id : null,
    geldt_voor: form.geldt_voor,
    client_id_filter: form.geldt_voor === "specifieke_klant" ? form.client_id_filter : null,
    prioriteit: form.prioriteit,
    actief: form.actief,
  };
}

export function applyBookingTemplatesToTransactions<T extends BookingTemplateTransaction>(
  transactions: T[],
  templates: BookingTemplate[],
  clientId: string,
): Array<T & AppliedBookingTemplateFields> {
  const activeTemplates = templates
    .filter((template) => template.actief && template.zoekterm)
    .filter((template) => !template.client_id_filter || template.client_id_filter === clientId)
    .sort((a, b) => (b.prioriteit ?? 0) - (a.prioriteit ?? 0));

  if (!activeTemplates.length) return transactions;

  return transactions.map((tx) => {
    if (tx.matchStatus === "gematcht") return tx;

    const desc = (tx.description || "").toLowerCase();
    const ref = (tx.reference || "").toLowerCase();
    const counter = (tx.counterAccount || "").toLowerCase();

    for (const template of activeTemplates) {
      const zoekterm = (template.zoekterm || "").toLowerCase();
      const zoekIn = template.zoek_in || "alles";

      let found = false;
      if (zoekIn === "alles" || zoekIn === "omschrijving") {
        if (desc.includes(zoekterm)) found = true;
      }
      if (zoekIn === "alles" || zoekIn === "referentie") {
        if (ref.includes(zoekterm)) found = true;
      }
      if (zoekIn === "alles" || zoekIn === "naam") {
        if (counter.includes(zoekterm)) found = true;
      }

      if (!found) continue;
      if (!template.grootboekrekening_id) continue;

      return {
        ...tx,
        matchStatus: "handmatig_geboekt" as const,
        matchConfidence: 100,
        grootboekrekeningId: template.grootboekrekening_id,
        grootboekText: template.ledger_account_text ?? null,
        templateName: template.zoekterm || template.name,
      };
    }

    return tx;
  });
}
