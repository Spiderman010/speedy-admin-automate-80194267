import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { AppLayout } from "@/components/AppLayout";
import Index from "./pages/Index";
import Klanten from "./pages/Klanten";
import Facturen from "./pages/Facturen";
import PurchaseInvoiceWorkspace from "./pages/PurchaseInvoiceWorkspace";
import Bank from "./pages/Bank";
import Verkoop from "./pages/Verkoop";
import Boekingen from "./pages/Boekingen";
import Overzichten from "./pages/Overzichten";
import Grootboek from "./pages/Grootboek";
import GrootboekMutaties from "./pages/GrootboekMutaties";
import Memoriaal from "./pages/Memoriaal";
import Beginbalans from "./pages/Beginbalans";
import GrootboekSaldi from "./pages/GrootboekSaldi";
import GrootboekHistorisch from "./pages/GrootboekHistorisch";
import GrootboekIntegriteit from "./pages/GrootboekIntegriteit";
import DiagnosticsAccounting from "./pages/DiagnosticsAccounting";
import Balans from "./pages/Balans";
import WinstVerlies from "./pages/WinstVerlies";
import ProefSaldibalans from "./pages/ProefSaldibalans";
import Vraagposten from "./pages/Vraagposten";
import Leveranciers from "./pages/Leveranciers";
import Instellingen from "./pages/Instellingen";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import OAuthConsent from "./pages/OAuthConsent";
import AIChat from "./pages/AIChat";

function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
    return decoded;
  } catch {
    return "/";
  }
}

const queryClient = new QueryClient();

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-muted-foreground">Laden...</p></div>;
  if (!user) return <Navigate to="/auth" replace />;
  return <AppLayout />;
}

function AuthRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) {
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    return <Navigate to={next} replace />;
  }
  return <Auth />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/auth" element={<AuthRoute />} />
            <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
            <Route element={<ProtectedRoutes />}>
              <Route path="/" element={<Index />} />
              <Route path="/klanten" element={<Klanten />} />
              <Route path="/leveranciers" element={<Leveranciers />} />
              <Route path="/facturen" element={<Facturen />} />
              <Route path="/facturen/inkoop/:invoiceId" element={<PurchaseInvoiceWorkspace />} />
              <Route path="/bank" element={<Bank />} />
              <Route path="/verkoop" element={<Verkoop />} />
              <Route path="/boekingen" element={<Boekingen />} />
              <Route path="/overzichten" element={<Overzichten />} />
              <Route path="/overzichten/proef-saldibalans" element={<ProefSaldibalans />} />
              <Route path="/grootboek" element={<Grootboek />} />
              <Route path="/grootboek/mutaties" element={<GrootboekMutaties />} />
              <Route path="/grootboek/memoriaal" element={<Memoriaal />} />
              <Route path="/grootboek/beginbalans" element={<Beginbalans />} />
              <Route path="/grootboek/historisch" element={<GrootboekHistorisch />} />
              <Route path="/grootboek/integriteit" element={<GrootboekIntegriteit />} />
              <Route path="/grootboek/saldi" element={<GrootboekSaldi />} />
              <Route path="/grootboek/saldi/:accountId" element={<GrootboekSaldi />} />
              {/* Balans/W&V PR 4: de jaarrekeningrapporten hangen onder
                  Grootboek, zonder eigen nav-item (prefix-matching houdt
                  "Grootboek" actief). */}
              <Route path="/grootboek/balans" element={<Balans />} />
              <Route path="/grootboek/winst-verlies" element={<WinstVerlies />} />
              {/* Interne diagnostiekconsole; geen klantfunctie, geen nav-item. */}
              <Route path="/diagnostics/accounting" element={<DiagnosticsAccounting />} />
              <Route path="/vraagposten" element={<Vraagposten />} />
              <Route path="/ai-chat" element={<AIChat />} />
              <Route path="/instellingen" element={<Instellingen />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
