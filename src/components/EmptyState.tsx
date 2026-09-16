import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  message: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
}

export function EmptyState({ message, icon: Icon, children }: EmptyStateProps) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center text-muted-foreground sm:py-12">
      {Icon && (
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border bg-muted/60 shadow-sm">
          <Icon className="h-5 w-5 opacity-70" />
        </div>
      )}
      <p className="max-w-sm text-sm leading-relaxed">{message}</p>
      {children && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}
