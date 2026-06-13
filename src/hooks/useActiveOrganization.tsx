import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useOrganizations } from "./useOrganizations";

const LS_KEY = "ba_active_org";

interface ActiveOrganizationContextType {
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string) => void;
  /** true once the active org has been resolved (localStorage / profile / first org) */
  isReady: boolean;
  /** true while memberships or profile are still loading */
  isLoading: boolean;
  /** false if the user has no org memberships at all */
  hasOrganizations: boolean;
}

const ActiveOrganizationContext = createContext<ActiveOrganizationContextType>({
  activeOrganizationId: null,
  setActiveOrganizationId: () => {},
  isReady: false,
  isLoading: true,
  hasOrganizations: false,
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
  const { data: organizations, isLoading: orgsLoading } = useOrganizations();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    if (!organizations || organizations.length === 0) {
      // Orgs loaded but empty — nothing to pick; mark ready so callers don't wait forever.
      if (!orgsLoading) {
        initializedRef.current = true;
        setIsReady(true);
      }
      return;
    }

    const orgIds = organizations.map((o) => o.id);

    // Priority 1: valid localStorage value still present in memberships
    const stored = localStorage.getItem(LS_KEY);
    if (stored && orgIds.includes(stored)) {
      setActiveOrganizationIdState(stored);
      initializedRef.current = true;
      setIsReady(true);
      return;
    }

    // Priority 2: profile default_organization_id (wait until profile query settles)
    if (profileLoading) return;

    const defaultId = profile?.default_organization_id;
    if (defaultId && orgIds.includes(defaultId)) {
      setActiveOrganizationIdState(defaultId);
      localStorage.setItem(LS_KEY, defaultId);
      initializedRef.current = true;
      setIsReady(true);
      return;
    }

    // Priority 3: first org in memberships
    setActiveOrganizationIdState(organizations[0].id);
    localStorage.setItem(LS_KEY, organizations[0].id);
    initializedRef.current = true;
    setIsReady(true);
  }, [organizations, orgsLoading, profile, profileLoading]);

  const setActiveOrganizationId = (id: string) => {
    setActiveOrganizationIdState(id);
    localStorage.setItem(LS_KEY, id);
  };

  const value: ActiveOrganizationContextType = {
    activeOrganizationId,
    setActiveOrganizationId,
    isReady,
    isLoading: orgsLoading || profileLoading,
    hasOrganizations: (organizations?.length ?? 0) > 0,
  };

  return (
    <ActiveOrganizationContext.Provider value={value}>
      {children}
    </ActiveOrganizationContext.Provider>
  );
}

export function useActiveOrganization() {
  return useContext(ActiveOrganizationContext);
}
