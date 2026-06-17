"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow, Zap, FlaskConical, Play, Power, AlertTriangle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

interface Rail {
  provider: string; method: string; direction: string;
  enabled: boolean; kill_switch: boolean; mdr_bps: number;
  kill_switch_reason: string; kill_switch_at: string | null; kill_switch_by: string;
}
interface Health {
  provider_code: string; success_rate: number; p95_latency_ms: number;
  failure_rate: number; utilization: number; circuit_state: string;
  consecutive_failures: number; circuit_opened_at: string | null;
  last_failure_at: string | null; last_success_at: string | null;
  updated_at: string;
}
interface CircuitConfig { threshold: number; cooldown_seconds: number }
interface SimResult {
  candidates: { rank: number; provider: string; score: number; reasoning: string; factors: Record<string, number> }[];
  excluded: { provider: string; method: string; reason: string }[];
  experiment: { id: string; name: string; bucket: "CONTROL" | "VARIANT" } | null;
  weights_applied: Record<string, number>;
}
interface Experiment {
  experiment_id: string; name: string; description: string;
  traffic_split: number; method_scope: string | null;
  enabled: boolean; started_at: string | null; ended_at: string | null;
  control_weights: Record<string, number>; variant_weights: Record<string, number>;
}
interface ExperimentStat { experiment_id: string; experiment_bucket: string; picks: number; avg_score: number }

function badge(state: string): "success" | "warning" | "danger" | "default" {
  if (state === "CLOSED") return "success";
  if (state === "HALF_OPEN") return "warning";
  if (state === "OPEN") return "danger";
  return "default";
}

function KillSwitchToggle({ rail }: { rail: Rail }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/routing/kill-switch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: rail.provider, method: rail.method, direction: rail.direction,
          on: !rail.kill_switch, reason: reason || undefined,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => {
      toast.success(rail.kill_switch ? "Rail re-enabled" : "Rail killed");
      qc.invalidateQueries({ queryKey: ["routing-health"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return rail.kill_switch ? (
    <Button size="sm" variant="secondary" onClick={() => m.mutate()} disabled={m.isPending}>
      <Zap className="h-4 w-4" /> Re-enable
    </Button>
  ) : (
    <Button size="sm" variant="danger" onClick={() => m.mutate()} disabled={m.isPending}>
      <Power className="h-4 w-4" /> Kill
    </Button>
  );
}

function CircuitAction({ provider, label, action, variant }: { provider: string; label: string; action: "reset" | "trip"; variant: "default" | "secondary" | "danger" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/routing/circuit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, action }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (b) => { toast.success(`${provider} → ${b.circuit_state}`); qc.invalidateQueries({ queryKey: ["routing-health"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Button size="sm" variant={variant} onClick={() => m.mutate()} disabled={m.isPending}>
      {action === "reset" ? <RotateCcw className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {label}
    </Button>
  );
}

function Simulator() {
  const [method, setMethod] = useState("UPI_INTENT");
  const [amount, setAmount] = useState("1000");
  const [currency, setCurrency] = useState("INR");
  const [merchantId, setMerchantId] = useState("tenant-default");
  const [result, setResult] = useState<SimResult | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/routing/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, amount, currency, merchant_id: merchantId }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as SimResult;
    },
    onSuccess: (b) => { setResult(b); toast.success(`Simulator: ${b.candidates.length} candidates, ${b.excluded.length} excluded`); },
    onError: (e: Error) => toast.error("Simulator failed", { description: e.message }),
  });

  const cols: Column<SimResult["candidates"][0]>[] = [
    { key: "rank", header: "#" },
    { key: "provider", header: "Provider", render: (r) => <Badge variant={r.rank === 1 ? "success" : "brand"}>{r.provider}</Badge> },
    { key: "score", header: "Score" },
    { key: "reasoning", header: "Reasoning", render: (r) => <span className="font-mono text-xs">{r.reasoning}</span> },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Route simulator</CardTitle>
        <CardDescription>Dry-run pickRoute against the live config — no order created, no charge.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div><Label>Method</Label><Input value={method} onChange={(e) => setMethod(e.target.value)} /></div>
          <div><Label>Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div><Label>Currency</Label><Input value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
          <div><Label>Merchant ID</Label><Input value={merchantId} onChange={(e) => setMerchantId(e.target.value)} /></div>
        </div>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          <Play className="h-4 w-4" /> {m.isPending ? "Simulating…" : "Simulate"}
        </Button>

        {result && (
          <div className="space-y-3 pt-3 border-t">
            <DataTable columns={cols} rows={result.candidates} rowKey={(r) => `${r.rank}-${r.provider}`} emptyState="No eligible providers." />
            {result.excluded.length > 0 && (
              <div className="text-xs text-[color:var(--color-text-muted)]">
                Excluded: {result.excluded.map((e) => `${e.provider}(${e.reason})`).join(", ")}
              </div>
            )}
            {result.experiment && (
              <div className="text-xs text-[color:var(--color-text-muted)]">
                Active experiment: <span className="font-mono">{result.experiment.name}</span> → bucket <Badge variant="brand">{result.experiment.bucket}</Badge>
              </div>
            )}
            <div className="text-xs text-[color:var(--color-text-muted)]">
              Weights: <span className="font-mono">{JSON.stringify(result.weights_applied)}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Experiments() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["experiments"],
    queryFn: async () => (await fetch("/api/admin/routing/experiments").then((r) => r.json())) as { experiments: Experiment[]; stats: ExperimentStat[] },
    refetchInterval: 10000,
  });
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const r = await fetch(`/api/admin/routing/experiments?id=${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success("Experiment updated"); qc.invalidateQueries({ queryKey: ["experiments"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const statsById = new Map(q.data?.stats?.map((s) => [`${s.experiment_id}:${s.experiment_bucket}`, s]) ?? []);

  const cols: Column<Experiment>[] = [
    { key: "name", header: "Name" },
    { key: "method_scope", header: "Method", render: (r) => r.method_scope ?? "ALL" },
    { key: "traffic_split", header: "Variant %", render: (r) => `${(r.traffic_split * 100).toFixed(0)}%` },
    { key: "enabled", header: "Status", render: (r) => r.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="default">off</Badge> },
    { key: "experiment_id", header: "Picks (C/V)", render: (r) => {
      const c = statsById.get(`${r.experiment_id}:CONTROL`);
      const v = statsById.get(`${r.experiment_id}:VARIANT`);
      return <span className="font-mono text-xs">{c?.picks ?? 0} / {v?.picks ?? 0}</span>;
    }},
    { key: "started_at", header: "Started", render: (r) => r.started_at ? formatDateTime(r.started_at) : "—" },
    { key: "ended_at", header: "Ended", render: (r) => r.ended_at ? formatDateTime(r.ended_at) : "—" },
    { key: "description", header: "Toggle", render: (r) => (
      <Button size="sm" variant={r.enabled ? "secondary" : "default"} onClick={() => toggle.mutate({ id: r.experiment_id, enabled: !r.enabled })} disabled={toggle.isPending}>
        {r.enabled ? "Disable" : "Enable"}
      </Button>
    )},
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">A/B experiments ({q.data?.experiments.length ?? 0})</CardTitle>
        <CardDescription>Live experiments swap pickRoute weights for the configured traffic share.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={cols} rows={q.data?.experiments ?? []} rowKey={(r) => r.experiment_id} emptyState="No experiments. POST /api/admin/routing/experiments to create one." />
      </CardContent>
    </Card>
  );
}

export default function RoutingAdminPage() {
  const q = useQuery({
    queryKey: ["routing-health"],
    queryFn: async () => (await fetch("/api/admin/routing/health").then((r) => r.json())) as {
      rails: Rail[]; health: Health[]; circuit_config: CircuitConfig;
    },
    refetchInterval: 4000,
  });

  const healthByProvider = new Map(q.data?.health?.map((h) => [h.provider_code, h]) ?? []);

  const railCols: Column<Rail>[] = [
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "method", header: "Method" },
    { key: "direction", header: "Dir" },
    { key: "mdr_bps", header: "MDR (bps)" },
    { key: "kill_switch", header: "Kill", render: (r) => r.kill_switch ? <Badge variant="danger">KILLED</Badge> : <Badge variant="success">live</Badge> },
    { key: "kill_switch_at", header: "Killed at", render: (r) => r.kill_switch_at ? formatDateTime(r.kill_switch_at) : "—" },
    { key: "kill_switch_reason", header: "Reason", render: (r) => r.kill_switch_reason || "—" },
    { key: "kill_switch_by", header: "Toggle", render: (r) => <KillSwitchToggle rail={r} /> },
  ];

  const healthCols: Column<Health>[] = [
    { key: "provider_code", header: "Provider", render: (r) => <Badge variant="brand">{r.provider_code}</Badge> },
    { key: "circuit_state", header: "Circuit", render: (r) => <Badge variant={badge(r.circuit_state)}>{r.circuit_state}</Badge> },
    { key: "consecutive_failures", header: "Consec. failures" },
    { key: "success_rate", header: "Success %", render: (r) => (r.success_rate * 100).toFixed(2) + "%" },
    { key: "failure_rate", header: "Failure %", render: (r) => (r.failure_rate * 100).toFixed(2) + "%" },
    { key: "p95_latency_ms", header: "p95 ms" },
    { key: "utilization", header: "Util %", render: (r) => (r.utilization * 100).toFixed(0) + "%" },
    { key: "last_failure_at", header: "Last fail", render: (r) => r.last_failure_at ? formatDateTime(r.last_failure_at) : "—" },
    { key: "last_success_at", header: "Last ok", render: (r) => r.last_success_at ? formatDateTime(r.last_success_at) : "—" },
    { key: "updated_at", header: "Actions", render: (r) => (
      <div className="flex gap-1">
        <CircuitAction provider={r.provider_code} label="Reset" action="reset" variant="secondary" />
        <CircuitAction provider={r.provider_code} label="Trip" action="trip" variant="danger" />
      </div>
    )},
  ];

  const cfg = q.data?.circuit_config;
  const openCount = (q.data?.health ?? []).filter((h) => h.circuit_state === "OPEN").length;
  const killCount = (q.data?.rails ?? []).filter((r) => r.kill_switch).length;

  return (
    <>
      <PageHeader
        title="Routing cockpit"
        description={`Circuit breaker (${cfg?.threshold ?? "?"} consecutive fails → OPEN; ${cfg?.cooldown_seconds ?? "?"}s cooldown). Kill-switch, A/B experiments, simulator.`}
        icon={Workflow}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={openCount > 0 ? "danger" : "default"}>{openCount} OPEN</Badge>
            <Badge variant={killCount > 0 ? "warning" : "default"}>{killCount} killed</Badge>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Provider health & circuit ({(q.data?.health ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={healthCols} rows={(q.data?.health ?? []) as any} rowKey={(r) => r.provider_code} emptyState="No provider_health_snapshot rows." /></CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Rails ({(q.data?.rails ?? []).length})</CardTitle><CardDescription>Toggle a rail off to immediately exclude it from routing.</CardDescription></CardHeader>
        <CardContent><DataTable columns={railCols} rows={(q.data?.rails ?? []) as any} rowKey={(r) => `${r.provider}:${r.method}:${r.direction}`} emptyState="No rails configured." /></CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Simulator />
        <Experiments />
      </div>
    </>
  );
}
