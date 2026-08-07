import {
  BarChart3,
  BookOpen,
  Building2,
  FileText,
  HelpCircle,
  Landmark,
  LayoutDashboard,
  PenLine,
  Receipt,
  Settings,
  Sparkles,
  Truck,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  /** Exact-match only (used for "/" so Dashboard is not active everywhere). */
  exact?: boolean;
}

export interface NavSection {
  /** Section label; null renders the items without a group heading. */
  label: string | null;
  items: NavItem[];
}

// One source of truth for the sidebar AND the header title. Every url below is
// an EXISTING route from App.tsx — the shell never introduces new routes.
// Existing pages outside the requested core structure (Leveranciers,
// Vraagposten, Snelle invoer, AI-assistent) keep a place in the most fitting
// section so they stay reachable.
export const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [{ title: "Dashboard", url: "/", icon: LayoutDashboard, exact: true }],
  },
  {
    label: "Boekhouding",
    items: [
      { title: "Administraties", url: "/klanten", icon: Building2 },
      { title: "Bank", url: "/bank", icon: Landmark },
      { title: "Inkoop", url: "/facturen", icon: FileText },
      { title: "Verkoop", url: "/verkoop", icon: Receipt },
      { title: "Grootboek", url: "/grootboek", icon: BookOpen },
      { title: "Leveranciers", url: "/leveranciers", icon: Truck },
      { title: "Vraagposten", url: "/vraagposten", icon: HelpCircle },
      { title: "Snelle invoer", url: "/boekingen", icon: PenLine },
    ],
  },
  {
    label: "Inzicht",
    items: [
      { title: "Rapportages", url: "/overzichten", icon: BarChart3 },
      { title: "AI-assistent", url: "/ai-chat", icon: Sparkles },
    ],
  },
  {
    label: "Beheer",
    items: [{ title: "Instellingen", url: "/instellingen", icon: Settings }],
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.url;
  return pathname === item.url || pathname.startsWith(`${item.url}/`);
}

/** Title for the header: the active nav item's label ("BoekAssist" as fallback). */
export function pageTitleForPath(pathname: string): string {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (isNavItemActive(item, pathname)) return item.title;
    }
  }
  return "BoekAssist";
}

/** Parent nav item for nested routes (e.g. /facturen/inkoop/:id → Inkoop). */
export function parentNavItemForPath(pathname: string): NavItem | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (!item.exact && pathname !== item.url && pathname.startsWith(`${item.url}/`)) {
        return item;
      }
    }
  }
  return null;
}
