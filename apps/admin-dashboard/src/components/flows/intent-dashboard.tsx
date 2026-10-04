"use client";

// Intent pay-in dashboard (/flows/intent). STAFF ONLY — names gateways. Read-only: pausing a
// MID or pinning is on the MID switch, blocking a banker on its page.

import Link from "next/link";
import { Zap } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { PAYIN_FAILURE_LABEL, pctText, rateTone } from "@/lib/flow-dashboards";
import type { IntentBankerRow, IntentDashboard } from "@/lib/flow-dashboards-store";
import { Donut, RateLine, StackedBars } from "./charts";
import {
  ago, BankerLink, CsvButton, ErrorNote, FlowToolbar, inr, mins, RateBadge, Section, SimpleTable, StateBadge, useFlowData, useFlowParams,
  type Col,
} from "./shared";

const REASON_COLOR = { EXPIRED_UNPAID: "var(--color-warning)", FAILED_AT_GATEWAY: "var(--color-danger)", CREATE_FAILED: "var(--color-brand)", OTHER: "var(--color-text-subtle)" } as const;
const TONE_VARIANT = { good: "success", warn: "warning", bad: "danger", none: "default" } as const;

export function IntentFlowDashboard() {
  const p = useFlowParams();
  const q = useFlowData<IntentDashboard>("intent", p.mode, p.banker);
  const d = q.data;
  const k = d?.kpi;

  const cols: Col<IntentBankerRow>[] = [
    { header: "Banker", cell: (r) => <><BankerLink id={r.id} name={r.name} code={r.code} />{r.provider_name && <div className="text-xs text-[color:var(--color-text-muted)]">{r.provider_name}</div>}</> },
    { header: "Gateway", cell: (r) => <span className="text-xs">{r.gateways.join(", ") || "—"}{r.gateway_mids > 0 && <span className="ml-1 text-[color:var(--color-text-muted)]">· {r.gateway_mids} MID{r.gateway_mids === 1 ? "" : "s"}</span>}</span> },
    { header: "Orders 24h", right: true, cell: (r) => r.orders_24h },
    { header: "Success", right: true, cell: (r) => <RateBadge rate={r.success_24h} />, title: "Paid over paid + failed + expired, last 24 hours" },
    { header: "Median confirm", right: true, cell: (r) => mins(r.median_confirm_min) },
    { header: "Callbacks", cell: (r) => !r.callback ? <span className="text-xs text-[color:var(--color-text-muted)]">none in 7 days</span> : (
      <span className="text-xs" title={r.callback.last_error ?? undefined}>
        <Badge variant={r.callback.last_status === "DELIVERED" ? "success" : r.callback.last_status === "DEAD_LETTER" ? "danger" : "warning"}>
          {r.callback.last_status === "DELIVERED" ? "Delivered" : r.callback.last_status === "DEAD_LETTER" ? "Gave up" : "Retrying"}
        </Badge> {ago(r.callback.last_at)}{r.callback.dead_24h > 0 && <span className="ml-1 text-[color:var(--color-danger)]">· {r.callback.dead_24h} gave up 24h</span>}
      </span>) },
    { header: "Status", cell: (r) => <StateBadge state={r.state} /> },
    { header: "", cell: (r) => (
      <span className="flex gap-2 whitespace-nowrap text-xs">
        <button type="button" className="text-[color:var(--color-brand)] hover:underline" onClick={() => p.setBanker(r.code)}>Only this</button>
        <Link href="/mid-switch" className="text-[color:var(--color-brand)] hover:underline">MID switch</Link>
      </span>) },
  ];

  const bars = (d?.bankers ?? []).filter((b) => b.paid_today + b.lost_today > 0).slice(0, 16)
    .map((b) => ({ label: b.code, values: { paid: b.paid_today, lost: b.lost_today } }));

  return (
    <>
      <PageHeader title="Intent pay-ins" icon={Zap}
        description="Orders a gateway issues and confirms. Today is India time; success is paid over orders that ended (paid, failed or expired)." />
      <FlowToolbar livemode={d?.livemode} banker={p.banker} asOf={d?.as_of} fetching={q.isFetching}
        onMode={p.setMode} onClearBanker={() => p.setBanker(null)}
        links={[{ href: "/mid-switch", label: "MID switch" }, { href: "/gateway-health", label: "Gateway health" }, { href: "/orders", label: "Order search" }, { href: "/flows/health", label: "Flow health" }]} />
      <ErrorNote error={q.error} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <KpiTile label="Initiated today" value={k?.initiated ?? "—"} loading={q.isLoading} />
        <KpiTile label="Paid" value={k?.paid ?? "—"} sublabel={k ? inr(k.paid_amount) : undefined} loading={q.isLoading} variant="success" />
        <KpiTile label="Failed" value={k ? k.failed + k.expired : "—"} sublabel={k ? `${k.expired} expired` : undefined} loading={q.isLoading} variant={k && k.failed + k.expired > 0 ? "danger" : "default"} />
        <KpiTile label="Pending" value={k?.pending ?? "—"} loading={q.isLoading} />
        <KpiTile label="Success" value={pctText(k?.success_rate)} loading={q.isLoading}
          variant={({ good: "success", warn: "warning", bad: "danger", none: "default" } as const)[rateTone(k?.success_rate)]} sublabel="of ended orders" />
        <KpiTile label="Median confirm" value={mins(k?.median_confirm_min)} sublabel="created → paid" loading={q.isLoading} />
        <KpiTile label="Create failures" value={k?.create_failures ?? "—"} sublabel={k?.create_failures == null ? "live only" : "gateway refused to create"} loading={q.isLoading}
          variant={k?.create_failures ? "warning" : "default"} />
      </div>

      {(d?.low_merchants.length ?? 0) > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] p-3 text-sm">
          <div className="font-medium text-[color:var(--color-danger)]">Merchants under 80% success in the last hour (5 orders or more)</div>
          <ul className="mt-1 space-y-0.5">
            {d!.low_merchants.map((m) => (
              <li key={m.provider_id}><Link href={`/merchants/${m.provider_id}`} className="font-medium hover:underline">{m.provider_name}</Link>: {pctText(m.rate)} of {m.ended} ended ({m.orders} orders)</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Section title="Success rate by hour" description="Last 24 hours, IST. Dashed lines at 85% and 60%." className="lg:col-span-2">
          {d ? <RateLine points={d.hourly.map((h) => ({ label: h.label, rate: h.rate, detail: `${h.paid} paid of ${h.ended} ended, ${h.orders} orders` }))} /> : <Skeleton />}
        </Section>
        <Section title="Why orders were not paid" description="Today. Create failures come from the MID switch.">
          {d ? <Donut unit="orders" empty="No failed or expired Intent orders today."
            parts={d.failures.map((f) => ({ label: PAYIN_FAILURE_LABEL[f.key], n: f.n, color: REASON_COLOR[f.key] }))} /> : <Skeleton />}
        </Section>
      </div>

      <Section title="Paid and not paid by banker" description="Today, IST. Top 16 bankers by orders." className="mb-4">
        {d ? <StackedBars data={bars} empty="No Intent order has ended today yet."
          series={[{ key: "paid", label: "Paid", color: "var(--color-success)" }, { key: "lost", label: "Failed or expired", color: "var(--color-danger)" }]} /> : <Skeleton />}
      </Section>

      <Section title="Banker health" description="Last 24 hours. Callback = the last pay-in callback sent to the banker's server."
        action={<CsvButton filename={`intent-bankers-${d?.livemode === false ? "test" : "live"}.csv`}
          headers={["banker_code", "banker", "merchant", "gateways", "gateway_mids", "orders_24h", "paid_24h", "failed_24h", "expired_24h", "pending_24h", "success_pct", "median_confirm_min", "last_callback", "last_callback_at", "status"]}
          rows={(d?.bankers ?? []).map((r) => [r.code, r.name, r.provider_name, r.gateways.join(" "), r.gateway_mids, r.orders_24h, r.paid_24h, r.failed_24h, r.expired_24h, r.pending_24h,
            r.success_24h == null ? null : Math.round(r.success_24h * 1000) / 10, r.median_confirm_min, r.callback?.last_status, r.callback?.last_at, r.state])} />}>
        {q.isLoading ? <Skeleton /> : <SimpleTable rows={d?.bankers ?? []} cols={cols} rowKey={(r) => r.code} empty="No banker took an Intent order in the last 24 hours." />}
        {d && d.bankers.some((b) => rateTone(b.success_24h) === "bad") && (
          <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">
            <Badge variant={TONE_VARIANT.bad}>red</Badge> under 60%. To move traffic off a MID, pause it or pin another on the <Link className="underline" href="/mid-switch">MID switch</Link>; to stop a banker, block it on its page.
          </p>
        )}
      </Section>
    </>
  );
}

export function Skeleton({ h = 160 }: { h?: number }) {
  return <div className="w-full animate-pulse rounded-xl bg-[color:var(--color-surface-muted)]" style={{ height: h }} />;
}
