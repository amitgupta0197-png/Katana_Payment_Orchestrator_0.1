"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, statusVariant } from "@/lib/utils";

interface Payout { id: string; merchant_id: string; amount: number; currency: string; status: string }

export default function PayoutDataPage() {
  const q = useQuery({
    queryKey: ["payout-data"],
    queryFn: async () => (await fetch("/api/payout").then((r) => r.json())) as { payouts: Payout[] },
  });
  const payouts = q.data?.payouts ?? [];
  const byStatus = new Map<string, { count: number; volume: number }>();
  for (const p of payouts) {
    const s = byStatus.get(p.status) ?? { count: 0, volume: 0 };
    s.count++; s.volume += Number(p.amount || 0); byStatus.set(p.status, s);
  }
  const rows = Array.from(byStatus, ([key, v]) => ({ key, ...v }));
  const cols: Column<typeof rows[number]>[] = [
    { key: "key", header: "Status", render: (r) => <Badge variant={statusVariant(r.key)}>{r.key}</Badge> },
    { key: "count", header: "Count" },
    { key: "volume", header: "Volume", render: (r) => formatAmount(r.volume) },
  ];
  return (
    <>
      <PageHeader title="Payout data" description="Aggregated payout metrics by status." icon={Activity} />
      <Card><CardHeader><CardTitle>{payouts.length} payouts aggregated</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={rows} loading={q.isLoading} rowKey={(r) => r.key} emptyState="No payouts." /></CardContent>
      </Card>
    </>
  );
}
