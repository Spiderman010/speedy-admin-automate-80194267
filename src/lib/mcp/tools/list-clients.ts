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
  name: "list_clients",
  title: "Lijst klanten",
  description: "Geef alle klanten (boekhoudkantoor) waar de ingelogde gebruiker toegang toe heeft.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Niet geauthenticeerd" }], isError: true };
    }
    const { data, error } = await supabaseForUser(ctx)
      .from("clients")
      .select("id, name, organization_id")
      .order("name");
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { clients: data ?? [] },
    };
  },
});
