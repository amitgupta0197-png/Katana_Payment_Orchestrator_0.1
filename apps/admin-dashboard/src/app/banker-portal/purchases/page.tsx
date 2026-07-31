"use client";

// Banker purchases — read-only view of the banker's own advance purchases and where
// each sits in the approval/funding lifecycle. Transitions stay admin/finance-side.

import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Purchase {
  id: string; quantity: number; buy_rate: number; total_amount: number;
  priority_percent: number; security_percent: number; status: string; payment_ref: string; created_at: string;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  DRAFT: "default", PENDING_APPROVAL: "info", AWAITING_FUNDS: "warning", FUNDS_SUBMITTED: "info",
  ACTIVE: "success", EXHAUSTED: "warning", SUSPENDED: "warning", REFILLED: "success", CLOSED: "default", REJECTED: "danger",
};

export default function BankerPurchasesPage() {
  const q = useQuery({
    queryKey: ["banker-purchases"],
    queryFn: async () => {
      const r = await fetch("/api/banker-portal/purchases");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.purchases as Purchase[];
    },
  });

  const cols: Column<Purchase>[] = [
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => <span className="font-medium">{formatAmount(r.total_amount)}</span> },
    { key: "split", header: "Rolling reserve", render: (r) => (
      <div className="flex flex-col leading-tight">
        <span className="font-medium">{formatAmount(r.total_amount * r.security_percent / 100)}</span>
        <span className="text-[10px] text-[color:var(--color-text-muted)]">quota {formatAmount(r.total_amount * r.priority_percent / 100)}</span>
      </div>
    ) },
    { key: "payment_ref", header: "Payment ref", render: (r) => r.payment_ref || "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Purchases" description="Your DT advance purchases and their approval/funding status." icon={Receipt} />
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        filters={[
          { key: "pending", label: "In progress", predicate: (r) => ["DRAFT", "PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED"].includes(r.status) },
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No purchases yet"
        emptyDescription="Your DT advance purchases will appear here once created."
      />
    </>
  );
}
