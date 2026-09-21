import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import { LEDGER_POSTINGS_QUERY_KEY } from "./useLedgerPostings";
import { UNPOSTED_SOURCE_WORK_QUERY_KEY } from "./useUnpostedSourceWork";
import { ACCOUNTING_DIAGNOSTICS_QUERY_KEY } from "./useAccountingDiagnostics";
import {
  classifyYearCloseError,
  safeYearCloseErrorMetadata,
  type YearClosure,
  type YearCloseResult,
} from "@/lib/year-close-action";

/**
 * Jaarafsluiting PR 2b — de datalaag.
 *
 * Er wordt hier NOOIT in `year_closures` of in `clients` geschreven. De enige
 * schrijfactie is één aanroep van `public.close_fiscal_year()` met precies twee
 * waarden: de administratie en het jaartal. Alles daarna — de herkeuring, het
 * bewijs, het watermerk — doet de database, in één transactie.
 *
 * `authenticated` heeft sowieso geen INSERT, UPDATE of DELETE op
 * `year_closures` (20260924120000), en `clients.afgesloten_boekjaar` kan alleen
 * nog naar een jaar waarvoor een bewijs bestaat. Een client-side schrijfpad
 * bestaat dus niet meer; deze hook bevestigt dat in code.
 */

export const YEAR_CLOSURE_QUERY_KEY = "year-closure" as const;

/**
 * TIJDELIJKE SHIM — weghalen zodra 20260924120000 in de gegenereerde types
 * staat (`src/integrations/supabase/types.ts` opnieuw genereren; nooit met de
 * hand bijwerken, zie AGENTS.md).
 *
 * Exact hetzelfde patroon als `useLedgerReversal.ts` voor 20260921120000: de
 * cast is zo smal mogelijk — precies de twee aanroepen die hier nodig zijn,
 * met echte parameter- en resultaattypes, geen brede `any`-laag.
 */
interface YearCloseApi {
  from(table: "year_closures"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: number,
        ): {
          maybeSingle(): PromiseLike<{
            data: YearClosure | null;
            error: { code?: string; message?: string } | null;
          }>;
        };
      };
    };
  };
  rpc(
    fn: "close_fiscal_year",
    args: { _client_id: string; _fiscal_year: number },
  ): PromiseLike<{ data: YearCloseResult[] | null; error: { code?: string; message?: string } | null }>;
}

const yearCloseApi = () => supabase as unknown as YearCloseApi;

const CLOSURE_COLUMNS = "client_id, organization_id, fiscal_year, closed_at, closed_by";

// ── Het bewijs lezen ────────────────────────────────────────────────────────

/**
 * Het afsluitbewijs van één administratie en één boekjaar.
 *
 * Altijd op BEIDE kolommen gefilterd: RLS is organisatiebreed en vervangt het
 * administratiepredicaat niet. `maybeSingle()` past precies, want de primary
 * key `(client_id, fiscal_year)` garandeert hoogstens één rij.
 *
 * De afsluitstatus komt UITSLUITEND hiervandaan — nooit uit
 * `clients.afgesloten_boekjaar` alleen, en nooit uit schermtoestand. Het
 * watermerk zegt "dit jaar is dicht", maar alleen het bewijs zegt "dit jaar is
 * via de jaarafsluiting dichtgegaan", en juist dat verschil is wat de
 * erfenistoestand van vóór PR 2a zichtbaar maakt.
 */
export function useYearClosure(clientId: string | undefined, fiscalYear: number, enabled = true) {
  const { user } = useAuth();
  return useQuery<YearClosure | null>({
    queryKey: [YEAR_CLOSURE_QUERY_KEY, clientId ?? "", fiscalYear],
    enabled: enabled && !!user && !!clientId,
    queryFn: async () => {
      const { data, error } = await yearCloseApi()
        .from("year_closures")
        .select(CLOSURE_COLUMNS)
        .eq("client_id", clientId!)
        .eq("fiscal_year", fiscalYear)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

// ── De rol ──────────────────────────────────────────────────────────────────

/**
 * Mag de ingelogde gebruiker afsluiten? De rollenladder blijft in de database:
 * één aanroep van `public.has_min_role()`, geen client-side rangorde.
 * `undefined` = nog onbekend, en dat telt als niet toegestaan. De RPC
 * controleert het recht hoe dan ook opnieuw — dit bepaalt alleen wat er op het
 * scherm wordt aangeboden.
 */
export function useCanCloseFiscalYear() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  return useQuery({
    queryKey: ["year-close-can-close", user?.id ?? "", activeOrganizationId ?? ""],
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

export interface CloseFiscalYearInput {
  clientId: string;
  fiscalYear: number;
}

function toClassifiedError(error: unknown) {
  const classified = classifyYearCloseError(error);
  return Object.assign(new Error(classified.message), {
    kind: classified.kind,
    code: classified.code,
    advice: classified.advice,
  });
}

/**
 * Alles wat na een afsluiting verouderd kan zijn, in één plek.
 *
 * `clients` staat er niet voor de sier: het watermerk is net verzet, en elke
 * andere pagina die daarop leunt (de inhaalslag, de boekingsschermen) zou
 * anders blijven denken dat het jaar nog open is.
 */
export function invalidateYearCloseQueries(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [YEAR_CLOSURE_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: ["clients"] }),
    queryClient.invalidateQueries({ queryKey: [LEDGER_POSTINGS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [UNPOSTED_SOURCE_WORK_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [ACCOUNTING_DIAGNOSTICS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: ["ledger-completeness"] }),
    queryClient.invalidateQueries({ queryKey: ["ledger-catchup"] }),
  ]);
}

/**
 * Sluit één boekjaar af.
 *
 * ER GAAN TWEE WAARDEN DE DEUR UIT. Geen resultaatbedrag, geen gereedheids-
 * uitslag, geen classificatie, geen watermerk, geen organisatie-id: de
 * database leidt dat allemaal zelf af en herkeurt het opnieuw. Zou deze hook
 * een oordeel meesturen, dan zou dat oordeel stilzwijgend de autoriteit worden.
 *
 * De RPC geeft één rij terug (`RETURNS TABLE`), dus PostgREST levert een array.
 * Een lege array is geen succes maar een gebroken aanname en wordt als fout
 * behandeld — fail closed.
 */
export function useCloseFiscalYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloseFiscalYearInput): Promise<YearCloseResult> => {
      const { data, error } = await yearCloseApi().rpc("close_fiscal_year", {
        _client_id: input.clientId,
        _fiscal_year: input.fiscalYear,
      });
      if (error) throw toClassifiedError(error);
      const row = data?.[0];
      if (!row) throw toClassifiedError(new Error("De afsluiting gaf geen afsluitbewijs terug."));
      return row;
    },
    onError: (error) => console.warn("[jaarafsluiting] mislukt", safeYearCloseErrorMetadata(error)),
    // Ook na een fout: de database kan wél hebben afgesloten terwijl het
    // antwoord wegviel, en de cache mag daar niet achterlopen.
    onSettled: () => invalidateYearCloseQueries(queryClient).then(() => undefined),
  });
}
