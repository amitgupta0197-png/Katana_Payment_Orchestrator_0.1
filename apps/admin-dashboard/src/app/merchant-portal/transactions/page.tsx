"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; client_ref: string; txn_id?: string; amount: number; currency: string;
  method: string; selected_rail?: string; status: string; created_at: string;
}

const STATUSES = ["", "PENDING", "SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "INITIATED", "CANCELLED", "REFUNDED", "CHARGEBACK"] as const;

export default function TransactionsPage() {
  const [status, setStatus] = useState<string>("");

  // The merchant's own row (id + code) — needed to fetch Katana Pay pay-ins, which
  // are keyed by merchant code, not the session UUID.
  const meQ = useQuery({
    queryKey: ["mp:me"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: { id: string; merchant_code: string }[] },
  });
  const meId = meQ.data?.merchants?.[0]?.id;

  // Checkout-gateway orders (filtered client-side below so both rails share one filter).
  const checkoutQ = useQuery({
    queryKey: ["mp:orders"],
    queryFn: async () => (await fetch("/api/checkout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[] },
  });

  // Katana Pay (PoolPay) pay-ins for this merchant.
  const payinQ = useQuery({
    queryKey: ["mp:payins", meId],
    enabled: !!meId,
    queryFn: async () => (await fetch(`/api/merchants/${meId}/payin-orders`).then((r) => r.json())) as { all: Array<{ id: string; order_id: string; amount: number; currency_code: string; status: string; rrn?: string; mode?: string; active_vpa?: string | null; created_at: string }> },
  });

  const payinRows: Order[] = (payinQ.data?.all ?? []).map((p) => ({
    id: p.id, client_ref: p.order_id, txn_id: p.rrn || undefined,
    amount: Number(p.amount || 0), currency: p.currency_code || "INR",
    method: p.mode === "QR" ? "UPI QR" : "UPI Intent", selected_rail: "Katana Pay",
    status: p.status, created_at: p.created_at,
  }));

  const all = [...(checkoutQ.data?.orders ?? []), ...payinRows]
    .filter((o) => !status || o.status === status)
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const loading = checkoutQ.isLoading || payinQ.isLoading;

  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref", render: (r) => <span className="font-mono text-xs">{r.client_ref}</span> },
    { key: "txn_id", header: "UTR / TXN", render: (r) => r.txn_id ? <span className="font-mono text-xs">{r.txn_id}</span> : "—" },
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
        <CardHeader><CardTitle>{all.length} orders</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={all}
            loading={loading}
            rowKey={(r) => r.id}
            emptyState="No transactions match this filter."
          />
        </CardContent>
      </Card>
    </>
  );
}
