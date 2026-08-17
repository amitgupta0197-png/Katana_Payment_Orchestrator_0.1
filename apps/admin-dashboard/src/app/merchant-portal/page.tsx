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
import { CreditDetail, hasCreditDetail } from "@/components/credits/credit-detail";
import { verificationLabel, verificationVariant, type CreditVerification } from "@/lib/credit-verification";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface MerchantRow { id: string; merchant_code: string; stage: string; legal_name?: string; created_at?: string }
interface SubMidRow { id: string; sub_mid_code: string; kyc_status: string; settlement_enabled: boolean }
interface KybRow { id: string; status: string; merchant_id: string; opened_at: string }

const PIPELINE_STAGES = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"];

/** Credits shown before the list has to be expanded — enough to fill a screen, not a page. */
const VPA_PREVIEW = 12;

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
          const r = await fetch("/api/merchant-portal/capture-rrn", {
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
  // Banker-code filter. Credits are tagged with the banker code configured in the capturing
  // device's Katana agent; branches can share a settlement VPA, so this code is the only
  // reliable way to separate one banker's traffic from another's.
  const [vpaBranch, setVpaBranch] = useState<string>("");
  // Id of the VPA credit whose full payment detail is expanded, or null.
  const [vpaDetailOf, setVpaDetailOf] = useState<string | null>(null);
  // Opens showing every captured credit. It used to open at 12 with the rest behind a
  // button, which put a different number on the list than on the tile above it.
  const [showAllVpa, setShowAllVpa] = useState(true);
  const vpaTxns = useQuery({
    queryKey: ["pp:vpa-txns", vpaBranch],
    queryFn: async () => (await fetch(`/api/merchant-portal/vpa-transactions${vpaBranch ? `?branch=${encodeURIComponent(vpaBranch)}` : ""}`).then((r) => r.json())) as {
      totals?: { count: number; gross: number; confirmed: number; unmatched: number; missingRrn: number; verified: number; awaitingRrn: number; vpaMismatch: number; verifiedAmount?: number; awaitingAmount?: number; mismatchAmount?: number; settledCount?: number; settled?: number };
      recent?: Array<{ id: string; amount: number; utr: string | null; order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; matched_order_ref: string | null; outcome: string; bank: string | null; created_at: string; payer_name: string | null; details: Record<string, string> | null; verification?: CreditVerification }>;
      /** Payouts from the payment app into the bank account — the same money as the credits
       *  above, one leg later. Listed on its own and counted in no collection total. */
      settlements?: Array<{ id: string; amount: number; payee_vpa: string | null; created_at: string; source: string }>;
      branches?: string[];
      /** True when older credits exist beyond the returned window. */
      truncated?: boolean;
    },
    refetchInterval: 30_000,
  });
  const txns = useQuery({
    queryKey: ["pp:txns"],
    queryFn: async () => (await fetch("/api/merchant-portal/transactions").then((r) => r.json())) as {
      totals?: { gross: number; success_count: number; pending_count: number; total_count: number };
      recent?: Array<{ merchant_id: string; channel: string; method: string; status: string; amount: number; ref: string; created_at: string }>;
    },
    refetchInterval: 30_000,
  });

  // DT position: USDT advanced to us, and how much we have repaid in pay-in traffic.
  // Absent (population: null) for merchants with no DT lots assigned — the tiles hide.
  const dt = useQuery({
    queryKey: ["merchant-portal", "dt-population"],
    queryFn: async () => (await fetch("/api/merchant-portal/dt-population").then((r) => r.json())) as {
      merchant_code?: string;
      population: null | {
        advanced: number; allocated: number; consumed: number; outstanding: number;
        unallocated_amount: number; unallocated_count: number; payin_count: number; pct_repaid: number | null;
      };
    },
    refetchInterval: 60_000,
  });
  const pop = dt.data?.population ?? null;

  const allMerchants = merchants.data?.merchants ?? [];
  // Every credit the API returned. The KPI tiles above the list are computed from this same
  // set, so the list must be able to show all of it — see the Show all control below.
  const vpaCredits = vpaTxns.data?.recent ?? [];
  // Settlement legs: the payment app paying its held balance into the bank account. Kept out
  // of the credit list and every total above — it is the same money as those credits, one leg
  // later — and shown below so the movement is still on the record.
  const vpaSettlements = vpaTxns.data?.settlements ?? [];
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
    alerts.push({ level: "warning", title: `${subMidsPending} Sub-MID request${subMidsPending > 1 ? "s" : ""} pending KYC`, detail: "Your Sub-MIDs are blocked until docs are verified.", href: "/merchant-portal/sub-mids", cta: "Open" });
  if (kybOpen > 0)
    alerts.push({ level: "info", title: `${kybOpen} merchant KYB case${kybOpen > 1 ? "s" : ""} in progress`, href: "/merchant-portal/merchants", cta: "Track" });
  const stuckEarly = allMerchants.filter((m) => m.stage === "APPLICATION" || m.stage === "DOCS_PENDING");
  if (stuckEarly.length > 2)
    alerts.push({ level: "info", title: `${stuckEarly.length} merchants stuck pre-screening`, detail: "Push docs or escalate to ops.", href: "/merchant-portal/merchants" });

  return (
    <>
      <PageHeader
        title="Merchant dashboard"
        description="Your mapped bankers, Sub-MID pipeline, KYB progress, and commission."
        icon={LayoutDashboard}
        actions={<Badge variant={merchants.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>}
      />

      {alerts.length > 0 && (
        <div className="mb-6">
          <AlertStrip items={alerts.slice(0, 5)} />
        </div>
      )}

      {/* DT position — only for merchants carrying a USDT advance. Katana advances USDT;
          this is how much of it has been repaid in incoming pay-in population. */}
      {pop && pop.allocated > 0 && (
        <>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
            Pay-in population {pop.pct_repaid !== null && <span className="normal-case text-[color:var(--color-text-subtle)]">· {pop.pct_repaid}% repaid</span>}
          </h2>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Advance carried" value={formatAmount(pop.advanced)} loading={dt.isLoading} />
            <KpiTile label="Population sent" value={formatAmount(pop.consumed)} variant="success" loading={dt.isLoading} />
            <KpiTile label="Still to send" value={formatAmount(pop.outstanding)} loading={dt.isLoading} />
            <KpiTile
              label="Pay-ins counted"
              value={pop.payin_count}
              sublabel={pop.unallocated_count ? `${pop.unallocated_count} unallocated` : undefined}
              variant={pop.unallocated_count ? "warning" : "default"}
              loading={dt.isLoading}
            />
          </div>
        </>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Portfolio</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Mapped bankers" value={allMerchants.length} icon={Store} loading={merchants.isLoading} href="/merchant-portal/merchants" />
        <KpiTile label="Bankers live" value={liveCount} sublabel={`${inOnboarding} in onboarding`} icon={Store} variant={liveCount > 0 ? "success" : "default"} loading={merchants.isLoading} href="/merchant-portal/merchants" />
        <KpiTile label="Sub-MIDs live" value={subMidsLive} sublabel={`${subMidsPending} pending KYC`} icon={Network} loading={subMids.isLoading} href="/merchant-portal/sub-mids" />
        <KpiTile label="Open KYB cases" value={kybOpen} icon={FileCheck2} variant={kybOpen > 0 ? "warning" : "default"} loading={kyb.isLoading} />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Commission</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="MTD earned" value={formatAmount(commission.data?.mtd_earned ?? 0)} icon={Percent} loading={commission.isLoading} href="/merchant-portal/commission" />
        <KpiTile label="YTD earned" value={formatAmount(commission.data?.ytd_earned ?? 0)} icon={Wallet} loading={commission.isLoading} href="/merchant-portal/commission" />
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Operations</h2>
      <ProviderCreateOrderCard />

      {/* API-based order generation — the merchant's own site calls the order API and hosts/redirects the checkout. */}
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Merchant Hosted Checkout</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Gross collected" value={formatAmount(txns.data?.totals?.gross ?? 0)} sublabel={`${txns.data?.totals?.success_count ?? 0} successful`} icon={Wallet} variant="success" loading={txns.isLoading} href="/merchant-portal/transactions" />
        <KpiTile label="Total transactions" value={txns.data?.totals?.total_count ?? 0} icon={Store} loading={txns.isLoading} href="/merchant-portal/transactions" />
        <KpiTile label="Pending" value={txns.data?.totals?.pending_count ?? 0} icon={Activity} variant={(txns.data?.totals?.pending_count ?? 0) > 0 ? "warning" : "default"} loading={txns.isLoading} href="/merchant-portal/transactions" />
        <KpiTile label="Bankers with volume" value={new Set((txns.data?.recent ?? []).map((r) => r.merchant_id)).size} icon={Network} loading={txns.isLoading} href="/merchant-portal/transactions" />
      </div>
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base">Recent transactions</CardTitle><CardDescription>API order generation — latest collections across your branches (all channels).</CardDescription></div>
          <Button variant="secondary" size="sm" asChild><Link href="/merchant-portal/transactions">View all <ChevronRight className="h-3.5 w-3.5" /></Link></Button>
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

      {/* Non-API flow — the payer pays a settlement VPA directly; the gateway hosts/reconciles the collection. */}
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Gateway Hosted Checkout</h2>
      {/* MONEY PROVEN, MONEY CLAIMED — reported side by side, never added together. A credit
          with no RRN is only a claim: the phone saw a notification, and the UPI network has not
          corroborated it yet. It used to be inside "Gross received", which presented unproven
          money as banked money and made the total creep for reasons no single payment explained.
          The received tile now counts only what an RRN (or a confirmed order match) proves;
          everything still being proved is its own tile. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Total VPA credits"
          value={vpaTxns.data?.totals?.count ?? 0}
          sublabel={`${formatAmount(vpaTxns.data?.totals?.gross ?? 0)} all-in`}
          icon={Wallet}
          loading={vpaTxns.isLoading}
        />
        {/* Verified, not "confirmed". A direct VPA collection never has a Katana order to be
            confirmed against — what proves it is the UPI network's own 12-digit RRN. */}
        <KpiTile
          label="Received · RRN verified"
          value={formatAmount(vpaTxns.data?.totals?.verifiedAmount ?? 0)}
          sublabel={`${vpaTxns.data?.totals?.verified ?? 0} credits proven`}
          icon={Wallet}
          variant="success"
          loading={vpaTxns.isLoading}
        />
        <KpiTile
          label="Awaiting RRN"
          value={formatAmount(vpaTxns.data?.totals?.awaitingAmount ?? 0)}
          sublabel={`${vpaTxns.data?.totals?.awaitingRrn ?? 0} credits · not in Received`}
          icon={Activity}
          variant={(vpaTxns.data?.totals?.awaitingRrn ?? 0) > 0 ? "warning" : "default"}
          loading={vpaTxns.isLoading}
        />
        <KpiTile
          label="VPA mismatch"
          value={vpaTxns.data?.totals?.vpaMismatch ?? 0}
          sublabel={(vpaTxns.data?.totals?.vpaMismatch ?? 0) > 0 ? `${formatAmount(vpaTxns.data?.totals?.mismatchAmount ?? 0)} · not in Received` : "none"}
          icon={Activity}
          variant={(vpaTxns.data?.totals?.vpaMismatch ?? 0) > 0 ? "danger" : "success"}
          loading={vpaTxns.isLoading}
        />
      </div>
      <Card className="mb-6">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">VPA credits</CardTitle>
              <CardDescription>Non-API collections — every UPI credit landing on your branches' settlement VPAs: payer, amount, UTR, and match.</CardDescription>
            </div>
            {(vpaTxns.data?.branches ?? []).length > 1 && (
              <select
                aria-label="Filter by banker code"
                className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm"
                value={vpaBranch}
                onChange={(e) => setVpaBranch(e.target.value)}
              >
                <option value="">All banker codes</option>
                {(vpaTxns.data?.branches ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {vpaCredits.length === 0
            ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">{vpaTxns.isLoading ? "Loading…" : "No VPA credits captured yet."}</div>
            : (
              // A long list scrolls inside the card rather than pushing the rest of the
              // dashboard off the page.
              <ol className={`flex flex-col gap-2 text-sm ${showAllVpa && vpaCredits.length > VPA_PREVIEW ? "max-h-[70vh] overflow-y-auto pr-1" : ""}`}>
                {(showAllVpa ? vpaCredits : vpaCredits.slice(0, VPA_PREVIEW)).map((r) => {
                  // RRN = the 12-digit UPI reference; UTR = any other all-digit bank ref.
                  const rrn = r.utr && /^\d{12}$/.test(r.utr) ? r.utr : null;
                  const utr = !rrn && r.utr && /^\d+$/.test(r.utr) ? r.utr : null;
                  // Order ID from the merged order_ref, the non-numeric utr (email standalone),
                  // or a matched Katana order — de-duped against whatever is already shown.
                  const utrOrderId = r.utr && !/^\d+$/.test(r.utr) ? r.utr : null;
                  const orderId = [r.order_ref, utrOrderId, r.matched_order_ref].find((v) => v && v !== r.utr) ?? null;
                  const expanded = vpaDetailOf === r.id;
                  return (
                  <li key={r.id} className="rounded-md border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="tabular-nums font-semibold">{formatAmount(r.amount)}</span>
                      <span className="flex-1 truncate text-xs text-[color:var(--color-text-muted)]">
                        {/* The payer's NAME when the capture gave us one — a name is what the
                            person reading this recognises; the VPA is the fallback. */}
                        {r.payer_name ? <>from <span className="font-medium text-[color:var(--color-text)]">{r.payer_name}</span> </>
                          : r.payer_vpa ? <>from <span className="font-mono">{r.payer_vpa}</span> </> : null}
                        → <span className="font-mono">{r.payee_vpa}</span>
                        {rrn ? <> · RRN <span className="font-mono">{rrn}</span></> : null}
                        {utr ? <> · UTR <span className="font-mono">{utr}</span></> : null}
                        {orderId ? <> · Order ID <span className="font-mono">{orderId}</span></> : null}
                        {!rrn ? <> · <span className="text-[color:var(--color-warning,#b45309)]">no RRN</span></> : null}
                      </span>
                      {(() => {
                        const v = r.verification ?? (r.outcome === "CONFIRMED" ? "matched" : "awaiting");
                        return <Badge variant={verificationVariant(v)}>{verificationLabel(v)}</Badge>;
                      })()}
                      <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatDateTime(r.created_at)}</span>
                      {hasCreditDetail(r.details) ? (
                        <button
                          type="button"
                          onClick={() => setVpaDetailOf(expanded ? null : r.id)}
                          aria-expanded={expanded}
                          className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-surface-muted)]"
                        >
                          {expanded ? "Hide" : "Details"}
                        </button>
                      ) : null}
                      {!rrn ? <CaptureRrnButton alertId={r.id} /> : null}
                    </div>
                    {/* Everything shown is already on the row, so expanding costs no fetch. */}
                    {expanded && (
                      <div className="mt-2 border-t border-[color:var(--color-border)] pt-2">
                        <CreditDetail details={r.details} />
                      </div>
                    )}
                  </li>
                  );
                })}
              </ol>
            )}
          {/* The card used to cut the list at 12 with nothing said, so the tile above it
              ("18") and the rows below it disagreed and the missing credits looked lost.
              Say what is hidden and let it be opened. */}
          {vpaCredits.length > VPA_PREVIEW && (
            <div className="mt-3 flex items-center justify-center gap-3 border-t border-[color:var(--color-border)] pt-3">
              <span className="text-xs text-[color:var(--color-text-muted)]">
                Showing {showAllVpa ? vpaCredits.length : VPA_PREVIEW} of {vpaCredits.length}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setShowAllVpa(!showAllVpa)}>
                {showAllVpa ? "Show fewer" : `Show all ${vpaCredits.length}`}
              </Button>
            </div>
          )}
          {vpaTxns.data?.truncated && (
            <p className="mt-2 text-center text-xs text-[color:var(--color-text-muted)]">
              Showing the most recent {vpaCredits.length} credits — older ones exist.
              Use <Link href="/merchant-portal/statements" className="underline">Statements</Link> for a full period.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Settled to bank. These used to appear in the list above as extra "awaiting RRN"
          credits, which stated the same takings twice — a ₹40,006 settlement of a ₹40,000 and
          a ₹6 collection read as ₹40,006 of new money. They are their own thing: the payment
          app moving money it already holds into the bank account. Worth seeing (it is the proof
          the collections landed), never worth counting. */}
      {vpaSettlements.length > 0 && (
        <Card className="mb-6 border-dashed">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base text-[color:var(--color-text-muted)]">Settled to bank</CardTitle>
                <CardDescription>
                  The payment app paying collected money into the bank account — the same money as the credits
                  above, one leg later. <b>Not counted</b> in any total.
                </CardDescription>
              </div>
              <Badge variant="default" className="shrink-0 whitespace-nowrap">
                {formatAmount(vpaTxns.data?.totals?.settled ?? 0)} · {vpaSettlements.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <ol className={`flex flex-col gap-2 text-sm ${vpaSettlements.length > VPA_PREVIEW ? "max-h-[40vh] overflow-y-auto pr-1" : ""}`}>
              {vpaSettlements.map((r) => (
                <li key={r.id} className="rounded-md border border-dashed px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="tabular-nums font-semibold">{formatAmount(r.amount)}</span>
                    <span className="flex-1 truncate text-xs text-[color:var(--color-text-muted)]">
                      settled to bank account{r.payee_vpa ? <> · <span className="font-mono">{r.payee_vpa}</span></> : null}
                    </span>
                    <Badge variant="default">settlement</Badge>
                    <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatDateTime(r.created_at)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Katana Pay reconciliation</h2>
      <PaymentFunnel description="Live Katana Pay pay-ins across all your bankers — created → reconciled." />

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Insights</h2>
      <ProviderCharts />

      {/* Onboarding pipeline funnel */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Onboarding funnel</CardTitle>
          <CardDescription>Where your bankers are in the 6-stage pipeline.</CardDescription>
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
            <CardTitle className="text-base">Recent bankers</CardTitle>
            <CardDescription>Most recent additions to your portfolio.</CardDescription>
          </CardHeader>
          <CardContent>
            {allMerchants.slice(0, 10).length === 0
              ? <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No bankers mapped yet.</div>
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
              <Link href="/merchant-portal/leads"><span className="inline-flex items-center gap-2"><Plus className="h-4 w-4" /> Submit new banker lead</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/sub-mids"><span className="inline-flex items-center gap-2"><Network className="h-4 w-4" /> Request a Sub-MID</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/kyc"><span className="inline-flex items-center gap-2"><FileCheck2 className="h-4 w-4" /> Upload KYC docs</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <Button variant="secondary" asChild className="justify-between">
              <Link href="/merchant-portal/commission"><span className="inline-flex items-center gap-2"><Percent className="h-4 w-4" /> Commission statement</span><ChevronRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
