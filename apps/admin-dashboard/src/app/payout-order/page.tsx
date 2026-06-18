"use client";

import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Payout {
  id: string; tenant_id: string; merchant_id: string; payout_ref?: string;
  beneficiary_vpa?: string; beneficiary_ifsc?: string; amount: number; currency: string;
  status: string; requested_at: string; completed_at?: string;
}

export default function PayoutOrderPage() {
  const q = useQuery({
    queryKey: ["payout-orders"],
    queryFn: async () => (await fetch("/api/payout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { payouts: Payout[] },
  });
  const cols: Column<Payout>[] = [
    { key: "payout_ref", header: "Ref", render: (r) => r.payout_ref ?? "—" },
    { key: "merchant_id", header: "Merchant" },
    { key: "beneficiary_vpa", header: "Bene VPA", render: (r) => r.beneficiary_vpa ?? "—" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
  ];
  return (
    <>
      <PageHeader title="Payout orders" description="Outbound payout history (PRODUCT_VISION §3.11)." icon={Send} />
      <Card><CardHeader><CardTitle>{(q.data?.payouts ?? []).length} payouts</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.payouts ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No payouts." /></CardContent>
      </Card>
    </>
  );
}
