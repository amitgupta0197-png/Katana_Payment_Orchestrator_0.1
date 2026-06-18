"use client";

import { useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order { id: string; pay_id: string; order_id: string; amount: number; currency_code: string; channel: string; vendor_txn_id: string; rrn: string; response_code: string; status: string; created_at: string }
interface Credential { id: string; vendor: string; env: string; pay_id: string; active: boolean; created_at: string }

export default function QuickpayCockpit() {
  const q = useQuery({
    queryKey: ["vendor:quickpay"],
    queryFn: async () => (await fetch("/api/vendors/quickpay/payin").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[]; credentials: Credential[] },
  });
  const cols: Column<Order>[] = [
    { key: "order_id", header: "Order" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency_code) },
    { key: "channel", header: "Channel" },
    { key: "vendor_txn_id", header: "Vendor txn", render: (r) => r.vendor_txn_id || "—" },
    { key: "rrn", header: "RRN", render: (r) => r.rrn || "—" },
    { key: "response_code", header: "Code" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  const credCols: Column<Credential>[] = [
    { key: "env", header: "Env" },
    { key: "pay_id", header: "Pay ID" },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Quickpay cockpit" description="Sandbox dispatcher + production observability (PRODUCT_VISION §3.6)." icon={CreditCard} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Credentials ({(q.data?.credentials ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={credCols} rows={q.data?.credentials ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No credentials." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent pay-in orders ({(q.data?.orders ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.orders ?? []} rowKey={(r) => r.id} emptyState="No orders." /></CardContent>
      </Card>
    </>
  );
}
