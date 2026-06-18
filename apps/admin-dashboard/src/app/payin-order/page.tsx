"use client";

// L1 — pay-in orders. DataView with status + method filter chips.

import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; currency: string; method: string; status: string; created_at: string;
}

export default function PayinOrderPage() {
  const q = useQuery({
    queryKey: ["payin-orders"],
    queryFn: async () => (await fetch("/api/checkout").then((r) => r.json())) as { orders: Order[] },
    refetchInterval: 30_000,
  });
  const rows = q.data?.orders ?? [];
  const methods = Array.from(new Set(rows.map((o) => o.method))).slice(0, 5);

  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/checkout/${r.id}`}>{r.client_ref}</Link> },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "method", header: "Method" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Pay-in orders" description="All incoming order intake across merchants." icon={Receipt} />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/checkout/${r.id}`}
        search={{ placeholder: "Search by ref, txn, merchant…", fields: ["client_ref", "txn_id", "merchant_id", "method"] }}
        filters={[
          { key: "succeeded", label: "Succeeded", predicate: (r: Order) => r.status === "SUCCEEDED" },
          { key: "failed",    label: "Failed",    predicate: (r: Order) => r.status === "FAILED" || r.status === "EXPIRED" },
          { key: "pending",   label: "Pending",   predicate: (r: Order) => r.status === "PENDING" || r.status === "INITIATED" },
          ...methods.map((m) => ({ key: `m-${m}`, label: m, predicate: (r: Order) => r.method === m })),
        ]}
        savedViewKey="payin-order"
        refresh={() => q.refetch()}
        emptyTitle="No pay-in orders yet"
      />
    </>
  );
}
