"use client";

import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  stage: string; risk_tier?: string;
}
interface SubMid {
  id: string; sub_mid_code: string; merchant_id: string;
  kyc_status: string; settlement_enabled: boolean; traffic_mode: string;
}
interface Reserve {
  id: string; merchant_id: string; hold_amount: number; release_date: string; release_status: string;
}

export default function ProviderPortalMerchantDetailView({ id }: { id: string }) {
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: Merchant[] },
  });
  const subMids = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then((r) => r.json())) as { sub_mids: SubMid[] },
  });
  const reserves = useQuery({
    queryKey: ["pp:reserves"],
    queryFn: async () => (await fetch("/api/reserves").then((r) => r.json())) as { reserves: Reserve[] },
  });

  const merchant = merchants.data?.merchants?.find((m) => m.id === id);
  const mSubs = (subMids.data?.sub_mids ?? []).filter((s) => s.merchant_id === id);
  const mReserves = (reserves.data?.reserves ?? []).filter((r) => r.merchant_id === id);

  const subCols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Code" },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const reserveCols: Column<Reserve>[] = [
    { key: "id", header: "ID", render: (r) => <span className="font-mono text-xs">{r.id.slice(0, 8)}</span> },
    { key: "hold_amount", header: "Held", render: (r) => formatAmount(r.hold_amount) },
    { key: "release_date", header: "Release date", render: (r) => formatDateTime(r.release_date) },
    { key: "release_status", header: "Status", render: (r) => <Badge variant={statusVariant(r.release_status)}>{r.release_status}</Badge> },
  ];

  if (merchants.isLoading) {
    return (
      <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</CardContent></Card>
    );
  }
  if (!merchant) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Merchant not found</CardTitle>
          <CardDescription>This merchant isn't mapped to your provider, or doesn't exist.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={merchant.brand_name || merchant.legal_name}
        description={`${merchant.merchant_code} · ${merchant.stage}`}
        icon={Store}
        actions={merchant.risk_tier ? <Badge variant={statusVariant(merchant.risk_tier)}>{merchant.risk_tier}</Badge> : null}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Sub-MIDs</CardTitle><CardDescription>{mSubs.length} configured</CardDescription></CardHeader>
          <CardContent>
            <DataTable columns={subCols} rows={mSubs} rowKey={(r) => r.id} emptyState="No Sub-MIDs yet." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Rolling reserves</CardTitle><CardDescription>{mReserves.length} active holds</CardDescription></CardHeader>
          <CardContent>
            <DataTable columns={reserveCols} rows={mReserves} rowKey={(r) => r.id} emptyState="No reserve holds." />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
