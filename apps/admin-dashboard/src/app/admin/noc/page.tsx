"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Gauge, AlertTriangle, ShieldCheck, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface SloTarget {
  target_id: string; name: string; description: string; metric_kind: string;
  target_value: number; comparison: string; window_minutes: number; burn_rate_alert: number;
}
interface SloResult {
  target: SloTarget; measured: number; status: "OK" | "WARN" | "BREACH";
  burn_rate: number; detail: Record<string, unknown>; evaluated_at: string;
}
interface Incident {
  incident_id: string; severity: string; status: string; source: string;
  title: string; summary: string; opened_at: string; opened_by: string;
  acked_at: string | null; resolved_at: string | null; resolved_by: string;
}

function fmtMeasured(r: SloResult): string {
  switch (r.target.metric_kind) {
    case "availability":
    case "webhook_in_sla":
    case "partner_sync":
    case "auto_match_pct":
      return (r.measured * 100).toFixed(2) + "%";
    case "latency_p95_ms":
      return Math.round(r.measured) + " ms";
    default: return String(r.measured);
  }
}
function fmtTarget(t: SloTarget): string {
  switch (t.metric_kind) {
    case "availability":
    case "webhook_in_sla":
    case "partner_sync":
    case "auto_match_pct":
      return `${t.comparison} ${(t.target_value * 100).toFixed(2)}%`;
    case "latency_p95_ms":
      return `${t.comparison} ${t.target_value} ms`;
    default: return `${t.comparison} ${t.target_value}`;
  }
}
function badge(status: string): "success" | "warning" | "danger" | "default" {
  if (status === "OK") return "success";
  if (status === "WARN") return "warning";
  if (status === "BREACH") return "danger";
  return "default";
}

function IncidentAction({ row, to, label, variant }: { row: Incident; to: string; label: string; variant: "default" | "danger" | "secondary" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/incidents/${row.incident_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, notes: `${label} via NOC` }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success(`Incident → ${to}`); qc.invalidateQueries({ queryKey: ["incidents"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return <Button size="sm" variant={variant} onClick={() => m.mutate()} disabled={m.isPending}>{label}</Button>;
}

function ReconButton() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/recon/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (b) => { toast.success(`Recon: ${b.matched_3way}/${b.matched_2way}/${b.matched_fuzzy} matched, ${b.breaks_opened} breaks`); qc.invalidateQueries({ queryKey: ["slos"] }); qc.invalidateQueries({ queryKey: ["incidents"] }); },
    onError: (e: Error) => toast.error("Recon failed", { description: e.message }),
  });
  return <Button size="sm" onClick={() => m.mutate()} disabled={m.isPending}><PlayCircle className="h-4 w-4" /> Run recon</Button>;
}

export default function NocPage() {
  const sQ = useQuery({
    queryKey: ["slos"],
    queryFn: async () => (await fetch("/api/admin/slos").then((r) => r.json())) as { slos: SloResult[]; history: any[] },
    refetchInterval: 5000,
  });
  const iQ = useQuery({
    queryKey: ["incidents"],
    queryFn: async () => (await fetch("/api/admin/incidents").then((r) => r.json())) as { incidents: Incident[] },
    refetchInterval: 5000,
  });
  const breaksQ = useQuery({
    queryKey: ["recon-breaks"],
    queryFn: async () => (await fetch("/api/recon/breaks").then((r) => r.json())) as { breaks: any[]; summary: { ageing_bucket: string; count: number }[] },
    refetchInterval: 8000,
  });

  const slos = sQ.data?.slos ?? [];
  const incidents = iQ.data?.incidents ?? [];
  const breakSummary = new Map(breaksQ.data?.summary?.map((s) => [s.ageing_bucket, s.count]) ?? []);
  const openIncidents = incidents.filter(i => ["OPEN","INVESTIGATING","MITIGATING"].includes(i.status));
  const breachCount = slos.filter(s => s.status === "BREACH").length;
  const warnCount   = slos.filter(s => s.status === "WARN").length;

  const incidentCols: Column<Incident>[] = [
    { key: "severity", header: "Sev", render: (r) => <Badge variant={r.severity === "SEV1" ? "danger" : r.severity === "SEV2" ? "warning" : "default"}>{r.severity}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "source", header: "Source" },
    { key: "title", header: "Title" },
    { key: "summary", header: "Summary" },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "incident_id", header: "Action", render: (r) => {
      if (r.status === "RESOLVED" || r.status === "POST_MORTEM")
        return <span className="text-xs text-[color:var(--color-text-muted)]">{r.resolved_at ? formatDateTime(r.resolved_at) : "—"}</span>;
      return (
        <div className="flex gap-1">
          {r.status === "OPEN" && <IncidentAction row={r} to="INVESTIGATING" label="Ack" variant="secondary" />}
          {r.status !== "MITIGATING" && r.status !== "RESOLVED" && <IncidentAction row={r} to="MITIGATING" label="Mitigate" variant="secondary" />}
          <IncidentAction row={r} to="RESOLVED" label="Resolve" variant="default" />
        </div>
      );
    }},
  ];

  return (
    <>
      <PageHeader
        title="NOC cockpit"
        description="Live SLOs, incidents and reconciliation health (BRD §13 P9)."
        icon={Activity}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={breachCount > 0 ? "danger" : "default"}>{breachCount} BREACH</Badge>
            <Badge variant={warnCount > 0 ? "warning" : "default"}>{warnCount} WARN</Badge>
            <Badge variant={openIncidents.length > 0 ? "warning" : "success"}><AlertTriangle className="h-3 w-3" /> {openIncidents.length} open</Badge>
            <ReconButton />
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        {slos.map((r) => (
          <Card key={r.target.target_id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>{r.target.name}</CardDescription>
                <Badge variant={badge(r.status)}>{r.status}</Badge>
              </div>
              <CardTitle className="text-xl flex items-center gap-2">
                <Gauge className="h-4 w-4" /> {fmtMeasured(r)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-1 text-[color:var(--color-text-muted)]">
              <div>target {fmtTarget(r.target)}</div>
              <div>burn rate {r.burn_rate.toFixed(2)}× over {r.target.window_minutes}m</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Reconciliation ageing buckets</CardTitle>
          <CardDescription>Open breaks by ageing window (BRD §11 P7).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(["0-24h","1-3d","3-7d","7d+"] as const).map((b) => {
              const n = breakSummary.get(b) ?? 0;
              const variant = b === "7d+" ? "danger" : b === "3-7d" ? "warning" : "default";
              return (
                <Card key={b}>
                  <CardHeader className="pb-2"><CardDescription>{b}</CardDescription><CardTitle className="text-2xl">{n}</CardTitle></CardHeader>
                  <CardContent><Badge variant={variant}>{n > 0 ? "breaks" : "clean"}</Badge></CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Active incidents ({openIncidents.length})
          </CardTitle>
          <CardDescription>Auto-opened on SLO breach. Ack / Mitigate / Resolve. WORM-logged.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={incidentCols} rows={openIncidents} rowKey={(r) => r.incident_id} emptyState="All clear." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Recent resolved</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={incidentCols}
            rows={incidents.filter(i => i.status === "RESOLVED" || i.status === "POST_MORTEM").slice(0, 50)}
            rowKey={(r) => r.incident_id}
            emptyState="No resolved incidents yet."
          />
        </CardContent>
      </Card>
    </>
  );
}
