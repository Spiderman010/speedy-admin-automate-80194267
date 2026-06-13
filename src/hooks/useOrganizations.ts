import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface Organization {
  id: string;
  name: string;
}

export function useOrganizations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["organizations", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organization_members")
        .select("organization_id, organizations(id, name)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? [])
        .map((row) => row.organizations as Organization | null)
        .filter((org): org is Organization => org !== null);
    },
    enabled: !!user,
  });
}
