export function FilterChip({
  label, active, count, onClick, activeClassName,
}: {
  label: string; active: boolean; count?: number;
  onClick: () => void; activeClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? (activeClassName ?? "border-primary bg-primary text-primary-foreground")
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`rounded-full px-1.5 text-[10px] font-semibold leading-tight ${active ? "bg-black/15" : "bg-muted"}`}>
          {count}
        </span>
      )}
    </button>
  );
}
