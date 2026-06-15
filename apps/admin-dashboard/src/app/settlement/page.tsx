"use client";

import { useQuery } from "@tanstack/react-query";
import { Banknote } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Batch {
  id: string; merchant_id: string; period_start: string; period_end: string;
  txn_count: number; gross_amount: number; fee_amount: number; net_payable: number;
  currency: string; status: string; created_at: string;
}

export default function SettlementPage() {
  const q = useQuery({
    queryKey: ["settlement"],
    queryFn: async () => (await fetch("/api/settlement/batches").then((r) => r.json())) as { batches: Batch[] },
  });
  const cols: Column<Batch>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "period_start", header: "Period", render: (r) => `${formatDateTime(r.period_start)} → ${formatDateTime(r.period_end)}` },
    { key: "txn_count", header: "Txns" },
    { key: "gross_amount", header: "Gross", render: (r) => formatAmount(r.gross_amount, r.currency) },
    { key: "fee_amount", header: "Fees", render: (r) => formatAmount(r.fee_amount, r.currency) },
    { key: "net_payable", header: "Net", render: (r) => formatAmount(r.net_payable, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Settlements" description="Per-merchant settlement batches." icon={Banknote} />
      <Card><CardHeader><CardTitle>{(q.data?.batches ?? []).length} batches</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.batches ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No settlement batches." /></CardContent>
      </Card>
    </>
  );
}
