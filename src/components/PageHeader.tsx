interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
      <div className="flex-1 overflow-hidden">
        <h1 className="font-display text-2xl font-semibold leading-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-normal text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{children}</div>
      )}
    </div>
  );
}
