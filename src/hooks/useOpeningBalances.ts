import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Json, TablesInsert } from "@/integrations/supabase/types";
import {
  buildHeaderInsertPayload,
  buildHeaderUpdatePayload,
  safeErrorMetadata,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLinePayload,
  type OpeningBalanceLineRecord,
  type OpeningBalanceMarker,
  type OpeningBalanceRow,
} from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — concept-kant van de beginbalans.
 *
 * De kop is een gewone enkele PostgREST-rij (insert/update/delete) onder RLS;
 * de drie nihil-kolommen gaan nooit mee (geen kolomrecht, alleen de RPC
 * schrijft ze). De REGELS gaan uitsluitend via public.save_opening_balance_lines():
 * die vervangt de hele set in één transactie achter dezelfde kopgrendel als de
 * boeker. Er is hier geen "DELETE regels → INSERT regels"-pad en dat komt er
 * ook niet.
 *
 * organization_id gaat nooit mee vanuit de client: public.set_organization_id()
 * leidt hem af uit client_id.
 */

export const OPENING_BALANCES_KEY = "opening-balances" as const;
export const OPENING_BALANCE_KEY = "opening-balance" as const;
export const OPENING_BALANCE_LINES_KEY = "opening-balance-lines" as const;
export const OPENING_BALANCE_POSTING_KEY = "opening-balance-posting" as const;

/**
 * Alles van één administratie in één keer ongeldig maken (na elke mutatie).
 * Geeft de refetch-belofte terug: een mutation-callback die hem teruggeeft
 * laat `mutateAsync` pas oplossen wanneer de cache weer vers is, zodat de
 * pagina daarna nooit op een tussentijdse, verouderde rij synchroniseert.
 */
export function invalidateOpeningBalanceQueries(
  qc: QueryClient,
  openingBalanceId?: string | null,
): Promise<void> {
  const tasks = [qc.invalidateQueries({ queryKey: [OPENING_BALANCES_KEY] })];
  if (openingBalanceId) {
    tasks.push(
      qc.invalidateQueries({ queryKey: [OPENING_BALANCE_KEY, openingBalanceId] }),
      qc.invalidateQueries({ queryKey: [OPENING_BALANCE_LINES_KEY, openingBalanceId] }),
      qc.invalidateQueries({ queryKey: [OPENING_BALANCE_POSTING_KEY, openingBalanceId] }),
    );
  }
  return Promise.all(tasks).then(() => undefined);
}

/** Is de cache van kop en regels na een refetch zonder fout gevuld? */
function refreshedCleanly(qc: QueryClient, openingBalanceId: string): boolean {
  return (
    !qc.getQueryState([OPENING_BALANCE_KEY, openingBalanceId])?.error &&
    !qc.getQueryState([OPENING_BALANCE_LINES_KEY, openingBalanceId])?.error
  );
}

export interface OpeningBalanceOverview {
  /** Alle koppen van de administratie (concepten, geboekt en nihil), oudste eerst. */
  headers: OpeningBalanceRow[];
  /** De claim van de administratie; hoogstens één (unieke index op client_id). */
  marker: OpeningBalanceMarker | null;
}

/**
 * De koppen én de claim van één administratie. De claimtabel is de enige bron
 * voor "geboekt"; de kop is de enige bron voor "nihil". Zonder administratie
 * draait de query niet.
 */
export function useOpeningBalanceOverview(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [OPENING_BALANCES_KEY, clientId ?? ""],
    enabled: !!user && !!clientId,
    queryFn: async (): Promise<OpeningBalanceOverview> => {
      const [headersResult, markerResult] = await Promise.all([
        supabase
          .from("opening_balances")
          .select("*")
          .eq("client_id", clientId!)
          .order("boekjaar", { ascending: true })
          .order("created_at", { ascending: true }),
        supabase
          .from("opening_balance_postings")
          .select("*")
          .eq("client_id", clientId!)
          .maybeSingle(),
      ]);
      if (headersResult.error) throw headersResult.error;
      if (markerResult.error) throw markerResult.error;
      return { headers: headersResult.data ?? [], marker: markerResult.data ?? null };
    },
  });
}

/** Eén kop, opnieuw uit de database — nooit uit de overzichtscache afgeleid. */
export function useOpeningBalance(openingBalanceId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [OPENING_BALANCE_KEY, openingBalanceId ?? ""],
    enabled: !!user && !!openingBalanceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("opening_balances")
        .select("*")
        .eq("id", openingBalanceId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useOpeningBalanceLines(openingBalanceId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [OPENING_BALANCE_LINES_KEY, openingBalanceId ?? ""],
    enabled: !!user && !!openingBalanceId,
    queryFn: async (): Promise<OpeningBalanceLineRecord[]> => {
      const { data, error } = await supabase
        .from("opening_balance_lines")
        .select("*")
        .eq("opening_balance_id", openingBalanceId!)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function logMutationError(action: string, error: unknown) {
  // Alleen veilige metadata: geen melding, geen rij-inhoud, geen bedragen.
  console.warn(`[beginbalans] ${action} mislukt`, safeErrorMetadata(error));
}

export function useCreateOpeningBalance() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ form, clientId }: { form: OpeningBalanceHeaderForm; clientId: string }) => {
      if (!user) throw new Error("Niet ingelogd");
      const { data, error } = await supabase
        .from("opening_balances")
        // organization_id staat in de gegenereerde types als verplicht, maar
        // wordt server-side door public.set_organization_id() afgeleid uit
        // client_id; de client hoort hem niet mee te sturen. user_id wél: het
        // INSERT-beleid eist user_id = auth.uid().
        .insert({ ...buildHeaderInsertPayload(form, clientId), user_id: user.id } as TablesInsert<"opening_balances">)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onError: (error) => logMutationError("kop aanmaken", error),
    onSuccess: (data) => invalidateOpeningBalanceQueries(qc, data.id),
  });
}

export function useUpdateOpeningBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, form }: { id: string; form: OpeningBalanceHeaderForm }) => {
      const { data, error } = await supabase
        .from("opening_balances")
        .update(buildHeaderUpdatePayload(form))
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) throw error;
      // Onder RLS wordt een rij die je niet mag wijzigen stil overgeslagen;
      // nul rijen terug is dan géén succes.
      if (!data) {
        throw Object.assign(new Error("De beginbalans is niet bijgewerkt: geen rechten of hij bestaat niet meer."), {
          code: "42501",
        });
      }
      return data;
    },
    onError: (error) => logMutationError("kop bijwerken", error),
    onSettled: (_data, _error, variables) => invalidateOpeningBalanceQueries(qc, variables.id),
  });
}

export interface SaveOpeningBalanceLinesResult {
  openingBalanceId: string;
  /**
   * Kop en regels zijn na de opslag opnieuw en zonder fout uit de database
   * gelezen. Zo niet, dan staat er mogelijk nog een oude rij in de cache en
   * mag de pagina daar niet op synchroniseren.
   */
  refreshed: boolean;
}

/**
 * De enige schrijfweg voor regels. Precies één RPC-aanroep; de database doet
 * DELETE + INSERT atomair achter de kopgrendel. Bedragen gaan onafgerond mee.
 * De belofte lost pas op nadat de cache opnieuw is opgehaald.
 */
export function useSaveOpeningBalanceLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      openingBalanceId,
      lines,
    }: {
      openingBalanceId: string;
      lines: OpeningBalanceLinePayload[];
    }): Promise<SaveOpeningBalanceLinesResult> => {
      // null/NaN zou server-side stilletjes 0 worden: dat is geen opslag maar
      // een fout, en die hoort hier al te stoppen.
      if (lines.some((l) => !Number.isFinite(l.debit_amount) || !Number.isFinite(l.credit_amount))) {
        throw Object.assign(new Error("Een regel bevat een onleesbaar bedrag; opslaan is niet mogelijk."), {
          code: "22023",
        });
      }
      const { error } = await supabase.rpc("save_opening_balance_lines", {
        _opening_balance_id: openingBalanceId,
        _lines: lines as unknown as Json,
      });
      if (error) throw error;
      // Pas ná de RPC opnieuw ophalen (invalidateQueries annuleert een nog
      // lopende, oudere refetch), en wachten tot dat klaar is.
      await invalidateOpeningBalanceQueries(qc, openingBalanceId);
      return { openingBalanceId, refreshed: refreshedCleanly(qc, openingBalanceId) };
    },
    onError: (error, variables) => {
      logMutationError("regels opslaan", error);
      return invalidateOpeningBalanceQueries(qc, variables.openingBalanceId);
    },
  });
}

export function useDeleteOpeningBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (openingBalanceId: string) => {
      const { data, error } = await supabase
        .from("opening_balances")
        .delete()
        .eq("id", openingBalanceId)
        .select("id");
      if (error) throw error;
      // RLS filtert stil: nul verwijderde rijen is geen succes.
      if (!data || data.length === 0) {
        throw Object.assign(
          new Error("Het concept is niet verwijderd: alleen een accountant mag een concept verwijderen, of het bestaat niet meer."),
          { code: "42501" },
        );
      }
      return openingBalanceId;
    },
    onError: (error) => logMutationError("concept verwijderen", error),
    onSettled: (_data, _error, openingBalanceId) => invalidateOpeningBalanceQueries(qc, openingBalanceId),
  });
}
