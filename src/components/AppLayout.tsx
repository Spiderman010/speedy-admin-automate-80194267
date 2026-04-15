import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { ClientProvider } from "@/hooks/useClientContext";

export function AppLayout() {
  return (
    <ClientProvider>
      <div className="min-h-screen">
        <AppSidebar />
        <main className="pl-64">
          <div className="p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
    </ClientProvider>
  );
}
