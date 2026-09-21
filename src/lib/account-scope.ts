/**
 * Welke grootboekrekeningen horen bij één administratie.
 *
 * DIT IS GEEN UI-CONVENTIE MAAR DE REGEL VAN DE DATABASE. `posting_account_ok()`
 * in de grootboekfundering (6C-b2) weigert elke boeking op een rekening die er
 * niet aan voldoet:
 *
 *     AND (g.client_id IS NULL OR g.client_id = _client_id)
 *     -- supabase/migrations/20260914120000_add_ledger_postings_foundation.sql:481
 *
 * Dezelfde formulering staat in de VAT- en bankconfiguratiemigraties
 * (20260915120000:161, 20260916120000:155) en in de classificatiemigratie
 * (20260920120000:60). Een organisatiebrede rekening (`client_id IS NULL`, het
 * ingezaaide schema) mag door elke administratie binnen de organisatie worden
 * gebruikt; een rekening met een `client_id` uitsluitend door díe administratie.
 *
 * Deze regel stond met de hand uitgeschreven op vijf plaatsen — `client-readiness.ts`,
 * `legacy-ledger-suggestion.ts`, `GrootboekCombobox.tsx`, `useDiagnosticSources.ts`
 * en binnen `buildTrialBalance()` zelf. Dit bestand is de ene plek waar zij
 * voortaan staat.
 *
 * WAT HIER NIET GEBEURT
 * Er wordt niets afgeleid uit rekeningnummer, naam of categorie, en er wordt
 * NIET op `actief` gefilterd: een inactieve rekening kan saldo dragen en moet
 * in de rapportage zichtbaar blijven. Wie alleen actieve rekeningen wil, filtert
 * dat zelf — bewust, en niet als bijwerking van de administratiegrens.
 */

/** Het enige veld waar de grens van afhangt. */
export interface ClientScopedAccountLike {
  /** `null` = organisatiebreed. */
  client_id?: string | null;
}

/**
 * Hoort deze rekening bij deze administratie?
 *
 * Zonder `clientId` (bijvoorbeeld "alle administraties") is er geen grens om
 * tegen te toetsen en hoort elke rekening erbij — hetzelfde wat
 * `buildTrialBalance()` doet met `!clientId`.
 */
export function accountBelongsToClient(
  account: ClientScopedAccountLike,
  clientId: string | null | undefined,
): boolean {
  if (!clientId) return true;
  // Een ontbrekend veld telt als organisatiebreed, net als in
  // `buildTrialBalance()` (`a.client_id == null`): sommige leesmodellen dragen
  // `client_id` niet mee, en die rekeningen dan stilzwijgend uit een rapport
  // laten vallen zou erger zijn dan ze tonen.
  const organisatiebreed = account.client_id === null || account.client_id === undefined;
  return organisatiebreed || account.client_id === clientId;
}

/**
 * De rekeningen van één administratie, in de volgorde waarin ze binnenkwamen.
 *
 * Puur: geen database, geen mutatie, geen sortering, dezelfde uitvoer bij
 * dezelfde invoer.
 */
export function accountsForClient<T extends ClientScopedAccountLike>(
  accounts: readonly T[],
  clientId: string | null | undefined,
): T[] {
  return accounts.filter((account) => accountBelongsToClient(account, clientId));
}
