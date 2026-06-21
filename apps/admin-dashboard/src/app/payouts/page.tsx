"use client";

// Payout & beneficiary console (PayTech BRD §18, §9, §11.B). Register beneficiaries
// (maker-checker whitelist), raise payouts (balance-checked; high-value → approval),
// and clear the maker-checker queue. Account numbers are masked.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, UserPlus, Check, X, ShieldCheck, Banknote } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { useConfirm } from "@/components/world-class/confirm-dialog";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Beneficiary {
  id: string; merchant_id: string; beneficiary_name: string; bank_name: string | null;
  account_number: string | null; ifsc: string | null; upi_id: string | null;
  wallet_address: string | null; network: string | null; status: string; created_at: string;
}
interface Approval {
  id: string; action_type: string; order_ref: string | null; merchant_id: string | null;
  amount_minor: string | null; currency: string | null; detail: string | null; status: string; maker: string | null; created_at: string;
}

async function jpost(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d;
}

export default function PayoutsPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [merchantId, setMerchantId] = useState("");
  const [ben, setBen] = useState({ beneficiary_name: "", bank_name: "", account_number: "", ifsc: "", upi_id: "", wallet_address: "", network: "" });
  const [payout, setPayout] = useState({ beneficiary_id: "", amount: "" });

  const beneficiaries = useQuery({
    queryKey: ["beneficiaries"],
    queryFn: async () => (await fetch("/api/v1/beneficiaries").then((r) => r.json())) as { beneficiaries: Beneficiary[] },
    refetchInterval: 10000,
  });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: async () => (await fetch("/api/v1/approvals?status=PENDING").then((r) => r.json())) as { approvals: Approval[] },
    refetchInterval: 8000,
  });
  const orders = useQuery({
    queryKey: ["payout-orders"],
    queryFn: async () => (await fetch("/api/v1/orders").then((r) => r.json())).orders as any[],
    refetchInterval: 8000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["beneficiaries"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["payout-orders"] });
  };

  const addBen = useMutation({
    mutationFn: async () => jpost("/api/v1/beneficiaries", { merchant_id: merchantId || undefined, ...Object.fromEntries(Object.entries(ben).filter(([, v]) => v)) }),
    onSuccess: () => { toast.success("Beneficiary added (PENDING approval)"); setBen({ beneficiary_name: "", bank_name: "", account_number: "", ifsc: "", upi_id: "", wallet_address: "", network: "" }); invalidate(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const decideBen = useMutation({
    mutationFn: async (v: { id: string; decision: "approve" | "reject" }) => jpost(`/api/v1/beneficiaries/${v.id}/approve`, { decision: v.decision }),
    onSuccess: (_d, v) => { toast.success(`Beneficiary ${v.decision}d`); invalidate(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const createPayout = useMutation({
    mutationFn: async () => jpost("/api/v1/payouts", { merchant_id: merchantId || undefined, beneficiary_id: payout.beneficiary_id, amount: payout.amount }),
    onSuccess: (d) => { toast.success(d.order?.approval_required ? "Payout created — awaiting maker-checker" : `Payout queued ${d.order?.order_ref}`); setPayout({ beneficiary_id: "", amount: "" }); invalidate(); },
    onError: (e: Error) => toast.error("Payout failed", { description: e.message }),
  });
  const decideApproval = useMutation({
    mutationFn: async (v: { id: string; decision: "approve" | "reject" }) => jpost(`/api/v1/approvals/${v.id}/decide`, { decision: v.decision }),
    onSuccess: (_d, v) => { toast.success(`Approval ${v.decision}d`); invalidate(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const bens = beneficiaries.data?.beneficiaries ?? [];
  const approved = bens.filter((b) => b.status === "APPROVED");
  const pending = approvals.data?.approvals ?? [];
  const payoutOrders = (orders.data ?? []).filter((o) => o.direction === "PAYOUT");

  // Confirm the chosen beneficiary + amount before raising a payout.
  const confirmCreate = async () => {
    const b = approved.find((x) => x.id === payout.beneficiary_id);
    if (await confirm({ title: "Create payout?", danger: true, confirmLabel: "Create payout",
      body: `Pay ₹${payout.amount} to ${b?.beneficiary_name ?? "beneficiary"} (${b?.merchant_id ?? merchantId}). High-value payouts route to maker-checker.` })) createPayout.mutate();
  };
  const confirmDecide = async (a: Approval, decision: "approve" | "reject") => {
    const amt = a.amount_minor ? formatAmount(Number(a.amount_minor), a.currency ?? "INR") : "";
    if (await confirm({
      title: decision === "approve" ? "Approve this request?" : "Reject this request?",
      danger: decision === "reject",
      confirmLabel: decision === "approve" ? "Approve" : "Reject",
      body: `${a.action_type}${amt ? ` · ${amt}` : ""}${a.order_ref ? ` · ${a.order_ref}` : ""}. ${decision === "approve" ? "Approving releases the funds / settlement." : "This rejects the request."}`,
    })) decideApproval.mutate({ id: a.id, decision });
  };

  return (
    <>
      {dialog}
      <PageHeader title="Payouts & Beneficiaries" description="Whitelist beneficiaries, raise balance-checked payouts, clear maker-checker approvals (BRD §18/§9)." icon={Send} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Beneficiaries" value={bens.length} loading={beneficiaries.isLoading} />
        <KpiTile label="Whitelisted" value={approved.length} variant="success" loading={beneficiaries.isLoading} />
        <KpiTile label="Pending approvals" value={pending.length} variant={pending.length > 0 ? "warning" : "default"} loading={approvals.isLoading} />
        <KpiTile label="Payout orders" value={payoutOrders.length} loading={orders.isLoading} />
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Context</CardTitle><CardDescription>Admins: set the merchant code these actions apply to. Merchants: leave blank (uses your own).</CardDescription></CardHeader>
        <CardContent><Input className="h-9 w-64" placeholder="merchant code e.g. MID100245" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} /></CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserPlus className="h-4 w-4" /> Add beneficiary</CardTitle><CardDescription>Created PENDING — a checker must approve to whitelist.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <Input className="h-9" placeholder="Beneficiary name *" value={ben.beneficiary_name} onChange={(e) => setBen({ ...ben, beneficiary_name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input className="h-9" placeholder="Bank name" value={ben.bank_name} onChange={(e) => setBen({ ...ben, bank_name: e.target.value })} />
              <Input className="h-9" placeholder="Account number" value={ben.account_number} onChange={(e) => setBen({ ...ben, account_number: e.target.value })} />
              <Input className="h-9" placeholder="IFSC" value={ben.ifsc} onChange={(e) => setBen({ ...ben, ifsc: e.target.value })} />
              <Input className="h-9" placeholder="UPI id" value={ben.upi_id} onChange={(e) => setBen({ ...ben, upi_id: e.target.value })} />
              <Input className="h-9" placeholder="USDT wallet" value={ben.wallet_address} onChange={(e) => setBen({ ...ben, wallet_address: e.target.value })} />
              <Input className="h-9" placeholder="Network (TRC20)" value={ben.network} onChange={(e) => setBen({ ...ben, network: e.target.value })} />
            </div>
            <Button size="sm" onClick={() => addBen.mutate()} disabled={!ben.beneficiary_name || addBen.isPending}><UserPlus className="h-4 w-4" /> Add</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Banknote className="h-4 w-4" /> Raise payout</CardTitle><CardDescription>Whitelisted beneficiary only. High-value goes to maker-checker.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <select className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={payout.beneficiary_id} onChange={(e) => setPayout({ ...payout, beneficiary_id: e.target.value })}>
              <option value="">Select whitelisted beneficiary…</option>
              {approved.map((b) => <option key={b.id} value={b.id}>{b.beneficiary_name} · {b.bank_name ?? b.network ?? "—"} ({b.merchant_id})</option>)}
            </select>
            <Input className="h-9" placeholder="Amount" value={payout.amount} onChange={(e) => setPayout({ ...payout, amount: e.target.value })} />
            <Button size="sm" onClick={confirmCreate} disabled={!payout.beneficiary_id || !payout.amount || createPayout.isPending}><Send className="h-4 w-4" /> Create payout</Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Pending approvals ({pending.length})</CardTitle><CardDescription>Maker-checker: a different user than the maker must decide.</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {pending.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Nothing pending.</div>}
          {pending.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="brand">{a.action_type}</Badge>
                {a.order_ref && <span className="font-mono text-xs">{a.order_ref}</span>}
                {a.amount_minor && <span className="tabular-nums font-medium">{formatAmount(Number(a.amount_minor), a.currency ?? "INR")}</span>}
                <span className="text-xs text-[color:var(--color-text-muted)]">{a.detail} · maker {a.maker ?? "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => confirmDecide(a, "approve")} disabled={decideApproval.isPending}><Check className="h-4 w-4" /> Approve</Button>
                <Button size="sm" variant="danger" onClick={() => confirmDecide(a, "reject")} disabled={decideApproval.isPending}><X className="h-4 w-4" /> Reject</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Beneficiaries ({bens.length})</CardTitle><CardDescription>Account numbers masked. Approve PENDING to whitelist.</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {bens.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">No beneficiaries.</div>}
          {bens.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{b.beneficiary_name}</span>
                <span className="text-xs text-[color:var(--color-text-muted)]">{b.bank_name ?? ""} {b.account_number ?? ""} {b.ifsc ?? ""} {b.upi_id ?? ""} {b.wallet_address ? `${b.network ?? ""} ${b.wallet_address}` : ""} · {b.merchant_id}</span>
                <Badge variant={statusVariant(b.status)}>{b.status}</Badge>
              </div>
              {b.status === "PENDING" && (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => decideBen.mutate({ id: b.id, decision: "approve" })} disabled={decideBen.isPending}><Check className="h-4 w-4" /> Approve</Button>
                  <Button size="sm" variant="danger" onClick={() => decideBen.mutate({ id: b.id, decision: "reject" })} disabled={decideBen.isPending}><X className="h-4 w-4" /> Reject</Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Payout orders ({payoutOrders.length})</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {payoutOrders.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">No payout orders.</div>}
          {payoutOrders.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{o.order_ref}</span>
                <span className="tabular-nums font-medium">{formatAmount(Number(o.amount_minor), o.currency)}</span>
                <span className="text-xs text-[color:var(--color-text-muted)]">{o.merchant_id} · {o.settlement_mode}</span>
                <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                {o.settlement_mode === "USDT" && o.usdt_amount && <Badge variant="info">{o.usdt_amount} USDT @ {o.usdt_rate} {o.usdt_network}</Badge>}
                {o.utr && <span className="text-xs">UTR {o.utr}</span>}
                {o.tx_hash && <span className="text-xs font-mono">tx {String(o.tx_hash).slice(0, 12)}…</span>}
              </div>
              <span className="text-xs text-[color:var(--color-text-muted)]">{formatDateTime(o.created_at)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
