"use client";

// Operator Console (PayTech BRD §16). Work the FIFO queue: claim head-of-line,
// accept → process → upload proof → complete. Read-only view of the queue tail.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Headphones, ArrowDownToLine, Check, Play, Upload, CheckCircle2, XCircle, AlertTriangle, Timer, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface QItem {
  queue_id: string; order_id: string; order_ref: string; merchant_id: string;
  direction: string; amount_minor: string; currency: string; settlement_mode: string;
  order_status: string; queue_status: string; priority: number;
  enqueued_at: string; assigned_to: string | null; sla_due_at: string | null;
  reassign_count?: number;
  risk_score?: number; risk_decision?: string; customer_name?: string;
}

// Live accept-by countdown (BRD §15/§29). Ticks every second; turns red and
// flips to "reassigning" once the SLA is breached — the sweep will requeue it.
function SlaCountdown({ dueAt }: { dueAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(dueAt).getTime() - now;
  if (ms <= 0) {
    return <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-danger)]"><RotateCcw className="h-3 w-3" /> SLA breached — reassigning…</span>;
  }
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  const urgent = total <= 30;
  return (
    <span className={`ml-2 inline-flex items-center gap-1 text-xs font-medium tabular-nums ${urgent ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-warning)]"}`}>
      <Timer className="h-3 w-3" /> accept in {mm}:{ss}
    </span>
  );
}

export default function OperatorConsolePage() {
  const qc = useQueryClient();
  const [utr, setUtr] = useState<Record<string, string>>({});
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const q = useQuery({
    queryKey: ["operator-queue"],
    queryFn: async () => {
      // Enforce SLA on every poll (no cron needed): returns breached assignments
      // to the queue before we read it, so the view reflects reassignments live.
      await fetch("/api/v1/queue/sweep", { method: "POST" }).catch(() => {});
      const r = await fetch("/api/v1/queue");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { operator_id: string | null; items: QItem[] };
    },
    refetchInterval: 5000,
  });

  const opId = q.data?.operator_id ?? null;
  const items = q.data?.items ?? [];
  const mine = items.filter((i) => i.assigned_to && i.assigned_to === opId && i.queue_status !== "DONE" && i.queue_status !== "CANCELLED");
  const queued = items.filter((i) => i.queue_status === "QUEUED");

  const refetch = () => qc.invalidateQueries({ queryKey: ["operator-queue"] });

  const claim = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/queue/assign", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: (d) => { toast.success(`Claimed ${d.assigned?.order_ref ?? "item"}`); refetch(); },
    onError: (e: Error) => toast.info(e.message),
  });

  const act = useMutation({
    mutationFn: async (v: { ref: string; action: string; utr?: string; tx_hash?: string; reason?: string }) => {
      const r = await fetch(`/api/v1/orders/${v.ref}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: v.action, utr: v.utr, tx_hash: v.tx_hash, reason: v.reason }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: (d) => { toast.success(`→ ${d.status}${d.journal_id ? " (settled to ledger)" : ""}`); refetch(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const uploadProof = useMutation({
    mutationFn: async (v: { ref: string; file: File }) => {
      const fd = new FormData();
      fd.append("order_id", v.ref); fd.append("kind", "screenshot"); fd.append("file", v.file);
      const r = await fetch("/api/v1/transactions/proof", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: (d) => { toast.success(`Proof stored · sha ${String(d.sha256).slice(0, 12)}…`); refetch(); },
    onError: (e: Error) => toast.error("Upload failed", { description: e.message }),
  });

  // Keyboard shortcuts for high-throughput queue work (presentation only — fires
  // the same actions as the buttons). C = claim next, A = accept the first assigned
  // item, P = start processing the first accepted item. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      const firstWith = (st: string) => mine.find((i) => i.order_status === st);
      if (k === "c") { e.preventDefault(); if (!claim.isPending) claim.mutate(); }
      else if (k === "a") { const it = firstWith("ASSIGNED"); if (it) { e.preventDefault(); act.mutate({ ref: it.order_ref, action: "accept" }); } }
      else if (k === "p") { const it = firstWith("ACCEPTED"); if (it) { e.preventDefault(); act.mutate({ ref: it.order_ref, action: "process" }); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mine, claim, act]);

  function actionsFor(it: QItem) {
    const ref = it.order_ref;
    const st = it.order_status;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {st === "ASSIGNED" && <Button size="sm" onClick={() => act.mutate({ ref, action: "accept" })} disabled={act.isPending}><Check className="h-4 w-4" /> Accept</Button>}
        {st === "ACCEPTED" && <Button size="sm" onClick={() => act.mutate({ ref, action: "process" })} disabled={act.isPending}><Play className="h-4 w-4" /> Start processing</Button>}
        {st === "PROCESSING" && (
          <>
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden"
              ref={(el) => { fileRefs.current[ref] = el; }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadProof.mutate({ ref, file: f }); e.target.value = ""; }} />
            <Button size="sm" variant="secondary" onClick={() => fileRefs.current[ref]?.click()} disabled={uploadProof.isPending}><Upload className="h-4 w-4" /> Upload proof</Button>
          </>
        )}
        {st === "PROOF_UPLOADED" && (
          <>
            <Input className="h-8 w-44" placeholder={it.settlement_mode === "USDT" ? "Blockchain tx hash" : "UTR / reference"} value={utr[ref] ?? ""} onChange={(e) => setUtr({ ...utr, [ref]: e.target.value })} />
            <Button size="sm" onClick={() => act.mutate({ ref, action: "complete", ...(it.settlement_mode === "USDT" ? { tx_hash: utr[ref] } : { utr: utr[ref] }) })} disabled={act.isPending}><CheckCircle2 className="h-4 w-4" /> Complete</Button>
          </>
        )}
        {st !== "COMPLETED" && st !== "REJECTED" && (
          <>
            <Button size="sm" variant="secondary" onClick={() => act.mutate({ ref, action: "hold", reason: "operator hold" })} disabled={act.isPending}><AlertTriangle className="h-4 w-4" /> Hold</Button>
            <Button size="sm" variant="danger" onClick={() => act.mutate({ ref, action: "reject", reason: "operator reject" })} disabled={act.isPending}><XCircle className="h-4 w-4" /> Reject</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Operator Console"
        description="Work the FIFO queue — claim the next item, process it, upload proof and complete. Shortcuts: C claim · A accept · P process."
        icon={Headphones}
        actions={<Button size="sm" onClick={() => claim.mutate()} disabled={claim.isPending}><ArrowDownToLine className="h-4 w-4" /> {claim.isPending ? "Claiming…" : "Claim next"}</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile label="In queue" value={queued.length} loading={q.isLoading} />
        <KpiTile label="My active" value={mine.length} variant={mine.length > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Operator" value={opId ? "ready" : "—"} variant="success" loading={q.isLoading} />
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">My active items ({mine.length})</CardTitle><CardDescription>Items assigned to you. Accept within SLA, then process → proof → complete.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {mine.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Nothing assigned. Click “Claim next”.</div>}
          {mine.map((it) => (
            <div key={it.queue_id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-mono">{it.order_ref}</span> · <Badge variant={statusVariant(it.direction)}>{it.direction}</Badge> ·{" "}
                  <span className="font-medium tabular-nums">{formatAmount(Number(it.amount_minor), it.currency)}</span> · {it.settlement_mode} ·{" "}
                  <span className="text-[color:var(--color-text-muted)]">{it.merchant_id}</span>{" "}
                  <Badge variant={statusVariant(it.order_status)}>{it.order_status}</Badge>
                  {it.sla_due_at && it.order_status === "ASSIGNED" && <SlaCountdown dueAt={it.sla_due_at} />}
                  {(it.reassign_count ?? 0) > 0 && <Badge variant="warning" className="ml-2">reassigned ×{it.reassign_count}</Badge>}
                </div>
                {actionsFor(it)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">FIFO queue ({queued.length})</CardTitle><CardDescription>Head-of-line first (priority, then oldest). Claim takes the top item.</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {queued.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Queue empty.</div>}
          {queued.map((it, i) => (
            <div key={it.queue_id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div><span className="text-[color:var(--color-text-muted)]">#{i + 1}</span> <span className="font-mono">{it.order_ref}</span> · <Badge variant={statusVariant(it.direction)}>{it.direction}</Badge> · <span className="tabular-nums">{formatAmount(Number(it.amount_minor), it.currency)}</span> · <span className="text-[color:var(--color-text-muted)]">{it.merchant_id}</span></div>
              <div className="text-xs text-[color:var(--color-text-muted)]">{it.priority > 0 && <Badge variant="brand">P{it.priority}</Badge>} enq {formatDateTime(it.enqueued_at)}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
