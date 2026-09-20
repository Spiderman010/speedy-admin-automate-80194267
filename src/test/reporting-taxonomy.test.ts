import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BALANS_GROUPS,
  CLASSIFICATION_CONFLICT_LABELS,
  EMPTY_CLASSIFICATION,
  REPORT_SUBGROUP_LABELS,
  SUBGROUPS_BY_GROUP,
  WINST_VERLIES_GROUPS,
  buildClassificationPayload,
  classificationConflicts,
  classificationFromAccount,
  classificationFullLabel,
  defaultNormalSideFor,
  isClassified,
  isSubgroupAllowed,
  onReportGroupChange,
  onReportSubgroupChange,
  onStatementTypeChange,
  subgroupsFor,
  validateClassification,
  type ClassificationForm,
  type ReportGroup,
} from "@/lib/reporting-classification";

/**
 * De rapportagetaxonomie — het tweede niveau.
 *
 * `report_group` was en blijft de CATEGORIE; `report_subgroup` is de GROEP
 * daarbinnen. De inzet van deze PR is dat dat tweede niveau bestaat zonder dat
 * er ook maar één bestaande, handmatig ingevulde classificatie verandert, en
 * zonder dat er ooit iets wordt afgeleid uit een rekeningnummer of een naam.
 */

const MIGRATION_DIR = "supabase/migrations";
const own = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith("_add_report_subgroup.sql"),
);
const rawMigration = readFileSync(resolve(process.cwd(), `${MIGRATION_DIR}/${own[0]}`), "utf8");
/** Commentaar weg: een bewering over de SQL mag nooit op proza slagen. */
const migration = rawMigration
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const form = (over: Partial<ClassificationForm> = {}): ClassificationForm => ({
  ...EMPTY_CLASSIFICATION,
  ...over,
});

describe("de groepen hangen aan hun eigen categorie", () => {
  it("1. Vlottende activa biedt Liquide middelen aan", () => {
    expect(subgroupsFor("vlottende_activa")).toContain("liquide_middelen");
    expect(REPORT_SUBGROUP_LABELS.liquide_middelen).toBe("Liquide middelen");
    expect(isSubgroupAllowed("vlottende_activa", "liquide_middelen")).toBe(true);
  });

  it("1b. en precies de zes gevraagde groepen, niet meer", () => {
    expect([...subgroupsFor("vlottende_activa")]).toEqual([
      "voorraden", "handelsdebiteuren", "overige_vorderingen",
      "belastingen_premies_te_ontvangen", "overlopende_activa", "liquide_middelen",
    ]);
  });

  it("2. Vaste activa biedt Liquide middelen NIET aan", () => {
    expect(subgroupsFor("vaste_activa")).not.toContain("liquide_middelen");
    expect(isSubgroupAllowed("vaste_activa", "liquide_middelen")).toBe(false);
  });

  it("3. een niet-passende combinatie kan niet nieuw worden opgeslagen", () => {
    // Het voorbeeld uit de opdracht: Vlottende activa + Loonheffingen.
    const kapot = form({
      statementType: "balans",
      reportGroup: "vlottende_activa",
      reportSubgroup: "loonheffingen" as never,
    });
    expect(validateClassification(kapot).reportSubgroup).toBeTruthy();
    // En zelfs als de validatie zou worden overgeslagen, gaat het veld niet mee.
    expect(buildClassificationPayload(kapot).report_subgroup).toBeNull();
    // De keuzehandler weigert hem ook gewoon.
    expect(onReportSubgroupChange(
      form({ statementType: "balans", reportGroup: "vlottende_activa" }),
      "loonheffingen" as never,
    ).reportSubgroup).toBeNull();
  });

  it("3b. een groep zonder categorie kan niet bestaan", () => {
    const los = form({ reportSubgroup: "liquide_middelen" });
    expect(validateClassification(los).reportSubgroup).toBeTruthy();
    expect(buildClassificationPayload(los).report_subgroup).toBeNull();
  });

  it("13. balans- en W&V-groepen raken nooit vermengd", () => {
    const balansSubgroepen = new Set(BALANS_GROUPS.flatMap((g) => [...subgroupsFor(g)]));
    const wvSubgroepen = new Set(WINST_VERLIES_GROUPS.flatMap((g) => [...subgroupsFor(g)]));
    for (const sg of balansSubgroepen) expect(wvSubgroepen.has(sg), sg).toBe(false);
    // Elke subgroep hoort bij precies één categorie.
    const tellingen = new Map<string, number>();
    for (const g of [...BALANS_GROUPS, ...WINST_VERLIES_GROUPS]) {
      for (const sg of subgroupsFor(g)) tellingen.set(sg, (tellingen.get(sg) ?? 0) + 1);
    }
    for (const [sg, n] of tellingen) expect(n, sg).toBe(1);
  });

  it("13b. elke categorie heeft groepen, en elke groep heeft een label", () => {
    for (const g of [...BALANS_GROUPS, ...WINST_VERLIES_GROUPS] as ReportGroup[]) {
      expect(subgroupsFor(g).length, g).toBeGreaterThan(0);
      for (const sg of subgroupsFor(g)) expect(REPORT_SUBGROUP_LABELS[sg], sg).toBeTruthy();
    }
  });
});

describe("bestaande, handmatig ingevulde classificaties blijven staan", () => {
  it("4. een bestaande categorie zonder groep blijft geldig en ongewijzigd", () => {
    // Precies de toestand waarin élke vandaag opgeslagen classificatie terechtkomt.
    const bestaand = {
      statement_type: "balans",
      report_group: "vlottende_activa",
      normal_side: "debet",
      report_sort: 10,
    };
    expect(isClassified(bestaand)).toBe(true);
    expect(classificationConflicts(bestaand)).toEqual([]);

    const geladen = classificationFromAccount(bestaand);
    expect(geladen.reportGroup).toBe("vlottende_activa");
    expect(geladen.reportSubgroup).toBeNull();

    // Opnieuw opslaan zonder iets aan te raken verandert niets aan de vier
    // bestaande velden en laat de groep leeg.
    expect(buildClassificationPayload(geladen)).toEqual({
      statement_type: "balans",
      report_group: "vlottende_activa",
      report_subgroup: null,
      normal_side: "debet",
      report_sort: 10,
    });
  });

  it("4b. de migratie leest, schrijft en verwijdert geen enkele rij", () => {
    expect(migration).not.toMatch(/\bUPDATE\b/i);
    expect(migration).not.toMatch(/\bINSERT\b/i);
    expect(migration).not.toMatch(/\bDELETE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bCOPY\b/i);
    // De vier bestaande kolommen en hun CHECKs blijven ongemoeid.
    expect(migration).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT)/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN/i);
    expect(migration).not.toMatch(/grootboekrekeningen_reporting_pair_check/);
    expect(migration).not.toMatch(/grootboekrekeningen_report_group_check/);
  });

  it("4c. de kolom is nullable en heeft geen default, dus geen bestaande rij kan omvallen", () => {
    expect(migration.replace(/\s+/g, " ")).toContain(
      "ADD COLUMN IF NOT EXISTS report_subgroup text NULL",
    );
    expect(migration).not.toMatch(/report_subgroup[^;]*DEFAULT/i);
    expect(migration).not.toMatch(/report_subgroup[^;]*NOT NULL/i);
  });

  it("4d. de code in de kaart is exact de code in de CHECK", () => {
    // Wijkt de TypeScript-kaart ooit af van de database, dan zou het formulier
    // een groep aanbieden die de database weigert. Beide lijsten worden hier
    // letterlijk naast elkaar gelegd.
    for (const [groep, subgroepen] of Object.entries(SUBGROUPS_BY_GROUP)) {
      const tak = migration
        .replace(/\s+/g, " ")
        .match(new RegExp(`WHEN report_group = '${groep}' THEN report_subgroup IN \\(([^)]*)\\)`));
      expect(tak, `tak voor ${groep}`).not.toBeNull();
      const uitSql = (tak![1].match(/'([a-z_]+)'/g) ?? []).map((v) => v.replace(/'/g, ""));
      expect(uitSql, groep).toEqual([...subgroepen]);
    }
    // En omgekeerd: geen waarde in het domein die de kaart niet kent.
    const domein = (migration.match(/grootboekrekeningen_report_subgroup_check[\s\S]*?\)\);/) ?? [""])[0];
    for (const waarde of (domein.match(/'([a-z_]+)'/g) ?? []).map((v) => v.replace(/'/g, ""))) {
      expect(REPORT_SUBGROUP_LABELS[waarde as never], waarde).toBeTruthy();
    }
  });
});

describe("niets wordt afgeleid", () => {
  const lib = readFileSync(resolve(process.cwd(), "src/lib/reporting-classification.ts"), "utf8");
  const code = lib
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  it("5. geen classificatie op rekeningnummer", () => {
    expect(code).not.toMatch(/\bnummer\b/);
    // Geen enkel bereik, in geen enkele vorm.
    expect(code).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)/);
    expect(code).not.toMatch(/(<=|<|>=|>)\s*\d{3,4}/);
    // De COMMENT ON-tekst is uitleg voor de volgende lezer, geen logica; wat
    // hier niet mag bestaan is een EXPRESSIE over het nummer.
    const sqlLogica = migration.replace(/COMMENT ON[\s\S]*?;/g, "");
    expect(sqlLogica).not.toMatch(/\bnummer\b/);
  });

  it("6. geen classificatie op woorden uit de rekeningnaam", () => {
    for (const veld of ["omschrijving", "categorie"]) {
      expect(code, veld).not.toMatch(new RegExp(`\\.\\s*${veld}\\b`));
      expect(code, veld).not.toMatch(new RegExp(`\\b${veld}\\s*[?]?\\s*:`));
    }
    // Geen tekstonderzoek op een rekeningnaam: geen enkele string-operatie
    // met `omschrijving` of `nummer` als onderwerp. (`.includes()` op een
    // vaste waardenlijst is domeinlidmaatschap en juist wél toegestaan.)
    expect(code).not.toMatch(/(omschrijving|nummer)[^;\n]*\.(includes|startsWith|endsWith|match|test)\(/);
    expect(code).not.toMatch(/autoClassify|guessClassification|suggestGroup|inferStatement|RGS/i);
    const sqlLogica = migration.replace(/COMMENT ON[\s\S]*?;/g, "");
    expect(sqlLogica).not.toMatch(/omschrijving|categorie|ILIKE|LIKE '/);
  });

  it("7. een rekening zonder classificatie blijft zichtbaar als niet geclassificeerd", () => {
    const leeg = { statement_type: null, report_group: null, report_subgroup: null };
    expect(isClassified(leeg)).toBe(false);
    expect(classificationFullLabel(leeg)).toBe("Niet geclassificeerd");
    // Er verdwijnt niets en er wordt niets geraden.
    expect(classificationFromAccount(leeg)).toEqual(EMPTY_CLASSIFICATION);
    expect(classificationConflicts(leeg)).toEqual([]);
  });

  it("7b. een opgeslagen waarde die deze versie niet kent wordt gemeld, niet gewist", () => {
    const vreemd = {
      statement_type: "balans",
      report_group: "vlottende_activa",
      report_subgroup: "iets_onbekends",
    };
    expect(classificationConflicts(vreemd)).toEqual(["unknown_subgroup"]);
    // Het formulier biedt hem niet opnieuw aan …
    expect(classificationFromAccount(vreemd).reportSubgroup).toBeNull();
    // … en er is een leesbare melding voor het scherm.
    expect(CLASSIFICATION_CONFLICT_LABELS.unknown_subgroup).toBeTruthy();
  });

  it("7c. een groep die niet bij haar opgeslagen categorie hoort, wordt als conflict gemeld", () => {
    expect(classificationConflicts({
      statement_type: "balans",
      report_group: "vaste_activa",
      report_subgroup: "liquide_middelen",
    })).toEqual(["subgroup_not_in_group"]);
    expect(classificationConflicts({
      statement_type: "balans",
      report_subgroup: "liquide_middelen",
    })).toEqual(["subgroup_without_group"]);
  });
});

describe("normale zijde is metadata, geen berekening", () => {
  it("8. de voorstellen volgen de taxonomie en raken geen enkele boeking", () => {
    expect(defaultNormalSideFor("vaste_activa", null)).toBe("debet");
    expect(defaultNormalSideFor("vlottende_activa", "liquide_middelen")).toBe("debet");
    expect(defaultNormalSideFor("eigen_vermogen", null)).toBe("credit");
    expect(defaultNormalSideFor("voorzieningen", null)).toBe("credit");
    expect(defaultNormalSideFor("langlopende_schulden", null)).toBe("credit");
    expect(defaultNormalSideFor("kortlopende_schulden", null)).toBe("credit");
    // Privé loopt binnen één categorie beide kanten op.
    expect(defaultNormalSideFor("prive", "prive_opnamen")).toBe("debet");
    expect(defaultNormalSideFor("prive", "prive_stortingen")).toBe("credit");
    // W&V krijgt geen voorstel: baten en lasten lopen per groep beide kanten op.
    expect(defaultNormalSideFor("netto_omzet", "omzet_hoog_tarief")).toBeNull();
  });

  it("8b. een voorstel vult alleen een LEEG veld en overschrijft nooit een keuze", () => {
    const leeg = form({ statementType: "balans", reportGroup: "vlottende_activa" });
    expect(onReportSubgroupChange(leeg, "liquide_middelen").normalSide).toBe("debet");

    const gekozen = form({
      statementType: "balans", reportGroup: "vlottende_activa", normalSide: "credit",
    });
    expect(onReportSubgroupChange(gekozen, "liquide_middelen").normalSide).toBe("credit");
  });

  it("8c. de zijde komt nergens in een bedrag of een saldo terecht", () => {
    const lib = readFileSync(resolve(process.cwd(), "src/lib/reporting-classification.ts"), "utf8");
    const libCode = lib
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(libCode).not.toMatch(/debit_amount|credit_amount|signedAmount|Cents|saldo/i);
    expect(migration.replace(/COMMENT ON[\s\S]*?;/g, "")).not.toMatch(/ledger_postings/i);
  });
});

describe("het voorbeeld uit de opdracht, zonder één regel rekeningnummerlogica", () => {
  it("een bankrekening is te classificeren als Vlottende activa → Liquide middelen → Debet", () => {
    let f = form();
    f = onStatementTypeChange(f, "balans");
    f = onReportGroupChange(f, "vlottende_activa");
    f = onReportSubgroupChange(f, "liquide_middelen");

    expect(validateClassification(f)).toEqual({});
    expect(buildClassificationPayload(f)).toEqual({
      statement_type: "balans",
      report_group: "vlottende_activa",
      report_subgroup: "liquide_middelen",
      normal_side: "debet",
      report_sort: null,
    });
    expect(classificationFullLabel({
      statement_type: "balans",
      report_group: "vlottende_activa",
      report_subgroup: "liquide_middelen",
    })).toBe("Balans · Vlottende activa · Liquide middelen");
  });

  it("het rekeningnummer speelt daarbij geen enkele rol", () => {
    // Dezelfde uitkomst, welk nummer de rekening ook draagt: het nummer komt
    // in de hele keten niet voor.
    const payload = buildClassificationPayload(
      form({
        statementType: "balans",
        reportGroup: "vlottende_activa",
        reportSubgroup: "liquide_middelen",
      }),
    );
    expect(payload.report_subgroup).toBe("liquide_middelen");
    expect(JSON.stringify(payload)).not.toMatch(/1100|\bnummer\b/);
  });

  it("wisselen van categorie laat een groep nooit meeliften", () => {
    const start = form({
      statementType: "balans",
      reportGroup: "vlottende_activa",
      reportSubgroup: "liquide_middelen",
    });
    expect(onReportGroupChange(start, "vaste_activa").reportSubgroup).toBeNull();
    expect(onStatementTypeChange(start, "winst_verlies").reportSubgroup).toBeNull();
    // En terug naar "niet geclassificeerd" wist alles.
    expect(onStatementTypeChange(start, null)).toEqual(EMPTY_CLASSIFICATION);
  });
});

describe("de grenzen van deze branch", () => {
  function changedFiles(): string[] | null {
    try {
      return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      return null;
    }
  }

  it("14. de bestaande rapportageberekening is niet aangeraakt", () => {
    const changed = changedFiles();
    if (!changed) return;
    for (const kern of [
      "src/lib/ledger-reporting.ts",
      "src/lib/financial-statements.ts",
      "src/lib/financial-statements-presentation.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/ledger-completeness.ts",
    ]) {
      expect(changed, kern).not.toContain(kern);
    }
  });

  it("15. geen boeking, geen schrijver en geen bestaande migratie is gewijzigd", () => {
    const changed = changedFiles();
    if (!changed) return;
    const bestaand = new Set(
      execFileSync("git", ["ls-tree", "--name-only", "origin/main", `${MIGRATION_DIR}/`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean),
    );
    expect(changed.filter((f) => f.startsWith(`${MIGRATION_DIR}/`) && bestaand.has(f))).toEqual([]);
    expect(own).toHaveLength(1);
  });

  it("18. types.ts is niet met de hand gewijzigd en er is geen afhankelijkheid bij", () => {
    const changed = changedFiles();
    if (!changed) return;
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed).not.toContain("package-lock.json");
  });

  it("18b. de migratie noemt alleen het juiste project en draagt haar rollback", () => {
    expect(rawMigration).toMatch(/-- rollback/);
    expect(rawMigration).toContain("alxlbdhpbwlehbdbfejw");
    expect(rawMigration).not.toContain("olumcwneiejjefhkzgmz");
    expect(rawMigration).not.toContain("ycuofllsdssoezwwpqmv");
    // Alleen deze ene tabel.
    for (const tabel of (migration.match(/public\.[a-z_]+/g) ?? [])) {
      expect(tabel).toBe("public.grootboekrekeningen");
    }
  });
});
