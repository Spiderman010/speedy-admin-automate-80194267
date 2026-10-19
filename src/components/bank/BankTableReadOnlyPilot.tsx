import { useMemo, useState } from "react";
import type { Tables } from "@/integrations/supabase/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type BankRow = Tables<"bank_transactions">;
type SortKey = "transaction_date" | "description" | "amount" | "match_status";
const currency = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const statusText: Record<string, string> = { handmatig_geboekt: "Handmatig geboekt", gematcht: "Gematcht", suggestie: "Suggestie", niet_gematcht: "Open" };

/** Presentation-only pilot: rows are already tenant-scoped and paged by Bank.tsx.
 * Never performs Supabase requests, mutations, posting, selection, or exports.
 */
export function BankTableReadOnlyPilot({ rows }: { rows: BankRow[] }) {
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [ascending, setAscending] = useState(false);
  const visible = useMemo(() => {
    const query = term.trim().toLocaleLowerCase("nl-NL");
    return rows.filter(row => !query || [row.description, row.transaction_date, row.match_status, row.amount].some(v => String(v ?? "").toLocaleLowerCase("nl-NL").includes(query)))
      .slice().sort((a, b) => {
        const av = a[sort] ?? "", bv = b[sort] ?? "";
        const cmp = sort === "amount" ? Number(av) - Number(bv) : String(av).localeCompare(String(bv), "nl-NL");
        return ascending ? cmp : -cmp;
      });
  }, [rows, term, sort, ascending]);
  const changeSort = (column: SortKey) => {
    if (sort === column) setAscending(prev => !prev);
    else { setSort(column); setAscending(true); }
  };
  return (
    <section aria-label="Read-only proefweergave banktabel" className="space-y-3 rounded-lg border bg-card p-3" data-testid="bank-readonly-pilot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="font-medium">Proefweergave — alleen lezen</p><p className="text-xs text-muted-foreground">Toont uitsluitend de reeds geladen pagina. Geen boekingsacties of databaseaanvragen.</p></div>
        <Input aria-label="Zoek op deze pagina" placeholder="Zoek op deze pagina…" value={term} onChange={e => setTerm(e.target.value)} className="w-full sm:w-64" />
      </div>
      <div className="overflow-auto">
        <Table>
          <TableHeader><TableRow>
            {([["transaction_date", "Datum"], ["description", "Omschrijving"], ["amount", "Bedrag"], ["match_status", "Status"]] as const).map(([key, label]) => (
              <TableHead key={key} aria-sort={sort === key ? ascending ? "ascending" : "descending" : "none"}>
                <Button size="sm" variant="ghost" onClick={() => changeSort(key)} className="h-8 px-1">{label}{sort === key ? ascending ? " ↑" : " ↓" : ""}</Button>
              </TableHead>
            ))}
          </TableRow></TableHeader>
          <TableBody>
            {visible.map(row => <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap">{row.transaction_date ? new Date(row.transaction_date + "T12:00:00").toLocaleDateString("nl-NL") : "—"}</TableCell>
              <TableCell className="min-w-60 max-w-lg break-words">{row.description || "—"}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{currency.format(row.amount)}</TableCell>
              <TableCell>{statusText[row.match_status ?? ""] ?? row.match_status ?? "—"}</TableCell>
            </TableRow>)}
            {!visible.length && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Geen bankregels op deze pagina gevonden.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">{visible.length} van {rows.length} geladen bankregels zichtbaar. Filtering op deze proefweergave geldt alleen voor de huidige serverpagina.</p>
    </section>
  );
}
