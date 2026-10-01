import { Link, useLocation } from "react-router-dom";
import { Building2 } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { pageTitleForPath, parentNavItemForPath } from "./nav";

/**
 * Compact shell header: sidebar toggle + current page title. Nested routes
 * (e.g. /facturen/inkoop/:id) get a small breadcrumb back to their parent.
 * Page-specific titles/actions stay in the pages' own PageHeader.
 *
 * Rechts staat de actieve administratie als context. Alleen weergave: de
 * keuze blijft in de zijbalk, en de lijst komt uit dezelfde `useClients`-
 * aanroep (zelfde query-key) die de zijbalk al doet — geen extra query.
 */
export function AppHeader() {
  const location = useLocation();
  const title = pageTitleForPath(location.pathname);
  const parent = parentNavItemForPath(location.pathname);
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const { data: clients } = useClients(
    activeOrganizationId ?? undefined,
    isReady && activeOrganizationId !== null,
  );
  const { selectedClientId } = useClientContext();
  const clientLabel =
    selectedClientId === "all"
      ? "Alle klanten"
      : clients?.find((c) => c.id === selectedClientId)?.name ?? null;

  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b bg-card/95 px-3 shadow-[0_1px_0_0_hsl(var(--border))] backdrop-blur supports-[backdrop-filter]:bg-card/90 sm:px-4">
      <SidebarTrigger className="-ml-1 h-8 w-8" aria-label="Zijbalk in- of uitklappen" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      {parent ? (
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap text-[13px]">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={parent.url}>{parent.title}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Details</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      ) : (
        <span className="truncate text-[13px] font-semibold text-foreground">{title}</span>
      )}
      {clientLabel && (
        <div
          className="ml-auto hidden min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs sm:flex"
        >
          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">Administratie</span>
          <span className="max-w-[16rem] truncate font-medium text-foreground" title={clientLabel}>
            {clientLabel}
          </span>
        </div>
      )}
    </header>
  );
}
