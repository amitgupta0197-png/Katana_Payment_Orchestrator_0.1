"use client";

// L1 — Quickpay vendor cockpit. Tabbed (Orders / Credentials).

import { useQuery } from "@tanstack/react-query";
import { CreditCard, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order { id: string; pay_id: string; order_id: string; amount: number; currency_code: string; channel: string; vendor_txn_id: string; rrn: string; response_code: string; status: string; created_at: string }
interface Credential { id: string; vendor: string; env: string; pay_id: string; active: boolean; created_at: string }

export default function QuickpayCockpit() {
  const q = useQuery({
    queryKey: ["vendor:quickpay"],
    queryFn: async () => (await fetch("/api/vendors/quickpay/payin").then((r) => r.json())) as { orders: Order[]; credentials: Credential[] },
  });
  const orders = q.data?.orders ?? [];
  const creds = q.data?.credentials ?? [];

  const cols: Column<Order>[] = [
    { key: "order_id", header: "Order", render: (r) => <span className="font-mono text-xs">{r.order_id}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency_code)}</span> },
    { key: "channel", header: "Channel" },
    { key: "vendor_txn_id", header: "Vendor txn", render: (r) => r.vendor_txn_id ? <span className="font-mono text-xs">{r.vendor_txn_id}</span> : "—" },
    { key: "rrn", header: "RRN", render: (r) => r.rrn || "—" },
    { key: "response_code", header: "Code" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];
  const credCols: Column<Credential>[] = [
    { key: "env", header: "Env" },
    { key: "pay_id", header: "Pay ID", render: (r) => <span className="font-mono text-xs">{r.pay_id}</span> },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Quickpay cockpit" description="Sandbox dispatcher + production observability (PRODUCT_VISION §3.6)." icon={CreditCard} />
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{orders.length}</span>
          </TabsTrigger>
          <TabsTrigger value="creds"><KeyRound className="h-3.5 w-3.5" /> Credentials
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{creds.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="orders">
          <DataView rows={orders} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by order / RRN / vendor txn…", fields: ["order_id", "vendor_txn_id", "rrn", "channel"] }}
            filters={[
              { key: "success", label: "Success", predicate: (r: Order) => r.status === "SUCCEEDED" || r.status === "SUCCESS" },
              { key: "failed",  label: "Failed",  predicate: (r: Order) => r.status === "FAILED" },
              { key: "pending", label: "Pending", predicate: (r: Order) => r.status === "PENDING" || r.status === "INITIATED" },
            ]}
            savedViewKey="vendor-quickpay" refresh={() => q.refetch()}
            emptyTitle="No Quickpay orders yet" />
        </TabsContent>
        <TabsContent value="creds">
          <DataView rows={creds} columns={credCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by env / pay id…", fields: ["env", "pay_id"] }}
            savedViewKey="vendor-quickpay-creds"
            emptyTitle="No credentials configured" />
        </TabsContent>
      </Tabs>
    </>
  );
}
