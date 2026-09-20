import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
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

const BTW_OPTIES = [
  { value: "0", label: "Geen BTW" },
  { value: "9", label: "9%" },
  { value: "21", label: "21%" },
];

export function BankTransactionPostingAction({
  transaction,
  allocationCount,
}: BankTransactionPostingActionProps) {
  const { toast } = useToast();
  const { data: posting, isPending: markerPending, isError: markerError } =
    useBankTransactionPosting(transaction.id);
  const postTransaction = usePostBankTransaction();

  const [btw, setBtw] = useState<string>(
    transaction.btw_percentage != null ? String(transaction.btw_percentage) : "0",
  );

  if (posting) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="bank-transaction-posting-done">
        Geboekt in het grootboek.
      </p>
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
    postTransaction.mutate(
      { transactionId: transaction.id, btwPercentage: Number(btw) || null },
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
        <Select value={btw} onValueChange={setBtw}>
          <SelectTrigger id="bank-posting-btw" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BTW_OPTIES.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        size="sm"
        className="w-full"
        onClick={handlePost}
        disabled={postTransaction.isPending}
      >
        {postTransaction.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
      </Button>
    </div>
  );
}
