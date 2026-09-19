import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Balans/W&V PR 1 — rapportageclassificatie op grootboekrekeningen: schema.
 *
 * Deze tests zijn structureel: ze bewijzen wat de migratie ZEGT, niet wat
 * PostgreSQL DOET. Het echte gedrag (bestaande rijen blijven geldig, geen
 * rewrite, de constraints weigeren precies wat ze moeten weigeren, ook voor de
 * API-rol) is bewezen met échte PostgreSQL-probes op een wegwerpcluster — zie
 * supabase/tests/reporting-classification/ en de PR.
 */

const MIGRATION_DIR = "supabase/migrations";
const MIGRATION_SLUG = "_add_reporting_classification.sql";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(MIGRATION_SLUG));
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;
const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");
/** Commentaar weggestript: een bewering over de CODE mag nooit op proza slagen. */
const sql = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

const BALANS_GROUPS = [
  "vaste_activa",
  "vlottende_activa",
  "eigen_vermogen",
  "voorzieningen",
  "langlopende_schulden",
  "kortlopende_schulden",
  "prive",
];
const WV_GROUPS = [
  "netto_omzet",
  "kostprijs_omzet",
  "personeelskosten",
  "afschrijvingen",
  "overige_bedrijfskosten",
  "financiele_baten_lasten",
  "belastingen",
  "overig_resultaat",
];
const CONSTRAINTS = [
  "grootboekrekeningen_statement_type_check",
  "grootboekrekeningen_report_group_check",
  "grootboekrekeningen_reporting_pair_check",
  "grootboekrekeningen_normal_side_check",
  "grootboekrekeningen_report_sort_check",
];
const COLUMNS = ["statement_type", "report_group", "normal_side", "report_sort"];

/** De CHECK-expressie (inclusief buitenste haakjes) van een benoemde constraint. */
function check(name: string): string {
  const marker = `ADD CONSTRAINT ${name} CHECK `;
  const start = flat.indexOf(marker);
  expect(start, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + marker.length; i < flat.length; i++) {
    if (flat[i] === "(") depth++;
    if (flat[i] === ")") {
      depth--;
      if (depth === 0) return flat.slice(start + marker.length, i + 1);
    }
  }
  throw new Error(`onafgesloten CHECK voor ${name}`);
}

/** Alle 'literals' in een stuk SQL, in volgorde. */
function literals(expr: string): string[] {
  return [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/**
 * Bestanden die deze branch t.o.v. origin/main wijzigt; null wanneer
 * origin/main niet beschikbaar is (dan worden de branch-scope-tests
 * overgeslagen in plaats van vals te slagen).
 */
function changedFiles(): string[] | null {
  try {
    return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("Balans/W&V PR 1 — kolommen", () => {
  it("1-4. de vier kolommen worden toegevoegd met ADD COLUMN IF NOT EXISTS op public.grootboekrekeningen", () => {
    expect(flat).toContain("ALTER TABLE public.grootboekrekeningen ADD COLUMN IF NOT EXISTS statement_type text NULL");
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS report_group text NULL/);
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS normal_side text NULL/);
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS report_sort integer NULL/);
    expect(flat.match(/ADD COLUMN/g)).toHaveLength(4);
  });

  it("5. alle vier kolommen zijn nullable — nergens een NOT NULL-kolombeperking in de code (IS NOT NULL in een CHECK is een predicaat, geen beperking)", () => {
    expect(sql.replace(/\bIS NOT NULL\b/g, "")).not.toMatch(/\bNOT NULL\b/i);
    expect(sql).not.toMatch(/SET NOT NULL/i);
    for (const c of COLUMNS) {
      expect(flat, c).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c} (text|integer) NULL`));
    }
  });

  it("6. geen DEFAULT toegevoegd of gewijzigd", () => {
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });
});

describe("Balans/W&V PR 1 — CHECK-constraints", () => {
  it("de vijf constraints hebben stabiele, benoemde namen en zijn elk precies één keer gedefinieerd", () => {
    for (const c of CONSTRAINTS) {
      expect(flat.match(new RegExp(`ADD CONSTRAINT ${c} CHECK`, "g")), c).toHaveLength(1);
    }
    expect(flat.match(/ADD CONSTRAINT/g)).toHaveLength(5);
  });

  it("7. statement_type is uitsluitend balans of winst_verlies (of NULL)", () => {
    const expr = check("grootboekrekeningen_statement_type_check");
    expect(expr).toContain("statement_type IS NULL OR statement_type IN (");
    expect(literals(expr)).toEqual(["balans", "winst_verlies"]);
  });

  const BALANS_BRANCH = /WHEN statement_type = 'balans' THEN report_group IS NOT NULL AND report_group IN \(([^)]*)\)/;
  const WV_BRANCH = /WHEN statement_type = 'winst_verlies' THEN report_group IS NOT NULL AND report_group IN \(([^)]*)\)/;

  it("8. balans-groepen: precies de zeven toegestane waarden", () => {
    const m = check("grootboekrekeningen_reporting_pair_check").match(BALANS_BRANCH);
    expect(m).not.toBeNull();
    expect(literals(m![1]).sort()).toEqual([...BALANS_GROUPS].sort());
  });

  it("9. winst_verlies-groepen: precies de acht toegestane waarden", () => {
    const m = check("grootboekrekeningen_reporting_pair_check").match(WV_BRANCH);
    expect(m).not.toBeNull();
    expect(literals(m![1]).sort()).toEqual([...WV_GROUPS].sort());
  });

  it("10. een groep van het andere overzicht wordt geweigerd: de twee lijsten overlappen niet en het domein is precies hun vereniging", () => {
    expect(BALANS_GROUPS.filter((g) => WV_GROUPS.includes(g))).toEqual([]);
    const domain = literals(check("grootboekrekeningen_report_group_check"));
    expect(domain.sort()).toEqual([...BALANS_GROUPS, ...WV_GROUPS].sort());
  });

  it("11/12. de pair-check is een CASE op statement_type met precies drie WHEN-takken en ELSE false — niets anders", () => {
    let expr = check("grootboekrekeningen_reporting_pair_check");
    // 12: beide NULL toegestaan; 11: NULL statement_type met een groep is
    // precies wat de eerste tak weigert (report_group IS NULL is dan false).
    expect(expr).toContain("CASE WHEN statement_type IS NULL THEN report_group IS NULL WHEN statement_type = 'balans'");
    expect(expr.match(/\bWHEN\b/g)).toHaveLength(3);
    expect(expr).toContain("ELSE false END");
    expr = expr
      .replace("WHEN statement_type IS NULL THEN report_group IS NULL", "")
      .replace(BALANS_BRANCH, "")
      .replace(WV_BRANCH, "")
      .replace("ELSE false", "");
    // Wat overblijft mag alleen CASE/END, spaties en de buitenste haakjes zijn.
    expect(expr.replace(/\bCASE\b|\bEND\b|\s|\(|\)/g, "")).toBe("");
  });

  it("drie-waardige logica: geen OR-vorm, elke groep-tak heeft een IS NOT NULL-guard, zodat een geweigerde combinatie FALSE oplevert en nooit NULL", () => {
    const expr = check("grootboekrekeningen_reporting_pair_check");
    expect(expr).not.toMatch(/\bOR\b/);
    expect(expr.match(/THEN report_group IS NOT NULL AND report_group IN \(/g)).toHaveLength(2);
  });

  it("13-16. normal_side: NULL, debet of credit — niets anders, en nooit afgedwongen bij classificatie", () => {
    const expr = check("grootboekrekeningen_normal_side_check");
    expect(expr).toContain("normal_side IS NULL OR normal_side IN (");
    expect(literals(expr)).toEqual(["debet", "credit"]);
    // De pair-check en de statement-check noemen normal_side niet.
    expect(check("grootboekrekeningen_reporting_pair_check")).not.toContain("normal_side");
    expect(check("grootboekrekeningen_statement_type_check")).not.toContain("normal_side");
  });

  it("17-19. report_sort: NULL of >= 0; negatief geweigerd", () => {
    const expr = check("grootboekrekeningen_report_sort_check");
    expect(expr.replace(/\s+/g, " ")).toBe("(report_sort IS NULL OR report_sort >= 0)");
  });

  it("elke constraint aanvaardt NULL expliciet, dus bestaande rijen (alles NULL) blijven geldig", () => {
    expect(check("grootboekrekeningen_statement_type_check")).toMatch(/^\(statement_type IS NULL OR /);
    expect(check("grootboekrekeningen_report_group_check")).toMatch(/^\(report_group IS NULL OR /);
    expect(check("grootboekrekeningen_normal_side_check")).toMatch(/^\(normal_side IS NULL OR /);
    expect(check("grootboekrekeningen_report_sort_check")).toMatch(/^\(report_sort IS NULL OR /);
    expect(check("grootboekrekeningen_reporting_pair_check")).toMatch(/^\( ?CASE WHEN statement_type IS NULL THEN report_group IS NULL WHEN /);
  });

  it("idempotent: elke constraint wordt alleen toegevoegd als die naam nog niet op de tabel bestaat", () => {
    for (const c of CONSTRAINTS) {
      expect(flat, c).toContain(
        `IF NOT EXISTS ( SELECT 1 FROM pg_constraint WHERE conrelid = 'public.grootboekrekeningen'::regclass AND conname = '${c}' ) THEN ALTER TABLE public.grootboekrekeningen ADD CONSTRAINT ${c} CHECK`,
      );
    }
    expect(sql).not.toMatch(/NOT VALID/i);
  });
});

describe("Balans/W&V PR 1 — wat de migratie NIET doet", () => {
  it("20. geen UPDATE", () => {
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  it("21. geen DELETE, geen TRUNCATE", () => {
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
  });

  it("22. geen INSERT, COPY of MERGE — geen backfill van welke aard ook", () => {
    expect(sql).not.toMatch(/\bINSERT\b|\bCOPY\b|\bMERGE\b/i);
  });

  it("23. categorie wordt niet genoemd in de code: niet gelezen, niet herschreven, niet beperkt", () => {
    expect(sql).not.toMatch(/categorie/i);
    expect(sql).not.toMatch(/\bnummer\b|\bomschrijving\b/i);
  });

  it("25. geen RLS, policy, grant of revoke", () => {
    expect(sql).not.toMatch(/\bPOLICY\b|ROW LEVEL SECURITY|\bGRANT\b|\bREVOKE\b|SECURITY DEFINER/i);
  });

  it("26. geen trigger, functie of procedure (een anoniem DO-blok is geen functie)", () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|PROCEDURE)/i);
    expect(sql).not.toMatch(/\bTRIGGER\b/i);
  });

  it("27. geen index", () => {
    expect(sql).not.toMatch(/\bINDEX\b/i);
  });

  it("geen DROP, geen ALTER COLUMN, geen RENAME, geen andere tabel dan public.grootboekrekeningen", () => {
    expect(sql).not.toMatch(/\bDROP\b|ALTER COLUMN|\bRENAME\b|\bCREATE TABLE\b|\bCREATE TYPE\b|\bCREATE SCHEMA\b/i);
    const targets = [...flat.matchAll(/ALTER TABLE (\S+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set(["public.grootboekrekeningen"]));
  });

  it("geen rekeningnummerbereiken en geen afleiding: de code bevat geen getallen behalve de 0-ondergrens van report_sort", () => {
    const numbers = [...sql.matchAll(/\b\d+\b/g)].map((m) => m[0]);
    expect(numbers).toEqual(["1", "1", "1", "1", "1", "0"]); // vijf keer `SELECT 1`, één keer `>= 0`
  });

  it("geen projectref en geen Supabase-URL in het bestand: de migratie is niet aan een database gebonden", () => {
    // Geen productie-ref, en geen enkele ref-vormige token (20 kleine letters,
    // zoals elke Supabase-projectref) — de geblokkeerde refs staan bewust niet
    // letterlijk in src/; zie docs/CLAUDE_WORKFLOW.md voor de lijst.
    expect(raw).not.toContain("alxlbdhpbwlehbdbfejw");
    expect(raw).not.toMatch(/supabase\.co|project_ref|--project-ref/i);
    expect(sql).not.toMatch(/\b[a-z]{20}\b/);
  });
});

describe("Balans/W&V PR 1 — rollback en documentatie", () => {
  it("de rollback is uitsluitend gedocumenteerd (commentaar), dropt eerst de vijf constraints en dan de vier kolommen, en benoemt het verlies", () => {
    expect(raw).toContain("-- rollback");
    for (const c of CONSTRAINTS) {
      expect(raw, c).toMatch(new RegExp(`--\\s+DROP CONSTRAINT IF EXISTS ${c}`));
    }
    for (const col of COLUMNS) {
      expect(raw, col).toMatch(new RegExp(`--\\s+DROP COLUMN IF EXISTS ${col}`));
    }
    const constraintsAt = raw.indexOf("DROP CONSTRAINT IF EXISTS");
    const columnsAt = raw.indexOf("DROP COLUMN IF EXISTS");
    expect(constraintsAt).toBeLessThan(columnsAt);
    expect(raw.replace(/\n--\s+/g, " ")).toMatch(/LOSES every classification value/);
    expect(raw).toMatch(/NOT executed/);
  });

  it("de kop zegt expliciet: geen backfill, categorie ongewijzigd, classificatie nog niet gezaghebbend, types later", () => {
    expect(raw).toMatch(/no backfill/i);
    expect(raw).toMatch(/categorie[^\n]*stays exactly as it is/);
    expect(raw).toMatch(/NOT authoritative until it has been filled in/);
    expect(raw).toMatch(/regenerated from the production schema AFTER/);
  });
});

describe("Balans/W&V PR 1 — branch-scope", () => {
  const changed = changedFiles();
  const branchIt = changed === null ? it.skip : it;

  it("28. precies één migratie met deze slug in supabase/migrations, met UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_add_reporting_classification\.sql$/);
  });

  branchIt("28b. geen enkele bestaande migratie wordt gewijzigd; hooguit deze ene komt erbij", () => {
    // Voorheen: exact [MIGRATION]. Dat gold alleen op de branch die de
    // migratie zelf meebracht; op elke latere branch (zoals de UI-PR) is de
    // lijst leeg. De invariant is dat dit spoor nooit een ándere migratie
    // aanraakt.
    // Voorheen: de lijst gewijzigde migraties mocht hoogstens DEZE ene
    // bevatten. Dat was waar op het classificatiespoor zelf, maar het is geen
    // invariant: een latere fase (6C-b9) voegt terecht een eigen, losstaande
    // migratie toe. De invariant is dat er nooit een BESTAANDE migratie wordt
    // gewijzigd — nieuwe bestanden erbij mogen.
    const migrations = changed!.filter((f) => f.startsWith("supabase/migrations/"));
    const bestaandOpMain = new Set(
      execFileSync("git", ["ls-tree", "--name-only", "origin/main", "supabase/migrations/"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean),
    );
    expect(migrations.filter((f) => f !== MIGRATION && bestaandOpMain.has(f))).toEqual([]);
  });

  branchIt("24. de seed, de rapportagekern en de afhankelijkheden zijn onaangeraakt", () => {
    // Voorheen stonden hier ook "src/pages/Grootboek.tsx" en
    // "src/hooks/useGrootboekrekeningen.ts", plus "geen enkele src/-wijziging
    // buiten src/test/". Dat waren scope-uitspraken van PR 1 (schema only),
    // geen invarianten: PR 2 bouwt juist de classificatie-UI op precies die
    // twee bestanden. Wat bewaakt moet blijven is dat dit schema-PR-spoor de
    // seed en het rekenwerk niet aanraakt en geen afhankelijkheid toevoegt.
    for (const f of [
      "src/lib/ledger-reporting.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/ledger-completeness.ts",
      "package.json",
    ]) {
      expect(changed, f).not.toContain(f);
    }
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
    // De seedlijst (DEFAULT_ACCOUNTS) mag nooit een classificatieveld krijgen:
    // dat zou classificeren op zaadpositie zijn.
    const hooks = readFileSync(resolve(process.cwd(), "src/hooks/useGrootboekrekeningen.ts"), "utf-8");
    const seed = hooks.slice(hooks.indexOf("const DEFAULT_ACCOUNTS"), hooks.indexOf("export interface UseGrootboek"));
    for (const field of ["statement_type", "report_group", "normal_side", "report_sort"]) {
      expect(seed, field).not.toContain(field);
    }
  });
});
