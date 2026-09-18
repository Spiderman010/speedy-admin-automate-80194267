import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { CatchupRecord } from "@/lib/ledger-catchup";

/**
 * Boekbaarheid van deze inkoopfactuur — zichtbaar vóór er geboekt wordt.
 *
 * De inhoud komt volledig uit `evaluatePurchaseInvoice()` in
 * `src/lib/ledger-catchup.ts`, dezelfde beoordeling die de historische
 * grootboekvulling gebruikt en die één-op-één de guards van
 * `post_purchase_invoice()` volgt. Hier wordt geen enkele regel bij verzonnen:
 * dit bestand toont alleen wat die beoordeling teruggeeft.
 *
 * De server-writer blijft de autoriteit. Deze melding voorkomt dat de gebruiker
 * een voorspelbare weigering moet aanklikken; zegt hij "klaar" en weigert de
 * writer alsnog, dan blijft de factuur ongeboekt en verschijnt de fout van de
 * writer.
 */

export function PurchaseInvoicePostingReadiness({
  record,
  onOpenSettings,
}: {
  /** `undefined` zolang de factuur of de administratie nog laadt. */
  record: CatchupRecord | undefined;
  /**
   * Naar de administratie-instellingen. Als callback en niet als `Link`, zodat
   * dit paneel geen router nodig heeft en overal inzetbaar blijft.
   */
  onOpenSettings?: () => void;
}) {
  if (!record) return null;

  if (record.state === "geboekt") return null;

  if (record.state === "klaar") {
    return (
      <Alert data-testid="posting-readiness" data-readiness="klaar">
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Klaar om te boeken</AlertTitle>
        <AlertDescription>
          Deze factuur voldoet aan alle controles van de boekingsfunctie. Bij het boeken wordt alles
          server-side nog één keer gecontroleerd.
        </AlertDescription>
      </Alert>
    );
  }

  // Ligt de oorzaak in de instellingen van de administratie, dan helpt één link
  // meer dan tien keer dezelfde uitleg; daarom staat die knop er één keer.
  const heeftConfiguratieblokkade = record.blocks.some((b) => b.configuratie);

  return (
    <Alert variant="destructive" data-testid="posting-readiness" data-readiness="geblokkeerd">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Nog niet boekbaar</AlertTitle>
      <AlertDescription>
        <p>Deze factuur kan nog niet in het grootboek worden geboekt:</p>
        <ul className="mt-2 space-y-1">
          {record.blocks.map((b) => (
            <li key={b.code} className="flex flex-wrap items-center gap-2 text-sm" data-block-code={b.code}>
              <span>{b.label}</span>
              {b.configuratie && (
                <Badge variant="outline" className="text-[11px] font-normal">Instelling</Badge>
              )}
            </li>
          ))}
        </ul>
        {heeftConfiguratieblokkade && onOpenSettings && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onOpenSettings}
            data-testid="posting-readiness-settings"
          >
            Naar de administratie-instellingen
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
