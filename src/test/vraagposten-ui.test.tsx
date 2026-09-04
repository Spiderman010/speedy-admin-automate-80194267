import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import path from "node:path";

const state = {
  vraagposten: [] as any[],
  isLoading: false,
  isError: false,
  selectedClientId: "all" as string,
  queryArgs: [] as any[],
  deleteShouldFail: false,
};

const toastSpy = vi.fn();
const updateStatusSpy = vi.fn(() => Promise.resolve({}));
const deleteSpy = vi.fn(() => (state.deleteShouldFail ? Promise.reject(new Error("boem")) : Promise.resolve()));
const refetchSpy = vi.fn();

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Bakkerij Jansen" }, { id: "c2", name: "Garage Pietersen" }] }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/hooks/useVraagposten", async (orig) => {
  const actual = await orig<typeof import("@/hooks/useVraagposten")>();
  return {
    ...actual,
    useVraagposten: (args: any) => {
      state.queryArgs.push(args);
      return {
        data: state.isLoading || state.isError ? undefined : state.vraagposten,
        isLoading: state.isLoading,
        isError: state.isError,
        refetch: refetchSpy,
      };
    },
    useUpdateVraagpostStatus: () => ({ mutateAsync: updateStatusSpy }),
    useDeleteVraagpost: () => ({ mutateAsync: deleteSpy }),
  };
});

const mt940 = { title: 0, detail: 0 };
vi.mock("@/lib/mt940-description-parser", async (orig) => {
  const actual = await orig<typeof import("@/lib/mt940-description-parser")>();
  return {
    ...actual,
    formatMT940Title: (...a: Parameters<typeof actual.formatMT940Title>) => {
      mt940.title++;
      return actual.formatMT940Title(...a);
    },
    formatMT940Detail: (...a: Parameters<typeof actual.formatMT940Detail>) => {
      mt940.detail++;
      return actual.formatMT940Detail(...a);
    },
  };
});

import Vraagposten from "@/pages/Vraagposten";

const vp = (over: Partial<any> = {}) => ({
  id: "vp-1",
  client_id: "c1",
  source_type: "purchase_invoice",
  categorie: "btw_nummer_ontbreekt",
  titel: "Factuur zonder btw-nummer",
  omschrijving: "Controleer de leverancier",
  status: "open",
  created_at: "2026-01-15T10:00:00Z",
  ...over,
});

const renderPage = (initial = "/vraagposten") =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Vraagposten />
    </MemoryRouter>
  );

beforeEach(() => {
  state.vraagposten = [
    vp({ id: "vp-open", status: "open" }),
    vp({ id: "vp-beh", status: "in_behandeling", titel: "Bon ontbreekt", client_id: "c2" }),
    vp({
      id: "vp-op",
      status: "opgelost",
      titel: "/NAME/ALBERT HEIJN/REMI/Bonnetje/IBAN/NL12RABO0123456789",
      omschrijving: "/NAME/ALBERT HEIJN/REMI/Bonnetje/IBAN/NL12RABO0123456789",
      source_type: "bank_transaction",
      categorie: "kassabon_geen_ubl",
    }),
    vp({ id: "vp-neg", status: "genegeerd", titel: "Oude post" }),
  ];
  state.isLoading = false;
  state.isError = false;
  state.selectedClientId = "all";
  state.queryArgs = [];
  state.deleteShouldFail = false;
  mt940.title = 0;
  mt940.detail = 0;
  toastSpy.mockClear();
  updateStatusSpy.mockClear();
  deleteSpy.mockClear();
  refetchSpy.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.useRealTimers());

const source = readFileSync(path.resolve(__dirname, "../pages/Vraagposten.tsx"), "utf8");

const chip = (label: string) =>
  screen.getAllByRole("button").find(b => b.textContent?.startsWith(label))!;

describe("Vraagposten overzicht", () => {
  it("rendert met sr-only h1 en zonder zichtbare dubbele titel", () => {
    renderPage();
    const h1 = screen.getByRole("heading", { level: 1, name: "Vraagposten" });
    expect(h1).toHaveClass("sr-only");
    expect(source).not.toContain("PageHeader");
  });

  it("toont een compacte werkvoorraadtelling zonder financieel totaal", () => {
    renderPage();
    expect(screen.getByText("4 vraagposten")).toBeInTheDocument();
    expect(screen.queryByText(/€/)).not.toBeInTheDocument();
  });

  it("toont alle vijf filterchips ook zonder data", () => {
    state.vraagposten = [];
    renderPage();
    ["Alle", "Open", "In behandeling", "Opgelost", "Genegeerd"].forEach(l => {
      expect(chip(l)).toBeTruthy();
    });
  });

  it("toont correcte statuscounts", () => {
    renderPage();
    expect(chip("Alle").textContent).toContain("4");
    expect(chip("Open").textContent).toContain("1");
    expect(chip("In behandeling").textContent).toContain("1");
    expect(chip("Opgelost").textContent).toContain("1");
    expect(chip("Genegeerd").textContent).toContain("1");
  });

  it("start standaard op alle vraagposten", () => {
    renderPage();
    expect(screen.getAllByRole("row")).toHaveLength(5); // header + 4
  });

  it.each([
    ["Open", "vp-open", "Factuur zonder btw-nummer"],
    ["In behandeling", "vp-beh", "Bon ontbreekt"],
    ["Genegeerd", "vp-neg", "Oude post"],
  ])("filtert op status %s", (label, _id, titel) => {
    renderPage();
    fireEvent.click(chip(label));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText(titel)).toBeInTheDocument();
  });

  it("filtert op status Opgelost", () => {
    renderPage();
    fireEvent.click(chip("Opgelost"));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("ALBERT HEIJN")).toBeInTheDocument();
  });

  const search = (q: string) =>
    fireEvent.change(screen.getByLabelText("Zoeken in vraagposten"), { target: { value: q } });

  it("zoekt op titel", () => {
    renderPage();
    search("Bon ontbreekt");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("zoekt op omschrijving", () => {
    renderPage();
    search("Controleer de leverancier");
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("zoekt op bron", () => {
    renderPage();
    search("Banktransactie");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("zoekt op categorie", () => {
    renderPage();
    search("Kassabon zonder UBL");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("zoekt op klant", () => {
    renderPage();
    search("Garage Pietersen");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("zoekt op status", () => {
    renderPage();
    search("Genegeerd");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("combineert zoeken en statusfilter", () => {
    renderPage();
    search("Controleer de leverancier");
    fireEvent.click(chip("Open"));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Factuur zonder btw-nummer")).toBeInTheDocument();
  });

  it("toont statusbadges", () => {
    renderPage();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getAllByText("In behandeling").length).toBeGreaterThan(0);
  });

  it("gebruikt de MT940 formatters", () => {
    renderPage();
    expect(mt940.title).toBeGreaterThan(0);
    expect(mt940.detail).toBeGreaterThan(0);
    expect(screen.getByText("ALBERT HEIJN")).toBeInTheDocument();
    expect(source).toContain("formatMT940Title");
    expect(source).toContain("formatMT940Detail");
  });

  it("houdt detailtekst op maximaal twee regels", () => {
    expect(source).toContain("line-clamp-2");
  });
});

describe("Vraagposten acties", () => {
  it("oplossen gebruikt bestaande mutation en toont toast", async () => {
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: /Oplossen/ }));
    await waitFor(() => expect(updateStatusSpy).toHaveBeenCalledWith({ id: "vp-open", status: "opgelost" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Vraagpost opgelost" }));
  });

  it("negeren gebruikt bestaande mutation", async () => {
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: /Negeren/ }));
    await waitFor(() => expect(updateStatusSpy).toHaveBeenCalledWith({ id: "vp-open", status: "genegeerd" }));
  });

  it("heropenen gebruikt bestaande mutation", async () => {
    renderPage();
    fireEvent.click(chip("Genegeerd"));
    fireEvent.click(screen.getByRole("button", { name: /Heropenen/ }));
    await waitFor(() => expect(updateStatusSpy).toHaveBeenCalledWith({ id: "vp-neg", status: "open" }));
  });

  it("roept nooit rechtstreeks supabase aan vanuit de pagina", () => {
    expect(source).not.toContain("integrations/supabase/client");
  });

  it("verwijderen opent bevestiging met duidelijke tekst", () => {
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Vraagpost verwijderen" }));
    expect(screen.getByText(/banktransactie of factuur blijft ongewijzigd/)).toBeInTheDocument();
  });

  it("annuleren verwijdert niets", async () => {
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Vraagpost verwijderen" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuleren" }));
    await waitFor(() => expect(deleteSpy).not.toHaveBeenCalled());
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  it("bevestigen gebruikt de bestaande delete mutation", async () => {
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Vraagpost verwijderen" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("vp-open"));
    // bron blijft ongewijzigd: geen andere mutation aangeroepen
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  it("toont een foutmelding als verwijderen mislukt", async () => {
    state.deleteShouldFail = true;
    renderPage();
    fireEvent.click(chip("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Vraagpost verwijderen" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Fout bij verwijderen", variant: "destructive" })
      )
    );
  });
});

describe("Vraagposten scope, focus en states", () => {
  it("geeft een specifieke klant door aan de query", () => {
    state.selectedClientId = "c1";
    renderPage();
    expect(state.queryArgs[0]).toMatchObject({ organizationId: "org-1", clientId: "c1" });
  });

  it("laat clientId weg bij organisatiebrede scope", () => {
    state.selectedClientId = "all";
    renderPage();
    expect(state.queryArgs[0].clientId).toBeUndefined();
    expect(state.queryArgs[0].organizationId).toBe("org-1");
  });

  it("scrollt en markeert de rij uit de focus-parameter en laat de markering verdwijnen", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <MemoryRouter initialEntries={["/vraagposten?focus=vp-beh"]}>
        <Vraagposten />
      </MemoryRouter>
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    const highlighted = () => container.querySelectorAll(".border-amber-300").length;
    expect(highlighted()).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(highlighted()).toBe(0);
  });

  it("toont skeletons tijdens laden", () => {
    state.isLoading = true;
    const { container } = renderPage();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("toont een foutstatus met opnieuw proberen", () => {
    state.isError = true;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(refetchSpy).toHaveBeenCalled();
  });

  it("toont lege staat zonder vraagposten", () => {
    state.vraagposten = [];
    renderPage();
    expect(screen.getByText("Geen vraagposten")).toBeInTheDocument();
  });

  it("toont lege staat voor zoekresultaten", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Zoeken in vraagposten"), { target: { value: "zzzzz" } });
    expect(screen.getByText("Geen zoekresultaten")).toBeInTheDocument();
  });

  it("toont statusspecifieke lege staat", () => {
    state.vraagposten = [vp({ id: "vp-op2", status: "opgelost" })];
    renderPage();
    fireEvent.click(chip("Open"));
    expect(screen.getByText("Geen open vraagposten")).toBeInTheDocument();
  });

  it("gebruikt responsive kolomklassen", () => {
    expect(source).toContain("hidden sm:table-cell");
    expect(source).toContain("hidden md:table-cell");
    expect(source).toContain("hidden lg:table-cell");
  });

  it("voegt geen route of databasewerk toe", () => {
    expect(source).not.toContain("Route");
    expect(source).not.toMatch(/\.from\(/);
    expect(source).not.toContain("rpc(");
  });
});
