"use client";

// SUPER_ADMIN ops cockpit. Real-time KPIs, queue depth, alert strip with
// CTAs to the items that need attention right now. Replaces the previous
// "8 pillar cards" landing.

import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, UserPlus, Store, FileCheck2, ShieldCheck, ShieldAlert,
  Banknote, Activity, Plus, ChevronRight, AlertOctagon, AlertTriangle, Clock,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { AlertStrip, type AlertItem } from "@/components/world-class/alert-strip";
import { ActivityFeed } from "@/components/world-class/activity-feed";
import { formatAmount } from "@/lib/utils";

interface Stats {
  providers: { total: number; kyc_pending: number };
  merchants: { total: number; by_stage: Record<string, number> };
  queue: { kyb_pending: number; maker_checker: number; disputes_open: number; risk_cases: number };
  today: {
    transactions: number; failed: number; success_rate: number | null;
    gross: number; settlement_batches: number; settlement_net: number;
  };
}

const STAGES = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"];

export default function SuperAdminCockpit() {
  const q = useQuery({
    queryKey: ["admin:stats"],
    queryFn: async () => (await fetch("/api/admin/stats").then((r) => r.json())) as Stats,
    refetchInterval: 30_000,
  });

  const s = q.data;
  const successRate = s?.today.success_rate ?? null;
  const successVariant: "default" | "success" | "warning" | "danger" =
    successRate === null ? "default" :
    successRate >= 99 ? "success" :
    successRate >= 95 ? "default" :
    successRate >= 90 ? "warning" : "danger";

  const alerts: AlertItem[] = [];
  if (s) {
    if (s.queue.maker_checker > 0)
      alerts.push({ level: "critical", title: `${s.queue.maker_checker} approvals pending in maker-checker queue`, detail: "Sensitive actions awaiting a second Super-Admin.", href: "/admin/maker-checker", cta: "Review" });
    if (s.queue.kyb_pending > 0)
      alerts.push({ level: "warning", title: `${s.queue.kyb_pending} KYB cases open`, detail: "Documents + screening waiting on decision.", href: "/kyb", cta: "Open cases" });
    if (s.queue.disputes_open > 0)
      alerts.push({ level: "warning", title: `${s.queue.disputes_open} disputes open`, detail: "SLA clock running on each.", href: "/disputes", cta: "Work queue" });
    if (s.queue.risk_cases > 0)
      alerts.push({ level: "info", title: `${s.queue.risk_cases} risk / AML cases`, detail: "Velocity hits + sanctions reviews.", href: "/risk", cta: "Review" });
    if (s.providers.kyc_pending > 0)
      alerts.push({ level: "info", title: `${s.providers.kyc_pending} provider KYC pending`, href: "/providers?f=kyc:pending", cta: "Open" });
    if (s.today.failed > 0 && s.today.transactions > 0 && (successRate ?? 100) < 95)
      alerts.push({ level: "critical", title: `Today's success rate is ${successRate}%`, detail: `${s.today.failed} of ${s.today.transactions} txns failed.`, href: "/checkout", cta: "Inspect" });
  }

  const quickActions = [
    { label: "New provider",  icon: UserPlus,  href: "/providers?new=1" },
    { label: "Onboard merchant", icon: Store,  href: "/merchants?new=1" },
    { label: "Approve queue", icon: ShieldCheck, href: "/admin/maker-checker" },
    { label: "KYB cases",    icon: FileCheck2, href: "/kyb" },
    { label: "Routing cockpit", icon: Activity, href: "/admin/routing" },
    { label: "Add user",     icon: Plus,      href: "/admin/access?new=1" },
  ];

  return (
    <>
      <PageHeader
        title="Operations console"
        description="Live state of the platform. Real-time KPIs · pending decisions · today's volume."
        icon={LayoutDashboard}
        actions={
          <Badge variant={q.isFetching ? "info" : "default"} className="text-[10px]">
            <Activity className="h-3 w-3 mr-1" />{q.isFetching ? "refreshing" : "auto-refresh 30s"}
          </Badge>
        }
      />

      {/* Alerts first — surface what needs action before showing pretty numbers. */}
      {alerts.length > 0 && (
        <div className="mb-6">
          <AlertStrip items={alerts.slice(0, 6)} />
        </div>
      )}

      {/* Today KPIs */}
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Today so far</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Transactions" value={s?.today.transactions ?? 0} sublabel={`gross ${formatAmount(s?.today.gross ?? 0)}`} icon={Activity} loading={q.isLoading} href="/checkout" />
        <KpiTile label="Success rate" value={successRate === null ? "—" : `${successRate}%`} sublabel={`${s?.today.failed ?? 0} failed`} variant={successVariant} loading={q.isLoading} href="/checkout?f=failed" />
        <KpiTile label="Settlement batches" value={s?.today.settlement_batches ?? 0} sublabel={`net ${formatAmount(s?.today.settlement_net ?? 0)}`} icon={Banknote} loading={q.isLoading} href="/settlement" />
        <KpiTile label="Approvals pending" value={s?.queue.maker_checker ?? 0} icon={ShieldCheck} variant={(s?.queue.maker_checker ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} href="/admin/maker-checker" />
      </div>

      {/* Queue + portfolio */}
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Queue depth</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="KYB pending" value={s?.queue.kyb_pending ?? 0} icon={FileCheck2} variant={(s?.queue.kyb_pending ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} href="/kyb" />
        <KpiTile label="Disputes open" value={s?.queue.disputes_open ?? 0} icon={ShieldAlert} variant={(s?.queue.disputes_open ?? 0) > 0 ? "warning" : "default"} loading={q.isLoading} href="/disputes" />
        <KpiTile label="Risk / AML cases" value={s?.queue.risk_cases ?? 0} icon={ShieldAlert} loading={q.isLoading} href="/risk" />
        <KpiTile label="Provider KYC pending" value={s?.providers.kyc_pending ?? 0} icon={UserPlus} loading={q.isLoading} href="/providers?f=kyc:pending" />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Portfolio</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Providers" value={s?.providers.total ?? 0} icon={UserPlus} loading={q.isLoading} href="/providers" />
        <KpiTile label="Merchants" value={s?.merchants.total ?? 0} icon={Store} loading={q.isLoading} href="/merchants" />
        <KpiTile label="Merchants live" value={s?.merchants.by_stage?.LIVE ?? 0} sublabel="reached LIVE stage" variant="success" loading={q.isLoading} href="/merchants?f=live" />
        <KpiTile label="In onboarding" value={STAGES.filter(x => x !== "LIVE").reduce((sum, st) => sum + (s?.merchants.by_stage?.[st] ?? 0), 0)} sublabel="across 5 pre-live stages" loading={q.isLoading} href="/merchants" />
      </div>

      {/* Quick actions + Activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent platform activity</CardTitle>
            <CardDescription>WORM-audited writes across all tenants in the last hours.</CardDescription>
          </CardHeader>
          <CardContent>
            <RecentPlatformActivity />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick actions</CardTitle>
            <CardDescription>One click to the most common admin starting points.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2">
            {quickActions.map((a) => (
              <Button key={a.href} variant="secondary" asChild className="justify-between">
                <Link href={a.href}>
                  <span className="inline-flex items-center gap-2"><a.icon className="h-4 w-4" />{a.label}</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// Lightweight global activity feed — re-uses /api/admin-log but renders the
// first 15 rows in the dashboard's column without leaving for the full page.
function RecentPlatformActivity() {
  const q = useQuery({
    queryKey: ["admin:recent-activity"],
    queryFn: async () => (await fetch("/api/admin-log?limit=15").then((r) => r.json())) as {
      events: Array<{ event_id: string; actor_subject: string; action: string; resource_type: string; resource_id: string; occurred_at: string; notes?: string }>;
    },
    refetchInterval: 20_000,
  });
  if (q.isLoading)
    return <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">Loading activity…</div>;
  const events = q.data?.events ?? [];
  if (events.length === 0)
    return <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No activity yet. Take any action above and it'll appear here.</div>;
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {events.map((ev) => (
        <li key={ev.event_id} className="flex items-center gap-2 rounded-md border border-[color:var(--color-border)] px-3 py-2">
          <span className="text-xs text-[color:var(--color-text-muted)] w-20 shrink-0">{new Date(ev.occurred_at).toLocaleTimeString()}</span>
          <span className="text-xs font-mono text-[color:var(--color-text-muted)] w-32 shrink-0 truncate">{ev.actor_subject || "system"}</span>
          <Badge variant="brand">{ev.action}</Badge>
          <span className="text-xs text-[color:var(--color-text-muted)] truncate">{ev.resource_type}/{ev.resource_id.slice(0, 8)}…</span>
        </li>
      ))}
    </ol>
  );
}
