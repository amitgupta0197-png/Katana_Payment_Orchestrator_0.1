"use client";

// L1 — aggregated pay-in metrics. Tabs (By status / By method).

import { useQuery } from "@tanstack/react-query";
import { Activity, ListFilter, Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; amount: number; currency: string; method: string;
  status: string; created_at: string;
}

export default function PayinDataPage() {
  const q = useQuery({
    queryKey: ["payin-data"],
    queryFn: async () => (await fetch("/api/checkout").then((r) => r.json())) as { orders: Order[] },
  });
  const orders = q.data?.orders ?? [];

  const byStatus = new Map<string, { count: number; volume: number }>();
  const byMethod = new Map<string, { count: number; volume: number }>();
  let totalVol = 0;
  for (const o of orders) {
    const amt = Number(o.amount || 0);
    totalVol += amt;
    const s = byStatus.get(o.status) ?? { count: 0, volume: 0 };
    s.count++; s.volume += amt; byStatus.set(o.status, s);
    const m = byMethod.get(o.method) ?? { count: 0, volume: 0 };
    m.count++; m.volume += amt; byMethod.set(o.method, m);
  }
  const statusRows = Array.from(byStatus, ([key, v]) => ({ key, ...v }));
  const methodRows = Array.from(byMethod, ([key, v]) => ({ key, ...v }));

  const sCols: Column<typeof statusRows[number]>[] = [
    { key: "key", header: "Status", render: (r) => <Badge variant={statusVariant(r.key)}>{r.key}</Badge> },
    { key: "count", header: "Count", render: (r) => <span className="tabular-nums">{r.count}</span> },
    { key: "volume", header: "Volume", render: (r) => <span className="tabular-nums">{formatAmount(r.volume)}</span> },
  ];
  const mCols: Column<typeof methodRows[number]>[] = [
    { key: "key", header: "Method" },
    { key: "count", header: "Count", render: (r) => <span className="tabular-nums">{r.count}</span> },
    { key: "volume", header: "Volume", render: (r) => <span className="tabular-nums">{formatAmount(r.volume)}</span> },
  ];

  return (
    <>
      <PageHeader title="Pay-in data" description="Aggregated pay-in metrics by status + method." icon={Activity} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile label="Orders" value={orders.length} loading={q.isLoading} />
        <KpiTile label="Total volume" value={formatAmount(totalVol)} loading={q.isLoading} />
        <KpiTile label="Methods" value={methodRows.length} loading={q.isLoading} />
      </div>
      <Tabs defaultValue="status">
        <TabsList>
          <TabsTrigger value="status"><ListFilter className="h-3.5 w-3.5" /> By status</TabsTrigger>
          <TabsTrigger value="method"><Network className="h-3.5 w-3.5" /> By method</TabsTrigger>
        </TabsList>
        <TabsContent value="status">
          <DataView rows={statusRows} columns={sCols} rowKey={(r) => r.key} loading={q.isLoading}
            savedViewKey="payin-data-status" emptyTitle="No orders to aggregate" />
        </TabsContent>
        <TabsContent value="method">
          <DataView rows={methodRows} columns={mCols} rowKey={(r) => r.key}
            savedViewKey="payin-data-method" emptyTitle="No orders to aggregate" />
        </TabsContent>
      </Tabs>
    </>
  );
}
