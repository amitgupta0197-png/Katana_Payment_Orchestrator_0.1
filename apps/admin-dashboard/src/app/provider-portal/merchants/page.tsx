"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  stage: string; risk_tier?: string; approved_at?: string;
}
interface SubMid { id: string; merchant_id: string; settlement_enabled: boolean }

const LIVE_STAGES = new Set(["APPROVED", "LIVE"]);

export default function MappedMerchantsPage() {
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: Merchant[] },
  });
  const subMids = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { sub_mids: SubMid[] },
  });

  const live = (merchants.data?.merchants ?? []).filter((m) => LIVE_STAGES.has(m.stage));
  const subCount = new Map<string, number>();
  for (const s of subMids.data?.sub_mids ?? []) {
    subCount.set(s.merchant_id, (subCount.get(s.merchant_id) ?? 0) + 1);
  }

  const cols: Column<Merchant>[] = [
    {
      key: "merchant_code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline" href={`/provider-portal/merchants/${r.id}`}>{r.merchant_code}</Link>,
    },
    { key: "brand_name", header: "Brand", render: (r) => r.brand_name ?? r.legal_name },
    {
      key: "risk_tier", header: "Risk tier",
      render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—",
    },
    {
      key: "stage", header: "Stage",
      render: (r) => <Badge variant={statusVariant(r.stage)}>{r.stage}</Badge>,
    },
    { key: "sub_mid_count", header: "Sub-MIDs", render: (r) => subCount.get(r.id) ?? 0 },
  ];

  return (
    <>
      <PageHeader
        title="Mapped merchants"
        description="Approved & live merchants under your provider."
        icon={Store}
      />
      <Card>
        <CardHeader><CardTitle>{live.length} merchants live</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={live}
            loading={merchants.isLoading}
            rowKey={(r) => r.id}
            emptyState="No live merchants yet. Approved leads will appear here."
          />
        </CardContent>
      </Card>
    </>
  );
}
