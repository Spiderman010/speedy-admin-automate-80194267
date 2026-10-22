// Review H-01: useAIChat stuurt niet de hele historie naar ai-chat, maar alleen
// de laatste berichten. Zo blijft ook een lang gesprek onder de body- en
// berichtlimiet van de functie (supabase/functions/ai-chat/chat-guards.ts).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

import { AI_CHAT_TOO_LONG_MESSAGE, useAIChat } from "@/hooks/useAIChat";
import { CHAT_HISTORY_WINDOW, CHAT_MAX_MESSAGE_CHARS } from "../../supabase/functions/ai-chat/chat-guards";

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

describe("useAIChat: te lange berichten en weigeringen (Codex-3)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("een bericht boven de limiet wordt niet verstuurd: duidelijke melding, geen nep-antwoord, invoer blijft staan", async () => {
    const { result } = renderHook(() => useAIChat());
    const long = "x".repeat(CHAT_MAX_MESSAGE_CHARS + 1);
    act(() => result.current.setInput(long));
    await act(async () => {
      await result.current.sendMessage();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.error).toBe(AI_CHAT_TOO_LONG_MESSAGE);
    expect(result.current.messages).toEqual([]);
    expect(result.current.input).toBe(long);
  });

  it("precies op de limiet wordt wel verstuurd", async () => {
    invoke.mockResolvedValue({ data: { text: "ok" }, error: null });
    const { result } = renderHook(() => useAIChat());
    await act(async () => {
      await result.current.sendMessage("y".repeat(CHAT_MAX_MESSAGE_CHARS));
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("een 400 van ai-chat zet error met de servermelding, zonder prototype-antwoord", async () => {
    const context = new Response(JSON.stringify({ error: "Systeemberichten van de client worden niet geaccepteerd." }), { status: 400 });
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context }) });
    const { result } = renderHook(() => useAIChat());
    await act(async () => {
      await result.current.sendMessage("Wat is een creditnota?");
    });
    expect(result.current.error).toBe("Systeemberichten van de client worden niet geaccepteerd.");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ role: "user" });
  });

  it("een netwerk- of serverfout (geen weigering) houdt het bestaande prototype-gedrag", async () => {
    const context = new Response("{}", { status: 500 });
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error("x"), { context }) });
    const { result } = renderHook(() => useAIChat());
    await act(async () => {
      await result.current.sendMessage("Wat is een creditnota?");
    });
    expect(result.current.error).toBeNull();
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({ role: "assistant" });
  });
});
