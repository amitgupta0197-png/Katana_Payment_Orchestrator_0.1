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
  const [usdt, setUsdt] = useState({ network: "TRC20", amount: "", tx_hash: "", wallet: "" });

  // Today's INR/USDT rate per network, so the banker can see what the USDT they
  // received is worth before approving it.
  const ratesQ = useQuery({
    queryKey: ["usdt-rates"],
    queryFn: async () => {
      const r = await fetch("/api/usdt-rates");
      const d = await r.json().catch(() => null);
      if (!r.ok) return { current: {} as Record<string, { settlement_rate: number }> };
      return d as { current: Record<string, { settlement_rate: number }> };
    },
  });

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
      const amt = Number(usdt.amount);
      const r = await fetch("/api/banker-portal/purchases", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: confirming!.id,
          reference_no: ref.trim() || undefined,
          ...(amt > 0 ? {
            usdt_network: usdt.network,
            usdt_amount: amt,
            usdt_tx_hash: usdt.tx_hash.trim() || undefined,
            usdt_wallet: usdt.wallet.trim() || undefined,
          } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { usdt: { rate: number; inr_value: number; expected_inr: number; shortfall: number } | null };
    },
    onSuccess: (d) => {
      // A shortfall is reported rather than buried — the lot activates at its full
      // size regardless, so an under-payment needs to be visible immediately.
      if (d.usdt && Math.abs(d.usdt.shortfall) >= 1) {
        const over = d.usdt.shortfall < 0;
        toast.warning(`USDT accepted — ${over ? "over" : "short"} by ${formatAmount(Math.abs(d.usdt.shortfall))}`, {
          description: `Received ${formatAmount(d.usdt.inr_value)} against an advance of ${formatAmount(d.usdt.expected_inr)}. The lot is active; raise this with Katana if unintended.`,
        });
      } else {
        toast.success("USDT accepted — lot active", { description: "Traffic quota and security reserve have been created." });
      }
      setConfirming(null); setRef("");
      setUsdt({ network: "TRC20", amount: "", tx_hash: "", wallet: "" });
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
      <PageHeader title="Purchases" description="Your DT advance purchases. Approve the USDT accepted to activate one." icon={Receipt} />
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        filters={[
          { key: "to-confirm", label: "To approve", predicate: (r) => r.status === "FUNDS_SUBMITTED" },
          { key: "pending", label: "In progress", predicate: (r) => ["DRAFT", "PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED"].includes(r.status) },
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No purchases yet"
        emptyDescription="Your DT advance purchases will appear here once created."
        rowActions={(r) =>
          r.status === "FUNDS_SUBMITTED" ? (
            <RowActions actions={[{ label: "Approve USDT accepted", icon: CheckCircle2, onClick: () => { setConfirming(r); setRef(""); } }]} />
          ) : null
        }
      />

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve USDT accepted</DialogTitle>
            <DialogDescription>
              Approving activates the lot and creates your 60% traffic quota and 40%
              security reserve. Only approve once the USDT has actually reached you.
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
              <div className="rounded-md border p-3 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">USDT accepted</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="net">Network</Label>
                    <select
                      id="net"
                      value={usdt.network}
                      onChange={(e) => setUsdt({ ...usdt, network: e.target.value })}
                      className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
                    >
                      {["TRC20", "ERC20", "BEP20"].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="amt">USDT received</Label>
                    <Input id="amt" type="number" step="0.000001" min="0" value={usdt.amount}
                      onChange={(e) => setUsdt({ ...usdt, amount: e.target.value })} placeholder="e.g. 4750" />
                  </div>
                </div>
                {(() => {
                  const rate = ratesQ.data?.current?.[usdt.network]?.settlement_rate;
                  const amt = Number(usdt.amount);
                  if (!rate) return <p className="text-xs text-[color:var(--color-danger)]">No active {usdt.network} rate — Katana must declare today&apos;s rate before this can be approved.</p>;
                  if (!(amt > 0)) return <p className="text-xs text-[color:var(--color-text-muted)]">Today&apos;s {usdt.network} rate: {formatAmount(rate)} per USDT.</p>;
                  const inr = +(amt * rate).toFixed(2);
                  const diff = +(confirming.total_amount - inr).toFixed(2);
                  return (
                    <p className="text-xs">
                      {amt.toLocaleString("en-IN")} USDT × {formatAmount(rate)} = <b>{formatAmount(inr)}</b>
                      {Math.abs(diff) >= 1 && (
                        <span className={diff > 0 ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-warning)]"}>
                          {" "}· {diff > 0 ? "short" : "over"} by {formatAmount(Math.abs(diff))} vs the {formatAmount(confirming.total_amount)} advance
                        </span>
                      )}
                    </p>
                  );
                })()}
                <div className="space-y-1.5">
                  <Label htmlFor="tx">Transaction hash <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
                  <Input id="tx" value={usdt.tx_hash} onChange={(e) => setUsdt({ ...usdt, tx_hash: e.target.value })} placeholder="on-chain tx hash" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wal">Wallet <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
                  <Input id="wal" value={usdt.wallet} onChange={(e) => setUsdt({ ...usdt, wallet: e.target.value })} placeholder="receiving wallet address" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ref">Other reference <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
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
