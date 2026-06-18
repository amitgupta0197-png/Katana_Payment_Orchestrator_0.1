"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Search, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Case {
  case_id: string; entity_type: string; entity_id: string; source: string;
  severity: string; status: string; summary: string; decision_notes: string;
  opened_at: string; opened_by: string; decided_at: string | null; decided_by: string;
  assigned_to: string; evidence: any[];
}

interface ScreeningResult {
  run_id: string; decision: "CLEAR" | "REVIEW" | "BLOCK"; case_id: string | null;
  sanctions_hit: boolean; pep_hit: boolean;
  hits: { source: string; full_name: string; match_kind: "SANCTIONS" | "PEP"; reason?: string; country?: string }[];
}

function ScreeningForm() {
  const qc = useQueryClient();
  const [entityType, setEntityType] = useState("merchant");
  const [entityId, setEntityId] = useState("MCH-DEMO");
  const [fullName, setFullName] = useState("Ivan Petrov");
  const [country, setCountry] = useState("");
  const [result, setResult] = useState<ScreeningResult | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/risk/screen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, full_name: fullName, country: country || undefined }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as ScreeningResult;
    },
    onSuccess: (b) => {
      setResult(b);
      qc.invalidateQueries({ queryKey: ["aml-cases"] });
      toast.success(b.decision === "CLEAR" ? "Clean — no hits" : `${b.decision}: ${b.hits.length} hit(s)${b.case_id ? " · case opened" : ""}`);
    },
    onError: (e: Error) => toast.error("Screening failed", { description: e.message }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Search className="h-4 w-4" /> Sanctions / PEP lookup</CardTitle>
        <CardDescription>Run a one-off check against the on-platform sanctions + PEP lists. Hits auto-open an AML case.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div><Label>Entity type</Label>
            <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                    value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="merchant">merchant</option>
              <option value="beneficiary">beneficiary</option>
              <option value="customer">customer</option>
              <option value="director">director</option>
              <option value="payout">payout</option>
            </select>
          </div>
          <div><Label>Entity ID</Label><Input value={entityId} onChange={(e) => setEntityId(e.target.value)} /></div>
          <div><Label>Full name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div><Label>Country (ISO-2)</Label><Input value={country} onChange={(e) => setCountry(e.target.value)} /></div>
        </div>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          <Search className="h-4 w-4" /> {m.isPending ? "Screening…" : "Screen"}
        </Button>

        {result && (
          <div className="space-y-2 pt-3 border-t">
            <div className="flex items-center gap-2">
              <span>Decision:</span>
              <Badge variant={result.decision === "CLEAR" ? "success" : result.decision === "REVIEW" ? "warning" : "danger"}>
                {result.decision}
              </Badge>
              {result.case_id && (
                <span className="text-xs text-[color:var(--color-text-muted)]">case <span className="font-mono">{result.case_id.slice(0,8)}</span> opened</span>
              )}
            </div>
            {result.hits.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {result.hits.map((h, i) => (
                  <li key={i} className="rounded border px-3 py-2 flex items-center gap-2">
                    <Badge variant={h.match_kind === "SANCTIONS" ? "danger" : "warning"}>{h.match_kind}</Badge>
                    <span className="font-mono text-xs">{h.source}</span>
                    <span className="font-semibold">{h.full_name}</span>
                    {h.country && <span className="text-xs text-[color:var(--color-text-muted)]">· {h.country}</span>}
                    {h.reason && <span className="text-xs text-[color:var(--color-text-muted)]">· {h.reason}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-[color:var(--color-text-muted)] flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" /> No hits.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecideButton({ row, status, label, variant }: { row: Case; status: string; label: string; variant: "default" | "danger" | "secondary" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/risk/cases/${row.case_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, decision_notes: `${label} via UI` }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success(`Case → ${status}`); qc.invalidateQueries({ queryKey: ["aml-cases"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return <Button size="sm" variant={variant} onClick={() => m.mutate()} disabled={m.isPending}>{label}</Button>;
}

export default function AmlCasesPage() {
  const q = useQuery({
    queryKey: ["aml-cases"],
    queryFn: async () => (await fetch("/api/risk/cases").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { cases: Case[] },
    refetchInterval: 6000,
  });
  const cases = q.data?.cases ?? [];
  const open = cases.filter((c) => c.status === "OPEN" || c.status === "UNDER_REVIEW" || c.status === "ESCALATED");
  const closed = cases.filter((c) => c.status.startsWith("CLOSED"));

  const cols: Column<Case>[] = [
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "severity", header: "Sev", render: (r) => <Badge variant={r.severity === "CRITICAL" ? "danger" : r.severity === "HIGH" ? "warning" : "default"}>{r.severity}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "source", header: "Source" },
    { key: "entity_id", header: "Entity", render: (r) => <span className="font-mono text-xs">{r.entity_type}/{r.entity_id}</span> },
    { key: "summary", header: "Summary" },
    { key: "opened_by", header: "Opened by", render: (r) => r.opened_by || "—" },
    { key: "case_id", header: "Decide", render: (r) => (
      r.status.startsWith("CLOSED") ? <span className="text-xs text-[color:var(--color-text-muted)]">decided {r.decided_at ? formatDateTime(r.decided_at) : "—"}</span> :
      <div className="flex gap-1">
        <DecideButton row={r} status="CLOSED_CLEARED" label="Clear" variant="default" />
        <DecideButton row={r} status="CLOSED_BLOCKED" label="Block" variant="danger" />
        <DecideButton row={r} status="ESCALATED" label="Escalate" variant="secondary" />
      </div>
    )},
  ];

  return (
    <>
      <PageHeader
        title="AML cases"
        description="Sanctions / PEP / velocity / manual cases. Decisions write to WORM (BRD §9)."
        icon={ShieldAlert}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={open.length > 0 ? "warning" : "default"}><AlertTriangle className="h-3 w-3" /> {open.length} open</Badge>
            <Badge variant="default">{closed.length} closed</Badge>
          </div>
        }
      />

      <div className="mb-4"><ScreeningForm /></div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Open & escalated ({open.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={open} rowKey={(r) => r.case_id} emptyState="No open cases. Sanctions / PEP hits open cases automatically." /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recently closed ({closed.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={closed.slice(0, 50)} rowKey={(r) => r.case_id} emptyState="No closed cases yet." /></CardContent>
      </Card>
    </>
  );
}
