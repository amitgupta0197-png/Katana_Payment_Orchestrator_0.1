"use client";

// L1 — payout orders. DataView with KPI strip + status filter chips.

import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Payout {
  id: string; tenant_id: string; merchant_id: string; payout_ref?: string;
  beneficiary_vpa?: string; beneficiary_ifsc?: string; amount: number; currency: string;
  status: string; requested_at: string; completed_at?: string;
}

export default function PayoutOrderPage() {
  const q = useQuery({
    queryKey: ["payout-orders"],
    queryFn: async () => (await fetch("/api/payout").then((r) => r.json())) as { payouts: Payout[] },
    refetchInterval: 30_000,
  });
  const rows = q.data?.payouts ?? [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayPayouts = rows.filter((p) => new Date(p.requested_at).getTime() >= today.getTime());
  const todaySum = todayPayouts.reduce((s, p) => s + Number(p.amount || 0), 0);
  const pending = rows.filter((p) => p.status === "PENDING" || p.status === "PROCESSING" || p.status === "REQUESTED").length;
  const failed = rows.filter((p) => p.status === "FAILED").length;

  const cols: Column<Payout>[] = [
    { key: "payout_ref", header: "Ref", render: (r) => r.payout_ref ? <span className="font-mono text-xs">{r.payout_ref}</span> : "—" },
    { key: "merchant_id", header: "Merchant" },
    { key: "beneficiary_vpa", header: "Beneficiary", render: (r) => r.beneficiary_vpa ?? "—" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "completed_at", header: "Completed", render: (r) => r.completed_at ? <span className="text-xs">{formatDateTime(r.completed_at)}</span> : "—" },
  ];

  return (
    <>
      <PageHeader title="Payout orders" description="Outbound payout history (PRODUCT_VISION §3.11)." icon={Send} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Today total" value={todayPayouts.length} loading={q.isLoading} />
        <KpiTile label="Today gross" value={formatAmount(todaySum)} loading={q.isLoading} />
        <KpiTile label="Pending" value={pending} variant={pending > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Failed" value={failed} variant={failed > 0 ? "danger" : "default"} loading={q.isLoading} />
      </div>
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by ref, merchant, VPA, IFSC…", fields: ["payout_ref", "merchant_id", "beneficiary_vpa", "beneficiary_ifsc"] }}
        filters={[
          { key: "completed", label: "Completed", predicate: (r: Payout) => r.status === "COMPLETED" || r.status === "PAID" },
          { key: "pending",   label: "Pending",   predicate: (r: Payout) => r.status === "PENDING" || r.status === "PROCESSING" || r.status === "REQUESTED" },
          { key: "failed",    label: "Failed",    predicate: (r: Payout) => r.status === "FAILED" },
          { key: "today",     label: "Today",     predicate: (r: Payout) => new Date(r.requested_at).getTime() >= today.getTime() },
        ]}
        savedViewKey="payout-order"
        refresh={() => q.refetch()}
        emptyTitle="No payouts yet"
        emptyDescription="Outbound disbursements appear here as soon as they're requested."
      />
    </>
  );
}
