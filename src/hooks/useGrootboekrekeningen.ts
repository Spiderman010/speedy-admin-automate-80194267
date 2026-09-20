import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

export interface Grootboekrekening {
  id: string;
  user_id: string;
  client_id: string | null;
  nummer: number;
  omschrijving: string;
  categorie: string;
  actief: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Balans/W&V PR 1 — rapportageclassificatie. Alle vier optioneel en
   * standaard NULL: een rekening zonder classificatie is de normale toestand
   * en blijft dat tot iemand haar invult. `categorie` staat hier los van en
   * verandert niet mee.
   */
  statement_type?: string | null;
  report_group?: string | null;
  /**
   * Tweede niveau van de taxonomie (migratie 20260923120000). Optioneel, net
   * als de andere vier: "categorie gekozen, groep nog niet" is een normale
   * toestand en de toestand waarin elke bestaande classificatie begint.
   */
  report_subgroup?: string | null;
  normal_side?: string | null;
  report_sort?: number | null;
}

/**
 * De classificatievelden zoals ze naar de database gaan. Los benoemd zodat de
 * pagina ze niet stuk voor stuk hoeft door te geven en er nooit een half
 * ingevulde combinatie ontstaat (zie src/lib/reporting-classification.ts).
 */
export interface GrootboekClassificationInput {
  statement_type?: string | null;
  report_group?: string | null;
  report_subgroup?: string | null;
  normal_side?: string | null;
  report_sort?: number | null;
}

/**
 * TIJDELIJKE SHIM — weg zodra 20260923120000 is toegepast en
 * `src/integrations/supabase/types.ts` opnieuw is gegenereerd (nooit met de
 * hand bijwerken, zie AGENTS.md). De gegenereerde types kennen
 * `report_subgroup` nog niet, dus zouden insert en update afketsen op een
 * kolom die in productie straks gewoon bestaat. De cast is zo smal mogelijk:
 * precies deze twee schrijfacties op deze ene tabel, met echte veldtypes —
 * geen brede `any`-laag, en niets wat een ander veld raakt.
 */
type GrootboekWriteRow = Record<string, string | number | boolean | null | undefined>;

interface GrootboekWriteApi {
  from(table: "grootboekrekeningen"): {
    insert(values: GrootboekWriteRow): PromiseLike<{ error: { message?: string; code?: string } | null }>;
    update(values: GrootboekWriteRow): {
      eq(column: "id", value: string): PromiseLike<{ error: { message?: string; code?: string } | null }>;
    };
  };
}

const DEFAULT_ACCOUNTS = [
  // Immateriële vaste activa
  { nummer: 10, omschrijving: "Goodwill verkrijgingsprijs", categorie: "activa" },
  { nummer: 11, omschrijving: "Goodwill afschrijvingen (cumulatief)", categorie: "activa" },
  // Materiële vaste activa
  { nummer: 22, omschrijving: "Terreinen verkrijgingsprijs", categorie: "activa" },
  { nummer: 23, omschrijving: "Terreinen afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 24, omschrijving: "Terreinen herwaarderingen (cumulatief)", categorie: "activa" },
  { nummer: 25, omschrijving: "Bedrijfsgebouwen verkrijgingsprijs", categorie: "activa" },
  { nummer: 26, omschrijving: "Bedrijfsgebouwen afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 28, omschrijving: "Verbouwingen verkrijgingsprijs", categorie: "activa" },
  { nummer: 29, omschrijving: "Verbouwingen afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 30, omschrijving: "Verbouwingen herwaarderingen (cumulatief)", categorie: "activa" },
  { nummer: 31, omschrijving: "Machines verkrijgingsprijs", categorie: "activa" },
  { nummer: 32, omschrijving: "Machines afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 33, omschrijving: "Machines verkrijgingsprijs binnen EU", categorie: "activa" },
  { nummer: 34, omschrijving: "Andere vaste bedrijfsmiddelen verkrijgingsprijs", categorie: "activa" },
  { nummer: 35, omschrijving: "Andere vaste bedrijfsmiddelen afschr. (cumulatief)", categorie: "activa" },
  { nummer: 37, omschrijving: "Inventaris verkrijgingsprijs", categorie: "activa" },
  { nummer: 38, omschrijving: "Inventaris afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 39, omschrijving: "Inventaris verkrijgingsprijs binnen EU", categorie: "activa" },
  { nummer: 40, omschrijving: "Transportmiddelen verkrijgingsprijs", categorie: "activa" },
  { nummer: 41, omschrijving: "Transportmiddelen afschrijvingen (cumulatief)", categorie: "activa" },
  { nummer: 377, omschrijving: "Waarborgsommen (langlopend)", categorie: "activa" },
  // Vlottende activa
  { nummer: 1000, omschrijving: "Kas", categorie: "activa" },
  { nummer: 1100, omschrijving: "Rekening-courant bank", categorie: "activa" },
  { nummer: 1101, omschrijving: "Spaarrekening", categorie: "activa" },
  { nummer: 1200, omschrijving: "Kruisposten", categorie: "activa" },
  { nummer: 1201, omschrijving: "Betaalwijze contant", categorie: "activa" },
  { nummer: 1202, omschrijving: "PIN betalingen", categorie: "activa" },
  { nummer: 1203, omschrijving: "Betaalwijze elektronisch", categorie: "activa" },
  { nummer: 1300, omschrijving: "Debiteuren", categorie: "activa" },
  { nummer: 1305, omschrijving: "Oninbare debiteuren", categorie: "activa" },
  { nummer: 1454, omschrijving: "Overige vorderingen", categorie: "activa" },
  { nummer: 1460, omschrijving: "Vooruitbetaalde facturen", categorie: "activa" },
  { nummer: 1483, omschrijving: "Te factureren omzet", categorie: "activa" },
  { nummer: 1485, omschrijving: "Overige overlopende activa", categorie: "activa" },
  { nummer: 3000, omschrijving: "Voorraad grond- en hulpstoffen", categorie: "activa" },
  { nummer: 3090, omschrijving: "Emballage", categorie: "activa" },
  // Langlopende schulden
  { nummer: 540, omschrijving: "Hoofdsom hypotheken", categorie: "passiva" },
  { nummer: 545, omschrijving: "Aflossingen hypotheken (cumulatief)", categorie: "passiva" },
  { nummer: 552, omschrijving: "Hoofdsom leningen (langlopend)", categorie: "passiva" },
  { nummer: 553, omschrijving: "Aflossingen leningen (cumulatief)", categorie: "passiva" },
  { nummer: 580, omschrijving: "Overige schulden (langlopend)", categorie: "passiva" },
  // Eigen vermogen
  { nummer: 609, omschrijving: "Herinvesteringsreserve fiscaal", categorie: "passiva" },
  { nummer: 610, omschrijving: "Fiscale oudedagsreserve", categorie: "passiva" },
  { nummer: 650, omschrijving: "Kapitaal firmant 1", categorie: "passiva" },
  { nummer: 651, omschrijving: "Privé-stortingen firmant 1", categorie: "privé" },
  { nummer: 652, omschrijving: "Privé-opnamen firmant 1", categorie: "privé" },
  { nummer: 653, omschrijving: "Inkomstenbelasting firmant 1", categorie: "privé" },
  { nummer: 660, omschrijving: "Kapitaal firmant 2", categorie: "passiva" },
  { nummer: 661, omschrijving: "Privé-stortingen firmant 2", categorie: "privé" },
  { nummer: 662, omschrijving: "Privé-opnamen firmant 2", categorie: "privé" },
  { nummer: 663, omschrijving: "Inkomstenbelasting firmant 2", categorie: "privé" },
  // Kortlopende schulden
  { nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva" },
  { nummer: 1605, omschrijving: "Vraagposten inkopen", categorie: "passiva" },
  { nummer: 1610, omschrijving: "Aflossingsverplichtingen", categorie: "passiva" },
  { nummer: 1611, omschrijving: "Te betalen bedragen", categorie: "passiva" },
  { nummer: 1613, omschrijving: "Netto lonen", categorie: "passiva" },
  { nummer: 1616, omschrijving: "Te betalen vakantiebijslag", categorie: "passiva" },
  { nummer: 1617, omschrijving: "Reservering vakantiedagen", categorie: "passiva" },
  { nummer: 1618, omschrijving: "Vakantiebonnen", categorie: "passiva" },
  { nummer: 1670, omschrijving: "Btw af te dragen laag (verkopen)", categorie: "passiva" },
  { nummer: 1671, omschrijving: "Btw af te dragen hoog (verkopen)", categorie: "passiva" },
  { nummer: 1672, omschrijving: "Btw af te dragen overig (verkopen)", categorie: "passiva" },
  { nummer: 1673, omschrijving: "Btw af te dragen verlegd (verkopen)", categorie: "passiva" },
  { nummer: 1674, omschrijving: "Btw te vorderen verlegd (verkopen)", categorie: "passiva" },
  { nummer: 1675, omschrijving: "Btw-privé af te dragen", categorie: "passiva" },
  { nummer: 1679, omschrijving: "Btw te vorderen laag (inkopen)", categorie: "passiva" },
  { nummer: 1680, omschrijving: "Btw te vorderen hoog (inkopen)", categorie: "passiva" },
  { nummer: 1681, omschrijving: "Btw te vorderen overig (inkopen)", categorie: "passiva" },
  { nummer: 1682, omschrijving: "Btw af te dragen verlegd (inkopen)", categorie: "passiva" },
  { nummer: 1683, omschrijving: "Btw te vorderen verlegd (inkopen)", categorie: "passiva" },
  { nummer: 1684, omschrijving: "Btw afdracht", categorie: "passiva" },
  { nummer: 1685, omschrijving: "Te betalen btw vorige jaren", categorie: "passiva" },
  { nummer: 1687, omschrijving: "Te betalen loonheffing", categorie: "passiva" },
  { nummer: 1700, omschrijving: "Te betalen EU VAT", categorie: "passiva" },
  { nummer: 1745, omschrijving: "Overige schulden", categorie: "passiva" },
  { nummer: 1799, omschrijving: "Onbekende betalingen", categorie: "passiva" },
  { nummer: 2000, omschrijving: "Tussenrekeningen betalingen", categorie: "passiva" },
  { nummer: 2010, omschrijving: "Tussenrekening balans", categorie: "passiva" },
  { nummer: 2011, omschrijving: "Tussenrekening memoriaal", categorie: "passiva" },
  { nummer: 9998, omschrijving: "Resultaat", categorie: "passiva" },
  { nummer: 9999, omschrijving: "Mutatie fiscale oudedagsreserve", categorie: "passiva" },
  // Personeelskosten
  { nummer: 4003, omschrijving: "Lonen", categorie: "kosten" },
  { nummer: 4004, omschrijving: "Overwerk", categorie: "kosten" },
  { nummer: 4006, omschrijving: "Vakantiebijslag", categorie: "kosten" },
  { nummer: 4007, omschrijving: "Vakantiedagen", categorie: "kosten" },
  { nummer: 4013, omschrijving: "Loonkostenreductie", categorie: "kosten" },
  { nummer: 4016, omschrijving: "Loonkostensubsidie", categorie: "kosten" },
  { nummer: 4020, omschrijving: "Premies sociale verzekeringen", categorie: "kosten" },
  { nummer: 4021, omschrijving: "Bijdrage ziektekostenverzekering", categorie: "kosten" },
  { nummer: 4024, omschrijving: "Overige sociale lasten", categorie: "kosten" },
  { nummer: 4030, omschrijving: "Pensioenpremies", categorie: "kosten" },
  { nummer: 4050, omschrijving: "Overige lasten m.b.t. personeelsbeloningen", categorie: "kosten" },
  { nummer: 4051, omschrijving: "Werkkosten vrije ruimte", categorie: "kosten" },
  { nummer: 4052, omschrijving: "Werkkosten met nihilwaardering", categorie: "kosten" },
  { nummer: 4053, omschrijving: "Werkkosten gericht vrijgesteld", categorie: "kosten" },
  { nummer: 4054, omschrijving: "Werkkosten noodzakelijkheidscriterium", categorie: "kosten" },
  { nummer: 4055, omschrijving: "Werkkosten intermediair", categorie: "kosten" },
  { nummer: 4056, omschrijving: "Werkkosten belast loon", categorie: "kosten" },
  { nummer: 4057, omschrijving: "Werkkosten geen of vrijgesteld loon", categorie: "kosten" },
  { nummer: 4058, omschrijving: "Werkkostenregeling", categorie: "kosten" },
  { nummer: 4060, omschrijving: "Uitzendkrachten", categorie: "kosten" },
  { nummer: 4066, omschrijving: "Wervingskosten", categorie: "kosten" },
  { nummer: 4067, omschrijving: "Arbodienst", categorie: "kosten" },
  { nummer: 4069, omschrijving: "Ziekengeldverzekering", categorie: "kosten" },
  { nummer: 4070, omschrijving: "Ontvangen ziekengelden", categorie: "kosten" },
  { nummer: 4078, omschrijving: "Overige personeelskosten", categorie: "kosten" },
  // Afschrijvingen
  { nummer: 4103, omschrijving: "Afschrijvingen goodwill", categorie: "kosten" },
  { nummer: 4150, omschrijving: "Afschrijvingen Terreinen", categorie: "kosten" },
  { nummer: 4151, omschrijving: "Afschrijvingen Bedrijfsgebouwen", categorie: "kosten" },
  { nummer: 4153, omschrijving: "Afschrijvingen Verbouwingen", categorie: "kosten" },
  { nummer: 4154, omschrijving: "Afschrijvingen Machines en installaties", categorie: "kosten" },
  { nummer: 4155, omschrijving: "Afschrijvingen Andere vaste bedrijfsmiddelen", categorie: "kosten" },
  { nummer: 4158, omschrijving: "Afschrijvingen Transportmiddelen", categorie: "kosten" },
  { nummer: 4159, omschrijving: "Afschrijvingen Inventaris", categorie: "kosten" },
  // Huisvestingskosten
  { nummer: 4200, omschrijving: "Erfpacht", categorie: "kosten" },
  { nummer: 4203, omschrijving: "Betaalde huur", categorie: "kosten" },
  { nummer: 4206, omschrijving: "Onderhoud terreinen", categorie: "kosten" },
  { nummer: 4207, omschrijving: "Onderhoud gebouwen", categorie: "kosten" },
  { nummer: 4208, omschrijving: "Schoonmaakkosten", categorie: "kosten" },
  { nummer: 4209, omschrijving: "Servicekosten", categorie: "kosten" },
  { nummer: 4210, omschrijving: "Gas, water en elektra", categorie: "kosten" },
  { nummer: 4211, omschrijving: "Privé-gebruik energie", categorie: "kosten" },
  { nummer: 4212, omschrijving: "Assurantiepremies onroerende zaak", categorie: "kosten" },
  { nummer: 4213, omschrijving: "Onroerende zaakbelasting", categorie: "kosten" },
  { nummer: 4290, omschrijving: "Overige huisvestingskosten", categorie: "kosten" },
  // Inventaris en machines
  { nummer: 4302, omschrijving: "Huur inventaris", categorie: "kosten" },
  { nummer: 4303, omschrijving: "Kleine aanschaffingen inventaris", categorie: "kosten" },
  { nummer: 4310, omschrijving: "Reparatie en onderhoud machines", categorie: "kosten" },
  { nummer: 4321, omschrijving: "Overige kosten machines", categorie: "kosten" },
  { nummer: 4327, omschrijving: "Verpakkingsmaterialen", categorie: "kosten" },
  // Verkoopkosten
  { nummer: 4400, omschrijving: "Reclame- en advertentiekosten", categorie: "kosten" },
  { nummer: 4401, omschrijving: "Kosten sponsoring", categorie: "kosten" },
  { nummer: 4402, omschrijving: "Beurskosten", categorie: "kosten" },
  { nummer: 4403, omschrijving: "Relatiegeschenken", categorie: "kosten" },
  { nummer: 4405, omschrijving: "Representatiekosten", categorie: "kosten" },
  { nummer: 4406, omschrijving: "Reis- en verblijfkosten", categorie: "kosten" },
  { nummer: 4407, omschrijving: "Etalagekosten", categorie: "kosten" },
  { nummer: 4408, omschrijving: "Kantinekosten", categorie: "kosten" },
  { nummer: 4409, omschrijving: "Vrachtkosten", categorie: "kosten" },
  { nummer: 4415, omschrijving: "Franchisekosten", categorie: "kosten" },
  { nummer: 4416, omschrijving: "Dotatie voorziening dubieuze debiteuren", categorie: "kosten" },
  { nummer: 4417, omschrijving: "Afboeking dubieuze debiteuren", categorie: "kosten" },
  { nummer: 4420, omschrijving: "Websitekosten", categorie: "kosten" },
  { nummer: 4421, omschrijving: "Bedrijfskleding", categorie: "kosten" },
  { nummer: 4423, omschrijving: "Overige verkoopkosten", categorie: "kosten" },
  // Autokosten
  { nummer: 4500, omschrijving: "Brandstofkosten auto's", categorie: "kosten" },
  { nummer: 4501, omschrijving: "Reparatie en onderhoud auto's", categorie: "kosten" },
  { nummer: 4502, omschrijving: "Assurantiepremie auto's", categorie: "kosten" },
  { nummer: 4503, omschrijving: "Motorrijtuigenbelasting auto's", categorie: "kosten" },
  { nummer: 4504, omschrijving: "Operational leasing auto's", categorie: "kosten" },
  { nummer: 4505, omschrijving: "Bijdrage werknemers leaseregeling", categorie: "kosten" },
  { nummer: 4506, omschrijving: "Privé-gebruik auto's", categorie: "kosten" },
  { nummer: 4507, omschrijving: "BTW op privé-gebruik auto's", categorie: "kosten" },
  { nummer: 4508, omschrijving: "Huur auto's", categorie: "kosten" },
  { nummer: 4509, omschrijving: "Kilometervergoeding", categorie: "kosten" },
  { nummer: 4510, omschrijving: "Boetes en bekeuringen", categorie: "kosten" },
  { nummer: 4518, omschrijving: "Parkeerkosten auto's", categorie: "kosten" },
  { nummer: 4519, omschrijving: "Overige autokosten", categorie: "kosten" },
  // Kantoorkosten
  { nummer: 4600, omschrijving: "Kantoorbenodigdheden", categorie: "kosten" },
  { nummer: 4601, omschrijving: "Porti", categorie: "kosten" },
  { nummer: 4602, omschrijving: "Telefoonkosten", categorie: "kosten" },
  { nummer: 4603, omschrijving: "Privé-gebruik telefoon", categorie: "kosten" },
  { nummer: 4604, omschrijving: "Drukwerk", categorie: "kosten" },
  { nummer: 4605, omschrijving: "Kleine aanschaffingen kantoorinventaris", categorie: "kosten" },
  { nummer: 4606, omschrijving: "Contributies en abonnementen", categorie: "kosten" },
  { nummer: 4607, omschrijving: "Vakliteratuur", categorie: "kosten" },
  { nummer: 4609, omschrijving: "Incassokosten", categorie: "kosten" },
  { nummer: 4610, omschrijving: "Kosten automatisering", categorie: "kosten" },
  { nummer: 4613, omschrijving: "Reparatie en onderhoud kantoorinventaris", categorie: "kosten" },
  { nummer: 4614, omschrijving: "Overige kantoorkosten", categorie: "kosten" },
  { nummer: 4650, omschrijving: "Bedrijfsaansprakelijkheidsverzekering", categorie: "kosten" },
  { nummer: 4651, omschrijving: "Overige assurantiepremies", categorie: "kosten" },
  // Advieskosten
  { nummer: 4700, omschrijving: "Accountants- en advieskosten", categorie: "kosten" },
  { nummer: 4702, omschrijving: "Notariskosten", categorie: "kosten" },
  { nummer: 4703, omschrijving: "Advocaat en juridisch advies", categorie: "kosten" },
  { nummer: 4704, omschrijving: "Overige advieskosten", categorie: "kosten" },
  // Algemene kosten
  { nummer: 4752, omschrijving: "Kasverschillen", categorie: "kosten" },
  { nummer: 4753, omschrijving: "Bankkosten", categorie: "kosten" },
  { nummer: 4756, omschrijving: "Betalingsverschillen", categorie: "kosten" },
  { nummer: 4757, omschrijving: "Boetes belastingen premies soc. verzekeringen", categorie: "kosten" },
  { nummer: 4798, omschrijving: "Algemene kosten", categorie: "kosten" },
  { nummer: 4943, omschrijving: "Rente bankrekeningen", categorie: "kosten" },
  { nummer: 4949, omschrijving: "Kwijtscheldingswinst", categorie: "kosten" },
  { nummer: 4955, omschrijving: "Rentelasten hypothecaire leningen", categorie: "kosten" },
  { nummer: 4957, omschrijving: "Rentelasten financieringen", categorie: "kosten" },
  { nummer: 4974, omschrijving: "Overige rentelasten", categorie: "kosten" },
  // Inkopen
  { nummer: 7000, omschrijving: "Inkopen alle btw tarieven", categorie: "kosten" },
  { nummer: 7001, omschrijving: "Inkopen laag tarief", categorie: "kosten" },
  { nummer: 7002, omschrijving: "Inkopen hoog tarief", categorie: "kosten" },
  { nummer: 7003, omschrijving: "Inkopen vrijgesteld", categorie: "kosten" },
  { nummer: 7010, omschrijving: "Inkopen import binnen EU laag", categorie: "kosten" },
  { nummer: 7011, omschrijving: "Inkopen import binnen EU hoog", categorie: "kosten" },
  { nummer: 7013, omschrijving: "Inkopen import binnen EU overig", categorie: "kosten" },
  { nummer: 7020, omschrijving: "Inkopen import buiten EU laag", categorie: "kosten" },
  { nummer: 7021, omschrijving: "Inkopen import buiten EU hoog", categorie: "kosten" },
  { nummer: 7022, omschrijving: "Inkopen import buiten EU overig", categorie: "kosten" },
  { nummer: 7100, omschrijving: "Kosten uitbesteed werk", categorie: "kosten" },
  { nummer: 7400, omschrijving: "Inkoopwaarde handelsgoederen", categorie: "kosten" },
  { nummer: 7960, omschrijving: "Kredietbeperking inkopen", categorie: "kosten" },
  { nummer: 7980, omschrijving: "Betalingsverschillen", categorie: "kosten" },
  { nummer: 7990, omschrijving: "Voorraadmutatie", categorie: "kosten" },
  // Omzet
  { nummer: 8000, omschrijving: "Omzet hoog (productiegoederen)", categorie: "omzet" },
  { nummer: 8010, omschrijving: "Omzet laag (productiegoederen)", categorie: "omzet" },
  { nummer: 8020, omschrijving: "Omzet overig (productiegoederen)", categorie: "omzet" },
  { nummer: 8040, omschrijving: "Omzet nultarief (productiegoederen)", categorie: "omzet" },
  { nummer: 8050, omschrijving: "Omzet verlegd (productiegoederen)", categorie: "omzet" },
  { nummer: 8060, omschrijving: "Omzet buiten EU (productiegoederen)", categorie: "omzet" },
  { nummer: 8070, omschrijving: "Omzet binnen EU (productiegoederen)", categorie: "omzet" },
  { nummer: 8080, omschrijving: "Omzet afstandsverk. binnen EU (productiegoederen)", categorie: "omzet" },
  { nummer: 8100, omschrijving: "Omzet hoog (handelsgoederen)", categorie: "omzet" },
  { nummer: 8110, omschrijving: "Omzet laag (handelsgoederen)", categorie: "omzet" },
  { nummer: 8120, omschrijving: "Omzet overig (handelsgoederen)", categorie: "omzet" },
  { nummer: 8130, omschrijving: "Netto-omzet uit privégebruik handelsgoederen", categorie: "omzet" },
  { nummer: 8140, omschrijving: "Omzet nultarief (handelsgoederen)", categorie: "omzet" },
  { nummer: 8150, omschrijving: "Omzet verlegd (handelsgoederen)", categorie: "omzet" },
  { nummer: 8160, omschrijving: "Omzet buiten EU (handelsgoederen)", categorie: "omzet" },
  { nummer: 8170, omschrijving: "Omzet binnen EU (handelsgoederen)", categorie: "omzet" },
  { nummer: 8180, omschrijving: "Omzet afstandsverk binnen de EU (handelsgoederen)", categorie: "omzet" },
  { nummer: 8199, omschrijving: "Vrijgestelde omzet (handelsgoederen)", categorie: "omzet" },
  { nummer: 8200, omschrijving: "Omzet hoog (diensten)", categorie: "omzet" },
  { nummer: 8210, omschrijving: "Omzet laag (diensten)", categorie: "omzet" },
  { nummer: 8220, omschrijving: "Omzet overig (diensten)", categorie: "omzet" },
  { nummer: 8240, omschrijving: "Omzet nultarief (diensten)", categorie: "omzet" },
  { nummer: 8250, omschrijving: "Omzet verlegd (diensten)", categorie: "omzet" },
  { nummer: 8260, omschrijving: "Omzet buiten EU (diensten)", categorie: "omzet" },
  { nummer: 8270, omschrijving: "Omzet binnen EU (diensten)", categorie: "omzet" },
  { nummer: 8280, omschrijving: "Omzet afstandsverkopen binnen EU (diensten)", categorie: "omzet" },
  { nummer: 8299, omschrijving: "Vrijgestelde omzet (diensten)", categorie: "omzet" },
  { nummer: 8400, omschrijving: "Omzet onderhanden werken", categorie: "omzet" },
  { nummer: 8700, omschrijving: "Kredietbeperking verkopen", categorie: "omzet" },
  // Overige opbrengsten
  { nummer: 9000, omschrijving: "Opbrengsten producten en/of diensten", categorie: "omzet" },
  { nummer: 9100, omschrijving: "Huurontvangsten", categorie: "omzet" },
  { nummer: 9170, omschrijving: "Overige opbrengsten", categorie: "omzet" },
  { nummer: 9190, omschrijving: "Overige verzekeringsuitkeringen", categorie: "omzet" },
];

export interface UseGrootboekrEkeningenOptions {
  organizationId?: string;
  enabled?: boolean;
}

export function useGrootboekrekeningen(options: UseGrootboekrEkeningenOptions = {}) {
  const { organizationId, enabled = true } = options;
  const { user } = useAuth();

  return useQuery({
    queryKey: ["grootboekrekeningen", organizationId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("grootboekrekeningen").select("*").order("nummer");
      if (organizationId) query = query.or(`organization_id.is.null,organization_id.eq.${organizationId}`);
      const { data, error } = await query;
      if (error) throw error;
      return data as Grootboekrekening[];
    },
    enabled: !!user && enabled,
  });
}

export function useActiveGrootboekrekeningen(options: UseGrootboekrEkeningenOptions = {}) {
  const { organizationId, enabled = true } = options;
  const { user } = useAuth();

  return useQuery({
    queryKey: ["grootboekrekeningen", "actief", organizationId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("grootboekrekeningen").select("*").eq("actief", true).order("nummer");
      if (organizationId) query = query.or(`organization_id.is.null,organization_id.eq.${organizationId}`);
      const { data, error } = await query;
      if (error) throw error;
      return data as Grootboekrekening[];
    },
    enabled: !!user && enabled,
  });
}

export function useSeedGrootboekrekeningen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<void, Error, boolean | undefined>({
    mutationFn: async (force) => {
      if (!user) throw new Error("Niet ingelogd");
      if (!force) {
        const { count } = await supabase
          .from("grootboekrekeningen")
          .select("*", { count: "exact", head: true });
        if (count && count > 0) return;
      }

      // Insert per batch to avoid payload limits
      const rows = DEFAULT_ACCOUNTS.map((a) => ({
        user_id: user.id,
        client_id: null,
        actief: true,
        ...a,
      }));

      // Insert in batches of 50, skip duplicates
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase
          .from("grootboekrekeningen")
          .insert(batch);
        if (error && !error.message.includes("duplicate")) throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

export function useAddGrootboekrekening() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      data: {
        nummer: number;
        omschrijving: string;
        categorie: string;
        actief: boolean;
      } & GrootboekClassificationInput,
    ) => {
      if (!user) throw new Error("Niet ingelogd");
      const { error } = await (supabase as unknown as GrootboekWriteApi)
        .from("grootboekrekeningen")
        .insert({ ...data, user_id: user.id, client_id: null });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

export function useUpdateGrootboekrekening() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: string } & Partial<Grootboekrekening>) => {
      const { error } = await (supabase as unknown as GrootboekWriteApi)
        .from("grootboekrekeningen")
        .update(updates as GrootboekWriteRow)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

/**
 * Balans/W&V PR 2 — mag de ingelogde gebruiker de rapportageclassificatie
 * wijzigen? De rollenladder blijft in de database: één aanroep van de
 * bestaande public.has_min_role(), dezelfde drempel (`accountant`) die de
 * UPDATE-policy op grootboekrekeningen zelf hanteert. Geen tweede
 * rechtenmodel, geen client-side rangorde.
 *
 * `undefined` = nog onbekend; de velden blijven dan alleen-lezen. RLS is en
 * blijft de echte poort — dit bepaalt alleen wat we tonen.
 */
export function useCanEditGrootboekClassification() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();

  return useQuery({
    queryKey: ["grootboek-can-classify", user?.id ?? "", activeOrganizationId ?? ""],
    enabled: !!user && isReady && !!activeOrganizationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("has_min_role", {
        _user_id: user!.id,
        _organization_id: activeOrganizationId!,
        _min: "accountant",
      });
      if (error) throw error;
      return data === true;
    },
  });
}

export function useDeleteGrootboekrekening() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("grootboekrekeningen").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}
