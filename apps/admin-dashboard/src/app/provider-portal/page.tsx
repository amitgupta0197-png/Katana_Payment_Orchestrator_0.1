"use client";

// PROVIDER portfolio dashboard. KPI tiles for mapped merchants, sub-MID
// pipeline, commission, KYB cases; alert strip surfaces items needing
// action; recent activity panel pulls WORM events scoped to the provider.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  LayoutDashboard, Store, Network, FileCheck2, Percent, Plus, ChevronRight, Activity, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { AlertStrip, type AlertItem } from "@/components/world-class/alert-strip";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface MerchantRow { id: string; merchant_code: string; stage: string; legal_name?: string; created_at?: string }
interface SubMidRow { id: string; sub_mid_code: string; kyc_status: string; settlement_enabled: boolean }
interface KybRow { id: string; status: string; merchant_id: string; opened_at: string }

const PIPELINE_STAGES = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"];

export default function ProviderDashboard() {
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: MerchantRow[] },
  });
  const subMids = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then((r) => r.json())) as { sub_mids: SubMidRow[] },
  });
  const commission = useQuery({
    queryKey: ["pp:commission"],
    queryFn: async () => (await fetch("/api/commission").then((r) => r.json())) as { mtd_earned: number; ytd_earned: number },
  });
  const kyb = useQuery({
    queryKey: ["pp:kyb"],
    queryFn: async () => (await fetch("/api/kyb").then((r) => r.json())) as { cases: KybRow[] },
  });

  const allMerchants = merchants.data?.merchants ?? [];
  const subs = subMids.data?.sub_mids ?? [];
  const kybCases = kyb.data?.cases ?? [];

  const stageCounts: Record<string, number> = {};
  for (const m of allMerchants) stageCounts[m.stage] = (stageCounts[m.stage] ?? 0) + 1;
  const liveCount = stageCounts.LIVE ?? 0;
  const inOnboarding = allMerchants.length - liveCount;
  const subMidsPending = subs.filter((s) => s.kyc_status === "PENDING" || s.kyc_status === "IN_REVIEW").length;
  const subMidsLive = subs.filter((s) => s.settlement_enabled).length;
  const kybOpen = kybCases.filter((c) => c.status !== "APPROVED" && c.status !== "REJECTED" && c.status !== "EXPIRED").length;

  const alerts: AlertItem[] = [];
  if (subMidsPending > 0)
    alerts.push({ level: "warning", title: `${subMidsPending} Sub-MID request${subMidsPending > 1 ? "s" : ""} pending KYC`, detail: "Your Sub-MIDs are blocked until docs are verified.", href: "/provider-portal/sub-mids", cta: "Open" });
  if (kybOpen > 0)
    alerts.push({ level: "info", title: `${kybOpen} merchant KYB case${kybOpen > 1 ? "s" : ""} in progress`, href: "/provider-portal/merchants", cta: "Track" });
  const stuckEarly = allMerchants.filter((m) => m.stage === "APPLICATION" || m.stage === "DOCS_PENDING");
  if (stuckEarly.length > 2)
    alerts.push({ level: "info", title: `${stuckEarly.length} merchants stuck pre-screening`, detail: "Push docs or escalate to ops.", href: "/provider-portal/merchants" });

  return (
    <>
      <PageHeader
        title="Provider dashboard"
        description="Your mapped merchants, Sub-MID pipeline, KYB progress, and commission."
        icon={LayoutDashboard}
        actions={<Badge variant={merchants.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>}
      />

      {alerts.length > 0 && (
        <div className="mb-6">
          <AlertStrip items={alerts.slice(0, 5)} />
        </div>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Portfolio</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Mapped merchants" value={allMerchants.length} icon={Store} loading={merchants.isLoading} href="/provider-portal/merchants" />
        <KpiTile label="Merchants live" value={liveCount} sublabel={`${inOnboarding} in onboarding`} icon={Store} variant={liveCount > 0 ? "success" : "default"} loading={merchants.isLoading} href="/provider-portal/merchants" />
        <KpiTile label="Sub-MIDs live" value={subMidsLive} sublabel={`${subMidsPending} pending KYC`} icon={Network} loading={subMids.isLoading} href="/provider-portal/sub-mids" />
        <KpiTile label="Open KYB cases" value={kybOpen} icon={FileCheck2} variant={kybOpen > 0 ? "warning" : "default"} loading={kyb.isLoading} />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Commission</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="MTD earned" value={formatAmount(commission.data?.mtd_earned ?? 0)} icon={Percent} loading={commission.isLoading} href="/provider-portal/commission" />
        <KpiTile label="YTD earned" value={formatAmount(commission.data?.ytd_earned ?? 0)} icon={Wallet} loading={commission.isLoading} href="/provider-portal/commission" />
      </div>

      {/* Onboarding pipeline funnel */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Onboarding funnel</CardTitle>
          <CardDescription>Where your merchants are in the 6-stage pipeline.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            {PIPELINE_STAGES.map((stage) => {
              const n = stageCounts[stage] ?? 0;
              const active = n > 0;
              return (
                <div key={stage} className={`rounded-md border p-3 text-center ${active ? "bg-[color:var(--color-brand-muted)]/40 border-[color:var(--color-brand)]/40" : ""}`}>
                  <div className="text-2xl font-semibold tabular-nums">{n}</div>
                  <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">{stage}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent merchants</CardTitle>
            <CardDescription>Most recent additions to your portfolio.</CardDescription>
          </CardHeader>
          <CardContent>
            {allMerchants.slice(0, 10).length === 0
              ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No merchants mapped yet.</div>
              : (
                <ol className="flex flex-col gap-2 text-sm">
                  {allMerchants.slice(0, 10).map((m) => (
                    <li key={m.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                      <Badge variant="brand">{m.merchant_code}</Badge>
                      <span className="flex-1 truncate">{m.legal_name ?? "—"}</span>
                      <Badge variant={m.stage === "LIVE" ? "success" : m.stage.includes("PENDING") ? "warning" : "default"}>{m.stage}</Badge>
                      {m.created_at && <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatDateTime(m.created_at)}</span>}
                    </li>
                  ))}
                </ol>
              )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2">
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/provider-portal/leads"><span className="inline-flex items-center gap-2"><Plus className="h-4 w-4" /> Submit new merchant lead</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/provider-portal/sub-mids"><span className="inline-flex items-center gap-2"><Network className="h-4 w-4" /> Request a Sub-MID</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/provider-portal/kyc"><span className="inline-flex items-center gap-2"><FileCheck2 className="h-4 w-4" /> Upload KYC docs</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/provider-portal/commission"><span className="inline-flex items-center gap-2"><Percent className="h-4 w-4" /> Commission statement</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
