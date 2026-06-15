"use client";

import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  business_type?: string; contact_email: string; stage: string; risk_tier?: string;
  created_at: string;
}
interface FunnelRow { stage: string; n: number }

export default function MerchantsPage() {
  const q = useQuery({
    queryKey: ["merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: Merchant[]; funnel: FunnelRow[] },
  });

  const cols: Column<Merchant>[] = [
    { key: "merchant_code", header: "Code" },
    { key: "legal_name", header: "Legal name" },
    { key: "business_type", header: "Type", render: (r) => r.business_type ?? "—" },
    { key: "contact_email", header: "Contact" },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "stage", header: "Stage", render: (r) => <Badge variant={statusVariant(r.stage)}>{r.stage}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  const funnel = q.data?.funnel ?? [];

  return (
    <>
      <PageHeader title="Merchants" description="Customer-of-our-customer entities (PRODUCT_VISION §3.3)." icon={Store} />
      {funnel.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {funnel.map((f) => (
            <Card key={f.stage}>
              <CardHeader>
                <Badge variant={statusVariant(f.stage)}>{f.stage}</Badge>
                <CardTitle className="text-xl">{f.n}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>{(q.data?.merchants ?? []).length} merchants</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={q.data?.merchants ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No merchants." />
        </CardContent>
      </Card>
    </>
  );
}
