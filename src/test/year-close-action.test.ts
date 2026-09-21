import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ALREADY_CLOSED_NOTICE,
  INCONSISTENT_CLOSURE_ADVICE,
  INCONSISTENT_CLOSURE_REASON,
  UNKNOWN_OUTCOME_MESSAGE,
  classifyYearCloseError,
  closeAvailability,
  closeConsequences,
  closureReceiptEntries,
  isTerminal,
  needsReconciliation,
  safeYearCloseErrorMetadata,
  type CloseAvailabilityInput,
  type YearClosure,
} from "@/lib/year-close-action";
import type { YearCloseReadiness, YearCloseStatus } from "@/lib/year-close-readiness";
import { visibleAuditEntries } from "@/lib/platform/audit-trail";

/**
 * Jaarafsluiting PR 2b — de pure laag.
 *
 * Wat hier bewaakt wordt: wanneer de afsluitactie mag worden aangeboden, en
 * wat een gebruiker te zien krijgt als de database weigert. Die twee zijn de
 * enige plekken waar dit scherm een eigen oordeel velt; al het overige is en
 * blijft van `close_fiscal_year()`.
 */

function readiness(status: YearCloseStatus): YearCloseReadiness {
  return {
    clientId: "client-1",
    fiscalYear: 2026,
    status,
    checks: [],
    administrationWide: [],
    unavailable: status === "incomplete" ? ["Grootboekmutaties"] : [],
    summary: { executed: 4, passed: 4, warnings: 0, blocking: 0 },
  };
}

const CLOSURE: YearClosure = {
  client_id: "client-1",
  organization_id: "org-1",
  fiscal_year: 2026,
  closed_at: "2027-01-15T10:30:00.000Z",
  closed_by: "user-1",
};

/** Alles op "mag wel", zodat elke test precies één ding kan omzetten. */
function gereed(overrides: Partial<CloseAvailabilityInput> = {}): CloseAvailabilityInput {
  return {
    fiscalYear: 2026,
    readiness: readiness("ready"),
    closure: null,
    closurePending: false,
    closureUnavailable: false,
    watermark: null,
    canClose: true,
    roleUnavailable: false,
    ...overrides,
  };
}

describe("Wanneer mag er worden afgesloten", () => {
  it("1. zonder gereedheidscontrole is er niets aan te bieden", () => {
    expect(closeAvailability(gereed({ readiness: null })).kind).toBe("no_snapshot");
  });

  it("2-4. blocked, incomplete en warning bieden géén afsluiting aan", () => {
    for (const status of ["blocked", "incomplete", "warning"] as const) {
      const uitkomst = closeAvailability(gereed({ readiness: readiness(status) }));
      expect(uitkomst.kind, status).toBe("not_ready");
      // Elke status krijgt zijn eigen uitleg; geen lege of gedeelde tekst.
      expect(uitkomst.kind === "not_ready" && uitkomst.reason.length, status).toBeGreaterThan(20);
    }
  });

  it("4b. een waarschuwing is bewust geen gereedheid — precies zoals PR 1 vastlegde", () => {
    const uitkomst = closeAvailability(gereed({ readiness: readiness("warning") }));
    expect(uitkomst.kind).toBe("not_ready");
    // De UI blijft strenger dan het minimum dat de database afdwingt: de
    // schrijver blokkeert bijvoorbeeld niet op een onvolledige beginbalans,
    // maar dit scherm biedt bij een waarschuwing gewoon niets aan.
    expect(uitkomst.kind === "not_ready" && uitkomst.reason).toMatch(/open werk/i);
  });

  it("5. alleen `ready` levert een afsluitactie op", () => {
    expect(closeAvailability(gereed()).kind).toBe("available");
  });

  it("6. een onbekende of onleesbare afsluitstatus telt nooit als 'mag wel'", () => {
    expect(closeAvailability(gereed({ closurePending: true })).kind).toBe("unknown");
    expect(closeAvailability(gereed({ closureUnavailable: true })).kind).toBe("unknown");
    expect(closeAvailability(gereed({ canClose: undefined })).kind).toBe("unknown");
    expect(closeAvailability(gereed({ roleUnavailable: true })).kind).toBe("unknown");
  });

  it("7. een te lage rol krijgt uitleg in plaats van een knop", () => {
    const uitkomst = closeAvailability(gereed({ canClose: false }));
    expect(uitkomst.kind).toBe("not_allowed");
    expect(uitkomst.kind === "not_allowed" && uitkomst.reason).toMatch(/accountant/i);
  });

  it("8. een bestaand afsluitbewijs wint van elke gereedheidsuitslag", () => {
    // Ook wanneer iemand de controle er daarna nog een keer overheen draait en
    // die toevallig `ready` zegt: een afgesloten jaar krijgt geen tweede knop.
    for (const status of ["ready", "warning", "blocked", "incomplete"] as const) {
      expect(closeAvailability(gereed({ closure: CLOSURE, readiness: readiness(status) })).kind, status)
        .toBe("already_closed");
    }
  });

  it("9. watermerk zegt dicht maar er is geen bewijs: expliciet inconsistent", () => {
    const uitkomst = closeAvailability(gereed({ watermark: 2026, closure: null }));
    expect(uitkomst.kind).toBe("inconsistent");
    expect(uitkomst.kind === "inconsistent" && uitkomst.reason).toBe(INCONSISTENT_CLOSURE_REASON);
  });

  it("9b. het watermerk is een WATERMERK: ook een ouder jaar telt als dicht", () => {
    expect(closeAvailability(gereed({ fiscalYear: 2024, watermark: 2026 })).kind).toBe("inconsistent");
    // Een jaar ná het watermerk staat gewoon open.
    expect(closeAvailability(gereed({ fiscalYear: 2026, watermark: 2025 })).kind).toBe("available");
  });

  it("9c. een nog onbekend watermerk maakt niets inconsistent", () => {
    expect(closeAvailability(gereed({ watermark: undefined })).kind).toBe("available");
  });
});

describe("Serverfouten worden nooit rauw getoond", () => {
  const geval = (code: string, message: string) => classifyYearCloseError({ code, message });

  it("10. watermerk zonder bewijs krijgt de eigen erfenismelding", () => {
    const f = geval(
      "23514",
      "Boekjaar 2026 staat al als afgesloten (watermerk 2026) maar er is geen bijbehorend afsluitbewijs; dit moet handmatig worden onderzocht.",
    );
    expect(f.kind).toBe("inconsistent_closure");
    expect(f.message).toBe(INCONSISTENT_CLOSURE_REASON);
    expect(f.advice).toBe(INCONSISTENT_CLOSURE_ADVICE);
    // De ruwe databasetekst mag niet doorlekken.
    expect(f.message).not.toMatch(/watermerk 2026|handmatig worden onderzocht/);
  });

  it("11. bewijs zonder watermerk is een eigen, even harde toestand", () => {
    const f = geval(
      "23514",
      "Er bestaat al een afsluitbewijs voor boekjaar 2026, maar het watermerk staat op leeg; dit moet handmatig worden onderzocht.",
    );
    expect(f.kind).toBe("inconsistent_watermark");
    expect(f.advice).toBe(INCONSISTENT_CLOSURE_ADVICE);
  });

  it("12. afsluitvolgorde", () => {
    const f = geval(
      "23514",
      "Er liggen oudere boekjaren met boekingen nog open (2025); boekjaar 2026 afsluiten zou die ongemerkt meenemen.",
    );
    expect(f.kind).toBe("year_order");
    expect(f.advice).toMatch(/oudste/i);
  });

  it("13. ongebalanceerde boekingsgroep", () => {
    const f = geval(
      "23514",
      "Er staat t/m boekjaar 2026 1 ongebalanceerde boekingsgroep(en) in het grootboek; afsluiten zou die onherstelbaar maken.",
    );
    expect(f.kind).toBe("unbalanced_group");
  });

  it("14. openstaand bronwerk", () => {
    const f = geval(
      "23514",
      "Er staat nog 1 postbaar brondocument(en) open met boekjaar t/m 2026; afsluiten zou dat document voorgoed onboekbaar maken.",
    );
    expect(f.kind).toBe("unposted_work");
    expect(f.advice).toMatch(/inhaalslag/i);
  });

  it("15. ontbrekende boekhoudkundige datum — en NIET als openstaand werk", () => {
    // Deze melding bevat zélf de woorden "postbaar brondocument". Werd zij op
    // volgorde ná het openstaande werk getoetst, dan kreeg de accountant het
    // verkeerde advies en ging hij zoeken naar werk dat er niet is.
    const f = geval(
      "23514",
      "Van 1 postbaar brondocument(en) is de boekhoudkundige datum onbekend; het boekjaar kan niet worden vastgesteld en afsluiten is daarom niet veilig.",
    );
    expect(f.kind).toBe("missing_date");
    expect(f.advice).toMatch(/datum/i);
  });

  it("16. rolweigering en tenantweigering delen SQLSTATE maar niet de melding", () => {
    const rol = geval(
      "42501",
      "Geen rechten om een boekjaar af te sluiten voor deze organisatie (accountant vereist)",
    );
    expect(rol.kind).toBe("permission");
    expect(rol.message).toMatch(/accountant/i);

    const tenant = geval("42501", "Administratie niet beschikbaar");
    expect(tenant.kind).toBe("unavailable");
    expect(tenant.message).toMatch(/juiste administratie/i);
  });

  it("17. een netwerkstoring zegt eerlijk dat de uitkomst onbekend is", () => {
    const f = classifyYearCloseError(new TypeError("Failed to fetch"));
    expect(f.kind).toBe("network");
    expect(f.message).toBe(UNKNOWN_OUTCOME_MESSAGE);
    expect(f.message).toMatch(/niet bekend of het boekjaar is afgesloten/i);
    expect(needsReconciliation(f.kind)).toBe(true);
  });

  it("18. een onbekende fout valt terug op een vaste zin, nooit op ruwe SQL", () => {
    for (const ruw of [
      'new row for relation "year_closures" violates check constraint "year_closures_fiscal_year_check"',
      "ERROR:  permission denied for table clients",
      "null value in column \"closed_by\"",
      "",
    ]) {
      const f = classifyYearCloseError({ code: "XX000", message: ruw });
      expect(f.message, ruw).toBe("Het afsluiten is niet gelukt. Probeer het opnieuw.");
      expect(f.message, ruw).not.toMatch(/constraint|relation|permission denied|null value/i);
    }
  });

  it("19. een Supabase-object wordt nooit als geheel doorgegeven", () => {
    const f = classifyYearCloseError({
      code: "23514",
      message: "iets",
      details: "Key (client_id)=(abc) ...",
      hint: "drop the constraint",
    });
    expect(JSON.stringify(f)).not.toMatch(/Key \(client_id\)|drop the constraint/);
  });

  it("20. de console krijgt alleen code en soort, nooit de melding", () => {
    const meta = safeYearCloseErrorMetadata({ code: "42501", message: "Administratie niet beschikbaar" });
    expect(meta).toEqual({ code: "42501", kind: "unavailable" });
    expect(JSON.stringify(meta)).not.toMatch(/beschikbaar/);
  });

  it("21. de twee inconsistente toestanden zijn eindstations, de rest niet", () => {
    expect(isTerminal("inconsistent_closure")).toBe(true);
    expect(isTerminal("inconsistent_watermark")).toBe(true);
    for (const kind of ["unposted_work", "year_order", "permission", "network", "unknown"] as const) {
      expect(isTerminal(kind), kind).toBe(false);
    }
    // Alleen bij een onbekende afloop hoort eerst opnieuw kijken.
    expect(needsReconciliation("unknown")).toBe(true);
    expect(needsReconciliation("unposted_work")).toBe(false);
  });
});

describe("Het afsluitbewijs", () => {
  it("22. toont administratie, boekjaar en tijdstip", () => {
    const zichtbaar = visibleAuditEntries(
      closureReceiptEntries({ closure: CLOSURE, clientName: "Klant A", currentUserId: "user-1" }),
    );
    const kaart = new Map(zichtbaar.map((e) => [e.label, e.value]));
    expect(kaart.get("Administratie")).toBe("Klant A");
    expect(kaart.get("Boekjaar")).toBe("2026");
    expect(kaart.get("Afgesloten op")).toMatch(/15-01-2027/);
  });

  it("23. benoemt de actor alleen als dat veilig kan, en verzint nooit een naam", () => {
    const eigen = visibleAuditEntries(
      closureReceiptEntries({ closure: CLOSURE, clientName: "Klant A", currentUserId: "user-1" }),
    );
    expect(eigen.find((e) => e.label === "Afgesloten door")?.value).toBe("U zelf");

    // Iemand anders: de regel valt wég. Geen rauwe uuid, geen verzonnen naam.
    for (const wie of ["user-2", undefined]) {
      const ander = visibleAuditEntries(
        closureReceiptEntries({ closure: CLOSURE, clientName: "Klant A", currentUserId: wie }),
      );
      expect(ander.find((e) => e.label === "Afgesloten door"), String(wie)).toBeUndefined();
      expect(JSON.stringify(ander), String(wie)).not.toContain("user-");
    }
  });

  it("24. draagt geen enkel bedrag — `result_cents` bestaat niet", () => {
    const entries = closureReceiptEntries({
      closure: CLOSURE,
      clientName: "Klant A",
      currentUserId: "user-1",
    });
    const labels = entries.map((e) => e.label.toLowerCase());
    for (const verboden of ["resultaat", "bedrag", "saldo", "winst"]) {
      expect(labels.some((l) => l.includes(verboden)), verboden).toBe(false);
    }
    expect(JSON.stringify(entries)).not.toMatch(/result_cents|€/);
  });

  it("25. de herhaalmelding is een mededeling, geen fout", () => {
    expect(ALREADY_CLOSED_NOTICE).toBe(
      "Dit boekjaar was al afgesloten. Het bestaande afsluitbewijs is geladen.",
    );
    expect(ALREADY_CLOSED_NOTICE).not.toMatch(/fout|mislukt|niet gelukt/i);
  });
});

describe("De bevestiging zegt wat er gebeurt", () => {
  const gevolgen = closeConsequences(2026);

  it("26. noemt de zes gevolgen die een accountant morgen merkt", () => {
    const tekst = gevolgen.join(" ");
    expect(tekst).toMatch(
      /geen nieuwe boekingen of tegenboekingen meer worden gemaakt met een datum in boekjaar 2026/i,
    );
    expect(tekst).toMatch(/bestaande boekingen blijven ongewijzigd/i);
    expect(tekst).toMatch(/geen resultaatboeking/i);
    expect(tekst).toMatch(/geen beginbalans voor het volgende boekjaar/i);
    expect(tekst).toMatch(/later boekjaar dat nog open staat/i);
    expect(tekst).toMatch(/niet meer worden heropend/i);
  });

  it("27. gebruikt geen interne architectuurtaal", () => {
    const tekst = gevolgen.join(" ").toLowerCase();
    for (const jargon of ["watermerk", "marker", "rpc", "presentatieregel", "afsluitbewijs", "sqlstate"]) {
      expect(tekst, jargon).not.toContain(jargon);
    }
  });
});

describe("Wat deze fase NIET toevoegt", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const lees = (pad: string) =>
    readFileSync(resolve(process.cwd(), pad), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//") && !r.trimStart().startsWith("*"))
      .join("\n");

  it("28. geen migratie en geen SQL in deze branch", () => {
    expect(changed.filter((f) => f.startsWith("supabase/"))).toEqual([]);
  });

  it("29. de app schrijft nergens rechtstreeks in year_closures of het watermerk", () => {
    for (const pad of ["src/hooks/useYearClose.ts", "src/pages/Jaarafsluiting.tsx", "src/lib/year-close-action.ts"]) {
      const bron = lees(pad);
      expect(bron, pad).not.toMatch(/\.from\(\s*["']year_closures["']\s*\)[\s\S]{0,80}\.(insert|update|delete|upsert)\(/);
      expect(bron, pad).not.toMatch(/afgesloten_boekjaar\s*:/);
      expect(bron, pad).not.toMatch(/\.from\(\s*["']clients["']\s*\)/);
    }
  });

  it("30. er is geen heropenpad, geen resultaatboeking en geen doorrol", () => {
    for (const pad of ["src/hooks/useYearClose.ts", "src/pages/Jaarafsluiting.tsx", "src/lib/year-close-action.ts"]) {
      const bron = lees(pad);
      expect(bron, pad).not.toMatch(/reopen|heropen(?!d)/i);
      expect(bron, pad).not.toMatch(/carry_forward|doorrol/i);
      expect(bron, pad).not.toMatch(/ledger_postings|posting_group/);
      expect(bron, pad).not.toMatch(/result_cents|resultaat_rekening|9998|9999/);
    }
  });

  it("31. de RPC wordt met precies twee argumenten aangeroepen", () => {
    const hook = lees("src/hooks/useYearClose.ts");
    const aanroep = hook.slice(hook.indexOf('rpc("close_fiscal_year"'));
    const args = aanroep.slice(0, aanroep.indexOf("})") + 2);
    expect(args).toContain("_client_id: input.clientId");
    expect(args).toContain("_fiscal_year: input.fiscalYear");
    expect([...args.matchAll(/_\w+:/g)].map((m) => m[0])).toEqual(["_client_id:", "_fiscal_year:"]);
  });
});
