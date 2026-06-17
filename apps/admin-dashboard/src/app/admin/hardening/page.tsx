"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, PlayCircle, FileCheck2, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

interface Check { check_id: string; code: string; area: string; name: string; description: string; target_value: string; status: string; current_value: string; last_checked_at: string | null }
interface Drill { drill_id: string; kind: string; status: string; rto_observed_minutes: number | null; rpo_observed_seconds: number | null; notes: string; ran_by: string; started_at: string; completed_at: string | null }
interface Report { provider: string; passed: number; failed: number; checks: { name: string; ok: boolean; reason?: string }[] }

function statusBadge(s: string): "success" | "warning" | "danger" | "default" {
  if (s === "READY" || s === "PASSED") return "success";
  if (s === "WARN") return "warning";
  if (s === "NOT_READY" || s === "FAILED") return "danger";
  return "default";
}

export default function HardeningPage() {
  const qc = useQueryClient();
  const hQ = useQuery({
    queryKey: ["hardening"],
    queryFn: async () => (await fetch("/api/admin/hardening").then((r) => r.json())) as { checks: Check[]; summary: { total: number; score: number; buckets: Record<string, number> } },
    refetchInterval: 15000,
  });
  const dQ = useQuery({
    queryKey: ["drills"],
    queryFn: async () => (await fetch("/api/admin/dr").then((r) => r.json())) as { drills: Drill[] },
  });

  const [drillKind, setDrillKind] = useState("backup_restore");
  const [rto, setRto] = useState("45");
  const [rpo, setRpo] = useState("30");

  const drill = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/dr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        kind: drillKind, status: "PASSED",
        rto_target_minutes: 60, rpo_target_seconds: 60,
        rto_observed_minutes: Number(rto), rpo_observed_seconds: Number(rpo),
        notes: "S9 drill via UI",
      }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success("Drill recorded"); qc.invalidateQueries({ queryKey: ["hardening"] }); qc.invalidateQueries({ queryKey: ["drills"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const [report, setReport] = useState<{ reports: Report[]; all_passed: boolean } | null>(null);
  const contracts = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/contract-tests", { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { reports: Report[]; all_passed: boolean };
    },
    onSuccess: (b) => {
      setReport(b);
      qc.invalidateQueries({ queryKey: ["hardening"] });
      toast.success(b.all_passed ? "All contract tests passed" : `Failures across ${b.reports.filter(r => r.failed).length} providers`);
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const checks = hQ.data?.checks ?? [];
  const summary = hQ.data?.summary;
  const byArea = checks.reduce<Record<string, Check[]>>((acc, c) => {
    (acc[c.area] ??= []).push(c); return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Production hardening"
        description="BRD §20 (DR) + §22 (test areas). Score = % of READY checks, half-credit for WARN."
        icon={ShieldCheck}
        actions={
          <div className="flex items-center gap-2">
            {summary && <>
              <Badge variant="success">{summary.buckets.READY} READY</Badge>
              <Badge variant="warning">{summary.buckets.WARN} WARN</Badge>
              <Badge variant="danger">{summary.buckets.NOT_READY} NOT_READY</Badge>
              <Badge variant="brand">score {Math.round(summary.score * 100)}%</Badge>
            </>}
            <Button onClick={() => contracts.mutate()} disabled={contracts.isPending}>
              <PlayCircle className="h-4 w-4" /> Run contract tests
            </Button>
          </div>
        }
      />

      {Object.keys(byArea).sort().map(area => (
        <Card key={area} className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">{area} ({byArea[area].length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {byArea[area].map(c => (
                <div key={c.check_id} className="flex items-start gap-2 rounded border p-2 text-sm">
                  <Badge variant={statusBadge(c.status)}>{c.status}</Badge>
                  <div className="flex-1">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-[color:var(--color-text-muted)]">{c.description}</div>
                  </div>
                  <div className="text-right text-xs">
                    <div>{c.current_value ?? "—"}</div>
                    <div className="text-[color:var(--color-text-muted)]">target {c.target_value}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileCheck2 className="h-4 w-4" /> Record DR drill</CardTitle>
          <CardDescription>BRD §20 — backup restore, chaos, failover, queue recovery.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><Label>Kind</Label>
              <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={drillKind} onChange={(e) => setDrillKind(e.target.value)}>
                <option value="backup_restore">backup_restore</option>
                <option value="chaos">chaos</option>
                <option value="failover">failover</option>
                <option value="queue_recovery">queue_recovery</option>
              </select>
            </div>
            <div><Label>RTO observed (min)</Label><Input value={rto} onChange={(e) => setRto(e.target.value)} /></div>
            <div><Label>RPO observed (sec)</Label><Input value={rpo} onChange={(e) => setRpo(e.target.value)} /></div>
          </div>
          <Button onClick={() => drill.mutate()} disabled={drill.isPending}><Plus className="h-4 w-4" /> Record PASSED drill</Button>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Drill log ({(dQ.data?.drills ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "started_at", header: "When", render: (r) => formatDateTime(r.started_at) },
              { key: "kind", header: "Kind" },
              { key: "status", header: "Status", render: (r) => <Badge variant={statusBadge(r.status)}>{r.status}</Badge> },
              { key: "rto_observed_minutes", header: "RTO m" },
              { key: "rpo_observed_seconds", header: "RPO s" },
              { key: "ran_by", header: "By" },
              { key: "notes", header: "Notes" },
            ] as Column<Drill>[]}
            rows={dQ.data?.drills ?? []}
            rowKey={(r) => r.drill_id}
            emptyState="No drills recorded yet."
          />
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Badge variant={report.all_passed ? "success" : "danger"}>{report.all_passed ? "ALL PASS" : "FAILURES"}</Badge>
              Contract test report
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.reports.map((r: Report) => (
              <div key={r.provider} className="rounded border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant={r.failed ? "danger" : "success"}>{r.provider}</Badge>
                  <span className="text-xs">{r.passed} passed · {r.failed} failed</span>
                </div>
                {r.failed > 0 && (
                  <ul className="text-xs mt-1 space-y-0.5">
                    {r.checks.filter(c => !c.ok).map((c, i) => (
                      <li key={i} className="text-[color:var(--color-danger)]">✗ {c.name}: {c.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
