import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateReversalIntegrity,
  REVERSAL_SOURCE_TYPE,
  type ReversalMarkerLike,
  type ReversalPostingLike,
} from "@/lib/reversal-integrity";
import { diagnosticsForReversals } from "@/lib/accounting-diagnostics";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * Fase 6C-b9 — de tegenboekingsmotor.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Wat de DATABASE doet — triggers, rechten, grendels, atomiciteit en twee
 * werkelijk gelijktijdige sessies — is niet met een reguliere expressie te
 * bewijzen. Dat staat in `supabase/tests/ledger-reversal/` en draait tegen een
 * echte PostgreSQL. Dit bestand bewaakt de twee dingen die daar juist NIET te
 * zien zijn: dat de migratie blijft zeggen wat zij hoort te zeggen, en dat de
 * pure diagnoselaag erboven klopt.
 */

const MIGRATION_SLUG = "_add_ledger_reversal_posting.sql";
const MIGRATION_DIR = "supabase/migrations";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith(MIGRATION_SLUG),
);
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

describe("Migratie — de tegenboekingsmotor", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_add_ledger_reversal_posting\.sql$/);
  });

  it("2. maakt exact één nieuwe tabel: ledger_reversal_postings", () => {
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["ledger_reversal_postings"]);
  });

  it("3. de oorspronkelijke boekingsgroep is de PRIMARY KEY — één origineel, hoogstens één tegenboeking", () => {
    expect(flat).toMatch(/original_posting_group_id uuid PRIMARY KEY/);
    expect(flat).toMatch(/reversal_posting_group_id uuid NOT NULL UNIQUE/);
  });

  it("4. de twee groepen kunnen nooit dezelfde zijn, en de tegenboeking niet vóór het origineel", () => {
    expect(flat).toMatch(/CHECK \(reversal_posting_group_id <> original_posting_group_id\)/);
    expect(flat).toMatch(/CHECK \(posting_date >= original_posting_date\)/);
  });

  it("5. een tegenboeking van een tegenboeking is een database-invariant, geen afspraak", () => {
    expect(flat).toMatch(/original_source_type <> 'reversal'/);
  });

  it("6. reversal_of_posting_id hoort uitsluitend bij bronsoort 'reversal'", () => {
    expect(flat).toMatch(
      /ADD CONSTRAINT ledger_postings_reversal_source_type_check CHECK \(reversal_of_posting_id IS NULL OR source_type = 'reversal'\)/,
    );
  });

  it("7. één originele regel wordt hoogstens één keer tegengeboekt (partiële unieke index)", () => {
    expect(flat).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_reversal_of_posting ON public\.ledger_postings \(reversal_of_posting_id\) WHERE source_type = 'reversal'/,
    );
  });

  it("8. de schrijver is SECURITY DEFINER met een vastgepind search_path", () => {
    expect(flat).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reverse_posting_group\( _posting_group_id uuid, _posting_date date, _reason text DEFAULT NULL \) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/,
    );
  });

  it("9. de rechten: alleen authenticated mag hem aanroepen, elke rol expliciet ingetrokken", () => {
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.reverse_posting_group\(uuid, date, text\) FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reverse_posting_group\(uuid, date, text\) TO authenticated;/,
    );
    expect(flat).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.reverse_posting_group[^;]*service_role/);
  });

  it("10. de markertabel is voor de applicatie uitsluitend leesbaar", () => {
    expect(flat).toMatch(/REVOKE ALL ON public\.ledger_reversal_postings FROM anon, authenticated, service_role;/);
    expect(flat).toMatch(/GRANT SELECT ON public\.ledger_reversal_postings TO authenticated, service_role;/);
    expect(flat).toMatch(/ALTER TABLE public\.ledger_reversal_postings ENABLE ROW LEVEL SECURITY/);
    expect(flat).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[^;]*ledger_reversal_postings/);
  });

  it("11. de rolvloer is accountant, gelijk aan memoriaal en beginbalans", () => {
    expect(flat).toMatch(/has_min_role\(v_uid, v_probe_org, 'accountant'\)/);
    expect(flat).not.toMatch(/has_min_role\([^)]*'assistant'\)/);
  });

  it("11a. bestaan wordt nooit bevestigd: dezelfde fout voor onbekend en onbevoegd", () => {
    // Eén tekst, één SQLSTATE. Zou er ergens nog een tweede formulering staan,
    // dan is het verschil tussen die twee antwoorden weer een orakel.
    expect(flat).not.toMatch(/Boekingsgroep niet gevonden/);
    const generiek = [...sql.matchAll(/RAISE EXCEPTION 'Boekingsgroep niet beschikbaar' USING ERRCODE = '42501'/g)];
    expect(generiek.length).toBeGreaterThanOrEqual(3);
    expect(flat).not.toMatch(/'Boekingsgroep niet beschikbaar'[^;]*ERRCODE = '(?!42501)/);
  });

  it("11b. de autorisatiepoort komt vóór elke uitspraak over de inhoud van de groep", () => {
    const poort = sql.indexOf("has_min_role(v_uid, v_probe_org, 'accountant')");
    expect(poort).toBeGreaterThan(0);
    // Elk inhoudelijk oordeel staat ná de poort.
    for (const needle of [
      "Boekingsgroep bevat regels van meerdere organisaties",
      "Boekingsgroep bevat regels van meerdere administraties",
      "zelf een tegenboeking",
      "Deze boekingsgroep is al tegengeboekt",
      "Boekingsgroep is niet in balans",
      "is afgesloten voor deze administratie",
      "wordt niet ondersteund; alleen EUR",
    ]) {
      expect(sql.indexOf(needle), needle).toBeGreaterThan(poort);
    }
  });

  it("11c. de autorisatie kijkt naar ELKE organisatie in de groep, nooit naar een steekproef", () => {
    // array_agg over de hele groep plus een FOREACH per organisatie; geen
    // LIMIT 1 dat toevallig op één organisatie rechten zou gebruiken.
    expect(flat).toMatch(/SELECT array_agg\(DISTINCT lp\.organization_id\) INTO v_org_ids/);
    expect(flat).toMatch(/FOREACH v_probe_org IN ARRAY v_org_ids LOOP/);
    expect(sql).not.toMatch(/LIMIT 1/);
    // De leesdrempel gaat vooraf aan de schrijfdrempel.
    expect(sql.indexOf("has_min_role(v_uid, v_probe_org, 'read_only')"))
      .toBeLessThan(sql.indexOf("has_min_role(v_uid, v_probe_org, 'accountant')"));
  });

  it("12. authenticatie eerst, en alleen READ COMMITTED", () => {
    expect(flat).toMatch(/v_uid IS NULL THEN RAISE EXCEPTION 'Niet ingelogd'/);
    expect(flat).toMatch(/current_setting\('transaction_isolation'\) <> 'read committed'/);
  });

  it("13. de administratiegrendel van 6C-b8 wordt als eerste genomen", () => {
    expect(flat).toMatch(/PERFORM public\.lock_ledger_client\(v_client_id\)/);
  });

  it("14. debet en credit worden verwisseld, rekening en valuta overgenomen", () => {
    // De INSERT zet v_row.credit_amount op de debetkolom en omgekeerd.
    expect(flat).toMatch(/v_row\.credit_amount, v_row\.debit_amount, v_row\.currency,/);
    expect(flat).toMatch(/v_org, v_client_id, v_row\.grootboekrekening_id, v_new_group, v_line_no,/);
  });

  it("15. elke tegenregel krijgt de EXACTE originele regel-id mee, en geen source_line_id", () => {
    expect(flat).toMatch(/'reversal', _posting_group_id,/);
    expect(flat).toMatch(/NULL, v_row\.id, v_uid/);
  });

  it("16. een afgesloten boekjaar wordt geweigerd en de datum nooit verschoven", () => {
    expect(flat).toMatch(/v_client\.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client\.afgesloten_boekjaar/);
    // Geen enkele terugval op vandaag of op een ander jaar.
    expect(sql).not.toMatch(/_posting_date\s*:=/);
    expect(sql).not.toMatch(/CURRENT_DATE|now\(\)::date/);
  });

  it("17. een kapotte groep wordt geweigerd, niet 'hersteld'", () => {
    for (const needle of [
      /v_sum_debit <> v_sum_credit/,
      /v_xacts > 1/,
      /v_currencies > 1/,
      /v_dates > 1 OR v_boekjaren > 1/,
      /v_orig_boekjaar <> EXTRACT\(YEAR FROM v_orig_date\)::integer/,
      /v_nan > 0/,
      /v_rows < 2/,
    ]) {
      expect(flat, String(needle)).toMatch(needle);
    }
  });

  it("18. de claim wordt vóór de grootboekregels geschreven, in dezelfde transactie", () => {
    const claim = sql.indexOf("INSERT INTO public.ledger_reversal_postings");
    const ledger = sql.indexOf("INSERT INTO public.ledger_postings (");
    expect(claim).toBeGreaterThan(0);
    expect(ledger).toBeGreaterThan(claim);
    // Geen COMMIT halverwege: de functie is één transactie.
    expect(sql).not.toMatch(/\bCOMMIT\b/);
  });

  it("19. de claimtrigger bestaat, is integriteit en geen autorisatie", () => {
    expect(flat).toMatch(/CREATE TRIGGER validate_reversal_source_claim_trigger BEFORE INSERT ON public\.ledger_postings/);
    const trigger = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_reversal_source_claim"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.enforce_reversal_source_claim"),
    );
    expect(trigger).toContain("SECURITY DEFINER");
    expect(trigger).toContain("SET search_path = public");
    // Patterns §5B: een integriteitstrigger kent geen rol en geen sessiegebruiker.
    expect(trigger).not.toMatch(/auth\.uid\(\)/);
    expect(trigger).not.toMatch(/has_min_role/);
  });

  it("20. de claimtrigger toetst elk van de afgesproken velden", () => {
    const trigger = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_reversal_source_claim"));
    for (const needle of [
      "NEW.source_type <> 'reversal'",
      "NEW.posting_group_id <> v_marker.reversal_posting_group_id",
      "NEW.organization_id IS DISTINCT FROM v_marker.organization_id",
      "NEW.posting_date <> v_marker.posting_date",
      "NEW.currency IS DISTINCT FROM v_marker.currency",
      "NEW.line_no < 1 OR NEW.line_no > v_marker.line_count",
      "NEW.user_id IS DISTINCT FROM v_marker.user_id",
      "NEW.source_line_id IS NOT NULL",
      "NEW.reversal_of_posting_id IS NULL",
      "v_orig.posting_group_id <> v_marker.original_posting_group_id",
      "NEW.grootboekrekening_id IS DISTINCT FROM v_orig.grootboekrekening_id",
      "NEW.debit_amount IS DISTINCT FROM v_orig.credit_amount",
      "NEW.credit_amount IS DISTINCT FROM v_orig.debit_amount",
    ]) {
      expect(trigger, needle).toContain(needle);
    }
  });

  it("21. niets wordt gewijzigd, verwijderd of afgekapt in bestaande boekhouding", () => {
    expect(sql).not.toMatch(/UPDATE public\.ledger_postings/);
    expect(sql).not.toMatch(/DELETE FROM public\.ledger_postings/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/);
    expect(sql).not.toMatch(/DROP TABLE/);
    // De enige ALTER op het grootboek is het toevoegen van de CHECK.
    const alters = sql.match(/ALTER TABLE public\.ledger_postings[\s\S]*?;/g) ?? [];
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain("ADD CONSTRAINT");
  });

  it("22. er wordt niets afgeleid uit een rekeningnummer of een categorie", () => {
    expect(sql).not.toMatch(/\bnummer\b/);
    expect(sql).not.toMatch(/\bcategorie\b/);
    expect(sql).not.toMatch(/\b1[1-9]00\b/);
  });

  it("23. een geboekte beginbalans wordt geweigerd, met de reden erbij", () => {
    expect(flat).toMatch(/v_orig_source = 'opening_balance'/);
    expect(flat).toMatch(/deze administratie kan daarna geen nieuwe beginbalans vastleggen/);
  });

  it("24. de rollback en haar voorwaarde staan in het bestand", () => {
    const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
    expect(raw).toMatch(/-- rollback/);
    expect(raw).toContain("DROP TABLE IF EXISTS public.ledger_reversal_postings;");
    expect(raw).toMatch(/UITSLUITEND geldig zolang er nog geen tegenboeking is geboekt/);
  });

  it("25. geen enkel verboden projectref komt in het bestand voor", () => {
    const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
    expect(raw).not.toContain("olumcwneiejjefhkzgmz");
    expect(raw).not.toContain("ycuofllsdssoezwwpqmv");
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
  });
});

// ── De pure diagnoselaag ────────────────────────────────────────────────────

const ORG = "org-1";
const CLIENT = "client-1";

function row(over: Partial<ReversalPostingLike> & { id: string }): ReversalPostingLike {
  return {
    client_id: CLIENT,
    grootboekrekening_id: "acc-1",
    posting_group_id: "g-orig",
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    source_type: "purchase_invoice",
    source_id: null,
    reversal_of_posting_id: null,
    ...over,
  };
}

function marker(over: Partial<ReversalMarkerLike> = {}): ReversalMarkerLike {
  return {
    original_posting_group_id: "g-orig",
    reversal_posting_group_id: "g-rev",
    organization_id: ORG,
    client_id: CLIENT,
    line_count: 2,
    ...over,
  };
}

/** Een gezonde tegenboeking van twee regels: 100 debet / 100 credit, omgekeerd. */
function gezondeSet(): ReversalPostingLike[] {
  return [
    row({ id: "o1", debit_amount: 100, credit_amount: 0, grootboekrekening_id: "acc-1" }),
    row({ id: "o2", debit_amount: 0, credit_amount: 100, grootboekrekening_id: "acc-2" }),
    row({
      id: "r1", posting_group_id: "g-rev", source_type: REVERSAL_SOURCE_TYPE, source_id: "g-orig",
      grootboekrekening_id: "acc-1", debit_amount: 0, credit_amount: 100, reversal_of_posting_id: "o1",
    }),
    row({
      id: "r2", posting_group_id: "g-rev", source_type: REVERSAL_SOURCE_TYPE, source_id: "g-orig",
      grootboekrekening_id: "acc-2", debit_amount: 100, credit_amount: 0, reversal_of_posting_id: "o2",
    }),
  ];
}

describe("reversal-integrity — de zes lineagecontroles", () => {
  it("26. een gezonde tegenboeking levert geen enkele bevinding op", () => {
    const report = evaluateReversalIntegrity({ markers: [marker()], postings: gezondeSet() });
    expect(report.findings).toEqual([]);
    expect(report.reversalCount).toBe(1);
  });

  it("26a. een administratie zonder tegenboekingen is gewoon schoon", () => {
    const report = evaluateReversalIntegrity({ markers: [], postings: gezondeSet().slice(0, 2) });
    expect(report.findings).toEqual([]);
    expect(report.reversalCount).toBe(0);
  });

  it("27. een claim zonder oorspronkelijke boekingsgroep", () => {
    const postings = gezondeSet().filter((r) => r.posting_group_id !== "g-orig");
    const report = evaluateReversalIntegrity({ markers: [marker()], postings });
    expect(report.byKind.claim_zonder_origineel).toBe(1);
  });

  it("28. een claim zonder tegenboekingsgroep", () => {
    const postings = gezondeSet().filter((r) => r.posting_group_id !== "g-rev");
    const report = evaluateReversalIntegrity({ markers: [marker()], postings });
    expect(report.byKind.claim_zonder_tegenboeking).toBe(1);
  });

  it("29. een tegenregel zonder verwijzing, en een verwijzing die nergens op slaat", () => {
    const zonder = gezondeSet().map((r) =>
      r.id === "r1" ? { ...r, reversal_of_posting_id: null } : r,
    );
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: zonder }).byKind
      .tegenregel_zonder_origineel).toBe(1);

    const wijst_nergens = gezondeSet().map((r) =>
      r.id === "r1" ? { ...r, reversal_of_posting_id: "bestaat-niet" } : r,
    );
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: wijst_nergens }).byKind
      .tegenregel_zonder_origineel).toBe(1);
  });

  it("30. een tegenregel die niet exact negeert: bedrag, rekening of valuta", () => {
    const bedrag = gezondeSet().map((r) => (r.id === "r1" ? { ...r, credit_amount: 99 } : r));
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: bedrag }).byKind
      .tegenboeking_negeert_niet_exact).toBe(1);

    const rekening = gezondeSet().map((r) => (r.id === "r1" ? { ...r, grootboekrekening_id: "acc-9" } : r));
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: rekening }).byKind
      .tegenboeking_negeert_niet_exact).toBe(1);

    const valuta = gezondeSet().map((r) => (r.id === "r1" ? { ...r, currency: "USD" } : r));
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: valuta }).byKind
      .tegenboeking_negeert_niet_exact).toBe(1);
  });

  it("30a. bedragen worden in hele centen vergeleken, niet als float", () => {
    const tekstueel = gezondeSet().map((r) =>
      r.id === "r1" ? { ...r, credit_amount: "100.00" } : r.id === "o1" ? { ...r, debit_amount: "100,00" } : r,
    );
    expect(evaluateReversalIntegrity({ markers: [marker()], postings: tekstueel }).findings).toEqual([]);
  });

  it("31. een tegenboeking met te weinig regels negeert niet volledig", () => {
    const postings = gezondeSet().filter((r) => r.id !== "r2");
    const report = evaluateReversalIntegrity({ markers: [marker()], postings });
    expect(report.byKind.tegenboeking_negeert_niet_exact).toBe(1);
  });

  it("32. lineage over administraties heen", () => {
    const postings = gezondeSet().map((r) => (r.id === "o1" ? { ...r, client_id: "client-2" } : r));
    const report = evaluateReversalIntegrity({ markers: [marker()], postings });
    expect(report.byKind.lineage_buiten_administratie).toBe(1);
  });

  it("33. dezelfde oorspronkelijke regel twee keer tegengeboekt", () => {
    const postings = [
      ...gezondeSet(),
      row({
        id: "r3", posting_group_id: "g-rev", source_type: REVERSAL_SOURCE_TYPE, source_id: "g-orig",
        grootboekrekening_id: "acc-1", debit_amount: 0, credit_amount: 100, reversal_of_posting_id: "o1",
      }),
    ];
    const report = evaluateReversalIntegrity({ markers: [marker({ line_count: 3 })], postings });
    expect(report.byKind.dubbele_tegenboeking).toBe(1);
  });

  it("33a. dezelfde oorspronkelijke GROEP twee keer geclaimd", () => {
    const report = evaluateReversalIntegrity({
      markers: [marker(), marker({ reversal_posting_group_id: "g-rev-2" })],
      postings: gezondeSet(),
    });
    expect(report.byKind.dubbele_tegenboeking).toBe(1);
  });

  it("34. de onbalans van een groep staat hier NIET — die wordt al elders gemeld", () => {
    const bron = readFileSync("src/lib/reversal-integrity.ts", "utf8");
    expect(bron).not.toMatch(/niet in balans/);
    expect(bron).not.toMatch(/sum\w*\s*!==\s*0/);
  });

  it("35. de module leidt niets af uit een rekeningnummer, categorie of bronsoorttekst", () => {
    const bron = readFileSync("src/lib/reversal-integrity.ts", "utf8");
    expect(bron).not.toMatch(/\bnummer\b/);
    expect(bron).not.toMatch(/\bcategorie\b/);
    // De enige bronsoort die hier voorkomt is de eigen constante.
    expect([...bron.matchAll(/"(purchase_invoice|sales_invoice|bank_allocation|manual_journal|opening_balance)"/g)])
      .toEqual([]);
  });
});

describe("diagnostiek — de vertaling naar de console", () => {
  it("36. elke lineagebevinding wordt een error in het grootboekdomein, zonder eigen oordeel", () => {
    const postings = gezondeSet().map((r) => (r.id === "r1" ? { ...r, credit_amount: 99 } : r));
    const findings = evaluateReversalIntegrity({ markers: [marker()], postings }).findings;
    const items = diagnosticsForReversals(findings);
    expect(items).toHaveLength(findings.length);
    for (const item of items) {
      expect(item.severity).toBe("error");
      expect(item.domain).toBe("ledger");
      expect(item.targetUrl).toBe("/grootboek/integriteit");
    }
    expect(items[0].message).toContain("negeert de oorspronkelijke boeking niet exact");
  });

  it("37. de mapper beoordeelt niets zelf: één item per bevinding, codes ongewijzigd", () => {
    const postings = gezondeSet().filter((r) => r.posting_group_id !== "g-rev");
    const findings = evaluateReversalIntegrity({ markers: [marker()], postings }).findings;
    expect(diagnosticsForReversals(findings).map((i) => i.code)).toEqual(findings.map((f) => f.kind));
  });

  it("38. de applicatie schrijft nergens rechtstreeks in het grootboek of in de markertabel", () => {
    for (const path of ["src/hooks/useAccountingDiagnostics.ts", "src/lib/reversal-integrity.ts"]) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/ledger_postings[\s\S]{0,200}\.\s*(insert|upsert|update|delete)\s*\(/);
      expect(text, path).not.toMatch(/ledger_reversal_postings[\s\S]{0,200}\.\s*(insert|upsert|update|delete)\s*\(/);
    }
  });
});

// ── Branch-scope ────────────────────────────────────────────────────────────

describe("branch-scope", () => {
  let changed: string[] | null = null;
  try {
    changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    changed = null;
  }
  const branchIt = changed === null ? it.skip : it;

  branchIt("39. geen BESTAANDE migratie wordt gewijzigd; hooguit die van deze fase komt erbij", () => {
    // Voorheen: de lijst moest exact [MIGRATION] zijn. Dat gold op de branch die
    // de motor meebracht; een latere branch van dezelfde fase (de correctie-UI)
    // voegt terecht géén migratie toe en liet die assertie omvallen. De
    // invariant is dat dit spoor nooit een bestaande migratie aanraakt.
    const migrations = changed!.filter((f) => f.startsWith("supabase/migrations/"));
    const bestaandOpMain = new Set(
      execFileSync("git", ["ls-tree", "--name-only", "origin/main", "supabase/migrations/"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean),
    );
    expect(migrations.filter((f) => f !== MIGRATION && bestaandOpMain.has(f))).toEqual([]);
  });

  branchIt("40. de grootboekfundering blijft additief en geen bestaande schrijver wordt aangeraakt", () => {
    assertBranchSqlKeepsLedgerFoundation(changed!);
    assertBranchTouchesNoExistingWriter(changed!);
  });

  branchIt("41. geen handmatige typewijziging en geen afhankelijkheidswijziging", () => {
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  branchIt("42. de rekenlagen zijn byte-voor-byte ongewijzigd", () => {
    const toon = (p: string) => execFileSync("git", ["show", `origin/main:${p}`], { encoding: "utf8" });
    for (const p of [
      "src/lib/ledger-reporting.ts",
      "src/lib/financial-statements.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/ledger-integrity.ts",
      "src/lib/ledger-catchup.ts",
    ]) {
      expect(readFileSync(p, "utf8"), p).toBe(toon(p));
    }
  });

  branchIt("43. de motor blijft server-side: geen gewijzigd bestand krijgt een schrijfpad naar het grootboek", () => {
    // Voorheen: "deze PR bouwt geen correctie-UI". Dat was de scope van de
    // motor-PR, geen invariant — de correctie-UI is juist de volgende stap. Wat
    // bewaakt moet blijven is dat die UI nooit de boekhoudautoriteit wordt.
    for (const file of changed!.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f) && existsSync(f))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/ledger_postings[\s\S]{0,200}\.\s*(insert|upsert|update|delete)\s*\(/);
      expect(text, file).not.toMatch(/ledger_reversal_postings[\s\S]{0,200}\.\s*(insert|upsert|update|delete)\s*\(/);
    }
  });
});
