"use client";

// PROVIDER settlements console: register beneficiary accounts, raise settlements to
// branches (amount prefilled from outstanding collected), and verify the UTRs that
// branches submit — near-real-time (10s poll). The branch's outstanding receivable
// is reduced when the provider verifies.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Plus, Trash2, Power, Landmark, Activity, Clock, Download, Bell } from "lucide-react";
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
import { settlementStatusVariant, settlementStatusLabel } from "@/components/settlement/status";
import { SettlementActionBar, SettlementTimeline, SettlementNotifications } from "@/components/settlement/controls";

interface Benef { id: string; label?: string; beneficiary_name: string; account_number?: string; ifsc?: string; bank_name?: string; vpa?: string; transfer_mode: string; active: boolean }
interface Settlement {
  id: string; merchant_key: string; branch_name?: string; amount: number; currency: string; status: string;
  gross_amount?: number | null; net_amount?: number | null; charges?: { total_charges?: number } | null;
  settle_mode?: "BANK" | "USDT"; usdt_network?: string | null; wallet_address?: string | null;
  usdt_rate?: number | null; usdt_quantity?: number | null; tx_hash?: string | null; request_ref?: string | null;
  has_receipt?: boolean; locked?: boolean; priority?: string; requested_date?: string | null; internal_ref?: string | null;
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
  const [notifOpen, setNotifOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<Settlement | null>(null);

  // §13 balance tiles: whole-scope collected/settled/blocked/available + commission.
  const balances = useQuery({
    queryKey: ["settlement-balances"],
    queryFn: async () => (await fetch("/api/settlements/balances").then((r) => r.json())) as {
      totals?: { collected: number; settled: number; blocked: number; available: number; commission_deducted: number };
    },
    refetchInterval: 30_000,
  });
  const bal = balances.data?.totals;

  const list = settlements.data?.settlements ?? [];
  // Waiting on the upline to confirm: the downline has paid but not yet confirmed.
  const pendingVerify = list.filter((x) => ["PAID", "PARTIALLY_PAID", "UTR_SUBMITTED", "USDT_TRANSFERRED"].includes(x.status)).length;
  const SETTLED_STATUSES = ["VERIFIED", "RECONCILED"];
  // Raised but not yet a final outcome (settled) and not dead (rejected/failed/cancelled) →
  // money still on its way in. This is the "upcoming settlement" pipeline.
  const DEAD_STATUSES = ["REJECTED", "FAILED", "REVERSED", "CANCELLED", "DRAFT", "INSUFFICIENT_BALANCE", "INVALID_BENEFICIARY"];
  const verifiedTotal = list.filter((x) => SETTLED_STATUSES.includes(x.status)).reduce((s, x) => s + Number(x.amount || 0), 0);
  // Most recently settled (confirmed) settlement — newest by verified_at, then raised time.
  const lastSettled = list
    .filter((x) => SETTLED_STATUSES.includes(x.status))
    .sort((a, b) => new Date(b.verified_at ?? b.requested_at).getTime() - new Date(a.verified_at ?? a.requested_at).getTime())[0] ?? null;
  const upcoming = list.filter((x) => !SETTLED_STATUSES.includes(x.status) && !DEAD_STATUSES.includes(x.status));
  const upcomingTotal = upcoming.reduce((s, x) => s + Number(x.amount || 0), 0);

  const cols: Column<Settlement>[] = [
    { key: "ref", header: "Request ID", render: (r) => <span className="font-mono text-xs">{r.request_ref ?? r.id.slice(0, 8)}</span> },
    { key: "merchant_key", header: "Branch", render: (r) => <span className="font-medium">{r.branch_name ?? r.merchant_key}</span> },
    { key: "amount", header: "Gross", render: (r) => <span className="tabular-nums">{formatAmount(r.gross_amount ?? r.amount, r.currency)}</span> },
    { key: "net", header: "Net payable", render: (r) => (
      <span className="tabular-nums font-medium">
        {formatAmount(r.net_amount ?? r.amount, r.currency)}
        {r.settle_mode === "USDT" && r.usdt_quantity ? <span className="block text-[10px] text-[color:var(--color-text-muted)]">{r.usdt_quantity} USDT</span> : null}
      </span>
    ) },
    { key: "mode", header: "Mode", render: (r) => <Badge variant={r.settle_mode === "USDT" ? "brand" : "info"}>{r.settle_mode === "USDT" ? `USDT · ${r.usdt_network ?? ""}` : r.transfer_mode ?? "BANK"}</Badge> },
    { key: "utr", header: "UTR / Hash", render: (r) => (r.tx_hash || r.utr) ? <span className="font-mono text-xs break-all">{r.tx_hash ?? r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">—</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={settlementStatusVariant(r.status)}>{settlementStatusLabel(r.status)}</Badge> },
    { key: "requested_at", header: "Raised", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "actions", header: "", render: (r) => (
      <div className="flex items-center gap-1.5">
        <SettlementActionBar settlementId={r.id} status={r.status} role="UPLINE" mode={r.settle_mode ?? "BANK"} locked={r.locked} onDone={() => qc.invalidateQueries({ queryKey: ["settlements"] })} />
        {r.has_receipt ? <Button size="sm" variant="secondary" asChild><a href={`/api/settlements/${r.id}/receipt`} target="_blank" rel="noreferrer">Receipt</a></Button> : null}
        <Button size="sm" variant="secondary" onClick={() => setDetailFor(r)}><Clock className="h-4 w-4" /></Button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Settlements"
        description="Collect from your branches: raise a settlement, the branch pays your beneficiary account and submits the UTR, you verify it."
        icon={Banknote}
        actions={<div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setNotifOpen(true)}><Bell className="h-4 w-4" /> Notifications</Button>
          <Button variant="secondary" size="sm" asChild><a href="/api/settlements/export"><Download className="h-4 w-4" /> Recon report</a></Button>
          <Button variant="secondary" size="sm" onClick={() => setBenOpen(true)}><Landmark className="h-4 w-4" /> Beneficiaries</Button>
          <Button size="sm" onClick={() => setRaiseOpen(true)}><Plus className="h-4 w-4" /> Raise settlement</Button>
        </div>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Available balance</div><div className="text-2xl font-semibold tabular-nums">{bal ? formatAmount(bal.available) : "—"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Blocked (in-flight)</div><div className="text-2xl font-semibold tabular-nums">{bal ? formatAmount(bal.blocked) : "—"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Settled total</div><div className="text-2xl font-semibold tabular-nums">{bal ? formatAmount(bal.settled) : formatAmount(verifiedTotal)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Last settled</div><div className="text-2xl font-semibold tabular-nums">{lastSettled ? formatAmount(lastSettled.amount, lastSettled.currency) : "—"}</div><div className="mt-0.5 text-[10px] text-[color:var(--color-text-muted)] truncate">{lastSettled ? `${formatDateTime(lastSettled.verified_at ?? lastSettled.requested_at)}${lastSettled.request_ref ? ` · ${lastSettled.request_ref}` : ""}` : "No settlement confirmed yet"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Upcoming settlement</div><div className="text-2xl font-semibold tabular-nums">{formatAmount(upcomingTotal)}</div><div className="mt-0.5 text-[10px] text-[color:var(--color-text-muted)]">{upcoming.length} in-flight</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Commission deducted</div><div className="text-2xl font-semibold tabular-nums">{bal ? formatAmount(bal.commission_deducted) : "—"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Awaiting your confirmation</div><div className="text-2xl font-semibold tabular-nums">{pendingVerify}</div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center justify-between"><div><div className="text-xs text-[color:var(--color-text-muted)]">Live</div><div className="text-sm font-medium">10s refresh</div></div><Badge variant={settlements.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge></CardContent></Card>
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Recent activity</CardTitle><CardDescription>Everything your branches do lands here live — plus a toast the moment a status changes.</CardDescription></CardHeader>
        <CardContent><SettlementNotifications selfRole="UPLINE" /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Settlements</CardTitle><CardDescription>UTRs appear here in real time as branches submit them.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={settlements.isLoading} emptyState="No settlements yet. Raise one to start collecting from a branch." />
        </CardContent>
      </Card>

      {providerId && <BeneficiariesDialog open={benOpen} onOpenChange={setBenOpen} providerId={providerId} beneficiaries={beneficiaries.data?.beneficiaries ?? []} />}
      {providerId && <RaiseDialog open={raiseOpen} onOpenChange={setRaiseOpen} providerId={providerId}
        branches={branches.data?.merchants ?? []} beneficiaries={(beneficiaries.data?.beneficiaries ?? []).filter((b) => b.active)} />}
      {providerId && <NotifyChannelsDialog open={notifOpen} onOpenChange={setNotifOpen} providerId={providerId} />}

      <Dialog open={!!detailFor} onOpenChange={(o) => !o && setDetailFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settlement {detailFor ? formatAmount(detailFor.amount, detailFor.currency) : ""}</DialogTitle>
            <DialogDescription>Live status timeline — every action the branch and Katana take.</DialogDescription>
          </DialogHeader>
          {detailFor && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-[color:var(--color-text-muted)]">Current status</span>
                <Badge variant={settlementStatusVariant(detailFor.status)}>{settlementStatusLabel(detailFor.status)}</Badge>
              </div>
              <SettlementTimeline settlementId={detailFor.id} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// External notification channels (BRD §7): signed webhooks fire on every status change.
// Email addresses can be saved but stay dormant until SMTP is configured server-side.
function NotifyChannelsDialog({ open, onOpenChange, providerId }: { open: boolean; onOpenChange: (o: boolean) => void; providerId: string }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const channels = useQuery({
    queryKey: ["notify-channels", providerId],
    enabled: open,
    queryFn: async () => (await fetch(`/api/providers/${providerId}/notify-channels`).then((r) => r.json())) as {
      channels: Array<{ id: string; kind: string; target: string; enabled: boolean }>;
    },
  });
  const add = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/notify-channels`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "WEBHOOK", target: url.trim() }),
      });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Webhook added — it will receive every status change"); setUrl(""); qc.invalidateQueries({ queryKey: ["notify-channels"] }); },
    onError: (e: Error) => toast.error("Couldn’t add", { description: e.message }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/providers/${providerId}/notify-channels?channel=${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
    },
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["notify-channels"] }); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settlement notifications</DialogTitle>
          <DialogDescription>Every status change is POSTed to your webhook as signed JSON (x-katana-signature header). Dashboard toasts stay on regardless.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-40 overflow-auto">
          {(channels.data?.channels ?? []).length === 0
            ? <p className="text-sm text-[color:var(--color-text-muted)]">No external channels yet.</p>
            : (channels.data?.channels ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                <Badge variant="info">{c.kind}</Badge>
                <span className="flex-1 truncate font-mono">{c.target}</span>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
        </div>
        <div className="flex items-end gap-2 border-t pt-3">
          <div className="flex-1"><Label className="text-xs">Webhook URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-system.example/katana-settlements" /></div>
          <Button onClick={() => add.mutate()} disabled={add.isPending || !/^https?:\/\/.{5,}/.test(url.trim())}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const [payTo, setPayTo] = useState("");   // "v:<vendor_id>" | "b:<beneficiary_id>"
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"BANK" | "USDT">("BANK");
  const [network, setNetwork] = useState("TRC20");
  const [wallet, setWallet] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [reqDate, setReqDate] = useState("");
  const [internalRef, setInternalRef] = useState("");

  // §14: the branch's self-declared capacity, shown as a hint when raising.
  const capacity = useQuery({
    queryKey: ["branch-capacity-upline"],
    enabled: open,
    queryFn: async () => (await fetch("/api/branch-capacity").then((r) => r.json())) as {
      capacity: Array<{ merchant_key: string; bank_available: boolean; usdt_available: boolean; usdt_quantity: number | null; usdt_network: string | null; daily_capacity: number | null; note: string | null }>;
    },
  });
  const branchCap = (capacity.data?.capacity ?? []).find((c) => c.merchant_key === branch);

  // Registered vendors (BRD §3) — only ACTIVE ones can receive a settlement.
  const vendors = useQuery({
    queryKey: ["vendors-for-raise", providerId],
    enabled: open,
    queryFn: async () => (await fetch(`/api/providers/${providerId}/vendors`).then((r) => r.json())) as {
      vendors: Array<{ id: string; vendor_name: string; beneficiary_name: string; account_number?: string | null; vpa?: string | null; status: string }>;
    },
  });
  const activeVendors = (vendors.data?.vendors ?? []).filter((v) => v.status === "ACTIVE");

  // Prefill amount from the branch's AVAILABLE balance (collected − settled − in-flight).
  const outstanding = useQuery({
    queryKey: ["outstanding", providerId, branch],
    enabled: !!branch,
    queryFn: async () => (await fetch(`/api/settlements/outstanding?provider=${providerId}&branch=${encodeURIComponent(branch)}`).then((r) => r.json())) as { collected: number; settled: number; blocked: number; outstanding: number },
  });
  useEffect(() => { if (outstanding.data) setAmount(String(outstanding.data.outstanding)); }, [outstanding.data]);

  // Today's declared USDT rates (for the USDT preview; the server locks the rate on raise).
  const usdtRates = useQuery({
    queryKey: ["usdt-rates"],
    enabled: mode === "USDT",
    queryFn: async () => (await fetch("/api/usdt-rates").then((r) => r.json())) as {
      current: Record<string, { settlement_rate: number; network_fee: number }>;
    },
  });
  const activeRate = usdtRates.data?.current?.[network];

  // Live charge preview from the rule engine: gross → commissions → net payable.
  const preview = useQuery({
    queryKey: ["settle-preview", providerId, branch, amount],
    enabled: !!branch && Number(amount) > 0,
    queryFn: async () => (await fetch(`/api/settlement-rules/preview?provider=${providerId}&branch=${encodeURIComponent(branch)}&amount=${encodeURIComponent(amount)}`).then((r) => r.json())) as {
      breakdown?: { gross: number; upline_charge: number; katana_charge: number; downline_charge: number; fixed_fee: number; gst: number; total_charges: number; net: number; rule_version: number | null };
    },
  });
  const bd = preview.data?.breakdown;

  const raise = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settlements", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId, merchant_key: branch, amount: Number(amount), note: note || undefined,
          settle_mode: mode, priority,
          requested_date: reqDate || undefined, internal_ref: internalRef || undefined,
          ...(mode === "BANK"
            ? (payTo.startsWith("v:") ? { vendor_id: payTo.slice(2) } : { beneficiary_id: payTo.slice(2) })
            : { usdt_network: network, wallet_address: wallet.trim() }),
        }),
      });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: (d: any) => {
      toast.success(`Settlement raised${d?.settlement?.request_ref ? ` — ${d.settlement.request_ref}` : ""}`,
        { description: mode === "USDT" ? "Routed to your branch for USDT processing." : "The branch can now pay and submit a UTR." });
      onOpenChange(false); setBranch(""); setAmount(""); setPayTo(""); setNote(""); setWallet(""); setMode("BANK");
      qc.invalidateQueries({ queryKey: ["settlements"] });
    },
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
              Collected {formatAmount(outstanding.data.collected)} · settled {formatAmount(outstanding.data.settled)} · in-flight {formatAmount(outstanding.data.blocked ?? 0)} · <span className="font-medium text-[color:var(--color-text)]">available {formatAmount(outstanding.data.outstanding)}</span>
            </div>
          )}
          {branch && branchCap && (
            <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-2 text-xs text-[color:var(--color-text-muted)]">
              Branch declares: bank {branchCap.bank_available ? "✓" : "✗"} · USDT {branchCap.usdt_available ? `✓ ${branchCap.usdt_quantity ?? "?"} on ${branchCap.usdt_network ?? "?"}` : "✗"}
              {branchCap.daily_capacity ? ` · daily cap ${formatAmount(branchCap.daily_capacity)}` : ""}{branchCap.note ? ` · "${branchCap.note}"` : ""}
            </div>
          )}
          <div><Label className="text-xs">Settlement mode</Label>
            <div className="flex gap-2">
              {(["BANK", "USDT"] as const).map((m) => (
                <Button key={m} type="button" size="sm" variant={mode === m ? "default" : "secondary"} onClick={() => setMode(m)}>
                  {m === "BANK" ? "Bank transfer" : "USDT"}
                </Button>
              ))}
            </div>
          </div>
          <div><Label className="text-xs">Amount (₹)</Label><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          {mode === "USDT" && (
            <>
              <div><Label className="text-xs">Blockchain network</Label>
                <select value={network} onChange={(e) => setNetwork(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                  {["TRC20", "ERC20", "BEP20"].map((n) => <option key={n}>{n}</option>)}
                </select>
              </div>
              <div><Label className="text-xs">Wallet address</Label><Input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder={network === "TRC20" ? "T…" : "0x…"} /></div>
              {activeRate ? (
                <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-2 text-xs text-[color:var(--color-text-muted)]">
                  Today's rate <span className="font-medium text-[color:var(--color-text)]">₹{activeRate.settlement_rate}/USDT</span>
                  {Number(amount) > 0 && bd ? <> · net {formatAmount(bd.net)} ≈ <span className="font-medium text-[color:var(--color-text)]">{Math.max(0, Math.round((bd.net / activeRate.settlement_rate - (activeRate.network_fee || 0)) * 100) / 100)} USDT</span>{activeRate.network_fee ? ` (after ${activeRate.network_fee} USDT network fee)` : ""}</> : null}
                </div>
              ) : usdtRates.isFetched ? (
                <div className="rounded-md border border-[color:var(--color-warning,#b45309)] p-2 text-xs text-[color:var(--color-warning,#b45309)]">
                  No USDT rate declared for {network} today — Katana admin must set it before you can raise this request.
                </div>
              ) : null}
            </>
          )}
          {bd && bd.total_charges > 0 && (
            <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-2 text-xs space-y-0.5">
              <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Gross request</span><span className="tabular-nums">{formatAmount(bd.gross)}</span></div>
              {bd.upline_charge > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Your commission</span><span className="tabular-nums">− {formatAmount(bd.upline_charge)}</span></div>}
              {bd.katana_charge > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Katana charge</span><span className="tabular-nums">− {formatAmount(bd.katana_charge)}</span></div>}
              {bd.downline_charge > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Banker charge</span><span className="tabular-nums">− {formatAmount(bd.downline_charge)}</span></div>}
              {bd.fixed_fee > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Fixed fee</span><span className="tabular-nums">− {formatAmount(bd.fixed_fee)}</span></div>}
              {bd.gst > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">GST</span><span className="tabular-nums">− {formatAmount(bd.gst)}</span></div>}
              <div className="flex justify-between border-t pt-1 font-medium text-[color:var(--color-text)]"><span>Net payable by branch</span><span className="tabular-nums">{formatAmount(bd.net)}</span></div>
              {bd.rule_version ? <div className="text-right text-[10px] text-[color:var(--color-text-muted)]">rule v{bd.rule_version}</div> : null}
            </div>
          )}
          {mode === "BANK" && (
            <div><Label className="text-xs">Pay to (vendor or your account)</Label>
              <select value={payTo} onChange={(e) => setPayTo(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                <option value="">Select who the branch pays…</option>
                {activeVendors.length > 0 && (
                  <optgroup label="Vendors">
                    {activeVendors.map((v) => <option key={v.id} value={`v:${v.id}`}>{v.vendor_name} · {v.vpa || v.account_number}</option>)}
                  </optgroup>
                )}
                {beneficiaries.length > 0 && (
                  <optgroup label="My accounts">
                    {beneficiaries.map((b) => <option key={b.id} value={`b:${b.id}`}>{b.beneficiary_name} · {b.transfer_mode} · {b.vpa || b.account_number}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><Label className="text-xs">Priority</Label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                <option>LOW</option><option>NORMAL</option><option>HIGH</option>
              </select></div>
            <div><Label className="text-xs">Requested date</Label><Input type="date" value={reqDate} onChange={(e) => setReqDate(e.target.value)} /></div>
            <div><Label className="text-xs">Your reference</Label><Input value={internalRef} onChange={(e) => setInternalRef(e.target.value)} placeholder="INV-1042…" /></div>
          </div>
          <div><Label className="text-xs">Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => raise.mutate()} disabled={raise.isPending || !branch || !(Number(amount) > 0)
            || (mode === "BANK" ? !payTo : (wallet.trim().length < 10 || !activeRate))}>Raise settlement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
