export type DocumentRoute =
  | "originele_ubl"
  | "boekassist_ubl"
  | "pdf_route"
  | "vraagpost"
  | "handmatig";

export const DOCUMENT_ROUTE_LABELS: Record<DocumentRoute, string> = {
  originele_ubl: "Originele UBL",
  boekassist_ubl: "BoekAssist UBL",
  pdf_route: "PDF-route",
  vraagpost: "Vraagpost",
  handmatig: "Handmatig",
};

export const DOCUMENT_ROUTE_OPTIONS: { value: DocumentRoute; label: string }[] =
  (Object.keys(DOCUMENT_ROUTE_LABELS) as DocumentRoute[]).map((v) => ({
    value: v,
    label: DOCUMENT_ROUTE_LABELS[v],
  }));

export function getDocumentRoute(route: string | null | undefined): DocumentRoute {
  if (route && route in DOCUMENT_ROUTE_LABELS) return route as DocumentRoute;
  return "pdf_route";
}

export function getDocumentRouteLabel(route: string | null | undefined): string {
  return DOCUMENT_ROUTE_LABELS[getDocumentRoute(route)];
}
