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
/**
 * De vier toestanden die de aanroeper uit elkaar moet kunnen houden.
 *
 * Eén `undefined` voor alles was niet genoeg: "nog aan het laden" en "de
 * uitkomst is onbetrouwbaar" vragen om verschillende woorden op het scherm.
 * Zonder dat onderscheid kon een kernelfout stilzwijgend een ongefilterde
 * lijst opleveren — een actief boekhoudfilter dat er wél staat maar niets
 * doet, zonder dat iemand het merkt.
 */
export type AccountsWithActivityStatus =
  /** Filter uit, of geen administratie gekozen. Er is niets beloofd. */
  | "idle"
  /** De mutaties worden opgehaald; er is nog geen antwoord. */
  | "loading"
  /** `ids` is bruikbaar. */
  | "ready"
  /** Query mislukt, of de rapportagekern gaf geen betrouwbaar rapport. */
  | "error";

export interface AccountsWithActivity {
  status: AccountsWithActivityStatus;
  /**
   * Uitsluitend gevuld bij `status === "ready"`. In elke andere toestand hoort
   * de aanroeper NIET te filteren: een lege verzameling zou beweren dat geen
   * enkele rekening saldo heeft.
   */
  ids: Set<string> | undefined;
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

  return useMemo<AccountsWithActivity>(() => {
    if (!enabled || !clientId) return { status: "idle", ids: undefined };
    // Een mislukte query en een mislukte zelfcontrole zijn voor de gebruiker
    // hetzelfde: het antwoord is niet te vertrouwen.
    if (query.isError) return { status: "error", ids: undefined };
    if (!query.data) return { status: "loading", ids: undefined };

    try {
      const report = buildAccountReport({
        rows: query.data,
        clientId,
        period: ALL_TIME_PERIOD,
        accounts,
      });
      // Sluit de zelfcontrole van de kern niet, dan zijn de rollups niet
      // betrouwbaar en is "geen saldo" geen uitspraak die we mogen doen.
      if (report.ok !== true) return { status: "error", ids: undefined };
      return { status: "ready", ids: accountIdsWithActivity(report.rollups) };
    } catch {
      // De kern gooit bij een vreemde administratie, valuta of periode. Ook dan
      // geen stille terugval op een ongefilterde lijst.
      return { status: "error", ids: undefined };
    }
  }, [enabled, clientId, query.data, query.isError, accounts]);
}
