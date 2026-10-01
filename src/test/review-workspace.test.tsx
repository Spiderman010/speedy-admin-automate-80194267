import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Review — visueel prototype. Deze tests pinnen twee dingen vast: wat de
 * pagina laat zien, en dat zij niets ophaalt of schrijft. De Supabase-client
 * wordt gemockt met een spion op elke ingang; de pagina mag er geen enkele
 * van aanraken.
 */

const { supabaseCalls } = vi.hoisted(() => ({ supabaseCalls: [] as string[] }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy(
    {},
    {
      get: (_t, prop) => {
        supabaseCalls.push(String(prop));
        return () => {
          throw new Error(`Review-prototype raakte supabase.${String(prop)} aan`);
        };
      },
    },
  ),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "boekhouder@agio.nl" } }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }] }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/components/OrganizationSelector", () => ({
  OrganizationSelector: () => null,
}));

import Review from "@/pages/Review";
import { AppShell } from "@/components/layout/app-shell";
import { NAV_SECTIONS, pageTitleForPath } from "@/components/layout/nav";
import {
  REVIEW_EXAMPLE_ITEMS,
  countByStatus,
  filterReviewItems,
  proposalTotals,
} from "@/lib/review-workspace-mock";

function renderReview() {
  return render(
    <MemoryRouter initialEntries={["/review"]}>
      <Review />
    </MemoryRouter>,
  );
}

describe("Review — de pagina", () => {
  it("1. toont titel, ondertitel, de werkbalk en drie tellers die optellen tot alle voorbeeldregels", () => {
    renderReview();
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
    expect(screen.getByText(/Prototype met voorbeelddata/)).toBeInTheDocument();
    const toolbar = screen.getByTestId("review-toolbar");
    expect(toolbar).toHaveTextContent("Administratie");
    expect(toolbar).toHaveTextContent("Periode");
    expect(within(toolbar).getByRole("textbox", { name: "Zoeken in voorbeeldregels" })).toBeInTheDocument();

    const telling = countByStatus(REVIEW_EXAMPLE_ITEMS);
    expect(screen.getByTestId("review-counter-klaar")).toHaveTextContent(`Klaar${telling.klaar}`);
    expect(screen.getByTestId("review-counter-aandacht")).toHaveTextContent(`Aandacht nodig${telling.aandacht}`);
    expect(screen.getByTestId("review-counter-geblokkeerd")).toHaveTextContent(`Geblokkeerd${telling.geblokkeerd}`);
    expect(telling.klaar + telling.aandacht + telling.geblokkeerd).toBe(REVIEW_EXAMPLE_ITEMS.length);
    // Elke status komt in het voorbeeld minstens één keer voor.
    expect(Math.min(telling.klaar, telling.aandacht, telling.geblokkeerd)).toBeGreaterThan(0);
  });

  it("2. de tabel heeft de vereiste kolommen en een regel per voorbeelditem, met facturen, bank en memoriaal", () => {
    renderReview();
    const table = screen.getByTestId("review-table");
    const koppen = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(koppen).toEqual(["Datum", "Type", "Relatie", "Omschrijving", "Bedrag", "Status"]);
    expect(within(table).getAllByRole("row")).toHaveLength(REVIEW_EXAMPLE_ITEMS.length + 1);
    const types = new Set(REVIEW_EXAMPLE_ITEMS.map((i) => i.type));
    expect(types).toEqual(new Set(["inkoopfactuur", "verkoopfactuur", "banktransactie", "memoriaal"]));
  });

  it("3. status is nooit alleen kleur: elke badge heeft een icoon én tekst", () => {
    renderReview();
    const table = screen.getByTestId("review-table");
    for (const item of REVIEW_EXAMPLE_ITEMS) {
      const badge = within(screen.getByTestId(`review-row-${item.id}`)).getByText(
        { klaar: "Klaar", aandacht: "Aandacht nodig", geblokkeerd: "Geblokkeerd" }[item.status],
      );
      const chip = badge.closest("[data-status]")!;
      expect(chip).toHaveAttribute("data-status", item.status);
      expect(chip.querySelector("svg")).not.toBeNull();
    }
    expect(table.querySelectorAll('[data-status="klaar"].text-success')).toHaveLength(countByStatus(REVIEW_EXAMPLE_ITEMS).klaar);
    expect(table.querySelectorAll('[data-status="aandacht"].text-warning')).toHaveLength(countByStatus(REVIEW_EXAMPLE_ITEMS).aandacht);
    expect(table.querySelectorAll('[data-status="geblokkeerd"].text-destructive')).toHaveLength(
      countByStatus(REVIEW_EXAMPLE_ITEMS).geblokkeerd,
    );
  });

  it("4. een regel kiezen toont haar voorstel, toelichting, bijlagen en activiteit in het paneel", () => {
    renderReview();
    const doel = REVIEW_EXAMPLE_ITEMS.find((i) => i.status === "geblokkeerd")!;
    fireEvent.click(within(screen.getByTestId(`review-row-${doel.id}`)).getByRole("button", { name: doel.omschrijving }));
    expect(screen.getByTestId(`review-row-${doel.id}`)).toHaveAttribute("aria-selected", "true");

    const paneel = screen.getByTestId("review-detail");
    expect(paneel).toHaveTextContent(doel.relatie);
    expect(paneel).toHaveTextContent(doel.reden);
    expect(paneel).toHaveTextContent(doel.toelichting);
    const voorstel = within(paneel).getByTestId("review-proposal");
    for (const line of doel.voorstel) expect(voorstel).toHaveTextContent(line.rekening);
    expect(within(paneel).getByTestId("review-attachments")).toHaveTextContent("voorbeeld, geen document");
    expect(within(paneel).getByTestId("review-activity")).toHaveTextContent(doel.activiteit[0].tekst);
    // Een blokkade wordt als blokkade gemeld, niet als informatie.
    expect(paneel.querySelector('[data-severity="blocking"]')).not.toBeNull();
  });

  it("5. Goedkeuren, Terugzetten en Openen zijn zichtbaar maar uitgeschakeld, met 'Voorbeeld — geen boeking'", () => {
    renderReview();
    const paneel = screen.getByTestId("review-detail");
    for (const naam of ["Goedkeuren", "Terugzetten", "Openen"]) {
      const knop = within(paneel).getByRole("button", { name: naam });
      expect(knop).toBeDisabled();
      expect(knop).toHaveAttribute("title", "Voorbeeld — geen boeking");
    }
    expect(within(paneel).getByTestId("review-no-booking")).toHaveTextContent("Voorbeeld — geen boeking");
  });

  it("6. zoeken en de tellers filteren alleen lokaal; daarbij wordt Supabase nooit aangeraakt", () => {
    renderReview();
    const zoek = screen.getByRole("textbox", { name: "Zoeken in voorbeeldregels" });
    fireEvent.change(zoek, { target: { value: "Hotel De Linde" } });
    const verwacht = filterReviewItems(REVIEW_EXAMPLE_ITEMS, "Hotel De Linde", null);
    expect(verwacht.length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("review-table")).getAllByRole("row")).toHaveLength(verwacht.length + 1);

    fireEvent.change(zoek, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("review-counter-geblokkeerd"));
    expect(screen.getByTestId("review-counter-geblokkeerd")).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId("review-table")).getAllByRole("row")).toHaveLength(
      countByStatus(REVIEW_EXAMPLE_ITEMS).geblokkeerd + 1,
    );
    fireEvent.click(screen.getByTestId("review-counter-geblokkeerd"));
    expect(within(screen.getByTestId("review-table")).getAllByRole("row")).toHaveLength(REVIEW_EXAMPLE_ITEMS.length + 1);

    expect(supabaseCalls).toEqual([]);
  });

  it("7. op kleine schermen staat het paneel onder de tabel, op grote ernaast", () => {
    renderReview();
    const grid = screen.getByTestId("review-table").closest(".grid")!;
    // Eén kolom zonder breakpoint (DOM-volgorde: tabel, dan paneel); twee vanaf xl.
    expect(grid.className).toMatch(/(^|\s)grid(\s|$)/);
    expect(grid.className).toMatch(/xl:grid-cols-\[minmax\(0,1fr\)_\d+px\]/);
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-/);
    const kinderen = Array.from(grid.children);
    expect(kinderen[1]).toBe(screen.getByTestId("review-detail"));
  });
});

describe("Review — het paneel volgt de gefilterde tabel", () => {
  const paneel = () => screen.getByTestId("review-detail");
  const geselecteerd = () =>
    within(screen.getByTestId("review-table"))
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-selected") === "true")
      .map((r) => r.getAttribute("data-testid"));
  const kies = (id: string) => {
    const item = REVIEW_EXAMPLE_ITEMS.find((i) => i.id === id)!;
    fireEvent.click(within(screen.getByTestId(`review-row-${id}`)).getByRole("button", { name: item.omschrijving }));
  };

  it("11. statusfilter: een weggefilterde selectie wijkt voor de eerste zichtbare regel", () => {
    renderReview();
    const klaar = REVIEW_EXAMPLE_ITEMS.find((i) => i.status === "klaar")!;
    kies(klaar.id);
    expect(paneel()).toHaveTextContent(klaar.omschrijving);

    fireEvent.click(screen.getByTestId("review-counter-geblokkeerd"));
    const eerste = filterReviewItems(REVIEW_EXAMPLE_ITEMS, "", "geblokkeerd")[0];
    expect(paneel()).toHaveTextContent(eerste.omschrijving);
    expect(paneel()).not.toHaveTextContent(klaar.omschrijving);
    expect(geselecteerd()).toEqual([`review-row-${eerste.id}`]);

    // Een selectie die zichtbaar blijft, blijft staan.
    const tweede = filterReviewItems(REVIEW_EXAMPLE_ITEMS, "", "geblokkeerd")[1];
    kies(tweede.id);
    fireEvent.click(screen.getByTestId("review-counter-geblokkeerd"));
    expect(paneel()).toHaveTextContent(tweede.omschrijving);
    expect(geselecteerd()).toEqual([`review-row-${tweede.id}`]);
  });

  it("12. zoeken: een weggefilterde selectie wijkt voor de eerste zichtbare regel", () => {
    renderReview();
    const start = REVIEW_EXAMPLE_ITEMS[0];
    expect(paneel()).toHaveTextContent(start.omschrijving);

    fireEvent.change(screen.getByRole("textbox", { name: "Zoeken in voorbeeldregels" }), {
      target: { value: "Energie Direct" },
    });
    const zichtbaar = filterReviewItems(REVIEW_EXAMPLE_ITEMS, "Energie Direct", null);
    expect(zichtbaar.map((i) => i.id)).not.toContain(start.id);
    expect(paneel()).toHaveTextContent(zichtbaar[0].omschrijving);
    expect(paneel()).not.toHaveTextContent(start.relatie);
    expect(geselecteerd()).toEqual([`review-row-${zichtbaar[0].id}`]);
  });

  it("13. geen zichtbare regels: het paneel toont de lege detailtoestand", () => {
    renderReview();
    fireEvent.change(screen.getByRole("textbox", { name: "Zoeken in voorbeeldregels" }), {
      target: { value: "bestaat-niet-xyz" },
    });
    expect(paneel()).toHaveTextContent("Kies een regel om de details te bekijken.");
    expect(within(paneel()).queryByRole("button", { name: "Goedkeuren" })).toBeNull();

    // Ook via het statusfilter in combinatie met zoeken.
    fireEvent.change(screen.getByRole("textbox", { name: "Zoeken in voorbeeldregels" }), {
      target: { value: "Energie Direct" },
    });
    fireEvent.click(screen.getByTestId("review-counter-klaar"));
    expect(filterReviewItems(REVIEW_EXAMPLE_ITEMS, "Energie Direct", "klaar")).toEqual([]);
    expect(paneel()).toHaveTextContent("Kies een regel om de details te bekijken.");
    expect(geselecteerd()).toEqual([]);
  });
});

describe("Review — voorbeelddata", () => {
  it("8b. een voorbeeld dat op de boekingsblokkade wordt geblokkeerd, valt ook echt binnen zijn eigen blokkade", () => {
    const opBlokkade = REVIEW_EXAMPLE_ITEMS.filter((i) => /boekingsblokkade/i.test(i.reden));
    // Het bekende voorbeeld moet hier tussen zitten; anders toetst deze test niets.
    expect(opBlokkade.map((i) => i.id)).toContain("vb-5");
    for (const item of opBlokkade) {
      expect(item.status, item.id).toBe("geblokkeerd");
      const tm = /t\/m (\d{2})-(\d{2})-(\d{4})/.exec(item.toelichting) ?? /tot en met (\d{2})-(\d{2})-(\d{4})/.exec(item.toelichting);
      expect(tm, `${item.id}: toelichting noemt geen blokkadedatum`).not.toBeNull();
      const blokkadeTot = `${tm![3]}-${tm![2]}-${tm![1]}`;
      // ISO-datums vergelijken lexicografisch: op of vóór de blokkade = geblokkeerd.
      expect(item.datum <= blokkadeTot, `${item.id}: ${item.datum} valt na de blokkade t/m ${blokkadeTot}`).toBe(true);
      // De activiteit hoort bij dezelfde factuur: niet vóór de factuurdatum.
      for (const regel of item.activiteit) {
        const [d, m, j] = regel.moment.slice(0, 10).split("-");
        expect(`${j}-${m}-${d}` >= item.datum, `${item.id}: ${regel.moment}`).toBe(true);
      }
    }
    // En de omschrijving "augustus" past bij een augustusdatum.
    const vb5 = REVIEW_EXAMPLE_ITEMS.find((i) => i.id === "vb-5")!;
    expect(vb5.datum.startsWith("2026-08-")).toBe(true);
    expect(vb5.activiteit.every((r) => r.moment.slice(3, 10) === "08-2026")).toBe(true);
  });

  it("8. elk voorbeeldvoorstel is in balans en elke regel is óf debet óf credit", () => {
    for (const item of REVIEW_EXAMPLE_ITEMS) {
      const { debetCents, creditCents } = proposalTotals(item.voorstel);
      expect(debetCents, item.id).toBe(creditCents);
      expect(debetCents, item.id).toBe(Math.abs(item.bedragCents));
      for (const line of item.voorstel) {
        expect((line.debetCents > 0) !== (line.creditCents > 0), `${item.id} ${line.rekening}`).toBe(true);
        expect(Number.isInteger(line.debetCents) && Number.isInteger(line.creditCents)).toBe(true);
      }
    }
  });
});

describe("Review — geen databaseverbinding, wel bereikbaar", () => {
  const strip = (pad: string) =>
    readFileSync(resolve(process.cwd(), pad), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//"))
      .join("\n");

  it("9. pagina en voorbeelddata importeren geen Supabase, geen hooks met data en geen mutatie", () => {
    for (const pad of ["src/pages/Review.tsx", "src/lib/review-workspace-mock.ts"]) {
      const bron = strip(pad);
      expect(bron, pad).not.toMatch(/integrations\/supabase|@\/hooks\/|useQuery|useMutation|\.rpc\(|\.from\(|fetch\(/);
    }
    // De voorbeelddata hangt nergens van af.
    expect(strip("src/lib/review-workspace-mock.ts")).not.toMatch(/^import /m);
  });

  it("10. /review bestaat als route en als nav-item, en is actief op die route", () => {
    expect(readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8")).toContain(
      '<Route path="/review" element={<Review />} />',
    );
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.url === "/review");
    expect(item?.title).toBe("Review");
    expect(pageTitleForPath("/review")).toBe("Review");

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Review/ })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute("data-active", "false");
  });
});
