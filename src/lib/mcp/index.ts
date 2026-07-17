import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listClients from "./tools/list-clients";
import listOpenPurchaseInvoices from "./tools/list-open-purchase-invoices";
import listOpenSalesInvoices from "./tools/list-open-sales-invoices";
import listUnmatchedBankTransactions from "./tools/list-unmatched-bank-transactions";

// Build the Supabase OAuth issuer from the project ref (Vite inlines this at build time).
// Never derive from SUPABASE_URL — that may be a proxy host that mcp-js rejects.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "boekassist-mcp",
  title: "BoekAssist MCP",
  version: "0.1.0",
  instructions:
    "Tools voor BoekAssist — een boekhoudapp voor Nederlandse boekhoudkantoren. Gebruik `list_clients` om klanten op te halen, en de overige tools voor openstaande inkoop-/verkoopfacturen en niet-gematchte banktransacties. Alle tools werken binnen de rechten (RLS) van de ingelogde gebruiker.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    listClients,
    listOpenPurchaseInvoices,
    listOpenSalesInvoices,
    listUnmatchedBankTransactions,
  ],
});
