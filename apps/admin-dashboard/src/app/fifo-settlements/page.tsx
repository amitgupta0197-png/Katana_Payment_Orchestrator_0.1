"use client";

// FIFO settlement batches (PayTech BRD §19/§22). Net a merchant's completed
// pay-ins into a batch; large/adjusted batches route to maker-checker.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/world-class/empty-state";
import { MoneyInput } from "@/components/world-class/money-input";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

export default function FifoSettlementsPage() {
  const qc = useQueryClient();
  const [f, setF] = useState({ merchant_id: "", chargeback_hold: "", adjustment: "" });

  const q = useQuery({
    queryKey: ["fifo-settlements"],
    queryFn: async () => (await fetch("/api/v1/settlements").then((r) => r.json())) as { batches: any[] },
    refetchInterval: 12000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/settlements", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: f.merchant_id, chargeback_hold: f.chargeback_hold || undefined, adjustment: f.adjustment || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: (d) => { toast.success(d.batch?.approval_required ? "Batch created — awaiting maker-checker" : `Settled ${d.batch?.batch_ref}`); setF({ merchant_id: "", chargeback_hold: "", adjustment: "" }); qc.invalidateQueries({ queryKey: ["fifo-settlements"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const batches = q.data?.batches ?? [];

  return (
    <>
      <PageHeader title="FIFO Settlements" description="Net completed pay-ins into settlement batches (BRD §22). Large/adjusted batches need approval." icon={Banknote} />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Create settlement batch</CardTitle><CardDescription>Nets all COMPLETED, unsettled pay-ins for the merchant. Optional chargeback hold / approved adjustment (₹).</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <Input className="h-9 w-48" placeholder="merchant code e.g. M10001" value={f.merchant_id} onChange={(e) => setF({ ...f, merchant_id: e.target.value })} />
          <MoneyInput className="w-40" placeholder="chargeback hold" value={f.chargeback_hold} onChange={(v) => setF({ ...f, chargeback_hold: v })} />
          <Input className="h-9 w-40" placeholder="adjustment ± ₹" value={f.adjustment} onChange={(e) => setF({ ...f, adjustment: e.target.value })} />
          <Button size="sm" onClick={() => create.mutate()} disabled={!f.merchant_id || create.isPending}><Plus className="h-4 w-4" /> Create batch</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Settlement batches ({batches.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {batches.length === 0 ? <EmptyState icon={Banknote} title="No settlement batches yet" description="Enter a merchant code above and create a batch to net their completed pay-ins into a payout. Large or adjusted batches go to maker-checker." /> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-[color:var(--color-text-muted)]">
                <th className="px-2 py-1.5">batch</th><th className="px-2 py-1.5">merchant</th><th className="px-2 py-1.5">orders</th>
                <th className="px-2 py-1.5">gross</th><th className="px-2 py-1.5">MDR</th><th className="px-2 py-1.5">reserve</th>
                <th className="px-2 py-1.5">GST</th><th className="px-2 py-1.5">hold</th><th className="px-2 py-1.5">adj</th>
                <th className="px-2 py-1.5">net</th><th className="px-2 py-1.5">status</th><th className="px-2 py-1.5">when</th>
              </tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-mono">{b.batch_ref}</td>
                    <td className="px-2 py-1.5">{b.merchant_id}</td>
                    <td className="px-2 py-1.5 tabular-nums">{b.order_count}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.gross_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.mdr_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.reserve_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.gst_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.chargeback_hold_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatAmount(Number(b.adjustment_minor), b.currency)}</td>
                    <td className="px-2 py-1.5 tabular-nums font-medium">{formatAmount(Number(b.net_minor), b.currency)}</td>
                    <td className="px-2 py-1.5"><Badge variant={statusVariant(b.status)}>{b.status}</Badge></td>
                    <td className="px-2 py-1.5 text-[color:var(--color-text-muted)]">{formatDateTime(b.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
