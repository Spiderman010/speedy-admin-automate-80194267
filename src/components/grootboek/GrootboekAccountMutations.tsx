import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ArrowUpRight, Layers } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import {
  formatLedgerAccountLabel,
  resolveLedgerSource,
  type LedgerRunningBalance,
} from "@/lib/ledger-reporting";
import { CATEGORY_LABELS, formatCents, formatDatumNL } from "@/lib/grootboek-saldi-utils";
import { LedgerPostingGroupSheet } from "./LedgerPostingGroupSheet";
import { reversalAwareSourceLabel, type ReversalAccountRef } from "@/lib/ledger-reversal-ui";

/**
 * Fase 6C-b7 PR 2 — mutaties van één rekening met lopend saldo.
 *
 * De volgorde komt uit buildRunningBalance() (posting_date, posting_group_id,
 * line_no, id) en wordt hier NIET opnieuw gesorteerd: een andere volgorde zou
 * het lopend saldo veranderen.
 *
 * 6C-b9 PR 2: elke regel hoort bij een boeking, en die boeking is hier aan te
 * wijzen. De knop "Boeking" opent het detailpaneel met de volledige
 * boekingsgroep en — voor een accountant, bij een ondersteunde bronsoort — de
 * correctieactie. Bewust geen nieuwe route: dit is een detail van wat er al
 * op het scherm staat.
 */

export interface GrootboekAccountMutationsProps {
  running: LedgerRunningBalance;
  periodLabel: string;
  /** Verplicht voor het boekingspaneel: RLS is organisatiebreed, niet per administratie. */
  clientId: string;
  /** Rekeningen om een regel bij naam te kunnen tonen in het paneel. */
  accountsById: ReadonlyMap<string, ReversalAccountRef>;
}

export function GrootboekAccountMutations({
  running,
  periodLabel,
  clientId,
  accountsById,
}: GrootboekAccountMutationsProps) {
  const a = running.account;
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const periodDebit = running.lines.reduce((s, l) => s + l.debitCents, 0);
  const periodCredit = running.lines.reduce((s, l) => s + l.creditCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="account-header">
        <span className="font-mono text-lg tabular-nums">{a.nummer ?? "—"}</span>
        <span className="font-display text-lg font-semibold">{a.omschrijving}</span>
        <Badge variant={a.categorie === "onbekend" ? "outline" : "secondary"} className="font-normal">
          {CATEGORY_LABELS[a.categorie]}
        </Badge>
        {!a.resolved && <Badge variant="outline" className="font-normal">Onbekende rekening</Badge>}
        {a.resolved && a.actief === false && <Badge variant="outline" className="font-normal">Inactief</Badge>}
        <span className="text-sm text-muted-foreground">· {periodLabel}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="account-summary">
        <Stat label="Beginsaldo" cents={running.openingCents} />
        <Stat label="Debet" cents={periodDebit} />
        <Stat label="Credit" cents={periodCredit} />
        <Stat label="Eindsaldo" cents={running.closingCents} emphasis />
      </dl>

      {running.lines.length === 0 ? (
        <EmptyState message="Geen mutaties op deze rekening in de gekozen periode." />
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <Table className="min-w-[840px]">
            <caption className="sr-only">
              Mutaties van {formatLedgerAccountLabel(a)} met lopend saldo (debet-positief)
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-28">Datum</TableHead>
                <TableHead scope="col">Omschrijving</TableHead>
                <TableHead scope="col" className="w-28">Bron</TableHead>
                <TableHead scope="col" className="w-32 text-right">Debet</TableHead>
                <TableHead scope="col" className="w-32 text-right">Credit</TableHead>
                <TableHead scope="col" className="w-36 text-right">Lopend saldo</TableHead>
                <TableHead scope="col" className="w-24 text-right">Actie</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="text-muted-foreground hover:bg-transparent" data-testid="mutation-opening">
                <TableCell colSpan={5}>Beginsaldo</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCents(running.openingCents)}</TableCell>
                <TableCell />
              </TableRow>
              {running.lines.map((l) => {
                const source = resolveLedgerSource(l.row.source_type, l.row.source_id);
                return (
                  <TableRow key={l.row.id} data-testid="mutation-row" data-source-type={l.row.source_type}>
                    <TableCell className="whitespace-nowrap">{formatDatumNL(l.row.posting_date)}</TableCell>
                    <TableCell className="max-w-[320px] truncate">{l.row.description || "—"}</TableCell>
                    <TableCell>
                      {/* Neutrale badge: kleur mag geen debet/credit suggereren. */}
                      <Badge variant="outline" className="font-normal">
                        {source.kind === "resolved" ? source.label : reversalAwareSourceLabel(l.row.source_type)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                      {l.debitCents !== 0 ? formatCents(l.debitCents) : ""}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                      {l.creditCents !== 0 ? formatCents(l.creditCents) : ""}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatCents(l.balanceCents)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setOpenGroupId(l.row.posting_group_id)}
                          className={cn(
                            "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground",
                            "hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                          aria-label={`Open boeking van ${l.row.description || formatDatumNL(l.row.posting_date)}`}
                          title="Open boeking"
                          data-testid="open-posting-group"
                          data-posting-group-id={l.row.posting_group_id}
                        >
                          <Layers className="h-4 w-4" />
                        </button>
                        {source.kind === "resolved" ? (
                          <Link
                            to={source.path}
                            className={cn(
                              "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground",
                              "hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                            aria-label={`Open bron (${source.label}) van ${l.row.description || formatDatumNL(l.row.posting_date)}`}
                            title="Open bron"
                          >
                            <ArrowUpRight className="h-4 w-4" />
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground" data-testid="source-unavailable">
                            Bron niet beschikbaar
                          </span>
                        )}
                      </div>
                    </TableCell>

                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pas gemonteerd zodra er een boeking is aangewezen. Zo doet deze tabel
          nog steeds geen enkele query zolang niemand erom vraagt — per rij niet
          en per pagina niet. */}
      {openGroupId !== null && (
        <LedgerPostingGroupSheet
          open
          onOpenChange={(next) => {
            if (!next) setOpenGroupId(null);
          }}
          clientId={clientId}
          postingGroupId={openGroupId}
          accountsById={accountsById}
          /* Origineel ↔ tegenboeking: hetzelfde paneel toont de andere groep.
             Geen nieuwe route, en de rekeningcontext eronder blijft staan. */
          onNavigateToGroup={(id) => setOpenGroupId(id)}
        />
      )}
    </div>
  );
}

function Stat({ label, cents, emphasis }: { label: string; cents: number; emphasis?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={cn("mt-0.5 font-mono tabular-nums", emphasis ? "text-lg font-semibold" : "text-base")}>
          {formatCents(cents)}
        </dd>
      </CardContent>
    </Card>
  );
}
