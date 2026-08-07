import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "boekhouder@agio.nl" } }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }] }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/components/OrganizationSelector", () => ({
  OrganizationSelector: () => null,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

import { AppShell } from "@/components/layout/app-shell";
import { NAV_SECTIONS, pageTitleForPath, parentNavItemForPath } from "@/components/layout/nav";

function renderShell(path = "/bank"): void {
  render(
    (
      <MemoryRouter initialEntries={[path]}>
        <AppShell>
          <div>__page-content__</div>
        </AppShell>
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

describe("AppShell", () => {
  it("rendert sidebar-navigatie met alle bestaande routes, gegroepeerd per sectie", () => {
    renderShell();
    // Alle nav-items zijn links naar bestaande routes.
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        const link = screen.getByRole("link", { name: new RegExp(item.title) });
        expect(link).toHaveAttribute("href", item.url);
      }
    }
    // Sectiekoppen aanwezig.
    expect(screen.getByText("Boekhouding")).toBeInTheDocument();
    expect(screen.getByText("Inzicht")).toBeInTheDocument();
    expect(screen.getByText("Beheer")).toBeInTheDocument();
    // Page content rendert binnen de shell.
    expect(screen.getByText("__page-content__")).toBeInTheDocument();
  });

  it("toont de actieve pagina in de header en markeert het actieve nav-item", () => {
    renderShell("/bank");
    expect(screen.getByRole("banner")).toHaveTextContent("Bank");
    const active = screen.getByRole("link", { name: /Bank/ });
    // shadcn SidebarMenuButton zet data-active op het actieve item.
    expect(active).toHaveAttribute("data-active", "true");
    const dashboard = screen.getByRole("link", { name: /Dashboard/ });
    expect(dashboard).toHaveAttribute("data-active", "false");
  });

  it("heeft een toegankelijke sidebar-toggle en gebruikersfooter met uitloggen", () => {
    renderShell();
    expect(
      screen.getByRole("button", { name: "Zijbalk in- of uitklappen" }),
    ).toBeInTheDocument();
    expect(screen.getByText("boekhouder@agio.nl")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Uitloggen/ })).toBeInTheDocument();
  });

  it("titel- en breadcrumbhelpers volgen de routes correct", () => {
    expect(pageTitleForPath("/")).toBe("Dashboard");
    expect(pageTitleForPath("/facturen")).toBe("Inkoop");
    expect(pageTitleForPath("/facturen/inkoop/abc-123")).toBe("Inkoop");
    expect(pageTitleForPath("/overzichten")).toBe("Rapportages");
    // Dashboard is exact: andere paden activeren het niet.
    expect(pageTitleForPath("/bank")).toBe("Bank");
    expect(parentNavItemForPath("/facturen/inkoop/abc-123")?.title).toBe("Inkoop");
    expect(parentNavItemForPath("/bank")).toBeNull();
  });
});
