"use client";

// Traffic Wallet (BRD §9, §11) — the fleet-wide view, one row per banker.
// DT Wallet drills into a single banker's lots; this answers "who is running out?"
// across every banker at once, using the same BRD §11 formulas.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Gauge, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatAmount } from "@/lib/utils";

interface BankerRow {
  banker_id: string; purchases: number; active: number; dt_purchased: number;
  advance_debit: number; traffic_quota: number; reserved: number; consumed: number;
  available: number; reserve_held: number; open_refills: number; last_purchase_at: string | null;
}

// BRD §16 ladder, mirrored client-side so the table colours match the alerts screen.
function levelFor(r: BankerRow): { label: string; variant: "default" | "info" | "warning" | "success" | "danger" } {
  if (r.traffic_quota <= 0) return { label: "NO QUOTA", variant: "default" };
  const pct = r.available / r.traffic_quota;
  if (r.available <= 0) return { label: "EXHAUSTED", variant: "danger" };
  if (pct <= 0.15) return { label: "REFILL", variant: "danger" };
  if (pct <= 0.20) return { label: "WARN", variant: "warning" };
  return { label: "OK", variant: "success" };
}

export default function DtTrafficWalletPage() {
  const q = useQuery({
    queryKey: ["dt-traffic-wallet"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/dashboard");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.bankers as BankerRow[];
    },
  });

  const rows = q.data ?? [];
  const totals = rows.reduce(
    (a, r) => ({
      quota: a.quota + r.traffic_quota,
      reserved: a.reserved + r.reserved,
      consumed: a.consumed + r.consumed,
      available: a.available + r.available,
    }),
    { quota: 0, reserved: 0, consumed: 0, available: 0 },
  );
  const atRisk = rows.filter((r) => r.traffic_quota > 0 && r.available / r.traffic_quota <= 0.2).length;

  const cols: Column<BankerRow>[] = [
    {
      key: "banker_id",
      header: "Banker",
      render: (r) => (
        <Link href={`/dt-wallet`} className="font-medium hover:underline">
          {r.banker_id}
        </Link>
      ),
    },
    {
      key: "level",
      header: "Level",
      render: (r) => {
        const l = levelFor(r);
        return <Badge variant={l.variant}>{l.label}</Badge>;
      },
    },
    { key: "traffic_quota", header: "Allocated", render: (r) => formatAmount(r.traffic_quota) },
    { key: "reserved", header: "Reserved", render: (r) => formatAmount(r.reserved) },
    { key: "consumed", header: "Consumed", render: (r) => formatAmount(r.consumed) },
    {
      key: "available",
      header: "Available",
      render: (r) => (
        <span className={r.available <= 0 ? "font-medium text-[color:var(--color-danger)]" : ""}>
          {formatAmount(r.available)}
          {r.traffic_quota > 0 && (
            <span className="ml-1 text-xs text-[color:var(--color-text-subtle)]">
              · {((r.available / r.traffic_quota) * 100).toFixed(1)}%
            </span>
          )}
        </span>
      ),
    },
    {
      key: "utilization",
      header: "Utilization",
      render: (r) => (r.traffic_quota > 0 ? `${((r.consumed / r.traffic_quota) * 100).toFixed(1)}%` : "—"),
    },
    { key: "reserve_held", header: "Reserve", render: (r) => formatAmount(r.reserve_held) },
    {
      key: "open_refills",
      header: "Open refills",
      render: (r) => (r.open_refills > 0 ? <Badge variant="info">{r.open_refills}</Badge> : "—"),
    },
    { key: "active", header: "Active lots", render: (r) => r.active },
  ];

  return (
    <>
      <PageHeader
        title="Traffic Wallet"
        description="Fleet-wide quota position per banker — available = allocated − reserved − consumed (BRD §11)."
        icon={Gauge}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile label="Bankers" value={rows.length || "—"} loading={q.isLoading} />
        <KpiTile label="Allocated" value={totals.quota ? formatAmount(totals.quota) : "—"} loading={q.isLoading} />
        <KpiTile label="Consumed" value={totals.consumed ? formatAmount(totals.consumed) : "—"} loading={q.isLoading} />
        <KpiTile
          label="Available"
          value={totals.quota ? formatAmount(totals.available) : "—"}
          variant={totals.quota > 0 && totals.available / totals.quota <= 0.2 ? "warning" : "success"}
          loading={q.isLoading}
        />
        <KpiTile
          label="At risk (≤20%)"
          value={atRisk}
          icon={atRisk > 0 ? AlertTriangle : undefined}
          variant={atRisk > 0 ? "danger" : "success"}
          href="/dt-refills"
          loading={q.isLoading}
        />
      </div>

      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.banker_id}
        loading={q.isLoading}
        search={{ placeholder: "Search banker…", fields: ["banker_id"] }}
        filters={[
          { key: "at-risk", label: "At risk (≤20%)", predicate: (r) => r.traffic_quota > 0 && r.available / r.traffic_quota <= 0.2 },
          { key: "exhausted", label: "Exhausted", predicate: (r) => r.traffic_quota > 0 && r.available <= 0 },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No bankers with quota"
        emptyDescription="Quota appears once a banker's DT purchase is confirmed."
      />
    </>
  );
}
