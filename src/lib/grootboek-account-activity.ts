import type { LedgerAccountRollup } from "./ledger-reporting";

/**
 * "Met saldo" = heeft deze rekening grootboekactiviteit?
 *
 * DE DEFINITIE IS NIET NIEUW. Zij staat al in `financial-statements.ts` als
 * `rollupHasActivity()` en bepaalt daar of een niet-geclassificeerde rekening
 * het rapport onvolledig maakt. Dat bestand is byte-voor-byte bevroren (de
 * PR 5-bewaking vergelijkt het met `origin/main`) en de functie is daar privé,
 * dus zij kon niet worden geëxporteerd. Vandaar deze gedeelde kopie — mét een
 * test die haar aan de échte engine-uitkomst (`UnclassifiedAccount.hasActivity`)
 * ijkt, zodat de twee niet ongemerkt uit elkaar kunnen lopen.
 *
 * WAAROM NIET GEWOON `closingCents !== 0`:
 * een rekening waarop €500 is gedebiteerd en €500 gecrediteerd heeft een
 * eindsaldo van nul en tóch een volle kolom mutaties. Die verbergen zou precies
 * de rekeningen wegfilteren waar iets aan de hand is. Openingssaldo telt mee om
 * dezelfde reden: een rekening die het jaar met een saldo begint en verder geen
 * beweging kent, dráágt saldo.
 *
 * Er wordt hier niets afgeleid uit rekeningnummer, omschrijving of `categorie`;
 * uitsluitend uit de bedragen die de rapportagekern heeft geteld.
 */
export function rollupHasLedgerActivity(rollup: LedgerAccountRollup): boolean {
  return (
    rollup.openingCents !== 0 ||
    rollup.periodDebitCents !== 0 ||
    rollup.periodCreditCents !== 0 ||
    rollup.closingCents !== 0
  );
}

/** De id's van alle rekeningen met activiteit, voor een filter op het schema. */
export function accountIdsWithActivity(rollups: readonly LedgerAccountRollup[]): Set<string> {
  const ids = new Set<string>();
  for (const rollup of rollups) {
    if (rollupHasLedgerActivity(rollup)) ids.add(rollup.account.id);
  }
  return ids;
}
