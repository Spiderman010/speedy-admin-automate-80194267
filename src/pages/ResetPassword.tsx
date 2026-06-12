import { useEffect, useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Capture PASSWORD_RECOVERY event that fires when arriving via recovery link
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) {
        setHasSession(true);
        setChecking(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(!!session);
      setChecking(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleReset = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;

    if (password.length < 6) {
      toast({
        title: "Wachtwoord te kort",
        description: "Wachtwoord moet minimaal 6 tekens bevatten.",
        variant: "destructive",
      });
      return;
    }
    if (password !== confirm) {
      toast({
        title: "Wachtwoorden komen niet overeen",
        description: "Beide wachtwoorden moeten gelijk zijn.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const sessionIssue = /session|auth|jwt|token/i.test(error.message);
      toast({
        title: "Fout",
        description: sessionIssue
          ? "Geen geldige herstel-sessie. Vraag een nieuwe resetlink aan."
          : error.message,
        variant: "destructive",
      });
      setLoading(false);
      return;
    }
    await supabase.auth.signOut();
    toast({
      title: "Wachtwoord bijgewerkt",
      description: "Wachtwoord bijgewerkt. Log opnieuw in.",
    });
    navigate("/auth");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground font-display font-bold text-lg">
            BA
          </div>
          <CardTitle className="font-display text-2xl">Nieuw wachtwoord</CardTitle>
          <CardDescription>Stel een nieuw wachtwoord in voor je account.</CardDescription>
        </CardHeader>
        <CardContent>
          {checking ? (
            <p className="text-center text-sm text-muted-foreground">Laden...</p>
          ) : !hasSession ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Geen geldige herstel-sessie gevonden. Open deze pagina via de resetlink in je e-mail,
                of vraag een nieuwe link aan.
              </p>
              <Button className="w-full" onClick={() => navigate("/auth")}>
                Terug naar inloggen
              </Button>
            </div>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="new-password">Nieuw wachtwoord</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimaal 6 tekens"
                  minLength={6}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Bevestig wachtwoord</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Bezig..." : "Wachtwoord opslaan"}
              </Button>
              <Button
                type="button"
                variant="link"
                className="w-full"
                onClick={() => navigate("/auth")}
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
