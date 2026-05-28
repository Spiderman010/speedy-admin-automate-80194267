import type { MouseEvent } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type InvoiceNumberCopyButtonProps = {
  invoiceNumber: string;
  className?: string;
};

export function InvoiceNumberCopyButton({
  invoiceNumber,
  className = "",
}: InvoiceNumberCopyButtonProps) {
  const { toast } = useToast();

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(invoiceNumber);
      toast({ title: "Factuurnummer gekopieerd" });
    } catch (error) {
      const description = error instanceof Error
        ? error.message
        : "Factuurnummer kon niet worden gekopieerd.";

      toast({
        title: "Kopieren mislukt",
        description,
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title="Kopieer factuurnummer"
      aria-label="Kopieer factuurnummer"
      className={`h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground ${className}`.trim()}
      onClick={handleCopy}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}
