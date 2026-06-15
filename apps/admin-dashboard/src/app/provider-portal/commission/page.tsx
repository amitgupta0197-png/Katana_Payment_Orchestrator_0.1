"use client";

import { useQuery } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Rule {
  id: string; provider_id: string; rule_kind: string; rate_bps: number;
  fixed_fee: number; currency: string; valid_from: string; valid_to?: string;
}

export default function CommissionPage() {
  const q = useQuery({
    queryKey: ["pp:commission"],
    queryFn: async () => (await fetch("/api/commission").then((r) => r.json())) as
      { rules: Rule[]; mtd_earned: number; ytd_earned: number },
  });

  const cols: Column<Rule>[] = [
    { key: "rule_kind", header: "Kind" },
    { key: "rate_bps", header: "Rate (bps)", render: (r) => r.rate_bps },
    { key: "fixed_fee", header: "Fixed fee", render: (r) => formatAmount(r.fixed_fee, r.currency) },
    { key: "valid_from", header: "Valid from", render: (r) => formatDateTime(r.valid_from) },
    { key: "valid_to", header: "Valid to", render: (r) => r.valid_to ? formatDateTime(r.valid_to) : "—" },
  ];

  return (
    <>
      <PageHeader
        title="Commission"
        description="Your commission rules and earnings to date. Set by Super Admin."
        icon={Percent}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>MTD earned</CardDescription>
            <CardTitle className="text-2xl">{formatAmount(q.data?.mtd_earned ?? 0)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>YTD earned</CardDescription>
            <CardTitle className="text-2xl">{formatAmount(q.data?.ytd_earned ?? 0)}</CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle>Active rules</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.rules ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No commission rules configured. Contact Super Admin."
          />
        </CardContent>
      </Card>
    </>
  );
}
