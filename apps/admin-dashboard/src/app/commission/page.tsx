"use client";

import { useQuery } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Rule {
  id: string; provider_id: string; rule_kind: string; rate_bps: number;
  fixed_fee: number; currency: string; valid_from: string; valid_to?: string;
}

export default function AdminCommissionPage() {
  const q = useQuery({
    queryKey: ["commission:admin"],
    queryFn: async () => (await fetch("/api/commission").then((r) => r.json())) as { rules: Rule[] },
  });
  const cols: Column<Rule>[] = [
    { key: "provider_id", header: "Provider", render: (r) => <span className="font-mono text-xs">{r.provider_id?.slice(0,8) ?? "—"}…</span> },
    { key: "rule_kind", header: "Kind" },
    { key: "rate_bps", header: "Rate (bps)" },
    { key: "fixed_fee", header: "Fixed", render: (r) => formatAmount(r.fixed_fee, r.currency) },
    { key: "valid_from", header: "Valid from", render: (r) => formatDateTime(r.valid_from) },
    { key: "valid_to", header: "Valid to", render: (r) => r.valid_to ? formatDateTime(r.valid_to) : "—" },
  ];
  return (
    <>
      <PageHeader title="Commission" description="Provider commission rules across the platform (PRODUCT_VISION §3.11)." icon={Percent} />
      <Card><CardHeader><CardTitle>{(q.data?.rules ?? []).length} rules</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.rules ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No commission rules." /></CardContent>
      </Card>
    </>
  );
}
