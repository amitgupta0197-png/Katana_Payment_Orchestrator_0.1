"use client";

// Traffic Allocations (BRD §9, §11). One row per lot's 60% priority quota, with the
// live position: allocated − reserved − consumed = available. Utilization is
// consumed ÷ allocated × 100, exactly as BRD §11 defines it.

import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface Allocation {
  id: string; banker_id: string; purchase_id: string; priority_percent: number;
  allocated: number; reserved: number; consumed: number; available: number;
  utilization: number; status: string; buy_rate: number; lot_status: string; created_at: string;
}
interface Totals { allocated: number; reserved: number; consumed: number; available: number }

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  ACTIVE: "success", EXHAUSTED: "warning", CLOSED: "default",
};

// A small inline bar reads faster than a number when scanning many lots.
function UtilBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone = clamped >= 85 ? "var(--color-danger)" : clamped >= 60 ? "var(--color-warning)" : "var(--color-success)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[color:var(--color-surface-muted)]">
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: tone }} />
      </div>
      <span className="tabular-nums text-xs">{pct}%</span>
    </div>
  );
}

export default function DtAllocationsPage() {
  const q = useQuery({
    queryKey: ["dt-allocations"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/allocations");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { allocations: Allocation[]; totals: Totals };
    },
  });

  const t = q.data?.totals;

  const cols: Column<Allocation>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "purchase_id", header: "Lot", render: (r) => <span className="font-mono text-xs">{r.purchase_id.slice(0, 8)}</span> },
    { key: "priority_percent", header: "Priority %", render: (r) => `${r.priority_percent}%` },
    { key: "allocated", header: "Allocated", render: (r) => formatAmount(r.allocated) },
    { key: "reserved", header: "Reserved", render: (r) => formatAmount(r.reserved) },
    { key: "consumed", header: "Consumed", render: (r) => formatAmount(r.consumed) },
    {
      key: "available",
      header: "Available",
      render: (r) => (
        <span className={r.available <= 0 ? "font-medium text-[color:var(--color-danger)]" : "text-[color:var(--color-success)]"}>
          {formatAmount(r.available)}
        </span>
      ),
    },
    { key: "utilization", header: "Utilization", render: (r) => <UtilBar pct={r.utilization} /> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Traffic Allocations"
        description="Per-lot priority quota positions — allocated, reserved, consumed, available (BRD §11)."
        icon={Gauge}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Allocated" value={t ? formatAmount(t.allocated) : "—"} loading={q.isLoading} />
        <KpiTile label="Reserved (in flight)" value={t ? formatAmount(t.reserved) : "—"} loading={q.isLoading} />
        <KpiTile label="Consumed" value={t ? formatAmount(t.consumed) : "—"} loading={q.isLoading} />
        <KpiTile
          label="Available"
          value={t ? formatAmount(t.available) : "—"}
          variant={t && t.allocated > 0 && t.available / t.allocated <= 0.2 ? "warning" : "success"}
          loading={q.isLoading}
        />
      </div>

      <DataView
        rows={q.data?.allocations ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search banker or lot…", fields: ["banker_id", "purchase_id", "status"] }}
        filters={[
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
          { key: "exhausted", label: "Exhausted", predicate: (r) => r.status === "EXHAUSTED" },
          { key: "low", label: "Low (≤20%)", predicate: (r) => r.allocated > 0 && r.available / r.allocated <= 0.2 },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No allocations"
        emptyDescription="A 60% quota row is created for each lot when a purchase or refill is confirmed."
      />
    </>
  );
}
