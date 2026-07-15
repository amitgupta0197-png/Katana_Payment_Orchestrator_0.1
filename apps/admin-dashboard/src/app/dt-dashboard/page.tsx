"use client";

// DT Business dashboard (BRD §10 UI-001). KPIs across DT purchases, traffic quota,
// security reserve and commission, plus the current Katana-controlled DT rate.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Coins, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccess } from "@/lib/use-access";
import { formatAmount } from "@/lib/utils";

interface Kpis {
  purchases: number; active: number; dt_purchased: number; advance_debit: number;
  traffic_quota: number; reserved: number; consumed_traffic: number; available_traffic: number;
  security_reserve: number; banker_commission: number; katana_margin: number; merchant_charge: number;
}
interface Data { kpis: Kpis; rate: { rate: number; currency: string; version: number } | null }

export default function DtDashboardPage() {
  const qc = useQueryClient();
  const canSetRate = useAccess().data?.persona === "SUPER_ADMIN";
  const q = useQuery({
    queryKey: ["dt-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/dashboard");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Data;
    },
  });

  const [rate, setRate] = useState("");
  const saveRate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/dt/rates/current", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rate: Number(rate) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("DT rate updated"); setRate(""); qc.invalidateQueries({ queryKey: ["dt-dashboard"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const k = q.data?.kpis;
  const dtRate = q.data?.rate;
  const loading = q.isLoading;

  return (
    <>
      <PageHeader title="DT Dashboard" description="Digital Token business control center — purchases, quota, reserve, commission (BRD §10)." icon={Coins} />

      {/* Current DT rate + set (Katana-controlled) */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Current DT rate</CardTitle>
              <CardDescription>Katana-controlled price per DT unit. Advance debit = quantity × rate.</CardDescription>
            </div>
            <div className="text-2xl font-bold tabular-nums">{dtRate ? `${formatAmount(dtRate.rate)} / DT` : "— not set —"}{dtRate ? <span className="ml-2 text-xs font-normal text-[color:var(--color-text-muted)]">v{dtRate.version}</span> : null}</div>
          </div>
        </CardHeader>
        {canSetRate && (
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label>New rate (₹ per DT)</Label>
                <Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 104.00" className="w-40" />
              </div>
              <Button onClick={() => saveRate.mutate()} disabled={!rate || saveRate.isPending}><Save className="h-4 w-4" /> {saveRate.isPending ? "Saving…" : "Set rate"}</Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* KPIs */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <KpiTile label="DT purchased" value={k ? k.dt_purchased.toLocaleString("en-IN") : "—"} loading={loading} />
        <KpiTile label="Advance debit" value={k ? formatAmount(k.advance_debit) : "—"} loading={loading} />
        <KpiTile label="Active lots" value={k?.active ?? 0} loading={loading} />
        <KpiTile label="Traffic quota" value={k ? formatAmount(k.traffic_quota) : "—"} loading={loading} />
        <KpiTile label="Consumed traffic" value={k ? formatAmount(k.consumed_traffic) : "—"} loading={loading} />
        <KpiTile label="Available traffic" value={k ? formatAmount(k.available_traffic) : "—"} variant={k && k.traffic_quota > 0 && k.available_traffic / k.traffic_quota <= 0.2 ? "warning" : "success"} loading={loading} />
        <KpiTile label="Security reserve" value={k ? formatAmount(k.security_reserve) : "—"} loading={loading} />
        <KpiTile label="Banker commission" value={k ? formatAmount(k.banker_commission) : "—"} loading={loading} />
        <KpiTile label="Katana margin" value={k ? formatAmount(k.katana_margin) : "—"} variant="success" loading={loading} />
      </div>

      <p className="text-xs text-[color:var(--color-text-subtle)]">
        Commission figures populate once Phase 3 (routing consumption + waterfall) is enabled. Purchases, quota and reserve are live now.
      </p>
    </>
  );
}
