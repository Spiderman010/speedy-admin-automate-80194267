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
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
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
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "assistant", content: turn.reply },
      ]);
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
