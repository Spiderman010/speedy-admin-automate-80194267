import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLEAR_DOES_NOT_REOPEN_NOTE,
  INDEPENDENCE_NOTE,
  NO_LOCK_LABEL,
  REOPEN_DOES_NOT_CLEAR_NOTE,
  UNKNOWN_LOCK_OUTCOME_MESSAGE,
  classifyPostingLockError,
  isIsoDate,
  isRelaxation,
  lockAvailability,
  lockChangeConsequences,
  lockChangeKind,
  lockConsistency,
  lockEventEntries,
  lockExplanation,
  lockLabel,
  needsLockReconciliation,
  nextDay,
  safePostingLockErrorMetadata,
  sortLockEventsChronologically,
  validateLockDate,
  validateLockReason,
  type LockAvailabilityInput,
  type PostingLockEvent,
} from "@/lib/posting-lock";
import { visibleAuditEntries } from "@/lib/platform/audit-trail";
import { appFilesMatching } from "@/test/support/app-sources";

/**
 * De boekingsblokkade op het scherm — de pure laag en de statische grenzen.
 *
 * Wat hier bewaakt wordt: de stand in woorden (precies de regel van de
 * schrijvers: op of vóór de datum is dicht), wat een wijziging doet, dat de
 * stand en de geschiedenis elkaar moeten dragen, dat een serverweigering
 * letterlijk doorkomt, en — statisch — dat blokkade en jaarafsluiting elkaar in
 * de code niet aanraken.
 */

function event(overrides: Partial<PostingLockEvent>): PostingLockEvent {
  return {
    id: "lock-1",
    client_id: "client-1",
    organization_id: "org-1",
    previous_locked_through: null,
    new_locked_through: "2025-12-31",
    changed_at: "2026-01-10T08:00:00.000Z",
    changed_by: "user-1",
    reason: "Aangifte ingediend",
    ...overrides,
  };
}

describe("De datum", () => {
  it("1. alleen een echte kalenderdatum", () => {
    expect(isIsoDate("2025-12-31")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("31-12-2025")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  it("2. het bereik van de schrijver: 2000-01-01 t/m 2100-12-31", () => {
    expect(validateLockDate("2000-01-01").ok).toBe(true);
    expect(validateLockDate("2100-12-31").ok).toBe(true);
    expect(validateLockDate("1999-12-31").ok).toBe(false);
    expect(validateLockDate("2101-01-01").ok).toBe(false);
    expect(validateLockDate("").ok).toBe(false);
  });

  it("3. de dag erna, ook over maand-, jaar- en schrikkelgrenzen", () => {
    expect(nextDay("2025-06-30")).toBe("2025-07-01");
    expect(nextDay("2025-12-31")).toBe("2026-01-01");
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2025-02-28")).toBe("2025-03-01");
  });
});

describe("De reden: getrimd, 1–500 tekens — de regel van de schrijver", () => {
  it("4. witruimte is geen reden, 500 mag, 501 niet", () => {
    for (const raw of ["", "   ", "\n\t\r "]) expect(validateLockReason(raw).ok, JSON.stringify(raw)).toBe(false);
    expect(validateLockReason("  Aangifte ingediend \n")).toEqual({ ok: true, reason: "Aangifte ingediend" });
    expect(validateLockReason("x".repeat(500)).ok).toBe(true);
    const teLang = validateLockReason("x".repeat(501));
    expect(teLang.ok === false && teLang.message).toMatch(/501 van maximaal 500/);
  });
});

describe("De stand in woorden", () => {
  it("5. NULL = geen boekingsblokkade", () => {
    expect(lockLabel(null)).toBe(NO_LOCK_LABEL);
    expect(NO_LOCK_LABEL).toBe("Geen boekingsblokkade");
    expect(lockExplanation(null).join(" ")).toMatch(/geen boekingsblokkade ingesteld/i);
  });

  it("6. een datum: op of vóór is dicht, ná blijft mogelijk", () => {
    expect(lockLabel("2025-12-31")).toBe("Boekingen geblokkeerd t/m 31-12-2025");
    const uitleg = lockExplanation("2025-12-31").join(" ");
    expect(uitleg).toMatch(/op of vóór 31-12-2025 worden geweigerd/);
    expect(uitleg).toMatch(/ná 31-12-2025 blijven mogelijk, onder voorbehoud van alle andere/);
  });

  it("7. de onafhankelijkheid staat er letterlijk", () => {
    expect(INDEPENDENCE_NOTE).toBe("Deze boekingsblokkade staat los van de boekjaarstatus.");
    expect(REOPEN_DOES_NOT_CLEAR_NOTE).toBe("Een boekjaar heropenen heft deze blokkade niet op.");
    expect(CLEAR_DOES_NOT_REOPEN_NOTE).toBe("De blokkade opheffen opent geen afgesloten boekjaar.");
  });
});

describe("Wat een wijziging doet", () => {
  it("8. vijf soorten, en alleen versoepelen en opheffen zijn een versoepeling", () => {
    expect(lockChangeKind(null, "2025-12-31")).toBe("set");
    expect(lockChangeKind("2025-06-30", "2025-12-31")).toBe("extend");
    expect(lockChangeKind("2025-12-31", "2025-06-30")).toBe("relax");
    expect(lockChangeKind("2025-12-31", null)).toBe("clear");
    expect(lockChangeKind("2025-12-31", "2025-12-31")).toBe("unchanged");
    expect(lockChangeKind(null, null)).toBe("unchanged");
    expect(["set", "extend", "unchanged"].map((k) => isRelaxation(k as never))).toEqual([false, false, false]);
    expect(isRelaxation("relax")).toBe(true);
    expect(isRelaxation("clear")).toBe(true);
  });

  it("9. instellen noemt precies welke datums dichtgaan", () => {
    const tekst = lockChangeConsequences(null, "2025-12-31").join(" ");
    expect(tekst).toMatch(/Boekingen met een datum op of vóór 31-12-2025 worden geblokkeerd\./);
    expect(tekst).toMatch(/vanaf 01-01-2026 blijven mogelijk/);
  });

  it("10. uitbreiden en versoepelen noemen het precieze tussenstuk", () => {
    expect(lockChangeConsequences("2025-06-30", "2025-12-31").join(" ")).toMatch(
      /van 01-07-2025 t\/m 31-12-2025 worden voortaan óók geblokkeerd/,
    );
    const versoepeld = lockChangeConsequences("2025-12-31", "2025-06-30").join(" ");
    expect(versoepeld).toMatch(/van 01-07-2025 t\/m 31-12-2025 worden niet langer door deze blokkade tegengehouden/);
    expect(versoepeld).toMatch(/afgesloten boekjaar blijft afgesloten/i);
  });

  it("11. opheffen opent geen afgesloten boekjaar, en geen enkele wijziging raakt de boekjaarstatus", () => {
    const opheffen = lockChangeConsequences("2025-12-31", null).join(" ");
    expect(opheffen).toContain(CLEAR_DOES_NOT_REOPEN_NOTE);
    expect(opheffen).toMatch(/afgesloten boekjaar blijft afgesloten/i);
    for (const [van, naar] of [[null, "2025-12-31"], ["2025-06-30", "2025-12-31"], ["2025-12-31", "2025-06-30"], ["2025-12-31", null]] as const) {
      const tekst = lockChangeConsequences(van, naar).join(" ");
      expect(tekst).toMatch(/boekjaarstatus en het afgesloten boekjaar van deze administratie veranderen hierdoor niet/);
      // Nooit taal van de jaarlevenscyclus voor de blokkade.
      expect(tekst).not.toMatch(/periode geopend|boekjaar vrijgegeven|heropend/i);
    }
    expect(lockChangeConsequences("2025-12-31", "2025-12-31")).toEqual([]);
  });
});

describe("Stand en geschiedenis moeten elkaar dragen", () => {
  it("12. zonder geschiedenis is alleen 'geen blokkade' consistent (er is nooit gebackfilld)", () => {
    expect(lockConsistency(null, []).kind).toBe("consistent");
    expect(lockConsistency("2025-12-31", []).kind).toBe("inconsistent");
  });

  it("13. de laatste gebeurtenis bepaalt wat de stand hoort te zijn", () => {
    const gezet = event({ id: "a", new_locked_through: "2025-12-31", changed_at: "2026-01-10T08:00:00Z" });
    const opgeheven = event({
      id: "b",
      previous_locked_through: "2025-12-31",
      new_locked_through: null,
      changed_at: "2026-02-10T08:00:00Z",
    });
    expect(lockConsistency("2025-12-31", [gezet]).kind).toBe("consistent");
    expect(lockConsistency(null, [opgeheven, gezet]).kind).toBe("consistent");
    const tegenspraak = lockConsistency("2025-12-31", [gezet, opgeheven]);
    expect(tegenspraak.kind).toBe("inconsistent");
    expect(tegenspraak.kind === "inconsistent" && tegenspraak.reason).toMatch(/kiest hier geen kant/);
  });

  it("14. chronologisch, oudste eerst; bij gelijk tijdstip beslist het id", () => {
    const t = "2026-01-10T08:00:00Z";
    const lijst = [
      event({ id: "z", changed_at: t }),
      event({ id: "c", changed_at: "2026-03-01T00:00:00Z" }),
      event({ id: "a", changed_at: t }),
    ];
    expect(sortLockEventsChronologically(lijst).map((e) => e.id)).toEqual(["a", "z", "c"]);
    // En de invoervolgorde doet er niet toe.
    expect(sortLockEventsChronologically([...lijst].reverse()).map((e) => e.id)).toEqual(["a", "z", "c"]);
  });
});

describe("Wanneer mag er worden gewijzigd", () => {
  function invoer(overrides: Partial<LockAvailabilityInput> = {}): LockAvailabilityInput {
    return {
      lockedThrough: null,
      stateUnavailable: false,
      events: [],
      eventsUnavailable: false,
      canSet: true,
      roleUnavailable: false,
      reconciling: false,
      ...overrides,
    };
  }

  it("15. een accountant met een consistente stand: beschikbaar", () => {
    expect(lockAvailability(invoer()).kind).toBe("available");
  });

  it("16. onbekend is nooit 'mag wel' — ook niet tijdens een verzoening", () => {
    expect(lockAvailability(invoer({ stateUnavailable: true })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ eventsUnavailable: true })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ lockedThrough: undefined })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ events: undefined })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ reconciling: true })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ canSet: undefined })).kind).toBe("unknown");
    expect(lockAvailability(invoer({ roleUnavailable: true })).kind).toBe("unknown");
  });

  it("17. een inconsistente stand biedt ook een accountant niets aan", () => {
    expect(lockAvailability(invoer({ lockedThrough: "2025-12-31", events: [] })).kind).toBe("inconsistent");
  });

  it("18. alleen een accountant", () => {
    const uitkomst = lockAvailability(invoer({ canSet: false }));
    expect(uitkomst.kind).toBe("not_allowed");
    expect(uitkomst.kind === "not_allowed" && uitkomst.reason).toMatch(/accountant/i);
  });
});

describe("De geschiedenis verzint niets", () => {
  it("19. van, naar, tijdstip en reden; de actor alleen als dat de gebruiker zelf is", () => {
    const vreemd = event({ changed_by: "user-2", previous_locked_through: "2025-06-30", new_locked_through: "2025-12-31" });
    const zichtbaar = visibleAuditEntries(lockEventEntries(vreemd, "user-1"));
    expect(zichtbaar.map((e) => [e.label, e.value])).toEqual([
      ["Wijziging", "Blokkade uitbreiden"],
      ["Van", "t/m 30-06-2025"],
      ["Naar", "t/m 31-12-2025"],
      ["Tijdstip", expect.stringMatching(/10-01-2026/)],
      ["Reden", "Aangifte ingediend"],
    ]);
    expect(JSON.stringify(zichtbaar)).not.toContain("user-2");

    const eigen = visibleAuditEntries(lockEventEntries(event({ new_locked_through: null, previous_locked_through: "2025-12-31" }), "user-1"));
    expect(eigen.find((e) => e.label === "Door")?.value).toBe("U zelf");
    expect(eigen.find((e) => e.label === "Naar")?.value).toBe("Geen blokkade");
    expect(eigen.find((e) => e.label === "Wijziging")?.value).toBe("Blokkade opheffen");
  });
});

describe("Serverfouten komen letterlijk door, elk met een eigen soort", () => {
  const fout = (code: string, message: string) => classifyPostingLockError({ code, message });

  it("20. rol en tenant", () => {
    const rol = fout("42501", "Geen rechten om de boekingsblokkade te wijzigen voor deze organisatie (accountant vereist)");
    expect(rol.kind).toBe("permission");
    expect(rol.message).toMatch(/accountant/i);
    expect(fout("42501", "Administratie niet beschikbaar").kind).toBe("unavailable");
    expect(fout("28000", "Niet ingelogd").kind).toBe("permission");
  });

  it("21. validatie: de melding van de schrijver blijft staan", () => {
    const datum = fout("22023", "Blokkadedatum 2101-01-01 valt buiten het ondersteunde bereik 2000-2100");
    expect(datum).toMatchObject({ kind: "validation", message: "Blokkadedatum 2101-01-01 valt buiten het ondersteunde bereik 2000-2100" });
    expect(fout("22004", "Een wijziging van de boekingsblokkade vereist een reden").message).toBe(
      "Een wijziging van de boekingsblokkade vereist een reden",
    );
  });

  it("22. inconsistent, gelijktijdig, netwerk, schema", () => {
    expect(fout("23514", "client_id verwijst naar een administratie buiten de organisatie van deze blokkadewijziging").kind).toBe("inconsistent");
    expect(fout("40001", "could not serialize access").kind).toBe("concurrent");
    expect(fout("25000", "De boekingsblokkade kan alleen in een READ COMMITTED transactie worden gewijzigd").kind).toBe("concurrent");
    const net = classifyPostingLockError(new TypeError("Failed to fetch"));
    expect(net).toMatchObject({ kind: "network", message: UNKNOWN_LOCK_OUTCOME_MESSAGE });
    expect(fout("PGRST202", "Could not find the function public.set_posting_lock in the schema cache").kind).toBe("schema");
  });

  it("23. ruwe PostgreSQL komt nooit door; de console krijgt alleen code en soort", () => {
    const rauw = fout("XX000", 'new row for relation "posting_lock_events" violates check constraint "x"');
    expect(rauw.message).not.toMatch(/violates|constraint|posting_lock_events/);
    expect(safePostingLockErrorMetadata({ code: "22023", message: "geheim" })).toEqual({ code: "22023", kind: "validation" });
  });

  it("24. alleen een onzekere afloop wordt verzoend; validatie en rechten niet", () => {
    expect(needsLockReconciliation("network")).toBe(true);
    expect(needsLockReconciliation("unknown")).toBe(true);
    expect(needsLockReconciliation("concurrent")).toBe(true);
    for (const kind of ["permission", "unavailable", "validation", "inconsistent", "schema"] as const) {
      expect(needsLockReconciliation(kind), kind).toBe(false);
    }
  });
});

// ── Statische grenzen ───────────────────────────────────────────────────────

/** Broncode zonder commentaar: een verbod gaat over wat de code DOET. */
function code(pad: string): string {
  return readFileSync(resolve(process.cwd(), pad), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((r) => !r.trimStart().startsWith("//") && !r.trimStart().startsWith("*"))
    .join("\n");
}

const BLOKKADE = [
  "src/lib/posting-lock.ts",
  "src/hooks/usePostingLock.ts",
  "src/components/overzichten/PostingLockCard.tsx",
];

const JAARAFSLUITING = [
  "src/lib/year-close-action.ts",
  "src/lib/year-close-lifecycle.ts",
  "src/hooks/useYearClose.ts",
  "src/pages/Jaarafsluiting.tsx",
];

describe("Statisch: de blokkade raakt de jaarafsluiting en het grootboek niet", () => {
  it("25. geen grootboek, geen resultaat, geen doorrol", () => {
    for (const pad of BLOKKADE) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/ledger_postings|posting_group/);
      expect(bron, pad).not.toMatch(/result_cents|resultaat_rekening|carry_forward|doorrol|9998|9999/i);
    }
  });

  it("26. geen afsluiten, geen heropenen, geen jaarwatermerk", () => {
    for (const pad of BLOKKADE) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/close_fiscal_year|reopen_fiscal_year/);
      expect(bron, pad).not.toMatch(/afgesloten_boekjaar/);
      expect(bron, pad).not.toMatch(/year_closures|fiscal_year_events/);
      expect(bron, pad).not.toMatch(/useYearClose|year-close-lifecycle/);
    }
  });

  it("27. geen directe schrijfactie; set_posting_lock is de enige mutatiegrens", () => {
    for (const pad of BLOKKADE) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
      const rpcs = [...bron.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
      expect(rpcs.filter((f) => f !== "has_min_role" && f !== "set_posting_lock"), pad).toEqual([]);
    }
    // In de hele app is er precies één aanroeper van de schrijver.
    expect(appFilesMatching(/\.rpc\(\s*["'`]set_posting_lock["'`]/)).toEqual(["src/hooks/usePostingLock.ts"]);
    // En nergens wordt de kolom rechtstreeks meegestuurd in een schrijfactie.
    expect(appFilesMatching(/\.(update|upsert|insert)\(\s*\{[^}]*posting_locked_through/)).toEqual([]);
  });

  it("28. de schrijver krijgt precies drie waarden", () => {
    const hook = code("src/hooks/usePostingLock.ts");
    const aanroep = hook.slice(hook.indexOf('rpc("set_posting_lock"'));
    const args = aanroep.slice(0, aanroep.indexOf("})") + 2);
    expect([...args.matchAll(/_\w+:/g)].map((m) => m[0])).toEqual(["_client_id:", "_locked_through:", "_reason:"]);
  });
});

describe("Statisch: de jaarafsluiting raakt de blokkade niet", () => {
  it("29. de jaarafsluitingscode noemt noch roept de blokkadeschrijver aan", () => {
    for (const pad of JAARAFSLUITING) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/set_posting_lock|posting_locked_through|posting_lock_events/);
      expect(bron, pad).not.toMatch(/useSetPostingLock|usePostingLock/);
    }
  });

  it("30. de pagina geeft de kaart alleen de administratie door", () => {
    const pagina = code("src/pages/Jaarafsluiting.tsx");
    const kaart = pagina.match(/<PostingLockCard[^>]*\/>/g) ?? [];
    expect(kaart).toHaveLength(1);
    const props = [...kaart[0].matchAll(/(\w+)=\{/g)].map((m) => m[1]).sort();
    expect(props).toEqual(["clientId", "clientName", "key"]);
  });
});
