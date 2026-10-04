"use client";

// The Operations console's health additions (super-admin-cockpit): the actor strip, the flow
// row, integration and health alerts, and the tabbed onboarding funnel. Data from /api/admin/stats
// (lib/health-console). Staff only: labels may name a TSP.

import { useState } from "react";
import Link from "next/link";
import { Building2, Store, UserPlus, Hash, Zap, Smartphone, Landmark, Plug, HeartPulse, ChevronRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { FunnelBars } from "@/components/world-class/dashboard-charts";
import { HealthRing, type HealthActorType, type HealthBand } from "@/components/health/health-ring";
import { cn } from "@/lib/utils";

export interface ConsoleExtras {
  actors?: { tsps_total: number; tsps_live: number; bankers_live: number; merchants_live: number; mids_active: number };
  flows?: { intent_total_today: number; intent_success_pct: number | null; p2p_pending: number; payout_pending: number; payout_avg_lag_min: number | null };
  yesterday?: { transactions: number; gross: number; failed: number; success_rate: number | null; settlement_batches: number };
  health_alerts?: { type: HealthActorType; id: string; label: string | null; band: HealthBand; score: number; missing: string[] }[];
  integration_alerts?: { banker_id: string | null; code: string; problems: string[] }[];
  funnels?: { tsp: { stage: string; n: number }[]; merchant: { stage: string; n: number }[] };
  merchants?: { by_stage: Record<string, number> };
}

const H2 = "mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]";

/** TSPs live | Bankers live | Merchants live | MIDs active. */
export function ActorHealthStrip({ s, loading }: { s?: ConsoleExtras; loading: boolean }) {
  const a = s?.actors;
  return (
    <>
      <h2 className={H2}>Actor health</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="TSPs live" value={a?.tsps_live ?? 0} sublabel={`of ${a?.tsps_total ?? 0}`} icon={Building2} loading={loading} href="/tsps" />
        <KpiTile label="Bankers live" value={a?.bankers_live ?? 0} icon={Store} variant="success" loading={loading} href="/bankers" />
        <KpiTile label="Merchants live" value={a?.merchants_live ?? 0} sublabel="with a live banker" icon={UserPlus} loading={loading} href="/merchants" />
        <KpiTile label="MIDs active" value={a?.mids_active ?? 0} sublabel="issued, approved" icon={Hash} loading={loading} href="/tsps" />
      </div>
    </>
  );
}

/** Intent success today, P2P pending queue, payouts pending and average settle lag. */
export function FlowHealthRow({ s, loading }: { s?: ConsoleExtras; loading: boolean }) {
  const f = s?.flows;
  const pct = f?.intent_success_pct ?? null;
  return (
    <>
      <h2 className={H2}>Flow health</h2>
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile label="Intent success today" value={pct === null ? "—" : `${pct}%`} sublabel={`${f?.intent_total_today ?? 0} orders`} icon={Zap}
          variant={pct === null ? "default" : pct >= 90 ? "success" : pct >= 70 ? "warning" : "danger"} loading={loading} href="/flows/intent" />
        <KpiTile label="P2P pending queue" value={f?.p2p_pending ?? 0} sublabel="waiting for a bank credit (24 h)" icon={Smartphone}
          variant={(f?.p2p_pending ?? 0) > 50 ? "warning" : "default"} loading={loading} href="/flows/p2p" />
        <KpiTile label="Payouts pending" value={f?.payout_pending ?? 0}
          sublabel={f?.payout_avg_lag_min == null ? "no payout settled today" : `avg settle ${f.payout_avg_lag_min} min today`}
          icon={Landmark} loading={loading} href="/flows/payout" />
      </div>
    </>
  );
}

/** Up to five bankers with no live Key or callbacks not reaching them. */
export function IntegrationAlertsCard({ s }: { s?: ConsoleExtras }) {
  const list = s?.integration_alerts ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4" />Integration alerts</CardTitle>
          <CardDescription>Bankers with no live Key or callbacks not reaching them.</CardDescription>
        </div>
        <Link href="/merchant-readiness" className="inline-flex shrink-0 items-center text-xs font-medium text-[color:var(--color-brand)] hover:underline">
          View all <ChevronRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {list.length === 0
          ? <p className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">No integration problems.</p>
          : (
            <ul className="space-y-2 text-sm">
              {list.map((a) => (
                <li key={a.code} className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)] px-3 py-2">
                  <Link href={a.banker_id ? `/bankers/${a.banker_id}?tab=developer` : "/bankers"} className="font-medium hover:underline">{a.code}</Link>
                  <span className="flex flex-wrap justify-end gap-1">
                    {a.problems.map((p) => <Badge key={p} variant="warning" className="text-[10px]">{p}</Badge>)}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </CardContent>
    </Card>
  );
}

const TYPE_WORD: Record<HealthActorType, string> = { TSP: "TSP", BANKER: "Banker", MERCHANT: "Merchant", INTEGRATION: "Integration" };

/** Live actors that are RED or BLOCKED, each opening its checklist. */
export function HealthAlertsCard({ s }: { s?: ConsoleExtras }) {
  const list = s?.health_alerts ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HeartPulse className="h-4 w-4" />Health alerts</CardTitle>
        <CardDescription>Live TSPs, bankers, merchants and integrations that are RED or BLOCKED.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.length === 0
          ? <p className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">Every live actor is GREEN or AMBER.</p>
          : (
            <ul className="space-y-2 text-sm">
              {list.map((a) => (
                <li key={`${a.type}:${a.id}`} className="flex items-center gap-3 rounded-md border border-[color:var(--color-border)] px-3 py-2">
                  <HealthRing type={a.type} id={a.id} label={a.label ?? a.id} row={{ actor_type: a.type, actor_id: a.id, label: a.label, live: true, score: a.score, raw_score: a.score, band: a.band, computed_at: "", stale: false, items: [] }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{TYPE_WORD[a.type]} {a.label ?? a.id}</div>
                    <div className="truncate text-xs text-[color:var(--color-text-muted)]">{a.missing.join(" · ") || "—"}</div>
                  </div>
                  <Badge variant="danger" className="text-[10px]">{a.band}</Badge>
                </li>
              ))}
            </ul>
          )}
      </CardContent>
    </Card>
  );
}

const TSP_ORDER = ["APPLICATION", "KYB_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"] as const;
const BANKER_ORDER = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "MID_ISSUANCE", "CONFIG", "LIVE"] as const;
const MERCHANT_ORDER = ["CREATED", "KYC_APPROVED", "CHOICE_MADE", "HAS_BANKER", "LIVE"] as const;
const MERCHANT_LABEL: Record<string, string> = { CREATED: "Created", KYC_APPROVED: "KYC approved", CHOICE_MADE: "Services chosen", HAS_BANKER: "Has a banker", LIVE: "Live" };
type FunnelTab = "TSP" | "BANKER" | "MERCHANT";

/** The onboarding funnel, one tab per actor, drawn by the same FunnelBars. */
export function TabbedFunnel({ s }: { s?: ConsoleExtras }) {
  const [tab, setTab] = useState<FunnelTab>("BANKER");
  const banker = Object.entries(s?.merchants?.by_stage ?? {}).map(([stage, n]) => ({ stage, n }));
  const desc: Record<FunnelTab, string> = {
    TSP: "TSPs by onboarding stage.",
    BANKER: "Bankers by stage.",
    MERCHANT: "Merchants reaching each step: created, KYC approved, services chosen, a banker mapped, a live banker.",
  };
  return (
    <>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Onboarding funnel</CardTitle>
          <CardDescription>{desc[tab]}</CardDescription>
        </div>
        <div role="tablist" className="inline-flex rounded-md border border-[color:var(--color-border)] p-0.5 text-xs">
          {(["TSP", "BANKER", "MERCHANT"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}
              className={cn("rounded px-2.5 py-1 font-medium", tab === t ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]")}>
              {t === "TSP" ? "TSP" : t === "BANKER" ? "Banker" : "Merchant"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {tab === "TSP" && <FunnelBars funnel={s?.funnels?.tsp ?? []} order={TSP_ORDER} />}
        {tab === "BANKER" && <FunnelBars funnel={banker} order={BANKER_ORDER} />}
        {tab === "MERCHANT" && <FunnelBars funnel={s?.funnels?.merchant ?? []} order={MERCHANT_ORDER} label={(x) => MERCHANT_LABEL[x] ?? x} />}
      </CardContent>
    </>
  );
}

/** Percentage change against the same time yesterday, for KpiTile's trend arrow. */
export function vsYesterday(today: number | null | undefined, yesterday: number | null | undefined): number | undefined {
  if (today == null || yesterday == null) return undefined;
  if (yesterday === 0) return today > 0 ? 100 : 0;
  return Math.round(((today - yesterday) / yesterday) * 100);
}
