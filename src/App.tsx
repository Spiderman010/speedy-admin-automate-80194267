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
import Vraagposten from "./pages/Vraagposten";
import Leveranciers from "./pages/Leveranciers";
import Instellingen from "./pages/Instellingen";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import OAuthConsent from "./pages/OAuthConsent";

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
              <Route path="/bank" element={<Bank />} />
              <Route path="/verkoop" element={<Verkoop />} />
              <Route path="/boekingen" element={<Boekingen />} />
              <Route path="/overzichten" element={<Overzichten />} />
              <Route path="/grootboek" element={<Grootboek />} />
              <Route path="/vraagposten" element={<Vraagposten />} />
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
