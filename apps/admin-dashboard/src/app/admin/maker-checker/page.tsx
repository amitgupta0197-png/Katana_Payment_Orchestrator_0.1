"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface PendingRow {
  request_id: string; resource_type: string; resource_id: string;
  action: string; payload: any; maker_id: string; maker_email: string;
  status: string; created_at: string;
}
interface RecentRow extends PendingRow {
  checker_email: string; decision_notes: string; decided_at: string;
}

function DecideDialog({ row, decision }: { row: PendingRow; decision: "APPROVED" | "REJECTED" }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/maker-checker", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: row.request_id, decision, notes }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => {
      toast.success(`Request ${decision.toLowerCase()}`);
      setOpen(false); setNotes("");
      qc.invalidateQueries({ queryKey: ["maker-checker"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const isApprove = decision === "APPROVED";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={isApprove ? "default" : "danger"}>
          {isApprove ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {isApprove ? "Approve" : "Reject"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isApprove ? "Approve" : "Reject"} request</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{row.action}</span> on{" "}
            <span className="font-mono text-xs">{row.resource_type}/{row.resource_id}</span>{" "}
            requested by <span className="font-mono text-xs">{row.maker_email || row.maker_id}</span>.
            {isApprove
              ? " On approve, the change is applied and a WORM audit row is written."
              : " On reject, the request is closed with notes only — no platform change."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Decision notes {isApprove ? "(optional)" : "(required)"}</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="why" />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant={isApprove ? "default" : "danger"}
            onClick={() => m.mutate()}
            disabled={m.isPending || (!isApprove && !notes)}
          >
            {m.isPending ? "Working…" : isApprove ? "Confirm approve" : "Confirm reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MakerCheckerPage() {
  const canDecide = useCan("maker_checker", "admin");
  const q = useQuery({
    queryKey: ["maker-checker"],
    queryFn: async () => (await fetch("/api/admin/maker-checker").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as {
      pending: PendingRow[]; recent: RecentRow[];
    },
    refetchInterval: 6000,
  });

  const pendingCols: Column<PendingRow>[] = [
    { key: "created_at", header: "Requested", render: (r) => formatDateTime(r.created_at) },
    { key: "action", header: "Action", render: (r) => <Badge variant="warning">{r.action}</Badge> },
    { key: "resource_id", header: "Resource", render: (r) => <span className="font-mono text-xs">{r.resource_type}/{r.resource_id.slice(0, 8)}</span> },
    { key: "maker_email", header: "Maker", render: (r) => r.maker_email || r.maker_id },
    { key: "payload", header: "Payload", render: (r) => <span className="font-mono text-xs">{JSON.stringify(r.payload).slice(0, 80)}</span> },
    { key: "request_id", header: "Decide", render: (r) => (
      canDecide ? (
        <div className="flex gap-2">
          <DecideDialog row={r} decision="APPROVED" />
          <DecideDialog row={r} decision="REJECTED" />
        </div>
      ) : (
        <span className="text-xs text-[color:var(--color-text-muted)]">read-only</span>
      )
    )},
  ];

  const recentCols: Column<RecentRow>[] = [
    { key: "decided_at", header: "Decided", render: (r) => formatDateTime(r.decided_at) },
    { key: "action", header: "Action" },
    { key: "resource_id", header: "Resource", render: (r) => <span className="font-mono text-xs">{r.resource_type}/{r.resource_id.slice(0, 8)}</span> },
    { key: "status", header: "Decision", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "maker_email", header: "Maker" },
    { key: "checker_email", header: "Checker" },
    { key: "decision_notes", header: "Notes" },
  ];

  return (
    <>
      <PageHeader
        title="Maker-checker queue"
        description="Sensitive actions (KYC approval, provider termination) require a second Super-Admin (BRD §4)."
        icon={ShieldCheck}
        actions={<Badge variant="warning"><Clock className="h-3 w-3" /> {q.data?.pending.length ?? 0} pending</Badge>}
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Pending decisions ({q.data?.pending.length ?? 0})</CardTitle>
          <CardDescription>You cannot approve a request you raised yourself — sign in as a second Super-Admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={pendingCols}
            rows={q.data?.pending ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.request_id}
            emptyState="No pending requests. Trigger one from /providers/[id] (Approve KYC)."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent decisions ({q.data?.recent.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={recentCols}
            rows={q.data?.recent ?? []}
            rowKey={(r) => r.request_id}
            emptyState="No decisions recorded yet."
          />
        </CardContent>
      </Card>
    </>
  );
}
