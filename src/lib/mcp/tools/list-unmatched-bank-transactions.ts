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
  name: "list_unmatched_bank_transactions",
  title: "Niet-gematchte banktransacties",
  description:
    "Geef banktransacties met status 'niet_gematcht' voor de ingelogde gebruiker, optioneel gefilterd op klant.",
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
      .from("bank_transactions")
      .select("id, transaction_date, amount, description, counter_account, reference, match_status, client_id")
      .eq("match_status", "niet_gematcht")
      .order("transaction_date", { ascending: false })
      .limit(limit ?? 50);
    if (client_id) q = q.eq("client_id", client_id);
    const { data, error } = await q;
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { transactions: data ?? [] },
    };
  },
});
