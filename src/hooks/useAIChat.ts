import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type ChatMessage = { role: "user" | "assistant"; content: string };

export function useAIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = async (content?: string) => {
    const text = (content ?? input).trim();
    if (!text || isLoading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke("ai-chat", {
        body: { messages: nextMessages },
      });

      if (fnError) throw fnError;
      if (!data || typeof data.text !== "string") {
        throw new Error("Ongeldige reactie van AI");
      }

      setMessages((prev) => [...prev, { role: "assistant", content: data.text }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Er is iets misgegaan";
      setError(msg);
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
  };
}
