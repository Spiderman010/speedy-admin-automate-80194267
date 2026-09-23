import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * 6C-b11 PR C — de boekingsblokkade, los van de jaarafsluiting.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/posting-lock/` en draait tegen een echte
 * PostgreSQL (41 bewijzen): de grensgevallen van de helper, de rolvloer, de
 * verplichte reden, de idempotentie, de atomiciteit, en — het punt van deze PR
 * — dat een afgesloten boekjaar en een boekingsblokkade werkelijk los van
 * elkaar bestaan.
 *
 * Dit bestand bewaakt de VORM, en vooral de belofte die PR C onderscheidt van
 * PR D: **geen enkele schrijver toetst deze blokkade al**.
 */

const MIGRATION_SLUG = "_add_posting_lock_foundation.sql";
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

/** Zonder de `COMMENT ON … IS '…'`-teksten: uitvoerbaar, maar inhoudelijk proza. */
const code = sql.replace(/COMMENT ON [^;]*;/g, "");

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

function functie(naam: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${naam}`);
  if (start < 0) return "";
  const volgende = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
  return sql.slice(start, volgende < 0 ? undefined : volgende);
}

describe("Migratie — de boekingsblokkade", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempelprefix", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_add_posting_lock_foundation\.sql$/);
  });

  it("2. voegt precies één kolom toe aan clients, zonder default", () => {
    const alters = [...sql.matchAll(/ALTER TABLE public\.clients[^;]*/g)].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    // Eén ADD COLUMN plus de ENABLE ALWAYS van de grendel; verder niets.
    expect(alters).toHaveLength(2);
    expect(flat).toContain("ADD COLUMN IF NOT EXISTS posting_locked_through date NULL");
    expect(flat).not.toMatch(/posting_locked_through date[^;]*DEFAULT/);
  });

  it("3. maakt exact één nieuwe tabel: posting_lock_events", () => {
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(["posting_lock_events"]);
  });

  it("4. BACKFILLT NIETS — niet uit afgesloten_boekjaar, niet uit year_closures", () => {
    /*
     * Zou dit wel gebeuren, dan voerde de migratie stilzwijgend een
     * beheersmaatregel in die niemand heeft ingesteld — en bestendigde zij
     * precies de verwarring tussen jaarstatus en schrijfverbod die deze hele
     * herziening opheft.
     */
    /*
     * De schrijver zet de kolom natuurlijk wél — dat is zijn taak. Wat er niet
     * mag zijn, is een massa-update op migratieniveau. Elke UPDATE op clients
     * moet dus binnen set_posting_lock() staan én precies één rij raken.
     */
    const updates = [...sql.matchAll(/UPDATE public\.clients[^;]*/g)].map((m) => m[0].replace(/\s+/g, " "));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toBe(
      "UPDATE public.clients c SET posting_locked_through = _locked_through WHERE c.id = _client_id",
    );
    expect(sql.indexOf("UPDATE public.clients")).toBeGreaterThan(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.set_posting_lock"),
    );
    // En de gebeurtenis wordt uit ARGUMENTEN geschreven, niet uit een bestaande
    // tabel gelezen. Alleen het INSERT-statement zelf bekijken: verderop in de
    // functie staat gewoon een RETURN QUERY SELECT, en een lui `[\s\S]*?` zou
    // daar overheen lopen en altijd afgaan.
    const insert = sql.slice(sql.indexOf("INSERT INTO public.posting_lock_events"));
    const statement = insert.slice(0, insert.indexOf(";") + 1).replace(/\s+/g, " ");
    expect(statement).toContain("VALUES (_client_id, v_org, v_client.posting_locked_through, _locked_through, v_uid, v_reason)");
    expect(statement).not.toMatch(/\bSELECT\b/);
    expect(code).not.toMatch(/afgesloten_boekjaar/);
    expect(code).not.toMatch(/year_closures|fiscal_year_events/);
    // De enige INSERT-vorm in deze migratie staat binnen de schrijver.
    const inserts = [...sql.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["posting_lock_events"]);
  });

  it("5. de reden is verplicht, trim-bewust en begrensd", () => {
    expect(flat).toContain("reason text NOT NULL");
    expect(flat).toContain("CHECK (btrim(reason, E' \\t\\r\\n') <> '' AND length(reason) <= 500)");
  });

  it("6. een gebeurtenis zonder wijziging kan niet bestaan", () => {
    // Zo is "geen auditruis" een databaseregel in plaats van een afspraak.
    expect(flat).toContain(
      "CHECK (new_locked_through IS DISTINCT FROM previous_locked_through)",
    );
  });

  it("7. tenantintegriteit, onuitwisbaarheid en rechten volgen het bestaande model", () => {
    expect(flat).toMatch(/posting_client_org_ok\(NEW\.client_id, NEW\.organization_id\)/);
    expect(flat).toMatch(/BEFORE INSERT ON public\.posting_lock_events/);
    expect(flat).toMatch(/BEFORE UPDATE OR DELETE ON public\.posting_lock_events/);
    expect(flat).toMatch(/BEFORE TRUNCATE ON public\.posting_lock_events/);
    expect(flat).toMatch(
      /ALTER TABLE public\.posting_lock_events ENABLE ALWAYS TRIGGER prevent_posting_lock_event_mutation_trigger/,
    );
    expect(flat).toMatch(
      /ALTER TABLE public\.posting_lock_events ENABLE ALWAYS TRIGGER prevent_posting_lock_event_truncate_trigger/,
    );
    expect(flat).toMatch(/has_min_role\(auth\.uid\(\), organization_id, 'read_only'\)/);
    expect(flat).toMatch(/REVOKE ALL ON public\.posting_lock_events FROM anon, authenticated, service_role/);
    expect(flat).toMatch(/GRANT SELECT ON public\.posting_lock_events TO authenticated, service_role/);
    expect(flat).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* ON public\.posting_lock_events/);
  });

  it("8. de kolom kan alleen via de schrijver bewegen, met een zegel uit dezelfde transactie", () => {
    /*
     * `authenticated` heeft vanaf de rol ASSISTENT gewoon UPDATE op clients
     * (role_clients_update, 20260613001452), dus zonder deze grendel kon een
     * assistent de blokkade met één update opheffen.
     *
     * Het transactiezegel is load-bearing: zonder `created_xact_id` zou na
     * A → B → A een oude A→B-gebeurtenis een latere handmatige update naar B
     * kunnen dekken.
     */
    const guard = functie("enforce_posting_lock_change").replace(/\s+/g, " ");
    expect(guard).toContain("e.previous_locked_through IS NOT DISTINCT FROM OLD.posting_locked_through");
    expect(guard).toContain("e.new_locked_through IS NOT DISTINCT FROM NEW.posting_locked_through");
    expect(guard).toContain("e.created_xact_id = pg_current_xact_id()");
    expect(flat).toMatch(/BEFORE UPDATE OF posting_locked_through ON public\.clients/);
    expect(flat).toMatch(
      /ALTER TABLE public\.clients ENABLE ALWAYS TRIGGER enforce_posting_lock_change_trigger/,
    );
  });
});

describe("posting_allowed() — de grenssemantiek", () => {
  const helper = functie("posting_allowed").replace(/\s+/g, " ");

  it("9. is STABLE, SECURITY DEFINER met vast zoekpad, en niet aan iemand verleend", () => {
    expect(helper).toContain("RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public");
    expect(flat).toMatch(/REVOKE ALL ON FUNCTION public\.posting_allowed\(uuid, date\) FROM PUBLIC/);
    expect(flat).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.posting_allowed/);
  });

  it("10. de grens ligt ERÓP: de blokkadedatum zelf mag niet meer", () => {
    // `>` en niet `>=`: "dicht t/m 31-12-2024" betekent dat die dag zelf dicht
    // is. Dit is de plek waar een off-by-one zou ontstaan.
    expect(helper).toContain("_posting_date > c.posting_locked_through");
    expect(helper).not.toContain("_posting_date >= c.posting_locked_through");
  });

  it("11. faalt gesloten op alles wat niet te beoordelen is", () => {
    expect(helper).toContain("WHEN _client_id IS NULL OR _posting_date IS NULL THEN false");
    // Een onbekende administratie levert geen NULL maar false.
    expect(helper).toContain("COALESCE(");
    expect(helper).toContain("false)");
  });
});

describe("set_posting_lock() — de schrijver", () => {
  const writer = functie("set_posting_lock");
  const f = writer.replace(/\s+/g, " ");

  it("12. is SECURITY DEFINER met vast zoekpad, en alleen voor authenticated", () => {
    expect(f).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public");
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_posting_lock\(uuid, date, text\) FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_posting_lock\(uuid, date, text\) TO authenticated/,
    );
  });

  it("13. rolvloer accountant voor élke richting, en geen owner-only", () => {
    expect(f).toContain("has_min_role(v_uid, v_org, 'accountant')");
    expect(writer).not.toMatch(/'owner'/);
    // Eén vloer voor zetten, verschuiven én opheffen: geen tweede rangorde.
    expect((writer.match(/has_min_role\(v_uid, v_org, 'accountant'\)/g) ?? [])).toHaveLength(1);
  });

  it("14. authenticatie vóór elke lezing, en geen tenantorakel", () => {
    const uid = writer.indexOf("v_uid IS NULL");
    const lees = writer.indexOf("has_min_role(v_uid, v_org, 'read_only')");
    const schrijf = writer.indexOf("has_min_role(v_uid, v_org, 'accountant')");
    const grendel = writer.indexOf("lock_ledger_client");
    expect(uid).toBeGreaterThan(-1);
    expect(uid).toBeLessThan(lees);
    expect(lees).toBeLessThan(schrijf);
    expect(schrijf).toBeLessThan(grendel);
    expect(writer).toMatch(
      /IF v_org IS NULL OR NOT public\.has_min_role\(v_uid, v_org, 'read_only'\) THEN\s+RAISE EXCEPTION 'Administratie niet beschikbaar'/,
    );
  });

  it("15. de reden wordt genormaliseerd vóór elke controle", () => {
    expect(f).toContain("v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \\t\\r\\n'), '')");
    expect(f).toContain("vereist een reden");
  });

  it("16. de canonieke administratiegrendel en de rijgrendel, in die volgorde", () => {
    const grendel = writer.indexOf("PERFORM public.lock_ledger_client(_client_id);");
    const rij = writer.indexOf("FOR UPDATE");
    expect(grendel).toBeGreaterThan(-1);
    expect(grendel).toBeLessThan(rij);
    expect(writer).not.toMatch(/pg_advisory/);
  });

  it("17. dezelfde waarde opnieuw is een no-op — NULL telt daarbij als waarde", () => {
    expect(f).toContain("IF _locked_through IS NOT DISTINCT FROM v_client.posting_locked_through THEN");
    const noop = writer.slice(
      writer.indexOf("IF _locked_through IS NOT DISTINCT FROM"),
      writer.indexOf("INSERT INTO public.posting_lock_events"),
    );
    // Op die tak wordt niets geschreven en wordt teruggekeerd.
    expect(noop).not.toMatch(/INSERT|UPDATE/);
    expect(noop).toMatch(/\bRETURN;/);
  });

  it("18. de gebeurtenis staat vóór de kolom, met één tijdstip en één actor", () => {
    const gebeurtenis = writer.indexOf("INSERT INTO public.posting_lock_events");
    const kolom = writer.indexOf("UPDATE public.clients c");
    expect(gebeurtenis).toBeGreaterThan(-1);
    expect(kolom).toBeGreaterThan(gebeurtenis);
    // Het retour komt uit de weggeschreven rij, niet uit een tweede now().
    const schrijfblok = writer.slice(gebeurtenis);
    expect(schrijfblok).toContain("RETURNING * INTO v_event");
    expect(schrijfblok).toContain("v_event.changed_at");
    expect(schrijfblok).toContain("v_event.changed_by");
    expect(schrijfblok).not.toMatch(/now\(\)|clock_timestamp|auth\.uid\(\)/);
  });
});

describe("PR C raakt het bestaande gedrag niet aan", () => {
  it("19. GEEN ENKELE SCHRIJVER TOETST DE BLOKKADE — dat is PR D", () => {
    // De belofte die deze PR onderscheidt van de volgende: `posting_allowed()`
    // bestaat, maar wordt door niemand aangeroepen.
    expect(sql).not.toMatch(/post_purchase_invoice|post_sales_invoice|post_bank|post_manual_journal/);
    expect(sql).not.toMatch(/post_opening_balance|declare_opening_balance_nil|reverse_posting_group/);
    expect(sql).not.toMatch(/bank_bulk_posting_candidates|post_bank_transactions_bulk/);
    expect(sql).not.toMatch(/ledger_postings/);
    // De helper wordt binnen deze migratie nergens aangeroepen.
    const aanroepen = [...sql.matchAll(/posting_allowed\(/g)].length;
    const definitie = [...sql.matchAll(/FUNCTION public\.posting_allowed\(/g)].length;
    expect(aanroepen).toBe(definitie);
  });

  it("20. close_fiscal_year() wordt niet aangeraakt en niet aangeroepen", () => {
    expect(code).not.toMatch(/close_fiscal_year/);
    expect(changed).not.toContain("supabase/migrations/20260924120000_add_year_close_writer.sql");
    expect(changed).not.toContain("supabase/migrations/20260926120000_close_writes_fiscal_year_event.sql");
  });

  it("21. geen heropening, en de watermerkgrendel blijft ongemoeid", () => {
    const functies = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    expect(functies.sort()).toEqual([
      "enforce_posting_lock_change",
      "enforce_posting_lock_event_org",
      "posting_allowed",
      "prevent_posting_lock_event_mutation",
      "set_posting_lock",
    ]);
    expect(functies.filter((naam) => /reopen|heropen/i.test(naam))).toEqual([]);
    expect(code).not.toMatch(/enforce_year_close_watermark|prevent_year_closure_mutation/);
  });

  it("22. de eerdere migraties en de bestaande schrijvers blijven onaangeroerd", () => {
    changed
      .filter((f) => f.startsWith("supabase/migrations/"))
      .forEach((f) => expect(f).toBe(MIGRATION));
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("23. de app is niet aangeraakt en de gegenereerde types evenmin", () => {
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  it("24. de koppelingstest is bijgewerkt zoals zij zelf voorschreef", () => {
    /*
     * `year-close-coupling.test.ts` legde vast: "acht kopieën, nul helpers —
     * zodra die helper er komt, hoort deze test te worden herschreven." PR C
     * maakt die helper, dus die ene assertie IS herschreven, naar de scherpere
     * invariant die PR C van PR D scheidt: de helper bestaat, maar geen
     * schrijver gebruikt hem.
     *
     * De acht schrijvers en hun toets blijven daar onveranderd vastgepind.
     */
    const koppeling = readFileSync(
      resolve(process.cwd(), "src/test/year-close-coupling.test.ts"),
      "utf8",
    );
    // Bij PR D is diezelfde assertie nóg een keer meegegroeid — van "geen
    // schrijver gebruikt hem" naar "elke gedateerde schrijver gebruikt hem,
    // behalve de nihil-verklaring". Wat hier telt is dat de test MEEBEWEEGT en
    // dat de achterhaalde formuleringen verdwijnen in plaats van te blijven
    // staan naast de nieuwe.
    expect(koppeling).toMatch(/gedeelde bewering|gedeelde helper/);
    expect(koppeling).not.toContain("er bestaat vandaag GEEN gedeelde helper");
    expect(koppeling).not.toContain("maar GEEN schrijver gebruikt hem");
  });
});
