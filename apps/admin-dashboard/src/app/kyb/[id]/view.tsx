"use client";

// L3 — KYB case detail. World-class shell with tabs:
//   Overview · Documents · Screening · Decisions · Activity · Danger
// Sticky right action rail exposes Approve / Reject / Mark in review with
// risk-tier picker. Eliminates the "decide blind from a row button" P0
// flagged by the audit.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileCheck2, ShieldCheck, AlertTriangle, FileText, Eye, Activity, AlertOctagon,
  CheckCircle2, Pause,
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

interface KybCase {
  id: string; merchant_id: string; status: string; risk_tier?: string;
  opened_at: string; decided_at?: string; decided_by: string;
  screening_hits: number; doc_count: number;
}
interface Doc { id: string; doc_type: string; uri: string; sha256: string; verified_at: string; verified_by: string; created_at: string }
interface ScreeningHit { id: string; hit_kind: string; provider: string; score: string; payload: string; created_at: string }
interface Decision { id: string; decision: string; actor: string; notes: string; decided_at: string }

function DecisionDialog({
  kyb, decision, open, onOpenChange,
}: {
  kyb: KybCase;
  decision: "APPROVED" | "REJECTED" | "IN_REVIEW";
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [riskTier, setRiskTier] = useState<"LOW" | "MEDIUM" | "HIGH">(kyb.risk_tier as any ?? "LOW");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/kyb/${kyb.id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: decision, risk_tier: decision === "APPROVED" ? riskTier : undefined, notes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(`Case ${decision}`);
      onOpenChange(false); setNotes("");
      qc.invalidateQueries({ queryKey: ["kyb", kyb.id] });
      qc.invalidateQueries({ queryKey: ["kyb:admin"] });
      qc.invalidateQueries({ queryKey: ["activity", "kyb_case", kyb.id] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const isApprove = decision === "APPROVED";
  const isReject = decision === "REJECTED";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isApprove ? "Approve" : isReject ? "Reject" : "Mark in review"} — case {kyb.id.slice(0, 8)}</DialogTitle>
          <DialogDescription>
            Merchant {kyb.merchant_id} · {kyb.screening_hits} screening hits · {kyb.doc_count} documents.
            {kyb.screening_hits > 0 && isApprove && (
              <span className="block mt-1 text-[color:var(--color-danger)]">
                ⚠ Screening hits {">"} 0 normally blocks APPROVE per §3.10 — proceed only with documented override.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isApprove && (
            <div className="space-y-1.5">
              <Label>Risk tier</Label>
              <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={riskTier} onChange={(e) => setRiskTier(e.target.value as any)}>
                <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Decision notes {isReject ? "(required)" : "(audit log)"}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isReject ? "e.g. sanctions hit on UBO" : "e.g. docs verified, no sanctions hit"} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={isApprove ? "default" : isReject ? "danger" : "secondary"}
            onClick={() => m.mutate()}
            disabled={m.isPending || (isReject && !notes)}
          >
            {m.isPending ? "Submitting…" : `Confirm ${decision}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KybDetailView({ id }: { id: string }) {
  const canDecide = useCan("kyb", "admin");
  const [dialog, setDialog] = useState<"APPROVED" | "REJECTED" | "IN_REVIEW" | null>(null);

  const q = useQuery({
    queryKey: ["kyb", id],
    queryFn: async () => (await fetch(`/api/kyb/${id}`).then((r) => r.json())) as {
      case: KybCase; docs: Doc[]; screening: ScreeningHit[]; decisions: Decision[];
    },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  if (q.error || !q.data?.case) {
    return <EmptyState icon={FileCheck2} title="KYB case not found" description="It may have been removed or you don't have access." secondaryAction={{ label: "Back to KYB", href: "/kyb" }} />;
  }

  const { case: kyb, docs, screening, decisions } = q.data;
  const isClosed = kyb.status === "APPROVED" || kyb.status === "REJECTED" || kyb.status === "EXPIRED";
  const blockedByScreening = kyb.screening_hits > 0;

  const docCols: Column<Doc>[] = [
    { key: "doc_type", header: "Type" },
    { key: "sha256", header: "Hash", render: (r) => <span className="font-mono text-xs">{r.sha256.slice(0, 12)}…</span> },
    { key: "verified_at", header: "Verified", render: (r) => r.verified_at ? <Badge variant="success">{formatDateTime(r.verified_at)}</Badge> : <Badge variant="warning">pending</Badge> },
    { key: "verified_by", header: "By", render: (r) => r.verified_by || "—" },
    { key: "created_at", header: "Uploaded", render: (r) => formatDateTime(r.created_at) },
  ];
  const screenCols: Column<ScreeningHit>[] = [
    { key: "hit_kind", header: "Kind", render: (r) => <Badge variant="danger">{r.hit_kind}</Badge> },
    { key: "provider", header: "Provider", render: (r) => r.provider || "—" },
    { key: "score", header: "Score", render: (r) => r.score || "—" },
    { key: "payload", header: "Payload", render: (r) => <span className="font-mono text-xs">{r.payload.slice(0, 60)}…</span> },
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
  ];
  const decCols: Column<Decision>[] = [
    { key: "decided_at", header: "When", render: (r) => formatDateTime(r.decided_at) },
    { key: "decision", header: "Decision", render: (r) => <Badge variant={statusVariant(r.decision)}>{r.decision}</Badge> },
    { key: "actor", header: "Actor", render: (r) => r.actor || "—" },
    { key: "notes", header: "Notes" },
  ];

  const tabs = [
    { key: "overview", label: "Overview", icon: FileCheck2, content: (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Case</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Branch</span><span className="font-mono">{kyb.merchant_id}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Status</span><Badge variant={statusVariant(kyb.status)}>{kyb.status}</Badge></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Risk tier</span>{kyb.risk_tier ? <Badge variant={statusVariant(kyb.risk_tier)}>{kyb.risk_tier}</Badge> : <span>—</span>}</div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Opened</span><span>{formatDateTime(kyb.opened_at)}</span></div>
            <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Decided</span><span>{kyb.decided_at ? formatDateTime(kyb.decided_at) : "—"}</span></div>
            {kyb.decided_by && <div className="flex items-center justify-between"><span className="text-[color:var(--color-text-muted)]">Decided by</span><span className="font-mono text-xs">{kyb.decided_by}</span></div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Readiness</CardTitle><CardDescription>What blocks an APPROVE today.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {docs.length > 0 ? <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" /> : <AlertTriangle className="h-4 w-4 text-[color:var(--color-warning)]" />}
              <span className="flex-1">{docs.length} document{docs.length === 1 ? "" : "s"} uploaded</span>
              <Badge variant={docs.length > 0 ? "success" : "warning"}>{docs.filter(d => d.verified_at).length}/{docs.length} verified</Badge>
            </div>
            <div className="flex items-center gap-2">
              {blockedByScreening ? <AlertOctagon className="h-4 w-4 text-[color:var(--color-danger)]" /> : <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" />}
              <span className="flex-1">Screening hits</span>
              <Badge variant={blockedByScreening ? "danger" : "success"}>{kyb.screening_hits}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {decisions.length === 0 ? <Pause className="h-4 w-4 text-[color:var(--color-text-muted)]" /> : <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" />}
              <span className="flex-1">Decision history</span>
              <Badge variant="default">{decisions.length} decision{decisions.length === 1 ? "" : "s"}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    )},
    { key: "docs", label: "Documents", icon: FileText, count: docs.length, content: (
      <Card>
        <CardHeader><CardTitle className="text-base">Documents ({docs.length})</CardTitle></CardHeader>
        <CardContent>
          {docs.length === 0
            ? <EmptyState icon={FileText} title="No documents uploaded" description="The branch needs to upload PAN/GST/MOA before this case can advance." />
            : <DataTable columns={docCols} rows={docs} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "screening", label: "Screening", icon: Eye, count: screening.length, content: (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Screening hits ({screening.length})</CardTitle>
          <CardDescription>Sanctions / PEP / adverse media providers.</CardDescription>
        </CardHeader>
        <CardContent>
          {screening.length === 0
            ? <EmptyState icon={Eye} title="No screening hits" description="No sanctions / PEP / adverse-media matches. Safe to APPROVE if docs verified." />
            : <DataTable columns={screenCols} rows={screening} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "decisions", label: "Decision history", icon: ShieldCheck, count: decisions.length, content: (
      <Card>
        <CardHeader><CardTitle className="text-base">Decisions ({decisions.length})</CardTitle></CardHeader>
        <CardContent>
          {decisions.length === 0
            ? <EmptyState icon={ShieldCheck} title="No decisions recorded yet" description="The first APPROVE / REJECT / IN_REVIEW will land here with the actor + notes." />
            : <DataTable columns={decCols} rows={decisions} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "activity", label: "Activity", icon: Activity, content: (
      <ActivityFeed resourceType="kyb_case" resourceId={id} />
    )},
  ];

  return (
    <>
      <DetailShell
        breadcrumbs={[{ label: "KYB", href: "/kyb" }, { label: kyb.id.slice(0, 8) }]}
        backHref="/kyb"
        title={`KYB · ${kyb.merchant_id}`}
        subtitle={`Case ${kyb.id.slice(0, 8)} · opened ${formatDateTime(kyb.opened_at)}`}
        status={{ label: kyb.status, variant: statusVariant(kyb.status) }}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
            <Badge variant={blockedByScreening ? "danger" : "success"}>{kyb.screening_hits} hits</Badge>
            <Badge variant="info">{docs.length} docs</Badge>
            <Badge variant="info">{decisions.length} decisions</Badge>
            {kyb.risk_tier && <Badge variant={statusVariant(kyb.risk_tier)}>risk {kyb.risk_tier}</Badge>}
          </div>
        }
        sideActions={[
          canDecide && !isClosed ? { label: blockedByScreening ? "Approve (override)" : "Approve", icon: ShieldCheck, onClick: () => setDialog("APPROVED") } : null,
          canDecide && !isClosed ? { label: "Reject", icon: AlertTriangle, variant: "danger" as const, onClick: () => setDialog("REJECTED") } : null,
          canDecide && !isClosed ? { label: "Mark in review", icon: Pause, variant: "secondary" as const, onClick: () => setDialog("IN_REVIEW") } : null,
        ].filter(Boolean) as []}
        tabs={tabs}
      />

      {dialog && (
        <DecisionDialog
          kyb={kyb}
          decision={dialog}
          open={true}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
    </>
  );
}
