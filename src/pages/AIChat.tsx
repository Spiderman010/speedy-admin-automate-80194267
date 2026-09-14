import { useRef, useEffect } from "react";
import { useAIChat } from "@/hooks/useAIChat";
import { AgentActionCard } from "@/components/ai-chat/AgentActionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Bot, Send, User } from "lucide-react";
import { DEMO_INVOICE, STATUS_LABELS, SUGGESTED_PROMPTS } from "@/lib/agent-actions";
import { formatEuro } from "@/lib/format";

export default function AIChat() {
  const {
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
  } = useAIChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="flex h-[calc(100vh-11rem)] flex-col">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b">
          <CardTitle className="flex items-center gap-2 text-lg font-display">
            <Bot className="h-5 w-5" />
            BoekAssist boekingsagent
          </CardTitle>
          <Badge variant="secondary">Prototype</Badge>
        </CardHeader>

        <CardContent className="flex-1 overflow-hidden p-0">
          <div className="h-full overflow-y-auto" ref={scrollRef}>
            <div className="space-y-4 p-4">
              {messages.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <p>
                    Vraag de agent om een boekingsvoorstel of een statuswijziging. Elke
                    muterende actie vraagt eerst om je bevestiging.
                  </p>
                </div>
              )}

              {messages.map((message) => (
                <div key={message.id} className="space-y-2">
                  <div
                    className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`flex max-w-[80%] gap-2 rounded-lg px-4 py-3 text-sm ${
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        {message.role === "user" ? (
                          <User className="h-4 w-4" />
                        ) : (
                          <Bot className="h-4 w-4" />
                        )}
                      </div>
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    </div>
                  </div>

                  {message.action && (
                    <div className="max-w-[80%]">
                      <AgentActionCard
                        action={message.action}
                        onConfirm={confirmAction}
                        onCancel={cancelAction}
                        onRetry={retryAction}
                        onClose={dismissAction}
                      />
                    </div>
                  )}
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start gap-3">
                  <div className="flex gap-2 rounded-lg bg-muted px-4 py-3 text-sm">
                    <Bot className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-muted-foreground">Bezig met schrijven...</span>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>
        </CardContent>

        <div className="space-y-3 border-t p-4">
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoading}
                onClick={() => sendMessage(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Typ je opdracht..."
              className="flex-1"
              disabled={isLoading}
            />
            <Button type="submit" disabled={isLoading || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>

      <Card className="h-fit">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-sm font-semibold">Context</CardTitle>
          <Badge variant="secondary">Demo</Badge>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Administratie</span>
            <span className="text-right font-medium">{DEMO_INVOICE.administratie}</span>
          </div>
          <Separator />
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Leverancier</span>
            <span className="text-right font-medium">{DEMO_INVOICE.leverancier}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Factuurnummer</span>
            <span className="text-right">{DEMO_INVOICE.invoice_number}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Bedrag incl.</span>
            <span className="text-right tabular-nums">{formatEuro(DEMO_INVOICE.amount_incl)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Status</span>
            <span className="text-right">{STATUS_LABELS[DEMO_INVOICE.status]}</span>
          </div>
          <p className="pt-2 text-xs text-muted-foreground">
            Voorbeeldcontext. Er wordt geen productiedata getoond of gewijzigd.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
