import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const state = {
  leveranciers: [] as any[],
  isLoading: false,
  isError: false,
  selectedClientId: "c1" as string,
  invoiceCount: 0,
  addShouldFail: false,
  deleteShouldFail: false,
};

const toastSpy = vi.fn();
const addSpy = vi.fn((_payload: any) => (state.addShouldFail ? Promise.reject(new Error("boem")) : Promise.resolve({})));
const updateSpy = vi.fn((_payload: any) => Promise.resolve({}));
const deleteSpy = vi.fn((_id?: string) => (state.deleteShouldFail ? Promise.reject(new Error("weg")) : Promise.resolve()));
const refetchSpy = vi.fn();

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({
    data: [{ id: "g1", nummer: 4000, omschrijving: "Inkoopkosten" }],
  }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: (props: any) => (
    <button type="button" data-testid="grootboek-combobox" onClick={() => props.onIdChange?.("g1")}>
      {props.value || props.placeholder}
    </button>
  ),
}));
vi.mock("@/hooks/useLeveranciers", async (orig) => {
  const actual = await orig<typeof import("@/hooks/useLeveranciers")>();
  return {
    ...actual,
    useLeveranciers: () => ({
      data: state.isLoading || state.isError ? undefined : state.leveranciers,
      isLoading: state.isLoading,
      isError: state.isError,
      refetch: refetchSpy,
    }),
    useAddLeverancier: () => ({ mutateAsync: addSpy, isPending: false }),
    useUpdateLeverancier: () => ({ mutateAsync: updateSpy, isPending: false }),
    useDeleteLeverancier: () => ({ mutateAsync: deleteSpy, isPending: false }),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ count: state.invoiceCount, error: null }),
      }),
    }),
  },
}));

import Leveranciers from "@/pages/Leveranciers";
import { normalizeBtwNummer } from "@/hooks/useLeveranciers";

const lev = (over: Partial<any> = {}) => ({
  id: "l1",
  naam: "Bouwmarkt Jansen",
  btw_nummer: "NL123456789B01",
  kvk_nummer: "12345678",
  adres: "Dorpsstraat 1",
  postcode: "1234 AB",
  plaats: "Utrecht",
  land: "NL",
  iban: "NL91ABNA0417164300",
  standaard_grootboekrekening_id: "g1",
  actief: true,
  ...over,
});

const source = readFileSync(path.resolve(__dirname, "../pages/Leveranciers.tsx"), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  state.leveranciers = [];
  state.isLoading = false;
  state.isError = false;
  state.selectedClientId = "c1";
  state.invoiceCount = 0;
  state.addShouldFail = false;
  state.deleteShouldFail = false;
});

describe("Leveranciers pagina", () => {
  it("rendert met sr-only titel", () => {
    render(<Leveranciers />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Leveranciers" });
    expect(h1.className).toContain("sr-only");
  });

  it("toont NoClientBanner zonder specifieke klant", () => {
    state.selectedClientId = "all";
    render(<Leveranciers />);
    expect(screen.getByText(/Kies links in de zijbalk/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nieuwe leverancier/i })).not.toBeInTheDocument();
  });

  it("toont loading skeletons", () => {
    state.isLoading = true;
    const { container } = render(<Leveranciers />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("toont foutstatus met opnieuw proberen", () => {
    state.isError = true;
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(refetchSpy).toHaveBeenCalled();
  });

  it("toont lege staat", () => {
    render(<Leveranciers />);
    expect(screen.getByText("Nog geen leveranciers")).toBeInTheDocument();
  });

  it.each([
    ["naam", "Jansen"],
    ["BTW-nummer", "NL123456789B01"],
    ["KvK-nummer", "12345678"],
    ["plaats", "Utrecht"],
    ["IBAN", "NL91ABNA"],
  ])("zoekt op %s", (_label, term) => {
    state.leveranciers = [lev(), lev({ id: "l2", naam: "Groothandel Pietersen", btw_nummer: "NL999999999B01", kvk_nummer: "87654321", plaats: "Almere", iban: "NL02RABO0999888777" })];
    render(<Leveranciers />);
    fireEvent.change(screen.getByLabelText("Zoeken in leveranciers"), { target: { value: term } });
    expect(screen.getByText("Bouwmarkt Jansen")).toBeInTheDocument();
    expect(screen.queryByText("Groothandel Pietersen")).not.toBeInTheDocument();
  });

  it("toont zoek-empty state", () => {
    state.leveranciers = [lev()];
    render(<Leveranciers />);
    fireEvent.change(screen.getByLabelText("Zoeken in leveranciers"), { target: { value: "zzz" } });
    expect(screen.getByText("Geen zoekresultaten")).toBeInTheDocument();
  });

  it("filtert op status Alle / Actief / Inactief", () => {
    state.leveranciers = [lev(), lev({ id: "l2", naam: "Oude Leverancier", actief: false })];
    render(<Leveranciers />);

    expect(screen.getByText("Bouwmarkt Jansen")).toBeInTheDocument();
    expect(screen.getByText("Oude Leverancier")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Actief/ }));
    expect(screen.queryByText("Oude Leverancier")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Inactief/ }));
    expect(screen.queryByText("Bouwmarkt Jansen")).not.toBeInTheDocument();
    expect(screen.getByText("Oude Leverancier")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Alle/ }));
    expect(screen.getByText("Bouwmarkt Jansen")).toBeInTheDocument();
  });

  it("toont status-empty state", () => {
    state.leveranciers = [lev()];
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: /^Inactief/ }));
    expect(screen.getByText("Geen inactieve leveranciers")).toBeInTheDocument();
  });

  it("opent add dialog en slaat op via bestaande add mutation", async () => {
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: /Nieuwe leverancier/i }));
    expect(screen.getByText("Nieuwe leverancier", { selector: "h2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Naam is verplicht" })));
    expect(addSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Naam *"), { target: { value: "Nieuwe BV" } });
    fireEvent.change(screen.getByLabelText("BTW-nummer"), { target: { value: "nl 1234.56789 b01" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));

    await waitFor(() => expect(addSpy).toHaveBeenCalled());
    expect(addSpy.mock.calls[0][0]).toMatchObject({
      client_id: "c1",
      naam: "Nieuwe BV",
      btw_nummer: normalizeBtwNummer("nl 1234.56789 b01"),
    });
  });

  it("toont fout bij mislukt opslaan", async () => {
    state.addShouldFail = true;
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: /Nieuwe leverancier/i }));
    fireEvent.change(screen.getByLabelText("Naam *"), { target: { value: "Nieuwe BV" } });
    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Opslaan mislukt" }))
    );
  });

  it("opent edit dialog met prefill en gebruikt update mutation", async () => {
    state.leveranciers = [lev()];
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: "Leverancier Bouwmarkt Jansen bewerken" }));

    expect((screen.getByLabelText("Naam *") as HTMLInputElement).value).toBe("Bouwmarkt Jansen");
    expect((screen.getByLabelText("KvK-nummer") as HTMLInputElement).value).toBe("12345678");
    expect(screen.getByTestId("grootboek-combobox")).toHaveTextContent("4000 - Inkoopkosten");

    fireEvent.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ id: "l1", standaard_grootboekrekening_id: "g1" });
  });

  it("verwijdert ongebruikte leverancier echt", async () => {
    state.leveranciers = [lev()];
    state.invoiceCount = 0;
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: "Leverancier Bouwmarkt Jansen verwijderen" }));
    expect(screen.getByText("Leverancier verwijderen?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("l1"));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({ title: "Leverancier verwijderd" });
  });

  it("zet gekoppelde leverancier op inactief in plaats van verwijderen", async () => {
    state.leveranciers = [lev()];
    state.invoiceCount = 3;
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: "Leverancier Bouwmarkt Jansen verwijderen" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith({ id: "l1", actief: false }));
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({
      title: "Leverancier is gekoppeld aan facturen en is daarom op inactief gezet.",
    });
  });

  it("toont fout bij mislukt verwijderen", async () => {
    state.leveranciers = [lev()];
    state.deleteShouldFail = true;
    render(<Leveranciers />);
    fireEvent.click(screen.getByRole("button", { name: "Leverancier Bouwmarkt Jansen verwijderen" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Verwijderen mislukt" }))
    );
  });
});

describe("Leveranciers broncode-garanties", () => {
  it("gebruikt normalizeBtwNummer en geen eigen normalisatie", () => {
    expect(source).toContain("normalizeBtwNummer(form.btw_nummer)");
  });

  it("behoudt de linked-invoice delete-semantiek", () => {
    expect(source).toContain('.from("purchase_invoices")');
    expect(source).toContain('.eq("leverancier_id", deleteConfirm.pendingId)');
    expect(source).toContain("actief: false");
    expect(source).toContain("deleteMut.mutateAsync(deleteConfirm.pendingId)");
  });

  it("houdt GrootboekCombobox en standaard_grootboekrekening_id intact", () => {
    expect(source).toContain("<GrootboekCombobox");
    expect(source).toContain("standaard_grootboekrekening_id");
  });

  it("bevat responsive kolomklassen", () => {
    expect(source).toContain("hidden sm:table-cell");
    expect(source).toContain("hidden md:table-cell");
    expect(source).toContain("hidden lg:table-cell");
  });

  it("kapt lange waarden veilig af en gebruikt touch-vriendelijke actieknoppen", () => {
    expect(source).toContain("truncate");
    expect(source).toContain("break-all");
    expect(source).toContain("h-9 w-9");
    expect(source).toContain("max-h-[90vh]");
  });

  it("bevat geen database- of schemawijzigingen", () => {
    expect(source).not.toMatch(/\.rpc\(|create table|alter table/i);
  });
});
