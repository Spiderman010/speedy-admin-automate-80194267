/**
 * Parse structured MT940 description fields (NAME, IBAN, REMI, etc.)
 */
export interface ParsedMT940Description {
  name: string | null;
  iban: string | null;
  reference: string | null;
  raw: string;
}

export function parseMT940Description(description: string | null): ParsedMT940Description {
  if (!description) return { name: null, iban: null, reference: null, raw: "" };

  const raw = description;
  let name: string | null = null;
  let iban: string | null = null;
  let reference: string | null = null;

  // Try /NAME/ field
  const nameMatch = description.match(/\/NAME\/([^/]+)/);
  if (nameMatch) name = nameMatch[1].trim();

  // Try /IBAN/ field
  const ibanMatch = description.match(/\/IBAN\/([^/]+)/);
  if (ibanMatch) iban = ibanMatch[1].trim();

  // Try /REMI/ field
  const remiMatch = description.match(/\/REMI\/([^/]+)/);
  if (remiMatch) reference = remiMatch[1].trim();

  // Try /EREF/ field as fallback reference
  if (!reference) {
    const erefMatch = description.match(/\/EREF\/([^/]+)/);
    if (erefMatch) reference = erefMatch[1].trim();
  }

  // Fallback: try CNTP format /CNTP/IBAN/BIC/NAME/CITY/
  if (!name || !iban) {
    const cntpMatch = description.match(/\/CNTP\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)/);
    if (cntpMatch) {
      if (!iban && cntpMatch[1]) iban = cntpMatch[1].trim();
      if (!name && cntpMatch[3]) name = cntpMatch[3].trim();
    }
  }

  // Fallback: extract IBAN pattern anywhere
  if (!iban) {
    const ibanPattern = description.match(/([A-Z]{2}\d{2}[A-Z]{4}\d{10,})/);
    if (ibanPattern) iban = ibanPattern[1];
  }

  return { name, iban, reference, raw };
}

/** Get best display label: parsed name or truncated raw */
export function getDisplayDescription(description: string | null): string {
  if (!description) return "—";
  const parsed = parseMT940Description(description);
  return parsed.name || description;
}
