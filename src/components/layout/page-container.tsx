import { cn } from "@/lib/utils";

/**
 * Consistent content wrapper for every page in the shell: one max width,
 * one horizontal padding scale, one vertical rhythm, shared responsive
 * behavior. Pages should not define their own outer layout rules.
 */
export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8", className)}>
      {children}
    </div>
  );
}
