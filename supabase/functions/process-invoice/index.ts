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
      console.error("Missing env vars:", { SUPABASE_URL: !!SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: !!SUPABASE_ANON_KEY });
      throw new Error("Server configuration error: missing Supabase environment variables");
    }

    // Get auth token
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify user
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
    const filePath = `${user.id}/${clientId}/${crypto.randomUUID()}.${fileExt}`;
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

    let messages: any[];

    if (isImage || isPdf) {
      messages = [
        {
          role: "system",
          content: `Je bent een OCR-assistent voor het verwerken van Nederlandse inkoopfacturen. Analyseer de factuur en extraheer de gevraagde gegevens. Geef alleen de tool call terug, geen extra tekst.

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
              text: `Analyseer deze Nederlandse inkoopfactuur en extraheer de volgende velden van de LEVERANCIER (= verkoper/uitgever van de factuur, NIET de klant/koper):
- leverancier (naam)
- factuurnummer, factuurdatum
- bedragen: excl BTW, BTW-bedrag, incl BTW, BTW-percentage
- supplier_btw_number (BTW-nummer leverancier, bv. NL807936494B01)
- supplier_kvk (KvK-nummer leverancier, meestal 8 cijfers)
- supplier_address (straat + huisnummer van de leverancier)
- supplier_postal_code (postcode leverancier, bv. 1234 AB)
- supplier_city (plaats leverancier)
- supplier_country (land leverancier, alleen als duidelijk zichtbaar)
- supplier_iban (IBAN leverancier indien zichtbaar)

BELANGRIJK: gebruik NOOIT het adres of de gegevens van de klant/koper als leveranciersgegevens. Laat velden leeg/null als ze niet zichtbaar zijn op de factuur.

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
    } else {
      return new Response(
        JSON.stringify({ error: "Unsupported file type. Use PDF, JPG, or PNG." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call Lovable AI with tool calling for structured output
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
              name: "extract_invoice",
              description: "Extract structured data from a Dutch purchase invoice",
              parameters: {
                type: "object",
                properties: {
                  supplier: { type: "string", description: "Naam van de leverancier" },
                  invoice_number: { type: "string", description: "Factuurnummer" },
                  invoice_date: {
                    type: "string",
                    description: "Factuurdatum in YYYY-MM-DD formaat",
                  },
                  amount_excl: {
                    type: "number",
                    description: "Bedrag exclusief BTW in EUR",
                  },
                  btw_amount: { type: "number", description: "BTW-bedrag in EUR" },
                  amount_incl: {
                    type: "number",
                    description: "Bedrag inclusief BTW in EUR",
                  },
                  btw_percentage: {
                    type: "number",
                    description: "BTW-percentage (bijv. 21, 9, 0)",
                  },
                  supplier_btw_number: {
                    type: "string",
                    description: "BTW-nummer van de leverancier (bv. NL807936494B01). Laat leeg indien niet zichtbaar.",
                  },
                  supplier_kvk: {
                    type: "string",
                    description: "KvK-nummer van de leverancier (meestal 8 cijfers). Laat leeg indien niet zichtbaar.",
                  },
                  supplier_address: {
                    type: "string",
                    description: "Straat + huisnummer van de leverancier. Niet het adres van de klant.",
                  },
                  supplier_postal_code: {
                    type: "string",
                    description: "Postcode van de leverancier (bv. 1234 AB).",
                  },
                  supplier_city: {
                    type: "string",
                    description: "Plaats van de leverancier.",
                  },
                  supplier_country: {
                    type: "string",
                    description: "Land van de leverancier (bv. NL). Alleen invullen indien duidelijk zichtbaar.",
                  },
                  supplier_iban: {
                    type: "string",
                    description: "IBAN van de leverancier indien zichtbaar op de factuur.",
                  },
                  raw_text: {
                    type: "string",
                    description: "Volledige ruwe tekst van de factuur, exact zoals zichtbaar (gebruikt voor fallback-extractie).",
                  },
                },
                required: ["supplier"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_invoice" } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "AI rate limit bereikt, probeer het later opnieuw." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI-tegoed op. Voeg credits toe in Workspace instellingen." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "AI processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    // Normalize Dutch VAT number: uppercase, strip separators
    const normalizeBtw = (raw: string | null | undefined): string | null => {
      if (!raw) return null;
      const cleaned = String(raw).toUpperCase().replace(/[\s.\-/\\]/g, "");
      const m = cleaned.match(/NL\d{9}B\d{2}/);
      return m ? m[0] : null;
    };

    // Fallback: regex on raw OCR text if AI did not return a normalized number
    let supplierBtw = normalizeBtw(extracted.supplier_btw_number);
    if (!supplierBtw && extracted.raw_text) {
      supplierBtw = normalizeBtw(extracted.raw_text);
    }
    if (!supplierBtw) {
      // Last resort: scan over the entire extracted JSON string
      supplierBtw = normalizeBtw(JSON.stringify(extracted));
    }

    // Light normalization for new supplier fields (stored in ocr_data only)
    const trimOrNull = (v: any): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s ? s : null;
    };
    const normalizeKvk = (v: any): string | null => {
      const s = trimOrNull(v);
      if (!s) return null;
      const digits = s.replace(/\D+/g, "");
      return digits || s;
    };
    const normalizeIban = (v: any): string | null => {
      const s = trimOrNull(v);
      if (!s) return null;
      return s.toUpperCase().replace(/\s+/g, "");
    };
    const normalizePostal = (v: any): string | null => {
      const s = trimOrNull(v);
      if (!s) return null;
      return s.toUpperCase();
    };

    if (extracted && typeof extracted === "object") {
      const k = normalizeKvk(extracted.supplier_kvk);
      const addr = trimOrNull(extracted.supplier_address);
      const pc = normalizePostal(extracted.supplier_postal_code);
      const city = trimOrNull(extracted.supplier_city);
      const country = trimOrNull(extracted.supplier_country);
      const iban = normalizeIban(extracted.supplier_iban);
      extracted.supplier_kvk = k;
      extracted.supplier_address = addr;
      extracted.supplier_postal_code = pc;
      extracted.supplier_city = city;
      extracted.supplier_country = country;
      extracted.supplier_iban = iban;
    }

    const { data: invoice, error: insertError } = await supabase
      .from("purchase_invoices")
      .insert({
        user_id: user.id,
        client_id: clientId,
        supplier: extracted.supplier || "Onbekend",
        invoice_number: extracted.invoice_number || null,
        invoice_date: extracted.invoice_date || null,
        amount_excl: extracted.amount_excl || null,
        btw_amount: extracted.btw_amount || null,
        amount_incl: extracted.amount_incl || null,
        btw_percentage: extracted.btw_percentage || null,
        supplier_btw_number: supplierBtw,
        // Fall back to 0 so allocation logic always has a numeric starting point
        remaining_amount: extracted.amount_incl ?? extracted.amount_excl ?? 0,
        file_path: filePath,
        ocr_data: extracted,
        status: "te_controleren",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return new Response(JSON.stringify({ error: "Failed to save invoice" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ invoice, extracted }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("process-invoice error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
