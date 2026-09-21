import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PURCHASE_POSTABLE_STATUSES, SALES_POSTABLE_STATUSES } from "@/lib/ledger-completeness";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * Fase 6C-b10 — de jaarafsluiting.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Wat de DATABASE doet — triggers, rechten, grendels, atomiciteit, idempotentie
 * en twee werkelijk gelijktijdige sessies — is niet met een reguliere expressie
 * te bewijzen. Dat staat in `supabase/tests/year-close/` en draait tegen een
 * echte PostgreSQL (42 bewijzen). Dit bestand bewaakt wat daar juist NIET te
 * zien is:
 *
 *   • dat de migratie blijft zeggen wat zij hoort te zeggen;
 *   • dat de postbaarheidsregels in SQL exact die van de applicatie zijn —
 *     de constanten daarvoor staan in TypeScript, dus die vergelijking kan
 *     alleen hier;
 *   • dat er geen weg terug is ingeslopen (heropenen, resultaatboeking, doorrol);
 *   • dat het klantformulier het watermerk niet meer schrijft.
 */

const MIGRATION_SLUG = "_add_year_close_writer.sql";
const MIGRATION_DIR = "supabase/migrations";
const ownMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) =>
  f.endsWith(MIGRATION_SLUG),
);
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

/**
 * Commentaar weg: een bewering over de CODE mag nooit op proza slagen. Deze
 * migratie legt in haar toelichting juist uit wat zij NIET doet — "geen
 * resultaatboeking", "nooit created_at" — dus een test die het onbewerkte
 * bestand leest, zou op precies die zinnen kunnen slagen terwijl de code het
 * tegenovergestelde deed.
 */
const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const flat = sql.replace(/\s+/g, " ");

/** Alleen de body van de schrijver, zonder de tabel- en triggerdefinities. */
const writer = sql.slice(
  sql.indexOf("CREATE OR REPLACE FUNCTION public.close_fiscal_year"),
  // Tot aan de rechtenverlening: de COMMENT ON FUNCTION daarna is uitvoerbare
  // SQL, maar inhoudelijk proza — zij legt juist uit wat de schrijver NIET doet
  // ("geen resultaatbestemming en geen doorrol") en zou elke assertie over het
  // ontbreken van die woorden vals laten falen.
  sql.indexOf("REVOKE ALL ON FUNCTION public.close_fiscal_year"),
);

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

describe("Migratie — de jaarafsluiting", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_add_year_close_writer\.sql$/);
  });

  it("2. maakt exact één nieuwe tabel: year_closures", () => {
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["year_closures"]);
  });

  it("3. (client_id, fiscal_year) is de identiteit — één jaar, hoogstens één afsluiting", () => {
    expect(flat).toMatch(/CONSTRAINT year_closures_pkey PRIMARY KEY \(client_id, fiscal_year\)/);
  });

  it("4. de marker draagt geen boekingsverwijzing en geen resultaatbedrag", () => {
    // Er wordt geen boeking gemaakt, dus er is niets om naar te verwijzen. En
    // result_cents is bewust weggelaten: het zou een tweede boekhoudmotor
    // vereisen (de classificatie is nullable) en zou verouderen zodra die
    // classificatie later wordt gecorrigeerd.
    for (const veld of [
      "result_posting_group_id",
      "destination_account_id",
      "carry_forward_id",
      "result_cents",
      "source_id",
    ]) {
      expect(sql, veld).not.toContain(veld);
    }
  });

  it("5. tenantintegriteit leunt niet op RLS maar op de bewezen orakelfunctie", () => {
    expect(flat).toMatch(/posting_client_org_ok\(NEW\.client_id, NEW\.organization_id\)/);
    expect(flat).toMatch(/BEFORE INSERT ON public\.year_closures/);
    // De drie verwijzingen mogen nooit meegecascadeerd worden.
    expect(flat.match(/REFERENCES public\.\w+ \(id\) ON DELETE RESTRICT/g) ?? []).toHaveLength(2);
    expect(flat).toMatch(/REFERENCES auth\.users \(id\) ON DELETE RESTRICT/);
  });

  it("6. de marker is append-only, ook tegen TRUNCATE en ook onder session_replication_role", () => {
    expect(flat).toMatch(/BEFORE UPDATE OR DELETE ON public\.year_closures/);
    expect(flat).toMatch(/BEFORE TRUNCATE ON public\.year_closures/);
    expect(flat).toMatch(
      /ALTER TABLE public\.year_closures ENABLE ALWAYS TRIGGER prevent_year_closure_mutation_trigger/,
    );
    expect(flat).toMatch(
      /ALTER TABLE public\.year_closures ENABLE ALWAYS TRIGGER prevent_year_closure_truncate_trigger/,
    );
  });

  it("7. applicatierollen mogen de marker alleen lezen", () => {
    expect(flat).toMatch(/ALTER TABLE public\.year_closures ENABLE ROW LEVEL SECURITY/);
    expect(flat).toMatch(/REVOKE ALL ON public\.year_closures FROM anon, authenticated, service_role/);
    expect(flat).toMatch(/GRANT SELECT ON public\.year_closures TO authenticated, service_role/);
    // Geen enkele directe schrijfrechtverlening op de markertabel.
    expect(flat).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* ON public\.year_closures/);
  });
});

describe("De schrijver — beveiliging en grendels", () => {
  it("8. SECURITY DEFINER met een vastgezet zoekpad, en EXECUTE alleen voor authenticated", () => {
    expect(writer.replace(/\s+/g, " ")).toMatch(
      /RETURNS TABLE \([^)]*\) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/,
    );
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.close_fiscal_year\(uuid, integer\) FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.close_fiscal_year\(uuid, integer\) TO authenticated/);
  });

  it("9. authenticatie vóór elke lezing, en dezelfde fout voor 'bestaat niet' en 'geen rechten'", () => {
    const uid = writer.indexOf("v_uid IS NULL");
    const leesdrempel = writer.indexOf("has_min_role(v_uid, v_org, 'read_only')");
    const schrijfdrempel = writer.indexOf("has_min_role(v_uid, v_org, 'accountant')");
    const grendel = writer.indexOf("lock_ledger_client");

    expect(uid).toBeGreaterThan(-1);
    expect(uid).toBeLessThan(leesdrempel);
    expect(leesdrempel).toBeLessThan(schrijfdrempel);
    // De grendel wordt pas genomen als de aanroeper bevoegd is: een
    // buitenstaander mag geen administratie kunnen laten wachten.
    expect(schrijfdrempel).toBeLessThan(grendel);

    // Eén tekst voor beide gevallen — anders is het verschil een orakel.
    expect(writer).toMatch(
      /IF v_org IS NULL OR NOT public\.has_min_role\(v_uid, v_org, 'read_only'\) THEN\s+RAISE EXCEPTION 'Administratie niet beschikbaar'/,
    );
  });

  it("10. de rolvloer is accountant, net als memoriaal, beginbalans en tegenboeking", () => {
    expect(writer).toContain("'accountant'");
    for (const lager of ["'assistant'", "'read_only')  -- schrijf"]) {
      expect(writer.includes(`has_min_role(v_uid, v_org, ${lager})`)).toBe(false);
    }
  });

  it("11. de canonieke administratiegrendel, geen eigen sleutelalgoritme", () => {
    expect(writer).toContain("PERFORM public.lock_ledger_client(_client_id);");
    expect(writer).not.toMatch(/pg_advisory/);
    expect(writer).not.toMatch(/ledger_client_lock_key/);
  });

  it("12. de grendel wordt genomen vóór er iets veranderlijks wordt gelezen", () => {
    const grendel = writer.indexOf("lock_ledger_client");
    const rijgrendel = writer.indexOf("FOR UPDATE");
    const marker = writer.indexOf("FROM public.year_closures yc");
    expect(grendel).toBeLessThan(rijgrendel);
    expect(rijgrendel).toBeLessThan(marker);
  });

  it("13. het bewijs wordt geschreven vóór het watermerk, in één transactie", () => {
    const insert = writer.indexOf("INSERT INTO public.year_closures");
    const update = writer.indexOf("UPDATE public.clients");
    expect(insert).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(insert);
    // Geen eigen transactiebeheer: de RPC is zelf de transactie.
    expect(writer).not.toMatch(/\bCOMMIT\b|\bROLLBACK\b|SET TRANSACTION/);
  });
});

describe("De schrijver — wat hij herkeurt", () => {
  it("14. de postbare statussen zijn letterlijk die van de applicatie", () => {
    const inkoop = PURCHASE_POSTABLE_STATUSES.map((s) => `'${s}'`).join(", ");
    const verkoop = SALES_POSTABLE_STATUSES.map((s) => `'${s}'`).join(", ");
    expect(writer.replace(/\s+/g, " ")).toContain(`pi.status IN (${inkoop})`);
    expect(writer.replace(/\s+/g, " ")).toContain(`si.status IN (${verkoop})`);
  });

  it("15. verkoop met btw_verlegd telt niet mee — de schrijver weigert die sowieso", () => {
    expect(writer.replace(/\s+/g, " ")).toContain("si.btw_verlegd = false");
  });

  it("16. een aflettering telt alleen als de FACTUUR al geboekt is", () => {
    const f = writer.replace(/\s+/g, " ");
    expect(f).toMatch(
      /a\.invoice_type = 'inkoop' THEN EXISTS \(SELECT 1 FROM public\.purchase_invoice_postings p WHERE p\.purchase_invoice_id = a\.invoice_id\)/,
    );
    expect(f).toMatch(
      /ELSE EXISTS \(SELECT 1 FROM public\.sales_invoice_postings s WHERE s\.sales_invoice_id = a\.invoice_id\)/,
    );
  });

  it("17. het boekjaar komt uit de boekhoudkundige datum en NOOIT uit created_at", () => {
    for (const kolom of ["pi.invoice_date", "si.invoice_date", "bt.transaction_date", "mj.posting_date"]) {
      expect(writer, kolom).toContain(`EXTRACT(YEAR FROM ${kolom})::integer`);
    }
    // Gericht op veldgebruik, niet op het woord: de toelichting zegt juist
    // "NOOIT created_at", en die staat hier al niet meer in.
    expect(writer).not.toMatch(/\bcreated_at\b/);
  });

  it("18. ontbrekende boekhoudkundige datum faalt gesloten in plaats van te raden", () => {
    expect(writer.replace(/\s+/g, " ")).toContain("count(*) FILTER (WHERE p.boekjaar IS NULL)");
    expect(writer).toContain("IF v_dateless > 0 THEN");
    // Geen enkele vorm van raden.
    expect(writer).not.toMatch(/COALESCE\([^)]*boekjaar[^)]*,\s*\d{4}\)/);
  });

  it("19. een leeg ouder boekjaar blokkeert niet — alleen jaren MET boekingen tellen", () => {
    expect(writer.replace(/\s+/g, " ")).toMatch(
      /array_agg\(DISTINCT lp\.boekjaar ORDER BY lp\.boekjaar\) INTO v_open_years FROM public\.ledger_postings lp WHERE lp\.client_id = _client_id AND lp\.boekjaar < _fiscal_year/,
    );
  });

  it("20. later bronwerk blokkeert niet: alleen t/m het doeljaar telt", () => {
    expect(writer.replace(/\s+/g, " ")).toContain(
      "count(*) FILTER (WHERE p.boekjaar IS NOT NULL AND p.boekjaar <= _fiscal_year)",
    );
  });

  it("21. presentatiewaarschuwingen zijn GEEN databaseblokkade", () => {
    // Classificatie, subgroepen en beginbalans maken een rapport onvolledig,
    // niet het grootboek onjuist. Ze in SQL blokkerend maken zou een norm
    // verzinnen die dit product niet kent.
    for (const woord of ["statement_type", "report_group", "report_subgroup", "opening_balances"]) {
      expect(writer, woord).not.toContain(woord);
    }
  });
});

describe("De schrijver — wat hij nooit doet", () => {
  it("22. geen enkele grootboekregel, geen boekingsgroep, geen doorrol", () => {
    expect(writer).not.toMatch(/INSERT INTO public\.ledger_postings/);
    expect(writer).not.toMatch(/carry_forward|doorrol/i);
    // posting_group_id komt wel voor — de schrijver TELT boekingsgroepen in
    // controle C — maar mag nooit in een INSERT staan.
    for (const statement of writer.match(/INSERT INTO public\.\w+[^;]*/g) ?? []) {
      expect(statement).not.toMatch(/posting_group_id/);
    }
    // De hele migratie schrijft in precies één tabel.
    const inserts = [...sql.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(inserts)]).toEqual(["year_closures"]);
  });

  it("23. nergens een resultaatrekening, langs geen enkele weg afgeleid", () => {
    expect(sql).not.toMatch(/grootboekrekening/i);
    expect(sql).not.toMatch(/\b999[89]\b/);
    expect(sql).not.toMatch(/resultaat_rekening|eigen_vermogen|equity/i);
    // Ook niet op nummer, naam, categorie of omschrijving.
    expect(sql).not.toMatch(/\.\s*(nummer|omschrijving|categorie)\b/);
  });

  it("24. geen heropening: geen RPC, geen markermutatie, geen watermerkverlaging", () => {
    // Gericht op wat er WORDT GEDEFINIEERD, niet op het woord: de
    // foutmeldingen van de migratie zeggen juist "wordt niet heropend", en dat
    // is precies de zin die hier moet kunnen blijven staan.
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.filter((naam) => /reopen|heropen/i.test(naam))).toEqual([]);
    expect(sql).not.toMatch(/DELETE FROM public\.year_closures/);
    expect(sql).not.toMatch(/UPDATE public\.year_closures/);
    // De enige UPDATE in de hele migratie is die van het watermerk zelf.
    const updates = [...sql.matchAll(/UPDATE public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(updates)]).toEqual(["clients"]);
  });

  it("25. het watermerk kan per constructie alleen vooruit, en alleen mét bewijs", () => {
    const trigger = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_year_close_watermark"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.enforce_year_close_watermark()"),
    );
    expect(trigger.replace(/\s+/g, " ")).toContain(
      "NEW.afgesloten_boekjaar IS NULL OR NEW.afgesloten_boekjaar < OLD.afgesloten_boekjaar",
    );
    expect(trigger.replace(/\s+/g, " ")).toContain(
      "SELECT 1 FROM public.year_closures yc WHERE yc.client_id = NEW.id AND yc.fiscal_year = NEW.afgesloten_boekjaar",
    );
    expect(flat).toMatch(/BEFORE UPDATE OF afgesloten_boekjaar ON public\.clients/);
    expect(flat).toMatch(
      /ALTER TABLE public\.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger/,
    );
  });

  it("26. de generieke tegenboekingsmotor wordt niet aangeraakt", () => {
    expect(changed).not.toContain("supabase/migrations/20260921120000_add_ledger_reversal_posting.sql");
    expect(sql).not.toMatch(/reverse_posting_group|ledger_reversal_postings/);
  });
});

describe("De applicatie schrijft het watermerk niet meer", () => {
  const klanten = readFileSync(resolve(process.cwd(), "src/pages/Klanten.tsx"), "utf8");
  /** Commentaar weg: de uitleg bij deze wijziging noemt het veld juist wél. */
  const code = klanten
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("27. het klantformulier stuurt afgesloten_boekjaar niet meer mee", () => {
    // Het veld mag nog wel worden UITGELEZEN om te tonen; het mag alleen niet
    // meer in de payload staan die naar de database gaat.
    expect(code).not.toMatch(/afgesloten_boekjaar:\s*toIntOrNull/);
    expect(code).not.toMatch(/afgesloten_boekjaar:\s*form\./);
  });

  it("28. en biedt er geen invoerveld meer voor aan", () => {
    expect(code).not.toMatch(/id="afgesloten_boekjaar"/);
    expect(code).not.toMatch(/afgesloten_boekjaar:\s*e\.target\.value/);
  });

  it("29. geen enkele andere plek in de app schrijft het watermerk", () => {
    const bronnen = execFileSync(
      "git",
      ["grep", "-l", "afgesloten_boekjaar", "--", "src/hooks", "src/lib", "src/pages", "src/components"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    for (const bestand of bronnen) {
      const inhoud = readFileSync(resolve(process.cwd(), bestand), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
        .join("\n");
      // Een toewijzing in een objectliteraal is de enige vorm waarin dit veld
      // naar Supabase kan vertrekken. Vandaar: vastleggen WAT er achter de
      // dubbele punt staat, in plaats van een negatieve vooruitblik — die zou
      // met een greedy `\s*` altijd alsnog slagen door één spatie op te geven.
      for (const [, ruw] of inhoud.matchAll(/afgesloten_boekjaar:\s*([^\n,;]*)/g)) {
        const waarde = ruw.trim();
        const toegestaan =
          // een typedeclaratie
          /^(number \| null|number|string)$/.test(waarde) ||
          // de lege beginwaarde van een formulierveld
          waarde === '""' ||
          // het UITLEZEN van de klantrij, om te tonen of door te geven
          waarde.startsWith("client.afgesloten_boekjaar");
        expect(toegestaan, `${bestand}: onbekende toewijzing \`${waarde}\``).toBe(true);
      }
    }
  });
});

describe("Scope van deze branch", () => {
  it("30. de grootboekfundering blijft ongemoeid", () => {
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("31. geen van de bestaande boekingsschrijvers wordt herschreven", () => {
    assertBranchTouchesNoExistingWriter(changed);
  });
});
