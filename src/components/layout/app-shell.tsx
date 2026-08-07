import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { AppHeader } from "./app-header";
import { PageContainer } from "./page-container";

/**
 * The single application shell: sidebar (desktop fixed / icon-collapsible,
 * mobile Sheet), compact header with sidebar trigger + page title, and one
 * consistent PageContainer around the routed page content.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="flex-1">
          <PageContainer>{children}</PageContainer>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
