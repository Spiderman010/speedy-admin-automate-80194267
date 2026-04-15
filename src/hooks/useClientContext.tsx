import { createContext, useContext, useState, ReactNode } from "react";

interface ClientContextType {
  selectedClientId: string;
  setSelectedClientId: (id: string) => void;
}

const ClientContext = createContext<ClientContextType>({
  selectedClientId: "all",
  setSelectedClientId: () => {},
});

export function ClientProvider({ children }: { children: ReactNode }) {
  const [selectedClientId, setSelectedClientId] = useState<string>("all");

  return (
    <ClientContext.Provider value={{ selectedClientId, setSelectedClientId }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClientContext() {
  return useContext(ClientContext);
}
