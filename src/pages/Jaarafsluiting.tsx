import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { CalendarCheck, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { AuditTrailBlock } from "@/components/platform/AuditTrailBlock";
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useYearCloseSources } from "@/hooks/useYearCloseSources";
import {
  useCanCloseFiscalYear,
  useCloseFiscalYear,
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
  unresolvedWarnings,
  WARNINGS_HEADING,
  WARNINGS_NOTICE,
  type ClassifiedYearCloseError,
  type YearClosure,
  type YearCloseResult,
} from "@/lib/year-close-action";
import {
  READINESS_SEVERITY_ORDER,
  evaluateYearClose,
  readinessChecksBySeverity,
  type ReadinessCheck,
  type YearCloseReadiness,
  type YearCloseStatus,
} from "@/lib/year-close-readiness";

/**
 * Jaarafsluiting — gereedheid (PR 1) en definitief afsluiten (PR 2b).
 *
 * TWEE VRAGEN, IN DEZE VOLGORDE. Eerst: *kan dit boekjaar verantwoord worden
 * afgesloten?* — beantwoord met de oordelen die er al zijn. Pas als het
 * antwoord géén blokkade en géén onvolledige controle is, en pas na een
 * expliciete bevestiging, gaat er één aanroep naar
 * `public.close_fiscal_year()`.
 *
 * WAARSCHUWINGEN HOUDEN NIET TEGEN, MAAR VERDWIJNEN OOK NIET. Zij blijven
 * amber op de pagina staan én worden in de bevestigingsdialoog nog een keer
 * opgesomd, met de woorden waarmee de controle ze zelf heeft vastgesteld. Dat
 * is het hele overridemechanisme: er is geen verborgen vinkje en geen tweede
 * knop. Een blokkade en een onvolledige controle blijven fail-closed.
 *
 * DEZE PAGINA REKENT NIET EN BESLIST NIET. Elke uitspraak komt uit
 * `evaluateYearClose()`; het afsluiten zelf doet de database, die alles onder
 * haar eigen grendel opnieuw keurt en de financieel noodzakelijke
 * voorwaarden afdwingt.
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
    label: "Gereed, met openstaande waarschuwingen",
    severity: "warning",
    // Blijft nadrukkelijk amber. Dit is géén schone uitslag, en dat hoort te
    // blijven staan — maar het is ook geen blokkade: de waarschuwingen hier
    // zijn bevindingen die de databaseschrijver zelf niet tegenhoudt. De
    // gebruiker krijgt ze vóór het bevestigen nog een keer te zien.
    uitleg:
      "Er staan waarschuwingen open. Afsluiten kan, maar niet ongemerkt: u krijgt ze bij het bevestigen eerst te zien.",
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
  const { data: canClose, isError: roleError } = useCanCloseFiscalYear();
  const close = useCloseFiscalYear();
  const { user } = useAuth();
  const { toast } = useToast();

  /**
   * De synchrone grendel. `close.isPending` en de `disabled` op de knop worden
   * pas na een render waar; twee klikken binnen één tick zien die dus allebei
   * nog op "uit" staan. Een ref is meteen waar en sluit dat af — nog vóór de
   * eerste render. Zelfde patroon als de tegenboeking (6C-b9).
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
  const [bevestigen, setBevestigen] = useState(false);

  const past = (s: { clientId: string; fiscalYear: number } | null) =>
    s !== null && s.clientId === clientId && s.fiscalYear === fiscalYear;

  const huidigeSnapshot = past(snapshot) ? snapshot : null;
  const huidigeUitkomst = past(uitkomst) ? uitkomst : null;

  const closure = closureQuery.data ?? null;
  /** Het bewijs uit de database wint; de RPC-uitkomst is het vangnet vóór de verversing. */
  const bewijs: YearClosure | null = closure ?? huidigeUitkomst?.result ?? null;
  /** Zodra er bewijs ligt, is de mislukking achterhaald — wat er ook eerder misging. */
  const huidigeFout = past(fout) && bewijs === null ? fout!.classified : null;

  const beschikbaarheid = closeAvailability({
    fiscalYear,
    readiness: huidigeSnapshot?.readiness ?? null,
    closure: bewijs,
    closurePending: closureQuery.isPending,
    closureUnavailable: closureQuery.isError,
    watermark: selectedClient?.afgesloten_boekjaar,
    canClose,
    roleUnavailable: roleError,
  });

  /**
   * De waarschuwingen die de gebruiker vóór het bevestigen moet zien. Uit de
   * VASTGEZETTE momentopname, niet uit de live cache: de dialoog hoort precies
   * te tonen waarop de gebruiker zijn beslissing baseert.
   */
  const openstaandeWaarschuwingen = useMemo(
    () => (huidigeSnapshot === null ? [] : unresolvedWarnings(huidigeSnapshot.readiness)),
    [huidigeSnapshot],
  );

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
    if (!clientId || inFlight.current || close.isPending) return;
    inFlight.current = true;
    try {
      const result = await close.mutateAsync({ clientId, fiscalYear });
      setFout(null);
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
      // Blijkt er dan tóch bewijs te liggen, dan verdwijnt deze melding vanzelf
      // (zie `huidigeFout`) en staat het afsluitbewijs er in plaats daarvan.
      const bevestigd = await closureQuery.refetch();
      if (bevestigd.data) {
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

  return (
    <>
      <PageHeader
        title="Jaarafsluiting"
        description="Vaststellen of een boekjaar verantwoord kan worden afgesloten, en het daarna definitief afsluiten. De controle draait pas wanneer u erom vraagt."
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

          <Card>
            <CardContent className="space-y-4 p-4 sm:p-6">
              {huidigeSnapshot === null && bewijs === null && huidigeFout === null ? (
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
                      gebruiker niets zeggen en die hier niet horen. */}
                  <p>{huidigeFout.message}</p>
                  {huidigeFout.advice !== undefined && (
                    <p className="mt-1" data-testid="jaar-afsluitadvies">{huidigeFout.advice}</p>
                  )}
                </AccountingNotice>
              )}

              {bewijs !== null && (
                <Afsluitbewijs
                  closure={bewijs}
                  clientName={clientNaam}
                  currentUserId={user?.id}
                  hergebruikt={huidigeUitkomst?.result.created === false}
                />
              )}

              {beschikbaarheid.kind === "inconsistent" && (
                <AccountingNotice
                  severity="blocking"
                  title="Afsluitstatus klopt niet"
                  data-testid="jaar-inconsistent"
                >
                  <p>{beschikbaarheid.reason}</p>
                  <p className="mt-1">{INCONSISTENT_CLOSURE_ADVICE}</p>
                </AccountingNotice>
              )}

              {beschikbaarheid.kind === "available" && (
                <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                  <Button
                    type="button"
                    onClick={() => setBevestigen(true)}
                    disabled={close.isPending}
                    data-testid="jaar-afsluiten"
                  >
                    {CLOSE_ACTION_LABEL}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {beschikbaarheid.withWarnings
                      ? "Deze stap is definitief. U ziet de openstaande waarschuwingen nog vóór u bevestigt."
                      : "Deze stap is definitief en kan niet worden teruggedraaid."}
                  </span>
                </div>
              )}

              {(beschikbaarheid.kind === "not_ready" ||
                beschikbaarheid.kind === "not_allowed" ||
                beschikbaarheid.kind === "unknown") && (
                <p
                  className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
                  data-testid="jaar-geen-actie"
                  data-kind={beschikbaarheid.kind}
                >
                  {beschikbaarheid.reason}
                </p>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Alle uitspraken komen uit opgeslagen grootboekmutaties en de bestaande boekhoudregels. Het afsluiten
            zelf doet de database: zij keurt alles opnieuw en blijft de autoriteit.
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
          >
            {/*
              De openstaande waarschuwingen, letterlijk zoals de
              gereedheidscontrole ze heeft vastgesteld. Niets wordt hier
              opnieuw berekend, samengevat of weggelaten: dit zijn dezelfde
              titels en zinnen die ook op de pagina staan.

              DIT IS DE OVERRIDE, EN ER IS GEEN ANDERE. Er zit geen verborgen
              vinkje onder en geen tweede knop naast: afsluiten mét
              waarschuwingen kan alleen door ze eerst te lezen en dan
              hetzelfde ene bevestigknopje te gebruiken.
            */}
            {openstaandeWaarschuwingen.length > 0 && (
              <section
                className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/5 px-3 py-2"
                aria-labelledby="jaar-waarschuwingen-kop"
                data-testid="jaar-dialoog-waarschuwingen"
              >
                <h3 id="jaar-waarschuwingen-kop" className="text-sm font-semibold">
                  {WARNINGS_HEADING} ({openstaandeWaarschuwingen.length})
                </h3>
                <ul className="mt-1 space-y-1">
                  {openstaandeWaarschuwingen.map((check) => (
                    <li key={check.id} className="text-sm" data-testid="jaar-dialoog-waarschuwing" data-check={check.id}>
                      <span className="font-medium">{check.title}</span>
                      <span className="text-muted-foreground"> — {check.summary}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="jaar-waarschuwingen-uitleg">
                  {WARNINGS_NOTICE}
                </p>
              </section>
            )}
          </FinancialActionDialog>
        </div>
      )}
    </>
  );
}
