import { BALANS_GROUPS, isReportGroup, isStatementType } from "./reporting-classification";
import type { UnclassifiedAccount } from "./financial-statements";

/**
 * Fix — rapportage zonder beginbalans, reviewronde 2.
 *
 * Voor wélk overzicht was een niet-geclassificeerde rekening bedoeld?
 *
 * Een lege Balans of W&V mag alleen aan ontbrekende classificatie worden
 * toegeschreven wanneer de betrokken activiteit ook werkelijk bij dát
 * overzicht hoort. Een globale telling over álle niet-geclassificeerde
 * rekeningen doet dat niet: staat de activiteit aan de balanskant, dan zou de
 * W&V ten onrechte beweren dat zíj leeg is doordat W&V-rekeningen niet zijn
 * geclassificeerd — en omgekeerd.
 *
 * De toewijzing komt uitsluitend uit de twee expliciete classificatievelden
 * die de engine ongewijzigd doorgeeft. Er wordt NIETS afgeleid uit het
 * rekeningnummer, de omschrijving of `categorie`; die laatste is in deze
 * architectuur geen rapportageclassificatie en blijft dat ook hier. Kan het
 * overzicht niet uit die velden worden aangetoond, dan is het antwoord
 * "onbepaald" en zegt de melding dat ook: een onjuiste oorzaak claimen is
 * erger dan geen oorzaak noemen.
 *
 * Puur: geen React, geen query, geen bedrag. Er wordt hier niets gefilterd of
 * herordend — alleen geteld; de rekeningen zelf gaan ongewijzigd naar de
 * tabel "Niet geclassificeerd".
 */

export type UnclassifiedStatementAttribution = "balans" | "winst_verlies" | "onbepaald";

export function attributeUnclassifiedAccount(
  account: Pick<UnclassifiedAccount, "statementType" | "reportGroup" | "reason">,
): UnclassifiedStatementAttribution {
  // Botsen de twee velden (`invalid_group_for_statement`), dan zijn er twee
  // expliciete signalen die elkaar tegenspreken en valt niet vast te stellen
  // welk van beide de vergissing is. Dan dus geen keuze.
  if (account.reason === "invalid_group_for_statement") return "onbepaald";

  // Het overzicht staat er met zoveel woorden; alleen de groep ontbreekt nog.
  if (isStatementType(account.statementType)) return account.statementType;

  // Geen overzicht ingevuld, wél een geldige groep: de groepsverzamelingen van
  // de balans en de W&V zijn disjunct, dus de groep wijst het overzicht aan.
  // Dat is geen gok maar dezelfde expliciete metadata, van de andere kant.
  if (isReportGroup(account.reportGroup)) {
    return (BALANS_GROUPS as readonly string[]).includes(account.reportGroup) ? "balans" : "winst_verlies";
  }

  // Beide velden leeg (`unresolved_account`, `account_not_supplied`, of
  // simpelweg nooit ingevuld — de toestand van elke administratie sinds de
  // classificatiemigratie, die bewust geen backfill deed). Onbepaald.
  return "onbepaald";
}

export interface UnclassifiedRelevance {
  /** Rekeningen mét beweging die aantoonbaar voor dít overzicht bedoeld zijn. */
  relevantCount: number;
  /** Rekeningen mét beweging waarvan het overzicht niet is vast te stellen. */
  undeterminedCount: number;
  /** Is er op dit overzicht iets te melden? */
  any: boolean;
}

/**
 * De telling per overzicht. Rekeningen zonder beweging tellen niet mee: die
 * wachten op classificatie, maar er ontbreekt geen cijfer, dus ze maken het
 * rapport niet onvolledig.
 */
export function unclassifiedRelevanceFor(
  accounts: readonly UnclassifiedAccount[],
  what: "balans" | "winst_verlies",
): UnclassifiedRelevance {
  let relevantCount = 0;
  let undeterminedCount = 0;
  for (const account of accounts) {
    if (!account.hasActivity) continue;
    const toewijzing = attributeUnclassifiedAccount(account);
    if (toewijzing === what) relevantCount++;
    else if (toewijzing === "onbepaald") undeterminedCount++;
  }
  return { relevantCount, undeterminedCount, any: relevantCount > 0 || undeterminedCount > 0 };
}
