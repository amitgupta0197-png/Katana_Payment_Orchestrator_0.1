"use client";

// One workflow instance (/journeys/{id}): stepper, a card per step (state, role, checklist,
// system check, linked Maker-Checker request), the events and comments, and the actions a person
// may take. Nothing here changes the banker / TSP / MID / merchant itself.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, ExternalLink, MessageSquare, Route, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ROLE_LABEL, STEP_TYPE_LABEL, SlaBadge, StatusBadge, StepIcon, WorkflowStepper, fmtHours, readJson, type StepStateName,
} from "@/components/workflow/common";
import type { SlaStatus, StepDef } from "@/lib/workflow";
import { cn, formatDateTime } from "@/lib/utils";

interface StepView extends StepDef {
  state: StepStateName; started_at: string | null; sla: SlaStatus | null; ticked: Record<string, boolean>;
  check: { key: string; label: string; passes: boolean } | null;
  mc: { request_id: string; status: string; created_at: string } | null;
  can_complete: boolean;
}
interface EventRow { id: number; step_id: string; event: string; actor: string; method: string | null; checklist: Record<string, boolean> | null; comment: string | null; evidence_ref: string | null; at: string }
interface Detail {
  instance: {
    id: string; template_name: string; template_description: string | null; template_version: number; actor_type: string; actor_label: string | null;
    actor_link: string | null; status: string; current_step_id: string | null; initiated_by: string; initiated_at: string; completed_at: string | null; sla_due_at: string | null;
  };
  steps: StepView[]; events: EventRow[]; sla: SlaStatus | null; you: { persona: string; email: string };
}

const textareaCls = "min-h-[80px] w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm";
const EVENT_LABEL: Record<string, string> = {
  STARTED: "started", CHECKED: "ticked the checklist", COMPLETED: "completed", FAILED: "sent back / failed",
  ESCALATED: "escalated", REJECTED: "rejected the workflow", COMMENT: "commented",
};

function post(path: string, body: unknown) {
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => readJson<unknown>(r));
}

function NoteDialog({ title, description, danger, label, onSubmit, open, onOpenChange, pending }: {
  title: string; description: React.ReactNode; danger?: boolean; label: string; open: boolean; pending: boolean;
  onOpenChange: (v: boolean) => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit(note); }}>
          <Label htmlFor="wf-note">Why</Label>
          <textarea id="wf-note" className={textareaCls} value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant={danger ? "danger" : "default"} disabled={pending || note.trim().length < 5}>{pending ? "Saving…" : label}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StepCard({ s, d, onDone }: { s: StepView; d: Detail; onDone: () => void }) {
  const current = s.state === "ACTIVE" && d.instance.status === "IN_PROGRESS";
  const [ticks, setTicks] = useState<Record<string, boolean>>(s.ticked);
  const [comment, setComment] = useState("");
  const [dialog, setDialog] = useState<"" | "escalate" | "send_back">("");
  const base = `/api/workflows/instances/${d.instance.id}/steps/${s.step_id}`;
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => post(base, body),
    onSuccess: (_r, body) => {
      const a = body.action as string;
      toast.success(a === "complete" ? "Step completed" : a === "escalate" ? "Escalated to operations" : a === "send_back" ? "Step sent back" : a === "check" ? "Ticks saved" : "Comment added");
      setComment(""); setDialog(""); onDone();
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });
  const allTicked = s.checklist_items.every((c) => ticks[c.key]);
  const manual = s.step_type === "MANUAL_REVIEW" || s.step_type === "DOCUMENT_UPLOAD";
  const events = d.events.filter((e) => e.step_id === s.step_id);

  return (
    <Card className={cn(current && "ring-2 ring-[color:var(--color-brand)]/40")} id={`step-${s.step_id}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <StepIcon state={s.state} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <CardTitle className="text-base">{s.name}</CardTitle>
              <CardDescription>
                {STEP_TYPE_LABEL[s.step_type]} · {ROLE_LABEL[s.assigned_role] ?? s.assigned_role} · {fmtHours(s.timeout_hours)}
                {s.distinct_from && " · a different person from the maker"}
              </CardDescription>
            </div>
          </div>
          {current && <SlaBadge sla={s.sla} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {s.check && (
          <div className="flex items-center gap-2 text-xs">
            <ShieldCheck className={cn("h-3.5 w-3.5", s.check.passes ? "text-[color:var(--color-success)]" : "text-[color:var(--color-text-subtle)]")} />
            <span>System check: {s.check.label}</span>
            {d.instance.status === "IN_PROGRESS" && <Badge variant={s.check.passes ? "success" : "default"}>{s.check.passes ? "holds" : "not yet"}</Badge>}
          </div>
        )}
        {s.step_type === "MAKER_CHECKER" && current && (
          <div className="rounded-md border px-3 py-2 text-xs">
            {s.mc
              ? <>Maker-Checker request {s.mc.status === "PENDING" ? "waiting for a checker" : s.mc.status.toLowerCase()} (<span className="font-mono">{s.mc.request_id.slice(0, 8)}</span>, raised {formatDateTime(s.mc.created_at)}). {s.mc.status === "PENDING" && <Link className="text-[color:var(--color-brand)] underline" href="/admin/maker-checker">Open the queue</Link>}</>
              : <>No <span className="font-mono">{s.mc_action}</span> request yet. It is raised from the actor&apos;s own page; this step completes when it is approved.</>}
          </div>
        )}
        {s.step_type === "SYSTEM_CHECK" && current && (
          <p className="text-xs text-[color:var(--color-text-muted)]">Completes by itself when the real state shows it done. Do it on the actor&apos;s page.</p>
        )}
        {s.checklist_items.length > 0 && (
          <ul className="space-y-1.5">
            {s.checklist_items.map((c) => (
              <li key={c.key}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={!!ticks[c.key]} disabled={!current || !s.can_complete}
                    onChange={(e) => setTicks((t) => ({ ...t, [c.key]: e.target.checked }))} />
                  <span>{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {current && manual && !s.can_complete && (
          <p className="text-xs text-[color:var(--color-text-muted)]">Waiting for {ROLE_LABEL[s.assigned_role] ?? s.assigned_role}. You can comment or escalate.</p>
        )}
        {current && (
          <div className="space-y-2">
            <textarea className={textareaCls} placeholder="Comment (optional when completing)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
            <div className="flex flex-wrap gap-2">
              {s.can_complete && (
                <>
                  <Button size="sm" disabled={!allTicked || act.isPending} title={allTicked ? undefined : "Tick every item first"}
                    onClick={() => act.mutate({ action: "complete", checklist: ticks, comment: comment || undefined })}>Complete step</Button>
                  {s.checklist_items.length > 0 && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ action: "check", checklist: ticks })}>Save ticks</Button>}
                  {s.on_fail && s.on_fail !== "REJECT" && <Button size="sm" variant="secondary" onClick={() => setDialog("send_back")}>Send back</Button>}
                </>
              )}
              <Button size="sm" variant="secondary" disabled={!comment.trim() || act.isPending} onClick={() => act.mutate({ action: "comment", comment })}>
                <MessageSquare className="h-3.5 w-3.5" /> Comment
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog("escalate")}><AlertTriangle className="h-3.5 w-3.5" /> Escalate</Button>
            </div>
          </div>
        )}
        {events.length > 0 && (
          <ol className="space-y-1 border-l pl-3 text-xs">
            {events.map((e) => (
              <li key={e.id}>
                <span className="text-[color:var(--color-text-muted)]">{formatDateTime(e.at)}</span>{" "}
                <span className="font-medium">{e.actor === "system" ? "System" : e.actor}</span> {EVENT_LABEL[e.event] ?? e.event}
                {e.method === "MAKER_CHECKER" && " (Maker-Checker)"}
                {e.comment && <span className="text-[color:var(--color-text-muted)]">: {e.comment}</span>}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <NoteDialog open={dialog === "escalate"} onOpenChange={(v) => setDialog(v ? "escalate" : "")} pending={act.isPending}
        title="Escalate this step" description="Operations get an alert now. Say what is stuck." label="Escalate"
        onSubmit={(note) => act.mutate({ action: "escalate", comment: note })} />
      <NoteDialog open={dialog === "send_back"} onOpenChange={(v) => setDialog(v ? "send_back" : "")} pending={act.isPending}
        title="Send this step back" description={`The workflow goes back to "${d.steps.find((x) => x.step_id === s.on_fail)?.name ?? s.on_fail}".`} label="Send back"
        onSubmit={(note) => act.mutate({ action: "send_back", comment: note })} />
    </Card>
  );
}

export default function InstanceView({ id }: { id: string }) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const q = useQuery({ queryKey: ["workflow", id], queryFn: async () => readJson<Detail>(await fetch(`/api/workflows/instances/${id}`)), refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["workflow", id] }); qc.invalidateQueries({ queryKey: ["workflows"] }); };
  const reject = useMutation({
    mutationFn: (comment: string) => post(`/api/workflows/instances/${id}/reject`, { comment }),
    onSuccess: () => { toast.success("Workflow rejected"); setRejecting(false); refresh(); },
    onError: (e: Error) => toast.error("Could not reject", { description: e.message }),
  });
  if (q.error) return <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>;
  if (!q.data) return <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>;
  const d = q.data;
  const i = d.instance;
  const open = i.status === "IN_PROGRESS" || i.status === "PAUSED";
  const cur = d.steps.find((s) => s.step_id === i.current_step_id);
  const canReject = open && (d.you.persona === "SUPER_ADMIN" || d.you.persona === "ADMIN" || cur?.assigned_role === d.you.persona);

  return (
    <div>
      <Link href="/journeys" className="mb-3 inline-flex items-center gap-1 text-sm text-[color:var(--color-text-muted)] hover:underline"><ArrowLeft className="h-4 w-4" /> Journey Tracker</Link>
      <PageHeader title={`${i.template_name}: ${i.actor_label ?? ""}`} icon={Route}
        description={i.template_description ?? undefined}
        actions={<>
          {i.actor_link && <Button variant="secondary" asChild><Link href={i.actor_link}>Open the {i.actor_type === "MID" ? "banker" : i.actor_type === "BANKER_SUSPENSION" ? "banker" : i.actor_type.toLowerCase()} <ExternalLink className="h-3.5 w-3.5" /></Link></Button>}
          {canReject && <Button variant="danger" onClick={() => setRejecting(true)}>Reject</Button>}
        </>} />

      <Card className="mb-4">
        <CardContent className="space-y-4 pt-6">
          <WorkflowStepper steps={d.steps} stopped={i.status === "REJECTED"} />
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <div><dt className="text-xs text-[color:var(--color-text-muted)]">Status</dt><dd className="mt-0.5"><StatusBadge status={i.status} /></dd></div>
            <div><dt className="text-xs text-[color:var(--color-text-muted)]">Current step</dt><dd className="mt-0.5">{cur?.name ?? "—"}</dd></div>
            <div><dt className="text-xs text-[color:var(--color-text-muted)]">SLA</dt><dd className="mt-0.5"><SlaBadge sla={d.sla} />{i.sla_due_at && <span className="ml-1.5 text-xs text-[color:var(--color-text-muted)]">due {formatDateTime(i.sla_due_at)}</span>}</dd></div>
            <div><dt className="text-xs text-[color:var(--color-text-muted)]">Started</dt><dd className="mt-0.5">{formatDateTime(i.initiated_at)} by {i.initiated_by}</dd></div>
            <div><dt className="text-xs text-[color:var(--color-text-muted)]">Template</dt><dd className="mt-0.5">version {i.template_version}</dd></div>
          </dl>
          {i.status === "REJECTED" && (
            <p className="rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] px-3 py-2 text-xs text-[color:var(--color-danger)]">
              This workflow was rejected. The {i.actor_type === "MID" ? "MID" : "actor"} itself was not changed by that; see its own page for its real state.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {d.steps.map((s) => <StepCard key={`${s.step_id}:${s.state}:${d.events.length}`} s={s} d={d} onDone={refresh} />)}
      </div>

      <NoteDialog open={rejecting} onOpenChange={setRejecting} pending={reject.isPending} danger label="Reject workflow"
        title="Reject this workflow"
        description={<>This closes the workflow only. The {i.actor_type === "MID" ? "MID" : i.actor_type.toLowerCase().replace("_", " ")} itself is <strong>not</strong> rejected, suspended or changed: do that on its own page if it is meant.</>}
        onSubmit={(note) => reject.mutate(note)} />
    </div>
  );
}
