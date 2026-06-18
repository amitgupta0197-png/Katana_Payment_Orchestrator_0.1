"use client";

// L1 — platform summary. KPI strip + DataView of daily roll-ups.

import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface DailyRow {
  tenant_id: string; merchant_id: string; kind: string; status: string;
  day: string; currency: string; txn_count: number; gross_amount: number; fee_amount: number;
}

export default function SummaryPage() {
  const q = useQuery({
    queryKey: ["summary"],
    queryFn: async () => (await fetch("/api/reporting").then((r) => r.json())) as { daily: DailyRow[] },
  });
  const daily = q.data?.daily ?? [];
  const totalTxn = daily.reduce((s, r) => s + Number(r.txn_count || 0), 0);
  const totalGross = daily.reduce((s, r) => s + Number(r.gross_amount || 0), 0);
  const totalFee = daily.reduce((s, r) => s + Number(r.fee_amount || 0), 0);

  const cols: Column<DailyRow>[] = [
    { key: "day", header: "Day", render: (r) => <span className="text-xs">{formatDateTime(r.day)}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "txn_count", header: "Txns", render: (r) => <span className="tabular-nums">{r.txn_count}</span> },
    { key: "gross_amount", header: "Gross", render: (r) => <span className="tabular-nums">{formatAmount(r.gross_amount, r.currency)}</span> },
    { key: "fee_amount", header: "Fee", render: (r) => <span className="tabular-nums">{formatAmount(r.fee_amount, r.currency)}</span> },
  ];

  return (
    <>
      <PageHeader title="Summary" description="Platform-wide roll-up of pay-in volume by day + merchant." icon={BarChart3} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile label="Total transactions" value={totalTxn} loading={q.isLoading} />
        <KpiTile label="Total gross" value={formatAmount(totalGross)} loading={q.isLoading} />
        <KpiTile label="Total fees" value={formatAmount(totalFee)} loading={q.isLoading} />
      </div>
      <DataView rows={daily} columns={cols} rowKey={(r) => `${r.merchant_id}|${r.day}|${r.kind}|${r.status}|${r.currency}`} loading={q.isLoading}
        search={{ placeholder: "Search by merchant / kind / status…", fields: ["merchant_id", "kind", "status"] }}
        savedViewKey="summary" refresh={() => q.refetch()}
        emptyTitle="No reporting data yet" />
    </>
  );
}
