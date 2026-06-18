"use client";

import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Provider { id: string; code: string; name: string; mdr_bps: number; enabled: boolean; health: string; success_rate_bps: number; created_at: string }
interface Credential { id: string; provider: string; env: string; active: boolean; created_at: string }

export default function PgAdapterPage() {
  const q = useQuery({
    queryKey: ["pg-adapter"],
    queryFn: async () => (await fetch("/api/pg-adapter").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { providers: Provider[]; credentials: Credential[] },
  });
  const pCols: Column<Provider>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "mdr_bps", header: "MDR (bps)" },
    { key: "health", header: "Health", render: (r) => <Badge variant={statusVariant(r.health)}>{r.health}</Badge> },
    { key: "success_rate_bps", header: "Success %", render: (r) => `${(r.success_rate_bps / 100).toFixed(2)}%` },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const cCols: Column<Credential>[] = [
    { key: "provider", header: "Provider" },
    { key: "env", header: "Env" },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="PG adapters" description="Pay-in gateway adapter pool — providers + per-env credentials." icon={Network} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Providers ({(q.data?.providers ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={pCols} rows={q.data?.providers ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No PG providers." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Credentials ({(q.data?.credentials ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cCols} rows={q.data?.credentials ?? []} rowKey={(r) => r.id} emptyState="No credentials." /></CardContent>
      </Card>
    </>
  );
}
