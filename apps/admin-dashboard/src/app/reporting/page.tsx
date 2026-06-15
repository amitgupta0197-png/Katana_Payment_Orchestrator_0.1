"use client";

import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface DailyRow { merchant_id: string; kind: string; status: string; day: string; currency: string; txn_count: number; gross_amount: number; fee_amount: number }
interface Fact { id: string; merchant_id: string; txn_id: string; kind: string; rail: string; method: string; amount: number; fee: number; currency: string; status: string; occurred_at: string }

export default function ReportingPage() {
  const q = useQuery({
    queryKey: ["reporting"],
    queryFn: async () => (await fetch("/api/reporting").then((r) => r.json())) as { daily: DailyRow[]; facts_recent: Fact[] },
  });
  const dCols: Column<DailyRow>[] = [
    { key: "day", header: "Day", render: (r) => formatDateTime(r.day) },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind" },
    { key: "status", header: "Status" },
    { key: "txn_count", header: "Count" },
    { key: "gross_amount", header: "Gross", render: (r) => formatAmount(r.gross_amount, r.currency) },
    { key: "fee_amount", header: "Fee", render: (r) => formatAmount(r.fee_amount, r.currency) },
  ];
  const fCols: Column<Fact>[] = [
    { key: "occurred_at", header: "When", render: (r) => formatDateTime(r.occurred_at) },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind" },
    { key: "rail", header: "Rail" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Reporting" description="Daily merchant roll-ups + recent transaction facts (PRODUCT_VISION §3.11)." icon={BarChart3} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Daily ({(q.data?.daily ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={dCols} rows={q.data?.daily ?? []} loading={q.isLoading} rowKey={(r, i) => `${r.merchant_id}-${r.day}-${i}`} emptyState="No daily rows." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent facts ({(q.data?.facts_recent ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={fCols} rows={q.data?.facts_recent ?? []} rowKey={(r) => r.id} emptyState="No fact rows." /></CardContent>
      </Card>
    </>
  );
}
