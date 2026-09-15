import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoicePosting } from "@/hooks/usePurchaseInvoicePosting";
import { useSalesInvoicePosting } from "@/hooks/useSalesInvoicePosting";
import { useBankAllocationPosting, usePostBankAllocation } from "@/hooks/useBankAllocationPosting";
import type { Tables } from "@/integrations/supabase/types";
import type { BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";

/**
 * Fase 6C-b5b — "Boeken in grootboek" per bankkoppeling.
 *
 * Toont per koppeling óf dat hij geboekt is, óf de eerste reden waarom boeken
 * nu niet kan, óf de knop. De hints hier zijn puur UX: de RPC
 * public.post_bank_allocation() controleert alles opnieuw server-side
 * (richting, bedragen, rekeningen, geboekte factuur, boekjaar, rechten) en is
 * de enige autoriteit. De client stuurt uitsluitend de koppeling-id — nooit
 * bedragen, rekeningen of datums.
 *
 * Persisted-state: de drawer heeft geen lokaal concept van koppelingsbedragen.
 * Bank.tsx schrijft koppelingen direct weg via
 * useUpsertBankTransactionAllocation / de delete-mutaties en de lijst wordt
 * opnieuw uit React Query gelezen, dus deze kaart toont altijd de opgeslagen
 * rij. Het "niet-opgeslagen formulier"-risico van de verkoopdialoog bestaat
 * hier dus niet. Of er op dit moment nog een koppelingsmutatie onderweg is, is
 * vanaf hier niet waarneembaar; daarvoor vertrouwen we op het feit dat de RPC
 * de rij server-side met een rijgrendel opnieuw leest en alles herkeurt (dat
 * doet hij).
 */

export interface BankAllocationPostingActionProps {
  allocation: BankTransactionAllocation;
  transaction: Tables<"bank_transactions">;
  /**
   * Optionele overrule van "is de bronfactuur geboekt?". Wanneer undefined
   * vraagt de component het zelf op via de posting-hooks van fase 6C-b3/b4.
   */
  invoicePosted?: boolean;
  /** Optionele overrule van de administratie; anders opgezocht via useClients(). */
  client?: Tables<"clients">;
}

export function BankAllocationPostingAction({
  allocation,
  transaction,
  invoicePosted,
  client,
}: BankAllocationPostingActionProps) {
  const { toast } = useToast();
  const isPurchase = allocation.invoice_type === "inkoop";

  // Hooks worden altijd in dezelfde volgorde aangeroepen; de "verkeerde" krijgt
  // undefined en blijft uitgeschakeld.
  const { data: purchasePosting } = usePurchaseInvoicePosting(
    isPurchase ? allocation.invoice_id : undefined,
  );
  const { data: salesPosting } = useSalesInvoicePosting(
    isPurchase ? undefined : allocation.invoice_id,
  );
  const {
    data: allocationPosting,
    isPending: markerPending,
    isError: markerError,
  } = useBankAllocationPosting(allocation.id);
  const { data: clients } = useClients();
  const postAllocation = usePostBankAllocation();

  const resolvedClient = client ?? clients?.find((c) => c.id === transaction.client_id);
  const sourcePosted =
    invoicePosted ?? (isPurchase ? !!purchasePosting : !!salesPosting);

  if (allocationPosting) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="bank-posting-done">
        Geboekt in het grootboek.
      </p>
    );
  }

  // "Weet ik niet" is niet hetzelfde als "niet geboekt". Zolang de
  // claimtabel nog niet bevraagd is (laden) of niet bevraagd kán worden (bv.
  // de migratie is nog niet op productie toegepast, PostgREST kent de tabel
  // niet), blijft de knop uit met een neutrale uitleg. Anders zou een klik
  // een rauwe schema-cache-fout tonen.
  const hint = markerError
    ? "Boeken in het grootboek is nog niet beschikbaar voor bankkoppelingen."
    : markerPending
      ? "Boekingsstatus wordt geladen…"
      : firstBlockingReason({
          isPurchase,
          sourcePosted,
          txAmount: transaction.amount,
          client: resolvedClient,
        });

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-border/50">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="bank-posting-button"
        disabled={!!hint || postAllocation.isPending}
        onClick={async () => {
          try {
            await postAllocation.mutateAsync(allocation.id);
            toast({ title: "Aflettering geboekt" });
          } catch (e) {
            toast({
              title: "Boeken niet gelukt",
              description: e instanceof Error ? e.message : undefined,
              variant: "destructive",
            });
          }
        }}
      >
        {postAllocation.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
      </Button>
      {hint && (
        <p className="text-xs text-muted-foreground" data-testid="bank-posting-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

function firstBlockingReason({
  isPurchase,
  sourcePosted,
  txAmount,
  client,
}: {
  isPurchase: boolean;
  sourcePosted: boolean;
  txAmount: number;
  client: Tables<"clients"> | undefined;
}): string | null {
  if (!sourcePosted) return "Boek eerst de factuur in het grootboek.";
  if (!client?.bank_rekening_id) {
    return "Geen bankrekening (grootboek) ingesteld voor deze administratie.";
  }
  if (!isPurchase && !client.debiteuren_rekening_id) return "Geen debiteurenrekening ingesteld.";
  if (isPurchase && !client.crediteuren_rekening_id) return "Geen crediteurenrekening ingesteld.";
  // Tekenconventie (Bank.tsx:111): >= 0 = inkomend = verkoop, < 0 = uitgaand = inkoop.
  if (!isPurchase && txAmount <= 0) return "Richting van de banktransactie past niet bij dit koppelingstype.";
  if (isPurchase && txAmount >= 0) return "Richting van de banktransactie past niet bij dit koppelingstype.";
  return null;
}
