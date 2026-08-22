"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { CreditDetail, hasCreditDetail } from "@/components/credits/credit-detail";
import { LiveCaptureStrip } from "@/components/credits/live-capture-strip";
import { paymentAppOf, PAYMENT_APP_DOT } from "@/lib/payment-app";
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
  payer_name: string | null;
  /** Which payment app the credit arrived on. */
  bank: string | null;
  sender: string | null;
  /** Verification state, computed server-side. Distinct from order matching: a direct VPA
   *  collection never has an order, so "matched" alone made every healthy payment amber. */
  verification?: "matched" | "verified" | "awaiting" | "vpa_mismatch";
  /** Full payment detail as the capturing screen stated it (GPay: payer, method,
   *  customer-paid vs amount-you-get, both references, settlement note). */
  details: Record<string, string> | null;
}

const STATUSES = ["", "PENDING", "SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "INITIATED", "CANCELLED", "REFUNDED", "CHARGEBACK"] as const;

/** "· 2m ago" for anything recent enough to be worth relating to now; blank once it is history. */
function relativeAgo(iso: string): string {
  const s = Math.round((Date.now() - +new Date(iso)) / 1000);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return "· just now";
  if (s < 3600) return `· ${Math.round(s / 60)}m ago`;
  if (s < 6 * 3600) return `· ${Math.round(s / 3600)}h ago`;
  return "";
}

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
      test_credits: Credit[];
      /** Payouts from the payment app into your bank account — the same money as the credits,
       *  one leg later. Excluded from every total below. */
      settlements?: Credit[];
      summary: {
        total: number; confirmed: number; unmatched: number;
        today_count: number; today_amount: number; last_at: string | null;
        /** Today's money the UPI network has corroborated — the figure to lead with. */
        today_verified_amount?: number;
        /** Today's credits still without an RRN. Reported, never added to the verified figure. */
        today_awaiting_count?: number; today_awaiting_amount?: number;
        test_count: number; test_amount: number;
        settled_count?: number; settled_amount?: number;
      };
    },
    refetchInterval: 15_000,   // this is the screen you watch while testing the agent
  });
  const credits = creditsQ.data?.credits ?? [];
  const testCredits = creditsQ.data?.test_credits ?? [];
  const settlements = creditsQ.data?.settlements ?? [];
  const creditSummary = creditsQ.data?.summary;

  // Id of the credit whose detail is expanded, or null. Everything shown is already on the
  // row, so expanding costs no fetch.
  const [detailOf, setDetailOf] = useState<string | null>(null);

  // The detail block, rendered inline directly beneath its own row.
  const renderCreditDetail = (r: Credit) => <CreditDetail details={r.details} />;

  const creditCols: Column<Credit>[] = [
    { key: "created_at", header: "When", render: (r) => {
      const t = r.event_time ?? r.created_at;
      return (
        <span className="whitespace-nowrap">
          {formatDateTime(t)}
          <span className="ml-1.5 text-[color:var(--color-text-subtle)]">{relativeAgo(t)}</span>
        </span>
      );
    } },
    { key: "amount", header: "Amount", render: (r) => <span className="font-medium">{formatAmount(r.amount)}</span> },
    // The customer's NAME when the capture gave us one, falling back to their VPA. Showing
    // the payee VPA here would just repeat your own account on every row.
    { key: "payer_name", header: "From", render: (r) =>
      r.payer_name ? <span>{r.payer_name}</span>
        : r.payer_vpa ? <span className="font-mono text-xs">{r.payer_vpa}</span>
        : "—" },
    { key: "utr", header: "UTR / RRN", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">pending</span> },
    { key: "outcome", header: "Status", render: (r) => {
      // matched      - tied to a Katana order, which is now confirmed
      // verified     - carries the UPI network's own 12-digit reference: a real transfer,
      //                no order expected (this is what a direct VPA collection looks like)
      // awaiting     - attributed, reference not in yet; usually seconds
      // vpa mismatch - the payment named a payee VPA that is not this banker's: real problem
      const v = r.verification ?? (r.outcome === "CONFIRMED" ? "matched" : "awaiting");
      const label = v === "vpa_mismatch" ? "VPA mismatch" : v === "awaiting" ? "awaiting RRN" : v;
      const variant = v === "matched" || v === "verified" ? "success" : v === "vpa_mismatch" ? "danger" : "default";
      return <Badge variant={variant}>{label}</Badge>;
    } },
    // The APP, not the plumbing. This column used to print the ingestion channel ("agent",
    // "notification"), which told the merchant nothing about where their money came in — every row
    // said the same thing. `bank`/`sender` already identify the app on every credit.
    { key: "source", header: "Via", render: (r) => {
      const app = paymentAppOf({ bank: r.bank, sender: r.sender, source: r.source });
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-text-muted)]" title={`${r.source.toLowerCase()} capture`}>
          {app.key !== "UNKNOWN" && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: PAYMENT_APP_DOT[app.key] }} />
          )}
          {app.label}
        </span>
      );
    } },
    { key: "details", header: "", render: (r) => hasCreditDetail(r.details) ? (
      <button
        type="button"
        onClick={() => setDetailOf(detailOf === r.id ? null : r.id)}
        className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
      >
        {detailOf === r.id ? "Hide" : "Details"}
      </button>
    ) : <span className="text-xs text-[color:var(--color-text-subtle)]">—</span> },
  ];

  // Same columns for the settlement list, except the verification badge: a settlement has no
  // RRN to wait for (no UPI transaction happened), so reusing the credit column would label
  // every row a permanent "awaiting RRN" problem.
  const settlementCols: Column<Credit>[] = creditCols.map((c) =>
    c.key === "outcome"
      ? { ...c, header: "Status", render: () => <Badge variant="default">settlement</Badge> }
      : c,
  );

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
            {/* Today's takings are stated as PROVEN money, with anything still waiting on its
                RRN named beside it rather than folded in. A credit with no RRN is a claim the
                phone made; until the network confirms it, adding it to the day's total presents
                unproven money as banked. */}
            <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">
              {creditSummary
                ? `${creditSummary.today_count} today · ${formatAmount(creditSummary.today_verified_amount ?? 0)} verified`
                  + ((creditSummary.today_awaiting_amount ?? 0) > 0
                      ? ` · ${formatAmount(creditSummary.today_awaiting_amount ?? 0)} awaiting RRN (not counted)`
                      : "")
                : "Live feed from your collection phone."}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {/* THE BADGE THAT USED TO SIT HERE READ "last 22 Aug 2026, 18:19" and was taken for the
              page's own freshness — twice, on 2026-08-22, while capture was working perfectly.
              It was neither: it was the newest credit's INGEST time. The strip answers the two
              separate questions plainly instead. */}
          <div className="mb-3">
            <LiveCaptureStrip
              dataUpdatedAt={creditsQ.dataUpdatedAt}
              lastPaymentAt={credits[0]?.event_time ?? credits[0]?.created_at ?? null}
            />
          </div>
          <DataTable
            columns={creditCols}
            rows={credits}
            loading={creditsQ.isLoading}
            rowKey={(r) => r.id}
            renderExpanded={renderCreditDetail}
            isExpanded={(r) => detailOf === r.id}
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

      {/* Settled to bank. The payment app pays the day's collections into your bank account and
          posts a notification for it ("₹40,006 for transactions settled to your bank account").
          The phone forwards that like any other credit, so it used to appear above as a second,
          payer-less copy of money already listed — and added itself to today's total. It is kept
          here instead: the same money, one leg later, counted nowhere. */}
      {settlements.length > 0 && (
        <Card className="mb-4 border-dashed">
          <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base text-[color:var(--color-text-muted)]">Settled to bank</CardTitle>
              <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                {creditSummary?.settled_count ?? settlements.length} settlement{(creditSummary?.settled_count ?? settlements.length) === 1 ? "" : "s"} · {formatAmount(creditSummary?.settled_amount ?? 0)} — the credits above reaching your bank account. <b>Not counted</b> in the totals.
              </p>
            </div>
            <Badge variant="default" className="shrink-0">excluded</Badge>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={settlementCols}
              rows={settlements}
              loading={creditsQ.isLoading}
              rowKey={(r) => r.id}
              emptyState="No settlements yet."
            />
          </CardContent>
        </Card>
      )}

      {/* Test alerts from the agent's "Test" button. Kept in their own card and excluded
          from every total above, so a commissioning test can never be mistaken for — or
          added to — real collected money. */}
      {testCredits.length > 0 && (
        <Card className="mb-4 border-dashed">
          <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base text-[color:var(--color-text-muted)]">Test alerts</CardTitle>
              <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                {creditSummary?.test_count ?? testCredits.length} test{(creditSummary?.test_count ?? testCredits.length) === 1 ? "" : "s"} · {formatAmount(creditSummary?.test_amount ?? 0)} — <b>not counted</b> in the totals above.
              </p>
            </div>
            <Badge variant="default" className="shrink-0">excluded</Badge>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={creditCols}
              rows={testCredits}
              loading={creditsQ.isLoading}
              rowKey={(r) => r.id}
              emptyState="No test alerts."
            />
          </CardContent>
        </Card>
      )}

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
