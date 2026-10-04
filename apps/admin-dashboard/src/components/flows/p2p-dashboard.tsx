"use client";

// P2P pay-in dashboard (/flows/p2p). STAFF ONLY, read-only. Money with no order is handled
// under Transaction intelligence; open P2P orders under Pay-in Flows → P2P pay-ins.

import Link from "next/link";
import { Smartphone } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { pctText, rateTone } from "@/lib/flow-dashboards";
import type { P2pBankerRow, P2pDashboard, UpiIdRow } from "@/lib/flow-dashboards-p2p";
import { HBars, StackedBars } from "./charts";
import { Skeleton } from "./intent-dashboard";
import {
  ago, BankerLink, CsvButton, ErrorNote, FlowToolbar, inr, istDateTime, mins, RateBadge, Section, SimpleTable, StateBadge, useFlowData, useFlowParams,
  type Col,
} from "./shared";

export function P2pFlowDashboard() {
  const p = useFlowParams();
  const q = useFlowData<P2pDashboard>("p2p", p.mode, p.banker);
  const d = q.data;
  const k = d?.kpi;

  const bankerCols: Col<P2pBankerRow>[] = [
    { header: "Banker", cell: (r) => <><BankerLink id={r.id} name={r.name} code={r.code} />{r.provider_name && <div className="text-xs text-[color:var(--color-text-muted)]">{r.provider_name}</div>}</> },
    { header: "UPI IDs", right: true, cell: (r) => r.upi_ids },
    { header: "Orders today", right: true, cell: (r) => r.orders },
    { header: "Paid", right: true, cell: (r) => r.paid },
    { header: "Waiting", right: true, cell: (r) => r.pending },
    { header: "Success", right: true, cell: (r) => <RateBadge rate={r.success} /> },
    { header: "Money with no order", right: true, title: "Credits to the banker's UPI IDs in the last 3 days that no order accounts for (live only)",
      cell: (r) => r.unmatched_count ? <span className="text-[color:var(--color-warning)]">{r.unmatched_count} · {inr(r.unmatched_amount)}</span> : "0" },
    { header: "Status", cell: (r) => <StateBadge state={r.state} /> },
    { header: "", cell: (r) => <button type="button" className="text-xs text-[color:var(--color-brand)] hover:underline" onClick={() => p.setBanker(r.code)}>Only this</button> },
  ];
  const upiCols: Col<UpiIdRow>[] = [
    { header: "UPI ID", cell: (r) => <span className="font-mono text-xs">{r.upi_id}</span> },
    { header: "Banker", cell: (r) => <span className="font-mono text-xs">{r.banker}</span> },
    { header: "Kind", cell: (r) => <Badge variant={r.source === "MID" ? "brand" : "default"}>{r.source === "MID" ? "MID" : "Settlement"}</Badge> },
    { header: "State", cell: (r) => <Badge variant={r.status === "ACTIVE" ? "success" : "warning"}>{r.status.toLowerCase()}</Badge> },
    { header: "Orders today", right: true, cell: (r) => `${r.orders_today}${r.daily_count ? ` / ${r.daily_count}` : ""}` },
    { header: "Amount today", right: true, cell: (r) => `${inr(r.amount_today)}${r.daily_amount ? ` / ${inr(r.daily_amount)}` : ""}` },
    { header: "Use of limit", right: true, cell: (r) => r.use == null ? <span className="text-xs text-[color:var(--color-text-muted)]">no day limit</span>
      : <Badge variant={r.use >= 0.9 ? "danger" : r.use >= 0.7 ? "warning" : "success"}>{pctText(r.use)}</Badge> },
  ];

  const e = d?.pending_by_expiry;
  const recon = d?.recon;

  return (
    <>
      <PageHeader title="P2P pay-ins" icon={Smartphone}
        description="The customer pays the banker's own UPI ID and a bank credit proves it. Today is India time." />
      <FlowToolbar livemode={d?.livemode} banker={p.banker} asOf={d?.as_of} fetching={q.isFetching}
        onMode={p.setMode} onClearBanker={() => p.setBanker(null)}
        links={[{ href: "/payin-flows/p2p", label: "P2P orders" }, { href: "/mid-switch", label: "MID switch" }, { href: "/transaction-intel", label: "Transaction intelligence" }, { href: "/flows/health", label: "Flow health" }]} />
      <ErrorNote error={q.error} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Deposits today" value={k?.deposits ?? "—"} loading={q.isLoading} />
        <KpiTile label="Credited" value={k?.credited ?? "—"} sublabel={k ? inr(k.paid_amount) : undefined} variant="success" loading={q.isLoading} />
        <KpiTile label="Waiting" value={k?.pending ?? "—"} loading={q.isLoading} />
        <KpiTile label="Expired" value={k?.expired ?? "—"} sublabel={k?.failed ? `${k.failed} failed` : undefined} loading={q.isLoading} variant={k?.expired ? "warning" : "default"} />
        <KpiTile label="Average credit time" value={mins(k?.avg_credit_min)} sublabel="order → credit" loading={q.isLoading} />
        <KpiTile label="Active UPI IDs" value={k?.active_upi_ids ?? "—"} sublabel="MIDs + settlement" loading={q.isLoading} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Section title="Deposits by hour" description="Last 24 hours, IST." className="lg:col-span-2">
          {d ? <StackedBars empty="No P2P order in the last 24 hours."
            data={d.hourly.map((h) => ({ label: h.label, values: { paid: h.paid, other: h.orders - h.paid } }))}
            series={[{ key: "paid", label: "Credited", color: "var(--color-success)" }, { key: "other", label: "Not credited", color: "var(--color-text-subtle)" }]} /> : <Skeleton />}
        </Section>
        <Section title="Waiting orders by time left" description="Before the customer's 15 minutes run out (last 3 days).">
          {e ? <HBars empty="No P2P order is waiting." items={[
            { label: "Past expiry", n: e.overdue, color: "var(--color-danger)" },
            { label: "Within 1 hour", n: e.within_1h, color: "var(--color-warning)" },
            { label: "1 to 4 hours", n: e.within_4h },
            { label: "4 to 24 hours", n: e.within_24h },
          ]} /> : <Skeleton />}
        </Section>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Money received with no order" description={d?.livemode === false ? "Live only: test mode has no real money." : "Credits to bankers' UPI IDs in the last 3 days that no order accounts for."}
          action={<Link href="/transaction-intel" className="text-xs text-[color:var(--color-brand)] hover:underline">Match them →</Link>}>
          {recon ? (
            <>
              <p className="mb-2 text-sm"><span className="font-semibold tabular-nums">{recon.unmatched.count}</span> credits · <span className="font-semibold">{inr(recon.unmatched.amount)}</span></p>
              <SimpleTable rows={recon.unmatched.rows} rowKey={(r) => `${r.utr}-${r.at}-${r.amount}`} empty="None. Every credit has its order."
                cols={[
                  { header: "Banker", cell: (r) => <span className="font-mono text-xs">{r.banker}</span> },
                  { header: "Amount", right: true, cell: (r) => inr(r.amount) },
                  { header: "Bank reference (UTR)", cell: (r) => <span className="font-mono text-xs">{r.utr ?? "—"}</span> },
                  { header: "Received", cell: (r) => istDateTime(r.at) },
                ]} />
            </>
          ) : <Skeleton />}
        </Section>
        <Section title="Waiting over 30 minutes, no credit" description="Open P2P orders with no bank reference (last 3 days). The money may have arrived unmatched."
          action={<Link href="/payin-flows/p2p" className="text-xs text-[color:var(--color-brand)] hover:underline">P2P orders →</Link>}>
          {recon ? (
            <>
              <p className="mb-2 text-sm"><span className="font-semibold tabular-nums">{recon.stale.count}</span> orders{recon.stale.count > recon.stale.rows.length ? ` (oldest ${recon.stale.rows.length} shown)` : ""}</p>
              <SimpleTable rows={recon.stale.rows} rowKey={(r) => r.id} empty="None waiting that long."
                cols={[
                  { header: "Order", cell: (r) => <Link href={`/orders/${r.id}`} className="font-mono text-xs hover:underline">{r.order_id}</Link> },
                  { header: "Banker", cell: (r) => <span className="font-mono text-xs">{r.banker}</span> },
                  { header: "Amount", right: true, cell: (r) => inr(r.amount) },
                  { header: "Created", cell: (r) => <span title={istDateTime(r.created_at)}>{ago(r.created_at)}</span> },
                ]} />
            </>
          ) : <Skeleton />}
        </Section>
      </div>

      <Section title="UPI IDs today" description="Use against each MID's day limits. Settlement UPI IDs without a MID have no limit of their own." className="mb-4"
        action={<Link href="/mid-switch" className="text-xs text-[color:var(--color-brand)] hover:underline">MID switch →</Link>}>
        {d ? <SimpleTable rows={d.upi_ids} cols={upiCols} rowKey={(r) => `${r.banker}|${r.upi_id}`} empty="No UPI ID is set up for these bankers." /> : <Skeleton />}
      </Section>

      <Section title="Bankers" description="Today, IST."
        action={<CsvButton filename={`p2p-bankers-${d?.livemode === false ? "test" : "live"}.csv`}
          headers={["banker_code", "banker", "merchant", "upi_ids", "orders", "paid", "waiting", "success_pct", "unmatched_count", "unmatched_amount", "status"]}
          rows={(d?.bankers ?? []).map((r) => [r.code, r.name, r.provider_name, r.upi_ids, r.orders, r.paid, r.pending,
            r.success == null ? null : Math.round(r.success * 1000) / 10, r.unmatched_count, r.unmatched_amount, r.state])} />}>
        {d ? <SimpleTable rows={d.bankers} cols={bankerCols} rowKey={(r) => r.code} empty="No P2P order today and no unmatched money." /> : <Skeleton />}
        {d && d.bankers.some((b) => rateTone(b.success) === "bad") && (
          <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">To stop a banker taking orders, block it on its page; to take a UPI ID out of rotation, pause it on the MID switch.</p>
        )}
      </Section>
    </>
  );
}
