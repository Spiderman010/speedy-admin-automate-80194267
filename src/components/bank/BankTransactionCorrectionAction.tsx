import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useToast } from "@/hooks/use-toast";
import type { Tables } from "@/integrations/supabase/types";
import { useBankTransactionPosting } from "@/hooks/useBankTransactionPosting";
import { useReclassifyBankTransaction } from "@/hooks/useBankTransactionCorrection";

export function BankTransactionCorrectionAction({ transaction, allocationCount }: {
  transaction: Tables<"bank_transactions">;
  allocationCount: number;
}) {
  const { data: posting, isPending: loading, isError, refetch: refetchPosting } = useBankTransactionPosting(transaction.id);
  const correction = useReclassifyBankTransaction();
  const { user } = useAuth();
  const { data: canCorrect } = useQuery({
    queryKey: ["bank-correction-accountant", transaction.organization_id, user?.id],
    enabled: !!user?.id && !!transaction.organization_id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("has_min_role", {
        _min: "accountant",
        _organization_id: transaction.organization_id,
        _user_id: user!.id,
      });
      if (error) throw error;
      return data === true;
    },
  });
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [vat, setVat] = useState(String(transaction.btw_percentage ?? 0));
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [openedPostingGroupId, setOpenedPostingGroupId] = useState<string | null>(null);

  // Until the marker is known, fail closed. Invoice-linked transactions are excluded in v1.1.
  if (loading || isError || allocationCount > 0) return null;
  if (!posting || transaction.match_status !== "handmatig_geboekt" || canCorrect !== true) return null;

  const submit = async () => {
    if (!accountId || !reason.trim() || reason.trim().length > 500 || correction.isPending || !openedPostingGroupId) return;
    const id = requestId ?? crypto.randomUUID();
    if (!requestId) setRequestId(id); // Retain idempotency key on retry.
    try {
      await correction.mutateAsync({
        transactionId: transaction.id,
        expectedPostingGroupId: openedPostingGroupId,
        accountId, vat: Number(vat), reason: reason.trim(), requestId: id,
      });
      toast({ title: "Bankrekeningcorrectie verwerkt" });
      setOpen(false);
      setRequestId(null);
      window.dispatchEvent(new CustomEvent("bookassist:bank-correction-success", { detail: { transactionId: transaction.id } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safeMessage = message.length > 0 && message.length <= 500 && !/https?:\/\/|stack|postgres|supabase|schema|function|relation|permission denied/i.test(message)
        ? message
        : "Controleer de actuele boekingsstatus en probeer pas daarna opnieuw.";
      toast({ title: "Correctie niet uitgevoerd", description: safeMessage, variant: "destructive" });
    }
  };

  if (open && posting?.posting_group_id !== openedPostingGroupId) {
    // Fail closed if another user changed the posting marker during editing.
    return <p role="alert">Deze bankboeking is gewijzigd. Sluit en open de details opnieuw.</p>;
  }

  return <>
    <Button size="sm" variant="outline" className="w-full" onClick={async () => {
      // Snapshot the concurrency token before loading VAT. The RPC must never use a newer marker with an older form.
      const currentMarker = await refetchPosting();
      const groupId = currentMarker.data?.posting_group_id;
      if (currentMarker.isError || !groupId || !transaction.organization_id) {
        toast({ title: "Boeking niet actueel", description: "Laad de banktransactie opnieuw.", variant: "destructive" });
        return;
      }
      // The parent allocation cache may still be loading; verify independently before exposing the correction.
      const { data: linkedAllocations, error: allocationsError } = await supabase
        .from("bank_transaction_allocations")
        .select("id")
        .eq("bank_transaction_id", transaction.id)
        .limit(1);
      if (allocationsError || !linkedAllocations || linkedAllocations.length > 0) {
        toast({ title: "Factuurkoppelingen niet gecontroleerd", description: "Controleer de afletteringen voordat je deze boeking corrigeert.", variant: "destructive" });
        return;
      }
      const { data, error } = await supabase.from("bank_transactions")
        .select("btw_percentage").eq("id", transaction.id).eq("organization_id", transaction.organization_id).single();
      if (error || !data) {
        toast({ title: "Actuele BTW niet beschikbaar", description: "Laad de banktransactie opnieuw voordat je corrigeert.", variant: "destructive" });
        return;
      }
      // Detect a concurrent correction during VAT load, rather than combining incompatible snapshots.
      const confirmed = await refetchPosting();
      if (confirmed.isError || confirmed.data?.posting_group_id !== groupId) {
        toast({ title: "Boeking is ondertussen gewijzigd", description: "Open de correctie opnieuw.", variant: "destructive" });
        return;
      }
      setOpenedPostingGroupId(groupId);
      setAccountId(""); setAccountLabel(""); setVat(String(data.btw_percentage ?? 0));
      setReason(""); setRequestId(null); setOpen(true);
    }}>Rekening wijzigen</Button>
    <Dialog open={open} onOpenChange={v => { if (!correction.isPending) setOpen(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bankboeking corrigeren</DialogTitle>
          <DialogDescription>De bestaande boeking wordt met audittrail tegengeboekt en op de gekozen rekening opnieuw geboekt. Controleer rekening en BTW.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label>Nieuwe grootboekrekening</Label>
          <GrootboekCombobox value={accountLabel} onValueChange={setAccountLabel} onIdChange={setAccountId} clientId={transaction.client_id} />
          <Label htmlFor="correction-vat">BTW-percentage</Label>
          <select id="correction-vat" className="w-full rounded-md border p-2" value={vat} onChange={e => setVat(e.target.value)}>
            <option value="0">0%</option><option value="9">9%</option><option value="21">21%</option>
          </select>
          <Label htmlFor="correction-reason">Reden (verplicht)</Label>
          <Input id="correction-reason" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={correction.isPending}>Annuleren</Button>
          <Button onClick={submit} disabled={correction.isPending || !openedPostingGroupId || !accountId || !reason.trim() || reason.trim().length > 500}>{correction.isPending ? "Verwerken…" : "Correctie bevestigen"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
