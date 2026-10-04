"use client";

// Journey Tracker: every workflow instance (lib/workflow-store), grouped by actor type, with the
// step each one is at, who it waits for and its SLA. Staff only. A workflow tracks the real state
// (banker stage, TSP stage, MIDs, Maker-Checker); it never changes it.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, RefreshCw, Route } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ACTOR_LABEL, ROLE_LABEL, SlaBadge, StatusBadge, readJson, selectCls } from "@/components/workflow/common";
import { ACTOR_TYPES, WORKFLOW_ROLES, type SlaStatus } from "@/lib/workflow";
import { formatDateTime } from "@/lib/utils";

interface Row {
  id: string; template_key: string; template_name: string; actor_type: string; actor_id: string; actor_label: string | null;
  current_step_name: string | null; assigned_role: string | null; sla: SlaStatus | null; status: string;
  initiated_at: string; initiated_by: string; steps_total: number; steps_done: number;
}
interface Tpl { key: string; name: string; actor_type: string }

function StartDialog({ open, onOpenChange, templates }: { open: boolean; onOpenChange: (v: boolean) => void; templates: Tpl[] }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [key, setKey] = useState("");
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const tpl = templates.find((t) => t.key === key);
  const actors = useQuery({
    queryKey: ["workflow-actors", tpl?.actor_type, q], enabled: !!tpl,
    queryFn: async () => readJson<{ actors: { id: string; label: string }[] }>(await fetch(`/api/workflows/actors?type=${tpl!.actor_type}&q=${encodeURIComponent(q)}`)),
  });
  const m = useMutation({
    mutationFn: async () => readJson<{ id: string }>(await fetch("/api/workflows/instances", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: key, actor_id: actor }),
    })),
    onSuccess: (d) => { toast.success("Workflow started"); qc.invalidateQueries({ queryKey: ["workflows"] }); onOpenChange(false); router.push(`/journeys/${d.id}`); },
    onError: (e: Error & { code?: string }) => toast.error("Could not start it", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a workflow</DialogTitle>
          <DialogDescription>For a Key + Salt rotation, a banker suspension or a merchant&apos;s onboarding. Banker, TSP and MID onboarding start by themselves.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="space-y-1.5">
            <Label htmlFor="wf-tpl">Workflow</Label>
            <select id="wf-tpl" className={selectCls} value={key} onChange={(e) => { setKey(e.target.value); setActor(""); }}>
              <option value="">Choose…</option>
              {templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </div>
          {tpl && (
            <div className="space-y-1.5">
              <Label htmlFor="wf-actor">For</Label>
              <Input placeholder="Search by code or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
              <select id="wf-actor" className={selectCls} value={actor} onChange={(e) => setActor(e.target.value)} size={6}>
                {(actors.data?.actors ?? []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!key || !actor || m.isPending}>{m.isPending ? "Starting…" : "Start"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function JourneysPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [f, setF] = useState({ actor_type: "", template: "", role: "", sla: "", status: "IN_PROGRESS" });
  const [starting, setStarting] = useState(false);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const q = useQuery({
    queryKey: ["workflows", qs],
    queryFn: async () => readJson<{ instances: Row[]; you: { persona: string } }>(await fetch(`/api/workflows/instances?${qs}`)),
    refetchInterval: 60_000,
  });
  const tq = useQuery({ queryKey: ["workflow-templates"], queryFn: async () => readJson<{ templates: Tpl[]; can_propose: boolean }>(await fetch("/api/workflows/templates")) });
  const sync = useMutation({
    mutationFn: async () => readJson<{ started: number; moved: number; synced: number }>(await fetch("/api/workflows/sync", { method: "POST" })),
    onSuccess: (d) => { toast.success(`Synced ${d.synced}: ${d.started} started, ${d.moved} steps moved on`); qc.invalidateQueries({ queryKey: ["workflows"] }); },
    onError: (e: Error) => toast.error("Sync failed", { description: e.message }),
  });
  const list = q.data?.instances ?? [];
  const persona = q.data?.you.persona ?? "";
  const groups = useMemo(() => ACTOR_TYPES.map((t) => ({ type: t, rows: list.filter((r) => r.actor_type === t) })).filter((g) => g.rows.length), [list]);
  const counts = {
    open: list.filter((r) => r.status === "IN_PROGRESS").length,
    risk: list.filter((r) => r.sla === "AT_RISK").length,
    breached: list.filter((r) => r.sla === "BREACHED").length,
    mine: list.filter((r) => r.status === "IN_PROGRESS" && r.assigned_role === persona).length,
  };
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const columns: Column<Row>[] = [
    { key: "actor", header: "Actor", render: (r) => <span className="font-medium">{r.actor_label ?? r.actor_id}</span> },
    { key: "workflow", header: "Workflow", render: (r) => <span>{r.template_name}<span className="ml-1.5 text-xs tabular-nums text-[color:var(--color-text-muted)]">{r.steps_done}/{r.steps_total}</span></span> },
    { key: "step", header: "Current step", render: (r) => r.status === "IN_PROGRESS" ? (r.current_step_name ?? "—") : <StatusBadge status={r.status} /> },
    { key: "role", header: "Assigned role", render: (r) => r.assigned_role ? ROLE_LABEL[r.assigned_role] ?? r.assigned_role : "—" },
    { key: "sla", header: "SLA", render: (r) => <SlaBadge sla={r.sla} /> },
    { key: "started", header: "Started", className: "whitespace-nowrap", render: (r) => formatDateTime(r.initiated_at) },
  ];

  return (
    <div>
      <PageHeader title="Journey Tracker" icon={Route}
        description="Where every banker, TSP, MID and merchant is in its workflow, and who it is waiting for. Steps checked by the system follow the real state."
        actions={<>
          {tq.data?.can_propose && <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw className="h-4 w-4" /> {sync.isPending ? "Syncing…" : "Sync now"}</Button>}
          <Button onClick={() => setStarting(true)}><Plus className="h-4 w-4" /> Start workflow</Button>
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["In progress", counts.open, ""], ["Waiting for my role", counts.mine, ""], ["At risk", counts.risk, "warning"], ["SLA breached", counts.breached, "danger"]].map(([label, n, tone]) => (
          <div key={label as string} className="rounded-2xl border bg-[color:var(--color-surface)] px-3 py-2"
            style={tone && (n as number) > 0 ? { borderColor: `var(--color-${tone})` } : undefined}>
            <div className="truncate text-xs text-[color:var(--color-text-muted)]">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{q.isLoading ? "—" : n}</div>
          </div>
        ))}
      </div>

      <Card className="mb-4">
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1"><Label htmlFor="f-type">Actor</Label>
            <select id="f-type" className={selectCls} value={f.actor_type} onChange={(e) => set("actor_type", e.target.value)}>
              <option value="">All</option>{ACTOR_TYPES.map((t) => <option key={t} value={t}>{ACTOR_LABEL[t]}</option>)}
            </select></div>
          <div className="space-y-1"><Label htmlFor="f-tpl">Workflow</Label>
            <select id="f-tpl" className={selectCls} value={f.template} onChange={(e) => set("template", e.target.value)}>
              <option value="">All</option>{(tq.data?.templates ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select></div>
          <div className="space-y-1"><Label htmlFor="f-role">Assigned role</Label>
            <select id="f-role" className={selectCls} value={f.role} onChange={(e) => set("role", e.target.value)}>
              <option value="">All</option>{WORKFLOW_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select></div>
          <div className="space-y-1"><Label htmlFor="f-sla">SLA</Label>
            <select id="f-sla" className={selectCls} value={f.sla} onChange={(e) => set("sla", e.target.value)}>
              <option value="">All</option><option value="ON_TRACK">On track</option><option value="AT_RISK">At risk</option><option value="BREACHED">Breached</option>
            </select></div>
          <div className="space-y-1"><Label htmlFor="f-status">Status</Label>
            <select id="f-status" className={selectCls} value={f.status} onChange={(e) => set("status", e.target.value)}>
              <option value="">All</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETED">Completed</option><option value="REJECTED">Rejected</option><option value="PAUSED">Paused</option>
            </select></div>
        </CardContent>
      </Card>

      {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
        : q.isLoading ? <DataTable columns={columns} rows={[]} loading />
        : !groups.length ? <DataTable columns={columns} rows={[]} emptyState={<>No workflows match. Banker, TSP and MID onboarding start by themselves on the next sync; others start with &quot;Start workflow&quot;.</>} />
        : (
          <div className="space-y-4">
            {groups.map((g) => (
              <Card key={g.type}>
                <CardHeader className="pb-3"><CardTitle className="text-base">{ACTOR_LABEL[g.type]} <span className="font-normal text-[color:var(--color-text-muted)]">· {g.rows.length}</span></CardTitle></CardHeader>
                <CardContent>
                  <DataTable columns={columns} rows={g.rows} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/journeys/${r.id}`)} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      <StartDialog open={starting} onOpenChange={setStarting} templates={tq.data?.templates ?? []} />
    </div>
  );
}
