"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface SubMid {
  id: string; sub_mid_code: string; traffic_mode: string; kyc_status: string;
  settlement_enabled: boolean; merchant_id: string; main_mid_code: string; requested_at: string;
  provider_id?: string;
}
interface MainMid { id: string; mid_code: string; merchant_id: string; sub_mid_count: number; settlement_enabled: boolean }

export default function AdminSubMidsPage() {
  const q = useQuery({
    queryKey: ["sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { main_mids: MainMid[]; sub_mids: SubMid[] },
  });

  const mainCols: Column<MainMid>[] = [
    { key: "mid_code", header: "MID code" },
    { key: "merchant_id", header: "Merchant" },
    { key: "sub_mid_count", header: "Sub-MIDs" },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const subCols: Column<SubMid>[] = [
    {
      key: "sub_mid_code", header: "Sub-MID",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/sub-mids/${r.id}`}>{r.sub_mid_code}</Link>,
    },
    { key: "main_mid_code", header: "Main MID" },
    {
      key: "merchant_id", header: "Merchant",
      render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span>,
    },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
  ];

  return (
    <>
      <PageHeader title="Main + Sub-MID engine" description="MID surface for all merchants (PRODUCT_VISION §3.2)." icon={Network} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Main MIDs ({(q.data?.main_mids ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={mainCols} rows={q.data?.main_mids ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No main MIDs." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Sub-MIDs ({(q.data?.sub_mids ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={subCols} rows={q.data?.sub_mids ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No Sub-MIDs." />
        </CardContent>
      </Card>
    </>
  );
}
