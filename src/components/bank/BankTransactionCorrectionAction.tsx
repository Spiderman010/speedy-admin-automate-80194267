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
  const { data: posting, isPending: loading, isError } = useBankTransactionPosting(transaction.id);
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

  // Until the marker is known, fail closed. Invoice-linked transactions are excluded in v1.1.
  if (loading || isError || allocationCount > 0) return null;
  if (!posting || transaction.match_status !== "handmatig_geboekt" || canCorrect !== true) return null;

  const submit = async () => {
    if (!accountId || !reason.trim() || reason.trim().length > 500 || correction.isPending) return;
    const id = requestId ?? crypto.randomUUID();
    if (!requestId) setRequestId(id); // Retain idempotency key on retry.
    try {
      await correction.mutateAsync({
        transactionId: transaction.id,
        expectedPostingGroupId: posting.posting_group_id,
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

  return <>
    <Button size="sm" variant="outline" className="w-full" onClick={() => { setAccountId(""); setAccountLabel(""); setVat(String(transaction.btw_percentage ?? 0)); setReason(""); setRequestId(null); setOpen(true); }}>Rekening wijzigen</Button>
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
          <Button onClick={submit} disabled={correction.isPending || !accountId || !reason.trim() || reason.trim().length > 500}>{correction.isPending ? "Verwerken…" : "Correctie bevestigen"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
