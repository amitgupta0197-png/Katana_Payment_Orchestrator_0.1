"use client";

// Payout dashboard (/flows/payout). STAFF ONLY, read-only. Approve / reject is on /payouts and
// the maker-checker queue; the operator queue on the FIFO dashboard.

import Link from "next/link";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { PAYOUT_FAILURE_LABEL, PAYOUT_MODES } from "@/lib/flow-dashboards";
import type { PayoutDashboard, PayoutQueueRow } from "@/lib/flow-dashboards-payout";
import { Donut, StackedBars } from "./charts";
import { Skeleton } from "./intent-dashboard";
import {
  ago, BankerLink, CsvButton, ErrorNote, FlowToolbar, inr, istDateTime, mins, Section, SimpleTable, StateBadge, useFlowData, useFlowParams,
  type Col,
} from "./shared";

const MODE_COLOR: Record<string, string> = {
  IMPS: "var(--color-brand)", NEFT: "var(--color-info)", RTGS: "var(--color-brand-2)", UPI: "var(--color-success)", OTHER: "var(--color-text-subtle)",
};
const REASON_COLOR: Record<string, string> = {
  INSUFFICIENT_FUNDS: "var(--color-warning)", BENEFICIARY: "var(--color-info)", REJECTED: "var(--color-text-muted)",
  PROCESSOR: "var(--color-danger)", RETURNED: "var(--color-brand)", OTHER: "var(--color-text-subtle)",
};

export function PayoutFlowDashboard() {
  const p = useFlowParams();
  const q = useFlowData<PayoutDashboard>("payout", p.mode, p.banker);
  const d = q.data;
  const k = d?.kpi;
  const live = d?.livemode !== false;

  const cols: Col<PayoutQueueRow>[] = [
    { header: "Banker", cell: (r) => <><BankerLink id={r.id} name={r.name} code={r.code} />{r.provider_name && <div className="text-xs text-[color:var(--color-text-muted)]">{r.provider_name}</div>}</> },
    { header: "Waiting", right: true, cell: (r) => r.open },
    { header: "Waiting amount", right: true, cell: (r) => inr(r.open_amount) },
    { header: "Oldest", cell: (r) => <span title={istDateTime(r.oldest_at)}>{ago(r.oldest_at)}</span> },
    { header: "Approval", right: true, title: "Waiting for a second person (maker-checker)", cell: (r) => r.awaiting_approval ? <Badge variant="warning">{r.awaiting_approval}</Badge> : "0" },
    { header: "On hold", right: true, cell: (r) => r.on_hold },
    { header: "Payable balance", right: true, title: "MERCHANT_PAYABLE in the ledger: what the banker can pay out from", cell: (r) => inr(r.payable) },
    { header: "After queue", right: true, title: "Payable balance less the waiting amount", cell: (r) => r.headroom == null ? "—"
      : <span className={r.headroom < 0 ? "font-medium text-[color:var(--color-danger)]" : ""}>{inr(r.headroom)}</span> },
    { header: "Sent today", right: true, cell: (r) => `${r.sent_today} · ${inr(r.sent_amount_today)}` },
    { header: "Status", cell: (r) => <StateBadge state={r.state} /> },
    { header: "", cell: (r) => <button type="button" className="text-xs text-[color:var(--color-brand)] hover:underline" onClick={() => p.setBanker(r.code)}>Only this</button> },
  ];

  return (
    <>
      <PageHeader title="Payouts" icon={Send}
        description="Payout requests from bankers' merchants: what was sent, what waits for approval or an operator, and the funds behind the queue. Today is India time." />
      <FlowToolbar livemode={d?.livemode} banker={p.banker} asOf={d?.as_of} fetching={q.isFetching}
        onMode={p.setMode} onClearBanker={() => p.setBanker(null)}
        links={[{ href: "/payouts", label: "Payouts & approvals" }, { href: "/fifo-dashboard", label: "FIFO dashboard" }, { href: "/merchant-wallet", label: "Banker wallet" }, { href: "/flows/health", label: "Flow health" }]} />
      <ErrorNote error={q.error} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Requests today" value={k?.requests ?? "—"} loading={q.isLoading} />
        <KpiTile label="Sent" value={k?.sent ?? "—"} sublabel={k ? inr(k.sent_amount) : undefined} variant="success" loading={q.isLoading} />
        <KpiTile label="Awaiting approval" value={k?.pending_approval ?? "—"} sublabel={live ? "maker-checker" : "none in test mode"} href="/payouts" loading={q.isLoading} variant={k?.pending_approval ? "warning" : "default"} />
        <KpiTile label="In progress" value={k?.open ?? "—"} sublabel="created today" loading={q.isLoading} />
        <KpiTile label="Failed" value={k?.failed ?? "—"} loading={q.isLoading} variant={k?.failed ? "danger" : "default"} />
        <KpiTile label="Average time to send" value={mins(k?.avg_settle_min)} sublabel="request → sent" loading={q.isLoading} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Section title="Amount sent by mode" description="Last 7 days, IST." className="lg:col-span-2">
          {d ? <StackedBars empty="No payout sent in the last 7 days." format={(v) => inr(v)}
            data={d.by_mode.map((m) => ({ label: m.day.slice(5), values: m.modes }))}
            series={PAYOUT_MODES.map((m) => ({ key: m, label: m === "OTHER" ? "Other" : m, color: MODE_COLOR[m] }))} /> : <Skeleton />}
        </Section>
        <Section title="Why payouts failed" description="Last 7 days.">
          {d ? <Donut unit="payouts" empty="No payout failed in the last 7 days."
            parts={d.failures.map((f) => ({ label: PAYOUT_FAILURE_LABEL[f.key], n: f.n, color: REASON_COLOR[f.key] }))} /> : <Skeleton />}
        </Section>
      </div>

      <Section title="Queue and funds by banker" description={live ? "Waiting payouts (last 30 days) against the banker's payable balance in the ledger." : "Test mode: the ledger holds live money only, so no balance is shown."}
        action={<div className="flex items-center gap-2">
          <Link href="/fifo-dashboard" className="text-xs text-[color:var(--color-brand)] hover:underline">Operator queue →</Link>
          <CsvButton filename={`payout-queue-${live ? "live" : "test"}.csv`}
            headers={["banker_code", "banker", "merchant", "waiting", "waiting_amount", "oldest_at", "awaiting_approval", "on_hold", "payable", "reserve", "after_queue", "sent_today", "sent_amount_today", "failed_today", "status"]}
            rows={(d?.queue ?? []).map((r) => [r.code, r.name, r.provider_name, r.open, r.open_amount, r.oldest_at, r.awaiting_approval, r.on_hold, r.payable, r.reserve, r.headroom, r.sent_today, r.sent_amount_today, r.failed_today, r.state])} />
        </div>}>
        {d ? <SimpleTable rows={d.queue} cols={cols} rowKey={(r) => r.code} empty="No payout waiting and none made today." /> : <Skeleton />}
        {d && d.queue.some((r) => (r.headroom ?? 0) < 0) && (
          <p className="mt-2 text-xs text-[color:var(--color-danger)]">A red figure means the waiting payouts are larger than the banker's payable balance.</p>
        )}
      </Section>
    </>
  );
}
