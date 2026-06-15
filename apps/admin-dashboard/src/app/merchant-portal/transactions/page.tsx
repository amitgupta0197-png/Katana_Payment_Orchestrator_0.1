"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; client_ref: string; txn_id?: string; amount: number; currency: string;
  method: string; selected_rail?: string; status: string; created_at: string;
}

const STATUSES = ["", "INITIATED", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED", "REFUNDED", "CHARGEBACK"] as const;

export default function TransactionsPage() {
  const [status, setStatus] = useState<string>("");
  const q = useQuery({
    queryKey: ["mp:orders", status],
    queryFn: async () => {
      const url = status ? `/api/checkout?status=${status}` : "/api/checkout";
      return (await fetch(url).then((r) => r.json())) as { orders: Order[] };
    },
  });

  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref" },
    { key: "txn_id", header: "TXN ID", render: (r) => r.txn_id ?? "—" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "method", header: "Method" },
    { key: "selected_rail", header: "Rail", render: (r) => r.selected_rail ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Transactions" description="Your pay-in order history." icon={Receipt} />
      <Card className="mb-4">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <select
                className="flex h-9 w-48 rounded-md border px-3 py-1 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{s || "(any)"}</option>)}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{(q.data?.orders ?? []).length} orders</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.orders ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No transactions match this filter."
          />
        </CardContent>
      </Card>
    </>
  );
}
