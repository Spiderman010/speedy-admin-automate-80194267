import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  message: string;
  icon?: LucideIcon;
}

export function EmptyState({ message, icon: Icon }: EmptyStateProps) {
  return (
    <div className="py-12 text-center text-muted-foreground">
      {Icon && <Icon className="mx-auto mb-3 h-8 w-8 opacity-40" />}
      <p className="text-sm">{message}</p>
    </div>
  );
}
