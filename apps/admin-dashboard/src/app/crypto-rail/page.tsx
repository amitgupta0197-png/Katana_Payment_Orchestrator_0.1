"use client";

import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Vasp { id: string; code: string; name: string; kind: string; enabled: boolean; spread_bps: number; created_at: string }
interface Transfer { id: string; vasp_code: string; network: string; txid: string; amount: number; currency: string; status: string; created_at: string }

export default function CryptoRailPage() {
  const q = useQuery({
    queryKey: ["crypto-rail"],
    queryFn: async () => (await fetch("/api/crypto-rail").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { vasps: Vasp[]; recent_transfers: Transfer[] },
  });
  const vCols: Column<Vasp>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind" },
    { key: "spread_bps", header: "Spread (bps)" },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const tCols: Column<Transfer>[] = [
    { key: "vasp_code", header: "VASP" },
    { key: "network", header: "Network" },
    { key: "txid", header: "TXID", render: (r) => <span className="font-mono text-xs">{r.txid?.slice(0,16)}…</span> },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Crypto rails" description="VASP adapter pool — Binance OTC, OKX, Bitget, OnMeta, Transak…" icon={Coins} />
      <Card className="mb-4">
        <CardHeader><CardTitle>VASPs ({(q.data?.vasps ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={vCols} rows={q.data?.vasps ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No VASPs." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent transfers ({(q.data?.recent_transfers ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={tCols} rows={q.data?.recent_transfers ?? []} rowKey={(r) => r.id} emptyState="No crypto transfers." /></CardContent>
      </Card>
    </>
  );
}
