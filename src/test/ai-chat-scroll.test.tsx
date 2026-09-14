import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

import AIChat from "@/pages/AIChat";

// ── Mock state knobs ────────────────────────────────────────────────────────
const state = {
  messages: [] as { id: string; role: "user" | "assistant"; content: string }[],
  isLoading: false,
  error: null as string | null,
};

const mockSendMessage = vi.fn();
const mockConfirmAction = vi.fn();
const mockCancelAction = vi.fn();
const mockRetryAction = vi.fn();
const mockDismissAction = vi.fn();

vi.mock("@/hooks/useAIChat", () => ({
  useAIChat: () => ({
    messages: state.messages,
    input: "",
    setInput: vi.fn(),
    isLoading: state.isLoading,
    error: state.error,
    sendMessage: mockSendMessage,
    confirmAction: mockConfirmAction,
    cancelAction: mockCancelAction,
    retryAction: mockRetryAction,
    dismissAction: mockDismissAction,
  }),
}));

function renderAIChat(): ReturnType<typeof render> {
  return render(<AIChat /> as ReactNode as any);
}

beforeEach(() => {
  state.messages = [];
  state.isLoading = false;
  state.error = null;
  vi.clearAllMocks();
});

describe("AIChat scroll", () => {
  it("renders the conversation in a native scrollable container", () => {
    renderAIChat();
    const container = screen.getByTestId("chat-scroll-container");
    expect(container.tagName).toBe("DIV");
    expect(container.className).toContain("overflow-y-auto");
    expect(container.className).toContain("h-full");
  });

  it("auto-scrolls to the bottom when new messages arrive", async () => {
    const { rerender } = renderAIChat();
    const container = screen.getByTestId("chat-scroll-container");

    // Simulate scrollable content larger than viewport.
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });

    state.messages = [
      { id: "m1", role: "user", content: "Hallo" },
      { id: "m2", role: "assistant", content: "Hoe kan ik helpen?" },
    ];

    rerender(<AIChat /> as ReactNode as any);

    await waitFor(() => {
      expect(container.scrollTop).toBe(container.scrollHeight);
    });
  });

  it("keeps the newest message reachable after several exchanges", async () => {
    const { rerender } = renderAIChat();
    const container = screen.getByTestId("chat-scroll-container");

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });

    state.messages = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Bericht ${i}`,
    })) as { id: string; role: "user" | "assistant"; content: string }[];

    rerender(<AIChat /> as ReactNode as any);

    await waitFor(() => {
      expect(container.scrollTop).toBe(container.scrollHeight);
    });
    expect(screen.getByText("Bericht 9")).toBeVisible();
  });

  it("does not use the non-scrolling ScrollArea Root for the ref target", () => {
    const { container: root } = renderAIChat();
    // The ScrollArea component renders a Radix Root with `data-radix-scroll-area-viewport` absent;
    // our container is a plain div with the test id, not the Radix Root.
    const scrollContainer = screen.getByTestId("chat-scroll-container");
    expect(scrollContainer).not.toHaveAttribute("data-radix-scroll-area-viewport");
    expect(scrollContainer.parentElement).not.toHaveAttribute("data-radix-scroll-area-root");
  });
});
