import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CalendarCheck, ChevronRight, History, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { AuditTrailBlock } from "@/components/platform/AuditTrailBlock";
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";
import { PostingLockCard } from "@/components/overzichten/PostingLockCard";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useYearCloseSources } from "@/hooks/useYearCloseSources";
import {
  useCanCloseFiscalYear,
  useCloseFiscalYear,
  useFiscalYearEvents,
  useReopenFiscalYear,
  useYearClosure,
} from "@/hooks/useYearClose";
import { recentYears } from "@/lib/grootboek-saldi-utils";
import type { DiagnosticSeverity } from "@/lib/accounting-diagnostics";
import {
  ALREADY_CLOSED_NOTICE,
  CLOSED_EXPLANATION,
  CLOSED_HEADING,
  CLOSE_ACTION_LABEL,
  CLOSE_CONFIRM_LABEL,
  CLOSE_DIALOG_TITLE,
  CLOSE_PENDING_LABEL,
  INCONSISTENT_CLOSURE_ADVICE,
  closeAvailability,
  closeConsequences,
  closeDialogExplanation,
  asClassifiedYearCloseError,
  closureReceiptEntries,
  type ClassifiedYearCloseError,
  type YearClosure,
  type YearCloseResult,
} from "@/lib/year-close-action";
import {
  ALREADY_REOPENED_NOTICE,
  LIFECYCLE_STATUS_PRESENTATION,
  REASON_MAX_LENGTH,
  RECLOSE_ACTION_LABEL,
  REOPENED_EXPLANATION,
  REOPENED_HEADING,
  REOPEN_ACTION_LABEL,
  REOPEN_CONFIRM_LABEL,
  REOPEN_DIALOG_TITLE,
  REOPEN_PENDING_LABEL,
  asClassifiedReopenError,
  latestEvent,
  lifecycleEventEntries,
  lifecycleStatus,
  reopenAvailability,
  reopenConsequences,
  reopenDialogExplanation,
  validateReopenReason,
  type ClassifiedReopenError,
  type FiscalYearEvent,
  type ReopenResult,
} from "@/lib/year-close-lifecycle";
import {
  READINESS_SEVERITY_ORDER,
  evaluateYearClose,
  readinessChecksBySeverity,
  type ReadinessCheck,
  type YearCloseReadiness,
  type YearCloseStatus,
} from "@/lib/year-close-readiness";

/**
 * Jaarafsluiting — gereedheid (PR 1), definitief afsluiten (PR 2b) en de
 * levenscyclus: heropenen en opnieuw afsluiten (PR F, op de schrijvers van
 * PR E).
 *
 * TWEE VRAGEN, IN DEZE VOLGORDE. Eerst: *kan dit boekjaar verantwoord worden
 * afgesloten?* — beantwoord met de oordelen die er al zijn. Pas als het
 * antwoord `ready` is, en pas na een expliciete bevestiging, gaat er één
 * aanroep naar `public.close_fiscal_year()`. Heropenen kent geen gereedheid
 * maar wél een verplichte reden en dezelfde expliciete bevestiging; dan gaat
 * er één aanroep naar `public.reopen_fiscal_year()`.
 *
 * DEZE PAGINA REKENT NIET EN BESLIST NIET. Elke uitspraak komt uit
 * `evaluateYearClose()`; de status komt uit `year_closures.status` en de
 * historie uit `fiscal_year_events` — nooit uit rekeningnummers, boekingen of
 * het watermerk alleen. Het afsluiten en heropenen zelf doet de database, die
 * alles onder haar eigen grendel opnieuw keurt.
 *
 * DE BOEKINGSBLOKKADE IS GEEN ONDERDEEL VAN DE BOEKJAARSTATUS. Afsluiten en
 * heropenen zetten of wissen `posting_locked_through` nooit, deze pagina roept
 * `set_posting_lock()` nooit aan, en er staat nergens dat heropenen "de
 * periode weer openzet". De blokkade heeft een eigen kaart
 * (`PostingLockCard`) met een eigen hook, een eigen schrijver en een eigen
 * geschiedenis; deze pagina geeft haar alleen de administratie door.
 *
 * ER WORDT GEEN BEDRAG GETOOND BIJ DE AFSLUITING. `year_closures` bewaart geen
 * resultaat, want er wordt geen resultaatboeking gemaakt; een berekening
 * erbij verzinnen zou een tweede boekhoudmotor zijn.
 *
 * De gereedheid is een MOMENTOPNAME: bij de klik wordt zij vastgezet en beweegt
 * daarna niet meer mee met de cache. Zij draagt de administratie en het
 * boekjaar waarvoor zij geldt, zodat zij bij een wissel verdwijnt in plaats van
 * mee te verhuizen.
 */

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  ok: "Akkoord",
  warning: "Waarschuwing",
  error: "Blokkade",
};

const SEVERITY_HEADING: Record<DiagnosticSeverity, string> = {
  error: "Blokkades",
  warning: "Waarschuwingen",
  ok: "Akkoord",
};

const SEVERITY_VARIANT: Record<DiagnosticSeverity, "destructive" | "warning" | "secondary"> = {
  error: "destructive",
  warning: "warning",
  ok: "secondary",
};

/** De vier statussen in woorden. Geen tweede ernstladder: een samenvatting. */
const STATUS_PRESENTATION: Record<
  YearCloseStatus,
  { label: string; severity: DiagnosticSeverity; uitleg: string }
> = {
  ready: {
    label: "Gereed voor afsluiten",
    severity: "ok",
    uitleg: "Elke controle is doorstaan. Er staat niets open dat het afsluiten in de weg zit.",
  },
  warning: {
    label: "Nog niet gereed",
    severity: "warning",
    uitleg:
      "Er staat open werk. Dit product kent geen regel die zegt dat een boekjaar met open werk toch mag worden afgesloten, dus dat wordt hier niet beweerd.",
  },
  blocked: {
    label: "Afsluiten geblokkeerd",
    severity: "error",
    uitleg: "Er is iets aan de hand dat afsluiten onverantwoord maakt. Los dat eerst op.",
  },
  incomplete: {
    label: "Controle niet volledig uitgevoerd",
    severity: "error",
    uitleg:
      "Niet elke bron kon worden gelezen. Dit is een technische storing en geen boekhoudkundige bevinding — over wat hier niet is gecontroleerd, is dus niets vastgesteld.",
  },
};

function Bevinding({ check }: { check: ReadinessCheck }) {
  return (
    <li
      className="rounded-md border px-3 py-2"
      data-testid="jaar-bevinding"
      data-check={check.id}
      data-severity={check.severity}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{check.title}</span>
        <Badge variant={SEVERITY_VARIANT[check.severity]} className="font-normal">
          {SEVERITY_LABEL[check.severity]}
        </Badge>
        {check.count !== undefined && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{check.count}×</span>
        )}
        {check.amountCents !== undefined && (
          <AccountingAmount cents={check.amountCents} className="ml-auto text-sm" />
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{check.summary}</p>
      {check.drilldown && (
        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" asChild>
          <Link to={check.drilldown.to} data-testid="jaar-drilldown">
            {check.drilldown.label}
            <ChevronRight className="ml-0.5 h-3 w-3" aria-hidden="true" />
          </Link>
        </Button>
      )}
    </li>
  );
}

function Telling({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-md border px-3 py-2" data-testid={testId}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Rapport({ readiness, clientName }: { readiness: YearCloseReadiness; clientName: string }) {
  const presentatie = STATUS_PRESENTATION[readiness.status];
  return (
    <div className="space-y-4" data-testid="jaar-rapport">
      <div>
        <h2 className="text-sm font-semibold">Jaarafsluiting {readiness.fiscalYear}</h2>
        <p className="text-sm text-muted-foreground" data-testid="jaar-context">{clientName}</p>
      </div>

      <AccountingNotice
        severity={presentatie.severity === "error" ? "blocking" : presentatie.severity === "warning" ? "warning" : "info"}
        title={presentatie.label}
        data-testid="jaar-status"
        data-status={readiness.status}
      >
        <p>{presentatie.uitleg}</p>
        {readiness.unavailable.length > 0 && (
          <p className="mt-1">Niet geladen: {readiness.unavailable.join(", ")}.</p>
        )}
      </AccountingNotice>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="jaar-telling">
        <Telling label="Uitgevoerd" value={readiness.summary.executed} testId="jaar-uitgevoerd" />
        <Telling label="Akkoord" value={readiness.summary.passed} testId="jaar-akkoord" />
        <Telling label="Waarschuwingen" value={readiness.summary.warnings} testId="jaar-waarschuwingen" />
        <Telling label="Blokkades" value={readiness.summary.blocking} testId="jaar-blokkades" />
      </dl>

      {READINESS_SEVERITY_ORDER.map((severity) => {
        const groep = readinessChecksBySeverity(readiness.checks, severity);
        if (groep.length === 0) return null;
        return (
          <section key={severity} aria-labelledby={`jaar-${severity}`} data-testid={`jaar-groep-${severity}`}>
            <h3 id={`jaar-${severity}`} className="mb-2 text-sm font-semibold">
              {SEVERITY_HEADING[severity]} ({groep.length})
            </h3>
            <ul className="space-y-2">
              {groep.map((check) => <Bevinding key={check.id} check={check} />)}
            </ul>
          </section>
        );
      })}

      {readiness.administrationWide.length > 0 && (
        <section aria-labelledby="jaar-breed" data-testid="jaar-groep-administratiebreed">
          <h3 id="jaar-breed" className="mb-1 text-sm font-semibold">
            Administratiebreed ({readiness.administrationWide.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground" data-testid="jaar-breed-uitleg">
            Deze bevindingen gelden voor de hele administratie en dragen geen boekjaar. Zij zijn
            daarom niet meegewogen in de gereedheid van {readiness.fiscalYear} — een bevinding uit een
            ander boekjaar bewijst niets over dit boekjaar — maar ze staan hier wel, want verzwijgen
            zou erger zijn.
          </p>
          <ul className="space-y-2">
            {readiness.administrationWide.map((check) => <Bevinding key={check.id} check={check} />)}
          </ul>
        </section>
      )}

    </div>
  );
}

/**
 * Het afsluitbewijs op het scherm.
 *
 * Er staat GEEN bedrag op. `year_closures` bewaart geen `result_cents` — dat is
 * een bewuste keuze van PR 2a — dus er valt niets te tonen dat "het
 * afsluitresultaat" zou heten, en het hier alsnog uitrekenen zou precies de
 * tweede boekhoudmotor opleveren die daar is vermeden.
 */
function Afsluitbewijs({
  closure,
  clientName,
  currentUserId,
  hergebruikt,
}: {
  closure: YearClosure;
  clientName: string;
  currentUserId: string | undefined;
  /** De aanroep vond een bestaand bewijs in plaats van er een te maken. */
  hergebruikt: boolean;
}) {
  return (
    <div className="space-y-2" data-testid="jaar-afsluitbewijs">
      <AccountingNotice
        severity="info"
        title={`${CLOSED_HEADING} ${closure.fiscal_year}`}
        data-testid="jaar-afgesloten"
      >
        <p>{CLOSED_EXPLANATION}</p>
        {hergebruikt && <p className="mt-1" data-testid="jaar-al-afgesloten">{ALREADY_CLOSED_NOTICE}</p>}
      </AccountingNotice>
      {/* Geen `fallback`: een niet-vastgelegde of niet veilig te benoemen
          waarde krijgt geen plaatsvervanger maar verdwijnt. Zie
          closureReceiptEntries() voor waarom dat bij `closed_by` de enige
          eerlijke optie is. */}
      <AuditTrailBlock
        entries={closureReceiptEntries({ closure, clientName, currentUserId })}
        className="rounded-md border px-3 py-2"
      />
    </div>
  );
}

/**
 * De heropening op het scherm: de laatste `reopened`-gebeurtenis, met haar
 * reden. Er wordt niets uit een andere bron aangevuld.
 */
function Heropeningsbewijs({
  event,
  fiscalYear,
  currentUserId,
  hergebruikt,
}: {
  event: FiscalYearEvent | null;
  fiscalYear: number;
  currentUserId: string | undefined;
  /** De aanroep vond het jaar al heropend. */
  hergebruikt: boolean;
}) {
  return (
    <div className="space-y-2" data-testid="jaar-heropeningsbewijs">
      <AccountingNotice
        severity="warning"
        title={`${REOPENED_HEADING} ${fiscalYear}`}
        data-testid="jaar-heropend"
      >
        <p>{REOPENED_EXPLANATION}</p>
        {hergebruikt && <p className="mt-1" data-testid="jaar-al-heropend">{ALREADY_REOPENED_NOTICE}</p>}
      </AccountingNotice>
      {event !== null && (
        <AuditTrailBlock
          entries={lifecycleEventEntries(event, currentUserId).filter((e) => e.label !== "Gebeurtenis")}
          className="rounded-md border px-3 py-2"
        />
      )}
    </div>
  );
}

/**
 * De levensloop: elke gebeurtenis, oudste eerst. Precies wat in
 * `fiscal_year_events` staat — geen samengevoegde of verzonnen regels.
 */
function Levensloop({
  events,
  currentUserId,
}: {
  events: readonly FiscalYearEvent[];
  currentUserId: string | undefined;
}) {
  return (
    <ol className="space-y-2" data-testid="jaar-gebeurtenissen">
      {events.map((event, index) => (
        <li
          key={event.id}
          className="rounded-md border px-3 py-2"
          data-testid="jaar-gebeurtenis"
          data-event-type={event.event_type}
          data-index={index}
        >
          <AuditTrailBlock entries={lifecycleEventEntries(event, currentUserId)} />
        </li>
      ))}
    </ol>
  );
}

function BoekjaarstatusCard({
  fiscalYear,
  bewijs,
  laatsteHeropening,
  clientName,
  currentUserId,
  afsluiten,
  heropenen,
  closePending,
  reopenPending,
  onClose,
  onReopen,
}: {
  fiscalYear: number;
  bewijs: YearClosure | null;
  laatsteHeropening: FiscalYearEvent | null;
  clientName: string;
  currentUserId: string | undefined;
  afsluiten: ReturnType<typeof closeAvailability>;
  heropenen: ReturnType<typeof reopenAvailability>;
  closePending: boolean;
  reopenPending: boolean;
  onClose: () => void;
  onReopen: () => void;
}) {
  const status = lifecycleStatus(bewijs);
  const presentatie = LIFECYCLE_STATUS_PRESENTATION[status];

  const statusEntries =
    status === "closed" && bewijs !== null
      ? closureReceiptEntries({ closure: bewijs, clientName, currentUserId })
          .filter((entry) => entry.label === "Afgesloten op" || entry.label === "Afgesloten door")
          .map(({ label, value, valueClassName }) => ({ label, value, valueClassName }))
      : status === "reopened" && laatsteHeropening !== null
        ? lifecycleEventEntries(laatsteHeropening, currentUserId)
            .filter((entry) => entry.label === "Tijdstip" || entry.label === "Door" || entry.label === "Reden")
            .map(({ label, value, valueClassName }) => ({
              label: label === "Tijdstip" ? "Heropend op" : label === "Door" ? "Heropend door" : label,
              value,
              valueClassName,
            }))
        : [];

  return (
    <Card data-testid="jaar-status-card">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Boekjaarstatus</h2>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{fiscalYear}</p>
          </div>
          <Badge variant={presentatie.variant} data-testid="jaar-status-badge" data-status={status}>
            {presentatie.label}
          </Badge>
        </div>

        {statusEntries.length > 0 && (
          <AuditTrailBlock entries={statusEntries} className="border-t pt-3" data-testid="jaar-status-details" />
        )}

        {status === "closed" ? (
          <div className="space-y-2 border-t pt-3">
            {heropenen.kind === "available" ? (
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={onReopen}
                disabled={reopenPending}
                data-testid="jaar-heropenen"
              >
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                {REOPEN_ACTION_LABEL}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" className="w-full sm:w-auto" disabled>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                  {REOPEN_ACTION_LABEL}
                </Button>
                {heropenen.kind !== "not_closed" && heropenen.kind !== "already_reopened" && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="jaar-geen-heropening"
                    data-kind={heropenen.kind}
                  >
                    {heropenen.reason}
                  </p>
                )}
              </>
            )}
          </div>
        ) : afsluiten.kind === "available" ? (
          <div className="space-y-3 border-t pt-3">
            {status === "reopened" && (
              <AccountingNotice severity="warning" data-testid="jaar-heropend-hint">
                Dit boekjaar is heropend. Opnieuw afsluiten doorloopt dezelfde volledige controle als een
                eerste afsluiting.
              </AccountingNotice>
            )}
            <Button
              type="button"
              onClick={onClose}
              disabled={closePending}
              data-testid="jaar-afsluiten"
            >
              {status === "reopened" ? RECLOSE_ACTION_LABEL : CLOSE_ACTION_LABEL}
            </Button>
          </div>
        ) : (
          <div className="border-t pt-3">
            <Button type="button" disabled className="w-full sm:w-auto">
              {status === "reopened" ? RECLOSE_ACTION_LABEL : "Boekjaar afsluiten"}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {afsluiten.kind === "no_snapshot"
                ? "Voer eerst de gereedheidscontrole uit."
                : "Afsluiten is pas beschikbaar zodra de gereedheidscontrole akkoord is."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Jaarafsluiting() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [fiscalYear, setFiscalYear] = useState(() => new Date().getFullYear() - 1);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const sources = useYearCloseSources({
    clientId,
    fiscalYear,
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled && hasSpecificClient,
  });

  const closureQuery = useYearClosure(clientId, fiscalYear, orgEnabled && hasSpecificClient);
  const eventsQuery = useFiscalYearEvents(clientId, fiscalYear, orgEnabled && hasSpecificClient);
  /** Eén rolvloer voor beide handelingen: accountant, via `has_min_role()`. */
  const { data: isAccountant, isError: roleError } = useCanCloseFiscalYear();
  const close = useCloseFiscalYear();
  const reopen = useReopenFiscalYear();
  const { user } = useAuth();
  const { toast } = useToast();

  /**
   * De synchrone grendel. `close.isPending` en de `disabled` op de knop worden
   * pas na een render waar; twee klikken binnen één tick zien die dus allebei
   * nog op "uit" staan. Een ref is meteen waar en sluit dat af — nog vóór de
   * eerste render. Zelfde patroon als de tegenboeking (6C-b9). Eén grendel
   * voor afsluiten én heropenen: die twee mogen nooit tegelijk lopen.
   */
  const inFlight = useRef(false);

  /**
   * Elke schermtoestand draagt de administratie en het boekjaar waarvoor zij
   * is vastgesteld. Wisselt een van beide, dan hoort de oude uitspraak te
   * verdwijnen in plaats van mee te verhuizen: een gereedheid van 2025 zegt
   * niets over 2026, en het afsluitbewijs van klant A al helemaal niets over
   * klant B. Vergelijken bij het renderen in plaats van opruimen in een effect:
   * dan kan er geen tussenframe bestaan waarin het oude er nog staat.
   */
  const [snapshot, setSnapshot] = useState<
    { clientId: string; fiscalYear: number; readiness: YearCloseReadiness; clientName: string } | null
  >(null);
  const [uitkomst, setUitkomst] = useState<
    { clientId: string; fiscalYear: number; result: YearCloseResult } | null
  >(null);
  const [fout, setFout] = useState<
    { clientId: string; fiscalYear: number; classified: ClassifiedYearCloseError } | null
  >(null);
  const [heropenUitkomst, setHeropenUitkomst] = useState<
    { clientId: string; fiscalYear: number; result: ReopenResult } | null
  >(null);
  const [heropenFout, setHeropenFout] = useState<
    { clientId: string; fiscalYear: number; classified: ClassifiedReopenError } | null
  >(null);
  const [bevestigen, setBevestigen] = useState(false);
  const [heropenDialoog, setHeropenDialoog] = useState(false);
  const [heropenReden, setHeropenReden] = useState("");

  const past = (s: { clientId: string; fiscalYear: number } | null) =>
    s !== null && s.clientId === clientId && s.fiscalYear === fiscalYear;

  const huidigeSnapshot = past(snapshot) ? snapshot : null;
  const huidigeUitkomst = past(uitkomst) ? uitkomst : null;
  const huidigeHeropenUitkomst = past(heropenUitkomst) ? heropenUitkomst : null;

  const closure = closureQuery.data ?? null;
  /** Het bewijs uit de database wint; de RPC-uitkomst is het vangnet vóór de verversing. */
  const bewijs: YearClosure | null = closure ?? huidigeUitkomst?.result ?? null;
  const status = lifecycleStatus(bewijs);
  /** Zodra het jaar dicht is, is een afsluitfout achterhaald — wat er ook eerder misging. */
  const huidigeFout = past(fout) && status !== "closed" ? fout!.classified : null;
  /** En zodra het jaar heropend is, is een heropenfout achterhaald. */
  const huidigeHeropenFout = past(heropenFout) && status !== "reopened" ? heropenFout!.classified : null;

  const gebeurtenissen = eventsQuery.data ?? [];
  const laatsteHeropening = latestEvent(gebeurtenissen, "reopened");

  const afsluiten = closeAvailability({
    fiscalYear,
    readiness: huidigeSnapshot?.readiness ?? null,
    closure: bewijs,
    closurePending: closureQuery.isPending,
    closureUnavailable: closureQuery.isError,
    watermark: selectedClient?.afgesloten_boekjaar,
    canClose: isAccountant,
    roleUnavailable: roleError,
  });

  const heropenen = reopenAvailability({
    fiscalYear,
    closure: bewijs,
    closurePending: closureQuery.isPending,
    closureUnavailable: closureQuery.isError,
    watermark: selectedClient?.afgesloten_boekjaar,
    canReopen: isAccountant,
    roleUnavailable: roleError,
  });

  const redenToets = validateReopenReason(heropenReden);

  const clientNaam = selectedClient?.name ?? "—";
  const jaren = useMemo(() => recentYears(), []);

  const voerUit = () => {
    if (!clientId || !sources.input) return;
    setSnapshot({
      clientId,
      fiscalYear,
      readiness: evaluateYearClose({ ...sources.input, clientId, fiscalYear }),
      clientName: clientNaam,
    });
  };

  const sluitAf = async () => {
    if (!clientId || inFlight.current || close.isPending || reopen.isPending) return;
    inFlight.current = true;
    try {
      const result = await close.mutateAsync({ clientId, fiscalYear });
      setFout(null);
      setHeropenUitkomst(null);
      setUitkomst({ clientId, fiscalYear, result });
      setBevestigen(false);
      // De gereedheidsmomentopname gaat weg: zij beschrijft een toestand van
      // vóór de afsluiting en zou naast het afsluitbewijs onzin worden.
      setSnapshot(null);
      toast({
        title: result.created ? `Boekjaar ${fiscalYear} afgesloten` : "Boekjaar was al afgesloten",
        description: result.created ? undefined : ALREADY_CLOSED_NOTICE,
      });
    } catch (error) {
      const classified = asClassifiedYearCloseError(error);
      setFout({ clientId, fiscalYear, classified });
      setBevestigen(false);
      // Bij een onbekende afloop is `onSettled` de cache al aan het verversen.
      // Blijkt er dan tóch een dicht jaar te liggen, dan verdwijnt deze melding
      // vanzelf (zie `huidigeFout`) en staat het afsluitbewijs er in plaats
      // daarvan.
      const bevestigd = await closureQuery.refetch();
      if (bevestigd.data && lifecycleStatus(bevestigd.data) === "closed") {
        setFout(null);
        setUitkomst({ clientId, fiscalYear, result: { ...bevestigd.data, created: false } });
        setSnapshot(null);
        toast({ title: "Boekjaar was al afgesloten", description: ALREADY_CLOSED_NOTICE });
        return;
      }
      toast({ title: "Afsluiten niet gelukt", description: classified.message, variant: "destructive" });
    } finally {
      inFlight.current = false;
    }
  };

  const heropen = async () => {
    if (!clientId || inFlight.current || close.isPending || reopen.isPending) return;
    // De knop staat al uit bij een ongeldige reden; dit is de tweede grendel.
    if (!redenToets.ok) return;
    inFlight.current = true;
    try {
      const result = await reopen.mutateAsync({ clientId, fiscalYear, reason: redenToets.reason });
      setHeropenFout(null);
      setUitkomst(null);
      setHeropenUitkomst({ clientId, fiscalYear, result });
      setHeropenDialoog(false);
      setHeropenReden("");
      // De gereedheidsmomentopname beschreef een afgesloten jaar; na de
      // heropening moet zij opnieuw.
      setSnapshot(null);
      toast({
        title: result.reopened ? `Boekjaar ${fiscalYear} heropend` : "Boekjaar was al heropend",
        description: result.reopened ? undefined : ALREADY_REOPENED_NOTICE,
      });
    } catch (error) {
      const classified = asClassifiedReopenError(error);
      setHeropenFout({ clientId, fiscalYear, classified });
      setHeropenDialoog(false);
      // Zelfde verzoening als bij het afsluiten: eerst kijken wat er staat.
      const bevestigd = await closureQuery.refetch();
      if (bevestigd.data && lifecycleStatus(bevestigd.data) === "reopened") {
        setHeropenFout(null);
        setSnapshot(null);
        toast({ title: "Boekjaar was al heropend", description: ALREADY_REOPENED_NOTICE });
        return;
      }
      toast({ title: "Heropenen niet gelukt", description: classified.message, variant: "destructive" });
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <>
      <PageHeader
        title="Jaarafsluiting"
        description="Beoordeel de gereedheid, bekijk de boekjaarstatus en de historie, en sluit een boekjaar af of heropen het."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de gereedheid te bepalen." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Administratie en boekjaar" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <CalendarCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={String(fiscalYear)} onValueChange={(v) => setFiscalYear(Number(v))}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-40" aria-label="Boekjaar">
                  <span className="truncate">{fiscalYear}</span>
                </SelectTrigger>
                <SelectContent>
                  {jaren.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>

              <Button
                type="button"
                className="ml-auto h-9"
                onClick={voerUit}
                disabled={sources.isPending || !sources.input}
                data-testid="jaar-uitvoeren"
              >
                {sources.isPending ? "Bronnen laden…" : "Gereedheid controleren"}
              </Button>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <BoekjaarstatusCard
              fiscalYear={fiscalYear}
              bewijs={bewijs}
              laatsteHeropening={laatsteHeropening}
              clientName={clientNaam}
              currentUserId={user?.id}
              afsluiten={afsluiten}
              heropenen={heropenen}
              closePending={close.isPending}
              reopenPending={reopen.isPending}
              onClose={() => setBevestigen(true)}
              onReopen={() => setHeropenDialoog(true)}
            />
            {/* Een eigen besturingselement, met een eigen schrijver en een eigen
                geschiedenis. Het deelt niets met de boekjaarstatus hiernaast;
                de key laat haar bij een wissel van administratie opnieuw
                beginnen, zonder oude melding of dialoogtoestand. */}
            <PostingLockCard key={clientId} clientId={clientId!} clientName={clientNaam} />
          </div>

          <Card>
            <CardContent className="space-y-4 p-4 sm:p-6">
              <div>
                <h2 className="text-sm font-semibold">Gereedheid voor afsluiten</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Controleer het open werk en de boekhoudkundige aandachtspunten voor dit boekjaar.
                </p>
              </div>

              {huidigeSnapshot === null && status !== "closed" && huidigeFout === null && huidigeHeropenFout === null ? (
                <EmptyState
                  icon={CalendarCheck}
                  message="Er is nog geen gereedheidscontrole uitgevoerd. Kies een administratie en boekjaar en start de controle."
                />
              ) : null}

              {huidigeSnapshot !== null && (
                <Rapport readiness={huidigeSnapshot.readiness} clientName={huidigeSnapshot.clientName} />
              )}

              {huidigeFout !== null && (
                <AccountingNotice
                  severity="blocking"
                  title="Afsluiten niet gelukt"
                  data-testid="jaar-afsluitfout"
                  data-kind={huidigeFout.kind}
                >
                  {/* De melding komt uit `classifyYearCloseError()`, nooit
                      rechtstreeks uit het Supabase-object: daar zitten
                      SQLSTATE's, constraintnamen en details in die een
                      gebruiker niets zeggen en die hier niet horen. De
                      boekhoudkundige weigeringen van de database — open werk,
                      een ongebalanceerde groep, de volgorde, een heropend
                      ouder jaar — komen wél letterlijk door: dat is de
                      actie die de gebruiker moet ondernemen. */}
                  <p>{huidigeFout.message}</p>
                  {huidigeFout.advice !== undefined && (
                    <p className="mt-1" data-testid="jaar-afsluitadvies">{huidigeFout.advice}</p>
                  )}
                </AccountingNotice>
              )}

              {huidigeHeropenFout !== null && (
                <AccountingNotice
                  severity="blocking"
                  title="Heropenen niet gelukt"
                  data-testid="jaar-heropenfout"
                  data-kind={huidigeHeropenFout.kind}
                >
                  <p>{huidigeHeropenFout.message}</p>
                  {huidigeHeropenFout.advice !== undefined && (
                    <p className="mt-1" data-testid="jaar-heropenadvies">{huidigeHeropenFout.advice}</p>
                  )}
                </AccountingNotice>
              )}

              {afsluiten.kind === "inconsistent" && (
                <AccountingNotice
                  severity="blocking"
                  title="Afsluitstatus klopt niet"
                  data-testid="jaar-inconsistent"
                >
                  <p>{afsluiten.reason}</p>
                  <p className="mt-1">{INCONSISTENT_CLOSURE_ADVICE}</p>
                </AccountingNotice>
              )}

              {heropenen.kind === "inconsistent" && (
                <AccountingNotice
                  severity="blocking"
                  title="Afsluitstatus klopt niet"
                  data-testid="jaar-heropen-inconsistent"
                >
                  <p>{heropenen.reason}</p>
                  <p className="mt-1">{INCONSISTENT_CLOSURE_ADVICE}</p>
                </AccountingNotice>
              )}

              {(afsluiten.kind === "not_ready" ||
                afsluiten.kind === "not_allowed" ||
                afsluiten.kind === "unknown") && (
                <p
                  className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
                  data-testid="jaar-geen-actie"
                  data-kind={afsluiten.kind}
                >
                  {afsluiten.reason}
                </p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="jaar-historie">
            <CardContent className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Historie</h2>
              </div>

              {status === "closed" && bewijs !== null && (
                <Afsluitbewijs
                  closure={bewijs}
                  clientName={clientNaam}
                  currentUserId={user?.id}
                  hergebruikt={huidigeUitkomst?.result.created === false}
                />
              )}

              {status === "reopened" && (
                <Heropeningsbewijs
                  event={laatsteHeropening}
                  fiscalYear={fiscalYear}
                  currentUserId={user?.id}
                  hergebruikt={huidigeHeropenUitkomst?.result.reopened === false}
                />
              )}

              {status === "open" && gebeurtenissen.length === 0 && !eventsQuery.isError && (
                <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  Voor dit boekjaar is nog geen afsluiting vastgelegd.
                </p>
              )}

              {eventsQuery.isError && (
                <AccountingNotice severity="blocking" title="Historie niet geladen" data-testid="jaar-historie-fout">
                  De gebeurtenissen van dit boekjaar konden niet worden opgehaald. Ververs de pagina; er is
                  hierover niets vastgesteld.
                </AccountingNotice>
              )}

              {gebeurtenissen.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Levensloop ({gebeurtenissen.length})
                  </h3>
                  <Levensloop events={gebeurtenissen} currentUserId={user?.id} />
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Alle uitspraken komen uit opgeslagen grootboekmutaties en de bestaande boekhoudregels. Het afsluiten
            en heropenen zelf doet de database: zij keurt alles opnieuw en blijft de autoriteit.
          </p>

          <FinancialActionDialog
            open={bevestigen}
            onOpenChange={setBevestigen}
            title={CLOSE_DIALOG_TITLE}
            explanation={closeDialogExplanation(clientNaam, fiscalYear)}
            consequences={closeConsequences(fiscalYear)}
            confirmLabel={CLOSE_CONFIRM_LABEL}
            pendingLabel={CLOSE_PENDING_LABEL}
            /* Afsluiten verwijdert niets en herschrijft niets — het is een
               definitieve financiële handeling, geen destructieve. Vandaar de
               gewone primaire knop; zie de Platform Kit. */
            intent="normal"
            isPending={close.isPending}
            onConfirm={sluitAf}
            data-testid="jaar-bevestigen"
            confirmTestId="jaar-bevestig-knop"
            cancelTestId="jaar-annuleer-knop"
            consequencesTestId="jaar-gevolgen"
          />

          <FinancialActionDialog
            open={heropenDialoog}
            onOpenChange={(open) => {
              setHeropenDialoog(open);
              if (!open) setHeropenReden("");
            }}
            title={REOPEN_DIALOG_TITLE}
            explanation={reopenDialogExplanation(clientNaam, fiscalYear)}
            consequences={reopenConsequences(fiscalYear)}
            confirmLabel={REOPEN_CONFIRM_LABEL}
            pendingLabel={REOPEN_PENDING_LABEL}
            /* Heropenen haalt een bescherming weg. Het verwijdert niets, maar
               het is de ene handeling op dit scherm die bewust rood hoort te
               zijn: zie de Platform Kit over `intent`. */
            intent="destructive"
            isPending={reopen.isPending}
            confirmDisabled={!redenToets.ok}
            onConfirm={heropen}
            data-testid="jaar-heropenen-dialoog"
            confirmTestId="jaar-heropenen-bevestigen"
            cancelTestId="jaar-heropenen-annuleren"
            consequencesTestId="jaar-heropenen-gevolgen"
          >
            <div className="space-y-2">
              <Label htmlFor="jaar-heropenen-reden">Reden voor heropening</Label>
              <Textarea
                id="jaar-heropenen-reden"
                value={heropenReden}
                onChange={(event) => setHeropenReden(event.target.value)}
                placeholder="Bijvoorbeeld: nagekomen inkoopfactuur"
                required
                aria-invalid={!redenToets.ok && heropenReden !== ""}
                aria-describedby="jaar-heropenen-reden-toets"
                data-testid="jaar-heropenen-reden"
              />
              <p
                id="jaar-heropenen-reden-toets"
                className={`text-xs ${redenToets.ok ? "text-muted-foreground" : "text-destructive"}`}
                data-testid="jaar-heropenen-reden-toets"
                data-ok={redenToets.ok ? "true" : "false"}
              >
                {redenToets.ok === false
                  ? redenToets.message
                  : `${redenToets.reason.length} van maximaal ${REASON_MAX_LENGTH} tekens. De reden wordt onuitwisbaar vastgelegd.`}
              </p>
            </div>
          </FinancialActionDialog>
        </div>
      )}
    </>
  );
}
