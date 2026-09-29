import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appFilesMatching } from "./support/app-sources";
import { WORKFLOW_LABELS } from "@/lib/bank-bulk-posting";

/**
 * Na PR H — wat de app over boekbaarheid mag voorspellen.
 *
 * De database is de autoriteit; elke voorspelling in de app is UX. Maar een
 * voorspelling die "geblokkeerd" zegt waar de schrijver boekt, of "klaar" waar
 * hij weigert, is erger dan geen voorspelling. Sinds PR H (20261002120000)
 * geldt: de boekjaarstatus (`afgesloten_boekjaar`) voorspelt NIETS over
 * boekbaarheid; de boekingsblokkade (`posting_locked_through`) is de enige
 * datumgrendel; onbekend is onbekend.
 *
 * Deze tests zijn statisch en gaan over CODE (commentaar gestript): zij
 * verhinderen dat de oude regel via een omweg terugkomt.
 */

/** Broncode zonder commentaar: een verbod gaat over wat de code DOET. */
function code(pad: string): string {
  return readFileSync(resolve(process.cwd(), pad), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((r) => !r.trimStart().startsWith("//") && !r.trimStart().startsWith("*"))
    .join("\n");
}

const VOORSPELLERS = [
  "src/lib/ledger-catchup.ts",
  "src/lib/accounting-diagnostics.ts",
  "src/lib/posting-lock.ts",
  "src/lib/bank-bulk-posting.ts",
  "src/hooks/useLedgerCatchup.ts",
  "src/hooks/useAccountingDiagnostics.ts",
  "src/hooks/usePostingLock.ts",
  "src/pages/PurchaseInvoiceWorkspace.tsx",
  "src/pages/GrootboekHistorisch.tsx",
  "src/pages/BankInhaalslag.tsx",
  "src/components/purchase/PurchaseInvoicePostingReadiness.tsx",
  "src/components/bank/BankBulkCandidateSheet.tsx",
];

describe("De boekjaarstatus voorspelt niets meer over boekbaarheid", () => {
  it("1. `boekjaar_afgesloten` bestaat nergens meer als blokkadecode of -reden", () => {
    expect(appFilesMatching(/boekjaar_afgesloten/)).toEqual([]);
    expect(appFilesMatching(/is afgesloten voor deze administratie/)).toEqual([
      // Alleen de vertaling van een SERVERmelding (tegenboeking): geen voorspelling.
      "src/lib/ledger-reversal-ui.ts",
    ].filter((f) => appFilesMatching(/is afgesloten voor deze administratie/).includes(f)));
  });

  it("2. geen voorspeller vergelijkt een boekjaar met `afgesloten_boekjaar`", () => {
    for (const pad of VOORSPELLERS) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/<=\s*[\w.]*afgesloten_boekjaar|afgesloten_boekjaar\s*[<>]=?/);
      expect(bron, pad).not.toMatch(/jaarAfgesloten|closedYear|yearClosed\(/);
    }
    // De inhaalslag en de diagnostiek kennen het veld niet eens meer.
    for (const pad of ["src/lib/ledger-catchup.ts", "src/lib/accounting-diagnostics.ts", "src/hooks/useLedgerCatchup.ts", "src/hooks/useAccountingDiagnostics.ts"]) {
      expect(code(pad), pad).not.toMatch(/afgesloten_boekjaar/);
    }
  });

  it("3. er is geen 'altijd fout'-lijst meer die op de boekjaarstatus leunt", () => {
    const diag = code("src/lib/accounting-diagnostics.ts");
    expect(diag).not.toMatch(/ALTIJD_ERROR/);
    expect(diag).not.toMatch(/afgesloten/i);
    // De onbekende blokkade is altijd een waarschuwing, nooit een fout.
    expect(diag).toMatch(/ALTIJD_WAARSCHUWING = new Set<string>\(\[[^\]]*"boekingsblokkade_onbekend"/);
  });

  it("4. één helper voorspelt het oordeel van de blokkade; niemand herhaalt de datumvergelijking", () => {
    const helper = code("src/lib/posting-lock.ts");
    expect(helper).toContain("export function postingLockVerdict(");
    expect(helper).toMatch(/postingDate <= lockedThrough/);
    // Buiten de helper: geen eigen `<= posting_locked_through`-vergelijking.
    for (const f of appFilesMatching(/<=\s*[\w.]*posting_locked_through|posting_locked_through\s*[<>]=?/)) {
      expect(f).toBe("src/lib/posting-lock.ts");
    }
    // En de inhaalslag leest via die helper.
    expect(code("src/lib/ledger-catchup.ts")).toContain("postingLockVerdict(");
  });

  it("5. onbekend is onbekend: de inhaalslag en de werkbank zetten een onleesbare blokkade nooit op 'geen blokkade'", () => {
    const hook = code("src/hooks/usePostingLock.ts");
    expect(hook).toContain("export async function readPostingLockStateOrUnknown(");
    expect(hook).toMatch(/catch \(error\) \{[\s\S]*return undefined;/);
    for (const pad of ["src/hooks/useLedgerCatchup.ts", "src/hooks/useAccountingDiagnostics.ts"]) {
      expect(code(pad), pad).toContain("posting_locked_through: await readPostingLockStateOrUnknown(clientId)");
    }
    const ws = code("src/pages/PurchaseInvoiceWorkspace.tsx");
    expect(ws).toMatch(/lockedThrough = postingLock\.isSuccess \? postingLock\.data : undefined/);
    // Geen `?? null` op de blokkade: dat zou onbekend tot "toegestaan" maken.
    expect(ws).not.toMatch(/posting_locked_through: [^,\n]*\?\? null/);
  });
});

describe("De bank-preflight komt van de database", () => {
  it("6. de app leidt de banktoestand af uit `workflow_state` van de preflight en kent geen eigen jaarregel", () => {
    for (const pad of ["src/lib/bank-bulk-posting.ts", "src/pages/BankInhaalslag.tsx", "src/components/bank/BankBulkCandidateSheet.tsx", "src/hooks/useBankBulkPosting.ts"]) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/afgesloten_boekjaar|afgesloten|EXTRACT|getFullYear\(\)\s*<=/);
      expect(bron, pad).not.toMatch(/posting_locked_through/);
    }
    // De vier toestanden zijn exact die van bank_bulk_posting_candidates().
    expect(Object.keys(WORKFLOW_LABELS).sort()).toEqual(["blocked", "posted", "ready", "review_needed"]);
    // En de laatste definitie van de preflight noemt een afgesloten jaar niet meer.
    const prh = readFileSync(resolve(process.cwd(), "supabase/migrations/20261002120000_decouple_year_watermark_from_posting.sql"), "utf8");
    const start = prh.indexOf("CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates(");
    const preflight = prh.slice(start, prh.indexOf("\n$$;\n", start));
    expect(preflight).not.toMatch(/afgesloten_boekjaar/);
    expect(preflight).toContain("t.transaction_date <= c.posting_locked_through");
  });
});

describe("Lezen, nooit schrijven; de schrijver blijft de autoriteit", () => {
  it("7. geen code zet of wist de blokkade buiten set_posting_lock om, en niets raakt de levenscyclus", () => {
    expect(appFilesMatching(/\.rpc\(\s*["'`]set_posting_lock["'`]/)).toEqual(["src/hooks/usePostingLock.ts"]);
    expect(appFilesMatching(/\.(update|upsert|insert)\(\s*\{[^}]*(posting_locked_through|afgesloten_boekjaar)/)).toEqual([]);
    expect(appFilesMatching(/\.rpc\(\s*["'`](close_fiscal_year|reopen_fiscal_year)["'`]/)).toEqual(["src/hooks/useYearClose.ts"]);
    for (const pad of VOORSPELLERS) {
      expect(code(pad), pad).not.toMatch(/close_fiscal_year|reopen_fiscal_year|year_closures|fiscal_year_events/);
    }
  });

  it("8. geen directe grootboekmutatie, en elke voorspeller zegt dat de database opnieuw controleert", () => {
    expect(appFilesMatching(/\.from\(\s*["'`]ledger_postings["'`]\s*\)[^;]*\.(insert|update|upsert|delete)\s*\(/)).toEqual([]);
    expect(code("src/lib/posting-lock.ts")).toMatch(/controleert de boeking opnieuw bij uitvoeren/);
    // De inhaalslag rekent niets uit en praat niet zelf met de database.
    expect(code("src/lib/ledger-catchup.ts")).not.toMatch(/supabase|\.rpc\(|useMutation/);
  });
});
