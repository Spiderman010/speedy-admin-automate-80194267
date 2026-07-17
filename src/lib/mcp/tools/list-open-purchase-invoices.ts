import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_open_purchase_invoices",
  title: "Openstaande inkoopfacturen",
  description:
    "Geef inkoopfacturen met status 'te_controleren' voor de ingelogde gebruiker, optioneel gefilterd op klant.",
  inputSchema: {
    client_id: z.string().uuid().optional().describe("Optioneel klant-id om op te filteren"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximaal aantal (standaard 50)"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ client_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Niet geauthenticeerd" }], isError: true };
    }
    let q = supabaseForUser(ctx)
      .from("purchase_invoices")
      .select("id, invoice_number, invoice_date, amount_incl, amount_excl, btw_amount, status, client_id, supplier_name")
      .eq("status", "te_controleren")
      .order("invoice_date", { ascending: false })
      .limit(limit ?? 50);
    if (client_id) q = q.eq("client_id", client_id);
    const { data, error } = await q;
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { invoices: data ?? [] },
    };
  },
});
