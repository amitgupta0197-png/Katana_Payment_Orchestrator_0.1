"use client";

// DOWNLINE (branch) view of provider settlements. The provider (upline) raises a
// settlement; the branch drives it through the lifecycle with context-aware status
// buttons (Accept → Start → Mark paid …), and every change is written to the shared
// immutable timeline the upline can see in real time.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Activity, Copy, Clock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { settlementStatusVariant, settlementStatusLabel } from "@/components/settlement/status";
import { SettlementActionBar, SettlementTimeline, SettlementNotifications, UploadReceiptButton } from "@/components/settlement/controls";

interface Settlement {
  id: string; provider_code?: string; provider_name?: string; amount: number; currency: string; status: string;
  gross_amount?: number | null; net_amount?: number | null;
  charges?: { upline_charge?: number; katana_charge?: number; downline_charge?: number; fixed_fee?: number; gst?: number; total_charges?: number } | null;
  settle_mode?: "BANK" | "USDT"; usdt_network?: string | null; wallet_address?: string | null;
  usdt_rate?: number | null; usdt_quantity?: number | null; tx_hash?: string | null; request_ref?: string | null;
  has_receipt?: boolean; locked?: boolean; priority?: string; requested_date?: string | null; internal_ref?: string | null;
  utr?: string; purpose?: string; transfer_mode?: string; beneficiary_snapshot?: any; requested_at: string; note?: string;
}

export default function BranchProviderSettlementsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settlements", "branch"],
    queryFn: async () => (await fetch("/api/settlements").then((r) => r.json())) as { settlements: Settlement[] },
    refetchInterval: 10_000,
  });
  const [detailFor, setDetailFor] = useState<Settlement | null>(null);

  const list = q.data?.settlements ?? [];
  const toPay = list.filter((x) => ["REQUESTED", "REJECTED", "CORRECTION_REQUIRED"].includes(x.status)).reduce((s, x) => s + Number(x.net_amount ?? x.amount ?? 0), 0);
  const inProgress = list.filter((x) => ["ACCEPTED", "PROCESSING", "ON_HOLD"].includes(x.status)).length;

  const cols: Column<Settlement>[] = [
    { key: "ref", header: "Request ID", render: (r) => (
      <span className="font-mono text-xs">
        {r.request_ref ?? r.id.slice(0, 8)}
        {r.priority === "HIGH" ? <Badge variant="danger">HIGH</Badge> : r.priority === "LOW" ? <Badge variant="default">low</Badge> : null}
        {r.locked ? <Badge variant="warning">🔒 locked</Badge> : null}
      </span>
    ) },
    { key: "provider", header: "Merchant", render: (r) => <span className="font-medium">{r.provider_name ?? r.provider_code ?? "—"}</span> },
    { key: "amount", header: "Gross", render: (r) => <span className="tabular-nums">{formatAmount(r.gross_amount ?? r.amount, r.currency)}</span> },
    { key: "net", header: "Net to pay", render: (r) => (
      <span className="tabular-nums font-medium">
        {r.settle_mode === "USDT" && r.usdt_quantity
          ? <>{r.usdt_quantity} USDT<span className="block text-[10px] text-[color:var(--color-text-muted)]">{formatAmount(r.net_amount ?? r.amount)} @ ₹{r.usdt_rate}</span></>
          : formatAmount(r.net_amount ?? r.amount, r.currency)}
      </span>
    ) },
    { key: "beneficiary", header: "Pay to", render: (r) => {
      if (r.settle_mode === "USDT")
        return <span className="text-xs font-mono break-all">{r.wallet_address ?? "—"} <Badge variant="brand">{r.usdt_network}</Badge></span>;
      const b = r.beneficiary_snapshot ?? {};
      return <span className="text-xs">{b.beneficiary_name ?? "—"}{b.vpa ? ` · ${b.vpa}` : b.account_number ? ` · ${b.account_number} (${b.ifsc ?? ""})` : ""} <Badge variant="info">{r.transfer_mode ?? b.transfer_mode}</Badge></span>;
    } },
    { key: "utr", header: "UTR / Hash", render: (r) => (r.tx_hash || r.utr) ? <span className="font-mono text-xs break-all">{r.tx_hash ?? r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">—</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={settlementStatusVariant(r.status)}>{settlementStatusLabel(r.status)}</Badge> },
    { key: "requested_at", header: "Raised", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "actions", header: "", render: (r) => (
      <div className="flex items-center gap-1.5">
        <SettlementActionBar settlementId={r.id} status={r.status} role="DOWNLINE" mode={r.settle_mode ?? "BANK"} locked={r.locked}
          prefill={r.settle_mode === "USDT" ? { usdt_quantity: String(r.usdt_quantity ?? ""), usdt_rate: String(r.usdt_rate ?? "") } : undefined}
          onDone={() => qc.invalidateQueries({ queryKey: ["settlements"] })} />
        {["PROCESSING", "PAID", "PARTIALLY_PAID", "USDT_TRANSFERRED"].includes(r.status) && !r.has_receipt
          ? <UploadReceiptButton settlementId={r.id} /> : null}
        {r.has_receipt ? <Button size="sm" variant="secondary" asChild><a href={`/api/settlements/${r.id}/receipt`} target="_blank" rel="noreferrer">Receipt</a></Button> : null}
        <Button size="sm" variant="secondary" onClick={() => setDetailFor(r)}><Clock className="h-4 w-4" /></Button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Merchant settlements"
        description="Settlements your merchant raised. Accept, process, and mark paid — every step is visible to your merchant in real time."
        icon={Banknote}
        actions={<Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live · 10s</Badge>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">To act / resubmit</div><div className="text-2xl font-semibold tabular-nums">{formatAmount(toPay)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">In progress</div><div className="text-2xl font-semibold tabular-nums">{inProgress}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Awaiting confirmation</div><div className="text-2xl font-semibold tabular-nums">{list.filter((x) => ["PAID", "PARTIALLY_PAID", "UTR_SUBMITTED"].includes(x.status)).length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Confirmed</div><div className="text-2xl font-semibold tabular-nums">{list.filter((x) => ["VERIFIED", "RECONCILED"].includes(x.status)).length}</div></CardContent></Card>
      </div>

      <CapacityCard />

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Recent activity</CardTitle><CardDescription>Live status changes across your settlements — you'll also get a toast the moment something changes.</CardDescription></CardHeader>
        <CardContent><SettlementNotifications selfRole="DOWNLINE" /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Settlement requests</CardTitle><CardDescription>Only the actions valid for the current stage are shown. Open the clock icon for the full status timeline.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={q.isLoading} emptyState="No settlement requests from your provider yet." />
        </CardContent>
      </Card>

      <SettlementDetailDialog settlement={detailFor} onClose={() => setDetailFor(null)} />
    </>
  );
}

// §14: the branch declares its settlement capacity — the provider sees this when
// raising, and Katana can plan liquidity around it.
function CapacityCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["branch-capacity"],
    queryFn: async () => (await fetch("/api/branch-capacity").then((r) => r.json())) as {
      capacity: Array<{ merchant_key: string; bank_available: boolean; usdt_available: boolean; usdt_quantity: number | null; usdt_network: string | null; daily_capacity: number | null; unavailable_until: string | null; note: string | null }>;
    },
  });
  const cap = q.data?.capacity?.[0];
  const [f, setF] = useState<{ bank: boolean; usdt: boolean; qty: string; network: string; daily: string; note: string } | null>(null);
  const form = f ?? {
    bank: cap?.bank_available ?? true, usdt: cap?.usdt_available ?? false,
    qty: cap?.usdt_quantity != null ? String(cap.usdt_quantity) : "", network: cap?.usdt_network ?? "TRC20",
    daily: cap?.daily_capacity != null ? String(cap.daily_capacity) : "", note: cap?.note ?? "",
  };
  const set = (k: string, v: unknown) => setF({ ...form, [k]: v } as typeof form);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/branch-capacity", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bank_available: form.bank, usdt_available: form.usdt,
          usdt_quantity: form.usdt && form.qty ? Number(form.qty) : null,
          usdt_network: form.usdt ? form.network : null,
          daily_capacity: form.daily ? Number(form.daily) : null,
          note: form.note || null,
        }),
      });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Availability updated — your provider can see it"); setF(null); qc.invalidateQueries({ queryKey: ["branch-capacity"] }); },
    onError: (e: Error) => toast.error("Couldn’t save", { description: e.message }),
  });

  return (
    <Card className="mb-6">
      <CardHeader><CardTitle className="text-base">My settlement availability</CardTitle>
        <CardDescription>Declare what you can process today — bank transfers, USDT liquidity, and your daily capacity.</CardDescription></CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.bank} onChange={(e) => set("bank", e.target.checked)} /> Bank settlement available</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.usdt} onChange={(e) => set("usdt", e.target.checked)} /> USDT available</label>
          {form.usdt && (<>
            <div><span className="block text-xs text-[color:var(--color-text-muted)]">USDT quantity</span>
              <input type="number" className="w-28 rounded-md border bg-transparent px-2 py-1.5 text-sm" value={form.qty} onChange={(e) => set("qty", e.target.value)} /></div>
            <div><span className="block text-xs text-[color:var(--color-text-muted)]">Network</span>
              <select className="rounded-md border bg-[color:var(--color-surface)] px-2 py-1.5 text-sm" value={form.network} onChange={(e) => set("network", e.target.value)}>
                {["TRC20", "ERC20", "BEP20"].map((n) => <option key={n}>{n}</option>)}
              </select></div>
          </>)}
          <div><span className="block text-xs text-[color:var(--color-text-muted)]">Daily capacity (₹)</span>
            <input type="number" className="w-32 rounded-md border bg-transparent px-2 py-1.5 text-sm" value={form.daily} onChange={(e) => set("daily", e.target.value)} /></div>
          <div className="flex-1 min-w-40"><span className="block text-xs text-[color:var(--color-text-muted)]">Note</span>
            <input className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm" value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="e.g. unavailable this weekend" /></div>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !f}>Save availability</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SettlementDetailDialog({ settlement, onClose }: { settlement: Settlement | null; onClose: () => void }) {
  const b = settlement?.beneficiary_snapshot ?? {};
  const copy = (s?: string) => { if (s) { navigator.clipboard.writeText(s); toast.success("Copied"); } };
  return (
    <Dialog open={!!settlement} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settlement {settlement ? formatAmount(settlement.amount, settlement.currency) : ""}</DialogTitle>
          <DialogDescription>Beneficiary to pay and the full status timeline.</DialogDescription>
        </DialogHeader>
        {settlement && (
          <div className="space-y-4">
            <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-sm space-y-1">
              {settlement.request_ref ? <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Request ID</span><span className="font-mono text-xs">{settlement.request_ref}</span></div> : null}
              {settlement.settle_mode === "USDT" ? <>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Network</span><Badge variant="brand">{settlement.usdt_network}</Badge></div>
                <div className="flex justify-between gap-2"><span className="text-[color:var(--color-text-muted)]">Wallet</span><button className="font-mono text-xs break-all inline-flex items-center gap-1" onClick={() => copy(settlement.wallet_address ?? undefined)}>{settlement.wallet_address} <Copy className="h-3 w-3 shrink-0" /></button></div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Quantity</span><span className="tabular-nums font-medium">{settlement.usdt_quantity} USDT @ ₹{settlement.usdt_rate}</span></div>
                {settlement.tx_hash ? <div className="flex justify-between gap-2"><span className="text-[color:var(--color-text-muted)]">Tx hash</span><span className="font-mono text-xs break-all">{settlement.tx_hash}</span></div> : null}
              </> : <>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Beneficiary</span><span className="font-medium">{b.beneficiary_name ?? "—"}</span></div>
                {b.vpa ? <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">VPA</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.vpa)}>{b.vpa} <Copy className="h-3 w-3" /></button></div> : b.account_number ? <>
                  <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Account</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.account_number)}>{b.account_number} <Copy className="h-3 w-3" /></button></div>
                  <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">IFSC</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.ifsc)}>{b.ifsc} <Copy className="h-3 w-3" /></button></div>
                </> : null}
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Mode</span><span>{settlement.transfer_mode ?? b.transfer_mode ?? "—"}</span></div>
              </>}
              <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Status</span><Badge variant={settlementStatusVariant(settlement.status)}>{settlementStatusLabel(settlement.status)}</Badge></div>
            </div>
            {settlement.charges && Number(settlement.charges.total_charges) > 0 && (
              <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-xs space-y-0.5">
                <div className="mb-1 font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Deductions</div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Gross request</span><span className="tabular-nums">{formatAmount(settlement.gross_amount ?? settlement.amount)}</span></div>
                {Number(settlement.charges.upline_charge) > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Provider commission</span><span className="tabular-nums">− {formatAmount(Number(settlement.charges.upline_charge))}</span></div>}
                {Number(settlement.charges.katana_charge) > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Katana charge</span><span className="tabular-nums">− {formatAmount(Number(settlement.charges.katana_charge))}</span></div>}
                {Number(settlement.charges.downline_charge) > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Banker charge</span><span className="tabular-nums">− {formatAmount(Number(settlement.charges.downline_charge))}</span></div>}
                {Number(settlement.charges.fixed_fee) > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Fixed fee</span><span className="tabular-nums">− {formatAmount(Number(settlement.charges.fixed_fee))}</span></div>}
                {Number(settlement.charges.gst) > 0 && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">GST</span><span className="tabular-nums">− {formatAmount(Number(settlement.charges.gst))}</span></div>}
                <div className="flex justify-between border-t pt-1 font-medium text-[color:var(--color-text)]"><span>Net to pay</span><span className="tabular-nums">{formatAmount(settlement.net_amount ?? settlement.amount)}</span></div>
              </div>
            )}
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Status timeline</div>
              <SettlementTimeline settlementId={settlement.id} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
