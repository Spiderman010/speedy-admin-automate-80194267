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
import Bank from "./pages/Bank";
import Verkoop from "./pages/Verkoop";
import Boekingen from "./pages/Boekingen";
import Overzichten from "./pages/Overzichten";
import Grootboek from "./pages/Grootboek";
import Vraagposten from "./pages/Vraagposten";
import Instellingen from "./pages/Instellingen";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";

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
  if (user) return <Navigate to="/" replace />;
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
            <Route path="/auth" element={<AuthRoute />} />
            <Route element={<ProtectedRoutes />}>
              <Route path="/" element={<Index />} />
              <Route path="/klanten" element={<Klanten />} />
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
