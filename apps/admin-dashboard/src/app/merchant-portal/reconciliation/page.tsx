"use client";

// Provider Reconciliation — the evidence chain behind each Katana Pay pay-in: what the
// merchant ordered, what the gateway reported, what the bank shows, and whether it settled.
// Backed by /api/merchant-portal/reconciliation.
//
// A gateway SUCCESS and an actual bank credit are evidenced independently. A paid order with
// no bank reference is shown as "awaiting evidence", never as reconciled.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { GitMerge, Activity, ChevronRight, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { cn, formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { ChannelBadge, ChannelCards, ChannelSwitch, type ChannelFilter } from "@/components/payin/channel";
import type { PayinChannel } from "@/lib/payin-channel";

// The server reads a date as an IST calendar day, so the presets are built in IST too.
const istDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
    .format(new Date(Date.now() - offsetDays * 86_400_000));

type ReconState = "RECONCILED" | "AWAITING_EVIDENCE" | "NEEDS_REVIEW" | "PENDING" | "NOT_PAID";
type StageKey = "order" | "gateway" | "credit" | "settled";

interface Bucket { count: number; amount: number }
interface TimelineEvent { at: string; title: string; detail: string }
interface Order {
  id: string; order_id: string; txn_id: string | null; merchant_id: string | null; amount: number;
  status: string; gateway: string | null; recon: ReconState; bank_ref: string | null;
  evidence: string | null; settled: boolean; created_at: string; timeline: TimelineEvent[];
  channel_type: PayinChannel; channel_id: string | null;
}
interface Data {
  stages: ({ key: StageKey } & Bucket)[];
  states: Record<ReconState, Bucket>;
  by_channel?: Record<PayinChannel, Record<ReconState, Bucket>>;
  orders: Order[];
  truncated: boolean;
}

const STAGES: { key: StageKey; label: string; hint: string; explain: string }[] = [
  { key: "order", label: "Order created", hint: "Merchant / API",
    explain: "Proves what the merchant requested: the merchant order ID, Katana transaction ID, banker, amount, channel and creation time." },
  { key: "gateway", label: "Gateway success", hint: "Payment status",
    explain: "Proves what the payment system reported: the order reached SUCCESS, by a gateway webhook, a status enquiry or an operator's confirmation." },
  { key: "credit", label: "Bank evidence", hint: "UTR / RRN / credit",
    explain: "Proves the money actually landed: a UTR or RRN stated for the payment, or a bank-credit alert matched to the order. A paid order without it is awaiting evidence." },
  { key: "settled", label: "Settled", hint: "By the banker",
    explain: "Proves the banker has settled the payment to you, on INTENT and P2P alike: the banker's verified settlements cover the order. Settlements are lump sums, so they are applied to each banker's paid orders oldest first." },
];

const RECON: Record<ReconState, { label: string; variant: "success" | "warning" | "danger" | "info" | "default" }> = {
  RECONCILED: { label: "Reconciled", variant: "success" },
  AWAITING_EVIDENCE: { label: "Awaiting evidence", variant: "warning" },
  NEEDS_REVIEW: { label: "Needs review", variant: "warning" },
  PENDING: { label: "Pending", variant: "info" },
  NOT_PAID: { label: "Not paid", variant: "default" },
};

const EVIDENCE: Record<string, string> = {
  BANK_CREDIT: "bank credit matched", WEBHOOK: "gateway reference", MANUAL: "operator reference",
  UTR: "UTR entered", SCREENSHOT: "payer proof", DEVICE: "device capture", EMAIL: "bank email", REFERENCE: "reference",
};

const fetchJson = async (url: string) => fetch(url).then(async (r) => {
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d;
});

export default function ProviderReconciliationPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState<ReconState | "">("");
  const [channel, setChannel] = useState<ChannelFilter>("");
  const [stage, setStage] = useState<StageKey>("order");
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (state) params.set("state", state);
  if (channel) params.set("channel", channel);
  const qs = params.toString();
  const filtered = !!(from || to);

  const q = useQuery({
    queryKey: ["pp:reconciliation", from, to, state, channel],
    queryFn: async () => (await fetchJson(`/api/merchant-portal/reconciliation${qs ? `?${qs}` : ""}`)) as Data,
    refetchInterval: 30_000,
  });
  // Direct VPA collections have no order to reconcile against; their open items are counted
  // by the same feed the dashboard uses, so the two screens cannot disagree.
  const vpa = useQuery({
    queryKey: ["pp:vpa-txns", ""],
    queryFn: async () => (await fetchJson("/api/merchant-portal/vpa-transactions")) as {
      totals?: { awaitingRrn?: number; vpaMismatch?: number };
    },
    refetchInterval: 30_000,
  });

  const d = q.data;
  const st = d?.states;
  const stageOf = (k: StageKey) => d?.stages.find((x) => x.key === k) ?? { count: 0, amount: 0 };
  const created = stageOf("order").count;
  const setRange = (f: string, t: string) => { setFrom(f); setTo(t); };

  const cols: Column<Order>[] = [
    { key: "txn_id", header: "Txn ID", render: (r) => <span className="font-mono text-xs">{r.txn_id ?? "—"}</span> },
    { key: "order_id", header: "Merchant order", render: (r) => <span className="font-mono text-xs">{r.order_id}</span> },
    { key: "channel_type", header: "Channel", render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ChannelBadge channel={r.channel_type} />
          {r.channel_id && r.channel_type === "INTENT" && <span className="text-xs text-[color:var(--color-text-muted)]">{r.channel_id}</span>}
        </span>
      ) },
    { key: "merchant_id", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.merchant_id ?? "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "status", header: "Gateway", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "bank_ref", header: "Bank evidence", render: (r) => r.bank_ref
        ? <span className="text-xs"><span className="font-mono">{r.bank_ref}</span>{r.evidence ? <span className="text-[color:var(--color-text-muted)]"> · {EVIDENCE[r.evidence] ?? r.evidence.toLowerCase()}</span> : null}</span>
        : r.evidence === "BANK_CREDIT" ? <span className="text-xs">bank credit matched</span> : "—" },
    { key: "recon", header: "Recon", render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant={RECON[r.recon].variant}>{RECON[r.recon].label}</Badge>
          {r.settled && <Badge variant="default">settled</Badge>}
        </span>
      ) },
    { key: "created_at", header: "Time", render: (r) => <span className="text-xs tabular-nums">{formatDateTime(r.created_at)}</span> },
  ];

  const monitor: { label: string; value: number; tone?: string; state?: ReconState; href?: string }[] = [
    { label: "Reconciled", value: st?.RECONCILED.count ?? 0, tone: "text-[color:var(--color-success)]", state: "RECONCILED" },
    { label: "Paid, awaiting bank evidence", value: st?.AWAITING_EVIDENCE.count ?? 0, tone: "text-[color:var(--color-warning)]", state: "AWAITING_EVIDENCE" },
    { label: "Needs review (hold / payer proof)", value: st?.NEEDS_REVIEW.count ?? 0, tone: "text-[color:var(--color-warning)]", state: "NEEDS_REVIEW" },
    { label: "Pending", value: st?.PENDING.count ?? 0, state: "PENDING" },
    { label: "Failed / expired", value: st?.NOT_PAID.count ?? 0, tone: "text-[color:var(--color-danger)]", state: "NOT_PAID" },
    // Captured credits are the P2P rail, so they have no place in an INTENT-only view.
    ...(channel === "INTENT" ? [] : [
      { label: "P2P credits awaiting RRN", value: vpa.data?.totals?.awaitingRrn ?? 0, tone: "text-[color:var(--color-warning)]", href: "/merchant-portal" },
      { label: "P2P VPA mismatch", value: vpa.data?.totals?.vpaMismatch ?? 0, tone: "text-[color:var(--color-danger)]", href: "/merchant-portal" },
    ]),
  ];

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Order, gateway and bank evidence for every Katana Pay pay-in across your bankers."
        icon={GitMerge}
        actions={<Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>}
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

      {q.isError && (
        <Card className="mb-6"><CardContent className="py-6 text-center text-sm text-[color:var(--color-danger)]">
          Couldn’t load reconciliation: {(q.error as Error)?.message}
        </CardContent></Card>
      )}

      {/* Paid and proven are reported side by side, never added together. */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Gross pay-in" value={formatAmount(stageOf("gateway").amount)} sublabel={`${stageOf("gateway").count} successful`} variant="success" loading={q.isLoading} />
        <KpiTile label="Reconciled" value={formatAmount(st?.RECONCILED.amount ?? 0)} sublabel={`${st?.RECONCILED.count ?? 0} with bank evidence`} variant="success" loading={q.isLoading} />
        <KpiTile label="Awaiting evidence" value={formatAmount(st?.AWAITING_EVIDENCE.amount ?? 0)} sublabel={`${st?.AWAITING_EVIDENCE.count ?? 0} paid, no bank reference`}
          variant={(st?.AWAITING_EVIDENCE.count ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Settled" value={formatAmount(stageOf("settled").amount)} sublabel={`${stageOf("settled").count} settled by banker`} loading={q.isLoading} />
      </div>

      {/* Reconciliation is per channel first; these are each rail's own figures for the window. */}
      {!channel && (
        <ChannelCards loading={q.isLoading} cards={(["INTENT", "P2P", "UNCLASSIFIED"] as PayinChannel[]).map((c) => {
          const b = d?.by_channel?.[c];
          const n = (k: ReconState) => b?.[k]?.count ?? 0;
          return {
            channel: c, headline: (b?.RECONCILED.amount ?? 0) + (b?.AWAITING_EVIDENCE.amount ?? 0), headlineLabel: "Gross successful pay-in",
            hidden: c === "UNCLASSIFIED" && !b?.RECONCILED.count && !b?.AWAITING_EVIDENCE.count && !b?.PENDING.count && !b?.NEEDS_REVIEW.count && !b?.NOT_PAID.count,
            stats: [
              { label: "Reconciled", value: n("RECONCILED") },
              { label: "Awaiting evidence", value: n("AWAITING_EVIDENCE") },
              { label: "Pending / review", value: n("PENDING") + n("NEEDS_REVIEW") },
              { label: "Failed / expired", value: n("NOT_PAID") },
            ],
          };
        })} />
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Reconciliation funnel</CardTitle>
            <CardDescription>Order → gateway → bank evidence → settlement. Select a stage to see what it proves.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {STAGES.map((s, i) => {
                const b = stageOf(s.key);
                const pct = created > 0 && s.key !== "order" ? Math.round((b.count / created) * 100) : null;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStage(s.key)}
                    aria-pressed={stage === s.key}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      stage === s.key
                        ? "border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand-muted)]/40"
                        : "hover:bg-[color:var(--color-surface-muted)]",
                    )}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                      {String(i + 1).padStart(2, "0")} · {s.label}
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{q.isLoading ? "—" : b.count}</div>
                    <div className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatAmount(b.amount)}</div>
                    <div className="mt-0.5 text-[10px] text-[color:var(--color-text-subtle)]">{pct !== null ? `${pct}% of created` : s.hint}</div>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 rounded-md bg-[color:var(--color-surface-muted)] p-3 text-sm text-[color:var(--color-text-muted)]">
              <span className="font-medium text-[color:var(--color-text)]">{STAGES.find((s) => s.key === stage)!.label}:</span>{" "}
              {STAGES.find((s) => s.key === stage)!.explain}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Exception monitor</CardTitle>
            <CardDescription>Select a row to filter the evidence table.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col text-sm">
              {monitor.map((m) => {
                const body = (
                  <>
                    <span>{m.label}</span>
                    <span className={cn("inline-flex items-center gap-1 font-semibold tabular-nums", m.value > 0 && m.tone)}>
                      {m.value}{m.href && <ChevronRight className="h-3.5 w-3.5 text-[color:var(--color-text-muted)]" />}
                    </span>
                  </>
                );
                const row = "flex w-full items-center justify-between gap-3 border-b border-[color:var(--color-border)] py-2 text-left hover:text-[color:var(--color-brand)]";
                return (
                  <li key={m.label} className="last:[&>*]:border-0">
                    {m.href
                      ? <Link href={m.href} className={row}>{body}</Link>
                      : <button type="button" aria-pressed={state === m.state} onClick={() => setState(state === m.state ? "" : m.state!)}
                          className={cn(row, state === m.state && "text-[color:var(--color-brand)]")}>{body}</button>}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Transaction evidence</CardTitle>
            <CardDescription>
              {state ? `${RECON[state].label} · ` : ""}Newest first. Select a row for its evidence timeline.
            </CardDescription>
          </div>
          {state && <Button variant="ghost" size="sm" onClick={() => setState("")}><X className="h-4 w-4" /> {RECON[state].label}</Button>}
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={d?.orders ?? []}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
            isExpanded={(r) => openId === r.id}
            renderExpanded={(r) => (
              <ol className="space-y-3">
                {r.timeline.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-brand)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{e.title} <span className="font-normal text-xs text-[color:var(--color-text-muted)]">· {formatDateTime(e.at)}</span></div>
                      <div className="mt-0.5 break-words text-xs text-[color:var(--color-text-muted)]">{e.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            emptyState={state || filtered || channel ? "No pay-ins match this filter." : "No Katana Pay pay-ins yet."}
          />
          {d?.truncated && (
            <p className="mt-2 text-center text-xs text-[color:var(--color-text-muted)]">
              Showing the newest {d.orders.length} pay-ins — the totals above cover all of them. Narrow the dates to see older ones.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
