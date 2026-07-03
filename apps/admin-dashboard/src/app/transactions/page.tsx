"use client";

// Universal transactions — one normalized list across every channel
// (PoolPay/Quickpay payins + PayU/Cashfree/Razorpay checkouts) in the canonical
// §4 shape. Backed by /api/v1/transactions.

import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";

interface Txn {
  katana_order_id: string; source: string; provider: string; provider_txn_id: string;
  status: string; utr: string | null; amount: number; currency: string; method: string;
  merchant_id: string; sub_mid: string | null; created_at: string;
}

const STATUSES = ["INITIATED", "PENDING", "AWAITING_CONFIRMATION", "SUCCESS", "FAILED", "EXPIRED", "MISMATCH", "MANUAL_REVIEW"];

export default function TransactionsPage() {
  const q = useQuery({
    queryKey: ["universal-txns"],
    queryFn: async () => (await fetch("/api/v1/transactions").then((r) => r.json())) as { transactions: Txn[]; total: number },
    refetchInterval: 20_000,
  });
  const txns = q.data?.transactions ?? [];

  const cols: Column<Txn>[] = [
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id || "—"}</span> },
    { key: "provider", header: "Provider / channel", render: (r) => <Badge variant="brand">{railLabel(r.provider)}</Badge> },
    { key: "method", header: "Method", render: (r) => r.method || "—" },
    { key: "sub_mid", header: "Sub-MID", render: (r) => r.sub_mid ? <Badge variant="info">{r.sub_mid}</Badge> : "—" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "utr", header: "UTR/RRN", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : "—" },
    { key: "provider_txn_id", header: "Provider txn", render: (r) => r.provider_txn_id ? <span className="font-mono text-xs">{r.provider_txn_id}</span> : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Transactions (universal)"
        description="One normalized view across all channels — Katana Pay, Quickpay, PayU, Cashfree, Razorpay. Canonical katana_order_id · provider · UTR · status."
        icon={Receipt}
      />
      <DataView
        rows={txns}
        columns={cols}
        rowKey={(r) => `${r.source}:${r.katana_order_id}`}
        loading={q.isLoading}
        search={{ placeholder: "Search order id / provider txn / UTR / branch / sub-MID…", fields: ["katana_order_id", "provider_txn_id", "utr", "merchant_id", "sub_mid", "provider"] }}
        filters={STATUSES.map((st) => ({ key: st, label: st, predicate: (r: Txn) => r.status === st }))}
        savedViewKey="universal-txns"
        refresh={() => q.refetch()}
        emptyTitle="No transactions yet"
        emptyDescription="Pay-ins and checkouts across every channel will appear here."
      />
    </>
  );
}
