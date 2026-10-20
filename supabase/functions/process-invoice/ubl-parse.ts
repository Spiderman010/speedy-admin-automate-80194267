import { XMLParser, XMLValidator } from "https://esm.sh/fast-xml-parser@4.5.3";
import { extractUblInvoice } from "./ubl-extract.ts";

export const UBL_MIME_TYPES = new Set(["application/xml", "text/xml"]);
export const UBL_MAX_BYTES = 1_000_000;

// XML invoice data is untrusted: validate structure and explicitly disable
// external and internal entity handling before extracting financial fields.
export function parseUblXml(xml: string) {
  if (new TextEncoder().encode(xml).byteLength > UBL_MAX_BYTES) {
    throw new Error("UBL-bestand is te groot (maximaal 1 MB)");
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error("UBL met DTD of entiteiten is niet toegestaan");
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error("Ongeldige UBL XML-structuur");
  }
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: false,
    allowBooleanAttributes: false,
  });
  return extractUblInvoice(parser.parse(xml));
}
