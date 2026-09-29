import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOSED_BUT_UNLOCKED_REASON,
  REASON_MAX_LENGTH,
  classifyReopenError,
  latestEvent,
  lifecycleEventEntries,
  lifecycleStatus,
  reopenAvailability,
  reopenConsequences,
  reopenDialogExplanation,
  safeReopenErrorMetadata,
  sortEventsChronologically,
  validateReopenReason,
  type FiscalYearEvent,
  type ReopenAvailabilityInput,
} from "@/lib/year-close-lifecycle";
import {
  REOPENED_BUT_LOCKED_REASON,
  classifyYearCloseError,
  closeAvailability,
  isTerminal,
  type YearClosure,
} from "@/lib/year-close-action";
import type { YearCloseReadiness } from "@/lib/year-close-readiness";
import { visibleAuditEntries } from "@/lib/platform/audit-trail";

/**
 * Jaarafsluiting PR F — de pure laag onder de levenscyclus.
 *
 * Wat hier bewaakt wordt: de status komt uit het bewijs en nergens anders,
 * wanneer heropenen mag worden aangeboden, de toets op de reden (dezelfde
 * regel als de database), dat een serverweigering letterlijk doorkomt en
 * elk zijn eigen soort krijgt, en dat het historieblok niets verzint.
 */

const CLOSED: YearClosure = {
  client_id: "client-1",
  organization_id: "org-1",
  fiscal_year: 2025,
  closed_at: "2026-01-15T10:30:00.000Z",
  closed_by: "user-1",
  status: "closed",
};

const REOPENED: YearClosure = { ...CLOSED, status: "reopened" };

function event(overrides: Partial<FiscalYearEvent>): FiscalYearEvent {
  return {
    id: "evt-1",
    client_id: "client-1",
    organization_id: "org-1",
    fiscal_year: 2025,
    event_type: "closed",
    occurred_at: "2026-01-15T10:30:00.000Z",
    actor_id: "user-1",
    reason: null,
    ...overrides,
  };
}

const readiness: YearCloseReadiness = {
  clientId: "client-1",
  fiscalYear: 2025,
  status: "ready",
  checks: [],
  administrationWide: [],
  unavailable: [],
  summary: { executed: 4, passed: 4, warnings: 0, blocking: 0 },
};

describe("De status komt uit het bewijs", () => {
  it("1. geen bewijs = open, bewijs = afgesloten, bewijs met status reopened = heropend", () => {
    expect(lifecycleStatus(null)).toBe("open");
    expect(lifecycleStatus(undefined)).toBe("open");
    expect(lifecycleStatus(CLOSED)).toBe("closed");
    expect(lifecycleStatus(REOPENED)).toBe("reopened");
  });

  it("2. een bewijs zonder statuskolom telt als afgesloten — de databasedefault", () => {
    const { status: _weg, ...zonder } = CLOSED;
    void _weg;
    expect(lifecycleStatus(zonder)).toBe("closed");
  });
});

describe("De reden: getrimd, 1–500 tekens", () => {
  it("3. leeg of alleen witruimte is geen reden", () => {
    for (const raw of ["", "   ", "\n\t ", "\r\n"]) {
      const uitkomst = validateReopenReason(raw);
      expect(uitkomst.ok, JSON.stringify(raw)).toBe(false);
      expect(uitkomst.ok === false && uitkomst.problem).toBe("empty");
    }
  });

  it("4. de reden wordt getrimd voordat zij de deur uitgaat", () => {
    const uitkomst = validateReopenReason("  Nagekomen inkoopfactuur \n");
    expect(uitkomst).toEqual({ ok: true, reason: "Nagekomen inkoopfactuur" });
  });

  it("5. precies 500 tekens mag, 501 niet — en witruimte telt niet mee", () => {
    expect(validateReopenReason("x".repeat(REASON_MAX_LENGTH)).ok).toBe(true);
    expect(validateReopenReason(`  ${"x".repeat(REASON_MAX_LENGTH)}  `).ok).toBe(true);
    const teLang = validateReopenReason("x".repeat(REASON_MAX_LENGTH + 1));
    expect(teLang.ok).toBe(false);
    expect(teLang.ok === false && teLang.problem).toBe("too_long");
    expect(teLang.ok === false && teLang.message).toMatch(/501 van maximaal 500/);
  });
});

describe("Wanneer mag heropenen worden aangeboden", () => {
  function invoer(overrides: Partial<ReopenAvailabilityInput> = {}): ReopenAvailabilityInput {
    return {
      fiscalYear: 2025,
      closure: CLOSED,
      closurePending: false,
      closureUnavailable: false,
      watermark: 2025,
      canReopen: true,
      roleUnavailable: false,
      ...overrides,
    };
  }

  it("6. een afgesloten jaar op het watermerk, voor een accountant: beschikbaar", () => {
    expect(reopenAvailability(invoer()).kind).toBe("available");
  });

  it("7. een open jaar heeft niets te heropenen; een heropend jaar is al open", () => {
    expect(reopenAvailability(invoer({ closure: null })).kind).toBe("not_closed");
    expect(reopenAvailability(invoer({ closure: REOPENED })).kind).toBe("already_reopened");
  });

  it("8. onbekend is nooit 'mag wel'", () => {
    expect(reopenAvailability(invoer({ closurePending: true })).kind).toBe("unknown");
    expect(reopenAvailability(invoer({ closureUnavailable: true })).kind).toBe("unknown");
    expect(reopenAvailability(invoer({ watermark: undefined })).kind).toBe("unknown");
    expect(reopenAvailability(invoer({ canReopen: undefined })).kind).toBe("unknown");
    expect(reopenAvailability(invoer({ roleUnavailable: true })).kind).toBe("unknown");
  });

  it("9. alleen een accountant", () => {
    const uitkomst = reopenAvailability(invoer({ canReopen: false }));
    expect(uitkomst.kind).toBe("not_allowed");
    expect(uitkomst.kind === "not_allowed" && uitkomst.reason).toMatch(/accountant/i);
  });

  it("10. alleen het hoogste afgesloten jaar — het watermerk zegt welk dat is", () => {
    const uitkomst = reopenAvailability(invoer({ watermark: 2026 }));
    expect(uitkomst.kind).toBe("not_highest");
    expect(uitkomst.kind === "not_highest" && uitkomst.reason).toMatch(/2026/);
  });

  it("11. afgesloten zonder watermerk erop: inconsistent, en nooit een knop", () => {
    for (const watermark of [null, 2024]) {
      const uitkomst = reopenAvailability(invoer({ watermark }));
      expect(uitkomst.kind, String(watermark)).toBe("inconsistent");
      expect(uitkomst.kind === "inconsistent" && uitkomst.reason).toBe(CLOSED_BUT_UNLOCKED_REASON);
    }
  });

  it("12. de rol wordt pas gevraagd als de toestand van het jaar het toelaat", () => {
    // Een open jaar geeft "niets te heropenen", niet "geen rechten".
    expect(reopenAvailability(invoer({ closure: null, canReopen: false })).kind).toBe("not_closed");
  });
});

describe("Opnieuw afsluiten loopt door dezelfde gereedheid", () => {
  const basis = {
    fiscalYear: 2025,
    readiness,
    closurePending: false,
    closureUnavailable: false,
    canClose: true,
    roleUnavailable: false,
  };

  it("13. een heropend jaar is geen 'al afgesloten' maar loopt de gewone route", () => {
    expect(closeAvailability({ ...basis, closure: REOPENED, watermark: 2024 }).kind).toBe("available");
    expect(closeAvailability({ ...basis, closure: REOPENED, watermark: null }).kind).toBe("available");
    expect(closeAvailability({ ...basis, closure: CLOSED, watermark: 2025 }).kind).toBe("already_closed");
  });

  it("14. heropend, maar de gereedheid is niet ready of de rol te laag: niets aanbieden", () => {
    expect(
      closeAvailability({ ...basis, closure: REOPENED, watermark: 2024, readiness: { ...readiness, status: "warning" } }).kind,
    ).toBe("not_ready");
    expect(closeAvailability({ ...basis, closure: REOPENED, watermark: 2024, canClose: false }).kind).toBe("not_allowed");
    expect(closeAvailability({ ...basis, closure: REOPENED, watermark: 2024, readiness: null }).kind).toBe("no_snapshot");
  });

  it("15. heropend terwijl het watermerk het jaar nog dekt: inconsistent, eigen melding", () => {
    const uitkomst = closeAvailability({ ...basis, closure: REOPENED, watermark: 2025 });
    expect(uitkomst.kind).toBe("inconsistent");
    expect(uitkomst.kind === "inconsistent" && uitkomst.reason).toBe(REOPENED_BUT_LOCKED_REASON);
  });
});

describe("Serverfouten bij heropenen komen letterlijk door, elk met een eigen soort", () => {
  const fout = (code: string, message: string) => classifyReopenError({ code, message });

  it("16. de drie 23514-weigeringen van PR E", () => {
    const nietDicht = fout("23514", "Boekjaar 2025 is niet afgesloten; er valt niets te heropenen.");
    expect(nietDicht.kind).toBe("not_closed");
    expect(nietDicht.message).toBe("Boekjaar 2025 is niet afgesloten; er valt niets te heropenen.");

    const nietHoogste = fout("23514", "Alleen het laatst afgesloten boekjaar (2026) kan worden heropend; heropen eerst de jongere jaren.");
    expect(nietHoogste.kind).toBe("not_highest");
    expect(nietHoogste.message).toMatch(/^Alleen het laatst afgesloten boekjaar \(2026\)/);
    expect(nietHoogste.advice).toBeDefined();

    for (const tekst of [
      "Boekjaar 2025 valt onder het watermerk 2025 maar heeft geen afsluitbewijs; de afsluitstand is inconsistent en moet handmatig worden onderzocht.",
      "Boekjaar 2025 staat heropend, maar het watermerk (2025) is niet het hoogste nog afgesloten boekjaar onder dit jaar (2024); de afsluitstand is inconsistent en moet handmatig worden onderzocht.",
      "Boekjaar 2025 staat heropend maar de gebeurtenisgeschiedenis draagt dat niet (laatste: closed); de afsluitstand is inconsistent en moet handmatig worden onderzocht.",
      "Boekjaar 2025 staat afgesloten maar de gebeurtenisgeschiedenis draagt dat niet (laatste: reopened); de afsluitstand is inconsistent en moet handmatig worden onderzocht.",
      "Heropenen van boekjaar 2025 zou ook boekjaar 2024 openen, dat boekingen heeft maar geen eigen afsluitbewijs; de afsluitstand is inconsistent en moet handmatig worden onderzocht.",
    ]) {
      const inconsistent = fout("23514", tekst);
      expect(inconsistent.kind, tekst).toBe("inconsistent");
      expect(inconsistent.message, tekst).toBe(tekst);
      expect(inconsistent.advice).toBe("Controleer deze administratie voordat u verdergaat.");
    }
  });

  it("17. reden, rol, tenant, sessie", () => {
    expect(fout("22004", "Een heropening vereist een reden").kind).toBe("reason");
    expect(fout("22023", "De reden is te lang (maximaal 500 tekens)")).toMatchObject({
      kind: "reason",
      message: "De reden is te lang (maximaal 500 tekens)",
    });
    expect(fout("42501", "Administratie niet beschikbaar").kind).toBe("unavailable");
    const rol = fout("42501", "Geen rechten om een boekjaar te heropenen voor deze organisatie (accountant vereist)");
    expect(rol.kind).toBe("permission");
    expect(rol.message).toMatch(/accountant/i);
    expect(fout("28000", "Niet ingelogd").kind).toBe("permission");
    expect(fout("PGRST301", "JWT expired").kind).toBe("permission");
  });

  it("18. netwerk, schema, gelijktijdigheid en de rest", () => {
    expect(classifyReopenError(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(fout("PGRST202", "Could not find the function public.reopen_fiscal_year in the schema cache").kind).toBe("schema");
    expect(fout("55000", "Boekjaar 2025 heeft in deze transactie al een levenscyclusstap gezet").kind).toBe("unknown");
    expect(fout("40001", "could not serialize").kind).toBe("unknown");
    const onbekend = fout("XX000", 'new row violates check constraint "x"');
    expect(onbekend.kind).toBe("unknown");
    // Ruwe PostgreSQL komt nooit door; een vaste zin wel.
    expect(onbekend.message).not.toMatch(/violates|constraint/);
    expect(onbekend.message).toMatch(/niet gelukt/);
  });

  it("19. de console krijgt alleen code en soort", () => {
    expect(safeReopenErrorMetadata({ code: "23514", message: "geheim" })).toEqual({ code: "23514", kind: "unknown" });
    expect(JSON.stringify(safeReopenErrorMetadata({ code: "23514", message: "geheim" }))).not.toContain("geheim");
  });
});

describe("Serverfouten bij opnieuw afsluiten", () => {
  it("20. een heropend ouder jaar is een eigen soort, met de melding letterlijk", () => {
    const tekst = "Boekjaar 2024 staat heropend; sluit dat eerst opnieuw af voordat boekjaar 2025 wordt afgesloten.";
    const fout = classifyYearCloseError({ code: "23514", message: tekst });
    expect(fout.kind).toBe("older_reopened");
    expect(fout.message).toBe(tekst);
    expect(fout.advice).toMatch(/opnieuw af/i);
    expect(isTerminal(fout.kind)).toBe(false);
  });

  it("21. elke andere PR E-inconsistentie is een eindstation", () => {
    const tekst = "Boekjaar 2025 staat heropend maar valt onder het watermerk 2025; dit moet handmatig worden onderzocht.";
    const fout = classifyYearCloseError({ code: "23514", message: tekst });
    expect(fout.kind).toBe("inconsistent_lifecycle");
    expect(fout.message).toBe(tekst);
    expect(isTerminal(fout.kind)).toBe(true);
    // De twee oudere, specifiekere soorten blijven voorgaan.
    expect(
      classifyYearCloseError({
        code: "23514",
        message: "Boekjaar 2025 staat al als afgesloten (watermerk 2025) maar er is geen bijbehorend afsluitbewijs; dit moet handmatig worden onderzocht.",
      }).kind,
    ).toBe("inconsistent_closure");
  });
});

describe("De historie verzint niets", () => {
  const dicht = event({ id: "evt-a", event_type: "closed", occurred_at: "2026-01-15T10:30:00.000Z" });
  const open = event({ id: "evt-b", event_type: "reopened", occurred_at: "2026-02-01T09:00:00.000Z", reason: "Nagekomen inkoopfactuur", actor_id: "user-2" });
  const weerDicht = event({ id: "evt-c", event_type: "closed", occurred_at: "2026-02-03T16:45:00.000Z" });

  it("22. chronologisch, oudste eerst, ongeacht de leesvolgorde", () => {
    expect(sortEventsChronologically([weerDicht, dicht, open]).map((e) => e.id)).toEqual(["evt-a", "evt-b", "evt-c"]);
    // Gelijk tijdstip: het id beslist, zodat de volgorde deterministisch is.
    const t = "2026-01-15T10:30:00.000Z";
    expect(
      sortEventsChronologically([event({ id: "z", occurred_at: t }), event({ id: "a", occurred_at: t })]).map((e) => e.id),
    ).toEqual(["a", "z"]);
  });

  it("23. de laatste gebeurtenis, al dan niet van één soort", () => {
    expect(latestEvent([weerDicht, dicht, open])?.id).toBe("evt-c");
    expect(latestEvent([weerDicht, dicht, open], "reopened")?.id).toBe("evt-b");
    expect(latestEvent([dicht], "reopened")).toBeNull();
    expect(latestEvent([])).toBeNull();
  });

  it("24. soort, boekjaar, tijdstip en reden staan er; de actor alleen als dat de gebruiker zelf is", () => {
    const zichtbaar = visibleAuditEntries(lifecycleEventEntries(open, "user-1"));
    expect(zichtbaar.map((e) => [e.label, e.value])).toEqual([
      ["Gebeurtenis", "Heropend"],
      ["Boekjaar", "2025"],
      ["Tijdstip", expect.stringMatching(/01-02-2026/)],
      ["Reden", "Nagekomen inkoopfactuur"],
    ]);
    // Geen uuid en geen verzonnen naam.
    expect(JSON.stringify(zichtbaar)).not.toContain("user-2");

    const eigen = visibleAuditEntries(lifecycleEventEntries(dicht, "user-1"));
    expect(eigen.find((e) => e.label === "Door")?.value).toBe("U zelf");
    // Een afsluiting zonder reden krijgt geen regel "Reden".
    expect(eigen.find((e) => e.label === "Reden")).toBeUndefined();
  });
});

describe("De woorden van de heropening", () => {
  it("25. zegt wat er verandert en wat níet: de boekingsblokkade", () => {
    const tekst = reopenConsequences(2025).join(" ");
    expect(tekst).toMatch(/status Heropend/);
    expect(tekst).toMatch(/eerdere afsluiting blijft in de historie/i);
    expect(tekst).toMatch(/boekingsblokkade .* verandert hierdoor niet/i);
    expect(tekst).toMatch(/opnieuw worden gecontroleerd en afgesloten/i);
    // Nooit de suggestie dat heropenen een periode of blokkade "opent".
    expect(tekst).not.toMatch(/blokkade (wordt )?opgeheven|periode weer open/i);
    expect(reopenDialogExplanation("Klant A", 2025)).toMatch(/reden wordt onuitwisbaar vastgelegd/i);
  });

  it("26. de pure laag raakt de boekingsblokkade niet en schrijft niet", () => {
    const bron = readFileSync(resolve(process.cwd(), "src/lib/year-close-lifecycle.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//") && !r.trimStart().startsWith("*"))
      .join("\n");
    expect(bron).not.toMatch(/set_posting_lock|posting_locked_through|posting_allowed/);
    expect(bron).not.toMatch(/supabase|useMutation|\.rpc\(|\.from\(/);
    expect(bron).not.toMatch(/ledger_postings|posting_group|result_cents|9998|9999/);
  });
});
