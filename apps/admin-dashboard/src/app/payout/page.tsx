"use client";

// L1 — gRPC payouts dispatch. DataView with status filter chips.

import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Payout {
  id: string; merchant_id: string; payout_ref?: string; beneficiary_vpa?: string;
  beneficiary_ifsc?: string; amount: number; currency: string; status: string; requested_at: string;
}

export default function PayoutPage() {
  const q = useQuery({
    queryKey: ["payouts"],
    queryFn: async () => (await fetch("/api/payout").then((r) => r.json())) as { payouts: Payout[] },
    refetchInterval: 30_000,
  });
  const rows = q.data?.payouts ?? [];

  const cols: Column<Payout>[] = [
    { key: "payout_ref", header: "Ref", render: (r) => r.payout_ref ? <span className="font-mono text-xs">{r.payout_ref}</span> : "—" },
    { key: "merchant_id", header: "Branch" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "beneficiary_vpa", header: "VPA", render: (r) => r.beneficiary_vpa ?? "—" },
    { key: "beneficiary_ifsc", header: "IFSC", render: (r) => r.beneficiary_ifsc ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Payouts (gRPC)" description="Per-vendor payout dispatch — internal gRPC service." icon={Send} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by ref / branch / VPA…", fields: ["payout_ref", "merchant_id", "beneficiary_vpa", "beneficiary_ifsc"] }}
        filters={[
          { key: "completed", label: "Completed", predicate: (r: Payout) => r.status === "COMPLETED" || r.status === "PAID" },
          { key: "pending",   label: "Pending",   predicate: (r: Payout) => r.status === "PENDING" || r.status === "PROCESSING" || r.status === "REQUESTED" },
          { key: "failed",    label: "Failed",    predicate: (r: Payout) => r.status === "FAILED" },
        ]}
        savedViewKey="payout-grpc" refresh={() => q.refetch()}
        emptyTitle="No payouts dispatched yet" />
    </>
  );
}
