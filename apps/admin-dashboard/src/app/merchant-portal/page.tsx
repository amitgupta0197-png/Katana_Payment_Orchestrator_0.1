"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; client_ref: string; txn_id?: string; amount: number; currency: string;
  method: string; selected_rail?: string; status: string; created_at: string;
}
interface Balance { merchant_id: string; currency: string; balance: number }
interface Reserve { id: string; release_status: string; hold_amount: number; released_amount: number }

export default function MerchantDashboard() {
  const orders = useQuery({
    queryKey: ["mp:orders"],
    queryFn: async () => (await fetch("/api/checkout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[] },
  });
  const balance = useQuery({
    queryKey: ["mp:balance"],
    queryFn: async () => (await fetch("/api/ledger/balance").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { balances: Balance[] },
  });
  const reserves = useQuery({
    queryKey: ["mp:reserves"],
    queryFn: async () => (await fetch("/api/reserves").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { reserves: Reserve[] },
  });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const orderRows = orders.data?.orders ?? [];
  const todayOrders = orderRows.filter((o) => new Date(o.created_at).getTime() >= today.getTime());
  const todayPayin = todayOrders.reduce((s, o) => s + Number(o.amount || 0), 0);

  const reserveRows = reserves.data?.reserves ?? [];
  const heldNow = reserveRows
    .filter((r) => r.release_status !== "RELEASED" && r.release_status !== "FORFEITED")
    .reduce((s, r) => s + (Number(r.hold_amount || 0) - Number(r.released_amount || 0)), 0);

  const currentBalance = (balance.data?.balances ?? []).reduce((s, b) => s + Number(b.balance || 0), 0);

  const tiles = [
    { label: "Pay-ins today", value: formatAmount(todayPayin) },
    { label: "Pay-in count today", value: todayOrders.length },
    { label: "Current balance", value: formatAmount(currentBalance) },
    { label: "Reserves held", value: formatAmount(heldNow) },
  ];

  const recentCols: Column<Order>[] = [
    { key: "client_ref", header: "Ref" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "method", header: "Method" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="Live view of your account." icon={LayoutDashboard} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardHeader><CardDescription>{t.label}</CardDescription><CardTitle className="text-2xl">{t.value}</CardTitle></CardHeader>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle>Recent transactions</CardTitle><CardDescription>Most recent 10 orders.</CardDescription></CardHeader>
        <CardContent>
          <DataTable
            columns={recentCols}
            rows={orderRows.slice(0, 10)}
            loading={orders.isLoading}
            rowKey={(r) => r.id}
            emptyState="No transactions yet."
          />
        </CardContent>
      </Card>
    </>
  );
}
