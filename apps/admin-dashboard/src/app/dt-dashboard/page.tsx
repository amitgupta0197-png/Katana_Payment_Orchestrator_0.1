"use client";

// DT Business dashboard (BRD §10 UI-001). KPIs across DT purchases, traffic quota,
// security reserve and commission, plus the current Katana-controlled DT rate.

import Link from "next/link";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Coins, Save, Droplets, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
  security_reserve: number; security_reserve_dt: number; banker_commission: number; katana_margin: number; merchant_charge: number;
}
interface OpenRefill { id: string; banker_id: string; quantity: number | null; trigger: string; status: string; created_by: string; created_at: string }
interface BankerRow {
  banker_id: string; purchases: number; active: number; dt_purchased: number; advance_debit: number;
  traffic_quota: number; reserved: number; consumed: number; available: number;
  reserve_held: number; reserve_dt: number; open_refills: number; last_purchase_at: string;
}
interface Data { kpis: Kpis; rate: { rate: number; currency: string; version: number } | null; bankers?: BankerRow[]; open_refills?: OpenRefill[] }

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
        <KpiTile label="Rolling reserve" value={k ? `${formatAmount(k.security_reserve)} · ${k.security_reserve_dt.toLocaleString("en-IN")} DT` : "—"} loading={loading} />
        <KpiTile label="Banker commission" value={k ? formatAmount(k.banker_commission) : "—"} loading={loading} />
        <KpiTile label="Katana margin" value={k ? formatAmount(k.katana_margin) : "—"} variant="success" loading={loading} />
      </div>

      {/* Banker-wise breakdown — who bought the DT and where each stands */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Banker-wise breakdown</CardTitle>
              <CardDescription>Per-banker DT position — click a banker to open their full ledger. The gross KPIs above are the sum of these rows.</CardDescription>
            </div>
            <Link href="/dt-purchases" className="inline-flex items-center gap-1 text-sm font-medium text-[color:var(--color-brand)] hover:underline">
              Open DT Purchases <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {!q.data?.bankers?.length ? (
            <p className="text-sm text-[color:var(--color-text-muted)]">No banker purchases yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-[color:var(--color-text-muted)]">
                    <th className="py-2 pr-4 font-medium">Banker</th>
                    <th className="py-2 pr-4 font-medium">DT bought</th>
                    <th className="py-2 pr-4 font-medium">Advance</th>
                    <th className="py-2 pr-4 font-medium">Lots (active)</th>
                    <th className="py-2 pr-4 font-medium">Quota</th>
                    <th className="py-2 pr-4 font-medium">Consumed</th>
                    <th className="py-2 pr-4 font-medium">Available</th>
                    <th className="py-2 pr-4 font-medium">Rolling reserve</th>
                    <th className="py-2 font-medium">Open refills</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.bankers.map((b) => (
                    <tr key={b.banker_id} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <Link href={`/dt-purchases?banker=${encodeURIComponent(b.banker_id)}`} className="font-medium text-[color:var(--color-brand)] hover:underline">
                          {b.banker_id}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{b.dt_purchased.toLocaleString("en-IN")}</td>
                      <td className="py-2 pr-4">{formatAmount(b.advance_debit)}</td>
                      <td className="py-2 pr-4">{b.purchases} ({b.active})</td>
                      <td className="py-2 pr-4">{formatAmount(b.traffic_quota)}</td>
                      <td className="py-2 pr-4">{formatAmount(b.consumed)}</td>
                      <td className="py-2 pr-4">
                        <span className={b.traffic_quota > 0 && b.available / b.traffic_quota <= 0.2 ? "font-medium text-[color:var(--color-danger)]" : ""}>
                          {formatAmount(b.available)}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        {formatAmount(b.reserve_held)}
                        <span className="ml-1 text-xs text-[color:var(--color-text-muted)]">({b.reserve_dt.toLocaleString("en-IN")} DT)</span>
                      </td>
                      <td className="py-2">
                        {b.open_refills > 0
                          ? <Link href="/dt-refills" className="inline-flex"><Badge variant="warning">{b.open_refills} open</Badge></Link>
                          : <span className="text-[color:var(--color-text-muted)]">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending refill requests — raised by bankers from the banker portal */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Droplets className="h-4 w-4" /> Pending refill requests</CardTitle>
              <CardDescription>Raised by bankers (or auto on exhaustion). Fund and verify them on the DT Refills screen.</CardDescription>
            </div>
            <Link href="/dt-refills" className="inline-flex items-center gap-1 text-sm font-medium text-[color:var(--color-brand)] hover:underline">
              Open DT Refills <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {!q.data?.open_refills?.length ? (
            <p className="text-sm text-[color:var(--color-text-muted)]">No open refill requests.</p>
          ) : (
            <ul className="divide-y">
              {q.data.open_refills.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                  <span className="font-medium">{r.banker_id}</span>
                  <span>{r.quantity != null ? `${r.quantity.toLocaleString("en-IN")} DT` : "qty —"}</span>
                  <Badge variant={r.status === "OPEN" ? "warning" : "info"}>{r.status}</Badge>
                  <span className="text-xs text-[color:var(--color-text-muted)]">by {r.created_by || "—"} · {new Date(r.created_at).toLocaleString("en-IN")}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-[color:var(--color-text-subtle)]">
        Commission figures populate once Phase 3 (routing consumption + waterfall) is enabled. Purchases, quota and reserve are live now.
      </p>
    </>
  );
}
