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
    <div className={cn("mx-auto w-full max-w-[1600px] px-3 py-3 sm:px-4 sm:py-4 lg:px-5", className)}>
      {children}
    </div>
  );
}
