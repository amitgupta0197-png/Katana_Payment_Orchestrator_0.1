"use client";

// Provider dashboard infographics — transaction volume, value, status, and channel
// mix across the provider's assigned merchants. Driven by /api/provider-portal/transactions.
// Reuses the dependency-free SVG chart primitives from the merchant portal.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, GrossBars, StatusDonut, HBars, ChartSkeleton, type Day } from "@/components/merchant/portal-charts";
import { formatAmount, railLabel } from "@/lib/utils";

interface Totals { gross: number; success_count: number; failed_count: number; pending_count: number; total_count: number }
interface ChannelRow { channel: string; gross: number; count: number }
interface ProviderTxns { totals: Totals; by_channel: ChannelRow[]; series: Day[] }

export function ProviderCharts() {
  const q = useQuery({
    queryKey: ["pp:txn-charts"],
    queryFn: async () => (await fetch("/api/provider-portal/transactions").then((r) => r.json())) as ProviderTxns,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const loading = q.isLoading;
  const series = d?.series ?? [];
  const status = {
    success: d?.totals.success_count ?? 0,
    pending: d?.totals.pending_count ?? 0,
    failed: d?.totals.failed_count ?? 0,
  };
  const channelRows = (d?.by_channel ?? []).map((c) => ({ label: railLabel(c.channel), count: c.count, gross: c.gross }));
  const grossTotal = series.reduce((s, x) => s + x.gross, 0);

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Pay-ins · last 14 days</CardTitle>
          <CardDescription>Daily order count across your merchants. Dashed line = successful · {formatAmount(grossTotal)} collected.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={190} /> : <AreaChart series={series} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status breakdown</CardTitle>
          <CardDescription>Across all branch orders.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={140} /> : <StatusDonut status={status} />}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Collected ₹ · last 14 days</CardTitle>
          <CardDescription>Successful pay-in value per day.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={170} /> : <GrossBars series={series} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channel mix</CardTitle>
          <CardDescription>Orders by payment channel.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={140} /> : <HBars rows={channelRows} empty="No transactions yet." />}
        </CardContent>
      </Card>
    </div>
  );
}
