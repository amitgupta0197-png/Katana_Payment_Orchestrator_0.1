"use client";

import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface DailyRow {
  tenant_id: string; merchant_id: string; kind: string; status: string;
  day: string; currency: string; txn_count: number; gross_amount: number; fee_amount: number;
}

export default function SummaryPage() {
  const q = useQuery({
    queryKey: ["summary"],
    queryFn: async () => (await fetch("/api/reporting").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { daily: DailyRow[] },
  });

  const daily = q.data?.daily ?? [];
  const totalTxn = daily.reduce((s, r) => s + Number(r.txn_count || 0), 0);
  const totalGross = daily.reduce((s, r) => s + Number(r.gross_amount || 0), 0);
  const totalFee = daily.reduce((s, r) => s + Number(r.fee_amount || 0), 0);

  const cols: Column<DailyRow>[] = [
    { key: "day", header: "Day", render: (r) => formatDateTime(r.day) },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind" },
    { key: "status", header: "Status" },
    { key: "txn_count", header: "Txns" },
    { key: "gross_amount", header: "Gross", render: (r) => formatAmount(r.gross_amount, r.currency) },
    { key: "fee_amount", header: "Fee", render: (r) => formatAmount(r.fee_amount, r.currency) },
  ];

  return (
    <>
      <PageHeader title="Summary" description="Platform-wide roll-up of pay-in volume by day + merchant." icon={BarChart3} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
        <Card><CardHeader><CardDescription>Total transactions</CardDescription><CardTitle className="text-2xl">{totalTxn}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Total gross</CardDescription><CardTitle className="text-2xl">{formatAmount(totalGross)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Total fees</CardDescription><CardTitle className="text-2xl">{formatAmount(totalFee)}</CardTitle></CardHeader></Card>
      </div>
      <Card><CardHeader><CardTitle>Daily breakdown</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={daily} loading={q.isLoading} rowKey={(r, i) => `${r.merchant_id}-${r.day}-${i}`} emptyState="No reporting data yet." /></CardContent>
      </Card>
    </>
  );
}
