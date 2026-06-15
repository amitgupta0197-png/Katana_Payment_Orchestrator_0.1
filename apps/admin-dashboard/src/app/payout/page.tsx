"use client";

import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Payout {
  id: string; merchant_id: string; payout_ref?: string; beneficiary_vpa?: string;
  beneficiary_ifsc?: string; amount: number; currency: string; status: string; requested_at: string;
}

export default function PayoutPage() {
  const q = useQuery({
    queryKey: ["payouts"],
    queryFn: async () => (await fetch("/api/payout").then((r) => r.json())) as { payouts: Payout[] },
  });
  const cols: Column<Payout>[] = [
    { key: "payout_ref", header: "Ref", render: (r) => r.payout_ref ?? "—" },
    { key: "merchant_id", header: "Merchant" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "beneficiary_vpa", header: "VPA", render: (r) => r.beneficiary_vpa ?? "—" },
    { key: "beneficiary_ifsc", header: "IFSC", render: (r) => r.beneficiary_ifsc ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
  ];
  return (
    <>
      <PageHeader title="Payouts (gRPC)" description="Per-vendor payout dispatch — internal gRPC service." icon={Send} />
      <Card><CardHeader><CardTitle>{(q.data?.payouts ?? []).length} dispatched</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.payouts ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No payouts." /></CardContent>
      </Card>
    </>
  );
}
