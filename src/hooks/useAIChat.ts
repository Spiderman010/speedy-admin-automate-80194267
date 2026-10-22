import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  buildAgentTurn,
  mockExecuteAction,
  type AgentAction,
} from "@/lib/agent-actions";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  action?: AgentAction;
};

/**
 * Alleen de laatste berichten gaan naar ai-chat: de functie stuurt er ook niet
 * meer naar het model (CHAT_HISTORY_WINDOW in supabase/functions/ai-chat/
 * chat-guards.ts). Zo blijft een lang gesprek onder de body- en berichtlimiet.
 */
const AI_CHAT_HISTORY_WINDOW = 20;

/** Gelijk aan CHAT_MAX_MESSAGE_CHARS in supabase/functions/ai-chat/chat-guards.ts. */
export const AI_CHAT_MAX_MESSAGE_CHARS = 4_000;
export const AI_CHAT_TOO_LONG_MESSAGE =
  `Je bericht is te lang (maximaal ${AI_CHAT_MAX_MESSAGE_CHARS} tekens). Maak het korter en probeer het opnieuw.`;
export const AI_CHAT_REFUSED_MESSAGE = "De AI-assistent kon dit bericht niet verwerken.";

/**
 * Een weigering van ai-chat (400/413) is een echte fout van dit verzoek: die
 * hoort als foutmelding in beeld, niet verstopt achter het prototype-antwoord.
 * Geeft de melding terug, of null als het geen weigering was.
 */
async function refusalMessage(err: unknown): Promise<string | null> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (!ctx || typeof ctx !== "object" || !("status" in ctx)) return null;
  const status = (ctx as { status: unknown }).status;
  if (status !== 400 && status !== 413) return null;
  try {
    const body = await (ctx as Response).clone().json();
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // geen JSON: de algemene melding volstaat
  }
  return AI_CHAT_REFUSED_MESSAGE;
}

function newId() {
  return `msg-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateAction = (actionId: string, patch: Partial<AgentAction>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.action && m.action.id === actionId
          ? ({ ...m, action: { ...m.action, ...patch } as AgentAction } as ChatMessage)
          : m,
      ),
    );
  };

  const findAction = (actionId: string) =>
    messages.find((m) => m.action?.id === actionId)?.action;

  /** Mock-uitvoering: er wordt niets in de database gewijzigd. */
  const runAction = async (actionId: string) => {
    const action = findAction(actionId);
    if (!action) return;
    updateAction(actionId, { status: "confirmed" });
    const result = await mockExecuteAction(action);
    updateAction(actionId, { status: result.ok ? "success" : "error" });
  };

  const confirmAction = (actionId: string) => {
    void runAction(actionId);
  };

  const cancelAction = (actionId: string) => {
    updateAction(actionId, { status: "cancelled" });
  };

  const retryAction = (actionId: string) => {
    updateAction(actionId, { status: "awaiting_confirmation" });
  };

  const dismissAction = (actionId: string) => {
    updateAction(actionId, { status: "cancelled" });
  };

  const sendMessage = async (content?: string) => {
    const text = (content ?? input).trim();
    if (!text || isLoading) return;
    if (text.length > AI_CHAT_MAX_MESSAGE_CHARS) {
      // Niet versturen en de invoer laten staan, zodat de gebruiker kan inkorten.
      setError(AI_CHAT_TOO_LONG_MESSAGE);
      return;
    }

    const nextMessages: ChatMessage[] = [
      ...messages,
      { id: newId(), role: "user", content: text },
    ];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setError(null);

    const turn = buildAgentTurn(text);

    // Actie-intentie: lokaal afgehandeld met een actiekaart (prototype).
    if (turn.action) {
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "assistant", content: turn.reply, action: turn.action },
      ]);
      setIsLoading(false);
      return;
    }

    try {
      const { data, error: fnError } = await supabase.functions.invoke("ai-chat", {
        body: {
          messages: nextMessages
            .slice(-AI_CHAT_HISTORY_WINDOW)
            .map(({ role, content }) => ({ role, content })),
        },
      });

      if (fnError) throw fnError;
      if (!data || typeof data.text !== "string") {
        throw new Error("Ongeldige reactie van AI");
      }

      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "assistant", content: data.text },
      ]);
    } catch (err) {
      const refused = await refusalMessage(err);
      if (refused) {
        setError(refused);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "assistant", content: turn.reply },
        ]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return {
    messages,
    input,
    setInput,
    isLoading,
    error,
    sendMessage,
    confirmAction,
    cancelAction,
    retryAction,
    dismissAction,
  };
}
