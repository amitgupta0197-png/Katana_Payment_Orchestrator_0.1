"use client";

// PROVIDER settlements console: register beneficiary accounts, raise settlements to
// branches (amount prefilled from outstanding collected), and verify the UTRs that
// branches submit — near-real-time (10s poll). The branch's outstanding receivable
// is reduced when the provider verifies.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Plus, ShieldCheck, ShieldX, Trash2, Power, Landmark, Activity } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RowActions } from "@/components/world-class/row-actions";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { settlementStatusVariant, SETTLEMENT_STATUS_LABEL } from "@/components/settlement/status";

interface Benef { id: string; label?: string; beneficiary_name: string; account_number?: string; ifsc?: string; bank_name?: string; vpa?: string; transfer_mode: string; active: boolean }
interface Settlement {
  id: string; merchant_key: string; branch_name?: string; amount: number; currency: string; status: string;
  utr?: string; purpose?: string; transfer_mode?: string; beneficiary_snapshot?: any;
  requested_at: string; utr_submitted_at?: string; verified_at?: string; note?: string;
}
interface MerchantRow { id: string; merchant_code: string; legal_name?: string }

export default function ProviderSettlementsPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { scope: { id: string } } });
  const providerId = me.data?.scope?.id;

  const settlements = useQuery({
    queryKey: ["settlements", "provider"],
    queryFn: async () => (await fetch("/api/settlements").then((r) => r.json())) as { settlements: Settlement[] },
    refetchInterval: 10_000,
  });
  const beneficiaries = useQuery({
    queryKey: ["beneficiaries", providerId],
    enabled: !!providerId,
    queryFn: async () => (await fetch(`/api/providers/${providerId}/beneficiaries`).then((r) => r.json())) as { beneficiaries: Benef[] },
  });
  const branches = useQuery({
    queryKey: ["pp:merchants-for-settle"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: MerchantRow[] },
  });

  const [benOpen, setBenOpen] = useState(false);
  const [raiseOpen, setRaiseOpen] = useState(false);

  const verify = useMutation({
    mutationFn: async ({ id, outcome }: { id: string; outcome: "VERIFIED" | "REJECTED" }) => {
      const r = await fetch(`/api/settlements/${id}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: (_d, v) => { toast.success(v.outcome === "VERIFIED" ? "Settlement verified" : "UTR rejected"); qc.invalidateQueries({ queryKey: ["settlements"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const list = settlements.data?.settlements ?? [];
  const pendingVerify = list.filter((x) => x.status === "UTR_SUBMITTED").length;
  const verifiedTotal = list.filter((x) => x.status === "VERIFIED").reduce((s, x) => s + Number(x.amount || 0), 0);

  const cols: Column<Settlement>[] = [
    { key: "merchant_key", header: "Branch", render: (r) => <span className="font-medium">{r.branch_name ?? r.merchant_key}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "beneficiary", header: "Beneficiary", render: (r) => <span className="text-xs">{r.beneficiary_snapshot?.beneficiary_name ?? "—"}{r.beneficiary_snapshot?.account_number ? ` · ${r.beneficiary_snapshot.account_number}` : ""}</span> },
    { key: "utr", header: "UTR", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">—</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={settlementStatusVariant(r.status)}>{SETTLEMENT_STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: "requested_at", header: "Raised", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "actions", header: "", render: (r) => r.status === "UTR_SUBMITTED" ? (
      <RowActions actions={[
        { label: "Verify received", icon: ShieldCheck, onClick: () => verify.mutate({ id: r.id, outcome: "VERIFIED" }) },
        { label: "Reject UTR", icon: ShieldX, variant: "danger", onClick: () => verify.mutate({ id: r.id, outcome: "REJECTED" }) },
      ]} />
    ) : null },
  ];

  return (
    <>
      <PageHeader
        title="Settlements"
        description="Collect from your branches: raise a settlement, the branch pays your beneficiary account and submits the UTR, you verify it."
        icon={Banknote}
        actions={<div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setBenOpen(true)}><Landmark className="h-4 w-4" /> Beneficiaries</Button>
          <Button size="sm" onClick={() => setRaiseOpen(true)} disabled={!(beneficiaries.data?.beneficiaries ?? []).some((b) => b.active)}><Plus className="h-4 w-4" /> Raise settlement</Button>
        </div>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Awaiting your verification</div><div className="text-2xl font-semibold tabular-nums">{pendingVerify}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Verified total</div><div className="text-2xl font-semibold tabular-nums">{formatAmount(verifiedTotal)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Beneficiary accounts</div><div className="text-2xl font-semibold tabular-nums">{(beneficiaries.data?.beneficiaries ?? []).length}</div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center justify-between"><div><div className="text-xs text-[color:var(--color-text-muted)]">Live</div><div className="text-sm font-medium">10s refresh</div></div><Badge variant={settlements.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Settlements</CardTitle><CardDescription>UTRs appear here in real time as branches submit them.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={settlements.isLoading} emptyState="No settlements yet. Raise one to start collecting from a branch." />
        </CardContent>
      </Card>

      {providerId && <BeneficiariesDialog open={benOpen} onOpenChange={setBenOpen} providerId={providerId} beneficiaries={beneficiaries.data?.beneficiaries ?? []} />}
      {providerId && <RaiseDialog open={raiseOpen} onOpenChange={setRaiseOpen} providerId={providerId}
        branches={branches.data?.merchants ?? []} beneficiaries={(beneficiaries.data?.beneficiaries ?? []).filter((b) => b.active)} />}
    </>
  );
}

function BeneficiariesDialog({ open, onOpenChange, providerId, beneficiaries }: { open: boolean; onOpenChange: (o: boolean) => void; providerId: string; beneficiaries: Benef[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ label: "", beneficiary_name: "", account_number: "", ifsc: "", bank_name: "", vpa: "", transfer_mode: "IMPS" });
  const add = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/beneficiaries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Beneficiary added"); setForm({ label: "", beneficiary_name: "", account_number: "", ifsc: "", bank_name: "", vpa: "", transfer_mode: "IMPS" }); qc.invalidateQueries({ queryKey: ["beneficiaries"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => { const r = await fetch(`/api/providers/${providerId}/beneficiaries/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed"); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beneficiaries"] }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => { const r = await fetch(`/api/providers/${providerId}/beneficiaries/${id}`, { method: "DELETE" }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed"); },
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["beneficiaries"] }); },
  });
  const isUpi = form.transfer_mode === "UPI";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Beneficiary accounts</DialogTitle><DialogDescription>The dedicated accounts your branches settle into.</DialogDescription></DialogHeader>
        <div className="space-y-2 max-h-48 overflow-auto">
          {beneficiaries.length === 0 ? <p className="text-sm text-[color:var(--color-text-muted)]">None yet.</p> : beneficiaries.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
              <div><span className="font-medium">{b.beneficiary_name}</span> <Badge variant="info">{b.transfer_mode}</Badge>{!b.active && <Badge variant="default">inactive</Badge>}
                <div className="text-xs text-[color:var(--color-text-muted)]">{b.vpa || `${b.account_number ?? ""} · ${b.ifsc ?? ""}`}</div></div>
              <RowActions actions={[
                { label: b.active ? "Deactivate" : "Activate", icon: Power, onClick: () => toggle.mutate({ id: b.id, active: !b.active }) },
                { label: "Delete", icon: Trash2, variant: "danger", onClick: () => { if (confirm("Delete beneficiary?")) del.mutate(b.id); } },
              ]} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t pt-3">
          <div className="col-span-2"><Label className="text-xs">Beneficiary name</Label><Input value={form.beneficiary_name} onChange={(e) => setForm({ ...form, beneficiary_name: e.target.value })} /></div>
          <div><Label className="text-xs">Transfer mode</Label>
            <select value={form.transfer_mode} onChange={(e) => setForm({ ...form, transfer_mode: e.target.value })} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              {["IMPS", "NEFT", "RTGS", "UPI"].map((m) => <option key={m}>{m}</option>)}
            </select></div>
          <div><Label className="text-xs">Label</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
          {isUpi ? (
            <div className="col-span-2"><Label className="text-xs">VPA</Label><Input value={form.vpa} onChange={(e) => setForm({ ...form, vpa: e.target.value })} placeholder="name@bank" /></div>
          ) : (<>
            <div><Label className="text-xs">Account number</Label><Input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} /></div>
            <div><Label className="text-xs">IFSC</Label><Input value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value })} /></div>
            <div className="col-span-2"><Label className="text-xs">Bank name</Label><Input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} /></div>
          </>)}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending || !form.beneficiary_name}><Plus className="h-4 w-4" /> Add account</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RaiseDialog({ open, onOpenChange, providerId, branches, beneficiaries }: { open: boolean; onOpenChange: (o: boolean) => void; providerId: string; branches: MerchantRow[]; beneficiaries: Benef[] }) {
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [amount, setAmount] = useState("");
  const [benId, setBenId] = useState("");
  const [note, setNote] = useState("");

  // Prefill amount from the branch's outstanding receivable when a branch is picked.
  const outstanding = useQuery({
    queryKey: ["outstanding", providerId, branch],
    enabled: !!branch,
    queryFn: async () => (await fetch(`/api/settlements/outstanding?provider=${providerId}&branch=${encodeURIComponent(branch)}`).then((r) => r.json())) as { collected: number; settled: number; outstanding: number },
  });
  useEffect(() => { if (outstanding.data) setAmount(String(outstanding.data.outstanding)); }, [outstanding.data]);

  const raise = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider_id: providerId, merchant_key: branch, amount: Number(amount), beneficiary_id: benId, note: note || undefined }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Settlement raised", { description: "The branch can now pay and submit a UTR." }); onOpenChange(false); setBranch(""); setAmount(""); setBenId(""); setNote(""); qc.invalidateQueries({ queryKey: ["settlements"] }); },
    onError: (e: Error) => toast.error("Couldn’t raise", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Raise settlement to a branch</DialogTitle><DialogDescription>Amount is prefilled from the branch's outstanding collected pay-ins — edit if needed.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-xs">Branch</Label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              <option value="">Select a branch…</option>
              {branches.map((m) => <option key={m.merchant_code} value={m.merchant_code}>{m.legal_name ? `${m.legal_name} (${m.merchant_code})` : m.merchant_code}</option>)}
            </select>
          </div>
          {branch && outstanding.data && (
            <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-2 text-xs text-[color:var(--color-text-muted)]">
              Collected {formatAmount(outstanding.data.collected)} · already settled {formatAmount(outstanding.data.settled)} · <span className="font-medium text-[color:var(--color-text)]">outstanding {formatAmount(outstanding.data.outstanding)}</span>
            </div>
          )}
          <div><Label className="text-xs">Amount (₹)</Label><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div><Label className="text-xs">Beneficiary account</Label>
            <select value={benId} onChange={(e) => setBenId(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              <option value="">Select where the branch pays…</option>
              {beneficiaries.map((b) => <option key={b.id} value={b.id}>{b.beneficiary_name} · {b.transfer_mode} · {b.vpa || b.account_number}</option>)}
            </select>
          </div>
          <div><Label className="text-xs">Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => raise.mutate()} disabled={raise.isPending || !branch || !benId || !(Number(amount) > 0)}>Raise settlement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
