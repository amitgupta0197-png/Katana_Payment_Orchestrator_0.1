"use client";

// L1 — refunds. DataView with status / partial-vs-full filter chips +
// search by txn / merchant. Issue dialog promoted from inline card to FAB.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataView } from "@/components/world-class/data-view";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Refund {
  refund_id: string; order_id: string; txn_id: string; merchant_id: string;
  amount_minor: string; currency: string; reason: string; status: string;
  partial: boolean; journal_id: string; requested_by: string;
  requested_at: string; posted_at: string | null; failure_reason: string;
}

function IssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ txn_id: "", amount_minor: "100", reason: "customer_request" });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/refunds", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success("Refund posted"); qc.invalidateQueries({ queryKey: ["refunds"] }); onOpenChange(false); setForm({ txn_id: "", amount_minor: "100", reason: "customer_request" }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue refund</DialogTitle>
          <DialogDescription>Posts a balanced refund journal. SUCCESS → REFUNDED / PARTIALLY_REFUNDED.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>TXN id</Label><Input value={form.txn_id} onChange={(e) => setForm({ ...form, txn_id: e.target.value })} placeholder="TXN-…" /></div>
          <div className="space-y-1.5"><Label>Amount (minor)</Label><Input value={form.amount_minor} onChange={(e) => setForm({ ...form, amount_minor: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Reason</Label><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !form.txn_id}>{m.isPending ? "Posting…" : "Post refund"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function RefundsPage() {
  const canCreate = useCan("refunds", "create");
  const [issueOpen, setIssueOpen] = useState(false);
  const q = useQuery({
    queryKey: ["refunds"],
    queryFn: async () => (await fetch("/api/refunds").then((r) => r.json())) as { refunds: Refund[] },
    refetchInterval: 8000,
  });
  const rows = q.data?.refunds ?? [];

  const cols: Column<Refund>[] = [
    { key: "requested_at", header: "Requested", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "partial", header: "Type", render: (r) => r.partial ? <Badge variant="warning">partial</Badge> : <Badge variant="default">full</Badge> },
    { key: "txn_id", header: "TXN", render: (r) => <span className="font-mono text-xs">{r.txn_id}</span> },
    { key: "merchant_id", header: "Branch" },
    { key: "amount_minor", header: "Amount", render: (r) => <span className="tabular-nums">{r.currency} {r.amount_minor}</span> },
    { key: "reason", header: "Reason" },
    { key: "journal_id", header: "Journal", render: (r) => <span className="font-mono text-xs">{r.journal_id?.slice(0, 8) ?? "—"}</span> },
    { key: "requested_by", header: "By" },
  ];

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Refund lifecycle (BRD §7 P3 + §10 P6). Every refund posts a balanced journal."
        icon={RotateCcw}
      />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.refund_id}
        loading={q.isLoading}
        search={{ placeholder: "Search by txn id, branch, reason…", fields: ["txn_id", "merchant_id", "reason", "requested_by"] }}
        filters={[
          { key: "posted",   label: "Posted",   predicate: (r: Refund) => r.status === "REFUNDED" || r.status === "PARTIALLY_REFUNDED" },
          { key: "pending",  label: "Pending",  predicate: (r: Refund) => r.status === "PENDING" || r.status === "PROCESSING" },
          { key: "failed",   label: "Failed",   predicate: (r: Refund) => r.status === "FAILED" },
          { key: "partial",  label: "Partial",  predicate: (r: Refund) => r.partial },
          { key: "full",     label: "Full",     predicate: (r: Refund) => !r.partial },
        ]}
        fab={canCreate ? { label: "Issue refund", icon: Plus, onClick: () => setIssueOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="refunds"
        emptyTitle="No refunds yet"
        emptyDescription="Issue the first refund for a successful payment to post a balanced journal."
      />
      <IssueDialog open={issueOpen} onOpenChange={setIssueOpen} />
    </>
  );
}
