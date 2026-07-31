"use client";

// Security Reserves (BRD §9, §5). One row per lot's 40% locked portion.
// Outstanding = held − released. Release requires approval (BRD open decision OD-03),
// so a RELEASED row is an audit-worthy event, not routine bookkeeping.

import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface Reserve {
  id: string; banker_id: string; purchase_id: string; reserve_percent: number;
  held: number; released: number; outstanding: number; outstanding_dt: number;
  status: string; buy_rate: number; lot_status: string; created_at: string; updated_at: string;
}
interface Totals { held: number; released: number; outstanding: number }

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  HELD: "success", PARTIALLY_RELEASED: "warning", RELEASED: "info",
};

export default function DtReservesPage() {
  const q = useQuery({
    queryKey: ["dt-reserves"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/reserves");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { reserves: Reserve[]; totals: Totals };
    },
  });

  const t = q.data?.totals;
  // BRD §15 invariant: reserve release ≤ held. A breach means money was released that
  // was never locked, so it is surfaced as a KPI rather than buried in a row.
  const releaseWithinHeld = t ? t.released <= t.held + 0.01 : true;

  const cols: Column<Reserve>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "purchase_id", header: "Lot", render: (r) => <span className="font-mono text-xs">{r.purchase_id.slice(0, 8)}</span> },
    { key: "reserve_percent", header: "Reserve %", render: (r) => `${r.reserve_percent}%` },
    { key: "held", header: "Held", render: (r) => formatAmount(r.held) },
    {
      key: "released",
      header: "Released",
      render: (r) => (r.released > 0 ? <span className="text-[color:var(--color-warning)]">{formatAmount(r.released)}</span> : "—"),
    },
    {
      key: "outstanding",
      header: "Outstanding",
      render: (r) => (
        <span className="font-medium">
          {formatAmount(r.outstanding)}
          {r.outstanding_dt > 0 && (
            <span className="ml-1 text-xs text-[color:var(--color-text-subtle)]">· {r.outstanding_dt.toLocaleString("en-IN")} DT</span>
          )}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "lot_status", header: "Lot", render: (r) => <Badge variant="default">{r.lot_status}</Badge> },
    { key: "updated_at", header: "Updated", render: (r) => formatDateTime(r.updated_at) },
  ];

  return (
    <>
      <PageHeader
        title="Security Reserves"
        description="Per-lot 40% locked portion. Outstanding = held − released (BRD §5)."
        icon={Lock}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Total held" value={t ? formatAmount(t.held) : "—"} loading={q.isLoading} />
        <KpiTile label="Released" value={t ? formatAmount(t.released) : "—"} loading={q.isLoading} />
        <KpiTile label="Outstanding" value={t ? formatAmount(t.outstanding) : "—"} variant="success" loading={q.isLoading} />
        <KpiTile
          label="Release ≤ held"
          value={releaseWithinHeld ? "PASS" : "BREACH"}
          sublabel="BRD §15 invariant"
          variant={releaseWithinHeld ? "success" : "danger"}
          loading={q.isLoading}
        />
      </div>

      <DataView
        rows={q.data?.reserves ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search banker or lot…", fields: ["banker_id", "purchase_id", "status"] }}
        filters={[
          { key: "held", label: "Held", predicate: (r) => r.status === "HELD" },
          { key: "released", label: "Released", predicate: (r) => r.released > 0 },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No security reserves"
        emptyDescription="A 40% reserve row is created for each lot when a purchase or refill is confirmed."
      />
    </>
  );
}
