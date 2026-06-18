"use client";

// L1 — reserves ledger. DataView with release-window + status filter chips
// + search. KPI tiles for held / releasing / released.

import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
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
  const rows = q.data?.reserves ?? [];
  const stats = q.data?.stats;
  const now = Date.now();

  const cols: Column<Reserve>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "hold_amount", header: "Held", render: (r) => <span className="tabular-nums">{formatAmount(r.hold_amount, r.currency)}</span> },
    { key: "released_amount", header: "Released", render: (r) => <span className="tabular-nums">{formatAmount(r.released_amount, r.currency)}</span> },
    { key: "hold_percent_bps", header: "%", render: (r) => <span className="tabular-nums">{(r.hold_percent_bps / 100).toFixed(2)}%</span> },
    { key: "held_at", header: "Held at", render: (r) => <span className="text-xs">{formatDateTime(r.held_at)}</span> },
    { key: "release_date", header: "Release",
      render: (r) => {
        const days = Math.ceil((new Date(r.release_date).getTime() - now) / 86400_000);
        const closed = r.release_status === "RELEASED" || r.release_status === "FORFEITED";
        if (closed) return <span className="text-xs">{formatDateTime(r.release_date)}</span>;
        return <Badge variant={days <= 0 ? "danger" : days <= 7 ? "warning" : "default"}>{days <= 0 ? "due" : `${days}d`}</Badge>;
      } },
    { key: "release_status", header: "Status", render: (r) => <Badge variant={statusVariant(r.release_status)}>{r.release_status}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Reserves" description="Rolling-reserve ledger across all merchants (PRODUCT_VISION §3.8)." icon={BookOpen} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile label="Total held" value={formatAmount(stats?.total_held ?? 0)} loading={q.isLoading} />
        <KpiTile label="Releasing this week" value={formatAmount(stats?.releasing_this_week ?? 0)} variant="warning" loading={q.isLoading} />
        <KpiTile label="Released MTD" value={formatAmount(stats?.released_mtd ?? 0)} variant="success" loading={q.isLoading} />
      </div>
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by merchant…", fields: ["merchant_id"] }}
        filters={[
          { key: "due-now",   label: "Due now",   predicate: (r: Reserve) => r.release_status !== "RELEASED" && new Date(r.release_date).getTime() <= now },
          { key: "due-7d",    label: "Due ≤7d",   predicate: (r: Reserve) => r.release_status !== "RELEASED" && new Date(r.release_date).getTime() - now <= 7 * 86400_000 },
          { key: "held",      label: "Held",      predicate: (r: Reserve) => r.release_status === "HELD" || r.release_status === "ACTIVE" },
          { key: "released",  label: "Released",  predicate: (r: Reserve) => r.release_status === "RELEASED" },
          { key: "forfeited", label: "Forfeited", predicate: (r: Reserve) => r.release_status === "FORFEITED" },
        ]}
        savedViewKey="reserves"
        refresh={() => q.refetch()}
        emptyTitle="No reserve holds"
        emptyDescription="When transactions hit the reserve policy threshold, holds appear here."
      />
    </>
  );
}
