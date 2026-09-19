import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import { LEDGER_POSTINGS_QUERY_KEY, type LedgerPosting } from "./useLedgerPostings";
import { LEDGER_INTEGRITY_QUERY_KEY } from "./useLedgerIntegrity";
import { ACCOUNTING_DIAGNOSTICS_QUERY_KEY } from "./useAccountingDiagnostics";
import { classifyReversalError, safeReversalErrorMetadata } from "@/lib/ledger-reversal-ui";

/**
 * 6C-b9 PR 2 — de datalaag van de correctieflow.
 *
 * Er wordt hier NOOIT in ledger_postings geschreven. De enige schrijfactie is
 * één aanroep van public.reverse_posting_group() met precies drie waarden: de
 * id van de boekingsgroep, de gekozen boekingsdatum en (optioneel) de
 * toelichting. Bedragen, zijden, rekeningen, valuta, organisatie, administratie
 * en de regel-op-regel-lineage komen alle uit de database.
 *
 * Sinds 20260920130000 heeft `authenticated` sowieso geen INSERT-recht meer op
 * ledger_postings; een client-side schrijfpad bestaat niet meer. Deze hook
 * bevestigt dat in code.
 */

export const LEDGER_REVERSAL_QUERY_KEY = "ledger-reversal" as const;
export const POSTING_GROUP_QUERY_KEY = "ledger-posting-group" as const;

/**
 * TIJDELIJKE SHIM — weghalen zodra 20260921120000 in de gegenereerde types
 * staat (`src/integrations/supabase/types.ts` opnieuw genereren; nooit met de
 * hand bijwerken, zie AGENTS.md en patterns §11).
 *
 * De migratie is toegepast op productie, maar de gegenereerde types kennen
 * `ledger_reversal_postings` en `reverse_posting_group` nog niet. De cast is
 * bewust zo smal mogelijk: precies de twee aanroepen die hier nodig zijn, met
 * echte parameter- en resultaattypes — geen brede `any`-laag.
 */
export interface LedgerReversalMarker {
  original_posting_group_id: string;
  reversal_posting_group_id: string;
  organization_id: string;
  client_id: string;
  original_posting_date: string;
  original_boekjaar: number;
  original_source_type: string;
  posting_date: string;
  boekjaar: number;
  line_count: number;
  total_amount: number | string;
  currency: string;
  reason: string | null;
  user_id: string;
  created_at: string;
}

const MARKER_COLUMNS =
  "original_posting_group_id, reversal_posting_group_id, organization_id, client_id, " +
  "original_posting_date, original_boekjaar, original_source_type, posting_date, boekjaar, " +
  "line_count, total_amount, currency, reason, user_id, created_at";

interface ReversalApi {
  from(table: "ledger_reversal_postings"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): PromiseLike<{ data: LedgerReversalMarker | null; error: { code?: string; message?: string } | null }>;
      };
    };
  };
  rpc(
    fn: "reverse_posting_group",
    args: { _posting_group_id: string; _posting_date: string; _reason: string | null },
  ): PromiseLike<{ data: string | null; error: { code?: string; message?: string } | null }>;
}

const reversalApi = () => supabase as unknown as ReversalApi;

// ── De boekingsgroep zelf ───────────────────────────────────────────────────

/**
 * De grootboekregels van één boekingsgroep, altijd ook op `client_id`
 * gefilterd: RLS is organisatiebreed en vervangt het administratiepredicaat
 * niet. Geen periodefilter — een boekingsgroep hoort bij één boekingsdatum en
 * mag nooit half worden getoond.
 */
export function usePostingGroupRows(options: {
  clientId: string | undefined;
  postingGroupId: string | undefined;
  enabled?: boolean;
}) {
  const { user } = useAuth();
  const { clientId, postingGroupId, enabled = true } = options;
  return useQuery<LedgerPosting[]>({
    queryKey: [POSTING_GROUP_QUERY_KEY, clientId ?? "", postingGroupId ?? ""],
    enabled: !!user && !!clientId && !!postingGroupId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ledger_postings")
        .select("*")
        .eq("client_id", clientId!)
        .eq("posting_group_id", postingGroupId!)
        .order("line_no", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as LedgerPosting[];
    },
  });
}

// ── De claim ────────────────────────────────────────────────────────────────

export interface ReversalRelation {
  /** De claim waarin DEZE groep het origineel is: zij is dus tegengeboekt. */
  asOriginal: LedgerReversalMarker | null;
  /** De claim waarin DEZE groep de tegenboeking is: zij corrigeert iets. */
  asReversal: LedgerReversalMarker | null;
}

/**
 * De tegenboekingsstatus komt UITSLUITEND uit public.ledger_reversal_postings.
 * Nooit afgeleid uit een omschrijving, een bronlabel of een saldo van nul: die
 * zeggen niets over de vraag of er werkelijk een tegenboeking is vastgelegd.
 */
export function useReversalRelation(options: {
  postingGroupId: string | undefined;
  enabled?: boolean;
}) {
  const { user } = useAuth();
  const { postingGroupId, enabled = true } = options;
  return useQuery<ReversalRelation>({
    queryKey: [LEDGER_REVERSAL_QUERY_KEY, postingGroupId ?? ""],
    enabled: !!user && !!postingGroupId && enabled,
    queryFn: async () => {
      const api = reversalApi();
      const [origineel, tegen] = await Promise.all([
        api
          .from("ledger_reversal_postings")
          .select(MARKER_COLUMNS)
          .eq("original_posting_group_id", postingGroupId!)
          .maybeSingle(),
        api
          .from("ledger_reversal_postings")
          .select(MARKER_COLUMNS)
          .eq("reversal_posting_group_id", postingGroupId!)
          .maybeSingle(),
      ]);
      if (origineel.error) throw origineel.error;
      if (tegen.error) throw tegen.error;
      return { asOriginal: origineel.data ?? null, asReversal: tegen.data ?? null };
    },
  });
}

// ── De rol ──────────────────────────────────────────────────────────────────

/**
 * Mag de ingelogde gebruiker tegenboeken? De rollenladder blijft in de
 * database: één aanroep van public.has_min_role(), geen client-side rangorde.
 * `undefined` = nog onbekend, en dat telt als niet toegestaan. De RPC
 * controleert het recht hoe dan ook opnieuw — dit bepaalt alleen wat er op het
 * scherm wordt aangeboden.
 */
export function useCanReversePostingGroup() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  return useQuery({
    queryKey: ["ledger-reversal-can-reverse", user?.id ?? "", activeOrganizationId ?? ""],
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

// ── De enige schrijfactie ───────────────────────────────────────────────────

export interface ReversePostingGroupInput {
  postingGroupId: string;
  /** ISO yyyy-mm-dd, expliciet door de gebruiker gekozen. */
  postingDate: string;
  /** Al genormaliseerd: leeg of alleen witruimte is `null`. */
  reason: string | null;
}

function toClassifiedError(error: unknown) {
  const classified = classifyReversalError(error);
  return Object.assign(new Error(classified.message), { kind: classified.kind, code: classified.code });
}

/** Alles wat na een tegenboeking verouderd kan zijn, in één plek. */
export function invalidateReversalQueries(
  queryClient: QueryClient,
  postingGroupId: string,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [LEDGER_REVERSAL_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [POSTING_GROUP_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [LEDGER_POSTINGS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [LEDGER_INTEGRITY_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [ACCOUNTING_DIAGNOSTICS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: ["ledger-completeness"] }),
    queryClient.invalidateQueries({ queryKey: ["ledger-catchup"] }),
  ]).then(() => postingGroupId);
}

export function useReversePostingGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReversePostingGroupInput) => {
      const { data, error } = await reversalApi().rpc("reverse_posting_group", {
        _posting_group_id: input.postingGroupId,
        _posting_date: input.postingDate,
        _reason: input.reason,
      });
      if (error) throw toClassifiedError(error);
      // De functie geeft de id van de nieuwe boekingsgroep terug.
      return data;
    },
    onError: (error) => console.warn("[tegenboeking] mislukt", safeReversalErrorMetadata(error)),
    // Ook na een fout: een 23505 betekent dat iemand anders eerder was, en de
    // cache mag daar niet achterlopen.
    onSettled: (_data, _error, input) =>
      invalidateReversalQueries(queryClient, input.postingGroupId).then(() => undefined),
  });
}
