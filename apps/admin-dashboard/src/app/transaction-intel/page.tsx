"use client";

// Transaction Reconciliation & Forensic Security console (per the architecture doc).
// One screen for the three operating roles:
//   • Operations — work the Manual Cases queue (confirm / reject pay-ins).
//   • Risk       — review Security Alerts (replay, SIM-swap, fake-sender, devices).
//   • Super-admin— enrol/trust forwarder Devices.
// Plus the live raw-alert stream. Presentation over /api/v1/recon/*.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, RefreshCw, CheckCircle2, XCircle, Smartphone, Eye, EyeOff, ShieldCheck, Ban } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { EmptyState } from "@/components/world-class/empty-state";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Summary {
  counts: { cases_open: number; alerts_open: number; devices_trusted: number; confirmed_24h: number };
  cases: any[];
  security: any[];
  devices: any[];
  recent: any[];
}

const sevVariant = (s: string): "danger" | "warning" | "info" | "default" =>
  s === "CRITICAL" || s === "HIGH" ? "danger" : s === "MEDIUM" ? "warning" : "info";
const outcomeVariant = (o: string): "success" | "danger" | "warning" | "default" =>
  o === "CONFIRMED" ? "success" : o === "DUPLICATE" || o === "REJECTED" ? "danger" : o === "AMBIGUOUS" || o === "UNMATCHED" ? "warning" : "default";
const deviceVariant = (s: string): "success" | "danger" | "warning" | "default" =>
  s === "TRUSTED" ? "success" : s === "SUSPENDED" || s === "REVOKED" ? "danger" : "warning";

const MUTED = "text-[color:var(--color-text-muted)]";

export default function TransactionIntelConsole() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["recon-summary"],
    queryFn: async () => {
      const r = await fetch("/api/v1/recon/summary");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as Summary;
    },
    refetchInterval: 15_000,
  });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["recon-summary"] });

  const post = async (url: string, body: any, ok: string) => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed");
      toast.success(ok);
      refresh();
    } catch (e) { toast.error("Failed", { description: (e as Error).message }); }
  };

  const resolveCase = (id: string, action: "CONFIRM" | "REJECT") => {
    const utr = action === "CONFIRM" ? (window.prompt("UTR / bank reference (optional):") ?? undefined) : undefined;
    post(`/api/v1/recon/cases/${id}`, { action, utr: utr || undefined }, action === "CONFIRM" ? "Order confirmed paid" : "Case rejected");
  };
  const reviewAlert = (id: string, action: "REVIEW" | "DISMISS") =>
    post(`/api/v1/recon/security/${id}`, { action }, action === "REVIEW" ? "Alert marked reviewed" : "Alert dismissed");
  const setDevice = (device_id: string, status: string) =>
    post("/api/v1/recon/devices", { device_id, status }, `Device ${status.toLowerCase()}`);

  const cases = d?.cases ?? [];
  const security = d?.security ?? [];
  const devices = d?.devices ?? [];
  const recent = d?.recent ?? [];

  return (
    <>
      <PageHeader
        title="Transaction Intel"
        description="SMS/Email reconciliation & forensic security — manual cases, security alerts, forwarder devices."
        icon={ShieldAlert}
        actions={<Button variant="secondary" onClick={refresh}><RefreshCw className="h-4 w-4" /> Refresh</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Open manual cases" value={String(d?.counts.cases_open ?? 0)} />
        <KpiTile label="Open security alerts" value={String(d?.counts.alerts_open ?? 0)} />
        <KpiTile label="Trusted devices" value={String(d?.counts.devices_trusted ?? 0)} />
        <KpiTile label="Confirmed (24h)" value={String(d?.counts.confirmed_24h ?? 0)} />
      </div>

      <Tabs defaultValue="cases">
        <TabsList className="h-auto flex-wrap gap-y-1">
          <TabsTrigger value="cases">Manual cases <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{cases.length}</span></TabsTrigger>
          <TabsTrigger value="security">Security alerts <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{security.length}</span></TabsTrigger>
          <TabsTrigger value="devices">Devices <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{devices.length}</span></TabsTrigger>
          <TabsTrigger value="recent">Recent alerts</TabsTrigger>
        </TabsList>

        {/* Manual cases */}
        <TabsContent value="cases">
          <Card><CardContent className="p-0">
            {cases.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="No open cases" description="Every alert auto-confirmed or was handled." />
            ) : (
              <ul className="divide-y">
                {cases.map((c) => (
                  <li key={c.case_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="warning">{c.reason}</Badge>
                        {c.order_ref ? <span className="font-mono text-xs">{c.order_ref}</span> : <span className={`text-xs ${MUTED}`}>no order</span>}
                        <span className="tabular-nums text-sm">{formatAmount(c.expected_amount)}</span>
                        <Badge variant={c.confidence >= 90 ? "success" : c.confidence >= 75 ? "warning" : "danger"}>conf {c.confidence}</Badge>
                        {c.device_id && <Badge variant={deviceVariant(c.device_status ?? "UNKNOWN")}><Smartphone className="mr-1 h-3 w-3" />{c.device_id}</Badge>}
                      </div>
                      <div className={`mt-1 text-xs ${MUTED}`}>{c.detail} · {formatDateTime(c.created_at)}{c.last_heartbeat ? ` · last heartbeat ${formatDateTime(c.last_heartbeat)}` : " · no heartbeat"}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => resolveCase(c.case_id, "REJECT")}><XCircle className="h-4 w-4" /> Reject</Button>
                      <Button size="sm" onClick={() => resolveCase(c.case_id, "CONFIRM")} disabled={!c.order_ref}><CheckCircle2 className="h-4 w-4" /> Confirm paid</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>

        {/* Security alerts */}
        <TabsContent value="security">
          <Card><CardContent className="p-0">
            {security.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="No open security alerts" description="No replay, SIM-swap, fake-sender or device anomalies." />
            ) : (
              <ul className="divide-y">
                {security.map((a) => (
                  <li key={a.alert_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={sevVariant(a.severity)}>{a.severity}</Badge>
                        <span className="text-sm font-medium">{a.risk_type}</span>
                        {a.device_id && <Badge variant="default"><Smartphone className="mr-1 h-3 w-3" />{a.device_id}</Badge>}
                      </div>
                      <div className={`mt-1 text-xs ${MUTED}`}>{a.detail} · {formatDateTime(a.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => reviewAlert(a.alert_id, "DISMISS")}><EyeOff className="h-4 w-4" /> Dismiss</Button>
                      <Button size="sm" onClick={() => reviewAlert(a.alert_id, "REVIEW")}><Eye className="h-4 w-4" /> Mark reviewed</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>

        {/* Devices */}
        <TabsContent value="devices">
          <Card><CardContent className="p-0">
            {devices.length === 0 ? (
              <EmptyState icon={Smartphone} title="No devices yet" description="Forwarder devices appear here on their first alert or heartbeat." />
            ) : (
              <ul className="divide-y">
                {devices.map((dev) => (
                  <li key={dev.device_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{dev.device_id}</span>
                        <Badge variant={deviceVariant(dev.status)}>{dev.status}</Badge>
                        {dev.label && <span className={`text-xs ${MUTED}`}>{dev.label}</span>}
                      </div>
                      <div className={`mt-1 text-xs ${MUTED}`}>
                        {dev.merchant_id || "no merchant"}{dev.sim_id ? ` · SIM ${dev.sim_id}` : ""} · {dev.last_heartbeat ? `last heartbeat ${formatDateTime(dev.last_heartbeat)}` : "no heartbeat"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {dev.status !== "TRUSTED"
                        ? <Button size="sm" onClick={() => setDevice(dev.device_id, "TRUSTED")}><ShieldCheck className="h-4 w-4" /> Trust</Button>
                        : <Button size="sm" variant="secondary" onClick={() => setDevice(dev.device_id, "SUSPENDED")}><Ban className="h-4 w-4" /> Suspend</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>

        {/* Recent raw alerts */}
        <TabsContent value="recent">
          <Card><CardContent className="p-0">
            {recent.length === 0 ? (
              <EmptyState icon={RefreshCw} title="No alerts yet" description="Forwarded bank-credit alerts will stream here." />
            ) : (
              <ul className="divide-y">
                {recent.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={outcomeVariant(a.outcome)}>{a.outcome}</Badge>
                        <span className="tabular-nums text-sm">{formatAmount(a.amount)}</span>
                        {a.utr && <span className="font-mono text-xs">{a.utr}</span>}
                        <Badge variant="default">{a.source}</Badge>
                        {a.bank && <span className={`text-xs ${MUTED}`}>{a.bank}</span>}
                        {(a.payer_name || a.payer_vpa) && <span className="text-xs">from {a.payer_name || a.payer_vpa}</span>}
                        <Badge variant={deviceVariant(a.device_status ?? "UNKNOWN")}>{a.device_status ?? "—"}</Badge>
                      </div>
                      <div className={`mt-1 text-xs ${MUTED}`}>{a.detail} · conf {a.match_confidence} · {formatDateTime(a.created_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
