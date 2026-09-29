import { useRef, useState } from "react";
import { History, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { AuditTrailBlock } from "@/components/platform/AuditTrailBlock";
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  useCanSetPostingLock,
  usePostingLockEvents,
  usePostingLockState,
  useSetPostingLock,
} from "@/hooks/usePostingLock";
import { formatDatumNL } from "@/lib/opening-balance-utils";
import {
  CHANGE_ACTION_LABEL,
  CLEAR_ACTION_LABEL,
  CLEAR_DOES_NOT_REOPEN_NOTE,
  INCONSISTENT_LOCK_ADVICE,
  INDEPENDENCE_NOTE,
  LOCK_CHANGE_HEADLINE,
  LOCK_DATE_MAX,
  LOCK_DATE_MIN,
  LOCK_REASON_MAX_LENGTH,
  REOPEN_DOES_NOT_CLEAR_NOTE,
  SET_ACTION_LABEL,
  asClassifiedPostingLockError,
  isRelaxation,
  lockAvailability,
  lockChangeConsequences,
  lockChangeKind,
  lockEventEntries,
  lockExplanation,
  lockLabel,
  needsLockReconciliation,
  validateLockDate,
  validateLockReason,
  type ClassifiedPostingLockError,
} from "@/lib/posting-lock";

/**
 * De boekingsblokkade — een EIGEN besturingselement, naast (niet binnen) de
 * boekjaarstatus.
 *
 * Wat hier kan: de huidige blokkadedatum zien, de geschiedenis lezen, en —
 * als accountant — de blokkade instellen, verschuiven of opheffen via de ene
 * schrijver `set_posting_lock()`. Wat hier niet kan en niet staat: iets aan de
 * boekjaarstatus veranderen. Deze kaart roept geen afsluit- of heropenactie
 * aan, en haar teksten zeggen expliciet dat de twee los van elkaar staan.
 *
 * FAIL CLOSED. Spreekt de stand de geschiedenis tegen, is een van beide niet
 * te lezen, of loopt er nog een verzoening na een onbekende afloop, dan wordt
 * er niets aangeboden.
 */

type DialogMode = "set" | "change" | "clear";

const DIALOG_TITLE: Record<DialogMode, string> = {
  set: SET_ACTION_LABEL,
  change: CHANGE_ACTION_LABEL,
  clear: CLEAR_ACTION_LABEL,
};

export function PostingLockCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const stateQuery = usePostingLockState(clientId);
  const eventsQuery = usePostingLockEvents(clientId);
  const { data: canSet, isError: roleError } = useCanSetPostingLock();
  const setLock = useSetPostingLock();

  /** Synchrone grendel tegen een dubbelklik binnen één tick. */
  const inFlight = useRef(false);
  /**
   * Zichtbare grendel over de HELE handeling: aanroep, de verversing daarna en
   * een eventuele verzoening. `setLock.isPending` alleen is niet genoeg: na een
   * fout wordt de mutatie al als afgerond gemeld terwijl de verversing nog
   * loopt, en dan zou de knop er klikbaar uitzien zonder iets te doen.
   */
  const [bezig, setBezig] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [fout, setFout] = useState<ClassifiedPostingLockError | null>(null);
  const [mededeling, setMededeling] = useState<string | null>(null);

  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [datum, setDatum] = useState("");
  const [reden, setReden] = useState("");

  const huidig = stateQuery.data;
  const gebeurtenissen = eventsQuery.data;

  const beschikbaarheid = lockAvailability({
    lockedThrough: huidig,
    stateUnavailable: stateQuery.isError,
    events: gebeurtenissen,
    eventsUnavailable: eventsQuery.isError,
    canSet,
    roleUnavailable: roleError,
    reconciling: reconciling || bezig,
  });

  const openDialog = (mode: DialogMode) => {
    setDialog(mode);
    setDatum(mode === "change" && huidig ? huidig : "");
    setReden("");
  };

  const resetDialog = () => {
    setDialog(null);
    setDatum("");
    setReden("");
  };

  const sluitDialog = () => {
    if (bezig) return;
    resetDialog();
  };

  // ── De dialoog ────────────────────────────────────────────────────────────
  const datumToets = validateLockDate(datum);
  const redenToets = validateLockReason(reden);
  /** `undefined` = nog geen geldige nieuwe waarde gekozen. */
  const nieuw: string | null | undefined =
    dialog === "clear" ? null : datumToets.ok ? datumToets.date : undefined;
  const soort = nieuw === undefined || huidig === undefined ? undefined : lockChangeKind(huidig, nieuw);
  const versoepeling = soort !== undefined && isRelaxation(soort);
  const gevolgen = soort !== undefined && huidig !== undefined ? lockChangeConsequences(huidig, nieuw!) : [];

  const bevestigUit =
    beschikbaarheid.kind !== "available" ||
    soort === undefined ||
    soort === "unchanged" ||
    !redenToets.ok;

  const voerUit = async () => {
    if (inFlight.current || bezig || setLock.isPending || reconciling) return;
    if (nieuw === undefined || soort === undefined || soort === "unchanged" || !redenToets.ok) return;
    inFlight.current = true;
    setBezig(true);
    setFout(null);
    setMededeling(null);
    try {
      const result = await setLock.mutateAsync({ clientId, lockedThrough: nieuw, reason: redenToets.reason });
      resetDialog();
      if (!result.changed) {
        setMededeling("De boekingsblokkade stond al op deze waarde; er is niets gewijzigd en niets vastgelegd.");
        toast({ title: "Boekingsblokkade ongewijzigd" });
        return;
      }
      toast({
        title:
          result.locked_through === null
            ? "Boekingsblokkade opgeheven"
            : `Boekingen geblokkeerd t/m ${formatDatumNL(result.locked_through)}`,
      });
    } catch (error) {
      const classified = asClassifiedPostingLockError(error);
      resetDialog();
      if (!needsLockReconciliation(classified.kind)) {
        setFout(classified);
        toast({ title: "Wijzigen niet gelukt", description: classified.message, variant: "destructive" });
        return;
      }
      // Onbekende afloop: eerst kijken wat er staat. Tot dat bekend is, wordt
      // er niets aangeboden (zie `reconciling` in lockAvailability) en nooit
      // automatisch opnieuw geprobeerd.
      setReconciling(true);
      try {
        const [stand] = await Promise.all([stateQuery.refetch(), eventsQuery.refetch()]);
        if (!stand.isError && stand.data === nieuw) {
          setMededeling("De verbinding viel weg, maar de wijziging blijkt wel te zijn doorgevoerd. De actuele stand staat hierboven.");
          toast({ title: "Wijziging blijkt doorgevoerd" });
        } else {
          setFout(classified);
          toast({ title: "Wijzigen niet gelukt", description: classified.message, variant: "destructive" });
        }
      } finally {
        setReconciling(false);
      }
    } finally {
      inFlight.current = false;
      setBezig(false);
    }
  };

  // ── De kaart ──────────────────────────────────────────────────────────────
  const geladen = huidig !== undefined;
  const badgeTekst = !geladen ? "Wordt geladen…" : huidig === null ? "Geen blokkade" : `t/m ${formatDatumNL(huidig)}`;

  return (
    <Card data-testid="boekingsblokkade-card">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Boekingsblokkade</h2>
          </div>
          <Badge
            variant={!geladen || huidig === null ? "secondary" : "warning"}
            data-testid="blokkade-status-badge"
            data-locked={!geladen ? "unknown" : huidig === null ? "false" : "true"}
          >
            {badgeTekst}
          </Badge>
        </div>

        {geladen && (
          <div className="space-y-1">
            <p className="text-sm font-medium" data-testid="blokkade-stand">
              {lockLabel(huidig)}
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground" data-testid="blokkade-uitleg">
              {lockExplanation(huidig).map((regel) => (
                <li key={regel}>{regel}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground" data-testid="blokkade-los-van-boekjaar">
          {INDEPENDENCE_NOTE} {REOPEN_DOES_NOT_CLEAR_NOTE} {CLEAR_DOES_NOT_REOPEN_NOTE}
        </p>

        {beschikbaarheid.kind === "inconsistent" && (
          <AccountingNotice severity="blocking" title="Boekingsblokkade klopt niet" data-testid="blokkade-inconsistent">
            <p>{beschikbaarheid.reason}</p>
            <p className="mt-1">{INCONSISTENT_LOCK_ADVICE}</p>
          </AccountingNotice>
        )}

        {fout !== null && (
          <AccountingNotice
            severity="blocking"
            title="Wijzigen niet gelukt"
            data-testid="blokkade-fout"
            data-kind={fout.kind}
          >
            <p>{fout.message}</p>
            {fout.advice !== undefined && <p className="mt-1">{fout.advice}</p>}
          </AccountingNotice>
        )}

        {mededeling !== null && (
          <AccountingNotice severity="info" data-testid="blokkade-mededeling">
            {mededeling}
          </AccountingNotice>
        )}

        <div className="border-t pt-3">
          {beschikbaarheid.kind === "available" ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {huidig === null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => openDialog("set")}
                  disabled={setLock.isPending}
                  data-testid="blokkade-instellen"
                >
                  {SET_ACTION_LABEL}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => openDialog("change")}
                    disabled={setLock.isPending}
                    data-testid="blokkade-wijzigen"
                  >
                    {CHANGE_ACTION_LABEL}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-destructive/50 text-destructive hover:text-destructive sm:w-auto"
                    onClick={() => openDialog("clear")}
                    disabled={setLock.isPending}
                    data-testid="blokkade-opheffen"
                  >
                    {CLEAR_ACTION_LABEL}
                  </Button>
                </>
              )}
            </div>
          ) : beschikbaarheid.kind === "inconsistent" ? null : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="blokkade-geen-actie"
              data-kind={beschikbaarheid.kind}
            >
              {beschikbaarheid.reason}
            </p>
          )}
        </div>

        <section className="space-y-2 border-t pt-3" aria-labelledby="blokkade-historie" data-testid="blokkade-historie">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 id="blokkade-historie" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Historie boekingsblokkade{gebeurtenissen ? ` (${gebeurtenissen.length})` : ""}
            </h3>
          </div>
          {eventsQuery.isError ? (
            <AccountingNotice severity="blocking" title="Historie niet geladen" data-testid="blokkade-historie-fout">
              De geschiedenis van de boekingsblokkade kon niet worden opgehaald. Ververs de pagina; er is hierover
              niets vastgesteld.
            </AccountingNotice>
          ) : gebeurtenissen && gebeurtenissen.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
              Er is nog geen wijziging van de boekingsblokkade vastgelegd.
            </p>
          ) : gebeurtenissen ? (
            <ol className="space-y-2" data-testid="blokkade-gebeurtenissen">
              {gebeurtenissen.map((event, index) => (
                <li
                  key={event.id}
                  className="rounded-md border px-3 py-2"
                  data-testid="blokkade-gebeurtenis"
                  data-index={index}
                >
                  <AuditTrailBlock entries={lockEventEntries(event, user?.id)} />
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </CardContent>

      <FinancialActionDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) sluitDialog();
        }}
        title={dialog === null ? "" : DIALOG_TITLE[dialog]}
        explanation={
          dialog === "clear"
            ? `U heft de boekingsblokkade van ${clientName} op. ${CLEAR_DOES_NOT_REOPEN_NOTE}`
            : `U kiest de datum t/m wanneer boekingen voor ${clientName} worden geblokkeerd. ${INDEPENDENCE_NOTE}`
        }
        consequences={gevolgen}
        confirmLabel={soort && soort !== "unchanged" ? LOCK_CHANGE_HEADLINE[soort] : dialog === null ? "" : DIALOG_TITLE[dialog]}
        pendingLabel="Bezig met opslaan…"
        /* Versoepelen en opheffen halen financiële bescherming weg: rood.
           Instellen en uitbreiden voegen bescherming toe: de gewone knop. */
        intent={versoepeling ? "destructive" : "normal"}
        isPending={bezig || setLock.isPending}
        confirmDisabled={bevestigUit}
        onConfirm={voerUit}
        data-testid="blokkade-dialoog"
        confirmTestId="blokkade-bevestigen"
        cancelTestId="blokkade-annuleren"
        consequencesTestId="blokkade-gevolgen"
      >
        <div className="space-y-3">
          {dialog !== "clear" && (
            <div className="space-y-1">
              <Label htmlFor="blokkade-datum">Blokkeren t/m</Label>
              <Input
                id="blokkade-datum"
                type="date"
                min={LOCK_DATE_MIN}
                max={LOCK_DATE_MAX}
                value={datum}
                onChange={(e) => setDatum(e.target.value)}
                className="w-48"
                data-testid="blokkade-datum"
              />
              {datum !== "" && datumToets.ok === false && (
                <p className="text-xs text-destructive" data-testid="blokkade-datum-toets">
                  {datumToets.message}
                </p>
              )}
              {soort === "unchanged" && (
                <p className="text-xs text-muted-foreground" data-testid="blokkade-datum-ongewijzigd">
                  Dit is de huidige blokkadedatum; kies een andere datum.
                </p>
              )}
            </div>
          )}

          {versoepeling && (
            <AccountingNotice
              severity="warning"
              title={soort === "clear" ? "U heft een financiële bescherming op" : "U versoepelt een financiële bescherming"}
              data-testid="blokkade-versoepeling"
              data-kind={soort}
            >
              Na deze wijziging kunnen boekingen die nu geweigerd worden weer worden gedaan, voor zover geen andere
              controle ze tegenhoudt. Doe dit alleen met een concrete reden.
            </AccountingNotice>
          )}

          <div className="space-y-1">
            <Label htmlFor="blokkade-reden">Reden</Label>
            <Textarea
              id="blokkade-reden"
              value={reden}
              onChange={(e) => setReden(e.target.value)}
              placeholder="Bijvoorbeeld: aangifte ingediend t/m dit kwartaal"
              required
              aria-invalid={reden !== "" && !redenToets.ok}
              data-testid="blokkade-reden"
            />
            <p
              className={`text-xs ${redenToets.ok ? "text-muted-foreground" : "text-destructive"}`}
              data-testid="blokkade-reden-toets"
              data-ok={redenToets.ok ? "true" : "false"}
            >
              {redenToets.ok === false
                ? redenToets.message
                : `${redenToets.reason.length} van maximaal ${LOCK_REASON_MAX_LENGTH} tekens. De reden wordt onuitwisbaar vastgelegd.`}
            </p>
          </div>
        </div>
      </FinancialActionDialog>
    </Card>
  );
}
