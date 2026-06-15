"use client";

import { useQuery } from "@tanstack/react-query";
import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface KybCase {
  id: string; merchant_id: string; status: string; risk_tier?: string;
  opened_at: string; decided_at?: string; decided_by: string;
  screening_hits: number; doc_count: number;
}

export default function KybPage() {
  const q = useQuery({
    queryKey: ["kyb:admin"],
    queryFn: async () => (await fetch("/api/kyb").then((r) => r.json())) as { cases: KybCase[] },
  });
  const cols: Column<KybCase>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "doc_count", header: "Docs" },
    { key: "screening_hits", header: "Hits" },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "decided_at", header: "Decided", render: (r) => r.decided_at ? formatDateTime(r.decided_at) : "—" },
  ];
  return (
    <>
      <PageHeader title="KYB" description="Payments-specific KYB cases (PRODUCT_VISION §3.10)." icon={FileCheck2} />
      <Card><CardHeader><CardTitle>{(q.data?.cases ?? []).length} cases</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.cases ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No KYB cases." /></CardContent>
      </Card>
    </>
  );
}
