import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      console.error("Missing env vars:", { hasUrl: !!SUPABASE_URL, hasSRK: !!SUPABASE_SERVICE_ROLE_KEY, hasAnon: !!SUPABASE_ANON_KEY });
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const clientId = formData.get("client_id") as string | null;

    if (!file || !clientId) {
      return new Response(JSON.stringify({ error: "file and client_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Upload file to storage
    const fileExt = file.name.split(".").pop();
    const filePath = `${user.id}/sales/${clientId}/${crypto.randomUUID()}.${fileExt}`;
    const fileBuffer = await file.arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(filePath, fileBuffer, { contentType: file.type });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return new Response(JSON.stringify({ error: "File upload failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Convert file to base64 for AI vision
    const base64 = btoa(
      new Uint8Array(fileBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );

    const mimeType = file.type || "image/jpeg";
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";

    if (!isImage && !isPdf) {
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Use PDF, JPG, or PNG." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const messages = [
      {
        role: "system",
        content: `Je bent een OCR-assistent voor het verwerken van Nederlandse verkoopfacturen. Analyseer de factuur en extraheer de gevraagde gegevens. Geef alleen de tool call terug, geen extra tekst.`,
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
          {
            type: "text",
            text: "Analyseer deze verkoopfactuur en extraheer: klantnaam (de klant aan wie gefactureerd wordt), factuurnummer, factuurdatum, vervaldatum, bedrag exclusief BTW, BTW-bedrag, bedrag inclusief BTW, en BTW-percentage.",
          },
        ],
      },
    ];

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "extract_sales_invoice",
              description: "Extract structured data from a Dutch sales invoice",
              parameters: {
                type: "object",
                properties: {
                  customer_name: { type: "string", description: "Naam van de klant aan wie gefactureerd wordt" },
                  invoice_number: { type: "string", description: "Factuurnummer" },
                  invoice_date: { type: "string", description: "Factuurdatum in YYYY-MM-DD formaat" },
                  due_date: { type: "string", description: "Vervaldatum in YYYY-MM-DD formaat" },
                  amount_excl: { type: "number", description: "Bedrag exclusief BTW in EUR" },
                  btw_amount: { type: "number", description: "BTW-bedrag in EUR" },
                  amount_incl: { type: "number", description: "Bedrag inclusief BTW in EUR" },
                  btw_percentage: { type: "number", description: "BTW-percentage (bijv. 21, 9, 0)" },
                },
                required: ["customer_name"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_sales_invoice" } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "AI rate limit bereikt, probeer het later opnieuw." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI-tegoed op. Voeg credits toe in Workspace instellingen." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "AI processing failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    let extracted: any = {};

    try {
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (toolCall?.function?.arguments) {
        extracted = JSON.parse(toolCall.function.arguments);
      }
    } catch (e) {
      console.error("Failed to parse AI response:", e);
    }

    // Save to sales_invoices
    const { data: invoice, error: insertError } = await supabase
      .from("sales_invoices")
      .insert({
        user_id: user.id,
        client_id: clientId,
        customer_name: extracted.customer_name || "Onbekend",
        invoice_number: extracted.invoice_number || `VF-${Date.now()}`,
        invoice_date: extracted.invoice_date || new Date().toISOString().split("T")[0],
        due_date: extracted.due_date || null,
        amount_excl: extracted.amount_excl || null,
        btw_amount: extracted.btw_amount || null,
        amount_incl: extracted.amount_incl || null,
        btw_percentage: extracted.btw_percentage || null,
        // Fall back to 0 so allocation logic always has a numeric starting point
        remaining_amount: extracted.amount_incl ?? extracted.amount_excl ?? 0,
        pdf_path: filePath,
        status: "concept",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return new Response(JSON.stringify({ error: "Failed to save invoice" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ invoice, extracted }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("process-sales-invoice error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
