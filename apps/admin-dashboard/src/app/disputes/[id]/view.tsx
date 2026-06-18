"use client";

// L3 — dispute detail. DetailShell with tabs (Overview / Evidence / Ledger /
// Activity) and sticky right rail with represent/win/lose/accept actions
// guarded by the state machine in lib/disputes.ts.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Scale, Gavel, ShieldCheck, AlertTriangle, FileText, Activity, BookOpen,
  Pause, XOctagon, Plus,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DetailShell } from "@/components/world-class/detail-shell";
import { ActivityFeed } from "@/components/world-class/activity-feed";
import { EmptyState } from "@/components/world-class/empty-state";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Dispute {
  dispute_id: string; txn_id: string; order_id: string;
  merchant_id: string; reason_code: string;
  amount_minor: string; currency: string; status: string;
  deadline_at: string | null;
  opened_at: string; opened_by: string;
  resolved_at: string | null; resolved_by: string;
  resolution_notes: string;
  hold_journal_id: string; resolution_journal_id: string;
}
interface Evidence {
  evidence_id: string; evidence_type: string; file_url: string;
  notes: string; submitted_by: string; submitted_at: string;
}

const fmtMoney = (m: string, c: string) => {
  const exp = c === "JPY" ? 0 : c === "USDT" ? 6 : 2;
  try { return `${c} ${(Number(BigInt(m)) / 10 ** exp).toFixed(exp)}`; } catch { return `${c} ${m}`; }
};

function TransitionDialog({
  dispute, to, label, open, onOpenChange,
}: {
  dispute: Dispute; to: "REPRESENTMENT" | "ACCEPTED" | "WON" | "LOST" | "EXPIRED";
  label: string; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/disputes/${dispute.dispute_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, notes: notes || `${label} via UI` }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => {
      toast.success(`Dispute → ${to}`);
      onOpenChange(false); setNotes("");
      qc.invalidateQueries({ queryKey: ["dispute", dispute.dispute_id] });
      qc.invalidateQueries({ queryKey: ["disputes"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const isWin = to === "WON";
  const isLose = to === "LOST" || to === "ACCEPTED";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label} — dispute {dispute.dispute_id.slice(0, 8)}</DialogTitle>
          <DialogDescription>
            {isWin && `Funds will be released back to ${dispute.merchant_id}.`}
            {isLose && `Funds will be refunded to the customer. This posts a balanced journal.`}
            {to === "REPRESENTMENT" && "Marks the dispute as in representment; deadline clock continues."}
            {to === "EXPIRED" && "Deadline lapsed — auto-loses without representment."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Resolution notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 'customer refunded, evidence weak'" />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={isWin ? "default" : isLose ? "danger" : "secondary"} onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? "Working…" : `Confirm ${to}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EvidenceDialog({ dispute, open, onOpenChange }: { dispute: Dispute; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ evidence_type: "receipt", file_url: "", notes: "" });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/disputes/${dispute.dispute_id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => {
      toast.success("Evidence attached");
      onOpenChange(false); setForm({ evidence_type: "receipt", file_url: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["dispute", dispute.dispute_id] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach evidence</DialogTitle>
          <DialogDescription>Used for representment to the issuing bank.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={form.evidence_type} onChange={(e) => setForm({ ...form, evidence_type: e.target.value })}>
              <option value="receipt">receipt</option>
              <option value="shipping_proof">shipping_proof</option>
              <option value="customer_correspondence">customer_correspondence</option>
              <option value="ip_log">ip_log</option>
              <option value="id_match">id_match</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>File URL (S3/CDN)</Label>
            <Input value={form.file_url} onChange={(e) => setForm({ ...form, file_url: e.target.value })} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="context for the issuing bank" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Attaching…" : "Attach"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DisputeDetailView({ id }: { id: string }) {
  const canUpdate = useCan("disputes", "update");
  const [pending, setPending] = useState<"REPRESENTMENT" | "WON" | "LOST" | "ACCEPTED" | "EXPIRED" | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const q = useQuery({
    queryKey: ["dispute", id],
    queryFn: async () => (await fetch(`/api/disputes/${id}`).then((r) => r.json())) as { dispute: Dispute; evidence: Evidence[] },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  if (q.error || !q.data?.dispute) {
    return <EmptyState icon={Scale} title="Dispute not found" description="It may have been removed or you don't have access." secondaryAction={{ label: "Back to disputes", href: "/disputes" }} />;
  }

  const { dispute, evidence } = q.data;
  const isClosed = ["ACCEPTED", "WON", "LOST", "EXPIRED"].includes(dispute.status);
  const canRepresent = dispute.status === "DISPUTE_OPEN";
  const deadline = dispute.deadline_at ? new Date(dispute.deadline_at) : null;
  const daysLeft = deadline ? Math.ceil((deadline.getTime() - Date.now()) / 86400_000) : null;

  const evidenceCols: Column<Evidence>[] = [
    { key: "evidence_type", header: "Type", render: (r) => <Badge variant="brand">{r.evidence_type}</Badge> },
    { key: "submitted_at", header: "Attached", render: (r) => formatDateTime(r.submitted_at) },
    { key: "submitted_by", header: "By", render: (r) => r.submitted_by || "—" },
    { key: "file_url", header: "File", render: (r) => r.file_url ? <a className="text-[color:var(--color-brand)] hover:underline text-xs" href={r.file_url} target="_blank" rel="noreferrer">{r.file_url.slice(0, 40)}…</a> : "—" },
    { key: "notes", header: "Notes" },
  ];

  const tabs = [
    { key: "overview", label: "Overview", icon: Scale, content: (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Dispute</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Merchant</span><span className="font-mono">{dispute.merchant_id}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Transaction</span><span className="font-mono text-xs">{dispute.txn_id}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Reason code</span><Badge variant="warning">{dispute.reason_code}</Badge></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Amount</span><span className="font-medium tabular-nums">{fmtMoney(dispute.amount_minor, dispute.currency)}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Opened</span><span>{formatDateTime(dispute.opened_at)}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">By</span><span className="font-mono text-xs">{dispute.opened_by || "—"}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">SLA / clock</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Deadline</span><span>{deadline ? formatDateTime(deadline.toISOString()) : "—"}</span></div>
            {daysLeft !== null && !isClosed && (
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--color-text-muted)]">Days left</span>
                <Badge variant={daysLeft <= 1 ? "danger" : daysLeft <= 3 ? "warning" : "success"}>{daysLeft}d</Badge>
              </div>
            )}
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Resolved</span><span>{dispute.resolved_at ? formatDateTime(dispute.resolved_at) : "—"}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">By</span><span className="font-mono text-xs">{dispute.resolved_by || "—"}</span></div>
            {dispute.resolution_notes && <div className="mt-2 rounded-md bg-[color:var(--color-surface-muted)] p-2 text-xs">{dispute.resolution_notes}</div>}
          </CardContent>
        </Card>
      </div>
    )},
    { key: "evidence", label: "Evidence", icon: FileText, count: evidence.length, content: (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Evidence ({evidence.length})</CardTitle>
          {canUpdate && !isClosed && (
            <Button size="sm" onClick={() => setEvidenceOpen(true)}><Plus className="h-4 w-4" /> Attach</Button>
          )}
        </CardHeader>
        <CardContent>
          {evidence.length === 0
            ? <EmptyState icon={FileText} title="No evidence attached" description="Attach receipts, shipping proof, IP logs to strengthen representment." />
            : <DataTable columns={evidenceCols} rows={evidence} rowKey={(r) => r.evidence_id} />}
        </CardContent>
      </Card>
    )},
    { key: "ledger", label: "Ledger", icon: BookOpen, content: (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Journal references</CardTitle>
          <CardDescription>Balanced postings backing every transition.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between rounded-md border p-2">
            <span className="text-[color:var(--color-text-muted)]">Hold journal</span>
            <span className="font-mono text-xs">{dispute.hold_journal_id?.slice(0, 16) ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2">
            <span className="text-[color:var(--color-text-muted)]">Resolution journal</span>
            <span className="font-mono text-xs">{dispute.resolution_journal_id || "—"}</span>
          </div>
        </CardContent>
      </Card>
    )},
    { key: "activity", label: "Activity", icon: Activity, content: (
      <ActivityFeed resourceType="dispute" resourceId={id} />
    )},
  ];

  return (
    <>
      <DetailShell
        breadcrumbs={[{ label: "Disputes", href: "/disputes" }, { label: dispute.dispute_id.slice(0, 8) }]}
        backHref="/disputes"
        title={`Dispute · ${dispute.merchant_id}`}
        subtitle={`Txn ${dispute.txn_id} · ${dispute.reason_code}`}
        status={{ label: dispute.status, variant: statusVariant(dispute.status) }}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
            <span className="font-medium tabular-nums">{fmtMoney(dispute.amount_minor, dispute.currency)}</span>
            <span>·</span>
            <span>opened {formatDateTime(dispute.opened_at)}</span>
            {daysLeft !== null && !isClosed && (
              <><span>·</span><Badge variant={daysLeft <= 1 ? "danger" : daysLeft <= 3 ? "warning" : "info"}>{daysLeft}d to deadline</Badge></>
            )}
            <Badge variant="info">{evidence.length} evidence</Badge>
          </div>
        }
        sideActions={[
          canUpdate && !isClosed ? { label: "Attach evidence", icon: Plus, variant: "secondary" as const, onClick: () => setEvidenceOpen(true) } : null,
          canUpdate && canRepresent ? { label: "Submit representment", icon: Gavel, variant: "secondary" as const, onClick: () => setPending("REPRESENTMENT") } : null,
          canUpdate && !isClosed ? { label: "Win (release)", icon: ShieldCheck, onClick: () => setPending("WON") } : null,
          canUpdate && !isClosed ? { label: "Lose (refund)", icon: AlertTriangle, variant: "danger" as const, onClick: () => setPending("LOST") } : null,
          canUpdate && canRepresent ? { label: "Accept liability", icon: XOctagon, variant: "secondary" as const, onClick: () => setPending("ACCEPTED") } : null,
          canUpdate && !isClosed ? { label: "Mark expired", icon: Pause, variant: "secondary" as const, onClick: () => setPending("EXPIRED") } : null,
        ].filter(Boolean) as []}
        tabs={tabs}
      />

      {pending && (
        <TransitionDialog
          dispute={dispute}
          to={pending}
          label={pending === "WON" ? "Win" : pending === "LOST" ? "Lose" : pending === "ACCEPTED" ? "Accept liability" : pending === "REPRESENTMENT" ? "Submit representment" : "Mark expired"}
          open={true}
          onOpenChange={(o) => !o && setPending(null)}
        />
      )}
      <EvidenceDialog dispute={dispute} open={evidenceOpen} onOpenChange={setEvidenceOpen} />
    </>
  );
}
