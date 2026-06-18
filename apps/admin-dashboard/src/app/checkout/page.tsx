"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; currency: string; method: string; selected_rail?: string;
  status: string; created_at: string;
}

const STATUSES = ["", "INITIATED", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED", "REFUNDED", "CHARGEBACK"] as const;

export default function CheckoutPage() {
  const [status, setStatus] = useState<string>("");
  const q = useQuery({
    queryKey: ["checkout", status],
    queryFn: async () => (await fetch(status ? `/api/checkout?status=${status}` : "/api/checkout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[] },
  });

  const cols: Column<Order>[] = [
    {
      key: "client_ref", header: "Ref",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/checkout/${r.id}`}>{r.client_ref}</Link>,
    },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    {
      key: "txn_id", header: "TXN",
      render: (r) => r.txn_id ? <Link className="font-mono text-xs hover:underline" href={`/checkout/${r.id}`}>{r.txn_id}</Link> : "—",
    },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "method", header: "Method" },
    { key: "selected_rail", header: "Rail", render: (r) => r.selected_rail ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Checkout" description="Universal pay-in orchestration (PRODUCT_VISION §3.5)." icon={CreditCard} />
      <Card className="mb-4">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <select className="flex h-9 w-48 rounded-md border px-3 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s || "(any)"}</option>)}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{(q.data?.orders ?? []).length} orders</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={q.data?.orders ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No orders." />
        </CardContent>
      </Card>
    </>
  );
}
