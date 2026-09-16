interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-col gap-3 border-b pb-5 sm:mb-6 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:pb-6">
      <div className="flex-1 overflow-hidden">
        <h1 className="font-display text-xl font-semibold leading-tight sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{children}</div>
      )}
    </div>
  );
}
