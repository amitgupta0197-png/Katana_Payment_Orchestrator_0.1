"use client";

import { useQuery } from "@tanstack/react-query";
import { Banknote } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Batch {
  id: string; batch_date: string; gross_amount: number; fees_amount: number; net_amount: number;
  utr?: string; payout_ref?: string; status: string; txn_count: number;
}

export default function SettlementsPage() {
  const q = useQuery({
    queryKey: ["mp:settlements"],
    queryFn: async () => (await fetch("/api/settlement/batches").then((r) => r.json())) as { batches: Batch[] },
  });

  const cols: Column<Batch>[] = [
    { key: "batch_date", header: "Batch date", render: (r) => formatDateTime(r.batch_date) },
    { key: "txn_count", header: "Txns" },
    { key: "gross_amount", header: "Gross", render: (r) => formatAmount(r.gross_amount) },
    { key: "fees_amount", header: "Fees", render: (r) => formatAmount(r.fees_amount) },
    { key: "net_amount", header: "Net", render: (r) => formatAmount(r.net_amount) },
    { key: "utr", header: "UTR", render: (r) => <span className="font-mono text-xs">{r.utr ?? "—"}</span> },
    { key: "payout_ref", header: "Payout ref", render: (r) => <span className="font-mono text-xs">{r.payout_ref ?? "—"}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Settlements" description="Your settlement batches pulled from the payout partner." icon={Banknote} />
      <Card>
        <CardHeader><CardTitle>{(q.data?.batches ?? []).length} batches</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.batches ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No settlement batches yet."
          />
        </CardContent>
      </Card>
    </>
  );
}
