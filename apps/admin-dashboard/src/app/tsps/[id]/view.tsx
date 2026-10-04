"use client";

// One TSP: its onboarding (APPLICATION → … → LIVE), checklist, details, KYB documents, the banks
// that confirmed it, its bankers and MID quota use, and stage history (lib/chain, lib/chain-store).
// Going live, suspending, reactivating and changing a live TSP's permissions wait for a second
// Super Admin on the Maker-Checker page. Staff only.

import { useState, type InputHTMLAttributes } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowRight, Building2, Check, CheckCircle2, ChevronLeft, CircleDashed, Clock, ExternalLink, FileText, History, Landmark,
  Pause, Play, Upload, Users, XCircle, Gauge, Ban,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  docLabel, FLOWS, healthBand, TSP_DOC_TYPES, TSP_STAGES, TSP_TYPES,
  type ChecklistItem, type Flow, type TspDocType, type TspStage, type TspType,
} from "@/lib/chain";
import type { TspDetail } from "@/lib/chain-store";
import { cn, formatDateTime, statusVariant } from "@/lib/utils";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<TspType, string> = {
  PAYMENT_AGGREGATOR: "Payment aggregator", PAYMENT_GATEWAY: "Payment gateway", ACQUIRING_BANK_ARM: "Acquiring bank arm",
};
const STAGE_LABEL: Record<string, string> = {
  APPLICATION: "Application", KYB_PENDING: "KYB documents", SCREENING: "Screening", BANK_VERIFY: "Bank verify",
  CONFIG: "Configuration", LIVE: "Live", SUSPENDED: "Suspended", REJECTED: "Rejected",
};
const NEXT_LABEL: Partial<Record<TspStage, string>> = {
  APPLICATION: "Submit application", KYB_PENDING: "Documents reviewed", SCREENING: "Run screening",
  BANK_VERIFY: "Bank verified", CONFIG: "Request go-live",
};
const FLOW_LABEL: Record<Flow, string> = { INTENT: "Intent pay-in", P2P: "P2P pay-in", PAYOUT: "Payout" };
const DOC_TYPE_LABEL = (d: string) => {
  const l = docLabel(d as TspDocType);
  return l.charAt(0).toUpperCase() + l.slice(1);
};
const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
const textareaCls = "clay-inset flex min-h-[72px] w-full rounded-xl bg-[color:var(--color-surface)] px-3.5 py-2 text-sm placeholder:text-[color:var(--color-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand)]";

/** An API refusal with its whole body: `{ error, code, ...extra }`. */
class ApiError extends Error {
  constructor(message: string, public body: Record<string, any>) { super(message); }
}

async function call<T = Record<string, any>>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, headers: body instanceof FormData || body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(d.error ?? "HTTP " + r.status, d);
  return d as T;
}

function errorText(e: Error): string {
  const b = e instanceof ApiError ? e.body : {};
  if (b.code === "CHECKLIST_INCOMPLETE" && Array.isArray(b.missing) && b.missing.length)
    return "Still missing: " + b.missing.map((m: ChecklistItem) => m.label).join("; ");
  if (b.code === "REQUEST_PENDING") return `${e.message}. It is already waiting on the Maker-Checker page.`;
  return e.message;
}

function useWaitingToast() {
  const router = useRouter();
  return (what: string) =>
    toast.success(`${what} is waiting for a second Super Admin`, {
      description: "Approve it on the Maker-Checker page.",
      action: { label: "Open", onClick: () => router.push("/admin/maker-checker") },
    });
}

function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const band = healthBand(score);
  const color = band === "GREEN" ? "var(--color-success)" : band === "AMBER" ? "var(--color-warning)" : "var(--color-danger)";
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center rounded-full" title={`Checklist ${score}% done`}
      style={{ width: size, height: size, background: `conic-gradient(${color} ${score * 3.6}deg, var(--color-border) 0deg)` }}>
      <span className="absolute inset-[4px] rounded-full bg-[color:var(--color-surface)]" />
      <span className="relative text-[11px] font-semibold tabular-nums" style={{ color }}>{score}</span>
    </span>
  );
}

// ── stepper ─────────────────────────────────────────────────────────────────────────────────

function Stepper({ stage }: { stage: TspStage }) {
  const at = (TSP_STAGES as readonly string[]).indexOf(stage);
  const stopped = stage === "SUSPENDED" || stage === "REJECTED";
  return (
    <ol className="grid grid-cols-6 gap-1" aria-label="Onboarding stages">
      {TSP_STAGES.map((s, i) => {
        const done = at >= 0 && (i < at || stage === "LIVE");
        const current = i === at && stage !== "LIVE";
        return (
          <li key={s} className="min-w-0" aria-current={current ? "step" : undefined}>
            <div className={cn("h-1.5 rounded-full", current && "animate-pulse motion-reduce:animate-none")}
              style={{ background: done ? "var(--color-success)" : current ? "var(--color-brand)" : stopped ? "var(--color-danger-muted)" : "var(--color-border)" }} />
            <div className={cn("mt-1.5 hidden items-center gap-1 truncate text-[11px] sm:flex",
              done ? "text-[color:var(--color-text-muted)]" : current ? "font-medium text-[color:var(--color-text)]" : "text-[color:var(--color-text-subtle)]")}>
              {done && <Check className="h-3 w-3 shrink-0 text-[color:var(--color-success)]" />}
              <span className="truncate">{STAGE_LABEL[s]}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────

function AdvanceDialog({ d, onDone }: { d: TspDetail; onDone: () => void }) {
  const t = d.tsp;
  const waiting = useWaitingToast();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [blocked, setBlocked] = useState<{ summary: string; canOverride: boolean } | null>(null);
  const [override, setOverride] = useState(false);
  const label = NEXT_LABEL[t.stage] ?? "Next step";
  const next = d.next;

  const m = useMutation({
    mutationFn: () => call<{ stage: string; request_id?: string }>(`/api/tsps/${t.id}/status`, "PATCH",
      { action: "advance", notes: notes.trim() || undefined, override: override || undefined }),
    onSuccess: (r) => {
      if (r.request_id) waiting(`Going live for ${t.code}`);
      else toast.success(`${t.code} moved to ${STAGE_LABEL[r.stage] ?? r.stage}`);
      setOpen(false); setBlocked(null); setOverride(false); setNotes("");
      onDone();
    },
    onError: (e: Error) => {
      const b = e instanceof ApiError ? e.body : {};
      if (b.code === "SCREENING_NOT_CLEAR") {
        setBlocked({ summary: b.screening?.summary ?? e.message, canOverride: b.can_override === true });
        onDone();
      }
      toast.error("Could not take the step", { description: errorText(e) });
    },
  });

  if (!next.ok && next.code === "NO_NEXT_STEP") return null;
  if (!next.ok) {
    return (
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <Button size="sm" disabled><ArrowRight className="h-4 w-4" /> {label}</Button>
        <span className="max-w-xs text-xs text-[color:var(--color-text-muted)] sm:text-right">
          Still missing: {next.missing.map((i) => i.label).join("; ")}
        </span>
      </div>
    );
  }
  const overrideNoteShort = override && notes.trim().length < 5;
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setBlocked(null); setOverride(false); } }}>
      <Button size="sm" onClick={() => setOpen(true)}><ArrowRight className="h-4 w-4" /> {label}</Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {t.stage === "SCREENING"
              ? `Checks ${t.code}'s names against the sanctions and PEP lists. If they are clear, it moves on to Bank verify.`
              : next.second_person
                ? `Asks a second Super Admin to take ${t.code} live. It stays in Configuration until they approve.`
                : `Moves ${t.code} from ${STAGE_LABEL[t.stage]} to ${STAGE_LABEL[next.to]}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="adv-notes">Note {override ? "(why you override, required)" : "(optional)"}</Label>
            <textarea id="adv-notes" className={textareaCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Recorded in the audit log" />
          </div>
          {blocked && (
            <div className="rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] px-3 py-2 text-xs text-[color:var(--color-danger)]">
              <div>Screening is not clear: {blocked.summary}</div>
              {blocked.canOverride ? (
                <label className="mt-2 flex items-center gap-1.5">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  Override with a note. The note above is recorded as the reason.
                </label>
              ) : <div className="mt-1">Only a Super Admin can override this.</div>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || overrideNoteShort}>
            {m.isPending ? "Working…" : override ? "Override and continue" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({ open, onOpenChange, title, description, confirm, danger, minLength = 5, placeholder, onSubmit, pending }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description: string; confirm: string; danger?: boolean;
  minLength?: number; placeholder?: string; onSubmit: (note: string) => void; pending: boolean;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setNote(""); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <textarea className={textareaCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder ?? "Say why (at least 5 characters)"} autoFocus />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? "danger" : "default"} disabled={pending || note.trim().length < minLength} onClick={() => onSubmit(note.trim())}>
            {pending ? "Working…" : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusActions({ d, onDone }: { d: TspDetail; onDone: () => void }) {
  const t = d.tsp;
  const waiting = useWaitingToast();
  const [which, setWhich] = useState<null | "suspend" | "reactivate" | "reject">(null);
  const m = useMutation({
    mutationFn: (v: { action: "suspend" | "reactivate" | "reject"; notes: string }) =>
      call<{ stage: string; request_id?: string }>(`/api/tsps/${t.id}/status`, "PATCH", v),
    onSuccess: (r, v) => {
      if (r.request_id) waiting(v.action === "suspend" ? `Suspending ${t.code}` : `Reactivating ${t.code}`);
      else toast.success(`${t.code} rejected`);
      setWhich(null); onDone();
    },
    onError: (e: Error) => toast.error("Could not do that", { description: errorText(e) }),
  });
  const canReject = !["LIVE", "SUSPENDED", "REJECTED"].includes(t.stage);
  const cfg = {
    suspend: { title: `Suspend ${t.code}`, description: "Its bankers can get no new MIDs while it is suspended. A second Super Admin must approve.", confirm: "Ask to suspend", danger: true },
    reactivate: { title: `Reactivate ${t.code}`, description: "Puts it back to Live. A second Super Admin must approve.", confirm: "Ask to reactivate", danger: false },
    reject: { title: `Reject ${t.code}`, description: "Stops its onboarding for good. This happens at once.", confirm: "Reject", danger: true },
  } as const;
  return (
    <>
      {t.stage === "LIVE" && <Button size="sm" variant="secondary" onClick={() => setWhich("suspend")}><Pause className="h-4 w-4" /> Suspend</Button>}
      {t.stage === "SUSPENDED" && <Button size="sm" onClick={() => setWhich("reactivate")}><Play className="h-4 w-4" /> Reactivate</Button>}
      {canReject && <Button size="sm" variant="ghost" className="text-[color:var(--color-danger)]" onClick={() => setWhich("reject")}><Ban className="h-4 w-4" /> Reject</Button>}
      {which && (
        <NoteDialog open onOpenChange={(v) => { if (!v) setWhich(null); }} {...cfg[which]} pending={m.isPending}
          onSubmit={(notes) => m.mutate({ action: which, notes })} />
      )}
    </>
  );
}

// ── checklist ───────────────────────────────────────────────────────────────────────────────

function ChecklistPanel({ items, score }: { items: ChecklistItem[]; score: number }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-base">Checklist</CardTitle>
          <CardDescription>{items.filter((i) => i.state === "DONE").length} of {items.length} done</CardDescription>
        </div>
        <ScoreRing score={score} />
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {items.map((i) => (
            <li key={i.key} className="flex items-start gap-2 text-sm">
              {i.state === "DONE" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" aria-label="Done" />
                : i.state === "MISSING" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-danger)]" aria-label="Missing" />
                : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-text-subtle)]" aria-label="Optional" />}
              <div className="min-w-0">
                <div className={cn(i.state === "DONE" && "text-[color:var(--color-text-muted)]")}>
                  {i.label}{i.state === "OPTIONAL_MISSING" && <span className="text-xs text-[color:var(--color-text-subtle)]"> (optional)</span>}
                </div>
                {i.state !== "DONE" && i.action && <div className="text-xs text-[color:var(--color-text-muted)]">{i.action}</div>}
                <div className="text-[11px] text-[color:var(--color-text-subtle)]">Needed for {STAGE_LABEL[i.needed_for] ?? i.needed_for}</div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ── overview ────────────────────────────────────────────────────────────────────────────────

type Form = {
  name: string; legal_name: string; tsp_type: TspType; gateway_code: string; rbi_licence_no: string; pci_dss_cert_no: string;
  primary_contact_name: string; primary_contact_email: string; primary_contact_phone: string;
  compliance_officer_name: string; compliance_officer_email: string;
  allowed_flows: Flow[]; max_mids_per_banker: string; max_bankers: string; notes: string;
};

function formOf(t: TspDetail["tsp"]): Form {
  return {
    name: t.name, legal_name: t.legal_name ?? "", tsp_type: t.tsp_type, gateway_code: t.gateway_code ?? "",
    rbi_licence_no: t.rbi_licence_no ?? "", pci_dss_cert_no: t.pci_dss_cert_no ?? "",
    primary_contact_name: t.primary_contact_name ?? "", primary_contact_email: t.primary_contact_email ?? "", primary_contact_phone: t.primary_contact_phone ?? "",
    compliance_officer_name: t.compliance_officer_name ?? "", compliance_officer_email: t.compliance_officer_email ?? "",
    allowed_flows: [...(t.allowed_flows ?? [])], max_mids_per_banker: t.max_mids_per_banker == null ? "" : String(t.max_mids_per_banker),
    max_bankers: t.max_bankers == null ? "" : String(t.max_bankers), notes: t.notes ?? "",
  };
}

const TEXT_FIELDS = ["name", "legal_name", "gateway_code", "rbi_licence_no", "pci_dss_cert_no", "primary_contact_name", "primary_contact_email",
  "primary_contact_phone", "compliance_officer_name", "compliance_officer_email", "notes"] as const;

function OverviewTab({ d, onDone }: { d: TspDetail; onDone: () => void }) {
  const t = d.tsp;
  const waiting = useWaitingToast();
  const [f, setF] = useState<Form>(() => formOf(t));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const locked = t.stage === "LIVE" || t.stage === "SUSPENDED";
  const rejected = t.stage === "REJECTED";

  // Only what changed is sent, so a live TSP raises a request only for a real permission change.
  const changes = (): Record<string, unknown> => {
    const o = formOf(t); const out: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) if (f[k].trim() !== o[k].trim()) out[k] = f[k].trim() || null;
    if (f.tsp_type !== o.tsp_type) out.tsp_type = f.tsp_type;
    const flows = FLOWS.filter((x) => f.allowed_flows.includes(x));
    if (flows.join() !== FLOWS.filter((x) => o.allowed_flows.includes(x)).join()) out.allowed_flows = flows;
    for (const k of ["max_mids_per_banker", "max_bankers"] as const)
      if (f[k].trim() !== o[k]) out[k] = f[k].trim() ? Number(f[k].trim()) : null;
    return out;
  };

  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => call<{ ok: true; request_id?: string }>(`/api/tsps/${t.id}`, "PATCH", body),
    onSuccess: (r) => {
      if (r.request_id) waiting(`The change to ${t.code}'s flows, quotas or type`);
      else toast.success("Saved");
      onDone();
    },
    onError: (e: Error) => toast.error("Could not save", { description: errorText(e) }),
  });

  const field = (k: (typeof TEXT_FIELDS)[number], label: string, extra?: InputHTMLAttributes<HTMLInputElement>) => (
    <div className="space-y-1.5">
      <Label htmlFor={`f-${k}`}>{label}</Label>
      <Input id={`f-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} disabled={rejected} {...extra} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Details</CardTitle>
        {locked && <CardDescription>{t.code} is {STAGE_LABEL[t.stage].toLowerCase()}: a change to its type, flows or quotas waits for a second Super Admin. Everything else saves at once.</CardDescription>}
        {rejected && <CardDescription>A rejected TSP cannot be edited.</CardDescription>}
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={(e) => {
          e.preventDefault();
          const c = changes();
          if (!Object.keys(c).length) { toast.info("Nothing changed"); return; }
          m.mutate(c);
        }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("name", "Name", { required: true })}
            {field("legal_name", "Legal name")}
            <div className="space-y-1.5">
              <Label htmlFor="f-type">Type</Label>
              <select id="f-type" className={selectCls} value={f.tsp_type} disabled={rejected} onChange={(e) => set("tsp_type", e.target.value as TspType)}>
                {TSP_TYPES.map((x) => <option key={x} value={x}>{TYPE_LABEL[x]}</option>)}
              </select>
            </div>
            {field("gateway_code", "Gateway code")}
            {field("rbi_licence_no", f.tsp_type === "ACQUIRING_BANK_ARM" ? "RBI licence no. (not needed for a bank arm)" : "RBI licence no.")}
            {field("pci_dss_cert_no", "PCI-DSS certificate no.")}
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Contacts</div>
            <div className="grid gap-3 sm:grid-cols-3">
              {field("primary_contact_name", "Primary contact name")}
              {field("primary_contact_email", "Primary contact email", { type: "email" })}
              {field("primary_contact_phone", "Primary contact phone", { type: "tel" })}
              {field("compliance_officer_name", "Compliance officer name")}
              {field("compliance_officer_email", "Compliance officer email", { type: "email" })}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">What it may issue MIDs for</div>
            <div className="flex flex-wrap gap-4">
              {FLOWS.map((x) => (
                <label key={x} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" disabled={rejected} checked={f.allowed_flows.includes(x)}
                    onChange={(e) => set("allowed_flows", e.target.checked ? [...f.allowed_flows, x] : f.allowed_flows.filter((y) => y !== x))} />
                  {FLOW_LABEL[x]}
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="f-mids">Max MIDs per banker</Label>
                <Input id="f-mids" type="number" min={1} max={10000} value={f.max_mids_per_banker} disabled={rejected}
                  onChange={(e) => set("max_mids_per_banker", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="f-bankers">Max bankers (empty = no cap)</Label>
                <Input id="f-bankers" type="number" min={1} max={10000} value={f.max_bankers} disabled={rejected}
                  onChange={(e) => set("max_bankers", e.target.value)} />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="f-notes">Notes</Label>
            <textarea id="f-notes" className={textareaCls} value={f.notes} disabled={rejected} onChange={(e) => set("notes", e.target.value)} />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setF(formOf(t))} disabled={m.isPending}>Undo changes</Button>
            <Button type="submit" disabled={m.isPending || rejected}>{m.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── documents ───────────────────────────────────────────────────────────────────────────────

type Doc = TspDetail["documents"][number];

function DocumentsTab({ d, onDone }: { d: TspDetail; onDone: () => void }) {
  const t = d.tsp;
  const [docType, setDocType] = useState<TspDocType>("INCORPORATION");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [rejecting, setRejecting] = useState<Doc | null>(null);

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("doc_type", docType);
      fd.append("file", file!);
      return call(`/api/tsps/${t.id}/documents`, "POST", fd);
    },
    onSuccess: () => { toast.success("Uploaded. Someone else must review it."); setFile(null); setInputKey((k) => k + 1); onDone(); },
    onError: (e: Error) => toast.error("Upload failed", { description: errorText(e) }),
  });
  const review = useMutation({
    mutationFn: (v: { id: string; decision: "APPROVED" | "REJECTED"; note?: string }) =>
      call(`/api/tsps/${t.id}/documents/${v.id}`, "PATCH", { decision: v.decision, note: v.note }),
    onSuccess: (_r, v) => { toast.success(v.decision === "APPROVED" ? "Approved" : "Rejected"); setRejecting(null); onDone(); },
    onError: (e: Error) => toast.error("Could not record the review", { description: errorText(e) }),
  });

  const cols: Column<Doc>[] = [
    { key: "doc_type", header: "Document", render: (x) => (
      <div>
        <div className="font-medium">{DOC_TYPE_LABEL(x.doc_type)}</div>
        <div className="text-xs text-[color:var(--color-text-muted)]">{x.filename ?? "file"} · {Math.max(1, Math.round(Number(x.size_bytes) / 1024))} KB</div>
      </div>
    ) },
    { key: "uploaded", header: "Uploaded", render: (x) => (
      <div className="text-xs"><div>{formatDateTime(x.created_at)}</div><div className="text-[color:var(--color-text-muted)]">{x.uploaded_by ?? "—"}</div></div>
    ) },
    { key: "review", header: "Review", render: (x) => (
      <div className="text-xs">
        <Badge variant={statusVariant(x.review)}>{x.review === "PENDING" ? "Waiting" : x.review === "APPROVED" ? "Approved" : x.review === "REJECTED" ? "Rejected" : x.review}</Badge>
        {x.reviewed_by && <div className="mt-1 text-[color:var(--color-text-muted)]">{x.reviewed_by}{x.reviewed_at ? `, ${formatDateTime(x.reviewed_at)}` : ""}</div>}
        {x.review_note && <div className="mt-0.5 text-[color:var(--color-text-muted)]">“{x.review_note}”</div>}
      </div>
    ) },
    { key: "actions", header: "", className: "text-right", render: (x) => (
      <div className="flex justify-end gap-1.5">
        <Button asChild size="sm" variant="ghost">
          <a href={`/api/tsps/${t.id}/documents/${x.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> View</a>
        </Button>
        {x.review === "PENDING" && (
          <>
            <Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ id: x.id, decision: "APPROVED" })}>Approve</Button>
            <Button size="sm" variant="secondary" disabled={review.isPending} onClick={() => setRejecting(x)}>Reject</Button>
          </>
        )}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Upload a document</CardTitle>
          <CardDescription>PDF, PNG, JPEG or WEBP up to 12 MB. The person who uploads a document cannot approve it.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
            <div className="space-y-1.5 sm:w-64">
              <Label htmlFor="doc-type">Type</Label>
              <select id="doc-type" className={selectCls} value={docType} onChange={(e) => setDocType(e.target.value as TspDocType)}>
                {TSP_DOC_TYPES.map((x) => <option key={x} value={x}>{DOC_TYPE_LABEL(x)}</option>)}
              </select>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="doc-file">File</Label>
              <input key={inputKey} id="doc-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp"
                className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <Button type="submit" disabled={!file || upload.isPending}><Upload className="h-4 w-4" /> {upload.isPending ? "Uploading…" : "Upload"}</Button>
          </form>
        </CardContent>
      </Card>
      <DataTable columns={cols} rows={d.documents} rowKey={(x) => x.id} emptyState="No documents uploaded yet." />
      {rejecting && (
        <NoteDialog open onOpenChange={(v) => { if (!v) setRejecting(null); }} title={`Reject ${DOC_TYPE_LABEL(rejecting.doc_type).toLowerCase()}`}
          description="Say what is wrong so the next upload gets it right." confirm="Reject" danger pending={review.isPending}
          onSubmit={(note) => review.mutate({ id: rejecting.id, decision: "REJECTED", note })} />
      )}
    </div>
  );
}

// ── banks ───────────────────────────────────────────────────────────────────────────────────

type BankLink = TspDetail["banks"][number];
interface BankRow { id: string; code: string; name: string; status: string }

function BanksTab({ d, onDone }: { d: TspDetail; onDone: () => void }) {
  const t = d.tsp;
  const banks = useQuery({
    queryKey: ["banks"],
    queryFn: async () => (await call<{ banks: BankRow[] }>("/api/banks", "GET")).banks,
  });
  const [pick, setPick] = useState("");
  const [confirming, setConfirming] = useState<BankLink | null>(null);
  const [ending, setEnding] = useState<BankLink | null>(null);
  const linked = new Set(d.banks.filter((b) => b.status !== "ENDED").map((b) => b.bank_id));
  const choices = (banks.data ?? []).filter((b) => b.status === "ACTIVE" && !linked.has(b.id));

  const add = useMutation({
    mutationFn: () => call(`/api/tsps/${t.id}/banks`, "POST", { bank_id: pick }),
    onSuccess: () => { toast.success("Bank added. Confirm it once the bank's letter is in."); setPick(""); onDone(); },
    onError: (e: Error) => toast.error("Could not add the bank", { description: errorText(e) }),
  });
  const act = useMutation({
    mutationFn: (v: { bankId: string; body: Record<string, string> }) => call(`/api/tsps/${t.id}/banks/${v.bankId}`, "PATCH", v.body),
    onSuccess: (_r, v) => { toast.success(v.body.action === "confirm" ? "Bank confirmed" : "Link ended"); setConfirming(null); setEnding(null); onDone(); },
    onError: (e: Error) => toast.error("Could not do that", { description: errorText(e) }),
  });

  const cols: Column<BankLink>[] = [
    { key: "bank", header: "Bank", render: (b) => <div><div className="font-medium">{b.name}</div><div className="font-mono text-xs text-[color:var(--color-text-muted)]">{b.code}</div></div> },
    { key: "status", header: "Status", render: (b) => <Badge variant={b.status === "CONFIRMED" ? "success" : b.status === "PENDING" ? "warning" : "default"}>{b.status === "CONFIRMED" ? "Confirmed" : b.status === "PENDING" ? "Waiting for the bank" : "Ended"}</Badge> },
    { key: "reference", header: "Bank's reference", render: (b) => b.reference ? (
      <div className="text-xs"><div className="font-mono">{b.reference}</div>
        {b.confirmed_by && <div className="text-[color:var(--color-text-muted)]">{b.confirmed_by}{b.confirmed_at ? `, ${formatDateTime(b.confirmed_at)}` : ""}</div>}</div>
    ) : <span className="text-[color:var(--color-text-muted)]">—</span> },
    { key: "actions", header: "", className: "text-right", render: (b) => (
      <div className="flex justify-end gap-1.5">
        {b.status === "PENDING" && <Button size="sm" onClick={() => setConfirming(b)}>Confirm</Button>}
        {b.status !== "ENDED" && <Button size="sm" variant="secondary" onClick={() => setEnding(b)}>End</Button>}
      </div>
    ) },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add a bank</CardTitle>
          <CardDescription>A bank this TSP issues MIDs for. It counts once you record the bank&apos;s confirmation letter or agreement.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (pick) add.mutate(); }}>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="bank-pick">Bank</Label>
              <select id="bank-pick" className={selectCls} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{banks.isLoading ? "Loading…" : choices.length ? "Choose a bank" : "No other active bank"}</option>
                {choices.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
              </select>
            </div>
            <Button type="submit" disabled={!pick || add.isPending}>{add.isPending ? "Adding…" : "Add bank"}</Button>
          </form>
          <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">Bank missing? Add it on the <Link href="/banks" className="text-[color:var(--color-brand)] hover:underline">Banks</Link> page.</p>
        </CardContent>
      </Card>
      <DataTable columns={cols} rows={d.banks} rowKey={(b) => b.bank_id} emptyState="No banks yet." />
      {confirming && (
        <NoteDialog open onOpenChange={(v) => { if (!v) setConfirming(null); }} title={`Confirm ${confirming.name}`}
          description="The reference of the bank's letter or agreement that says this TSP may issue its MIDs." confirm="Confirm" minLength={3}
          placeholder="e.g. HDFC/TSP/2026/0142" pending={act.isPending}
          onSubmit={(reference) => act.mutate({ bankId: confirming.bank_id, body: { action: "confirm", reference } })} />
      )}
      {ending && (
        <NoteDialog open onOpenChange={(v) => { if (!v) setEnding(null); }} title={`End the link to ${ending.name}`}
          description="The TSP no longer issues MIDs for this bank. Refused while a banker uses this TSP with this bank." confirm="End link" danger
          pending={act.isPending} onSubmit={(notes) => act.mutate({ bankId: ending.bank_id, body: { action: "end", notes } })} />
      )}
    </div>
  );
}

// ── bankers, quota, history ─────────────────────────────────────────────────────────────────

type Banker = TspDetail["bankers"][number];

function BankersTab({ d }: { d: TspDetail }) {
  const router = useRouter();
  const cols: Column<Banker>[] = [
    { key: "merchant_code", header: "Code", render: (b) => <Link href={`/bankers/${b.id}`} className="font-mono font-medium text-[color:var(--color-brand)] hover:underline" onClick={(e) => e.stopPropagation()}>{b.merchant_code}</Link> },
    { key: "legal_name", header: "Name" },
    { key: "stage", header: "Stage", render: (b) => <Badge variant={statusVariant(b.stage)}>{b.stage}</Badge> },
    { key: "bank_code", header: "Issuing bank", render: (b) => b.bank_code ?? <span className="text-[color:var(--color-text-muted)]">—</span> },
    { key: "active_mids", header: "Active MIDs", className: "text-right tabular-nums" },
  ];
  return <DataTable columns={cols} rows={d.bankers} rowKey={(b) => b.id} onRowClick={(b) => router.push(`/bankers/${b.id}`)}
    emptyState="No bankers on this TSP yet. A banker is put on a TSP from its own page, once the TSP is live." />;
}

function QuotaBar({ used, max }: { used: number; max: number | null }) {
  if (!max) return <span className="text-xs text-[color:var(--color-text-muted)]">{used} (no quota set)</span>;
  const pct = Math.min(100, Math.round((used / max) * 100));
  const color = used >= max ? "var(--color-danger)" : pct >= 75 ? "var(--color-warning)" : "var(--color-success)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[color:var(--color-border)]"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} /></div>
      <span className="text-xs tabular-nums">{used} / {max}</span>
    </div>
  );
}

function QuotaTab({ d }: { d: TspDetail }) {
  const t = d.tsp;
  const per = new Map(d.mid_quota.map((q) => [q.flow, q]));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">MIDs by flow</CardTitle>
          <CardDescription>
            All of this TSP&apos;s bankers together. Each banker may hold {t.max_mids_per_banker ?? "any number of"} MIDs
            {t.max_bankers ? `, and the TSP may have ${t.max_bankers} bankers` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {FLOWS.map((x) => {
              const q = per.get(x);
              const allowed = t.allowed_flows.includes(x);
              return (
                <div key={x} className={cn("rounded-2xl border px-4 py-3", !allowed && "opacity-60")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{FLOW_LABEL[x]}</span>
                    {!allowed && <Badge>Not allowed</Badge>}
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{q?.active ?? 0}</div>
                  <div className="text-xs text-[color:var(--color-text-muted)]">active, {q?.pending ?? 0} waiting approval</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Per banker</CardTitle>
          <CardDescription>Active MIDs against the quota per banker.</CardDescription>
        </CardHeader>
        <CardContent>
          {d.bankers.length === 0 ? <p className="text-sm text-[color:var(--color-text-muted)]">No bankers yet.</p> : (
            <ul className="divide-y">
              {d.bankers.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <Link href={`/bankers/${b.id}`} className="min-w-0 truncate hover:underline"><span className="font-mono">{b.merchant_code}</span> {b.legal_name}</Link>
                  <QuotaBar used={b.active_mids} max={t.max_mids_per_banker} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryTab({ d }: { d: TspDetail }) {
  if (!d.history.length) return <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No stage changes yet.</p>;
  return (
    <Card>
      <CardContent className="pt-6">
        <ol className="space-y-3">
          {d.history.map((h, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 shrink-0 text-xs tabular-nums text-[color:var(--color-text-muted)]">{formatDateTime(h.changed_at)}</span>
              {h.from_stage ? <Badge variant={statusVariant(h.from_stage)}>{STAGE_LABEL[h.from_stage] ?? h.from_stage}</Badge> : <span className="text-xs text-[color:var(--color-text-muted)]">Created</span>}
              <ArrowRight className="h-3.5 w-3.5 text-[color:var(--color-text-subtle)]" />
              <Badge variant={statusVariant(h.to_stage)}>{STAGE_LABEL[h.to_stage] ?? h.to_stage}</Badge>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// ── page ────────────────────────────────────────────────────────────────────────────────────

export default function TspView({ id }: { id: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("overview");
  const q = useQuery({ queryKey: ["tsp", id], queryFn: () => call<TspDetail>(`/api/tsps/${id}`, "GET") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["tsp", id] }); qc.invalidateQueries({ queryKey: ["tsps"] }); };

  if (q.isLoading) return <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>;
  if (q.error || !q.data) return (
    <div className="space-y-2">
      <Link href="/tsps" className="inline-flex items-center gap-0.5 text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)]"><ChevronLeft className="h-3 w-3" /> TSPs</Link>
      <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error | null)?.message ?? "Not found"}</p>
    </div>
  );
  const d = q.data;
  const t = d.tsp;
  const tabs = [
    { key: "overview", label: "Overview", icon: Building2 },
    { key: "documents", label: "KYB documents", icon: FileText, count: d.documents.length },
    { key: "banks", label: "Banks", icon: Landmark, count: d.banks.filter((b) => b.status !== "ENDED").length },
    { key: "bankers", label: "Bankers", icon: Users, count: d.bankers.length },
    { key: "quota", label: "MID quota", icon: Gauge },
    { key: "history", label: "History", icon: History },
  ];

  return (
    <div className="space-y-4">
      <section className="clay-surface rounded-3xl p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <ScoreRing score={d.score} size={48} />
            <div className="min-w-0">
              <Link href="/tsps" className="inline-flex items-center gap-0.5 text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)]">
                <ChevronLeft className="h-3 w-3" /> TSPs
              </Link>
              <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{t.name}</h1>
              <p className="truncate text-sm text-[color:var(--color-text-muted)]">
                <span className="font-mono">{t.code}</span>, {TYPE_LABEL[t.tsp_type] ?? t.tsp_type}
                {t.screening_result && <>, screening {t.screening_result.toLowerCase()}</>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(t.stage)}>{STAGE_LABEL[t.stage] ?? t.stage}</Badge>
            <StatusActions d={d} onDone={refresh} />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className={cn("mb-2 text-sm font-medium", (t.stage === "SUSPENDED" || t.stage === "REJECTED") && "text-[color:var(--color-danger)]")}>
              {t.stage === "LIVE" ? "Onboarding complete" : t.stage === "SUSPENDED" ? "Suspended" : t.stage === "REJECTED" ? "Onboarding stopped: rejected"
                : `Step ${(TSP_STAGES as readonly string[]).indexOf(t.stage) + 1} of ${TSP_STAGES.length}: ${STAGE_LABEL[t.stage]}`}
            </div>
            <Stepper stage={t.stage} />
          </div>
          <div className="shrink-0"><AdvanceDialog d={d} onDone={refresh} /></div>
        </div>
      </section>

      {d.pending_requests.length > 0 && (
        <div className="rounded-2xl border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-[color:var(--color-warning)]">
            <Clock className="h-4 w-4" /> Waiting for a second Super Admin
          </div>
          <ul className="mt-2 space-y-1">
            {d.pending_requests.map((p) => (
              <li key={p.request_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">{p.summary} <span className="text-xs text-[color:var(--color-text-muted)]">by {p.maker_email || "someone"}, {formatDateTime(p.created_at)}</span></span>
                <Link href="/admin/maker-checker" className="text-xs font-medium text-[color:var(--color-brand)] hover:underline">Open Maker-Checker</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="order-2 min-w-0 lg:order-1">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto w-full justify-start">
              {tabs.map((x) => (
                <TabsTrigger key={x.key} value={x.key} className="pb-2.5 pt-2">
                  <x.icon className="h-4 w-4" />{x.label}
                  {x.count !== undefined && <span className="rounded-full bg-[color:var(--color-surface)] px-1.5 text-xs font-normal tabular-nums">{x.count}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview"><OverviewTab key={t.updated_at} d={d} onDone={refresh} /></TabsContent>
            <TabsContent value="documents"><DocumentsTab d={d} onDone={refresh} /></TabsContent>
            <TabsContent value="banks"><BanksTab d={d} onDone={refresh} /></TabsContent>
            <TabsContent value="bankers"><BankersTab d={d} /></TabsContent>
            <TabsContent value="quota"><QuotaTab d={d} /></TabsContent>
            <TabsContent value="history"><HistoryTab d={d} /></TabsContent>
          </Tabs>
        </div>
        <div className="order-1 lg:order-2">
          <ChecklistPanel items={d.checklist} score={d.score} />
        </div>
      </div>
    </div>
  );
}

