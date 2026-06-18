"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; amount: number; currency: string; method: string;
  status: string; created_at: string;
}

export default function PayinDataPage() {
  const q = useQuery({
    queryKey: ["payin-data"],
    queryFn: async () => (await fetch("/api/checkout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[] },
  });
  const orders = q.data?.orders ?? [];

  const byStatus = new Map<string, { count: number; volume: number }>();
  const byMethod = new Map<string, { count: number; volume: number }>();
  for (const o of orders) {
    const s = byStatus.get(o.status) ?? { count: 0, volume: 0 };
    s.count++; s.volume += Number(o.amount || 0); byStatus.set(o.status, s);
    const m = byMethod.get(o.method) ?? { count: 0, volume: 0 };
    m.count++; m.volume += Number(o.amount || 0); byMethod.set(o.method, m);
  }
  const statusRows = Array.from(byStatus, ([key, v]) => ({ key, ...v }));
  const methodRows = Array.from(byMethod, ([key, v]) => ({ key, ...v }));

  const sCols: Column<typeof statusRows[number]>[] = [
    { key: "key", header: "Status", render: (r) => <Badge variant={statusVariant(r.key)}>{r.key}</Badge> },
    { key: "count", header: "Count" },
    { key: "volume", header: "Volume", render: (r) => formatAmount(r.volume) },
  ];
  const mCols: Column<typeof methodRows[number]>[] = [
    { key: "key", header: "Method" },
    { key: "count", header: "Count" },
    { key: "volume", header: "Volume", render: (r) => formatAmount(r.volume) },
  ];

  return (
    <>
      <PageHeader title="Pay-in data" description="Aggregated pay-in metrics by status + method." icon={Activity} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>By status</CardTitle><CardDescription>{orders.length} orders aggregated</CardDescription></CardHeader>
          <CardContent><DataTable columns={sCols} rows={statusRows} loading={q.isLoading} rowKey={(r) => r.key} emptyState="No orders." /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By method</CardTitle></CardHeader>
          <CardContent><DataTable columns={mCols} rows={methodRows} rowKey={(r) => r.key} emptyState="No orders." /></CardContent>
        </Card>
      </div>
    </>
  );
}
