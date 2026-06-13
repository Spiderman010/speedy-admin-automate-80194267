import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useOrganizations } from "./useOrganizations";

const LS_KEY = "ba_active_org";

interface ActiveOrganizationContextType {
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string) => void;
}

const ActiveOrganizationContext = createContext<ActiveOrganizationContextType>({
  activeOrganizationId: null,
  setActiveOrganizationId: () => {},
});

function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("default_organization_id")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { data: organizations } = useOrganizations();
  const { data: profile } = useProfile();
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    if (!organizations || organizations.length === 0) return;

    const orgIds = organizations.map((o) => o.id);

    // Priority 1: valid localStorage value still present in memberships
    const stored = localStorage.getItem(LS_KEY);
    if (stored && orgIds.includes(stored)) {
      setActiveOrganizationIdState(stored);
      initializedRef.current = true;
      return;
    }

    // Priority 2: profile default_organization_id (wait until profile query settles)
    if (profile === undefined) return;

    const defaultId = profile?.default_organization_id;
    if (defaultId && orgIds.includes(defaultId)) {
      setActiveOrganizationIdState(defaultId);
      localStorage.setItem(LS_KEY, defaultId);
      initializedRef.current = true;
      return;
    }

    // Priority 3: first org in memberships
    setActiveOrganizationIdState(organizations[0].id);
    localStorage.setItem(LS_KEY, organizations[0].id);
    initializedRef.current = true;
  }, [organizations, profile]);

  const setActiveOrganizationId = (id: string) => {
    setActiveOrganizationIdState(id);
    localStorage.setItem(LS_KEY, id);
  };

  return (
    <ActiveOrganizationContext.Provider value={{ activeOrganizationId, setActiveOrganizationId }}>
      {children}
    </ActiveOrganizationContext.Provider>
  );
}

export function useActiveOrganization() {
  return useContext(ActiveOrganizationContext);
}
