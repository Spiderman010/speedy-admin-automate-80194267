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

/** True when string looks like a raw MT940 structured description. */
export function isMT940Description(description: string | null | undefined): boolean {
  if (!description) return false;
  return /\/(NAME|CNTP|REMI|EREF|TRTP|IBAN)\//.test(description);
}

/**
 * Build a short, human readable title from a (possibly MT940) string.
 * Falls back to the original string when it does not look like MT940.
 */
export function formatMT940Title(description: string | null | undefined, fallback = "Banktransactie"): string {
  if (!description) return fallback;
  if (!isMT940Description(description)) return description;
  const parsed = parseMT940Description(description);
  if (parsed.name) return parsed.name;
  if (parsed.reference) return parsed.reference;
  return fallback;
}

/**
 * Build a short detail line (e.g. reference / IBAN) from a MT940 string.
 * Returns the original string unchanged when it does not look like MT940,
 * or null when nothing useful can be shown.
 */
export function formatMT940Detail(description: string | null | undefined): string | null {
  if (!description) return null;
  if (!isMT940Description(description)) return description;
  const parsed = parseMT940Description(description);
  const parts: string[] = [];
  if (parsed.reference) parts.push(parsed.reference);
  if (parsed.iban) parts.push(parsed.iban);
  return parts.length ? parts.join(" · ") : null;
}

