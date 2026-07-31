"use client";

// Provider Transactions & Reimbursement — gross value across all channels
// (PoolPay / Quickpay / PayU / Cashfree / Razorpay …) for the provider's
// assigned merchants. Backed by /api/provider-portal/transactions.

import { useQuery } from "@tanstack/react-query";
import { Receipt, TrendingUp, Store, Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";

interface Totals { gross: number; success_count: number; failed_count: number; pending_count: number; total_count: number }
interface ByMerchant { merchant_id: string; gross: number; count: number; success: number }
interface ByChannel { channel: string; gross: number; count: number }
interface Txn { source: string; merchant_id: string; channel: string; method: string; status: string; amount: number; ref: string; created_at: string }
interface Data { merchants: string[]; totals: Totals; by_merchant: ByMerchant[]; by_channel: ByChannel[]; recent: Txn[] }

export default function ProviderTransactionsPage() {
  const q = useQuery({
    queryKey: ["pp:transactions"],
    queryFn: async () => (await fetch("/api/provider-portal/transactions").then(async (r) => {
      const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d;
    })) as Data,
    refetchInterval: 30_000,
  });
  const d = q.data;
  const t = d?.totals;

  const merCols: Column<ByMerchant>[] = [
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "count", header: "Txns", render: (r) => <span className="tabular-nums">{r.count}</span> },
    { key: "success", header: "Successful", render: (r) => <span className="tabular-nums">{r.success}</span> },
    { key: "gross", header: "Gross (reimbursable)", render: (r) => <span className="font-medium tabular-nums">{formatAmount(r.gross)}</span> },
  ];
  const recentCols: Column<Txn>[] = [
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "channel", header: "Channel", render: (r) => <Badge variant="brand">{railLabel(r.channel)}</Badge> },
    { key: "method", header: "Method", render: (r) => r.method || "—" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Transactions & Reimbursement"
        description="Gross value across all channels for your assigned branches. Successful collections are reimbursable."
        icon={Receipt}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Gross (reimbursable)" value={formatAmount(t?.gross ?? 0)} sublabel={`${t?.success_count ?? 0} successful`} icon={TrendingUp} variant="success" loading={q.isLoading} />
        <KpiTile label="Total transactions" value={t?.total_count ?? 0} icon={Receipt} loading={q.isLoading} />
        <KpiTile label="Pending" value={t?.pending_count ?? 0} variant={(t?.pending_count ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Branches" value={d?.merchants.length ?? 0} icon={Store} loading={q.isLoading} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gross by branch</CardTitle>
            <CardDescription>Reimbursable gross per assigned branch.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={merCols} rows={d?.by_merchant ?? []} rowKey={(r) => r.merchant_id} loading={q.isLoading}
              emptyState="No transactions yet for your branches." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gross by channel</CardTitle>
            <CardDescription>Katana Pay · Quickpay · PayU · Cashfree · Razorpay …</CardDescription>
          </CardHeader>
          <CardContent>
            {(d?.by_channel ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No channel activity yet.</div>
            ) : (
              <ul className="space-y-2">
                {d!.by_channel.map((c) => {
                  const max = Math.max(1, ...d!.by_channel.map((x) => x.gross));
                  return (
                    <li key={c.channel}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="inline-flex items-center gap-2"><Network className="h-3.5 w-3.5 text-[color:var(--color-brand)]" />{railLabel(c.channel)}</span>
                        <span className="tabular-nums font-medium">{formatAmount(c.gross)} <span className="text-[color:var(--color-text-muted)]">· {c.count}</span></span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-[color:var(--color-surface-muted)]">
                        <div className="h-2 rounded-full bg-[color:var(--color-brand)]" style={{ width: `${Math.max(4, (c.gross / max) * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent transactions</CardTitle>
          <CardDescription>Across all channels, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={recentCols} rows={d?.recent ?? []} rowKey={(r) => `${r.source}:${r.ref}`} loading={q.isLoading}
            emptyState="No transactions yet." />
        </CardContent>
      </Card>
    </>
  );
}
