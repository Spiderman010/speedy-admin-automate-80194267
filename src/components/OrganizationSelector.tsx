import { useOrganizations } from "@/hooks/useOrganizations";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClientContext } from "@/hooks/useClientContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function OrganizationSelector() {
  const { data: organizations } = useOrganizations();
  const { activeOrganizationId, setActiveOrganizationId } = useActiveOrganization();
  const { setSelectedClientId } = useClientContext();

  if (!organizations || organizations.length <= 1) return null;

  const handleChange = (orgId: string) => {
    setActiveOrganizationId(orgId);
    setSelectedClientId("all");
  };

  const activeName = organizations.find((o) => o.id === activeOrganizationId)?.name;

  return (
    <div className="px-3 py-3 border-b border-sidebar-border">
      <p className="text-xs text-sidebar-foreground/50 mb-1.5 px-1">Organisatie</p>
      <Select value={activeOrganizationId ?? ""} onValueChange={handleChange}>
        <SelectTrigger className="w-full bg-sidebar-accent border-sidebar-border text-sidebar-foreground text-sm h-9">
          <SelectValue placeholder="Kies een organisatie">
            {activeName ?? "Kies een organisatie"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {organizations.map((org) => (
            <SelectItem key={org.id} value={org.id}>
              {org.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
