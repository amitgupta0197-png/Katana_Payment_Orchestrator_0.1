"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Reserve {
  id: string; source_order_id?: string; hold_amount: number; hold_percent_bps: number;
  held_at: string; release_date: string; release_status: string; released_amount: number; currency: string;
}
interface Stats { total_held: number; releasing_this_week: number; released_mtd: number }

export default function MerchantReservesPage() {
  const q = useQuery({
    queryKey: ["mp:reserves"],
    queryFn: async () => (await fetch("/api/reserves").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { reserves: Reserve[]; stats: Stats },
  });

  const cols: Column<Reserve>[] = [
    { key: "source_order_id", header: "Source order", render: (r) => <span className="font-mono text-xs">{r.source_order_id ?? "—"}</span> },
    { key: "hold_amount", header: "Held", render: (r) => formatAmount(r.hold_amount, r.currency) },
    { key: "hold_percent_bps", header: "%", render: (r) => `${(r.hold_percent_bps / 100).toFixed(2)}%` },
    { key: "held_at", header: "Held at", render: (r) => formatDateTime(r.held_at) },
    { key: "release_date", header: "Release date", render: (r) => formatDateTime(r.release_date) },
    { key: "release_status", header: "Status", render: (r) => <Badge variant={statusVariant(r.release_status)}>{r.release_status}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Rolling reserves" description="Funds held against future chargebacks." icon={BookOpen} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
        <Card><CardHeader><CardDescription>Total held</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats.total_held ?? 0)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Releasing this week</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats.releasing_this_week ?? 0)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Released MTD</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats.released_mtd ?? 0)}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{(q.data?.reserves ?? []).length} reserve holds</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.reserves ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No reserve holds. Reserves are auto-created on settlement."
          />
        </CardContent>
      </Card>
    </>
  );
}
