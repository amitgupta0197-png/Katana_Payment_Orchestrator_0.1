"use client";

import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; currency: string; method: string; status: string; created_at: string;
}

export default function PayinOrderPage() {
  const q = useQuery({
    queryKey: ["payin-orders"],
    queryFn: async () => (await fetch("/api/checkout").then((r) => r.json())) as { orders: Order[] },
  });
  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref" },
    { key: "merchant_id", header: "Merchant" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "method", header: "Method" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Pay-in orders" description="All incoming order intake across merchants." icon={Receipt} />
      <Card><CardHeader><CardTitle>{(q.data?.orders ?? []).length} orders</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.orders ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No pay-in orders." /></CardContent>
      </Card>
    </>
  );
}
