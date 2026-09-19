import { useMemo } from "react";
import { useLedgerPostings } from "./useLedgerPostings";
import { buildAccountReport } from "@/lib/ledger-reporting";
import { ALL_TIME_PERIOD } from "@/lib/grootboek-saldi-utils";
import { accountIdsWithActivity } from "@/lib/grootboek-account-activity";
import type { Grootboekrekening } from "./useGrootboekrekeningen";

/**
 * Welke grootboekrekeningen hebben grootboekactiviteit in deze administratie?
 *
 * Eén bron: `ledger_postings` via de bestaande `useLedgerPostings`, door de
 * bestaande rapportagekern `buildAccountReport()`. Er wordt hier niets zelf
 * geteld en niets geraden — het rekeningschema is organisatiebreed, de
 * activiteit is per administratie, en dat verschil wordt hier overbrugd.
 *
 * WAAROM DIT EEN EIGEN HOOK IS: het rekeningschema mag zelf geen rapportage-
 * engine aanroepen (daar staat een bewaking op, en terecht — die pagina gaat
 * over stamgegevens en classificatie, niet over bedragen). De pagina vraagt
 * hier dus alleen een verzameling id's op.
 *
 * PERIODE: `ALL_TIME`. "Met saldo" beantwoordt de vraag óf een rekening ooit
 * is gebruikt, niet wat zij in een boekjaar deed. Een jaarvenster zou een
 * rekening met alleen oudere mutaties ten onrechte als ongebruikt tonen.
 */
export interface AccountsWithActivity {
  /**
   * `undefined` = geen betrouwbaar antwoord (uit, geen administratie, nog aan
   * het laden, of de zelfcontrole van de kern sluit niet). De aanroeper hoort
   * dan NIET te filteren, want een lege verzameling zou "geen enkele rekening
   * heeft saldo" beweren.
   */
  ids: Set<string> | undefined;
  isPending: boolean;
  isError: boolean;
}

export function useAccountsWithActivity(options: {
  clientId: string | undefined;
  accounts: Grootboekrekening[] | undefined;
  enabled: boolean;
}): AccountsWithActivity {
  const { clientId, accounts, enabled } = options;
  const query = useLedgerPostings({
    clientId,
    period: ALL_TIME_PERIOD,
    enabled: enabled && !!clientId,
  });

  const ids = useMemo(() => {
    if (!enabled || !clientId || query.isError || !query.data) return undefined;
    try {
      const report = buildAccountReport({
        rows: query.data,
        clientId,
        period: ALL_TIME_PERIOD,
        accounts,
      });
      // Sluit de zelfcontrole niet, dan zijn de rollups niet betrouwbaar.
      return report.ok === true ? accountIdsWithActivity(report.rollups) : undefined;
    } catch {
      return undefined;
    }
  }, [enabled, clientId, query.data, query.isError, accounts]);

  return { ids, isPending: query.isPending, isError: query.isError };
}
