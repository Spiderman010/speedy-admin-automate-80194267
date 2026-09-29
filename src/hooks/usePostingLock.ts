import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import { ACCOUNTING_DIAGNOSTICS_QUERY_KEY } from "./useAccountingDiagnostics";
import { BANK_BULK_CANDIDATES_QUERY_KEY } from "./useBankBulkPosting";
import { LEDGER_CATCHUP_QUERY_KEY } from "./useLedgerCatchup";
import {
  classifyPostingLockError,
  safePostingLockErrorMetadata,
  sortLockEventsChronologically,
  type PostingLockEvent,
  type SetPostingLockResult,
} from "@/lib/posting-lock";

/**
 * De boekingsblokkade — de datalaag.
 *
 * ÉÉN SCHRIJFGRENS: `public.set_posting_lock()`. Er wordt hier nooit in
 * `clients` of `posting_lock_events` geschreven; de kolom kan ook alleen via
 * die schrijver bewegen (trigger `enforce_posting_lock_change`, PR C), en de
 * app heeft geen schrijfrecht op de gebeurtenissen.
 *
 * DEZE LAAG KENT DE JAARAFSLUITING NIET. Geen afsluit- of heropenaanroep, geen
 * jaarwatermerk, geen afsluitbewijs. De twee besturingselementen staan los van
 * elkaar, en dat begint bij de code.
 */

export const POSTING_LOCK_STATE_QUERY_KEY = "posting-lock-state" as const;
export const POSTING_LOCK_EVENTS_QUERY_KEY = "posting-lock-events" as const;

type ApiError = { code?: string; message?: string } | null;

/**
 * TIJDELIJKE SHIM — weghalen zodra 20260927120000 in de gegenereerde types
 * staat (`src/integrations/supabase/types.ts` opnieuw genereren; nooit met de
 * hand bijwerken, zie AGENTS.md). Zo smal mogelijk: precies de drie aanroepen
 * die hier nodig zijn, met echte parameter- en resultaattypes.
 */
interface PostingLockApi {
  from(table: "clients"): {
    select(columns: "id, posting_locked_through"): {
      eq(
        column: "id",
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: { id: string; posting_locked_through: string | null } | null;
          error: ApiError;
        }>;
      };
    };
  };
  from(table: "posting_lock_events"): {
    select(columns: string): {
      eq(
        column: "client_id",
        value: string,
      ): {
        order(
          column: string,
          options?: { ascending?: boolean },
        ): {
          order(
            column: string,
            options?: { ascending?: boolean },
          ): PromiseLike<{ data: PostingLockEvent[] | null; error: ApiError }>;
        };
      };
    };
  };
  rpc(
    fn: "set_posting_lock",
    args: { _client_id: string; _locked_through: string | null; _reason: string },
  ): PromiseLike<{ data: SetPostingLockResult[] | null; error: ApiError }>;
}

const postingLockApi = () => supabase as unknown as PostingLockApi;

const EVENT_COLUMNS =
  "id, client_id, organization_id, previous_locked_through, new_locked_through, changed_at, changed_by, reason";

// ── Lezen ───────────────────────────────────────────────────────────────────

/**
 * De huidige blokkadedatum van één administratie. `null` = geen blokkade.
 * Een ontbrekende rij (RLS of verkeerde id) is een FOUT, geen "geen blokkade":
 * anders zou het scherm een onbeschermde administratie melden die het niet
 * eens heeft kunnen lezen.
 */
export async function fetchPostingLockState(clientId: string): Promise<string | null> {
  const { data, error } = await postingLockApi()
    .from("clients")
    .select("id, posting_locked_through")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Administratie niet gevonden");
  return data.posting_locked_through ?? null;
}

/*
 * BEWUST GEEN "lees-of-onbekend"-variant. Een leesfout hier is een gewone
 * queryfout: zij hoort de omsluitende React Query-aanroep te laten falen,
 * zodat de normale retry en de zichtbare "Opnieuw proberen" van die pagina
 * gelden. Een gevangen fout die als geslaagde data wordt gecachet, neemt de
 * gebruiker juist elke herstelweg af. "Onbekend" ontstaat daarom alleen op de
 * plek waar de lezing haar eigen query heeft (usePostingLockState): zolang die
 * niet geslaagd is, én met een eigen refetch-knop erbij.
 */

export function usePostingLockState(clientId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery<string | null>({
    queryKey: [POSTING_LOCK_STATE_QUERY_KEY, clientId ?? ""],
    enabled: enabled && !!user && !!clientId,
    queryFn: () => fetchPostingLockState(clientId!),
  });
}

/** De geschiedenis, chronologisch (oudste eerst). Alleen lezen. */
export function usePostingLockEvents(clientId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery<PostingLockEvent[]>({
    queryKey: [POSTING_LOCK_EVENTS_QUERY_KEY, clientId ?? ""],
    enabled: enabled && !!user && !!clientId,
    queryFn: async () => {
      const { data, error } = await postingLockApi()
        .from("posting_lock_events")
        .select(EVENT_COLUMNS)
        .eq("client_id", clientId!)
        .order("changed_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return sortLockEventsChronologically(data ?? []);
    },
  });
}

/**
 * Mag de ingelogde gebruiker de blokkade wijzigen? Eén aanroep van
 * `has_min_role()` met de vloer van de schrijver (accountant). Dit bepaalt
 * alleen wat er wordt aangeboden; de schrijver toetst hoe dan ook opnieuw.
 */
export function useCanSetPostingLock() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  return useQuery({
    queryKey: ["posting-lock-can-set", user?.id ?? "", activeOrganizationId ?? ""],
    enabled: !!user && isReady && !!activeOrganizationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("has_min_role", {
        _user_id: user!.id,
        _organization_id: activeOrganizationId!,
        _min: "accountant",
      });
      if (error) throw error;
      return data === true;
    },
  });
}

// ── Schrijven ───────────────────────────────────────────────────────────────

export interface SetPostingLockInput {
  clientId: string;
  /** ISO-datum, of `null` om de blokkade op te heffen. */
  lockedThrough: string | null;
  /** Al getrimd en getoetst; de schrijver toetst opnieuw. */
  reason: string;
}

/**
 * Alles wat na een blokkadewijziging verouderd kan zijn.
 *
 * `clients` omdat die rij de kolom draagt; de bank-preflight en de
 * inhaalslag omdat zij "boekbaar" beoordelen en sinds PR D de blokkade
 * meewegen; de diagnostiek omdat die op dezelfde bronnen leunt.
 */
export function invalidatePostingLockQueries(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [POSTING_LOCK_STATE_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [POSTING_LOCK_EVENTS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: ["clients"] }),
    queryClient.invalidateQueries({ queryKey: [BANK_BULK_CANDIDATES_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [LEDGER_CATCHUP_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: ["ledger-completeness"] }),
    queryClient.invalidateQueries({ queryKey: [ACCOUNTING_DIAGNOSTICS_QUERY_KEY] }),
  ]);
}

function toClassifiedError(error: unknown) {
  const c = classifyPostingLockError(error);
  return Object.assign(new Error(c.message), { kind: c.kind, code: c.code, advice: c.advice });
}

/**
 * Zet, verschuift of heft de boekingsblokkade op.
 *
 * ER GAAN DRIE WAARDEN DE DEUR UIT: administratie, datum (of `null`) en de
 * reden. `changed = false` is geen fout: de gevraagde waarde stond er al.
 * Een lege array is wél een fout — fail closed.
 */
export function useSetPostingLock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetPostingLockInput): Promise<SetPostingLockResult> => {
      const { data, error } = await postingLockApi().rpc("set_posting_lock", {
        _client_id: input.clientId,
        _locked_through: input.lockedThrough,
        _reason: input.reason,
      });
      if (error) throw toClassifiedError(error);
      const row = data?.[0];
      if (!row) throw toClassifiedError(new Error("De wijziging gaf geen uitkomst terug."));
      return row;
    },
    onError: (error) => console.warn("[boekingsblokkade] mislukt", safePostingLockErrorMetadata(error)),
    // Ook na een fout: de database kan wél hebben gewijzigd terwijl het
    // antwoord wegviel, en de cache mag daar niet achterlopen.
    onSettled: () => invalidatePostingLockQueries(queryClient).then(() => undefined),
  });
}
