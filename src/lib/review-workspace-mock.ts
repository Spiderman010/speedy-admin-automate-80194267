/**
 * Review-werkbank — VOORBEELDDATA voor het visuele prototype.
 *
 * Alles hier is fictief en lokaal. Er is geen databaseverbinding, geen query,
 * geen RPC en geen schrijfpad; dit bestand importeert niets uit de app. De
 * statussen zijn ingevuld, niet afgeleid: dit prototype beoordeelt niets.
 * Zodra de werkbank echt wordt, komen de items uit bestaande leesmodellen en
 * blijft de database de autoriteit voor bedragen, BTW, debet/credit en status.
 */

export type ReviewStatus = "klaar" | "aandacht" | "geblokkeerd";
export type ReviewItemType = "inkoopfactuur" | "verkoopfactuur" | "banktransactie" | "memoriaal";

export interface ReviewProposalLine {
  rekening: string;
  omschrijving: string;
  /** Hele centen; precies één van debet/credit is groter dan nul. */
  debetCents: number;
  creditCents: number;
}

export interface ReviewActivity {
  moment: string;
  tekst: string;
}

export interface ReviewItem {
  id: string;
  /** ISO-datum (JJJJ-MM-DD). */
  datum: string;
  type: ReviewItemType;
  relatie: string;
  omschrijving: string;
  referentie: string;
  /** Hele centen; negatief = geld uit. */
  bedragCents: number;
  status: ReviewStatus;
  /** Waarom deze status — één zin, voor de tabel én het paneel. */
  reden: string;
  toelichting: string;
  voorstel: ReviewProposalLine[];
  bijlagen: string[];
  activiteit: ReviewActivity[];
}

export const REVIEW_EXAMPLE_ADMINISTRATION = "Voorbeeld Bakkerij B.V.";
export const REVIEW_EXAMPLE_PERIOD = "Q3 2026";

export const REVIEW_TYPE_LABELS: Readonly<Record<ReviewItemType, string>> = {
  inkoopfactuur: "Inkoopfactuur",
  verkoopfactuur: "Verkoopfactuur",
  banktransactie: "Bank",
  memoriaal: "Memoriaal",
};

export const REVIEW_STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  klaar: "Klaar",
  aandacht: "Aandacht nodig",
  geblokkeerd: "Geblokkeerd",
};

const regel = (rekening: string, omschrijving: string, debetCents: number, creditCents: number): ReviewProposalLine => ({
  rekening,
  omschrijving,
  debetCents,
  creditCents,
});

export const REVIEW_EXAMPLE_ITEMS: readonly ReviewItem[] = [
  {
    id: "vb-1",
    datum: "2026-09-02",
    type: "inkoopfactuur",
    relatie: "Meelhandel Noord",
    omschrijving: "Bloem en gist, september",
    referentie: "MN-2026-0912",
    bedragCents: -121000,
    status: "klaar",
    reden: "Alle velden herkend; rekening en BTW volgen de vaste regel.",
    toelichting:
      "Dezelfde leverancier is de afgelopen zes maanden steeds op 7000 Inkoop grondstoffen geboekt met 9% BTW. Bedragen en BTW sluiten aan op de factuur.",
    voorstel: [
      regel("7000 Inkoop grondstoffen", "Bloem en gist", 111009, 0),
      regel("1520 BTW te vorderen", "BTW 9%", 9991, 0),
      regel("1600 Crediteuren", "Meelhandel Noord", 0, 121000),
    ],
    bijlagen: ["MN-2026-0912.pdf"],
    activiteit: [
      { moment: "02-09-2026 08:14", tekst: "Factuur ontvangen via inkoopmailbox" },
      { moment: "02-09-2026 08:15", tekst: "Velden herkend, voorstel opgesteld" },
    ],
  },
  {
    id: "vb-2",
    datum: "2026-09-03",
    type: "banktransactie",
    relatie: "Meelhandel Noord",
    omschrijving: "Betaling MN-2026-0815",
    referentie: "NL91 ABNA 0417 1643 00",
    bedragCents: -86450,
    status: "klaar",
    reden: "Bedrag en kenmerk komen exact overeen met een open factuur.",
    toelichting: "De betaling past precies op factuur MN-2026-0815; voorstel is afletteren op crediteuren.",
    voorstel: [
      regel("1600 Crediteuren", "Meelhandel Noord", 86450, 0),
      regel("1100 Bank", "Betaling MN-2026-0815", 0, 86450),
    ],
    bijlagen: [],
    activiteit: [{ moment: "03-09-2026 06:02", tekst: "Banktransactie ingelezen" }],
  },
  {
    id: "vb-3",
    datum: "2026-09-05",
    type: "verkoopfactuur",
    relatie: "Hotel De Linde",
    omschrijving: "Levering brood, week 36",
    referentie: "VF-2026-0311",
    bedragCents: 54500,
    status: "aandacht",
    reden: "Afwijkend BTW-tarief ten opzichte van eerdere facturen.",
    toelichting:
      "Eerdere facturen aan deze klant hadden 9% BTW; deze heeft 21%. Controleer of er naast brood ook andere producten zijn geleverd.",
    voorstel: [
      regel("1300 Debiteuren", "Hotel De Linde", 54500, 0),
      regel("8000 Omzet", "Levering week 36", 0, 45041),
      regel("1500 BTW te betalen", "BTW 21%", 0, 9459),
    ],
    bijlagen: ["VF-2026-0311.pdf"],
    activiteit: [
      { moment: "05-09-2026 16:40", tekst: "Factuur aangemaakt" },
      { moment: "05-09-2026 16:41", tekst: "Gemarkeerd: afwijkend BTW-tarief" },
    ],
  },
  {
    id: "vb-4",
    datum: "2026-09-08",
    type: "banktransactie",
    relatie: "Onbekend",
    omschrijving: "Overboeking zonder omschrijving",
    referentie: "NL20 INGB 0001 2345 67",
    bedragCents: -25000,
    status: "aandacht",
    reden: "Geen relatie en geen omschrijving; rekening kan niet worden voorgesteld.",
    toelichting:
      "Er is geen open factuur of eerdere regel die bij deze betaling past. Een vraagpost aan de klant ligt voor de hand.",
    voorstel: [
      regel("2000 Tussenrekening", "Nog te bepalen", 25000, 0),
      regel("1100 Bank", "Overboeking", 0, 25000),
    ],
    bijlagen: [],
    activiteit: [{ moment: "08-09-2026 06:03", tekst: "Banktransactie ingelezen" }],
  },
  {
    id: "vb-5",
    datum: "2026-09-12",
    type: "inkoopfactuur",
    relatie: "Energie Direct",
    omschrijving: "Energie augustus",
    referentie: "ED-77812",
    bedragCents: -48279,
    status: "geblokkeerd",
    reden: "Boekingsdatum valt binnen de boekingsblokkade (voorbeeld).",
    toelichting:
      "In dit voorbeeld is de administratie geblokkeerd tot en met 31-08-2026 en de factuur is gedateerd in augustus. Boeken kan pas na een aangepaste blokkade of een andere boekingsdatum.",
    voorstel: [
      regel("4300 Energiekosten", "Energie augustus", 39900, 0),
      regel("1520 BTW te vorderen", "BTW 21%", 8379, 0),
      regel("1600 Crediteuren", "Energie Direct", 0, 48279),
    ],
    bijlagen: ["ED-77812.pdf"],
    activiteit: [
      { moment: "12-09-2026 09:20", tekst: "Factuur geüpload" },
      { moment: "12-09-2026 09:21", tekst: "Geblokkeerd: boekingsblokkade" },
    ],
  },
  {
    id: "vb-6",
    datum: "2026-09-15",
    type: "memoriaal",
    relatie: "—",
    omschrijving: "Afschrijving bakoven september",
    referentie: "MEM-2026-09",
    bedragCents: 31250,
    status: "klaar",
    reden: "Terugkerende memoriaalpost; bedrag gelijk aan vorige maand.",
    toelichting: "Maandelijkse afschrijving volgens het afschrijvingsschema van de bakoven.",
    voorstel: [
      regel("4800 Afschrijvingen", "Bakoven september", 31250, 0),
      regel("0210 Cumulatieve afschrijving inventaris", "Bakoven", 0, 31250),
    ],
    bijlagen: [],
    activiteit: [{ moment: "15-09-2026 07:00", tekst: "Terugkerende post klaargezet" }],
  },
  {
    id: "vb-7",
    datum: "2026-09-18",
    type: "verkoopfactuur",
    relatie: "Café Het Plein",
    omschrijving: "Gebak voor evenement",
    referentie: "VF-2026-0318",
    bedragCents: 32700,
    status: "klaar",
    reden: "Alle velden compleet; standaardrekening en 9% BTW.",
    toelichting: "Factuur volgt het vaste patroon voor deze klant.",
    voorstel: [
      regel("1300 Debiteuren", "Café Het Plein", 32700, 0),
      regel("8000 Omzet", "Gebak evenement", 0, 30000),
      regel("1500 BTW te betalen", "BTW 9%", 0, 2700),
    ],
    bijlagen: ["VF-2026-0318.pdf"],
    activiteit: [{ moment: "18-09-2026 11:05", tekst: "Factuur aangemaakt" }],
  },
  {
    id: "vb-8",
    datum: "2026-09-21",
    type: "inkoopfactuur",
    relatie: "Verpakking & Co",
    omschrijving: "Broodzakken en dozen",
    referentie: "—",
    bedragCents: -18150,
    status: "geblokkeerd",
    reden: "Factuurnummer ontbreekt; de factuur kan niet worden geboekt.",
    toelichting:
      "Zonder factuurnummer is de factuur niet uniek te identificeren. Vraag een correcte factuur op bij de leverancier.",
    voorstel: [
      regel("7100 Verpakkingsmateriaal", "Broodzakken en dozen", 15000, 0),
      regel("1520 BTW te vorderen", "BTW 21%", 3150, 0),
      regel("1600 Crediteuren", "Verpakking & Co", 0, 18150),
    ],
    bijlagen: ["scan-0921.jpg"],
    activiteit: [
      { moment: "21-09-2026 13:30", tekst: "Scan geüpload" },
      { moment: "21-09-2026 13:31", tekst: "Geblokkeerd: factuurnummer ontbreekt" },
    ],
  },
  {
    id: "vb-9",
    datum: "2026-09-25",
    type: "banktransactie",
    relatie: "Hotel De Linde",
    omschrijving: "Ontvangst VF-2026-0298",
    referentie: "NL55 RABO 0123 4567 89",
    bedragCents: 39240,
    status: "aandacht",
    reden: "Bedrag wijkt € 0,60 af van de open factuur.",
    toelichting:
      "De ontvangst is € 0,60 lager dan factuur VF-2026-0298 (€ 392,40 tegenover € 393,00). Mogelijk bankkosten of een afrondingsverschil.",
    voorstel: [
      regel("1100 Bank", "Ontvangst VF-2026-0298", 39240, 0),
      regel("1300 Debiteuren", "Hotel De Linde", 0, 39240),
    ],
    bijlagen: [],
    activiteit: [{ moment: "25-09-2026 06:01", tekst: "Banktransactie ingelezen" }],
  },
];

/** Aantal items per status, voor de tellers bovenaan. */
export function countByStatus(items: readonly ReviewItem[]): Record<ReviewStatus, number> {
  const telling: Record<ReviewStatus, number> = { klaar: 0, aandacht: 0, geblokkeerd: 0 };
  for (const item of items) telling[item.status] += 1;
  return telling;
}

/** Debet- en credittotaal van een voorbeeldvoorstel. */
export function proposalTotals(lines: readonly ReviewProposalLine[]): { debetCents: number; creditCents: number } {
  let debetCents = 0;
  let creditCents = 0;
  for (const line of lines) {
    debetCents += line.debetCents;
    creditCents += line.creditCents;
  }
  return { debetCents, creditCents };
}

/** Lokale zoekfilter op de voorbeeldregels (relatie, omschrijving, referentie). */
export function filterReviewItems(
  items: readonly ReviewItem[],
  zoekterm: string,
  status: ReviewStatus | null,
): ReviewItem[] {
  const term = zoekterm.trim().toLowerCase();
  return items.filter(
    (item) =>
      (status === null || item.status === status) &&
      (term === "" ||
        [item.relatie, item.omschrijving, item.referentie, REVIEW_TYPE_LABELS[item.type]].some((veld) =>
          veld.toLowerCase().includes(term),
        )),
  );
}
