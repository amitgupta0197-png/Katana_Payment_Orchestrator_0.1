"use client";

// L1 — KYB cases. World-class DataView w/ status filter chips + search +
// kanban-by-status view. Row click → L3 detail at /kyb/[id]. Row kebab
// exposes Open / View activity / Approve / Reject / Mark-in-review.

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, ShieldCheck, AlertTriangle, Pause, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface KybCase {
  id: string; merchant_id: string; status: string; risk_tier?: string;
  opened_at: string; decided_at?: string; decided_by: string;
  screening_hits: number; doc_count: number;
}

function QuickDecisionDialog({
  kyb, decision, open, onOpenChange,
}: { kyb: KybCase; decision: "APPROVED" | "REJECTED" | "IN_REVIEW"; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [riskTier, setRiskTier] = useState<"LOW" | "MEDIUM" | "HIGH">((kyb.risk_tier as any) ?? "LOW");
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
      qc.invalidateQueries({ queryKey: ["kyb:admin"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const isApprove = decision === "APPROVED";
  const isReject = decision === "REJECTED";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isApprove ? "Approve" : isReject ? "Reject" : "Mark in review"} — {kyb.merchant_id}</DialogTitle>
          <DialogDescription>
            {kyb.screening_hits} screening hits · {kyb.doc_count} docs. {isApprove && kyb.screening_hits > 0 && (
              <span className="block mt-1 text-[color:var(--color-danger)]">
                ⚠ Screening hits {">"} 0 normally blocks APPROVE per §3.10.
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
            <Label>Decision notes {isReject ? "(required)" : "(audit)"}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isReject ? "e.g. sanctions hit" : "context"} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={isApprove ? "default" : isReject ? "danger" : "secondary"} onClick={() => m.mutate()} disabled={m.isPending || (isReject && !notes)}>
            {m.isPending ? "Submitting…" : `Confirm ${decision}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KybPage() {
  const canDecide = useCan("kyb", "admin");
  const [decisionFor, setDecisionFor] = useState<{ kyb: KybCase; decision: "APPROVED" | "REJECTED" | "IN_REVIEW" } | null>(null);

  const q = useQuery({
    queryKey: ["kyb:admin"],
    queryFn: async () => (await fetch("/api/kyb").then((r) => r.json())) as { cases: KybCase[] },
  });
  const cases = q.data?.cases ?? [];

  const cols: Column<KybCase>[] = [
    { key: "merchant_id", header: "Merchant",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/kyb/${r.id}`}>{r.merchant_id}</Link> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "doc_count", header: "Docs" },
    { key: "screening_hits", header: "Hits", render: (r) => r.screening_hits > 0 ? <Badge variant="danger">{r.screening_hits}</Badge> : <Badge variant="success">0</Badge> },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "decided_at", header: "Decided", render: (r) => r.decided_at ? formatDateTime(r.decided_at) : "—" },
    { key: "decided_by", header: "By", render: (r) => r.decided_by || "—" },
  ];

  return (
    <>
      <PageHeader
        title="KYB"
        description="Payments-specific KYB cases (PRODUCT_VISION §3.10). Open a case to see docs, screening, decision history."
        icon={FileCheck2}
      />
      <DataView
        rows={cases}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/kyb/${r.id}`}
        search={{ placeholder: "Search by merchant id…", fields: ["merchant_id", "decided_by", "status"] }}
        filters={[
          { key: "open",       label: "Open",       predicate: (r) => r.status !== "APPROVED" && r.status !== "REJECTED" && r.status !== "EXPIRED" },
          { key: "in-review",  label: "In review",  predicate: (r) => r.status === "IN_REVIEW" },
          { key: "hits",       label: "With hits",  predicate: (r) => r.screening_hits > 0 },
          { key: "approved",   label: "Approved",   predicate: (r) => r.status === "APPROVED" },
          { key: "rejected",   label: "Rejected",   predicate: (r) => r.status === "REJECTED" },
        ]}
        modes={["table", "kanban"]}
        kanbanColumn={(r) => r.status}
        kanbanColumns={[
          { key: "OPEN", label: "Open" },
          { key: "IN_REVIEW", label: "In review" },
          { key: "APPROVED", label: "Approved" },
          { key: "REJECTED", label: "Rejected" },
        ]}
        renderCard={(r) => (
          <Link href={`/kyb/${r.id}`} className="block rounded-md border bg-[color:var(--color-surface)] p-2 text-sm hover:bg-[color:var(--color-surface-muted)]">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">{r.merchant_id}</span>
              <Badge variant={r.screening_hits > 0 ? "danger" : "success"}>{r.screening_hits} hits</Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
              <span>{r.doc_count} docs</span><span>·</span><span>{formatDateTime(r.opened_at)}</span>
            </div>
          </Link>
        )}
        savedViewKey="kyb"
        refresh={() => q.refetch()}
        emptyTitle="No KYB cases yet"
        emptyDescription="Cases open automatically when a merchant reaches the SCREENING stage."
        rowActions={(r) => {
          const closed = r.status === "APPROVED" || r.status === "REJECTED" || r.status === "EXPIRED";
          return (
            <RowActions
              openHref={`/kyb/${r.id}`}
              actions={[
                { label: "Open case", icon: ExternalLink, onClick: () => (window.location.href = `/kyb/${r.id}`) },
                ...(canDecide && !closed ? [
                  { label: "Approve", icon: ShieldCheck, onClick: () => setDecisionFor({ kyb: r, decision: "APPROVED" }) },
                  { label: "Reject", icon: AlertTriangle, variant: "danger" as const, onClick: () => setDecisionFor({ kyb: r, decision: "REJECTED" }) },
                  { label: "Mark in review", icon: Pause, onClick: () => setDecisionFor({ kyb: r, decision: "IN_REVIEW" }) },
                ] : []),
              ]}
            />
          );
        }}
      />

      {decisionFor && (
        <QuickDecisionDialog
          kyb={decisionFor.kyb}
          decision={decisionFor.decision}
          open={true}
          onOpenChange={(o) => !o && setDecisionFor(null)}
        />
      )}
    </>
  );
}
