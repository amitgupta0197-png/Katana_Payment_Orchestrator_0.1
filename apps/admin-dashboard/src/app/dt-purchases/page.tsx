"use client";

// DT Purchases (BRD §10). List + create draft + drive the lifecycle:
// DRAFT → PENDING_APPROVAL → AWAITING_FUNDS → FUNDS_SUBMITTED → ACTIVE (60/40 split
// materialised on confirm). Admin/Finance-gated.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Receipt, Plus, Send, ShieldCheck, Banknote, CheckCircle2, XCircle } from "lucide-react";
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
  id: string; banker_id: string; quantity: number; buy_rate: number; total_amount: number;
  priority_percent: number; security_percent: number; status: string; payment_ref: string; created_at: string;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  DRAFT: "default", PENDING_APPROVAL: "info", AWAITING_FUNDS: "warning", FUNDS_SUBMITTED: "info",
  ACTIVE: "success", EXHAUSTED: "warning", SUSPENDED: "warning", REFILLED: "success", CLOSED: "default", REJECTED: "danger",
};

export default function DtPurchasesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dt-purchases"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/purchases");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.purchases as Purchase[];
    },
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ banker_id: "", quantity: "", buy_rate: "" });
  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { banker_id: form.banker_id.trim(), quantity: Number(form.quantity) };
      if (form.buy_rate.trim()) body.buy_rate = Number(form.buy_rate);
      const r = await fetch("/api/v1/dt/purchases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("Draft purchase created"); setCreateOpen(false); setForm({ banker_id: "", quantity: "", buy_rate: "" }); qc.invalidateQueries({ queryKey: ["dt-purchases"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const transition = useMutation({
    mutationFn: async ({ id, to, reference_no }: { id: string; to: string; reference_no?: string }) => {
      const r = await fetch(`/api/v1/dt/purchases/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, reference_no }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("Purchase updated"); qc.invalidateQueries({ queryKey: ["dt-purchases"] }); },
    onError: (e: Error) => toast.error("Transition failed", { description: e.message }),
  });

  // confirm-funds needs a reference number → small dialog
  const [fundsFor, setFundsFor] = useState<Purchase | null>(null);
  const [fundsRef, setFundsRef] = useState("");

  const cols: Column<Purchase>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => <span className="font-medium">{formatAmount(r.total_amount)}</span> },
    { key: "split", header: "Split", render: (r) => `${r.priority_percent}/${r.security_percent}` },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  function actionsFor(r: Purchase) {
    const a: { label: string; icon: any; onClick: () => void; variant?: "danger" }[] = [];
    if (r.status === "DRAFT") a.push({ label: "Submit for approval", icon: Send, onClick: () => transition.mutate({ id: r.id, to: "PENDING_APPROVAL" }) });
    if (r.status === "PENDING_APPROVAL") a.push({ label: "Approve", icon: ShieldCheck, onClick: () => transition.mutate({ id: r.id, to: "AWAITING_FUNDS" }) });
    if (r.status === "AWAITING_FUNDS") a.push({ label: "Mark funds submitted", icon: Banknote, onClick: () => transition.mutate({ id: r.id, to: "FUNDS_SUBMITTED" }) });
    if (r.status === "FUNDS_SUBMITTED") a.push({ label: "Confirm funds → activate", icon: CheckCircle2, onClick: () => { setFundsFor(r); setFundsRef(""); } });
    if (["DRAFT", "PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED"].includes(r.status))
      a.push({ label: "Reject", icon: XCircle, variant: "danger", onClick: () => { if (confirm(`Reject purchase for ${r.banker_id}?`)) transition.mutate({ id: r.id, to: "REJECTED" }); } });
    return a;
  }

  return (
    <>
      <PageHeader title="DT Purchases" description="Banker advance purchases and their approval/funding lifecycle (BRD §10)." icon={Receipt} />
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by banker…", fields: ["banker_id", "status"] }}
        filters={[
          { key: "draft", label: "Draft", predicate: (r) => r.status === "DRAFT" },
          { key: "approval", label: "Pending approval", predicate: (r) => r.status === "PENDING_APPROVAL" },
          { key: "awaiting", label: "Awaiting funds", predicate: (r) => r.status === "AWAITING_FUNDS" || r.status === "FUNDS_SUBMITTED" },
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
        ]}
        fab={{ label: "New purchase", icon: Plus, onClick: () => setCreateOpen(true) }}
        refresh={() => q.refetch()}
        emptyTitle="No DT purchases yet"
        emptyDescription="Create a banker's first advance purchase to allocate priority traffic."
        rowActions={(r) => <RowActions actions={actionsFor(r)} />}
      />

      {/* Create draft */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New DT purchase</DialogTitle>
            <DialogDescription>Advance debit = quantity × rate. Splits 60% priority traffic / 40% security reserve.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Banker (provider code/id)</Label><Input value={form.banker_id} onChange={(e) => setForm({ ...form, banker_id: e.target.value })} placeholder="e.g. BNK-001" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>DT quantity</Label><Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="4000" /></div>
              <div className="space-y-1.5"><Label>Buy rate <span className="text-[color:var(--color-text-subtle)]">(blank = current)</span></Label><Input type="number" step="0.01" value={form.buy_rate} onChange={(e) => setForm({ ...form, buy_rate: e.target.value })} placeholder="104.00" /></div>
            </div>
            {form.quantity && form.buy_rate && <p className="text-xs text-[color:var(--color-text-muted)]">Advance debit: <b>{formatAmount(Number(form.quantity) * Number(form.buy_rate))}</b></p>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!form.banker_id || !form.quantity || create.isPending}>{create.isPending ? "Creating…" : "Create draft"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm funds */}
      <Dialog open={!!fundsFor} onOpenChange={(o) => !o && setFundsFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm funds & activate</DialogTitle>
            <DialogDescription>Records the funding reference and materialises the 60% traffic quota + 40% security reserve.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-text-muted)]">{fundsFor?.banker_id} · advance <b>{fundsFor ? formatAmount(fundsFor.total_amount) : ""}</b></p>
            <div className="space-y-1.5"><Label>Bank reference number</Label><Input value={fundsRef} onChange={(e) => setFundsRef(e.target.value)} placeholder="UTR / payment ref" /></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFundsFor(null)}>Cancel</Button>
            <Button disabled={!fundsRef.trim() || transition.isPending} onClick={() => { if (fundsFor) transition.mutate({ id: fundsFor.id, to: "ACTIVE", reference_no: fundsRef.trim() }, { onSuccess: () => setFundsFor(null) }); }}>Confirm & activate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
