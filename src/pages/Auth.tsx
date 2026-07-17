import { useState, FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

const DUPLICATE_MSG = "Dit e-mailadres bestaat al. Log in of gebruik 'Wachtwoord vergeten'.";

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"auth" | "forgot">("auth");
  const { toast } = useToast();

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) toast({ title: "Fout", description: error.message, variant: "destructive" });
    setLoading(false);
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    const next = new URLSearchParams(window.location.search).get("next");
    const emailRedirectTo =
      next && next.startsWith("/") && !next.startsWith("//")
        ? `${window.location.origin}/auth?next=${encodeURIComponent(next)}`
        : window.location.origin;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });

    const isDuplicate =
      (error && /already (registered|exists)|User already registered/i.test(error.message)) ||
      (!error && data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);

    if (isDuplicate) {
      toast({ title: "Account bestaat al", description: DUPLICATE_MSG, variant: "destructive" });
    } else if (error) {
      toast({ title: "Fout", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Account aangemaakt", description: "Controleer je e-mail om je account te bevestigen." });
    }
    setLoading(false);
  };

  const handleForgot = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) {
      toast({ title: "Fout", description: error.message, variant: "destructive" });
    } else {
      toast({
        title: "Resetlink verstuurd",
        description: "Als dit e-mailadres bekend is, ontvang je een resetlink.",
      });
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground font-display font-bold text-lg">
            BA
          </div>
          <CardTitle className="font-display text-2xl">BoekAssist</CardTitle>
          <CardDescription>Boekhoud automatiseringstool</CardDescription>
        </CardHeader>
        <CardContent>
          {view === "auth" ? (
            <Tabs defaultValue="login">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Inloggen</TabsTrigger>
                <TabsTrigger value="register">Registreren</TabsTrigger>
              </TabsList>
              <TabsContent value="login" className="pt-4">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="login-email">E-mailadres</Label>
                    <Input
                      id="login-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="jan@kantoor.nl"
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="login-password">Wachtwoord</Label>
                    <Input
                      id="login-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Bezig..." : "Inloggen"}
                  </Button>
                  <div className="text-center">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-sm"
                      onClick={() => {
                        setResetEmail(email);
                        setView("forgot");
                      }}
                    >
                      Wachtwoord vergeten?
                    </Button>
                  </div>
                </form>
              </TabsContent>
              <TabsContent value="register" className="pt-4">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="reg-email">E-mailadres</Label>
                    <Input
                      id="reg-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="jan@kantoor.nl"
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="reg-password">Wachtwoord</Label>
                    <Input
                      id="reg-password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimaal 6 tekens"
                      minLength={6}
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Bezig..." : "Account aanmaken"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4 pt-2">
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold">Wachtwoord vergeten</h2>
                <p className="text-sm text-muted-foreground">
                  Vul je e-mailadres in. We sturen je een link om je wachtwoord opnieuw in te stellen.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="forgot-email">E-mailadres</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="jan@kantoor.nl"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Bezig..." : "Resetlink versturen"}
              </Button>
              <Button
                type="button"
                variant="link"
                className="w-full"
                onClick={() => setView("auth")}
              >
                Terug naar inloggen
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
