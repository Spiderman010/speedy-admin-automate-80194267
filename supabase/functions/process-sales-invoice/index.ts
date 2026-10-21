import {
  authorizeIntakeWrite,
  buildSalesInvoiceInsert,
  INTAKE_FORBIDDEN_MESSAGE,
  SALES_WRITE_MIN_ROLE,
} from "./intake-guards.ts";
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
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

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

    // Verify user with a request-scoped client so RLS applies to the access check
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(
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

    // Validate UUID format to prevent unexpected storage path segments
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(clientId)) {
      return new Response(JSON.stringify({ error: "Invalid client_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authorization: confirm the authenticated user can access this client via RLS
    const { data: clientRow, error: clientErr } = await userClient
      .from("clients")
      .select("id, organization_id")
      .eq("id", clientId)
      .maybeSingle();
    if (clientErr || !clientRow) {
      return new Response(JSON.stringify({ error: INTAKE_FORBIDDEN_MESSAGE }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!clientRow.organization_id) {
      console.error("process-sales-invoice: client has null organization_id", clientId);
      return new Response(JSON.stringify({ error: "Client heeft geen organization_id; neem contact op met de beheerder." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Autorisatie (A2-06/B2-01): de upload en de INSERT hieronder lopen via de
    // service role en omzeilen dus de RLS op sales_invoices. Daarom eerst de
    // rolvloer SALES_WRITE_MIN_ROLE (ontwerpbesluit D2 open; fail-closed gelijk
    // aan role_sales_invoices_insert), in de organisatie van de opgeslagen
    // klantrij — vóór elke schrijfactie, ook in de opslag.
    const decision = await authorizeIntakeWrite(
      userClient,
      user.id,
      clientRow.organization_id,
      SALES_WRITE_MIN_ROLE,
    );
    if (!decision.allowed) {
      return new Response(JSON.stringify({ error: decision.error }), {
        status: decision.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mimeType = file.type || "image/jpeg";
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";

    if (!isImage && !isPdf) {
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Use PDF, JPG, or PNG." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Het bestand gaat pas naar de opslag nadat de extractie is gevalideerd:
    // een weigering (A2-11) mag niets achterlaten, ook geen weesbestand.
    const fileExt = file.name.split(".").pop();
    const filePath = `${user.id}/sales/${clientId}/${crypto.randomUUID()}.${fileExt}`;
    const fileBuffer = await file.arrayBuffer();

    // Convert file to base64 for AI vision
    const base64 = btoa(
      new Uint8Array(fileBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );

    const messages = [
      {
        role: "system",
        content: `Je bent een OCR-assistent voor het verwerken van Nederlandse verkoopfacturen. Analyseer de factuur en extraheer de gevraagde gegevens. Geef alleen de tool call terug, geen extra tekst.

Datuminstructies:
- Datumnotatie is Nederlands: dd-mm-jjjj of dd/mm/jjjj.
- Geef alle datums terug als YYYY-MM-DD.
- invoice_date moet komen van labels zoals "Factuurdatum", "Datum factuur" of "Invoice date".
- Gebruik labels zoals "Vervaldatum", "Betalen voor", "Betalingstermijn" of "Payment due" nooit als invoice_date.

Factuurnummerinstructies:
- Geef invoice_number exact terug zoals afgedrukt.
- Behoud voorloopnullen, prefixes, suffixes, schuine strepen, koppeltekens, punten en andere zichtbare tekens.
- Strip, normaliseer, verkort of herinterpreteer invoice_number niet.`,
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
            text: `Analyseer deze verkoopfactuur en extraheer: klantnaam (de klant aan wie gefactureerd wordt), factuurnummer, factuurdatum, vervaldatum, bedrag exclusief BTW, BTW-bedrag, bedrag inclusief BTW, en BTW-percentage.

Extra instructies:
- Datumnotatie is Nederlands: dd-mm-jjjj of dd/mm/jjjj.
- Geef alle datums terug als YYYY-MM-DD.
- invoice_date moet komen van labels zoals "Factuurdatum", "Datum factuur" of "Invoice date".
- Gebruik labels zoals "Vervaldatum", "Betalen voor", "Betalingstermijn" of "Payment due" nooit als invoice_date.
- Geef invoice_number exact terug zoals afgedrukt.
- Behoud voorloopnullen, prefixes, suffixes, schuine strepen, koppeltekens, punten en andere zichtbare tekens.
- Strip, normaliseer, verkort of herinterpreteer invoice_number niet.`,
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

    // A2-01/A2-11/B2-04/B2-05: deterministische validatie vóór elke
    // schrijfactie. Geen verzonnen factuurnummer of -datum: ontbreekt een van
    // beide (NOT NULL-kolommen), dan wordt niets opgeslagen. 0 blijft 0, en
    // remaining_amount is het bedrag incl. btw alleen als de bedragen kloppen —
    // anders NULL, nooit 0. Overige bevindingen staan in `notes`.
    const decisionRow = buildSalesInvoiceInsert(extracted, {
      userId: user.id,
      clientId,
      organizationId: clientRow.organization_id,
      filePath,
      now: new Date(),
    });
    if (!decisionRow.ok) {
      return new Response(
        JSON.stringify({ error: decisionRow.error, missing: decisionRow.missing }),
        { status: decisionRow.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // H-03: de AI-aanroep hierboven kan tientallen seconden duren. Wie in dat
    // venster zijn rol of lidmaatschap verliest, mag niets meer opslaan: de
    // rolcheck wordt vlak vóór de upload en de INSERT met de service role herhaald.
    const recheck = await authorizeIntakeWrite(
      userClient,
      user.id,
      clientRow.organization_id,
      SALES_WRITE_MIN_ROLE,
    );
    if (!recheck.allowed) {
      return new Response(JSON.stringify({ error: recheck.error }), {
        status: recheck.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // Save to sales_invoices
    const { data: invoice, error: insertError } = await supabase
      .from("sales_invoices")
      .insert(decisionRow.row)
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
