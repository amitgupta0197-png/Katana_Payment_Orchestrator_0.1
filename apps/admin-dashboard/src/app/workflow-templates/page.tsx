"use client";

// Workflow Templates: the steps each workflow has, and proposing a new version. A proposal is
// validated here and on the server, then approved by a second person through Maker-Checker
// (`workflow.template_update`). Running instances keep the version they started on. Staff only;
// Super Admin / Admin propose.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitBranch, Pencil } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACTOR_LABEL, ROLE_LABEL, STEP_TYPE_LABEL, fmtHours, readJson, selectCls } from "@/components/workflow/common";
import { normaliseSteps, templateProblems, WORKFLOW_ROLES, type StepDef, type TemplateDef } from "@/lib/workflow";
import { formatDateTime } from "@/lib/utils";

interface Tpl extends TemplateDef { id: string; version: number; active: boolean; created_by: string | null; created_at: string }
interface Data {
  templates: Tpl[];
  pending: { request_id: string; key: string; maker_email: string; created_at: string; base_version: number | null }[];
  checks: { key: string; kind: string; label: string }[];
  can_propose: boolean;
}

function Editor({ t, checks, onClose }: { t: Tpl; checks: Data["checks"]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(t.name);
  const [steps, setSteps] = useState<StepDef[]>(t.steps);
  const [json, setJson] = useState(JSON.stringify(t.steps, null, 2));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [notes, setNotes] = useState("");
  const parsed = useMemo((): { steps: StepDef[] | null; error: string | null } => {
    if (mode === "form") return { steps, error: null };
    try { const v = JSON.parse(json); return Array.isArray(v) ? { steps: v, error: null } : { steps: null, error: "steps must be a JSON list" }; }
    catch (e) { return { steps: null, error: (e as Error).message }; }
  }, [mode, json, steps]);
  const problems = parsed.steps ? templateProblems({ ...t, name, steps: normaliseSteps(parsed.steps) }) : [parsed.error!];
  const set = (i: number, patch: Partial<StepDef>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const m = useMutation({
    mutationFn: async () => readJson<{ request_id: string }>(await fetch("/api/workflows/templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: t.key, name, steps: parsed.steps, notes: notes || undefined }),
    })),
    onSuccess: () => { toast.success("Proposed. A second person approves it in the Maker-Checker queue."); qc.invalidateQueries({ queryKey: ["workflow-templates-all"] }); onClose(); },
    onError: (e: Error) => toast.error("Could not propose it", { description: e.message }),
  });
  const switchTo = (to: "form" | "json") => {
    if (to === "json") setJson(JSON.stringify(steps, null, 2));
    else if (parsed.steps) setSteps(parsed.steps);
    else { toast.error("Fix the JSON first"); return; }
    setMode(to);
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1 space-y-1"><Label htmlFor={`n-${t.key}`}>Name</Label><Input id={`n-${t.key}`} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="flex gap-1">
          <Button size="sm" variant={mode === "form" ? "default" : "secondary"} onClick={() => switchTo("form")}>Simple</Button>
          <Button size="sm" variant={mode === "json" ? "default" : "secondary"} onClick={() => switchTo("json")}>JSON</Button>
        </div>
      </div>
      {mode === "form" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[color:var(--color-text-muted)]"><tr><th className="py-1 pr-2">Step</th><th className="pr-2">Name</th><th className="pr-2">Role</th><th className="pr-2">Timeout (hours)</th><th>Type</th></tr></thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={s.step_id} className="border-t">
                  <td className="py-1.5 pr-2 font-mono text-xs">{s.step_id}</td>
                  <td className="pr-2"><Input aria-label={`Name of ${s.step_id}`} value={s.name} onChange={(e) => set(i, { name: e.target.value })} /></td>
                  <td className="pr-2">
                    <select aria-label={`Role of ${s.step_id}`} className={selectCls} value={s.assigned_role} onChange={(e) => set(i, { assigned_role: e.target.value as StepDef["assigned_role"] })}>
                      {WORKFLOW_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </td>
                  <td className="pr-2"><Input aria-label={`Timeout of ${s.step_id}`} type="number" min={0} className="w-24" value={s.timeout_hours ?? ""}
                    onChange={(e) => set(i, { timeout_hours: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                  <td className="text-xs text-[color:var(--color-text-muted)]">{STEP_TYPE_LABEL[s.step_type]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">Adding, removing or reordering steps, checklists and checks: use JSON.</p>
        </div>
      ) : (
        <div className="space-y-1">
          <textarea aria-label="Steps as JSON" spellCheck={false} className="min-h-[320px] w-full rounded-md border bg-[color:var(--color-surface)] p-2 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
          <details className="text-xs text-[color:var(--color-text-muted)]">
            <summary className="cursor-pointer">System checks a step may name</summary>
            <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">{checks.map((c) => <li key={c.key}><span className="font-mono">{c.key}</span> · {c.label}</li>)}</ul>
          </details>
        </div>
      )}
      {problems.length > 0
        ? <ul className="space-y-0.5 text-xs text-[color:var(--color-danger)]">{problems.slice(0, 6).map((p) => <li key={p}>{p}</li>)}</ul>
        : <p className="text-xs text-[color:var(--color-success)]">Valid.</p>}
      <div className="space-y-1"><Label htmlFor={`notes-${t.key}`}>Note for the checker</Label><Input id={`notes-${t.key}`} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="flex gap-2">
        <Button size="sm" disabled={problems.length > 0 || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Proposing…" : `Propose version ${t.version + 1}`}</Button>
        <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

export default function WorkflowTemplatesPage() {
  const [editing, setEditing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["workflow-templates-all"], queryFn: async () => readJson<Data>(await fetch("/api/workflows/templates?all=1")) });
  const all = q.data?.templates ?? [];
  const active = all.filter((t) => t.active);
  return (
    <div>
      <PageHeader title="Workflow Templates" icon={GitBranch}
        description="The steps of each workflow. A change is a new version, approved by a second person; workflows already running keep their version." />
      {q.error && <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>}
      {q.isLoading && <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>}
      <div className="space-y-4">
        {active.map((t) => {
          const pending = q.data!.pending.filter((p) => p.key === t.key);
          const older = all.filter((x) => x.key === t.key && !x.active);
          return (
            <Card key={t.key}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{t.name} <span className="font-normal text-[color:var(--color-text-muted)]">· version {t.version}</span></CardTitle>
                    <CardDescription>{ACTOR_LABEL[t.actor_type] ?? t.actor_type} · {t.description}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {pending.map((p) => <Badge key={p.request_id} variant="warning" title={`by ${p.maker_email}, ${formatDateTime(p.created_at)}`}>Version waiting for a checker</Badge>)}
                    {q.data!.can_propose && editing !== t.key && <Button size="sm" variant="secondary" onClick={() => setEditing(t.key)}><Pencil className="h-3.5 w-3.5" /> Propose a change</Button>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <ol className="space-y-1.5 text-sm">
                  {t.steps.map((s, i) => (
                    <li key={s.step_id} className="flex flex-wrap gap-x-2">
                      <span className="w-5 text-right tabular-nums text-[color:var(--color-text-muted)]">{i + 1}.</span>
                      <span className="font-medium">{s.name}</span>
                      <span className="text-xs text-[color:var(--color-text-muted)]">
                        {STEP_TYPE_LABEL[s.step_type]} · {ROLE_LABEL[s.assigned_role] ?? s.assigned_role} · {fmtHours(s.timeout_hours)}
                        {s.system_check && <> · <span className="font-mono">{s.system_check}</span></>}
                        {s.mc_action && <> · <span className="font-mono">{s.mc_action}</span></>}
                        {s.checklist_items.length > 0 && ` · ${s.checklist_items.length} checklist item${s.checklist_items.length === 1 ? "" : "s"}`}
                        {s.on_fail && ` · on fail: ${s.on_fail}`}
                      </span>
                    </li>
                  ))}
                </ol>
                {older.length > 0 && <p className="text-xs text-[color:var(--color-text-muted)]">Earlier versions: {older.map((o) => `v${o.version} (${formatDateTime(o.created_at)})`).join(", ")}</p>}
                {editing === t.key && <Editor t={t} checks={q.data!.checks} onClose={() => setEditing(null)} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
