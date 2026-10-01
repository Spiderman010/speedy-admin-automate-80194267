interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="mb-3 flex flex-col gap-2.5 sm:mb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
      <div className="flex-1 overflow-hidden">
        <h1 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-[1.375rem]">{title}</h1>
        {description && (
          <p className="mt-0.5 max-w-3xl text-[13px] leading-snug text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{children}</div>
      )}
    </div>
  );
}
