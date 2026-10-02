import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { FileText, ExternalLink, Loader2 } from "lucide-react";

/**
 * Original-document panel for the purchase-invoice workspace.
 *
 * Behaviour is unchanged from the previous inline InvoicePreview: it creates a
 * one-hour signed URL for the stored file, renders PDFs in an iframe and
 * images in an <img>, and offers an "open in new tab" action. Only the
 * presentation (panel chrome, sizing) lives here; the parent decides height.
 */
export function PurchaseInvoiceDocumentPreview({ filePath }: { filePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) { setUrl(null); setError(null); return; }
    setLoading(true); setError(null); setUrl(null);
    supabase.storage.from("invoices").createSignedUrl(filePath, 3600)
      .then(({ data, error }) => {
        if (error) setError("Document niet beschikbaar");
        else setUrl(data?.signedUrl ?? null);
      })
      .catch(() => setError("Document niet beschikbaar"))
      .finally(() => setLoading(false));
  }, [filePath]);

  const fileName = filePath ? filePath.split("/").pop() ?? filePath : null;
  const isPdf = !!filePath && filePath.toLowerCase().endsWith(".pdf");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="whitespace-nowrap text-sm font-semibold text-foreground">
            Origineel document
          </span>
          {fileName && (
            <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:inline" title={fileName}>
              {fileName}
            </span>
          )}
        </div>
        {url && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 shrink-0 px-2"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            title="Open in nieuw tabblad"
            aria-label="Open in nieuw tabblad"
          >
            <ExternalLink className="h-3.5 w-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">Openen</span>
          </Button>
        )}
      </div>

      <div className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-sm border bg-muted/60">
        {!filePath ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-muted-foreground">
            <FileText className="mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm">Geen bestand beschikbaar</p>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Document laden…
          </div>
        ) : error || !url ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            {error ?? "Document niet beschikbaar"}
          </div>
        ) : isPdf ? (
          <iframe src={url} className="h-full w-full bg-white" title="Factuur PDF" />
        ) : (
          <div className="h-full overflow-auto p-3">
            <img src={url} alt="Factuurdocument" className="h-auto w-full bg-white shadow-[0_1px_4px_rgba(15,23,42,0.12)]" />
          </div>
        )}
      </div>
    </div>
  );
}
