"use client";

// Gateway health (lib/gateway-performance): one row per pay-in gateway over the last 24 hours,
// with the three conditions ops is alerted on. STAFF ONLY — this page names gateways.

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface Row {
  gateway_name: string; orders_last_24h: number; pct_confirmed: number | null; median_confirm_latency_minutes: number | null;
  webhooks_received_last_24h: number; pct_revived_after_expiry: number | null; last_webhook_at: string | null; alerts: string[];
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);
const ago = (v: string | null) => {
  if (!v) return "never";
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export default function GatewayHealthPage() {
  const q = useQuery({
    queryKey: ["ops:gateway-health"],
    queryFn: async () => {
      const r = await fetch("/api/ops/gateway-health");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { gateways: Row[]; alert_text: Record<string, string>; as_of: string };
    },
    refetchInterval: 60_000,
  });
  const rows = q.data?.gateways ?? [];
  const alerting = rows.filter((g) => g.alerts.length);

  return (
    <div>
      <PageHeader title="Gateway health" icon={Activity}
        description="Live orders of the last 24 hours per gateway, and the webhooks each gateway actually sent. Refreshes every minute; alerts go to the admin chats every five." />

      {alerting.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-[color:var(--color-danger)]"><AlertTriangle className="h-4 w-4" /> {alerting.length} gateway{alerting.length === 1 ? "" : "s"} need attention</div>
          <ul className="mt-1 space-y-0.5">
            {alerting.flatMap((g) => g.alerts.map((a) => <li key={g.gateway_name + a}><span className="font-medium">{g.gateway_name}</span>: {q.data?.alert_text[a] ?? a}</li>))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gateways</CardTitle>
          <CardDescription>{q.data ? `As of ${formatDateTime(q.data.as_of)}` : " "}</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : rows.length === 0 ? <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No gateway took a live order or sent a webhook yet.</p>
            : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                    <tr>
                      <th className="px-3 py-2 font-medium">Gateway</th>
                      <th className="px-3 py-2 text-right font-medium">Orders 24h</th>
                      <th className="px-3 py-2 text-right font-medium">Confirmed</th>
                      <th className="px-3 py-2 text-right font-medium">Median confirm</th>
                      <th className="px-3 py-2 text-right font-medium">Webhooks 24h</th>
                      <th className="px-3 py-2 text-right font-medium">Paid after expiry</th>
                      <th className="px-3 py-2 font-medium">Last webhook</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => (
                      <tr key={g.gateway_name} className="border-t border-[color:var(--color-border)]">
                        <td className="px-3 py-2 font-medium">{g.gateway_name}{g.alerts.length > 0 && <Badge variant="danger" className="ml-2">{g.alerts.length} alert{g.alerts.length === 1 ? "" : "s"}</Badge>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{g.orders_last_24h}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(g.pct_confirmed)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${g.alerts.includes("SLOW_CONFIRMATION") ? "font-medium text-[color:var(--color-danger)]" : ""}`}>{g.median_confirm_latency_minutes == null ? "—" : `${g.median_confirm_latency_minutes} min`}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${g.alerts.includes("NO_WEBHOOK") ? "font-medium text-[color:var(--color-danger)]" : ""}`}>{g.webhooks_received_last_24h}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${g.alerts.includes("HIGH_REVIVAL") ? "font-medium text-[color:var(--color-danger)]" : ""}`}>{pct(g.pct_revived_after_expiry)}</td>
                        <td className="px-3 py-2" title={g.last_webhook_at ? formatDateTime(g.last_webhook_at) : undefined}>{ago(g.last_webhook_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
