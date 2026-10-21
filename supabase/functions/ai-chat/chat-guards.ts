// Pure beslislogica voor ai-chat (B2-07): wie mag de AI-assistent gebruiken,
// en wat mag er naar de AI-gateway.
//
// Geen Deno-globals, geen URL-imports en geen I/O: index.ts (Deno) importeert
// dit bestand als "./chat-guards.ts" en Vitest test het rechtstreeks
// (src/test/ai-chat-guards.test.ts). Het staat naast index.ts, het importpad dat
// in deze repo aantoonbaar mee-deployt.
//
// Niet in deze module: rate limiting per gebruiker of organisatie. Dat vraagt
// nieuwe infrastructuur (een tellertabel of een gateway-instelling) en staat
// als open punt in het rapport.

/** Bovengrens voor de ruwe body, vóór JSON.parse. */
export const CHAT_MAX_BODY_CHARS = 200_000;
/** Bovengrens voor het aantal berichten in één verzoek. */
export const CHAT_MAX_MESSAGES = 200;
/** Alleen de laatste berichten gaan naar het model; de app stuurt het hele gesprek mee. */
export const CHAT_HISTORY_WINDOW = 20;
/** Bovengrens per bericht. */
export const CHAT_MAX_MESSAGE_CHARS = 4_000;
/** Bovengrens voor de tekst die naar het model gaat (het venster samen). */
export const CHAT_MAX_WINDOW_CHARS = 24_000;
/** Bovengrens voor het antwoord van het model. */
export const CHAT_MAX_TOKENS = 1_024;

export const CHAT_FORBIDDEN_MESSAGE =
  "De AI-assistent is alleen beschikbaar voor leden van een organisatie.";
export const CHAT_CHECK_FAILED_MESSAGE =
  "De rechten konden niet worden gecontroleerd; probeer het later opnieuw.";

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

type Refusal = { ok: false; status: 400 | 413; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Leest de ruwe body. Weigert te groot, geen JSON, geen object, of een
 * organisatiecontext die geen uuid is. De berichten zelf toetst
 * validateChatMessages.
 */
export function parseChatBody(
  raw: string,
): { ok: true; body: Record<string, unknown>; organizationId: string | null } | Refusal {
  if (raw.length > CHAT_MAX_BODY_CHARS) {
    return { ok: false, status: 413, error: "Het verzoek is te groot." };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
  const record = body as Record<string, unknown>;
  const org = record.organization_id;
  if (org !== undefined && org !== null && (typeof org !== "string" || !UUID_RE.test(org))) {
    return { ok: false, status: 400, error: "Ongeldige organisatie." };
  }
  return { ok: true, body: record, organizationId: typeof org === "string" ? org : null };
}

/**
 * De berichten die naar het model mogen. Alleen de rollen user en assistant
 * met tekst: een door de client meegegeven system-bericht (of een andere rol,
 * of multimodale inhoud) wordt geweigerd, niet stil weggelaten. Van elk bericht
 * gaan alleen role en content mee, en alleen de laatste CHAT_HISTORY_WINDOW.
 */
export function validateChatMessages(body: Record<string, unknown>): { ok: true; messages: ChatMessage[] } | Refusal {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: "messages is required and must be a non-empty array" };
  }
  if (messages.length > CHAT_MAX_MESSAGES) {
    return { ok: false, status: 400, error: "Het gesprek bevat te veel berichten; begin een nieuw gesprek." };
  }
  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, status: 400, error: "Ongeldig bericht." };
    }
    const { role, content } = m as Record<string, unknown>;
    if (role === "system") {
      return { ok: false, status: 400, error: "Systeemberichten van de client worden niet geaccepteerd." };
    }
    if (role !== "user" && role !== "assistant") {
      return { ok: false, status: 400, error: "Ongeldige berichtrol." };
    }
    if (typeof content !== "string") {
      return { ok: false, status: 400, error: "Berichtinhoud moet tekst zijn." };
    }
    if (content.length > CHAT_MAX_MESSAGE_CHARS) {
      return { ok: false, status: 400, error: `Een bericht is te lang (maximaal ${CHAT_MAX_MESSAGE_CHARS} tekens).` };
    }
  }
  const window = messages
    .slice(-CHAT_HISTORY_WINDOW)
    .map((m) => ({ role: (m as ChatMessage).role, content: (m as ChatMessage).content }));
  const total = window.reduce((sum, m) => sum + m.content.length, 0);
  if (total > CHAT_MAX_WINDOW_CHARS) {
    return { ok: false, status: 400, error: "Het gesprek is te lang; begin een nieuw gesprek." };
  }
  return { ok: true, messages: window };
}

/** Het deel van de Supabase-client (met het JWT van de gebruiker) dat de lidmaatschapstoets nodig heeft. */
export interface ChatMembershipClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        limit(count: number): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/**
 * Lid van de gevraagde organisatie (public.is_organization_member), of — zonder
 * context — van minstens één organisatie (organization_members onder RLS:
 * een gebruiker ziet daar alleen de rijen van zijn eigen organisaties).
 * Fail-closed: een fout of uitzondering weigert.
 */
export async function authorizeChatMember(
  client: ChatMembershipClient,
  userId: string | null | undefined,
  organizationId: string | null,
): Promise<{ allowed: true } | { allowed: false; status: 403 | 500; error: string }> {
  if (!userId) return { allowed: false, status: 403, error: CHAT_FORBIDDEN_MESSAGE };
  try {
    if (organizationId) {
      const { data, error } = await client.rpc("is_organization_member", {
        _user_id: userId,
        _organization_id: organizationId,
      });
      if (error) return { allowed: false, status: 500, error: CHAT_CHECK_FAILED_MESSAGE };
      return data === true ? { allowed: true } : { allowed: false, status: 403, error: CHAT_FORBIDDEN_MESSAGE };
    }
    const { data, error } = await client
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId)
      .limit(1);
    if (error) return { allowed: false, status: 500, error: CHAT_CHECK_FAILED_MESSAGE };
    return Array.isArray(data) && data.length > 0
      ? { allowed: true }
      : { allowed: false, status: 403, error: CHAT_FORBIDDEN_MESSAGE };
  } catch {
    return { allowed: false, status: 500, error: CHAT_CHECK_FAILED_MESSAGE };
  }
}

/** De body voor de AI-gateway: de vaste systeemprompt vooraan en een vaste max_tokens. */
export function buildChatCompletionBody(
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
) {
  return {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: CHAT_MAX_TOKENS,
  };
}
