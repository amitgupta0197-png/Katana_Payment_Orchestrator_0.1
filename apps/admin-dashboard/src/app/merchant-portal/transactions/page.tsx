"use client";

// Provider Transactions & Reimbursement — gross value across all channels
// (Katana Pay / vendor PG / PayU / Cashfree / Razorpay …) for the provider's
// assigned merchants. Backed by /api/merchant-portal/transactions.

import { PaymentStatus } from "@/components/portal/plain-status";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Receipt, TrendingUp, Store, Network, Download, X, Wallet, Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";
import { ChannelBadge, ChannelCards, ChannelSwitch, type ChannelFilter } from "@/components/payin/channel";
import type { PayinChannel } from "@/lib/payin-channel";
import type { ChannelAccount } from "@/lib/channel-accounts";
import { ChannelAccountsTable } from "@/components/payin/channel-accounts";
import { verificationLabel, verificationVariant, type CreditVerification } from "@/lib/credit-verification";
import type { BankerHealth, HealthState } from "@/lib/integration-health-rules";

// The server reads a date as an IST calendar day, so the presets have to be built in IST
// too — on a phone set to another zone, `new Date()` would otherwise offer "today" as a
// day the server does not agree is today. en-CA formats as YYYY-MM-DD, which is exactly
// what both <input type="date"> and the API expect.
const istDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(new Date(Date.now() - offsetDays * 86_400_000));

interface Totals { gross: number; success_count: number; failed_count: number; pending_count: number; total_count: number }
interface ByMerchant { merchant_id: string; gross: number; count: number; success: number }
interface ByChannel { channel: string; gross: number; count: number }
interface Txn { source: string; merchant_id: string; channel: string; method: string; status: string; amount: number; ref: string; created_at: string; channel_type: PayinChannel }
interface Data { merchants: string[]; totals: Totals; by_merchant: ByMerchant[]; by_channel: ByChannel[]; by_channel_type?: Record<PayinChannel, Totals>; recent: Txn[] }

// Money the bankers' collection phones saw land on their UPI IDs (/api/merchant-portal/vpa-transactions).
// Most of it is paid straight to a UPI ID with no order, so it never appears in the order list
// above; this is the same feed the banker sees on its own Transactions page.
interface Credit { id: string; merchant_id: string | null; amount: number; utr: string | null; payer_name: string | null; payer_vpa: string | null; matched_order_ref: string | null; outcome: string; event_time: string | null; created_at: string; verification?: CreditVerification }
interface Credits { recent: Credit[]; totals: { count: number; verifiedAmount?: number; awaitingAmount?: number; verified?: number; awaitingRrn?: number }; truncated?: boolean }

/** The IST calendar day of a timestamp, as YYYY-MM-DD: what the date filter compares against. */
const istDayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));

const HEALTH: Record<HealthState, { label: string; variant: "success" | "warning" | "danger" | "default" }> = {
  OK: { label: "Healthy", variant: "success" },
  ATTENTION: { label: "Needs a look", variant: "warning" },
  FAILING: { label: "Failing", variant: "danger" },
  IDLE: { label: "No traffic", variant: "default" },
};

const successRate = (t?: Totals) => {
  const done = (t?.success_count ?? 0) + (t?.failed_count ?? 0);
  return done > 0 ? `${Math.round(((t?.success_count ?? 0) / done) * 100)}%` : "—";
};

export default function ProviderTransactionsPage() {
  const router = useRouter();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("");

  // One query string drives the table, the tiles and the CSV, so the file a merchant
  // downloads always covers the window they were looking at.
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (channel) params.set("channel", channel);
  const qs = params.toString();
  const filtered = !!(from || to);

  const q = useQuery({
    queryKey: ["pp:transactions", from, to, channel],
    queryFn: async () => (await fetch(`/api/merchant-portal/transactions${qs ? `?${qs}` : ""}`).then(async (r) => {
      const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d;
    })) as Data,
    refetchInterval: 15_000,
  });
  const d = q.data;

  // Katana Pay's accounts per channel: fees, chargebacks, net, settled and variance (lib/channel-accounts).
  const accQ = useQuery({
    queryKey: ["pp:channel-accounts", from, to],
    queryFn: async () => (await fetch(`/api/merchant-portal/channel-accounts${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`).then(async (r) => {
      const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d;
    })) as { channels: Record<PayinChannel, ChannelAccount>; total: ChannelAccount; livemode: boolean },
    refetchInterval: 30_000,
  });

  const creditsQ = useQuery({
    queryKey: ["pp:credits"],
    queryFn: async () => (await fetch("/api/merchant-portal/vpa-transactions").then(async (r) => {
      const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d;
    })) as Credits,
    refetchInterval: 15_000,
  });
  // The credit feed has no date parameter; the window is applied here, on the IST day the money arrived.
  const credits = (creditsQ.data?.recent ?? []).filter((c) => {
    const day = istDayOf(c.event_time ?? c.created_at);
    return (!from || day >= from) && (!to || day <= to);
  });
  const creditsVerified = credits.filter((c) => c.verification === "verified" || c.verification === "matched");

  const healthQ = useQuery({
    queryKey: ["pp:integration-health"],
    queryFn: async () => (await fetch("/api/portal/integration-health").then(async (r) => {
      const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d;
    })) as { bankers: BankerHealth[] },
    refetchInterval: 30_000,
  });
  const t = d?.totals;

  const setRange = (f: string, tt: string) => { setFrom(f); setTo(tt); };

  // Either end can be left open, so spell the window out rather than always printing a
  // range: "from 26 Aug onwards" and "up to 26 Aug" are both things a merchant will set.
  const windowLabel =
    from && to ? (from === to ? from : `${from} → ${to}`)
    : from ? `${from} → now`
    : `up to ${to}`;

  const merCols: Column<ByMerchant>[] = [
    { key: "merchant_id", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "count", header: "Txns", render: (r) => <span className="tabular-nums">{r.count}</span> },
    { key: "success", header: "Successful", render: (r) => <span className="tabular-nums">{r.success}</span> },
    { key: "gross", header: "Gross (reimbursable)", render: (r) => <span className="font-medium tabular-nums">{formatAmount(r.gross)}</span> },
  ];
  const recentCols: Column<Txn>[] = [
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "merchant_id", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "channel_type", header: "Pay-in channel", render: (r) => <ChannelBadge channel={r.channel_type} /> },
    { key: "channel", header: "Rail", render: (r) => <Badge variant="brand">{railLabel(r.channel)}</Badge> },
    { key: "method", header: "Method", render: (r) => r.method || "—" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "status", header: "Status", render: (r) => <PaymentStatus status={r.status} /> },
  ];

  const creditCols: Column<Credit>[] = [
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.event_time ?? r.created_at)}</span> },
    { key: "merchant_id", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.merchant_id ?? "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="font-medium tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "payer_name", header: "From", render: (r) => r.payer_name || "—" },
    { key: "utr", header: "Bank reference (UTR)", render: (r) => <span className="font-mono text-xs">{r.utr || "—"}</span> },
    { key: "matched_order_ref", header: "Order", render: (r) => <span className="font-mono text-xs">{r.matched_order_ref || "—"}</span> },
    { key: "verification", header: "Status", render: (r) => {
      const v = r.verification ?? (r.outcome === "CONFIRMED" ? "matched" : "awaiting");
      return <Badge variant={verificationVariant(v)}>{verificationLabel(v)}</Badge>;
    } },
  ];

  const healthCols: Column<BankerHealth>[] = [
    { key: "code", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "state", header: "Health", render: (r) => <Badge variant={HEALTH[r.state].variant}>{HEALTH[r.state].label}</Badge> },
    { key: "api", header: "API requests (24h)", render: (r) => (
      <span className="tabular-nums">{r.api.requests}{r.api.refused > 0 && <span className="text-[color:var(--color-danger)]"> · {r.api.refused} refused</span>}</span>
    ) },
    { key: "callbacks", header: "Payment messages", render: (r) => (
      <span className="tabular-nums">
        {r.callbacks.delivered} delivered
        {r.callbacks.retrying > 0 && <span className="text-[color:var(--color-warning)]"> · {r.callbacks.retrying} retrying</span>}
        {r.callbacks.failed > 0 && <span className="text-[color:var(--color-danger)]"> · {r.callbacks.failed} failed</span>}
      </span>
    ) },
    { key: "capture", header: "Last money on UPI ID", render: (r) => (
      <span className="text-xs">{r.capture.last_credit_at ? `${formatDateTime(r.capture.last_credit_at)} · ${r.capture.today} today` : "—"}</span>
    ) },
    { key: "note", header: "", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{r.note ?? ""}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Transactions & Reimbursement"
        description="Gross value across all channels for your assigned bankers. Successful collections are reimbursable."
        icon={Receipt}
        actions={
          <Button variant="secondary" size="sm" asChild>
            <a href={`/api/merchant-portal/transactions/export${qs ? `?${qs}` : ""}`}><Download className="h-4 w-4" /> Download CSV</a>
          </Button>
        }
      />

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <Label className="text-xs">Pay-in channel</Label>
            <div><ChannelSwitch value={channel} onChange={setChannel} /></div>
          </div>
          <div className="min-w-[9rem] flex-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="min-w-[9rem] flex-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          {/* Typing two dates on a phone is the slow path, and most of these lookups are
              "what came in today / this week" — so the common windows are one tap. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRange(istDay(), istDay())}>Today</Button>
            <Button variant="secondary" size="sm" onClick={() => setRange(istDay(1), istDay(1))}>Yesterday</Button>
            <Button variant="secondary" size="sm" onClick={() => setRange(istDay(6), istDay())}>Last 7 days</Button>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={() => setRange("", "")}><X className="h-4 w-4" /> Clear</Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Gross (reimbursable)" value={formatAmount(t?.gross ?? 0)} sublabel={`${t?.success_count ?? 0} successful`} icon={TrendingUp} variant="success" loading={q.isLoading} />
        <KpiTile label="Total transactions" value={t?.total_count ?? 0} icon={Receipt} loading={q.isLoading} />
        <KpiTile label="Pending" value={t?.pending_count ?? 0} variant={(t?.pending_count ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Bankers" value={d?.merchants.length ?? 0} icon={Store} loading={q.isLoading} />
      </div>

      {/* Each rail's own figures, side by side, so the total above is never an unexplained pool. */}
      {!channel && (
        <ChannelCards loading={q.isLoading} cards={(["INTENT", "P2P", "UNCLASSIFIED"] as PayinChannel[]).map((c) => {
          const b = d?.by_channel_type?.[c];
          return {
            channel: c, headline: b?.gross ?? 0, headlineLabel: "Gross successful pay-in",
            hidden: c === "UNCLASSIFIED" && !(b?.total_count),
            stats: [
              { label: "Orders", value: b?.total_count ?? 0 },
              { label: "Successful", value: b?.success_count ?? 0 },
              { label: "Pending", value: b?.pending_count ?? 0 },
              { label: "Success rate", value: successRate(b) },
            ],
          };
        })} />
      )}

      <ChannelAccountsTable channels={accQ.data?.channels} total={accQ.data?.total} selected={channel} loading={accQ.isLoading}
        livemode={accQ.data?.livemode !== false} title="Katana Pay accounts by channel"
        description="Katana Pay pay-ins only, each channel from its own pay-ins; All is their sum. Chargebacks and their debits are on the Chargebacks page." />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gross by banker</CardTitle>
            <CardDescription>Reimbursable gross per assigned banker.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable columns={merCols} rows={d?.by_merchant ?? []} rowKey={(r) => r.merchant_id} loading={q.isLoading}
              emptyState="No transactions yet for your bankers." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gross by channel</CardTitle>
            <CardDescription>Katana Pay and gateway payments</CardDescription>
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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Integration health</CardTitle>
          <CardDescription>Per banker: API requests accepted, payment messages reaching its server, and the last money on its UPI IDs.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={healthCols} rows={healthQ.data?.bankers ?? []} rowKey={(r) => r.code} loading={healthQ.isLoading}
            emptyState={healthQ.isError ? "Could not load integration health." : "No bankers yet."} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Recent transactions</CardTitle>
          {/* Say which window is on screen — every figure above is scoped to it too, so a
              filtered page that still claimed "across all channels" would misread. */}
          <CardDescription>
            {`${channel ? `${channel} only` : "Across all channels"}${filtered ? ` · ${windowLabel}` : ", newest first."}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Only CHECKOUT rows have a detail view — their ref is the order id. Katana Pay /
              vendor pay-ins live in another service and have no page to open. */}
          <DataTable columns={recentCols} rows={d?.recent ?? []} rowKey={(r) => `${r.source}:${r.ref}`} loading={q.isLoading}
            onRowClick={(r) => { if (r.source === "CHECKOUT") router.push(`/merchant-portal/transactions/${r.ref}`); }}
            emptyState={filtered || channel ? "No transactions match this filter." : "No transactions yet."} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4 w-4" /> Money received on UPI IDs</CardTitle>
          <CardDescription>
            {`Payments your bankers' collection phones saw arrive${filtered ? ` · ${windowLabel}` : ", newest first"}. `}
            {`${creditsVerified.length} of ${credits.length} confirmed by a bank reference · ${formatAmount(creditsVerified.reduce((a, c) => a + Number(c.amount || 0), 0))}.`}
            {" Live money only."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={creditCols} rows={credits.slice(0, 200)} rowKey={(r) => r.id} loading={creditsQ.isLoading}
            emptyState={creditsQ.isError ? "Could not load money received." : filtered ? "No money received in this window." : "No money received yet."} />
        </CardContent>
      </Card>
    </>
  );
}
