import { Card, CardContent } from "@/components/ui/card";

interface NoClientBannerProps {
  message?: string;
}

export function NoClientBanner({
  message = "Kies links in de zijbalk een specifieke klant.",
}: NoClientBannerProps) {
  return (
    <Card>
      <CardContent className="py-6 text-sm text-muted-foreground">{message}</CardContent>
    </Card>
  );
}
