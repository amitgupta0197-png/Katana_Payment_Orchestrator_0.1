"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; client_ref: string; txn_id?: string; amount: number; currency: string;
  method: string; selected_rail?: string; status: string; created_at: string;
}

// A raw bank credit as the collection phone's agent reported it — this is the alert
// itself, before (or without) any match to a pay-in order.
interface Credit {
  id: string; source: string; device_id: string | null; amount: number;
  payer_vpa: string | null; payee_vpa: string | null; utr: string | null;
  narration: string | null; outcome: string; match_confidence: number;
  matched_order_ref: string | null; detail: string | null;
  event_time: string | null; created_at: string;
}

const STATUSES = ["", "PENDING", "SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "INITIATED", "CANCELLED", "REFUNDED", "CHARGEBACK"] as const;

export default function TransactionsPage() {
  const [status, setStatus] = useState<string>("");

  // The merchant's own row (id + code) — needed to fetch Katana Pay pay-ins, which
  // are keyed by merchant code, not the session UUID.
  const meQ = useQuery({
    queryKey: ["mp:me"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: { id: string; merchant_code: string }[] },
  });
  const meId = meQ.data?.merchants?.[0]?.id;

  // Checkout-gateway orders (filtered client-side below so both rails share one filter).
  const checkoutQ = useQuery({
    queryKey: ["mp:orders"],
    queryFn: async () => (await fetch("/api/checkout").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { orders: Order[] },
  });

  // Katana Pay (PoolPay) pay-ins for this merchant.
  const payinQ = useQuery({
    queryKey: ["mp:payins", meId],
    enabled: !!meId,
    queryFn: async () => (await fetch(`/api/merchants/${meId}/payin-orders`).then((r) => r.json())) as { all: Array<{ id: string; order_id: string; amount: number; currency_code: string; status: string; rrn?: string; mode?: string; active_vpa?: string | null; created_at: string }> },
  });

  const payinRows: Order[] = (payinQ.data?.all ?? []).map((p) => ({
    id: p.id, client_ref: p.order_id, txn_id: p.rrn || undefined,
    amount: Number(p.amount || 0), currency: p.currency_code || "INR",
    method: p.mode === "QR" ? "UPI QR" : "UPI Intent", selected_rail: "Katana Pay",
    status: p.status, created_at: p.created_at,
  }));

  const all = [...(checkoutQ.data?.orders ?? []), ...payinRows]
    .filter((o) => !status || o.status === status)
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const loading = checkoutQ.isLoading || payinQ.isLoading;

  // Raw credit alerts reported by this banker's collection phone.
  const creditsQ = useQuery({
    queryKey: ["mp:credits"],
    queryFn: async () => (await fetch("/api/banker-portal/credits").then((r) => r.json())) as {
      credits: Credit[];
      summary: { total: number; confirmed: number; unmatched: number; today_count: number; today_amount: number; last_at: string | null };
    },
    refetchInterval: 15_000,   // this is the screen you watch while testing the agent
  });
  const credits = creditsQ.data?.credits ?? [];
  const creditSummary = creditsQ.data?.summary;

  const creditCols: Column<Credit>[] = [
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.event_time ?? r.created_at) },
    { key: "amount", header: "Amount", render: (r) => <span className="font-medium">{formatAmount(r.amount)}</span> },
    { key: "payer_vpa", header: "From", render: (r) => r.payer_vpa ? <span className="font-mono text-xs">{r.payer_vpa}</span> : "—" },
    { key: "utr", header: "UTR / RRN", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">pending</span> },
    { key: "outcome", header: "Match", render: (r) => (
      <Badge variant={r.outcome === "CONFIRMED" ? "success" : r.outcome === "DUPLICATE" ? "default" : "warning"}>
        {r.outcome === "CONFIRMED" ? "matched" : r.outcome.toLowerCase()}
      </Badge>
    ) },
    { key: "source", header: "Via", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{r.source === "DEVICE" ? "agent" : r.source.toLowerCase()}</span> },
  ];

  const cols: Column<Order>[] = [
    { key: "client_ref", header: "Ref", render: (r) => <span className="font-mono text-xs">{r.client_ref}</span> },
    { key: "txn_id", header: "UTR / TXN", render: (r) => r.txn_id ? <span className="font-mono text-xs">{r.txn_id}</span> : "—" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "method", header: "Method" },
    { key: "selected_rail", header: "Rail", render: (r) => r.selected_rail ?? "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Transactions" description="Incoming UPI credits and your pay-in order history." icon={Receipt} />

      {/* Raw credits straight from the collection phone's agent. Shown above orders because
          this is what proves the agent is alive — and because a credit that matches no
          order appears nowhere else, which makes a working agent look broken. */}
      <Card className="mb-4">
        <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Incoming credits</CardTitle>
            <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">
              {creditSummary
                ? `${creditSummary.today_count} today · ${formatAmount(creditSummary.today_amount)} · ${creditSummary.unmatched} unmatched`
                : "Live feed from your collection phone."}
            </p>
          </div>
          {creditSummary?.last_at && (
            <Badge variant="default" className="shrink-0 whitespace-nowrap">
              last {formatDateTime(creditSummary.last_at)}
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            columns={creditCols}
            rows={credits}
            loading={creditsQ.isLoading}
            rowKey={(r) => r.id}
            emptyState="No credits yet. Once your agent reports a UPI credit it appears here within seconds."
          />
          {creditSummary && creditSummary.unmatched > 0 && (
            <p className="mt-3 text-xs text-[color:var(--color-text-muted)]">
              <b>Unmatched</b> means the credit arrived but no pending pay-in order had that amount —
              the money is recorded, it just has no order to confirm. Create the order first, then pay.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <select
                className="flex h-9 w-48 rounded-md border px-3 py-1 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{s || "(any)"}</option>)}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{all.length} orders</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={all}
            loading={loading}
            rowKey={(r) => r.id}
            emptyState="No transactions match this filter."
          />
        </CardContent>
      </Card>
    </>
  );
}
