import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

// Typed wrapper for the beta supabase.auth.oauth namespace
type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
  approveAuthorization: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
  denyAuthorization: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
};
function oauthApi(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id") ?? "";
  const [details, setDetails] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) {
        setError("Ontbrekende authorization_id in de URL.");
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const next = window.location.pathname + window.location.search;
        window.location.href = "/auth?next=" + encodeURIComponent(next);
        return;
      }
      try {
        const { data, error } = await oauthApi().getAuthorizationDetails(authorizationId);
        if (!active) return;
        if (error) {
          setError(error.message);
          return;
        }
        const immediate = data?.redirect_url ?? data?.redirect_to;
        if (immediate && !data?.client) {
          window.location.href = immediate;
          return;
        }
        setDetails(data);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Onbekende fout");
      }
    })();
    return () => {
      active = false;
    };
  }, [authorizationId]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const api = oauthApi();
      const { data, error } = approve
        ? await api.approveAuthorization(authorizationId)
        : await api.denyAuthorization(authorizationId);
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      const target = data?.redirect_url ?? data?.redirect_to;
      if (!target) {
        setError("Geen redirect ontvangen van de autorisatieserver.");
        setBusy(false);
        return;
      }
      window.location.href = target;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="font-display">Toegang tot BoekAssist</CardTitle>
          <CardDescription>Bevestig of {details?.client?.name ?? "deze app"} verbinding mag maken met je BoekAssist-account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">Er ging iets mis: {error}</p>}
          {!error && !details && <p className="text-sm text-muted-foreground">Laden…</p>}
          {details && (
            <>
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <div>
                  <span className="text-muted-foreground">Client:</span>{" "}
                  <span className="font-medium">{details.client?.name ?? "Onbekend"}</span>
                </div>
                {details.client?.redirect_uri && (
                  <div className="break-all">
                    <span className="text-muted-foreground">Redirect:</span>{" "}
                    <span className="font-mono text-xs">{details.client.redirect_uri}</span>
                  </div>
                )}
                <p className="text-muted-foreground pt-2">
                  Deze app kan de BoekAssist-tools aanroepen namens jou. RLS en je toegangsrechten blijven onveranderd.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => decide(true)} disabled={busy} className="flex-1">
                  {busy ? "Bezig…" : "Goedkeuren"}
                </Button>
                <Button onClick={() => decide(false)} disabled={busy} variant="outline" className="flex-1">
                  Weigeren
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
