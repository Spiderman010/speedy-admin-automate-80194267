import { Outlet } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { ClientProvider } from "@/hooks/useClientContext";
import { OrganizationProvider } from "@/hooks/useActiveOrganization";

export function AppLayout() {
  return (
    <OrganizationProvider>
      <ClientProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </ClientProvider>
    </OrganizationProvider>
  );
}
