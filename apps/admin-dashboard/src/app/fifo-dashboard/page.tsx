"use client";

// FIFO operations dashboard (PayTech BRD §31). Persona widgets in one view:
// admin throughput, queue/SLA, operators, risk alerts and finance balances.

import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount } from "@/lib/utils";

export default function FifoDashboardPage() {
  const q = useQuery({
    queryKey: ["fifo-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dashboard");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as any;
    },
    refetchInterval: 8000,
  });
  const d = q.data;
  const m = (v: string | undefined) => formatAmount(Number(v ?? 0), d?.finance?.currency ?? "INR");

  const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <Card className="mb-4">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div></CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader title="FIFO Dashboard" description="Live operations metrics across pay-in, payout, queue, risk and finance (BRD §31)." icon={LayoutDashboard} />

      <Group title="Admin · throughput">
        <KpiTile label="Pay-in completed" value={d?.payin?.completed_count ?? 0} loading={q.isLoading} />
        <KpiTile label="Pay-in value" value={m(d?.payin?.completed_amount_minor)} variant="success" loading={q.isLoading} />
        <KpiTile label="Payout completed" value={d?.payout?.completed_count ?? 0} loading={q.isLoading} />
        <KpiTile label="Payout value" value={m(d?.payout?.completed_amount_minor)} loading={q.isLoading} />
      </Group>

      <Group title="Operations · queue & SLA">
        <KpiTile label="In queue" value={d?.queue?.queued ?? 0} variant={(d?.queue?.queued ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Assigned" value={d?.queue?.assigned ?? 0} loading={q.isLoading} />
        <KpiTile label="Accepted" value={d?.queue?.accepted ?? 0} loading={q.isLoading} />
        <KpiTile label="SLA breaches" value={d?.queue?.sla_breaches ?? 0} variant={(d?.queue?.sla_breaches ?? 0) > 0 ? "danger" : "default"} loading={q.isLoading} />
      </Group>

      <Group title="Exceptions & operators">
        <KpiTile label="On hold" value={d?.exceptions?.hold ?? 0} variant={(d?.exceptions?.hold ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Rejected" value={d?.exceptions?.rejected ?? 0} loading={q.isLoading} />
        <KpiTile label="Failed" value={d?.exceptions?.failed ?? 0} loading={q.isLoading} />
        <KpiTile label="Active operators" value={`${d?.operators?.active ?? 0}/${d?.operators?.total ?? 0}`} variant="success" loading={q.isLoading} />
      </Group>

      <Group title="Risk">
        <KpiTile label="Open alerts" value={d?.risk?.open_alerts ?? 0} variant={(d?.risk?.open_alerts ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Duplicate UTR" value={d?.risk?.duplicate_utr ?? 0} variant={(d?.risk?.duplicate_utr ?? 0) > 0 ? "danger" : "default"} loading={q.isLoading} />
        <KpiTile label="Velocity" value={d?.risk?.velocity ?? 0} loading={q.isLoading} />
        <KpiTile label="High-value" value={d?.risk?.high_value ?? 0} loading={q.isLoading} />
      </Group>

      <Group title="Finance">
        <KpiTile label="Net payable" value={m(d?.finance?.net_payable_minor)} loading={q.isLoading} />
        <KpiTile label="Rolling reserve" value={m(d?.finance?.reserve_minor)} loading={q.isLoading} />
        <KpiTile label="Payout pending" value={d?.payout?.pending ?? 0} loading={q.isLoading} />
        <KpiTile label="Pay-in processing" value={d?.payin?.processing ?? 0} loading={q.isLoading} />
      </Group>
    </>
  );
}
