import type { HTMLAttributes, ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/**
 * Platform Kit — één melding voor boekhoudkundige informatie, waarschuwingen
 * en blokkades.
 *
 * Dit is geen nieuw meldingsraamwerk: het is de bestaande shadcn `Alert` met
 * de ernst er expliciet bij. Dat was nodig omdat `Alert` maar twee varianten
 * kent (`default` en `destructive`), terwijl het ontwerpsysteem de tokens
 * `--warning`, `--info` en `--success` al heeft en `Badge` ze ook al gebruikt.
 * Gevolg in de bestaande app: een waarschuwing werd ofwel rood gezet alsof het
 * een fout was, ofwel met losse `amber-*`-kleuren buiten het tokensysteem om
 * nagebouwd. Deze component is de brug daartussen, niet iets nieuws.
 *
 * De ernst wordt door de beller bepaald. Er wordt hier niets afgeleid uit de
 * inhoud van de melding, en er wordt nooit een melding verzonnen of
 * weggelaten.
 */
export type AccountingNoticeSeverity = "info" | "warning" | "blocking";

interface SeverityPresentation {
  variant: "default" | "destructive";
  className?: string;
  icon: LucideIcon;
}

const SEVERITY_PRESENTATION: Readonly<Record<AccountingNoticeSeverity, SeverityPresentation>> = {
  info: { variant: "default", icon: Info },
  /**
   * Zelfde vorm als de `destructive`-variant van `Alert` — rand, tekst en icoon
   * in één tint — maar met het waarschuwingstoken in plaats van het foutentoken.
   */
  warning: {
    variant: "default",
    className: "border-warning/50 text-warning [&>svg]:text-warning",
    icon: AlertTriangle,
  },
  blocking: { variant: "destructive", icon: AlertCircle },
};

export interface AccountingNoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  severity: AccountingNoticeSeverity;
  /** Kopregel. Laat weg wanneer één zin genoeg is. */
  title?: ReactNode;
  /**
   * Ander icoon dan het standaardicoon van deze ernst, of `null` voor geen
   * icoon (voor meldingen die er in de bestaande app ook geen hebben).
   */
  icon?: LucideIcon | null;
  children: ReactNode;
}

export function AccountingNotice({
  severity,
  title,
  icon,
  children,
  className,
  ...rest
}: AccountingNoticeProps) {
  const presentation = SEVERITY_PRESENTATION[severity];
  const Icon = icon === undefined ? presentation.icon : icon;
  return (
    <Alert
      variant={presentation.variant}
      className={cn(presentation.className, className)}
      data-severity={severity}
      {...rest}
    >
      {Icon !== null && <Icon className="h-4 w-4" />}
      {title !== undefined && title !== null && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
