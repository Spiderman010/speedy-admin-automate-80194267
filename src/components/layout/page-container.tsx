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
    <div className={cn("mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-5 sm:py-5 lg:px-6", className)}>
      {children}
    </div>
  );
}
