"use client";

// L1 — settlement batches. DataView with status filter chips + search by
// merchant. Row click → opens lightweight detail drawer with batch
// breakdown + journal link.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, FileText, Play, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Column } from "@/components/ui/data-table";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerBody,
} from "@/components/ui/drawer";
import { DataView } from "@/components/world-class/data-view";
import { ActivityFeed } from "@/components/world-class/activity-feed";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Batch {
  id: string; merchant_id: string;
  batch_date?: string; period_start: string; period_end: string;
  txn_count: number; gross_amount: number; fee_amount: number; net_payable: number;
  currency: string; status: string;
  utr?: string; payout_ref?: string;
  created_at?: string; completed_at?: string;
}

export default function SettlementPage() {
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<Batch | null>(null);
  const q = useQuery({
    queryKey: ["settlement"],
    queryFn: async () => (await fetch("/api/settlement/batches").then((r) => r.json())) as { batches: Batch[] },
    refetchInterval: 30_000,
  });

  const run = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settlement/trigger", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { merchants: number; batches_paid: number; reserves_released: number };
    },
    onSuccess: (d) => {
      toast.success("Settlement run complete", { description: `${d.merchants} merchant(s), ${d.batches_paid} paid, ${d.reserves_released} reserve(s) released` });
      qc.invalidateQueries({ queryKey: ["settlement"] });
    },
    onError: (e: Error) => toast.error("Settlement run failed", { description: e.message }),
  });

  const payout = useMutation({
    mutationFn: async (batchId: string) => {
      const r = await fetch(`/api/settlement/batches/${batchId}/payout`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { utr: string };
    },
    onSuccess: (d) => {
      toast.success("Payout disbursed", { description: `UTR ${d.utr}` });
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ["settlement"] });
    },
    onError: (e: Error) => toast.error("Payout failed", { description: e.message }),
  });

  const batches = q.data?.batches ?? [];
  const grossTotal = batches.reduce((s, b) => s + Number(b.gross_amount || 0), 0);
  const netTotal = batches.reduce((s, b) => s + Number(b.net_payable || 0), 0);
  const pending = batches.filter((b) => b.status !== "COMPLETED" && b.status !== "PAID").length;

  const cols: Column<Batch>[] = [
    { key: "merchant_id", header: "Branch",
      render: (r) => <button onClick={() => setDrawer(r)} className="text-[color:var(--color-brand)] hover:underline">{r.merchant_id}</button> },
    { key: "period_start", header: "Date",
      render: (r) => <span className="text-xs">{formatDateTime(r.period_start)}</span> },
    { key: "txn_count", header: "Txns", render: (r) => <span className="tabular-nums">{r.txn_count}</span> },
    { key: "gross_amount", header: "Gross", render: (r) => <span className="tabular-nums">{formatAmount(r.gross_amount, r.currency)}</span> },
    { key: "fee_amount",   header: "Fees",  render: (r) => <span className="tabular-nums">{formatAmount(r.fee_amount, r.currency)}</span> },
    { key: "net_payable",  header: "Net",   render: (r) => <span className="tabular-nums font-medium">{formatAmount(r.net_payable, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "utr", header: "UTR", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : "—" },
  ];

  return (
    <>
      <PageHeader
        title="Settlements"
        description="Per-branch settlement batches. Open a row to see breakdown + journal trace."
        icon={Banknote}
        actions={
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            <Play className="h-4 w-4" /> {run.isPending ? "Running…" : "Run settlement cycle"}
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Batches" value={batches.length} loading={q.isLoading} />
        <KpiTile label="Pending" value={pending} variant={pending > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Gross total" value={formatAmount(grossTotal)} loading={q.isLoading} />
        <KpiTile label="Net total" value={formatAmount(netTotal)} variant="success" loading={q.isLoading} />
      </div>

      <DataView
        rows={batches}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by branch or UTR…", fields: ["merchant_id", "utr", "payout_ref"] }}
        filters={[
          { key: "pending",   label: "Pending",   predicate: (r: Batch) => r.status !== "COMPLETED" && r.status !== "PAID" },
          { key: "completed", label: "Completed", predicate: (r: Batch) => r.status === "COMPLETED" || r.status === "PAID" },
          { key: "failed",    label: "Failed",    predicate: (r: Batch) => r.status === "FAILED" },
        ]}
        savedViewKey="settlement"
        refresh={() => q.refetch()}
        emptyTitle="No settlement batches"
        emptyDescription="Batches appear once the settlement run posts journals for the day."
        rowActions={(r) => (
          <button onClick={() => setDrawer(r)} className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center gap-1">
            <FileText className="h-3.5 w-3.5" /> details
          </button>
        )}
      />

      <Drawer open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
        <DrawerContent size="md">
          <DrawerHeader>
            <DrawerTitle>Batch · {drawer?.merchant_id}</DrawerTitle>
            <DrawerDescription>Settlement {drawer && formatDateTime(drawer.period_start)}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            {drawer && (
              <div className="space-y-4">
                <Card>
                  <CardHeader><CardTitle className="text-base">Breakdown</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Txns</span><span className="tabular-nums">{drawer.txn_count}</span></div>
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Gross</span><span className="tabular-nums">{formatAmount(drawer.gross_amount, drawer.currency)}</span></div>
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Fees</span><span className="tabular-nums">{formatAmount(drawer.fee_amount, drawer.currency)}</span></div>
                    <div className="flex justify-between border-t pt-1 font-medium"><span>Net payable</span><span className="tabular-nums">{formatAmount(drawer.net_payable, drawer.currency)}</span></div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-base">Bank trace</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Status</span><Badge variant={statusVariant(drawer.status)}>{drawer.status}</Badge></div>
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">UTR</span><span className="font-mono text-xs">{drawer.utr || "—"}</span></div>
                    <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Payout ref</span><span className="font-mono text-xs">{drawer.payout_ref || "—"}</span></div>
                    {drawer.completed_at && <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Completed</span><span>{formatDateTime(drawer.completed_at)}</span></div>}
                    {drawer.status !== "PAID" && drawer.status !== "COMPLETED" && drawer.status !== "EMPTY" && Number(drawer.net_payable || 0) > 0 && (
                      <div className="pt-2">
                        <Button size="sm" onClick={() => payout.mutate(drawer.id)} disabled={payout.isPending}>
                          <Send className="h-4 w-4" /> {payout.isPending ? "Disbursing…" : "Pay out now"}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-base">Activity</CardTitle><CardDescription>Audit trail for this batch.</CardDescription></CardHeader>
                  <CardContent><ActivityFeed resourceType="settlement_batch" resourceId={drawer.id} limit={20} /></CardContent>
                </Card>
              </div>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}
