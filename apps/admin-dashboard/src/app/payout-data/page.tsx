"use client";

// L1 — aggregated payout metrics by status.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, statusVariant } from "@/lib/utils";

interface Payout { id: string; merchant_id: string; amount: number; currency: string; status: string }

export default function PayoutDataPage() {
  const q = useQuery({
    queryKey: ["payout-data"],
    queryFn: async () => (await fetch("/api/payout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { payouts: Payout[] },
  });
  const payouts = q.data?.payouts ?? [];
  const byStatus = new Map<string, { count: number; volume: number }>();
  let totalVol = 0;
  for (const p of payouts) {
    const amt = Number(p.amount || 0);
    totalVol += amt;
    const s = byStatus.get(p.status) ?? { count: 0, volume: 0 };
    s.count++; s.volume += amt; byStatus.set(p.status, s);
  }
  const rows = Array.from(byStatus, ([key, v]) => ({ key, ...v }));
  const cols: Column<typeof rows[number]>[] = [
    { key: "key", header: "Status", render: (r) => <Badge variant={statusVariant(r.key)}>{r.key}</Badge> },
    { key: "count", header: "Count", render: (r) => <span className="tabular-nums">{r.count}</span> },
    { key: "volume", header: "Volume", render: (r) => <span className="tabular-nums">{formatAmount(r.volume)}</span> },
  ];
  return (
    <>
      <PageHeader title="Payout data" description="Aggregated payout metrics by status." icon={Activity} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-2">
        <KpiTile label="Payouts" value={payouts.length} loading={q.isLoading} />
        <KpiTile label="Total volume" value={formatAmount(totalVol)} loading={q.isLoading} />
      </div>
      <DataView rows={rows} columns={cols} rowKey={(r) => r.key} loading={q.isLoading}
        savedViewKey="payout-data" emptyTitle="No payouts to aggregate" />
    </>
  );
}
