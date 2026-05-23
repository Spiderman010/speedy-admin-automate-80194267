import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useAppSettings, useSaveAppSetting } from "@/hooks/useAppSettings";
import { useBookingTemplates, useAddBookingTemplate, useUpdateBookingTemplate, useDeleteBookingTemplate } from "@/hooks/useBookingTemplates";
import { useCreateVraagpost } from "@/hooks/useVraagposten";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useClients } from "@/hooks/useClients";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Pencil, Trash2, Plus, RefreshCw, User, LogOut, Loader2 } from "lucide-react";

// ──── Tab 0: Profiel ────
function ProfielTab() {
  const { user } = useAuth();
  const { data: settings, isLoading } = useAppSettings();
  const saveMut = useSaveAppSetting();

  const [naam, setNaam] = useState("");
  const [bedrijf, setBedrijf] = useState("");
  const [telefoon, setTelefoon] = useState("");
  const [kvk, setKvk] = useState("");
  const [btwnummer, setBtwnummer] = useState("");
  const [nieuwWachtwoord, setNieuwWachtwoord] = useState("");
  const [wachtwoordBevestig, setWachtwoordBevestig] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const p = (settings as any).profiel || {};
    if (p.naam) setNaam(p.naam);
    if (p.bedrijf) setBedrijf(p.bedrijf);
    if (p.telefoon) setTelefoon(p.telefoon);
    if (p.kvk) setKvk(p.kvk);
    if (p.btwnummer) setBtwnummer(p.btwnummer);
  }, [settings]);

  const handleSaveProfiel = () => {
    saveMut.mutate(
      { profiel: { naam, bedrijf, telefoon, kvk, btwnummer } } as any,
      { onSuccess: () => toast({ title: "Profiel opgeslagen" }) }
    );
  };

  const handleWachtwoordWijzigen = async () => {
    if (!nieuwWachtwoord) return;
    if (nieuwWachtwoord !== wachtwoordBevestig) {
      toast({ title: "Wachtwoorden komen niet overeen", variant: "destructive" });
      return;
    }
    if (nieuwWachtwoord.length < 6) {
      toast({ title: "Wachtwoord moet minimaal 6 tekens zijn", variant: "destructive" });
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: nieuwWachtwoord });
    setSavingPassword(false);
    if (error) {
      toast({ title: "Fout bij wijzigen wachtwoord", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Wachtwoord gewijzigd" });
      setNieuwWachtwoord("");
      setWachtwoordBevestig("");
    }
  };

  const handleUitloggen = async () => {
    await supabase.auth.signOut();
  };

  if (isLoading) return <p className="text-muted-foreground">Laden...</p>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><User className="h-5 w-5" />Bedrijfsgegevens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Naam</Label>
              <Input value={naam} onChange={e => setNaam(e.target.value)} placeholder="Je volledige naam" />
            </div>
            <div className="space-y-1">
              <Label>Bedrijfsnaam</Label>
              <Input value={bedrijf} onChange={e => setBedrijf(e.target.value)} placeholder="Agio Finance" />
            </div>
            <div className="space-y-1">
              <Label>E-mailadres</Label>
              <Input value={user?.email || ""} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">E-mailadres kan niet worden gewijzigd</p>
            </div>
            <div className="space-y-1">
              <Label>Telefoonnummer</Label>
              <Input value={telefoon} onChange={e => setTelefoon(e.target.value)} placeholder="+31 6 00000000" />
            </div>
            <div className="space-y-1">
              <Label>KVK nummer</Label>
              <Input value={kvk} onChange={e => setKvk(e.target.value)} placeholder="12345678" />
            </div>
            <div className="space-y-1">
              <Label>BTW nummer</Label>
              <Input value={btwnummer} onChange={e => setBtwnummer(e.target.value)} placeholder="NL123456789B01" />
            </div>
          </div>
          <Button onClick={handleSaveProfiel} disabled={saveMut.isPending}>Profiel opslaan</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Wachtwoord wijzigen</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Nieuw wachtwoord</Label>
              <Input type="password" value={nieuwWachtwoord} onChange={e => setNieuwWachtwoord(e.target.value)} placeholder="Minimaal 6 tekens" />
            </div>
            <div className="space-y-1">
              <Label>Bevestig wachtwoord</Label>
              <Input type="password" value={wachtwoordBevestig} onChange={e => setWachtwoordBevestig(e.target.value)} placeholder="Herhaal wachtwoord" />
            </div>
          </div>
          <Button onClick={handleWachtwoordWijzigen} disabled={savingPassword || !nieuwWachtwoord}>
            {savingPassword ? "Bezig..." : "Wachtwoord wijzigen"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Account</CardTitle></CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={handleUitloggen} className="gap-2">
            <LogOut className="h-4 w-4" />Uitloggen
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ──── Tab 1: Matching ────
function MatchingTab() {
  const { data: settings, isLoading } = useAppSettings();
  const saveMut = useSaveAppSetting();

  const [tolerantie, setTolerantie] = useState(0.5);
  const [deelbetalingen, setDeelbetalingen] = useState(true);
  const [zoekOmschrijving, setZoekOmschrijving] = useState(true);
  const [zoekReferentie, setZoekReferentie] = useState(true);
  const [zoekNaam, setZoekNaam] = useState(true);
  const [autoMatchDrempel, setAutoMatchDrempel] = useState(95);
  const [suggestieDrempel, setSuggestieDrempel] = useState(50);

  useEffect(() => {
    if (!settings) return;
    const m = settings.matching || {};
    if (m.tolerantie !== undefined) setTolerantie(m.tolerantie);
    if (m.deelbetalingen !== undefined) setDeelbetalingen(m.deelbetalingen);
    if (m.zoekOmschrijving !== undefined) setZoekOmschrijving(m.zoekOmschrijving);
    if (m.zoekReferentie !== undefined) setZoekReferentie(m.zoekReferentie);
    if (m.zoekNaam !== undefined) setZoekNaam(m.zoekNaam);
    if (m.autoMatchDrempel !== undefined) setAutoMatchDrempel(m.autoMatchDrempel);
    if (m.suggestieDrempel !== undefined) setSuggestieDrempel(m.suggestieDrempel);
  }, [settings]);

  const handleSave = () => {
    saveMut.mutate(
      { matching: { tolerantie, deelbetalingen, zoekOmschrijving, zoekReferentie, zoekNaam, autoMatchDrempel, suggestieDrempel } },
      { onSuccess: () => toast({ title: "Matching instellingen opgeslagen" }) }
    );
  };

  if (isLoading) return <p className="text-muted-foreground">Laden...</p>;

  return (
    <Card>
      <CardHeader><CardTitle>Matching instellingen</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Maximaal bedragverschil bij matching (€)</Label>
          <Input type="number" step="0.01" value={tolerantie} onChange={e => setTolerantie(parseFloat(e.target.value) || 0)} className="w-40" />
        </div>
        <div className="flex items-center justify-between max-w-md">
          <Label>Deelbetalingen toestaan</Label>
          <Switch checked={deelbetalingen} onCheckedChange={setDeelbetalingen} />
        </div>
        <div className="flex items-center justify-between max-w-md">
          <Label>Zoeken in omschrijving</Label>
          <Switch checked={zoekOmschrijving} onCheckedChange={setZoekOmschrijving} />
        </div>
        <div className="flex items-center justify-between max-w-md">
          <Label>Zoeken in referentie</Label>
          <Switch checked={zoekReferentie} onCheckedChange={setZoekReferentie} />
        </div>
        <div className="flex items-center justify-between max-w-md">
          <Label>Zoeken in naam</Label>
          <Switch checked={zoekNaam} onCheckedChange={setZoekNaam} />
        </div>
        <div className="space-y-2 max-w-md">
          <Label>Betrouwbaarheidsdrempel automatisch matchen: {autoMatchDrempel}%</Label>
          <p className="text-xs text-muted-foreground">Transacties boven deze score worden automatisch gematcht</p>
          <Slider value={[autoMatchDrempel]} onValueChange={v => setAutoMatchDrempel(v[0])} min={0} max={100} step={1} />
        </div>
        <div className="space-y-2 max-w-md">
          <Label>Betrouwbaarheidsdrempel suggestie tonen: {suggestieDrempel}%</Label>
          <p className="text-xs text-muted-foreground">Transacties boven deze score worden als suggestie getoond</p>
          <Slider value={[suggestieDrempel]} onValueChange={v => setSuggestieDrempel(v[0])} min={0} max={100} step={1} />
        </div>
        <Button onClick={handleSave} disabled={saveMut.isPending}>Instellingen opslaan</Button>
      </CardContent>
    </Card>
  );
}

// ──── Tab 2: Herkenningsregels ────

interface PreviewItem {
  txId: string;
  date: string;
  description: string;
  amount: number;
  templateZoekterm: string;
  actie: string;
  ledgerText: string | null;
}

interface TemplateMatchCount {
  templateId: string;
  zoekterm: string;
  actie: string;
  count: number;
}

interface RetroPreviewResult {
  totalScanned: number;
  totalWouldUpdate: number;
  countPerTemplate: TemplateMatchCount[];
  skippedNoTemplate: number;
  skippedNoLedger: number;
  skippedInkoopfactuur: number;
  sample: PreviewItem[];
}

// Pure helpers used by both preview and apply steps.

function resolveTemplateLedger(rule: any, accounts: any[] | undefined) {
  if (rule.actie !== "grootboek" || !accounts) return null;
  if (rule.ledger_account_id) return accounts.find((a: any) => a.id === rule.ledger_account_id) ?? null;
  if (rule.ledger_account_text) return accounts.find((a: any) => `${a.nummer} - ${a.omschrijving}` === rule.ledger_account_text) ?? null;
  return null;
}

function matchTransactionToTemplate(tx: any, activeRules: any[]) {
  for (const rule of activeRules) {
    const term = (rule.zoekterm || "").toLowerCase();
    let field = "";
    if (rule.zoek_in === "naam") field = (tx.counter_account || "").toLowerCase();
    else if (rule.zoek_in === "omschrijving") field = (tx.description || "").toLowerCase();
    else if (rule.zoek_in === "referentie") field = (tx.reference || "").toLowerCase();
    else field = `${tx.counter_account || ""} ${tx.description || ""} ${tx.reference || ""}`.toLowerCase();
    if (field.includes(term)) return rule;
  }
  return null;
}

function HerkenningsregelsTab() {
  const { data: templates, isLoading } = useBookingTemplates();
  const addMut = useAddBookingTemplate();
  const updateMut = useUpdateBookingTemplate();
  const deleteMut = useDeleteBookingTemplate();
  const createVraagpost = useCreateVraagpost();
  const { data: accounts } = useActiveGrootboekrekeningen();
  const { data: clients } = useClients();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState<RetroPreviewResult | null>(null);
  const [applying, setApplying] = useState(false);

  const emptyForm = { zoekterm: "", zoek_in: "alles", actie: "grootboek", ledger_account_text: "", geldt_voor: "alle", client_id_filter: null as string | null, prioriteit: 0, actief: true };
  const [form, setForm] = useState(emptyForm);

  const openNew = () => { setEditId(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (t: any) => {
    setEditId(t.id);
    setForm({ zoekterm: t.zoekterm || "", zoek_in: t.zoek_in || "alles", actie: t.actie || "grootboek", ledger_account_text: t.ledger_account_text || "", geldt_voor: t.geldt_voor || "alle", client_id_filter: t.client_id_filter, prioriteit: t.prioriteit || 0, actief: t.actief ?? true });
    setDialogOpen(true);
  };

  const handleSave = () => {
    const payload: any = { ...form };
    if (form.actie !== "grootboek") { payload.ledger_account_text = null; payload.ledger_account_id = null; }
    if (form.geldt_voor !== "specifieke_klant") payload.client_id_filter = null;
    if (editId) {
      updateMut.mutate({ id: editId, ...payload }, { onSuccess: () => { setDialogOpen(false); toast({ title: "Regel bijgewerkt" }); } });
    } else {
      addMut.mutate(payload, { onSuccess: () => { setDialogOpen(false); toast({ title: "Regel aangemaakt" }); } });
    }
  };

  // Preview: fetch niet_gematcht rows, evaluate templates, report counts + sample — no DB writes.
  const handlePreview = async () => {
    if (!templates) return;
    setPreviewing(true);
    try {
      const activeRules = [...templates]
        .filter(t => t.actief && t.zoekterm)
        .sort((a, b) => (b.prioriteit ?? 0) - (a.prioriteit ?? 0));

      const { data: transactions, error } = await supabase
        .from("bank_transactions")
        .select("*")
        .eq("match_status", "niet_gematcht");
      if (error) throw error;

      const txList = transactions || [];
      let skippedNoTemplate = 0;
      let skippedNoLedger = 0;
      let skippedInkoopfactuur = 0;
      let totalWouldUpdate = 0;
      const countMap = new Map<string, number>();
      const sample: PreviewItem[] = [];

      for (const tx of txList) {
        const rule = matchTransactionToTemplate(tx, activeRules);
        if (!rule) { skippedNoTemplate++; continue; }

        countMap.set(rule.id, (countMap.get(rule.id) ?? 0) + 1);

        if (rule.actie === "inkoopfactuur") {
          skippedInkoopfactuur++;
          continue;
        }

        if (rule.actie === "grootboek") {
          const ledger = resolveTemplateLedger(rule, accounts);
          if (!ledger) { skippedNoLedger++; continue; }
          totalWouldUpdate++;
          if (sample.length < 10) {
            sample.push({
              txId: tx.id,
              date: tx.transaction_date,
              description: tx.description || "",
              amount: tx.amount,
              templateZoekterm: rule.zoekterm || "",
              actie: rule.actie,
              ledgerText: `${ledger.nummer} - ${ledger.omschrijving}`,
            });
          }
          continue;
        }

        if (rule.actie === "vraagpost") {
          totalWouldUpdate++;
          if (sample.length < 10) {
            sample.push({
              txId: tx.id,
              date: tx.transaction_date,
              description: tx.description || "",
              amount: tx.amount,
              templateZoekterm: rule.zoekterm || "",
              actie: rule.actie,
              ledgerText: null,
            });
          }
        }
      }

      const countPerTemplate: TemplateMatchCount[] = activeRules
        .filter(r => countMap.has(r.id))
        .map(r => ({ templateId: r.id, zoekterm: r.zoekterm || "", actie: r.actie || "", count: countMap.get(r.id) ?? 0 }));

      setPreviewResult({ totalScanned: txList.length, totalWouldUpdate, countPerTemplate, skippedNoTemplate, skippedNoLedger, skippedInkoopfactuur, sample });
      setPreviewOpen(true);
    } catch (e: any) {
      toast({ title: "Fout bij preview", description: e.message, variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  // Apply: re-queries niet_gematcht rows for safety, then applies matching templates.
  const handleApply = async () => {
    if (!user || !templates) return;
    setApplying(true);
    try {
      const activeRules = [...templates]
        .filter(t => t.actief && t.zoekterm)
        .sort((a, b) => (b.prioriteit ?? 0) - (a.prioriteit ?? 0));

      const { data: transactions, error } = await supabase
        .from("bank_transactions")
        .select("*")
        .eq("match_status", "niet_gematcht");
      if (error) throw error;

      let countGrootboek = 0;
      let countVraagpost = 0;
      let skipped = 0;

      for (const tx of transactions || []) {
        const rule = matchTransactionToTemplate(tx, activeRules);
        if (!rule) { skipped++; continue; }

        if (rule.actie === "inkoopfactuur") {
          // Leave as niet_gematcht — no write needed.
          skipped++;
          continue;
        }

        if (rule.actie === "grootboek") {
          const ledger = resolveTemplateLedger(rule, accounts);
          if (!ledger) { skipped++; continue; }
          // Additional .eq("match_status", "niet_gematcht") prevents overwriting rows
          // that changed status between preview and apply.
          await supabase
            .from("bank_transactions")
            .update({
              match_status: "handmatig_geboekt",
              grootboekrekening_id: ledger.id,
              matched_invoice_id: null,
              match_confidence: null,
            })
            .eq("id", tx.id)
            .eq("match_status", "niet_gematcht");
          countGrootboek++;
          continue;
        }

        if (rule.actie === "vraagpost") {
          // Create vraagpost only if one does not already exist; do not change match_status.
          const { data: existing } = await supabase
            .from("vraagposten")
            .select("id")
            .eq("source_type", "bank_transaction")
            .eq("source_id", tx.id)
            .maybeSingle();
          if (!existing) {
            const [y, m, d] = (tx.transaction_date || "").split("-");
            const formattedDate = y && m && d ? `${d}-${m}-${y}` : tx.transaction_date;
            const formattedAmount = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(tx.amount);
            await createVraagpost.mutateAsync({
              source_type: "bank_transaction",
              source_id: tx.id,
              client_id: tx.client_id,
              titel: tx.description || "Banktransactie zonder factuur",
              omschrijving: `${formattedDate} · ${formattedAmount}`,
              categorie: "bank_zonder_factuur",
            });
            countVraagpost++;
          }
          continue;
        }
      }

      const parts: string[] = [];
      if (countGrootboek > 0) parts.push(`${countGrootboek} geboekt op grootboek`);
      if (countVraagpost > 0) parts.push(`${countVraagpost} vraagpost${countVraagpost !== 1 ? "en" : ""} aangemaakt`);
      if (skipped > 0) parts.push(`${skipped} overgeslagen`);
      toast({ title: "Klaar", description: parts.join(" · ") || "Geen transacties bijgewerkt" });
      setPreviewOpen(false);
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    } finally {
      setApplying(false);
    }
  };

  const filtered = (templates || []).filter(t =>
    (t.zoekterm || "").toLowerCase().includes(search.toLowerCase()) ||
    (t.ledger_account_text || "").toLowerCase().includes(search.toLowerCase())
  );

  const actieLabel = (a: string | null) => {
    if (a === "grootboek") return "Boeken op grootboek";
    if (a === "inkoopfactuur") return "Koppelen aan inkoopfactuur";
    if (a === "vraagpost") return "Vraagpost aanmaken";
    return a || "-";
  };
  const zoekInLabel = (z: string | null) => {
    if (z === "naam") return "Naam";
    if (z === "omschrijving") return "Omschrijving";
    if (z === "referentie") return "Referentie";
    return "Alles";
  };
  const geldtVoorLabel = (g: string | null) => {
    if (g === "eenmanszaak") return "Alleen eenmanszaken";
    if (g === "bv") return "Alleen BV";
    if (g === "specifieke_klant") return "Specifieke klant";
    return "Alle klanten";
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Herkenningsregels</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handlePreview} disabled={previewing || isLoading}>
              {previewing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Preview toepassen op open bankregels
            </Button>
            <Button onClick={openNew}><Plus className="h-4 w-4 mr-2" />Nieuwe regel</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input placeholder="Zoek op zoekterm of grootboek..." value={search} onChange={e => setSearch(e.target.value)} className="max-w-sm" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Zoekterm</TableHead>
              <TableHead>Zoek in</TableHead>
              <TableHead>Actie</TableHead>
              <TableHead>Grootboekrekening</TableHead>
              <TableHead>Geldt voor</TableHead>
              <TableHead>Prioriteit</TableHead>
              <TableHead>Actief</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Geen regels gevonden</TableCell></TableRow>
            )}
            {filtered.map(t => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.zoekterm || "-"}</TableCell>
                <TableCell>{zoekInLabel(t.zoek_in)}</TableCell>
                <TableCell>{actieLabel(t.actie)}</TableCell>
                <TableCell>{t.ledger_account_text || "-"}</TableCell>
                <TableCell>{geldtVoorLabel(t.geldt_voor)}</TableCell>
                <TableCell>{t.prioriteit ?? 0}</TableCell>
                <TableCell>
                  <Switch checked={t.actief} onCheckedChange={v => updateMut.mutate({ id: t.id, actief: v })} />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(t)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteMut.mutate(t.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* CRUD dialog for creating / editing a template */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{editId ? "Regel bewerken" : "Nieuwe regel"}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1">
                <Label>Zoekterm *</Label>
                <Input value={form.zoekterm} onChange={e => setForm(f => ({ ...f, zoekterm: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Zoeken in</Label>
                <Select value={form.zoek_in} onValueChange={v => setForm(f => ({ ...f, zoek_in: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alles">Alles</SelectItem>
                    <SelectItem value="naam">Naam</SelectItem>
                    <SelectItem value="omschrijving">Omschrijving</SelectItem>
                    <SelectItem value="referentie">Referentie</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Actie</Label>
                <Select value={form.actie} onValueChange={v => setForm(f => ({ ...f, actie: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grootboek">Boeken op grootboek</SelectItem>
                    <SelectItem value="inkoopfactuur">Koppelen aan inkoopfactuur</SelectItem>
                    <SelectItem value="vraagpost">Vraagpost aanmaken</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.actie === "grootboek" && (
                <div className="space-y-1">
                  <Label>Grootboekrekening</Label>
                  <GrootboekCombobox value={form.ledger_account_text} onValueChange={v => setForm(f => ({ ...f, ledger_account_text: v }))} />
                </div>
              )}
              <div className="space-y-1">
                <Label>Geldt voor</Label>
                <Select value={form.geldt_voor} onValueChange={v => setForm(f => ({ ...f, geldt_voor: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alle">Alle klanten</SelectItem>
                    <SelectItem value="eenmanszaak">Alleen eenmanszaken</SelectItem>
                    <SelectItem value="bv">Alleen BV</SelectItem>
                    <SelectItem value="specifieke_klant">Specifieke klant</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.geldt_voor === "specifieke_klant" && (
                <div className="space-y-1">
                  <Label>Klant</Label>
                  <Select value={form.client_id_filter || ""} onValueChange={v => setForm(f => ({ ...f, client_id_filter: v }))}>
                    <SelectTrigger><SelectValue placeholder="Selecteer klant..." /></SelectTrigger>
                    <SelectContent>
                      {(clients || []).map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label>Prioriteit</Label>
                <Input type="number" value={form.prioriteit} onChange={e => setForm(f => ({ ...f, prioriteit: parseInt(e.target.value) || 0 }))} className="w-24" />
              </div>
              <div className="flex items-center gap-3">
                <Label>Actief</Label>
                <Switch checked={form.actief} onCheckedChange={v => setForm(f => ({ ...f, actief: v }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Annuleren</Button>
              <Button onClick={handleSave} disabled={!form.zoekterm}>Opslaan</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Preview dialog — read-only until user clicks Apply */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Preview: herkenningsregels op open bankregels</DialogTitle>
            </DialogHeader>
            {previewResult && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <div className="bg-muted rounded p-3">
                    <p className="text-muted-foreground text-xs">Gescand</p>
                    <p className="font-bold text-lg">{previewResult.totalScanned}</p>
                  </div>
                  <div className="bg-muted rounded p-3">
                    <p className="text-muted-foreground text-xs">Wordt bijgewerkt</p>
                    <p className="font-bold text-lg">{previewResult.totalWouldUpdate}</p>
                  </div>
                  <div className="bg-muted rounded p-3">
                    <p className="text-muted-foreground text-xs">Geen match</p>
                    <p className="font-bold text-lg">{previewResult.skippedNoTemplate}</p>
                  </div>
                  {previewResult.skippedNoLedger > 0 && (
                    <div className="bg-muted rounded p-3">
                      <p className="text-muted-foreground text-xs">Overgeslagen (geen grootboek)</p>
                      <p className="font-bold text-lg">{previewResult.skippedNoLedger}</p>
                    </div>
                  )}
                  {previewResult.skippedInkoopfactuur > 0 && (
                    <div className="bg-muted rounded p-3">
                      <p className="text-muted-foreground text-xs">Overgeslagen (inkoopfactuur)</p>
                      <p className="font-bold text-lg">{previewResult.skippedInkoopfactuur}</p>
                    </div>
                  )}
                </div>

                {previewResult.countPerTemplate.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Per herkenningsregel:</p>
                    <div className="flex flex-wrap gap-2">
                      {previewResult.countPerTemplate.map(tc => (
                        <Badge key={tc.templateId} variant="outline" className="text-xs">
                          {tc.zoekterm} ({actieLabel(tc.actie)}) · {tc.count}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {previewResult.sample.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Voorbeeld (eerste {previewResult.sample.length}):</p>
                    <div className="overflow-y-auto max-h-56 rounded border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">Datum</TableHead>
                            <TableHead className="text-xs">Omschrijving</TableHead>
                            <TableHead className="text-xs text-right">Bedrag</TableHead>
                            <TableHead className="text-xs">Regel</TableHead>
                            <TableHead className="text-xs">Grootboek / Actie</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {previewResult.sample.map(item => (
                            <TableRow key={item.txId}>
                              <TableCell className="text-xs whitespace-nowrap">{item.date}</TableCell>
                              <TableCell className="text-xs max-w-[180px] truncate">{item.description || "—"}</TableCell>
                              <TableCell className="text-xs text-right font-mono whitespace-nowrap">
                                {new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(item.amount)}
                              </TableCell>
                              <TableCell className="text-xs">{item.templateZoekterm}</TableCell>
                              <TableCell className="text-xs">{item.ledgerText ?? (item.actie === "vraagpost" ? "Vraagpost aanmaken" : "—")}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                {previewResult.totalWouldUpdate === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Geen open transacties komen in aanmerking voor bijwerking met de huidige herkenningsregels.
                  </p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreviewOpen(false)}>Annuleren</Button>
              {previewResult && previewResult.totalWouldUpdate > 0 && (
                <Button onClick={handleApply} disabled={applying}>
                  {applying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Toepassen op {previewResult.totalWouldUpdate} open bankregel{previewResult.totalWouldUpdate !== 1 ? "s" : ""}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ──── Tab 3: BTW ────
function BtwTab() {
  const { data: settings, isLoading } = useAppSettings();
  const saveMut = useSaveAppSetting();
  const [hoog, setHoog] = useState(21);
  const [laag, setLaag] = useState(9);
  const [codeH, setCodeH] = useState("H");
  const [codeL, setCodeL] = useState("L");
  const [codeV, setCodeV] = useState("V");
  const [codeG, setCodeG] = useState("G");

  useEffect(() => {
    if (!settings) return;
    const b = settings.btw || {};
    if (b.hoog !== undefined) setHoog(b.hoog);
    if (b.laag !== undefined) setLaag(b.laag);
    if (b.codeH !== undefined) setCodeH(b.codeH);
    if (b.codeL !== undefined) setCodeL(b.codeL);
    if (b.codeV !== undefined) setCodeV(b.codeV);
    if (b.codeG !== undefined) setCodeG(b.codeG);
  }, [settings]);

  const handleSave = () => {
    saveMut.mutate(
      { btw: { hoog, laag, codeH, codeL, codeV, codeG } },
      { onSuccess: () => toast({ title: "BTW instellingen opgeslagen" }) }
    );
  };

  if (isLoading) return <p className="text-muted-foreground">Laden...</p>;

  return (
    <Card>
      <CardHeader><CardTitle>BTW instellingen</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 gap-4 max-w-md">
          <div className="space-y-1">
            <Label>Standaard BTW tarief hoog (%)</Label>
            <Input type="number" value={hoog} onChange={e => setHoog(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label>Standaard BTW tarief laag (%)</Label>
            <Input type="number" value={laag} onChange={e => setLaag(parseFloat(e.target.value) || 0)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-base font-medium">BTW codes voor export</Label>
          <div className="grid grid-cols-4 gap-4 max-w-md">
            <div className="space-y-1"><Label>Hoog</Label><Input value={codeH} onChange={e => setCodeH(e.target.value)} /></div>
            <div className="space-y-1"><Label>Laag</Label><Input value={codeL} onChange={e => setCodeL(e.target.value)} /></div>
            <div className="space-y-1"><Label>Verlegd</Label><Input value={codeV} onChange={e => setCodeV(e.target.value)} /></div>
            <div className="space-y-1"><Label>Geen/Vrijgesteld</Label><Input value={codeG} onChange={e => setCodeG(e.target.value)} /></div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground max-w-xl">
          BTW type per klant wordt ingesteld in het klantenprofiel. Vrijgestelde klanten krijgen nooit BTW. Mix klanten: BTW wordt per factuur bepaald.
        </p>
        <Button onClick={handleSave} disabled={saveMut.isPending}>Instellingen opslaan</Button>
      </CardContent>
    </Card>
  );
}

// ──── Tab 4: Grootboek standaarden ────
const STANDAARD_BOEKINGEN = [
  { key: "prive_opnamen", label: "Privé opnamen eenmanszaak", defaultNummer: 652 },
  { key: "prive_stortingen", label: "Privé stortingen eenmanszaak", defaultNummer: 651 },
  { key: "bankkosten", label: "Bankkosten", defaultNummer: 4753 },
  { key: "betalingsverschillen", label: "Betalingsverschillen", defaultNummer: 4756 },
  { key: "onbekende_betalingen", label: "Onbekende betalingen", defaultNummer: 1799 },
  { key: "inkomstenbelasting", label: "Inkomstenbelasting", defaultNummer: 653 },
];

function GrootboekStandaardenTab() {
  const { data: settings, isLoading } = useAppSettings();
  const { data: accounts } = useActiveGrootboekrekeningen();
  const saveMut = useSaveAppSetting();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings || !accounts) return;
    const gs = settings.grootboek_standaarden || {};
    const init: Record<string, string> = {};
    for (const s of STANDAARD_BOEKINGEN) {
      if (gs[s.key]) {
        init[s.key] = gs[s.key];
      } else {
        const acc = accounts.find(a => a.nummer === s.defaultNummer);
        init[s.key] = acc ? `${acc.nummer} - ${acc.omschrijving}` : "";
      }
    }
    setValues(init);
  }, [settings, accounts]);

  const handleSave = () => {
    saveMut.mutate(
      { grootboek_standaarden: values },
      { onSuccess: () => toast({ title: "Grootboek standaarden opgeslagen" }) }
    );
  };

  if (isLoading) return <p className="text-muted-foreground">Laden...</p>;

  return (
    <Card>
      <CardHeader><CardTitle>Grootboek standaarden</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {STANDAARD_BOEKINGEN.map(s => (
          <div key={s.key} className="space-y-1 max-w-md">
            <Label>{s.label}</Label>
            <GrootboekCombobox value={values[s.key] || ""} onValueChange={v => setValues(prev => ({ ...prev, [s.key]: v }))} />
          </div>
        ))}
        <Button onClick={handleSave} disabled={saveMut.isPending}>Instellingen opslaan</Button>
      </CardContent>
    </Card>
  );
}

// ──── Tab 5: Export ────
function ExportTab() {
  const { data: settings, isLoading } = useAppSettings();
  const saveMut = useSaveAppSetting();
  const [formaat, setFormaat] = useState("csv");
  const [scheidingsteken, setScheidingsteken] = useState("puntkomma");
  const [datumformaat, setDatumformaat] = useState("DD-MM-YYYY");
  const [decimaalteken, setDecimaalTeken] = useState("komma");

  useEffect(() => {
    if (!settings) return;
    const e = settings.export || {};
    if (e.formaat) setFormaat(e.formaat);
    if (e.scheidingsteken) setScheidingsteken(e.scheidingsteken);
    if (e.datumformaat) setDatumformaat(e.datumformaat);
    if (e.decimaalteken) setDecimaalTeken(e.decimaalteken);
  }, [settings]);

  const handleSave = () => {
    saveMut.mutate(
      { export: { formaat, scheidingsteken, datumformaat, decimaalteken } },
      { onSuccess: () => toast({ title: "Export instellingen opgeslagen" }) }
    );
  };

  if (isLoading) return <p className="text-muted-foreground">Laden...</p>;

  return (
    <Card>
      <CardHeader><CardTitle>Export instellingen</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 max-w-xs">
          <Label>Exportformaat</Label>
          <Select value={formaat} onValueChange={setFormaat}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="excel">Excel</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 max-w-xs">
          <Label>Scheidingsteken</Label>
          <Select value={scheidingsteken} onValueChange={setScheidingsteken}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="puntkomma">Puntkomma (;)</SelectItem>
              <SelectItem value="komma">Komma (,)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 max-w-xs">
          <Label>Datumformaat</Label>
          <Select value={datumformaat} onValueChange={setDatumformaat}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="DD-MM-YYYY">DD-MM-YYYY</SelectItem>
              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 max-w-xs">
          <Label>Decimaalteken</Label>
          <Select value={decimaalteken} onValueChange={setDecimaalTeken}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="komma">Komma (,)</SelectItem>
              <SelectItem value="punt">Punt (.)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground max-w-xl">
          Deze instellingen worden gebruikt bij Export Snelstart in Bankafschriften en Facturen.
        </p>
        <Button onClick={handleSave} disabled={saveMut.isPending}>Instellingen opslaan</Button>
      </CardContent>
    </Card>
  );
}

// ──── Main Page ────
export default function Instellingen() {
  return (
    <div className="space-y-6">
      <PageHeader title="Instellingen" description="Beheer je applicatie-instellingen" />
      <Tabs defaultValue="profiel">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="profiel">Profiel</TabsTrigger>
          <TabsTrigger value="matching">Matching</TabsTrigger>
          <TabsTrigger value="herkenningsregels">Herkenningsregels</TabsTrigger>
          <TabsTrigger value="btw">BTW</TabsTrigger>
          <TabsTrigger value="grootboek">Grootboek standaarden</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
        </TabsList>
        <TabsContent value="profiel"><ProfielTab /></TabsContent>
        <TabsContent value="matching"><MatchingTab /></TabsContent>
        <TabsContent value="herkenningsregels"><HerkenningsregelsTab /></TabsContent>
        <TabsContent value="btw"><BtwTab /></TabsContent>
        <TabsContent value="grootboek"><GrootboekStandaardenTab /></TabsContent>
        <TabsContent value="export"><ExportTab /></TabsContent>
      </Tabs>
    </div>
  );
}
