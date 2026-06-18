"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

type Kind = "chargebacks" | "rules" | "blacklist";

export default function RiskPage() {
  const [kind, setKind] = useState<Kind>("chargebacks");
  const q = useQuery({
    queryKey: ["risk", kind],
    queryFn: async () => (await fetch(`/api/risk?kind=${kind}`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { items: any[]; kind: string },
  });

  const cbCols: Column<any>[] = [
    { key: "id", header: "Case", render: (r) => <span className="font-mono text-xs">{r.id?.slice(0,8)}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount) },
    { key: "reason_code", header: "Reason" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
  ];
  const ruleCols: Column<any>[] = [
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind" },
    { key: "window_seconds", header: "Window (s)" },
    { key: "cap", header: "Cap" },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const blCols: Column<any>[] = [
    { key: "kind", header: "Kind" },
    { key: "value", header: "Value" },
    { key: "reason", header: "Reason" },
    { key: "created_at", header: "Added", render: (r) => formatDateTime(r.created_at) },
  ];

  const cols = kind === "chargebacks" ? cbCols : kind === "rules" ? ruleCols : blCols;

  return (
    <>
      <PageHeader title="Risk & velocity" description="Velocity rules, blacklist, chargebacks (PRODUCT_VISION §3.9)." icon={ShieldAlert} />
      <Card className="mb-4"><CardContent className="py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <select className="flex h-9 w-48 rounded-md border px-3 py-1 text-sm" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="chargebacks">Chargebacks</option>
              <option value="rules">Velocity rules</option>
              <option value="blacklist">Blacklist</option>
            </select>
          </div>
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{(q.data?.items ?? []).length} entries</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.items ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No entries." /></CardContent>
      </Card>
    </>
  );
}
