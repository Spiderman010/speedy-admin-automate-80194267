import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export function useAppSettings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["app_settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("*");
      if (error) throw error;
      const map: Record<string, any> = {};
      for (const row of data) {
        map[row.key] = row.value;
      }
      return map;
    },
    enabled: !!user,
  });
}

export function useSaveAppSetting() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: Record<string, any>) => {
      if (!user) throw new Error("Niet ingelogd");
      for (const [key, value] of Object.entries(settings)) {
        const { error } = await supabase
          .from("app_settings")
          .upsert(
            { user_id: user.id, key, value, updated_at: new Date().toISOString() },
            { onConflict: "user_id,key" }
          );
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings"] }),
  });
}
