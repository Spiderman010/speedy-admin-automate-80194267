import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  message: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
}

export function EmptyState({ message, icon: Icon, children }: EmptyStateProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center text-muted-foreground sm:py-10">
      {Icon && (
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md border border-primary/15 bg-primary/[0.07]">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      )}
      <p className="max-w-sm text-sm leading-relaxed">{message}</p>
      {children && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}
