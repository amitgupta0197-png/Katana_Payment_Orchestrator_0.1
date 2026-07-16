"use client";

// Banker dashboard — the banker's own DT position: current rate, KPIs (purchases,
// traffic quota/consumed/available, security reserve, commission) and active DT lots.

import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Kpis {
  purchases: number; active: number; dt_purchased: number; advance_debit: number;
  traffic_quota: number; reserved: number; consumed_traffic: number; available_traffic: number;
  security_reserve: number; security_reserve_dt: number; banker_commission: number;
}
interface Lot { id: string; quantity: number; buy_rate: number; total_amount: number; status: string; created_at: string }
interface Data {
  kpis: Kpis;
  wallet: { allocated: number; reserved: number; consumed: number; available: number; utilization: number };
  lots: Lot[];
  rate: { rate: number; currency: string; version: number } | null;
}

const LOT_VARIANT: Record<string, "default" | "success" | "warning"> = {
  ACTIVE: "success", EXHAUSTED: "warning", REFILLED: "success",
};

export default function BankerDashboardPage() {
  const q = useQuery({
    queryKey: ["banker-overview"],
    queryFn: async () => {
      const r = await fetch("/api/banker-portal/overview");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Data;
    },
  });

  const k = q.data?.kpis;
  const rate = q.data?.rate;
  const wallet = q.data?.wallet;
  const loading = q.isLoading;

  return (
    <>
      <PageHeader title="Dashboard" description="Your DT purchases, traffic quota and commission at a glance." icon={Coins} />

      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Current DT rate</CardTitle>
              <CardDescription>Katana-controlled price per DT unit. Advance debit = quantity × rate.</CardDescription>
            </div>
            <div className="text-2xl font-bold tabular-nums">{rate ? `${formatAmount(rate.rate)} / DT` : "— not set —"}</div>
          </div>
        </CardHeader>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <KpiTile label="DT purchased" value={k ? k.dt_purchased.toLocaleString("en-IN") : "—"} loading={loading} />
        <KpiTile label="Advance paid" value={k ? formatAmount(k.advance_debit) : "—"} loading={loading} />
        <KpiTile label="Active lots" value={k?.active ?? 0} loading={loading} />
        <KpiTile label="Traffic quota" value={k ? formatAmount(k.traffic_quota) : "—"} loading={loading} />
        <KpiTile label="Consumed traffic" value={k ? formatAmount(k.consumed_traffic) : "—"} loading={loading} />
        <KpiTile label="Available traffic" value={k ? formatAmount(k.available_traffic) : "—"} variant={k && k.traffic_quota > 0 && k.available_traffic / k.traffic_quota <= 0.2 ? "warning" : "success"} loading={loading} />
        <KpiTile label="Rolling reserve" value={k ? `${formatAmount(k.security_reserve)} · ${Math.round(k.security_reserve_dt).toLocaleString("en-IN")} DT` : "—"} loading={loading} />
        <KpiTile label="Commission earned" value={k ? formatAmount(k.banker_commission) : "—"} variant="success" loading={loading} />
      </div>

      {wallet && wallet.allocated > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Traffic wallet</CardTitle>
            <CardDescription>{wallet.utilization}% of your allocated quota consumed.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-surface-muted)]">
              <div
                className="h-full rounded-full bg-[color:var(--color-brand)]"
                style={{ width: `${Math.min(100, wallet.utilization)}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[color:var(--color-text-muted)]">
              <span>Allocated <b className="text-[color:var(--color-text)]">{formatAmount(wallet.allocated)}</b></span>
              <span>Reserved <b className="text-[color:var(--color-text)]">{formatAmount(wallet.reserved)}</b></span>
              <span>Consumed <b className="text-[color:var(--color-text)]">{formatAmount(wallet.consumed)}</b></span>
              <span>Available <b className="text-[color:var(--color-text)]">{formatAmount(wallet.available)}</b></span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">DT lots</CardTitle>
          <CardDescription>Your funded purchases and their status.</CardDescription>
        </CardHeader>
        <CardContent>
          {!q.data?.lots?.length ? (
            <p className="text-sm text-[color:var(--color-text-muted)]">No funded lots yet. Your purchases appear here once funds are confirmed.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-[color:var(--color-text-muted)]">
                    <th className="py-2 pr-4 font-medium">DT Qty</th>
                    <th className="py-2 pr-4 font-medium">Rate</th>
                    <th className="py-2 pr-4 font-medium">Advance</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.lots.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{l.quantity.toLocaleString("en-IN")}</td>
                      <td className="py-2 pr-4">{formatAmount(l.buy_rate)}</td>
                      <td className="py-2 pr-4 font-medium">{formatAmount(l.total_amount)}</td>
                      <td className="py-2 pr-4"><Badge variant={LOT_VARIANT[l.status] ?? "default"}>{l.status}</Badge></td>
                      <td className="py-2">{formatDateTime(l.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
