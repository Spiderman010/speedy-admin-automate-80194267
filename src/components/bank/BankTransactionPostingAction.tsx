import { useState } from "react";
import { BankTransactionCorrectionAction } from "@/components/bank/BankTransactionCorrectionAction";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BtwKeuzeSelect } from "@/components/bank/BtwKeuzeSelect";
import { btwKeuzeFromPercentage } from "@/lib/btw-keuze";
import { useToast } from "@/hooks/use-toast";
import {
  useBankTransactionPosting,
  usePostBankTransaction,
} from "@/hooks/useBankTransactionPosting";
import type { Tables } from "@/integrations/supabase/types";

/**
 * "Boeken in grootboek" voor een handmatig gecodeerde bankregel.
 *
 * De hints hier zijn puur UX: public.post_bank_transaction() keurt alles
 * opnieuw server-side (status, rekeningen, bedrag, BTW, boekjaar, rechten) en
 * is de enige autoriteit. De client stuurt uitsluitend de transactie-id.
 */

export interface BankTransactionPostingActionProps {
  transaction: Tables<"bank_transactions">;
  /** Aantal factuurkoppelingen; die worden via de aflettering geboekt. */
  allocationCount: number;
}

export function BankTransactionPostingAction({
  transaction,
  allocationCount,
}: BankTransactionPostingActionProps) {
  const { toast } = useToast();
  const { data: posting, isPending: markerPending, isError: markerError } =
    useBankTransactionPosting(transaction.id);
  const postTransaction = usePostBankTransaction();

  // No silent VAT: without a stored percentage the user must choose one. A
  // default of "Geen BTW" would post a 21% expense gross, unnoticed.
  const [btw, setBtw] = useState<string>(() => btwKeuzeFromPercentage(transaction.btw_percentage));

  if (posting) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground" data-testid="bank-transaction-posting-done">
          Geboekt in het grootboek.
        </p>
        <BankTransactionCorrectionAction key={transaction.id} transaction={transaction} allocationCount={allocationCount} />
      </div>
    );
  }

  if (markerPending || markerError) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="bank-transaction-posting-unknown">
        Boekingsstatus kon niet worden opgehaald.
      </p>
    );
  }

  const blocker =
    allocationCount > 0
      ? "Deze bankregel is aan een factuur gekoppeld; boek die via de afletterdetails."
      : transaction.match_status !== "handmatig_geboekt"
        ? "Alleen handmatig gecodeerde bankregels kunnen zo geboekt worden."
        : !transaction.grootboekrekening_id
          ? "Kies eerst een grootboekrekening voor deze bankregel."
          : null;

  if (blocker) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="bank-transaction-posting-blocked">
        {blocker}
      </p>
    );
  }

  const handlePost = () => {
    if (btw === "") return;
    postTransaction.mutate(
      // "Geen BTW" is stored as an explicit 0, not as an unknown (null).
      { transactionId: transaction.id, btwPercentage: Number(btw) },
      {
        onSuccess: () => toast({ title: "Geboekt in het grootboek" }),
        onError: (e) =>
          toast({
            title: "Boeken is niet gelukt",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="bank-transaction-posting-action">
      <div className="grid gap-1">
        <Label htmlFor="bank-posting-btw" className="text-xs">BTW op deze regel</Label>
        <BtwKeuzeSelect id="bank-posting-btw" className="h-8" value={btw} onValueChange={setBtw} />
      </div>
      {btw === "" && (
        <p className="text-xs text-muted-foreground" data-testid="bank-transaction-posting-choose-vat">
          Kies eerst het BTW-percentage van deze regel.
        </p>
      )}
      <Button
        size="sm"
        className="w-full"
        onClick={handlePost}
        disabled={postTransaction.isPending || btw === ""}
      >
        {postTransaction.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
      </Button>
    </div>
  );
}
