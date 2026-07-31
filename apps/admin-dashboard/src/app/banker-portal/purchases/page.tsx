"use client";

// Banker purchases — read-only view of the banker's own advance purchases and where
// each sits in the approval/funding lifecycle. Transitions stay admin/finance-side.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Receipt, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Purchase {
  id: string; quantity: number; buy_rate: number; total_amount: number;
  priority_percent: number; security_percent: number; status: string; payment_ref: string; created_at: string;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  DRAFT: "default", PENDING_APPROVAL: "info", AWAITING_FUNDS: "warning", FUNDS_SUBMITTED: "info",
  ACTIVE: "success", EXHAUSTED: "warning", SUSPENDED: "warning", REFILLED: "success", CLOSED: "default", REJECTED: "danger",
};

export default function BankerPurchasesPage() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<Purchase | null>(null);
  const [ref, setRef] = useState("");

  const q = useQuery({
    queryKey: ["banker-purchases"],
    queryFn: async () => {
      const r = await fetch("/api/banker-portal/purchases");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.purchases as Purchase[];
    },
  });

  // Confirming receipt activates the lot and creates the 60/40 quota + reserve —
  // the point at which this becomes a real position, hence the explicit dialog
  // rather than a one-click row action.
  const confirm = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/banker-portal/purchases", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: confirming!.id, reference_no: ref.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => {
      toast.success("DT receipt confirmed", { description: "The lot is active — quota and reserve have been created." });
      setConfirming(null); setRef("");
      qc.invalidateQueries({ queryKey: ["banker-purchases"] });
      qc.invalidateQueries({ queryKey: ["banker-overview"] });
    },
    onError: (e: Error) => toast.error("Could not confirm", { description: e.message }),
  });

  const cols: Column<Purchase>[] = [
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => <span className="font-medium">{formatAmount(r.total_amount)}</span> },
    { key: "split", header: "Rolling reserve", render: (r) => (
      <div className="flex flex-col leading-tight">
        <span className="font-medium">{formatAmount(r.total_amount * r.security_percent / 100)}</span>
        <span className="text-[10px] text-[color:var(--color-text-muted)]">quota {formatAmount(r.total_amount * r.priority_percent / 100)}</span>
      </div>
    ) },
    { key: "payment_ref", header: "Payment ref", render: (r) => r.payment_ref || "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Purchases" description="Your DT advance purchases. Confirm receipt to activate one." icon={Receipt} />
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        filters={[
          { key: "to-confirm", label: "To confirm", predicate: (r) => r.status === "FUNDS_SUBMITTED" },
          { key: "pending", label: "In progress", predicate: (r) => ["DRAFT", "PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED"].includes(r.status) },
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No purchases yet"
        emptyDescription="Your DT advance purchases will appear here once created."
        rowActions={(r) =>
          r.status === "FUNDS_SUBMITTED" ? (
            <RowActions actions={[{ label: "Confirm DT received", icon: CheckCircle2, onClick: () => { setConfirming(r); setRef(""); } }]} />
          ) : null
        }
      />

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm DT received</DialogTitle>
            <DialogDescription>
              This activates the lot and creates your 60% traffic quota and 40% security
              reserve. Only confirm once the DT has actually reached you.
            </DialogDescription>
          </DialogHeader>
          {confirming && (
            <div className="space-y-3">
              <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Quantity</span><b>{confirming.quantity.toLocaleString("en-IN")} DT</b></div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Rate</span><b>{formatAmount(confirming.buy_rate)}</b></div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Advance</span><b>{formatAmount(confirming.total_amount)}</b></div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Traffic quota (60%)</span><b>{formatAmount(confirming.total_amount * confirming.priority_percent / 100)}</b></div>
                <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Security reserve (40%)</span><b>{formatAmount(confirming.total_amount * confirming.security_percent / 100)}</b></div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ref">Reference <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
                <Input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="UTR / transfer reference" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              {confirm.isPending ? "Confirming…" : "Confirm received"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
