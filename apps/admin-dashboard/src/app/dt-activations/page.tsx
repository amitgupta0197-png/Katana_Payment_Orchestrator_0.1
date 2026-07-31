"use client";

// DT Activations — the admin review queue for merchants asking to be activated for
// the DT refill model. Approving here is what unlocks a merchant's DT dashboard, so
// pending requests sort to the top and the action is explicit.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, CheckCircle2, XCircle, Ban } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Activation {
  id: string; merchant_id: string; model: string; status: string;
  request_note: string; review_note: string; requested_by: string; requested_at: string;
  reviewed_by: string; reviewed_at: string | null;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  REQUESTED: "warning", APPROVED: "success", REJECTED: "danger", REVOKED: "default",
};

const MODEL_LABEL: Record<string, string> = {
  PURE_INTENT: "Pure intent — provider access",
  DIRECT_QUASI: "Direct quasi — third-party QR + agent",
};

export default function DtActivationsPage() {
  const qc = useQueryClient();
  const [decide, setDecide] = useState<{ row: Activation; to: "APPROVED" | "REJECTED" | "REVOKED" } | null>(null);
  const [note, setNote] = useState("");

  const q = useQuery({
    queryKey: ["dt-activations"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/activations");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { activations: Activation[]; summary: { pending: number; approved: number } };
    },
  });

  const act = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/dt/activations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: decide!.row.id, to: decide!.to, note: note.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { merchant_id: string; status: string };
    },
    onSuccess: (d) => {
      const msg = d.status === "APPROVED"
        ? `${d.merchant_id} activated — its DT dashboard is now unlocked`
        : d.status === "REJECTED" ? `${d.merchant_id} request rejected`
        : `${d.merchant_id} activation revoked`;
      toast.success(msg);
      setDecide(null); setNote("");
      qc.invalidateQueries({ queryKey: ["dt-activations"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const rows = q.data?.activations ?? [];
  const s = q.data?.summary;

  const cols: Column<Activation>[] = [
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-medium">{r.merchant_id}</span> },
    { key: "model", header: "Model", render: (r) => <span className="text-xs">{MODEL_LABEL[r.model] ?? r.model}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "requested_by", header: "Requested by", render: (r) => <span className="text-xs">{r.requested_by || "—"}</span> },
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
    {
      key: "review",
      header: "Reviewed",
      render: (r) => r.reviewed_at
        ? <span className="text-xs">{formatDateTime(r.reviewed_at)}<br /><span className="text-[color:var(--color-text-subtle)]">{r.reviewed_by}</span></span>
        : <span className="text-[color:var(--color-text-subtle)]">—</span>,
    },
    { key: "request_note", header: "Note", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{r.request_note || r.review_note || "—"}</span> },
  ];

  function actionsFor(r: Activation) {
    const a: { label: string; icon: any; onClick: () => void; variant?: "danger" }[] = [];
    if (r.status === "REQUESTED") {
      a.push({ label: "Approve — unlock DT", icon: CheckCircle2, onClick: () => { setDecide({ row: r, to: "APPROVED" }); setNote(""); } });
      a.push({ label: "Reject", icon: XCircle, variant: "danger", onClick: () => { setDecide({ row: r, to: "REJECTED" }); setNote(""); } });
    }
    if (r.status === "APPROVED") {
      a.push({ label: "Revoke activation", icon: Ban, variant: "danger", onClick: () => { setDecide({ row: r, to: "REVOKED" }); setNote(""); } });
    }
    return a;
  }

  return (
    <>
      <PageHeader
        title="DT Activations"
        description="Branches asking to be activated for the DT refill model. Approving unlocks their DT dashboard."
        icon={ShieldCheck}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile label="Pending review" value={s?.pending ?? "—"} variant={s && s.pending > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Activated branches" value={s?.approved ?? "—"} variant="success" loading={q.isLoading} />
        <KpiTile label="Total requests" value={rows.length || "—"} loading={q.isLoading} />
      </div>

      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search branch…", fields: ["merchant_id", "status", "model", "requested_by"] }}
        filters={[
          { key: "pending", label: "Pending", predicate: (r) => r.status === "REQUESTED" },
          { key: "approved", label: "Activated", predicate: (r) => r.status === "APPROVED" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No activation requests"
        emptyDescription="Branches request DT activation from their portal; they appear here for review."
        rowActions={(r) => {
          const a = actionsFor(r);
          return a.length ? <RowActions actions={a} /> : null;
        }}
      />

      <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decide?.to === "APPROVED" ? "Approve activation" : decide?.to === "REJECTED" ? "Reject request" : "Revoke activation"}
            </DialogTitle>
            <DialogDescription>
              {decide?.to === "APPROVED"
                ? "The branch can raise DT purchase and refill requests immediately after this."
                : decide?.to === "REVOKED"
                  ? "The branch loses access to the DT dashboard. Existing lots are unaffected."
                  : "The branch is told the request was not approved and can raise a new one."}
            </DialogDescription>
          </DialogHeader>
          {decide && (
            <div className="space-y-3">
              <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-sm space-y-1">
                <div className="flex justify-between gap-4"><span className="text-[color:var(--color-text-muted)]">Branch</span><b>{decide.row.merchant_id}</b></div>
                <div className="flex justify-between gap-4"><span className="text-[color:var(--color-text-muted)]">Model</span><b>{MODEL_LABEL[decide.row.model] ?? decide.row.model}</b></div>
                {decide.row.request_note && (
                  <div className="pt-1 text-[color:var(--color-text-muted)]">Their note: <span className="text-[color:var(--color-text)]">{decide.row.request_note}</span></div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rn">Note to the branch <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
                <Input id="rn" value={note} onChange={(e) => setNote(e.target.value)} placeholder={decide.to === "REJECTED" ? "Why it was not approved" : "Anything they should know"} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDecide(null)}>Cancel</Button>
            <Button onClick={() => act.mutate()} disabled={act.isPending}>
              {act.isPending ? "Saving…" : decide?.to === "APPROVED" ? "Approve" : decide?.to === "REJECTED" ? "Reject" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
