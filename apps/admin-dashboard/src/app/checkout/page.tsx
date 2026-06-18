"use client";

// L1 — checkout orders. World-class DataView with status filter chips
// (succeeded / failed / pending / refunded / chargeback), search by
// ref/txn/merchant. KPI strip shows volume, success rate, gross.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; currency: string; method: string; selected_rail?: string;
  status: string; created_at: string;
}

export default function CheckoutPage() {
  const q = useQuery({
    queryKey: ["checkout"],
    queryFn: async () => (await fetch("/api/checkout").then((r) => r.json())) as { orders: Order[] },
    refetchInterval: 15_000,
  });
  const orders = q.data?.orders ?? [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayOrders = orders.filter((o) => new Date(o.created_at).getTime() >= today.getTime());
  const failed = todayOrders.filter((o) => o.status === "FAILED" || o.status === "EXPIRED" || o.status === "CANCELLED").length;
  const success = todayOrders.filter((o) => o.status === "SUCCEEDED").length;
  const successRate = todayOrders.length > 0 ? Math.round(((todayOrders.length - failed) / todayOrders.length) * 1000) / 10 : null;
  const grossToday = todayOrders.filter((o) => o.status === "SUCCEEDED").reduce((s, o) => s + Number(o.amount || 0), 0);

  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/checkout/${r.id}`}>{r.client_ref}</Link> },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "txn_id", header: "TXN",
      render: (r) => r.txn_id ? <Link className="font-mono text-xs hover:underline" href={`/checkout/${r.id}`}>{r.txn_id}</Link> : "—" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "method", header: "Method" },
    { key: "selected_rail", header: "Rail", render: (r) => r.selected_rail ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Checkout"
        description="Universal pay-in orchestration (PRODUCT_VISION §3.5)."
        icon={CreditCard}
        actions={<Badge variant={q.isFetching ? "info" : "default"}><RefreshCw className="h-3 w-3 mr-1" />live · 15s</Badge>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Today total" value={todayOrders.length} sublabel={`${success} succeeded`} loading={q.isLoading} />
        <KpiTile label="Today gross" value={formatAmount(grossToday)} loading={q.isLoading} />
        <KpiTile label="Success rate" value={successRate === null ? "—" : `${successRate}%`} sublabel={`${failed} failed`} variant={successRate === null ? "default" : successRate >= 99 ? "success" : successRate >= 95 ? "default" : successRate >= 90 ? "warning" : "danger"} loading={q.isLoading} />
        <KpiTile label="All orders" value={orders.length} loading={q.isLoading} />
      </div>

      <DataView
        rows={orders}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/checkout/${r.id}`}
        search={{ placeholder: "Search by ref, txn, merchant…", fields: ["client_ref", "txn_id", "merchant_id", "method"] }}
        filters={[
          { key: "succeeded", label: "Succeeded", predicate: (r: Order) => r.status === "SUCCEEDED" },
          { key: "failed",    label: "Failed",    predicate: (r: Order) => r.status === "FAILED" || r.status === "EXPIRED" || r.status === "CANCELLED" },
          { key: "pending",   label: "Pending",   predicate: (r: Order) => r.status === "PENDING" || r.status === "INITIATED" },
          { key: "refunded",  label: "Refunded",  predicate: (r: Order) => r.status === "REFUNDED" },
          { key: "chargeback", label: "Chargeback", predicate: (r: Order) => r.status === "CHARGEBACK" },
          { key: "today",     label: "Today",     predicate: (r: Order) => new Date(r.created_at).getTime() >= today.getTime() },
        ]}
        savedViewKey="checkout"
        refresh={() => q.refetch()}
        emptyTitle="No orders yet"
        emptyDescription="Trigger a payment from the merchant SDK to see it here in real time."
      />
    </>
  );
}
