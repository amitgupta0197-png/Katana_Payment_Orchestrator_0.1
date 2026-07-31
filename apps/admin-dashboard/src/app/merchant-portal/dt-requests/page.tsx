"use client";

// DT Requests — merchant side of the DT flow (role change 2026-07-31).
// The merchant raises the request here; the banker confirms the DT was received,
// which is what activates the lot. A request sits in PENDING_APPROVAL until then, so
// nothing a merchant does here creates a live position on its own.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Purchase {
  id: string; banker_id: string; quantity: number; buy_rate: number; total_amount: number;
  status: string; received_confirmed_by: string; received_confirmed_at: string | null;
  created_by: string; created_at: string;
}
interface Refill {
  id: string; banker_id: string; quantity: number | null; trigger: string; status: string;
  received_confirmed_by: string; received_confirmed_at: string | null; created_at: string;
}
interface Banker { banker_id: string; label: string }

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  DRAFT: "default", PENDING_APPROVAL: "info", AWAITING_FUNDS: "warning", FUNDS_SUBMITTED: "info",
  ACTIVE: "success", EXHAUSTED: "warning", SUSPENDED: "warning", REFILLED: "success",
  CLOSED: "default", REJECTED: "danger",
  OPEN: "warning", FUNDED: "info", VERIFIED: "success", CANCELLED: "danger",
};

// Plain-language stage, so a merchant reading the table knows whose move it is.
function whoseMove(status: string): string {
  switch (status) {
    case "PENDING_APPROVAL": return "With Katana for approval";
    case "AWAITING_FUNDS":   return "Awaiting funding";
    case "FUNDS_SUBMITTED":  return "With the banker to confirm receipt";
    case "ACTIVE":           return "Confirmed and live";
    case "REJECTED":         return "Rejected";
    default: return "";
  }
}

export default function MerchantDtRequestsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ banker_id: "", quantity: "", kind: "PURCHASE" as "PURCHASE" | "REFILL" });

  const q = useQuery({
    queryKey: ["mp:dt-requests"],
    queryFn: async () => {
      const r = await fetch("/api/merchant-portal/dt-requests");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as {
        merchant_id: string; purchases: Purchase[]; refills: Refill[];
        rate: { rate: number; currency: string; version: number } | null; bankers: Banker[];
      };
    },
  });

  const raise = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/merchant-portal/dt-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banker_id: form.banker_id, quantity: Number(form.quantity), kind: form.kind }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { kind: string; total?: number; rate?: number };
    },
    onSuccess: (d) => {
      toast.success(d.kind === "REFILL" ? "Refill request raised" : "DT purchase request raised", {
        description: d.total ? `${form.quantity} DT × ${formatAmount(d.rate!)} = ${formatAmount(d.total)} — sent for approval.` : undefined,
      });
      setOpen(false);
      setForm({ banker_id: "", quantity: "", kind: "PURCHASE" });
      qc.invalidateQueries({ queryKey: ["mp:dt-requests"] });
    },
    onError: (e: Error) => toast.error("Could not raise request", { description: e.message }),
  });

  const purchases = q.data?.purchases ?? [];
  const refills = q.data?.refills ?? [];
  const rate = q.data?.rate ?? null;
  const bankers = q.data?.bankers ?? [];
  const awaitingBanker = purchases.filter((p) => p.status === "FUNDS_SUBMITTED").length;
  const live = purchases.filter((p) => p.status === "ACTIVE").length;

  // Live preview of what the merchant is asking for, at the current rate.
  const qty = Number(form.quantity);
  const preview = rate && qty > 0 ? +(qty * rate.rate).toFixed(2) : null;

  const purchaseCols: Column<Purchase>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => <span className="font-medium">{formatAmount(r.total_amount)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "stage", header: "Stage", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{whoseMove(r.status)}</span> },
    {
      key: "received",
      header: "Receipt confirmed",
      render: (r) => r.received_confirmed_at
        ? <span className="text-xs">{formatDateTime(r.received_confirmed_at)}<br /><span className="text-[color:var(--color-text-subtle)]">{r.received_confirmed_by}</span></span>
        : <span className="text-[color:var(--color-text-subtle)]">—</span>,
    },
    { key: "created_at", header: "Raised", render: (r) => formatDateTime(r.created_at) },
  ];

  const refillCols: Column<Refill>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "quantity", header: "DT Qty", render: (r) => (r.quantity != null ? r.quantity.toLocaleString("en-IN") : "—") },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Raised", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="DT Requests"
        description="Raise a DT purchase or refill request. The banker confirms receipt, which activates it."
        icon={Coins}
        actions={
          <Button onClick={() => setOpen(true)} disabled={!rate}>
            <Plus className="h-4 w-4" /> New request
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Current DT rate" value={rate ? formatAmount(rate.rate) : "— not set —"} sublabel={rate ? `v${rate.version}` : "ask Katana to set it"} variant={rate ? "default" : "danger"} loading={q.isLoading} />
        <KpiTile label="My requests" value={purchases.length || "—"} loading={q.isLoading} />
        <KpiTile label="Awaiting banker confirmation" value={awaitingBanker} variant={awaitingBanker > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Live" value={live} variant="success" loading={q.isLoading} />
      </div>

      <DataView
        rows={purchases}
        columns={purchaseCols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search banker or status…", fields: ["banker_id", "status"] }}
        filters={[
          { key: "awaiting", label: "Awaiting banker", predicate: (r) => r.status === "FUNDS_SUBMITTED" },
          { key: "active", label: "Live", predicate: (r) => r.status === "ACTIVE" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No DT requests yet"
        emptyDescription="Raise one with “New request”. It goes to Katana for approval, then to the banker to confirm receipt."
      />

      {refills.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Refill requests</h2>
          <DataView
            rows={refills}
            columns={refillCols}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            refresh={() => q.refetch()}
            emptyTitle="No refill requests"
            emptyDescription=""
          />
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New DT request</DialogTitle>
            <DialogDescription>
              Goes to Katana for approval, then to the banker to confirm the DT was received.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex rounded-md border p-1 text-xs">
                {(["PURCHASE", "REFILL"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setForm({ ...form, kind: k })}
                    className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${form.kind === k ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"}`}
                  >
                    {k === "PURCHASE" ? "New purchase" : "Refill"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bk">Banker</Label>
              <select
                id="bk"
                value={form.banker_id}
                onChange={(e) => setForm({ ...form, banker_id: e.target.value })}
                className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
              >
                <option value="">Select a banker…</option>
                {bankers.map((b) => (
                  <option key={b.banker_id} value={b.banker_id}>{b.label || b.banker_id}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qty">DT quantity</Label>
              <Input id="qty" type="number" min="1" step="1" value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="e.g. 4000" />
              {preview !== null && (
                <p className="text-xs text-[color:var(--color-text-muted)]">
                  {qty.toLocaleString("en-IN")} DT × {formatAmount(rate!.rate)} = <b>{formatAmount(preview)}</b> advance
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => raise.mutate()} disabled={raise.isPending || !form.banker_id || !(Number(form.quantity) > 0)}>
              {raise.isPending ? "Raising…" : "Raise request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
