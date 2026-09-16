import { NavLink, useNavigate } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { LogOut, UserRound } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { OrganizationSelector } from "@/components/OrganizationSelector";
import { NAV_SECTIONS, isNavItemActive } from "./nav";

/**
 * Application sidebar built on the shadcn Sidebar primitive:
 * fixed on desktop, icon-collapsible (Cmd/Ctrl+B or the header trigger),
 * Sheet-based drawer on mobile. All navigation targets are existing routes
 * (see ./nav.ts). Auth data and sign-out reuse the existing useAuth/supabase
 * logic unchanged.
 */
export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  // Only fetch clients once the org context has resolved and we have a specific org.
  // This prevents a brief window where an unfiltered query would return all
  // RLS-accessible clients.
  const { data: clients } = useClients(
    activeOrganizationId ?? undefined,
    isReady && activeOrganizationId !== null,
  );
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const selectedClient = clients?.find(c => c.id === selectedClientId);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-0 border-b border-sidebar-border p-0">
        <div className="flex h-14 items-center gap-2 px-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-display text-sm font-bold text-sidebar-primary-foreground shadow-sm">
            BA
          </div>
          <span className="truncate font-display text-lg font-semibold group-data-[collapsible=icon]:hidden">
            BoekAssist
          </span>
        </div>

        {/* Contextkiezers verdwijnen in de icoon-modus; ze blijven bereikbaar
            door de sidebar uit te klappen. */}
        <div className="group-data-[collapsible=icon]:hidden">
          {/* Organisatiekiezer — alleen zichtbaar als user lid is van > 1 organisatie */}
          <OrganizationSelector />
          <div className="border-b border-sidebar-border px-3 py-3">
            <p className="mb-1.5 px-1 text-xs font-medium text-sidebar-foreground/60">Actieve klant</p>
            <Select value={selectedClientId} onValueChange={setSelectedClientId}>
              <SelectTrigger
                aria-label="Actieve klant"
                className="h-9 w-full border-sidebar-border bg-sidebar-accent text-sm text-sidebar-foreground"
              >
                <SelectValue placeholder="Kies een klant">
                  {selectedClientId === "all"
                    ? "Alle klanten"
                    : selectedClient?.name ?? "Kies een klant"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle klanten</SelectItem>
                {clients?.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="py-2">
        {NAV_SECTIONS.map((section, i) => (
          <SidebarGroup key={section.label ?? `top-${i}`}>
            {section.label && (
              <SidebarGroupLabel className="text-[11px] font-semibold uppercase text-sidebar-foreground/50">
                {section.label}
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map(item => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton
                      asChild
                      isActive={isNavItemActive(item, location.pathname)}
                      tooltip={item.title}
                    >
                      <NavLink to={item.url} end={item.exact}>
                        <item.icon className="shrink-0" />
                        <span>{item.title}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-sm group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <UserRound className="h-4 w-4 shrink-0 text-sidebar-foreground/70" />
              <span
                className="truncate text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden"
                title={user?.email ?? undefined}
              >
                {user?.email ?? "Ingelogd"}
              </span>
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleLogout} tooltip="Uitloggen">
              <LogOut className="shrink-0" />
              <span>Uitloggen</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
