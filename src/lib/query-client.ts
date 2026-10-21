import { QueryClient } from "@tanstack/react-query";

/**
 * De ene QueryClient van de app (voorheen een constante in App.tsx).
 *
 * Een eigen module, zodat de uitlogknoppen in app-sidebar en Instellingen de
 * cache kunnen legen zonder App.tsx te importeren (dat zou een importcirkel
 * geven) en zonder een QueryClientProvider te eisen van elke test die die
 * componenten rendert. B2-09: na uitloggen mag niets van de vorige gebruiker in
 * het geheugen blijven, dus elk uitlogpad roept `queryClient.clear()` aan.
 */
export const queryClient = new QueryClient();
