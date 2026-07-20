import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!(Element.prototype as any).hasPointerCapture) {
  (Element.prototype as any).hasPointerCapture = () => false;
  (Element.prototype as any).setPointerCapture = () => {};
  (Element.prototype as any).releasePointerCapture = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
}

const toastSpy = vi.fn();
const deleteMutateAsync = vi.fn();
const addMutateAsync = vi.fn();

const journalEntry = {
  id: "journal-1",
  user_id: "user-1",
  client_id: "client-1",
  organization_id: "org-1",
  entry_date: "2026-07-20",
  description: "Kantoorartikelen",
  amount: 121,
  btw_percentage: 21,
  btw_amount: 21,
  ledger_account_id: null,
  grootboekrekening_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  invoice_number: "J-001",
  entry_type: "handmatig",
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
};

vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({ title, description, children }: any) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </div>
  ),
}));

vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: () => <div data-testid="grootboek-combobox" />,
}));

vi.mock("@/components/NoClientBanner", () => ({
  NoClientBanner: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: false }],
  }),
}));

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({
    selectedClientId: "client-1",
    setSelectedClientId: vi.fn(),
  }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({
    activeOrganizationId: "org-1",
    isReady: true,
  }),
}));

vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [] }),
}));

vi.mock("@/hooks/useJournalEntries", () => ({
  useJournalEntries: () => ({ data: [journalEntry] }),
  useAddJournalEntry: () => ({ mutateAsync: addMutateAsync, isPending: false }),
  useDeleteJournalEntry: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
}));

vi.mock("@/lib/snelstart-export", () => ({
  exportJournalEntriesCSV: vi.fn(),
}));

import Boekingen from "@/pages/Boekingen";

describe("Boekingen verwijderen", () => {
  beforeEach(() => {
    toastSpy.mockReset();
    deleteMutateAsync.mockReset();
    addMutateAsync.mockReset();
  });

  it("toont bevestiging en annuleert zonder delete-mutation", async () => {
    render(<Boekingen />);

    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));

    expect(screen.getByText("Boeking verwijderen?")).toBeInTheDocument();
    expect(screen.getByText("Deze actie kan niet ongedaan worden gemaakt.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Annuleren" }));

    await waitFor(() => {
      expect(screen.queryByText("Boeking verwijderen?")).not.toBeInTheDocument();
    });
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });

  it("verwijdert na bevestiging de juiste boeking en toont een succes-toast", async () => {
    deleteMutateAsync.mockResolvedValue("journal-1");

    render(<Boekingen />);

    fireEvent.click(screen.getByRole("button", { name: "Verwijder boeking" }));
    fireEvent.click(screen.getByRole("button", { name: "Verwijderen" }));

    await waitFor(() => {
      expect(deleteMutateAsync).toHaveBeenCalledWith("journal-1");
    });
    expect(toastSpy).toHaveBeenCalledWith({ title: "Boeking verwijderd" });
  });
});
