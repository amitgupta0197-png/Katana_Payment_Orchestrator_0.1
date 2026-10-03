"use client";

// Merchant module operations: which pay-ins are currently active for this
// merchant, their mode (QR/non-QR), active receiver VPA + backup-pool health,
// with a one-click VPA failover and the shareable pay link. Admin-visible.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, SkipForward, QrCode, Smartphone, RefreshCw, Banknote, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KatanaCreateOrder } from "@/components/vendors/katana-create-order";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";

interface Order {
  id: string; order_id: string; vendor: string; amount: number; currency_code: string;
  status: string; mode: string; active_vpa: string | null; vpa_total: number; vpa_remaining: number;
  sub_mid_code: string; rrn?: string; hold?: boolean; hold_reason?: string | null; terminal: boolean; created_at: string;
  /** "checkout": a hosted-checkout order (POST /api/pay), shown in the history only. */
  source?: "checkout";
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
      const r = await fetch(`/api/vendors/katana/order/${orderId}/advance-vpa`, { method: "POST" });
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
      const r = await fetch(`/api/vendors/katana/order/${id}/confirm`, {
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
      const r = await fetch(`/api/vendors/katana/order/${orderId}/refresh`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ status: string; changed: boolean; note?: string }>;
    },
    // `note`: what the gateway answered when a gateway order did not change.
    onSuccess: (d) => { toast[d.changed ? "success" : "info"](`Status: ${d.status}`, d.note ? { description: d.note, duration: 12000 } : undefined); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] }); },
    onError: (e: Error) => toast.error("Refresh failed", { description: e.message }),
  });

  // Sandbox: simulate the bank-credit transaction alert (Android agent) for this
  // order so the reconciler matches and confirms it.
  const simCredit = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/vendors/katana/order/${orderId}/simulate-credit`, { method: "POST" });
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
          <CardDescription>Live pay-ins for this banker — mode, active receiver VPA, backup failover.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={live.length ? "success" : "default"}>{live.length} active</Badge>
          <KatanaCreateOrder
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
    { key: "mode", header: "Mode", render: (o) => o.source === "checkout" ? `Hosted checkout${o.vendor !== "CHECKOUT" ? ` · ${railLabel(o.vendor)}` : ""}` : o.mode === "QR" ? "QR" : "deeplink" },
    { key: "active_vpa", header: "Payee VPA", render: (o) => o.active_vpa ? <span className="font-mono text-xs">{o.active_vpa}</span> : "—" },
    { key: "rrn", header: "UTR (bank reference)", render: (o) => o.rrn ? <span className="font-mono text-xs">{o.rrn}</span> : "—" },
    { key: "sub_mid_code", header: "Sub-MID", render: (o) => o.sub_mid_code || "—" },
    { key: "created_at", header: "Date", render: (o) => formatDateTime(o.created_at) },
  ];

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Transactions</CardTitle>
          <CardDescription>All pay-ins for this banker across every status, newest first — Katana Pay orders and hosted checkouts.</CardDescription>
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

interface PossibleOrder { id: string; order_id: string; created_at: string; status: string }
interface CapturedCredit {
  id: string; amount: number; utr: string; app: string; source: string; payer_name: string;
  outcome: string; matched_order_ref: string; received_at: string;
  /** Staff only: open orders this payment could belong to (lib/credit-link). */
  possible_orders?: PossibleOrder[];
}

/**
 * The Order cell of a payment no order took. With open orders of its amount from just before it
 * (lib/credit-link), staff pick the one it paid: the reconciler will not choose between two of the
 * same amount. Linking confirms that order with this payment's bank reference.
 */
function LinkCell({ merchantId, credit }: { merchantId: string; credit: CapturedCredit }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState<string | null>(null);
  const link = useMutation({
    mutationFn: async (orderId: string) => {
      const r = await fetch(`/api/merchants/${merchantId}/credits/${credit.id}/link`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: orderId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not link");
      return d as { order_id: string };
    },
    onSuccess: (d) => {
      toast.success(`Linked to ${d.order_id}; the order is now paid`);
      setAsking(null);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "credits"] });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] });
    },
    onError: (e: Error) => toast.error("Not linked", { description: e.message }),
  });
  const options = credit.possible_orders ?? [];
  if (!options.length)
    return <Badge variant="default" title="Paid straight to the QR — no open Katana order of this amount was waiting for it">No order</Badge>;
  return (
    <div className="space-y-1.5">
      <Badge variant="warning" title="More than one open order had this amount, so it was not linked by itself">
        {options.length === 1 ? "1 possible order" : `${options.length} possible orders`}
      </Badge>
      {options.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono">{o.order_id}</span>
          <span className="text-[color:var(--color-text-muted)]">{formatDateTime(o.created_at)}</span>
          {asking === o.id ? (
            <>
              <Button size="sm" disabled={link.isPending} onClick={() => link.mutate(o.id)}>{link.isPending ? "Linking…" : "Confirm link"}</Button>
              <Button size="sm" variant="ghost" disabled={link.isPending} onClick={() => setAsking(null)}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setAsking(o.id)}>Link</Button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * What the agent phone captured, whether or not an order was waiting for it.
 *
 * The Transactions table above lists ORDERS, so a payment made straight to the banker's QR —
 * no order — appeared nowhere on this page, and a working agent looked dead (2026-10-01: a
 * captured Rs1 was on the server and in Transaction Intel, and not here).
 */
export function MerchantCapturedCreditsCard({ merchantId }: { merchantId: string }) {
  const q = useQuery({
    queryKey: ["merchant", merchantId, "credits"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/credits`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { credits: CapturedCredit[] };
    },
    refetchInterval: 10_000,
  });

  const credits = q.data?.credits ?? [];
  const cols: Column<CapturedCredit>[] = [
    { key: "received_at", header: "Received", render: (c) => formatDateTime(c.received_at) },
    { key: "amount", header: "Amount", render: (c) => formatAmount(c.amount, "INR") },
    { key: "utr", header: "UTR (bank reference)", render: (c) => c.utr ? <span className="font-mono text-xs">{c.utr}</span> : "—" },
    { key: "app", header: "App", render: (c) => c.app },
    { key: "payer_name", header: "Payer", render: (c) => c.payer_name || "—" },
    {
      key: "matched_order_ref", header: "Order",
      render: (c) => c.matched_order_ref
        ? <span className="font-mono text-xs">{c.matched_order_ref}</span>
        : <LinkCell merchantId={merchantId} credit={c} />,
    },
  ];

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Captured payments</CardTitle>
          <CardDescription>UPI credits the agent phone read off the payment app, newest first — including payments made straight to the QR, which have no order above.</CardDescription>
        </div>
        <Badge variant="default">{credits.length} shown</Badge>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={cols}
          rows={credits}
          loading={q.isLoading}
          rowKey={(c) => c.id}
          emptyState="Nothing captured yet. A payment appears here within seconds of the agent phone reading it."
        />
      </CardContent>
    </Card>
  );
}
