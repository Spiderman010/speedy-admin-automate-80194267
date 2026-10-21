import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";

/**
 * B2-09: de querycache hoort bij één gebruiker.
 *
 * De uitlogknoppen (app-sidebar, Instellingen) legen de cache zelf. Deze grens
 * vangt de andere manieren af waarop de ingelogde gebruiker wegvalt of
 * wisselt: een verlopen sessie (SIGNED_OUT na een mislukte tokenvernieuwing),
 * uitloggen in een ander tabblad, of daar inloggen als iemand anders. Veel
 * querysleutels bevatten geen gebruiker of organisatie (bijv. ["app_settings"]),
 * dus zonder legen ziet de volgende gebruiker eerst de gegevens van de vorige.
 *
 * Zodra de cache van een andere gebruiker is dan de huidige, rendert de grens
 * één keer niets — dan toont geen component nog oude gegevens en houdt geen
 * observer een oude query vast —, leegt de cache en rendert de app opnieuw.
 * Een gewone tokenvernieuwing (zelfde gebruiker) laat de cache staan.
 */
export function UserScopedQueryCache({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const current = user?.id ?? null;
  // De gebruiker van wie de cache gegevens kan bevatten; null = niemand.
  const [owner, setOwner] = useState<string | null>(null);
  const belongsToSomeoneElse = !loading && owner !== null && owner !== current;

  useEffect(() => {
    if (loading || owner === current) return;
    if (owner !== null) queryClient.clear();
    setOwner(current);
  }, [loading, owner, current, queryClient]);

  if (belongsToSomeoneElse) return null;
  return <>{children}</>;
}
