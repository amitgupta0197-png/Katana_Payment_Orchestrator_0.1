"use client";

// FIFO reconciliation (Katana BRD §21, AC-007). Run a pass that matches completed
// orders against the ledger and classifies mismatches into buckets.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, Play, Wrench } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { EmptyState } from "@/components/world-class/empty-state";
import { useInputDialog } from "@/components/world-class/input-dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";

const bucketVariant = (b: string) =>
  b === "MATCHED" ? "success" : b === "AMOUNT_MISMATCH" || b === "DUPLICATE_UTR" || b === "FAILED_PAYOUT_DEBIT" ? "danger" : "warning";

export default function FifoReconciliationPage() {
  const qc = useQueryClient();
  const { prompt, dialog: inputDialog } = useInputDialog();
  const q = useQuery({
    queryKey: ["fifo-recon"],
    queryFn: async () => {
      const r = await fetch("/api/v1/reconciliation");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { runs: any[]; run_id: string | null; items: any[] };
    },
    refetchInterval: 15000,
  });

  const run = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/reconciliation/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: (d) => { toast.success(`Recon: ${d.matched}/${d.total} matched, ${d.mismatched} mismatched`); qc.invalidateQueries({ queryKey: ["fifo-recon"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const adjust = useMutation({
    mutationFn: async (v: { item_id: string; reason: string }) => {
      const r = await fetch("/api/v1/reconciliation/adjust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("Adjustment raised — awaiting maker-checker on Payouts › approvals"); qc.invalidateQueries({ queryKey: ["fifo-recon"] }); },
    onError: (e: Error) => { if (e.message !== "cancelled") toast.error("Failed", { description: e.message }); },
  });

  async function askAdjust(it: any) {
    const reason = await prompt({ title: `Adjust ${it.order_ref}`, body: `Bucket: ${it.bucket}. Raises a maker-checker adjustment (a different user must approve).`, label: "Reason / code", placeholder: "e.g. gateway late-settle confirmed", required: true, confirmLabel: "Raise adjustment" });
    if (reason) adjust.mutate({ item_id: it.id, reason });
  }

  const latest = q.data?.runs?.[0];
  const items = q.data?.items ?? [];
  const mismatches = items.filter((i) => i.bucket !== "MATCHED");

  return (
    <>
      {inputDialog}
      <PageHeader title="FIFO Reconciliation" description="Match completed orders against the ledger; classify mismatches (BRD §21, AC-007)." icon={GitCompareArrows}
        actions={<Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}><Play className="h-4 w-4" /> {run.isPending ? "Running…" : "Run reconciliation"}</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Total items" value={latest?.total_items ?? 0} loading={q.isLoading} />
        <KpiTile label="Matched" value={latest?.matched ?? 0} variant="success" loading={q.isLoading} />
        <KpiTile label="Mismatched" value={latest?.mismatched ?? 0} variant={(latest?.mismatched ?? 0) > 0 ? "danger" : "default"} loading={q.isLoading} />
        <KpiTile label="Last run" value={latest ? formatDateTime(latest.created_at) : "—"} loading={q.isLoading} />
      </div>

      {latest?.summary && (
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(latest.summary as Record<string, number>).map(([b, n]) => (
            <Badge key={b} variant={bucketVariant(b)}>{b}: {n}</Badge>
          ))}
        </div>
      )}

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Mismatches ({mismatches.length})</CardTitle><CardDescription>Items needing review. Buckets per BRD §21.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {mismatches.length === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No mismatches in the latest run.</div> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-[color:var(--color-text-muted)]">
                <th className="px-2 py-1.5">order</th><th className="px-2 py-1.5">dir</th><th className="px-2 py-1.5">bucket</th>
                <th className="px-2 py-1.5">expected</th><th className="px-2 py-1.5">reported</th><th className="px-2 py-1.5">detail</th><th className="px-2 py-1.5"></th>
              </tr></thead>
              <tbody>
                {mismatches.map((it, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-mono">{it.order_ref}</td>
                    <td className="px-2 py-1.5">{it.direction}</td>
                    <td className="px-2 py-1.5"><Badge variant={bucketVariant(it.bucket)}>{it.bucket}</Badge></td>
                    <td className="px-2 py-1.5 tabular-nums">{it.expected_minor ? formatAmount(Number(it.expected_minor)) : "—"}</td>
                    <td className="px-2 py-1.5 tabular-nums">{it.reported_minor ? formatAmount(Number(it.reported_minor)) : "—"}</td>
                    <td className="px-2 py-1.5 text-[color:var(--color-text-muted)]">{it.detail}</td>
                    <td className="px-2 py-1.5">{it.resolved ? <Badge variant="success">resolved</Badge> : <Button size="sm" variant="ghost" className="h-7" onClick={() => askAdjust(it)} disabled={adjust.isPending}><Wrench className="h-3 w-3" /> Adjust</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs ({q.data?.runs?.length ?? 0})</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {(q.data?.runs ?? []).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center gap-2"><Badge variant="info">{r.source}</Badge><span>{r.matched}/{r.total_items} matched</span>{r.mismatched > 0 && <Badge variant="danger">{r.mismatched} mismatched</Badge>}</div>
              <span className="text-xs text-[color:var(--color-text-muted)]">{r.created_by} · {formatDateTime(r.created_at)}</span>
            </div>
          ))}
          {(q.data?.runs ?? []).length === 0 && <EmptyState icon={GitCompareArrows} title="No reconciliation runs yet" description="Run a pass to match completed orders against the ledger and surface any mismatches." action={{ label: "Run reconciliation", icon: Play, onClick: () => run.mutate() }} />}
        </CardContent>
      </Card>
    </>
  );
}
