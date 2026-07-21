import { useRef, useEffect } from "react";
import { useAIChat } from "@/hooks/useAIChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, User } from "lucide-react";

export default function AIChat() {
  const { messages, input, setInput, isLoading, error, sendMessage } = useAIChat();
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
    <div className="container mx-auto max-w-4xl py-8">
      <Card className="h-[calc(100vh-8rem)] flex flex-col">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg font-display">
            <Bot className="h-5 w-5" />
            BoekAssist AI
          </CardTitle>
        </CardHeader>

        <CardContent className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-full" ref={scrollRef}>
            <div className="space-y-4 p-4">
              {messages.length === 0 && (
                <div className="text-center text-muted-foreground py-12">
                  <p className="text-sm">
                    Stel een vraag over boekhouden, BTW, Snelstart of factuurverwerking.
                  </p>
                </div>
              )}

              {messages.map((message, index) => (
                <div
                  key={index}
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
              ))}

              {isLoading && (
                <div className="flex justify-start gap-3">
                  <div className="flex gap-2 rounded-lg bg-muted px-4 py-3 text-sm">
                    <Bot className="h-4 w-4 shrink-0 mt-0.5" />
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
          </ScrollArea>
        </CardContent>

        <div className="border-t p-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Typ je vraag..."
              className="flex-1"
              disabled={isLoading}
            />
            <Button type="submit" disabled={isLoading || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
