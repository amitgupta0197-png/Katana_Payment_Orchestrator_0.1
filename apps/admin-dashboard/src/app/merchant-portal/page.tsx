"use client";

// MERCHANT revenue dashboard. Today's volume + success rate, balance,
// reserves, recent transactions; alert strip surfaces failed payments,
// disputes, settlement holds.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  LayoutDashboard, Activity, Wallet, Banknote, ShieldAlert, KeyRound,
  Webhook, ChevronRight, AlertOctagon, Plus, CreditCard, Receipt,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { AlertStrip, type AlertItem } from "@/components/world-class/alert-strip";
import { MerchantPortalAgentCard } from "@/components/merchant/portal-agent";
import { MerchantCharts } from "@/components/merchant/portal-charts";
import { PaymentFunnel } from "@/components/integrations/payment-funnel";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; client_ref: string; txn_id?: string; amount: number; currency: string;
  method: string; selected_rail?: string; status: string; created_at: string;
}
interface Balance { merchant_id: string; currency: string; balance: number }
interface Reserve { id: string; release_status: string; hold_amount: number; released_amount: number; expected_release_date?: string }
interface Dispute { id: string; status: string; amount?: number; raised_at?: string }

export default function MerchantDashboard() {
  // The merchant's own row (id + code) — used to fetch Katana Pay pay-ins, which
  // are keyed by merchant code, not the session's UUID scope.
  const meQ = useQuery({
    queryKey: ["mp:me"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: { id: string; merchant_code: string }[] },
  });
  const meId = meQ.data?.merchants?.[0]?.id;

  const orders = useQuery({
    queryKey: ["mp:orders"],
    queryFn: async () => (await fetch("/api/checkout").then((r) => r.json())) as { orders: Order[] },
    refetchInterval: 30_000,
  });
  // Katana Pay (PoolPay) pay-ins for this merchant — merged into the figures below
  // so QR/S2S collections show up alongside checkout-gateway orders.
  const payins = useQuery({
    queryKey: ["mp:payins", meId],
    enabled: !!meId,
    queryFn: async () => (await fetch(`/api/merchants/${meId}/payin-orders`).then((r) => r.json())) as { all: Array<{ id: string; order_id: string; amount: number; currency_code: string; status: string; rrn?: string; mode?: string; created_at: string }> },
    refetchInterval: 30_000,
  });
  const balance = useQuery({
    queryKey: ["mp:balance"],
    queryFn: async () => (await fetch("/api/ledger/balance").then((r) => r.json())) as { balances: Balance[] },
  });
  const reserves = useQuery({
    queryKey: ["mp:reserves"],
    queryFn: async () => (await fetch("/api/reserves").then((r) => r.json())) as { reserves: Reserve[] },
  });
  const disputes = useQuery({
    queryKey: ["mp:disputes"],
    queryFn: async () => (await fetch("/api/disputes").then((r) => r.json())) as { disputes: Dispute[] },
  });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const checkoutRows = orders.data?.orders ?? [];
  // Normalize Katana Pay pay-ins into the Order shape and merge with checkout orders.
  const payinRows: Order[] = (payins.data?.all ?? []).map((p) => ({
    id: p.id, client_ref: p.order_id, txn_id: p.rrn || undefined,
    amount: Number(p.amount || 0), currency: p.currency_code || "INR",
    method: p.mode === "QR" ? "UPI QR" : "UPI Intent", selected_rail: "Katana Pay",
    status: p.status, created_at: p.created_at,
  }));
  const orderRows = [...checkoutRows, ...payinRows].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const txnsLoading = orders.isLoading || payins.isLoading;
  const todayOrders = orderRows.filter((o) => new Date(o.created_at).getTime() >= today.getTime());
  const todayPayin = todayOrders.reduce((s, o) => s + Number(o.amount || 0), 0);
  const todayFailed = todayOrders.filter((o) => o.status === "FAILED" || o.status === "EXPIRED").length;
  const successRate = todayOrders.length > 0 ? Math.round(((todayOrders.length - todayFailed) / todayOrders.length) * 1000) / 10 : null;

  const reserveRows = reserves.data?.reserves ?? [];
  const heldNow = reserveRows
    .filter((r) => r.release_status !== "RELEASED" && r.release_status !== "FORFEITED")
    .reduce((s, r) => s + (Number(r.hold_amount || 0) - Number(r.released_amount || 0)), 0);
  const releasingSoon = reserveRows
    .filter((r) => r.release_status !== "RELEASED" && r.expected_release_date && new Date(r.expected_release_date).getTime() < today.getTime() + 7 * 86400_000)
    .length;

  const currentBalance = (balance.data?.balances ?? []).reduce((s, b) => s + Number(b.balance || 0), 0);
  const openDisputes = (disputes.data?.disputes ?? []).filter((d) => d.status !== "WON" && d.status !== "LOST" && d.status !== "EXPIRED").length;

  const alerts: AlertItem[] = [];
  if (todayFailed > 0 && (successRate ?? 100) < 95) {
    alerts.push({ level: "critical", title: `Success rate ${successRate}% today`, detail: `${todayFailed} of ${todayOrders.length} payments failed.`, href: "/merchant-portal/transactions?f=failed", cta: "Inspect" });
  }
  if (openDisputes > 0) {
    alerts.push({ level: "warning", title: `${openDisputes} open dispute${openDisputes > 1 ? "s" : ""}`, detail: "Reply window may be running out — SLA clock applies.", href: "/merchant-portal/disputes", cta: "Reply" });
  }
  if (releasingSoon > 0) {
    alerts.push({ level: "info", title: `${releasingSoon} reserve release${releasingSoon > 1 ? "s" : ""} in next 7 days`, href: "/merchant-portal/reserves", cta: "View calendar" });
  }

  const recentCols: Column<Order>[] = [
    { key: "client_ref", header: "Ref", render: (r) => <span className="font-mono text-xs">{r.client_ref}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "method", header: "Method" },
    { key: "selected_rail", header: "Rail", render: (r) => r.selected_rail ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live revenue view · today's volume, balance, reserves, and disputes."
        icon={LayoutDashboard}
        actions={<Badge variant={orders.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live · refresh 30s</Badge>}
      />

      {alerts.length > 0 && (
        <div className="mb-6">
          <AlertStrip items={alerts.slice(0, 5)} />
        </div>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Today</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Pay-ins" value={formatAmount(todayPayin)} sublabel={`${todayOrders.length} txns`} icon={CreditCard} loading={txnsLoading} href="/merchant-portal/transactions" />
        <KpiTile label="Success rate" value={successRate === null ? "—" : `${successRate}%`} sublabel={`${todayFailed} failed`} variant={successRate === null ? "default" : successRate >= 99 ? "success" : successRate >= 95 ? "default" : successRate >= 90 ? "warning" : "danger"} loading={txnsLoading} href="/merchant-portal/transactions?f=failed" />
        <KpiTile label="Current balance" value={formatAmount(currentBalance)} icon={Wallet} loading={balance.isLoading} />
        <KpiTile label="Open disputes" value={openDisputes} icon={ShieldAlert} variant={openDisputes > 0 ? "warning" : "default"} loading={disputes.isLoading} href="/merchant-portal/disputes" />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Money</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Reserves held" value={formatAmount(heldNow)} sublabel={`${reserveRows.length} schedules`} icon={Banknote} loading={reserves.isLoading} href="/merchant-portal/reserves" />
        <KpiTile label="Releasing in 7d" value={releasingSoon} icon={Banknote} loading={reserves.isLoading} href="/merchant-portal/reserves" />
        <KpiTile label="Pending settlement" value={formatAmount(currentBalance)} sublabel="next batch ETA" icon={Receipt} loading={balance.isLoading} href="/merchant-portal/settlements" />
        <KpiTile label="Pay-in count today" value={todayOrders.length} icon={Activity} loading={txnsLoading} href="/merchant-portal/transactions" />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Katana Pay reconciliation</h2>
      <PaymentFunnel merchant={meId} description="Your Katana Pay pay-ins from created → reconciled." />

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Insights</h2>
      <MerchantCharts orders={orderRows} loading={txnsLoading} />

      <div className="mb-6">
        <MerchantPortalAgentCard />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
            <CardDescription>Last 10 payment orders.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={recentCols}
              rows={orderRows.slice(0, 10)}
              loading={txnsLoading}
              rowKey={(r) => r.id}
              emptyState="No transactions yet. Once a payment fires, it'll appear here in real time."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2">
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/api-keys"><span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />Issue API key</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/profile"><span className="inline-flex items-center gap-2"><Webhook className="h-4 w-4" />Configure webhooks</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/sub-mids"><span className="inline-flex items-center gap-2"><Plus className="h-4 w-4" />Request a new Sub-MID</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/settlements"><span className="inline-flex items-center gap-2"><Receipt className="h-4 w-4" />Settlement statement</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
