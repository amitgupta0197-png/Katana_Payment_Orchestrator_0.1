"use client";

// DT Wallet + Traffic Wallet (BRD §9, §11). Per BRD §11 the DT wallet stores purchase
// LOTS rather than one mutable balance, so this screen leads with the lot list and a
// weighted-average rate — never a single "balance" number that would hide lot identity.
// Both wallets are derived operational views; journals stay the source of truth (BRD §9).

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, Gauge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface Banker { banker_id: string; email: string; full_name: string; status: string }
interface Lot { id: string; quantity: number; buy_rate: number; total_amount: number; status: string; created_at: string }
interface Traffic { allocated: number; reserved: number; consumed: number; available: number; utilization: number }
interface LedgerRow {
  id: string; quantity: number; buy_rate: number; total_amount: number; status: string; payment_ref: string;
  created_at: string; quota_allocated: number; quota_reserved: number; quota_consumed: number;
  quota_available: number; reserve_held: number;
}

const LOT_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  ACTIVE: "success", EXHAUSTED: "warning", REFILLED: "info",
};

export default function DtWalletPage() {
  const [bankerId, setBankerId] = useState<string>("");

  const bankersQ = useQuery({
    queryKey: ["dt-bankers"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/bankers");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.bankers as Banker[];
    },
  });

  // Default to the first banker so the screen is never an empty shell on open.
  useEffect(() => {
    if (!bankerId && bankersQ.data?.length) setBankerId(bankersQ.data[0].banker_id);
  }, [bankersQ.data, bankerId]);

  const walletQ = useQuery({
    queryKey: ["dt-wallet", bankerId],
    enabled: !!bankerId,
    queryFn: async () => {
      const r = await fetch(`/api/v1/dt/wallets/${encodeURIComponent(bankerId)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { banker_id: string; lots: Lot[]; traffic: Traffic; ledger: LedgerRow[] };
    },
  });

  const w = walletQ.data;
  const loading = walletQ.isLoading;

  // BRD §11 "weighted average rate" — weight by DT units, not by lot count, so a large
  // lot moves the average proportionally. Guard the zero-quantity case.
  const totalQty = w?.lots.reduce((s, l) => s + l.quantity, 0) ?? 0;
  const totalAdvance = w?.lots.reduce((s, l) => s + l.total_amount, 0) ?? 0;
  const weightedRate = totalQty > 0 ? +(totalAdvance / totalQty).toFixed(4) : 0;
  const activeLots = w?.lots.filter((l) => l.status === "ACTIVE").length ?? 0;

  const lotCols: Column<LedgerRow>[] = [
    { key: "id", header: "Lot", render: (r) => <span className="font-mono text-xs">{r.id.slice(0, 8)}</span> },
    { key: "quantity", header: "DT qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => formatAmount(r.total_amount) },
    { key: "quota_allocated", header: "Quota 60%", render: (r) => formatAmount(r.quota_allocated) },
    { key: "quota_consumed", header: "Consumed", render: (r) => formatAmount(r.quota_consumed) },
    {
      key: "quota_available",
      header: "Available",
      render: (r) => (
        <span className={r.quota_available <= 0 ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-success)]"}>
          {formatAmount(r.quota_available)}
        </span>
      ),
    },
    { key: "reserve_held", header: "Reserve 40%", render: (r) => formatAmount(r.reserve_held) },
    { key: "status", header: "Status", render: (r) => <Badge variant={LOT_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "payment_ref", header: "Ref", render: (r) => r.payment_ref || "—" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="DT Wallet"
        description="Purchase lots and the derived traffic wallet for one banker (BRD §11)."
        icon={Wallet}
      />

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="min-w-[16rem]">
            <Label htmlFor="banker">Banker</Label>
            <select
              id="banker"
              value={bankerId}
              onChange={(e) => setBankerId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
            >
              {(bankersQ.data ?? []).map((b) => (
                <option key={b.banker_id} value={b.banker_id}>
                  {b.banker_id}
                  {b.full_name ? ` — ${b.full_name}` : ""}
                </option>
              ))}
            </select>
          </div>
          {bankersQ.data?.length === 0 && (
            <p className="text-sm text-[color:var(--color-text-muted)]">
              No bankers yet — create one from DT Purchases.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Purchased DT" value={totalQty ? totalQty.toLocaleString("en-IN") : "—"} loading={loading} />
        <KpiTile label="Active lots" value={activeLots} sublabel={`${w?.lots.length ?? 0} total`} loading={loading} />
        <KpiTile label="Weighted avg rate" value={weightedRate ? formatAmount(weightedRate) : "—"} loading={loading} />
        <KpiTile label="Advance value" value={totalAdvance ? formatAmount(totalAdvance) : "—"} loading={loading} />
      </div>

      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" aria-hidden />
            Traffic Wallet
          </CardTitle>
          <CardDescription>Available = allocated − reserved − consumed + reversals (BRD §11).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiTile label="Allocated" value={w ? formatAmount(w.traffic.allocated) : "—"} loading={loading} />
            <KpiTile label="Reserved" value={w ? formatAmount(w.traffic.reserved) : "—"} loading={loading} />
            <KpiTile label="Consumed" value={w ? formatAmount(w.traffic.consumed) : "—"} loading={loading} />
            <KpiTile
              label="Available"
              value={w ? formatAmount(w.traffic.available) : "—"}
              // BRD §16 thresholds: ≤20% warns, exhaustion is a hard stop.
              variant={
                w && w.traffic.allocated > 0
                  ? w.traffic.available <= 0
                    ? "danger"
                    : w.traffic.available / w.traffic.allocated <= 0.2
                      ? "warning"
                      : "success"
                  : "default"
              }
              loading={loading}
            />
            <KpiTile label="Utilization" value={w ? `${w.traffic.utilization}%` : "—"} loading={loading} />
          </div>
        </CardContent>
      </Card>

      <DataView
        rows={w?.ledger ?? []}
        columns={lotCols}
        rowKey={(r) => r.id}
        loading={loading}
        search={{ placeholder: "Search lot or payment ref…", fields: ["id", "payment_ref", "status"] }}
        filters={[
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
          { key: "exhausted", label: "Exhausted", predicate: (r) => r.status === "EXHAUSTED" },
        ]}
        refresh={() => walletQ.refetch()}
        emptyTitle="No lots for this banker"
        emptyDescription="Lots appear once a DT purchase or refill is confirmed."
      />
    </>
  );
}
