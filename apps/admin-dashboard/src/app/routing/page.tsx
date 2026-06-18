"use client";

import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Rule { id: string; name: string; priority: number; method: string; min_amount?: number; max_amount?: number; enabled: boolean; created_at: string }
interface Rail { id: string; provider: string; method: string; direction: string; enabled: boolean; weight: number; mdr_bps: number }
interface Health { rail_id: string; success_rate_bps: number; p95_latency_ms: number; last_checked_at: string }

export default function RoutingPage() {
  const q = useQuery({
    queryKey: ["routing"],
    queryFn: async () => (await fetch("/api/routing").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { rules: Rule[]; rails: Rail[]; health: Health[] },
  });

  const ruleCols: Column<Rule>[] = [
    { key: "priority", header: "Pri" },
    { key: "name", header: "Name" },
    { key: "method", header: "Method" },
    { key: "min_amount", header: "Range", render: (r) => `${r.min_amount ?? 0}—${r.max_amount ?? "∞"}` },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const railCols: Column<Rail>[] = [
    { key: "provider", header: "Provider" },
    { key: "method", header: "Method" },
    { key: "direction", header: "Dir" },
    { key: "weight", header: "Weight" },
    { key: "mdr_bps", header: "MDR (bps)" },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];

  return (
    <>
      <PageHeader title="Routing engine" description="Rule order + rail catalogue + health probe results." icon={Workflow} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Rules ({(q.data?.rules ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={ruleCols} rows={q.data?.rules ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No rules." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Rails ({(q.data?.rails ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={railCols} rows={q.data?.rails ?? []} rowKey={(r) => r.id} emptyState="No rails." /></CardContent>
      </Card>
    </>
  );
}
