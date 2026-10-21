// Review H-01: useAIChat stuurt niet de hele historie naar ai-chat, maar alleen
// de laatste berichten. Zo blijft ook een lang gesprek onder de body- en
// berichtlimiet van de functie (supabase/functions/ai-chat/chat-guards.ts).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

import { useAIChat } from "@/hooks/useAIChat";
import { CHAT_HISTORY_WINDOW } from "../../supabase/functions/ai-chat/chat-guards";

describe("useAIChat: historie naar ai-chat (H-01)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async () => ({ data: { text: "a".repeat(4_000) }, error: null }));
  });

  it("na 15 beurten gaan alleen de laatste berichten mee, met de nieuwe vraag als laatste", async () => {
    const { result } = renderHook(() => useAIChat());
    for (let i = 0; i < 15; i++) {
      await act(async () => {
        await result.current.sendMessage(`Wat is de btw op factuur ${i}?`);
      });
    }
    expect(invoke).toHaveBeenCalledTimes(15);
    expect(result.current.messages).toHaveLength(30);
    const last = invoke.mock.calls[14];
    expect(last[0]).toBe("ai-chat");
    const sent = last[1].body.messages as { role: string; content: string }[];
    expect(sent).toHaveLength(CHAT_HISTORY_WINDOW);
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "Wat is de btw op factuur 14?" });
    expect(Object.keys(sent[0]).sort()).toEqual(["content", "role"]);
    // het echte AI-antwoord is getoond, niet het lokale prototype-antwoord
    expect(result.current.messages[29]).toMatchObject({ role: "assistant", content: "a".repeat(4_000) });
  });
});
