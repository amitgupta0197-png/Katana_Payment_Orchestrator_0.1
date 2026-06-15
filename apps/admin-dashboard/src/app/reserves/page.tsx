"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Reserve {
  id: string; merchant_id: string; source_order_id?: string; hold_amount: number;
  hold_percent_bps: number; held_at: string; release_date: string;
  release_status: string; released_amount: number; currency: string;
}
interface Stats { total_held: number; releasing_this_week: number; released_mtd: number }

export default function ReservesPage() {
  const q = useQuery({
    queryKey: ["reserves:admin"],
    queryFn: async () => (await fetch("/api/reserves").then((r) => r.json())) as { reserves: Reserve[]; stats: Stats },
  });
  const cols: Column<Reserve>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "hold_amount", header: "Held", render: (r) => formatAmount(r.hold_amount, r.currency) },
    { key: "hold_percent_bps", header: "%", render: (r) => `${(r.hold_percent_bps / 100).toFixed(2)}%` },
    { key: "held_at", header: "Held at", render: (r) => formatDateTime(r.held_at) },
    { key: "release_date", header: "Release", render: (r) => formatDateTime(r.release_date) },
    { key: "release_status", header: "Status", render: (r) => <Badge variant={statusVariant(r.release_status)}>{r.release_status}</Badge> },
  ];
  return (
    <>
      <PageHeader title="Reserves" description="Rolling-reserve ledger across all merchants (PRODUCT_VISION §3.8)." icon={BookOpen} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
        <Card><CardHeader><CardDescription>Total held</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats?.total_held ?? 0)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Releasing this week</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats?.releasing_this_week ?? 0)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Released MTD</CardDescription><CardTitle className="text-2xl">{formatAmount(q.data?.stats?.released_mtd ?? 0)}</CardTitle></CardHeader></Card>
      </div>
      <Card><CardHeader><CardTitle>{(q.data?.reserves ?? []).length} holds</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.reserves ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No reserve holds." /></CardContent>
      </Card>
    </>
  );
}
