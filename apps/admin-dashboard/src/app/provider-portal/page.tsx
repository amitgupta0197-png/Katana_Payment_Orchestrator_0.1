"use client";

// PROVIDER portfolio dashboard. KPI tiles for mapped merchants, sub-MID
// pipeline, commission, KYB cases; alert strip surfaces items needing
// action; recent activity panel pulls WORM events scoped to the provider.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard, Store, Network, FileCheck2, Percent, Plus, ChevronRight, Activity, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { ProviderCharts } from "@/components/provider/portfolio-charts";
import { ProviderCreateOrderCard } from "@/components/provider/create-order-card";
import { PaymentFunnel } from "@/components/integrations/payment-funnel";
import { AlertStrip, type AlertItem } from "@/components/world-class/alert-strip";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface MerchantRow { id: string; merchant_code: string; stage: string; legal_name?: string; created_at?: string }
interface SubMidRow { id: string; sub_mid_code: string; kyc_status: string; settlement_enabled: boolean }
interface KybRow { id: string; status: string; merchant_id: string; opened_at: string }

const PIPELINE_STAGES = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"];

// Per-row "Get RRN" action on a no-RRN VPA credit. Raises an on-demand capture request;
// the merchant's agent then prompts/executes the Paytm Copy tap and the RRN fills in.
function CaptureRrnButton({ alertId }: { alertId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "requested" | "error">("idle");
  const label = state === "requested" ? "Requested ✓" : state === "loading" ? "Requesting…" : state === "error" ? "Retry" : "Get RRN";
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={state === "loading" || state === "requested"}
      onClick={async () => {
        setState("loading");
        try {
          const r = await fetch("/api/provider-portal/capture-rrn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ alert_id: alertId }),
          });
          setState(r.ok ? "requested" : "error");
        } catch { setState("error"); }
      }}
    >
      {label}
    </Button>
  );
}

export default function ProviderDashboard() {
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: MerchantRow[] },
  });
  const subMids = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { sub_mids: SubMidRow[] },
  });
  const commission = useQuery({
    queryKey: ["pp:commission"],
    queryFn: async () => (await fetch("/api/commission").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { mtd_earned: number; ytd_earned: number },
  });
  const kyb = useQuery({
    queryKey: ["pp:kyb"],
    queryFn: async () => (await fetch("/api/kyb").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { cases: KybRow[] },
  });
  const vpaTxns = useQuery({
    queryKey: ["pp:vpa-txns"],
    queryFn: async () => (await fetch("/api/provider-portal/vpa-transactions").then((r) => r.json())) as {
      totals?: { count: number; gross: number; confirmed: number; unmatched: number; missingRrn: number };
      recent?: Array<{ id: string; amount: number; utr: string | null; order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; matched_order_ref: string | null; outcome: string; bank: string | null; created_at: string }>;
    },
    refetchInterval: 30_000,
  });
  const txns = useQuery({
    queryKey: ["pp:txns"],
    queryFn: async () => (await fetch("/api/provider-portal/transactions").then((r) => r.json())) as {
      totals?: { gross: number; success_count: number; pending_count: number; total_count: number };
      recent?: Array<{ merchant_id: string; channel: string; method: string; status: string; amount: number; ref: string; created_at: string }>;
    },
    refetchInterval: 30_000,
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
        description="Your mapped branches, Sub-MID pipeline, KYB progress, and commission."
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
        <KpiTile label="Mapped branches" value={allMerchants.length} icon={Store} loading={merchants.isLoading} href="/provider-portal/merchants" />
        <KpiTile label="Branches live" value={liveCount} sublabel={`${inOnboarding} in onboarding`} icon={Store} variant={liveCount > 0 ? "success" : "default"} loading={merchants.isLoading} href="/provider-portal/merchants" />
        <KpiTile label="Sub-MIDs live" value={subMidsLive} sublabel={`${subMidsPending} pending KYC`} icon={Network} loading={subMids.isLoading} href="/provider-portal/sub-mids" />
        <KpiTile label="Open KYB cases" value={kybOpen} icon={FileCheck2} variant={kybOpen > 0 ? "warning" : "default"} loading={kyb.isLoading} />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Commission</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="MTD earned" value={formatAmount(commission.data?.mtd_earned ?? 0)} icon={Percent} loading={commission.isLoading} href="/provider-portal/commission" />
        <KpiTile label="YTD earned" value={formatAmount(commission.data?.ytd_earned ?? 0)} icon={Wallet} loading={commission.isLoading} href="/provider-portal/commission" />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Operations</h2>
      <ProviderCreateOrderCard />

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Transactions</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Gross collected" value={formatAmount(txns.data?.totals?.gross ?? 0)} sublabel={`${txns.data?.totals?.success_count ?? 0} successful`} icon={Wallet} variant="success" loading={txns.isLoading} href="/provider-portal/transactions" />
        <KpiTile label="Total transactions" value={txns.data?.totals?.total_count ?? 0} icon={Store} loading={txns.isLoading} href="/provider-portal/transactions" />
        <KpiTile label="Pending" value={txns.data?.totals?.pending_count ?? 0} icon={Activity} variant={(txns.data?.totals?.pending_count ?? 0) > 0 ? "warning" : "default"} loading={txns.isLoading} href="/provider-portal/transactions" />
        <KpiTile label="Branches with volume" value={new Set((txns.data?.recent ?? []).map((r) => r.merchant_id)).size} icon={Network} loading={txns.isLoading} href="/provider-portal/transactions" />
      </div>
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base">Recent transactions</CardTitle><CardDescription>Latest collections across your branches (all channels).</CardDescription></div>
          <Button variant="secondary" size="sm" asChild><Link href="/provider-portal/transactions">View all <ChevronRight className="h-3.5 w-3.5" /></Link></Button>
        </CardHeader>
        <CardContent>
          {(txns.data?.recent ?? []).length === 0
            ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">{txns.isLoading ? "Loading…" : "No transactions yet."}</div>
            : (
              <ol className="flex flex-col gap-2 text-sm">
                {(txns.data?.recent ?? []).slice(0, 10).map((r, i) => (
                  <li key={r.ref + i} className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <Badge variant="brand">{r.merchant_id}</Badge>
                    <span className="flex-1 truncate text-xs text-[color:var(--color-text-muted)]">{r.channel}{r.method ? ` · ${r.method}` : ""} · <span className="font-mono">{r.ref}</span></span>
                    <span className="tabular-nums font-medium">{formatAmount(r.amount)}</span>
                    <Badge variant={r.status === "SUCCESS" || r.status === "SUCCEEDED" ? "success" : r.status === "FAILED" || r.status === "EXPIRED" ? "danger" : "warning"}>{r.status}</Badge>
                    <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatDateTime(r.created_at)}</span>
                  </li>
                ))}
              </ol>
            )}
        </CardContent>
      </Card>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">VPA credit transactions</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile label="Total VPA credits" value={vpaTxns.data?.totals?.count ?? 0} icon={Wallet} loading={vpaTxns.isLoading} />
        <KpiTile label="Gross received" value={formatAmount(vpaTxns.data?.totals?.gross ?? 0)} icon={Wallet} variant="success" loading={vpaTxns.isLoading} />
        <KpiTile label="Confirmed" value={vpaTxns.data?.totals?.confirmed ?? 0} icon={Activity} variant="success" loading={vpaTxns.isLoading} />
        <KpiTile label="Unmatched" value={vpaTxns.data?.totals?.unmatched ?? 0} icon={Activity} variant={(vpaTxns.data?.totals?.unmatched ?? 0) > 0 ? "warning" : "default"} loading={vpaTxns.isLoading} />
        <KpiTile label="Missing RRN" value={vpaTxns.data?.totals?.missingRrn ?? 0} icon={Activity} variant={(vpaTxns.data?.totals?.missingRrn ?? 0) > 0 ? "warning" : "success"} loading={vpaTxns.isLoading} />
      </div>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">VPA credits</CardTitle>
          <CardDescription>Every UPI credit landing on your branches' settlement VPAs — payer, amount, UTR, and match.</CardDescription>
        </CardHeader>
        <CardContent>
          {(vpaTxns.data?.recent ?? []).length === 0
            ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">{vpaTxns.isLoading ? "Loading…" : "No VPA credits captured yet."}</div>
            : (
              <ol className="flex flex-col gap-2 text-sm">
                {(vpaTxns.data?.recent ?? []).slice(0, 12).map((r) => {
                  // RRN = the 12-digit UPI reference; UTR = any other all-digit bank ref.
                  const rrn = r.utr && /^\d{12}$/.test(r.utr) ? r.utr : null;
                  const utr = !rrn && r.utr && /^\d+$/.test(r.utr) ? r.utr : null;
                  // Order ID from the merged order_ref, the non-numeric utr (email standalone),
                  // or a matched Katana order — de-duped against whatever is already shown.
                  const utrOrderId = r.utr && !/^\d+$/.test(r.utr) ? r.utr : null;
                  const orderId = [r.order_ref, utrOrderId, r.matched_order_ref].find((v) => v && v !== r.utr) ?? null;
                  return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2">
                    <span className="tabular-nums font-semibold">{formatAmount(r.amount)}</span>
                    <span className="flex-1 truncate text-xs text-[color:var(--color-text-muted)]">
                      {r.payer_vpa ? <>from <span className="font-mono">{r.payer_vpa}</span> </> : null}
                      → <span className="font-mono">{r.payee_vpa}</span>
                      {rrn ? <> · RRN <span className="font-mono">{rrn}</span></> : null}
                      {utr ? <> · UTR <span className="font-mono">{utr}</span></> : null}
                      {orderId ? <> · Order ID <span className="font-mono">{orderId}</span></> : null}
                      {!rrn ? <> · <span className="text-[color:var(--color-warning,#b45309)]">no RRN</span></> : null}
                    </span>
                    <Badge variant={r.outcome === "CONFIRMED" ? "success" : r.outcome === "DUPLICATE" ? "danger" : "warning"}>{r.outcome}</Badge>
                    <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatDateTime(r.created_at)}</span>
                    {!rrn ? <CaptureRrnButton alertId={r.id} /> : null}
                  </li>
                  );
                })}
              </ol>
            )}
        </CardContent>
      </Card>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Katana Pay reconciliation</h2>
      <PaymentFunnel description="Live Katana Pay pay-ins across all your branches — created → reconciled." />

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Insights</h2>
      <ProviderCharts />

      {/* Onboarding pipeline funnel */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Onboarding funnel</CardTitle>
          <CardDescription>Where your branches are in the 6-stage pipeline.</CardDescription>
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
            <CardTitle className="text-base">Recent branches</CardTitle>
            <CardDescription>Most recent additions to your portfolio.</CardDescription>
          </CardHeader>
          <CardContent>
            {allMerchants.slice(0, 10).length === 0
              ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No branches mapped yet.</div>
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
              <Link href="/provider-portal/leads"><span className="inline-flex items-center gap-2"><Plus className="h-4 w-4" /> Submit new branch lead</span><ChevronRight className="h-3.5 w-3.5" /></Link>
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
