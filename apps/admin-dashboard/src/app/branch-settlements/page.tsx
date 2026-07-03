"use client";

// ADMIN provider↔branch settlement console. Sees every settlement across all
// providers/branches with live status, and can MARK-FOR-REVIEW and immediately
// EDIT any field (amount / UTR / status / purpose) to fix reconciliation errors.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Pencil, Flag, Activity } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { settlementStatusVariant, SETTLEMENT_STATUS_LABEL } from "@/components/settlement/status";

const STATUSES = ["REQUESTED", "UTR_SUBMITTED", "VERIFIED", "REJECTED", "REVIEW", "CANCELLED"];

interface Settlement {
  id: string; provider_code?: string; provider_name?: string; merchant_key: string; branch_name?: string;
  amount: number; currency: string; status: string; utr?: string; purpose?: string; transfer_mode?: string;
  beneficiary_snapshot?: any; requested_at: string; verified_at?: string; review_note?: string; note?: string;
}

export default function AdminBranchSettlementsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const q = useQuery({
    queryKey: ["settlements", "admin", statusFilter],
    queryFn: async () => (await fetch(`/api/settlements${statusFilter ? `?status=${statusFilter}` : ""}`).then((r) => r.json())) as { settlements: Settlement[] },
    refetchInterval: 15_000,
  });
  const [edit, setEdit] = useState<Settlement | null>(null);

  const list = q.data?.settlements ?? [];
  const inReview = list.filter((x) => x.status === "REVIEW").length;

  const cols: Column<Settlement>[] = [
    { key: "provider", header: "Provider", render: (r) => <span className="text-xs">{r.provider_name ?? r.provider_code ?? "—"}</span> },
    { key: "branch", header: "Branch", render: (r) => <span className="text-xs font-medium">{r.branch_name ?? r.merchant_key}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "utr", header: "UTR", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">—</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={settlementStatusVariant(r.status)}>{SETTLEMENT_STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: "requested_at", header: "Raised", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "actions", header: "", render: (r) => <Button size="sm" variant="secondary" onClick={() => setEdit(r)}><Pencil className="h-4 w-4" /> Review / edit</Button> },
  ];

  return (
    <>
      <PageHeader
        title="Branch settlements"
        description="Every provider↔branch settlement. Mark for review and edit any field to fix reconciliation errors."
        icon={Banknote}
        actions={<div className="flex items-center gap-2">
          {inReview > 0 && <Badge variant="warning"><Flag className="h-3 w-3 mr-1" />{inReview} in review</Badge>}
          <Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>
        </div>}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base">Settlements</CardTitle><CardDescription>{list.length} shown.</CardDescription></div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border bg-[color:var(--color-surface)] px-3 py-1.5 text-sm">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{SETTLEMENT_STATUS_LABEL[s] ?? s}</option>)}
          </select>
        </CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={q.isLoading} emptyState="No settlements." />
        </CardContent>
      </Card>
      <EditDialog settlement={edit} onClose={() => setEdit(null)} />
    </>
  );
}

function EditDialog({ settlement, onClose }: { settlement: Settlement | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [utr, setUtr] = useState("");
  const [status, setStatus] = useState("");
  const [purpose, setPurpose] = useState("");
  const [reviewNote, setReviewNote] = useState("");

  useEffect(() => {
    if (!settlement) return;
    setAmount(String(settlement.amount ?? "")); setUtr(settlement.utr ?? "");
    setStatus(settlement.status); setPurpose(settlement.purpose ?? ""); setReviewNote(settlement.review_note ?? "");
  }, [settlement]);

  const save = useMutation({
    mutationFn: async (review: boolean) => {
      const body: Record<string, unknown> = { amount: Number(amount), utr, purpose, review_note: reviewNote };
      if (review) body.review = true; else body.status = status;
      const r = await fetch(`/api/settlements/${settlement!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: (_d, review) => { toast.success(review ? "Flagged for review" : "Settlement updated"); qc.invalidateQueries({ queryKey: ["settlements"] }); onClose(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Dialog open={!!settlement} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Review / edit settlement</DialogTitle><DialogDescription>Override any field to fix a reconciliation error. Changes are written to the audit log.</DialogDescription></DialogHeader>
        {settlement && (
          <div className="space-y-3">
            <div className="text-xs text-[color:var(--color-text-muted)]">{settlement.provider_name ?? settlement.provider_code} → {settlement.branch_name ?? settlement.merchant_key}</div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Amount (₹)</Label><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
              <div><Label className="text-xs">Status</Label>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                  {STATUSES.map((s) => <option key={s} value={s}>{SETTLEMENT_STATUS_LABEL[s] ?? s}</option>)}
                </select></div>
              <div className="col-span-2"><Label className="text-xs">UTR</Label><Input value={utr} onChange={(e) => setUtr(e.target.value)} /></div>
              <div className="col-span-2"><Label className="text-xs">Purpose</Label><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
              <div className="col-span-2"><Label className="text-xs">Review note</Label><Input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="why this needs attention / what was corrected" /></div>
            </div>
          </div>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="danger" onClick={() => save.mutate(true)} disabled={save.isPending}><Flag className="h-4 w-4" /> Mark for review</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => save.mutate(false)} disabled={save.isPending}>Save changes</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
