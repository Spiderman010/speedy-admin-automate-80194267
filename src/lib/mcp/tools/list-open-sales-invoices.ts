import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { getEnv } from "../_env";

function supabaseForUser(ctx: ToolContext) {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_PUBLISHABLE_KEY") || getEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_open_sales_invoices",
  title: "Openstaande verkoopfacturen",
  description:
    "Geef verkoopfacturen met een openstaand bedrag (remaining_amount > 0), optioneel gefilterd op klant.",
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
      .from("sales_invoices")
      .select("id, invoice_number, invoice_date, due_date, customer_name, amount_incl, remaining_amount, status, client_id")
      .gt("remaining_amount", 0)
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
