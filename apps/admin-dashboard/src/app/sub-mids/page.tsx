"use client";

// L1 — Sub-MID engine. Main MIDs stay as a compact section; Sub-MIDs get
// the DataView treatment (KYC filter chips, settle-on/off chips, search by
// code/merchant, row links to /sub-mids/[id]).

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
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
    queryFn: async () => (await fetch("/api/sub-mids").then((r) => r.json())) as { main_mids: MainMid[]; sub_mids: SubMid[] },
  });
  const main = q.data?.main_mids ?? [];
  const sub = q.data?.sub_mids ?? [];

  const mainCols: Column<MainMid>[] = [
    { key: "mid_code", header: "MID code" },
    { key: "merchant_id", header: "Merchant" },
    { key: "sub_mid_count", header: "Sub-MIDs", render: (r) => <span className="tabular-nums">{r.sub_mid_count}</span> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const subCols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Sub-MID",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/sub-mids/${r.id}`}>{r.sub_mid_code}</Link> },
    { key: "main_mid_code", header: "Main MID" },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Main + Sub-MID engine" description="MID surface for all merchants (PRODUCT_VISION §3.2)." icon={Network} />

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Main MIDs ({main.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={mainCols} rows={main} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No main MIDs." />
        </CardContent>
      </Card>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Sub-MIDs ({sub.length})</h2>
      <DataView
        rows={sub}
        columns={subCols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/sub-mids/${r.id}`}
        search={{ placeholder: "Search by sub-MID / main MID / merchant…", fields: ["sub_mid_code", "main_mid_code", "merchant_id"] }}
        filters={[
          { key: "kyc-pending",  label: "KYC pending",   predicate: (r: SubMid) => r.kyc_status === "PENDING" || r.kyc_status === "IN_REVIEW" },
          { key: "kyc-approved", label: "KYC approved",  predicate: (r: SubMid) => r.kyc_status === "APPROVED" },
          { key: "live",         label: "Settling",      predicate: (r: SubMid) => r.settlement_enabled },
          { key: "traffic",      label: "Traffic mode",  predicate: (r: SubMid) => r.traffic_mode === "TRAFFIC" || r.traffic_mode === "LIVE" },
        ]}
        savedViewKey="sub-mids"
        refresh={() => q.refetch()}
        emptyTitle="No Sub-MIDs yet"
        emptyDescription="Request a Sub-MID from a merchant's detail page to start traffic-mode rollout."
      />
    </>
  );
}
