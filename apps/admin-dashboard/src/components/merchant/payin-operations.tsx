"use client";

// Merchant module operations: which pay-ins are currently active for this
// merchant, their mode (QR/non-QR), active receiver VPA + backup-pool health,
// with a one-click VPA failover and the shareable pay link. Admin-visible.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, SkipForward, QrCode, Smartphone, RefreshCw, Banknote, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PoolPayCreateOrder } from "@/components/vendors/poolpay-create-order";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";

interface Order {
  id: string; order_id: string; vendor: string; amount: number; currency_code: string;
  status: string; mode: string; active_vpa: string | null; vpa_total: number; vpa_remaining: number;
  sub_mid_code: string; rrn?: string; hold?: boolean; hold_reason?: string | null; terminal: boolean; created_at: string;
}

export function PayinOperationsCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["merchant", merchantId, "payin-orders"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-orders`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchant_code: string; live: Order[]; all: Order[] };
    },
    refetchInterval: 10_000,
  });

  const advance = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/poolpay/order/${orderId}/advance-vpa`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ active_vpa: string; remaining: number }>;
    },
    onSuccess: (d) => { toast.success(`Failed over to ${d.active_vpa}`, { description: `${d.remaining} backup VPA(s) left` }); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Cannot fail over", { description: e.message }),
  });

  // Deterministic ops confirm: enter the UTR seen in the payer/merchant app — no
  // dependence on phone notification capture. SUPER_ADMIN only (endpoint-gated).
  const confirmReceived = useMutation({
    mutationFn: async ({ id, utr }: { id: string; utr: string }) => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "SUCCESS", utr, evidence: "UTR" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Payment confirmed"); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Confirm failed", { description: e.message }),
  });

  const refresh = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/poolpay/order/${orderId}/refresh`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ status: string; changed: boolean }>;
    },
    onSuccess: (d) => { toast[d.changed ? "success" : "info"](`Status: ${d.status}`); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Refresh failed", { description: e.message }),
  });

  // Sandbox: simulate the bank-credit transaction alert (Android agent) for this
  // order so the reconciler matches and confirms it.
  const simCredit = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/poolpay/order/${orderId}/simulate-credit`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { outcome: string; detail?: string };
    },
    onSuccess: (d) => {
      if (d.outcome === "CONFIRMED") toast.success("Bank credit matched — order confirmed");
      else toast.info(`Alert ${String(d.outcome).toLowerCase()}`, { description: d.detail });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] });
    },
    onError: (e: Error) => toast.error("Simulate failed", { description: e.message }),
  });

  const live = q.data?.live ?? [];
  const copyLink = (id: string) => { navigator.clipboard?.writeText(`${window.location.origin}/pay/${id}`); toast.success("Pay link copied"); };

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Active payments (operations)</CardTitle>
          <CardDescription>Live pay-ins for this branch — mode, active receiver VPA, backup failover.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={live.length ? "success" : "default"}>{live.length} active</Badge>
          <PoolPayCreateOrder
            endpoint={`/api/merchants/${merchantId}/payin-orders`}
            receiverPlaceholder={"leave blank to use the merchant's settlement VPA\nor add a payee pool, one per line"}
            onChange={() => qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] })}
          />
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>
        ) : live.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-5 text-center text-sm text-[color:var(--color-text-muted)]">
            No active pay-ins. Click &ldquo;Create S2S order&rdquo; above to start one.
          </div>
        ) : (
          <ul className="space-y-2">
            {live.map((o) => (
              <li key={o.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{o.order_id}</span>
                      <Badge variant="brand">{railLabel(o.vendor)}</Badge>
                      <Badge variant="default">{o.mode === "QR" ? <><QrCode className="mr-1 h-3 w-3" />QR</> : <><Smartphone className="mr-1 h-3 w-3" />deeplink</>}</Badge>
                      {o.sub_mid_code && <Badge variant="info">{o.sub_mid_code}</Badge>}
                      {o.hold && <Badge variant="warning" title={o.hold_reason ?? "manual review"}>HELD · review</Badge>}
                      <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                      {formatAmount(o.amount, o.currency_code)} · {formatDateTime(o.created_at)}
                      {o.active_vpa ? <> · payee <span className="font-mono">{o.active_vpa}</span></> : null}
                      {o.vpa_total > 1 ? <> · VPA pool {o.vpa_remaining}/{o.vpa_total - 1} backups left</> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" title="Copy pay link" onClick={() => copyLink(o.id)}><Copy className="h-3.5 w-3.5" /></Button>
                    <Button asChild size="sm" variant="ghost" title="Open payment page"><a href={`/pay/${o.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a></Button>
                    <Button size="sm" variant="ghost" title="Force status refresh" disabled={refresh.isPending} onClick={() => refresh.mutate(o.id)}><RefreshCw className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" title="Simulate bank credit (sandbox) — match & confirm" disabled={simCredit.isPending} onClick={() => simCredit.mutate(o.id)}><Banknote className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" title="Confirm received — enter the UTR (ops only)" disabled={confirmReceived.isPending}
                      onClick={() => { const utr = window.prompt("Enter the UTR / bank reference shown in the payer's app:"); if (utr && utr.trim()) confirmReceived.mutate({ id: o.id, utr: utr.trim() }); }}>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="secondary" disabled={o.vpa_remaining < 1 || advance.isPending}
                      title={o.vpa_remaining < 1 ? "No backup VPA left" : "VPA can't receive — fail over to next"}
                      onClick={() => advance.mutate(o.id)}>
                      <SkipForward className="h-3.5 w-3.5" /> Next VPA
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Full transaction history for this merchant — every pay-in across all statuses
// (SUCCESS / PENDING / FAILED / EXPIRED), newest first. Reuses the same data hook
// as the operations card above (shared query cache), but renders the complete
// `all` set instead of only the live ones.
export function MerchantTransactionsCard({ merchantId }: { merchantId: string }) {
  const q = useQuery({
    queryKey: ["merchant", merchantId, "payin-orders"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-orders`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchant_code: string; live: Order[]; all: Order[] };
    },
    refetchInterval: 10_000,
  });

  const all = q.data?.all ?? [];
  const successAmount = all
    .filter((o) => ["SUCCESS", "SUCCEEDED"].includes(o.status))
    .reduce((sum, o) => sum + (o.amount ?? 0), 0);

  const cols: Column<Order>[] = [
    { key: "order_id", header: "Order", render: (o) => <span className="font-mono text-xs">{o.order_id}</span> },
    { key: "amount", header: "Amount", render: (o) => formatAmount(o.amount, o.currency_code) },
    { key: "status", header: "Status", render: (o) => <Badge variant={statusVariant(o.status)}>{o.status}</Badge> },
    { key: "mode", header: "Mode", render: (o) => o.mode === "QR" ? "QR" : "deeplink" },
    { key: "active_vpa", header: "Payee VPA", render: (o) => o.active_vpa ? <span className="font-mono text-xs">{o.active_vpa}</span> : "—" },
    { key: "rrn", header: "UTR / RRN", render: (o) => o.rrn ? <span className="font-mono text-xs">{o.rrn}</span> : "—" },
    { key: "sub_mid_code", header: "Sub-MID", render: (o) => o.sub_mid_code || "—" },
    { key: "created_at", header: "Date", render: (o) => formatDateTime(o.created_at) },
  ];

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Transactions</CardTitle>
          <CardDescription>All pay-ins for this branch across every status, newest first.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success" title="Total of successful pay-ins">{formatAmount(successAmount, "INR")} collected</Badge>
          <Badge variant="default">{all.length} total</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={cols}
          rows={all}
          loading={q.isLoading}
          rowKey={(o) => o.id}
          emptyState="No transactions yet. Create a pay-in order above to get started."
        />
      </CardContent>
    </Card>
  );
}
