"use client";

// Flow health monitor (/flows/health): every banker × Intent, P2P and payout. A tile is red when
// over 10% of the last hour's ended orders failed (10 orders or more that hour) or over 500
// payouts wait (lib/flow-dashboards tileTone). A tile opens that flow's page for the banker.

import Link from "next/link";
import { AlertTriangle, HeartPulse } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { pctText, type Tone } from "@/lib/flow-dashboards";
import type { Flow, HealthGrid, Tile } from "@/lib/flow-dashboards-health";
import { Skeleton } from "./intent-dashboard";
import { BankerLink, CsvButton, ErrorNote, FlowToolbar, Section, StateBadge, TONE_COLOR, useFlowData, useFlowParams } from "./shared";

const FLOW_LABEL: Record<Flow, string> = { INTENT: "Intent", P2P: "P2P", PAYOUT: "Payout" };
const FLOW_PATH: Record<Flow, string> = { INTENT: "/flows/intent", P2P: "/flows/p2p", PAYOUT: "/flows/payout" };
const TONE_WORD: Record<Tone, string> = { good: "OK", warn: "Watch", bad: "Problem", none: "Idle" };

function TileBox({ flow, t, code, mode }: { flow: Flow; t: Tile; code: string; mode: string | null }) {
  const qs = new URLSearchParams({ banker: code, ...(mode ? { mode } : {}) });
  const color = TONE_COLOR[t.tone];
  return (
    <Link href={`${FLOW_PATH[flow]}?${qs}`} title={t.reason ?? `${FLOW_LABEL[flow]}: ${TONE_WORD[t.tone]}`}
      className="block rounded-xl border p-2 text-xs transition-colors hover:border-[color:var(--color-brand)]"
      style={{ background: t.tone === "none" ? undefined : `color-mix(in oklab, ${color} 12%, transparent)`, borderColor: t.tone === "bad" ? color : undefined }}>
      <div className="flex items-center justify-between font-medium">
        <span style={{ color: t.tone === "none" ? "var(--color-text-muted)" : color }}>{TONE_WORD[t.tone]}</span>
        <span className="tabular-nums text-[color:var(--color-text-muted)]">{pctText(t.success_24h)}</span>
      </div>
      <div className="mt-1 tabular-nums text-[color:var(--color-text-muted)]">
        {t.orders_1h} in 1h · {t.failed_1h} failed{flow === "PAYOUT" ? ` · ${t.queue ?? 0} waiting` : ""}
      </div>
    </Link>
  );
}

export function FlowHealthDashboard() {
  const p = useFlowParams();
  const q = useFlowData<HealthGrid>("health", p.mode, p.banker);
  const d = q.data;
  const flows: Flow[] = ["INTENT", "P2P", "PAYOUT"];

  return (
    <>
      <PageHeader title="Flow health" icon={HeartPulse}
        description="Every active banker across Intent, P2P and payouts. Red: over 10% failed in the last hour with 10 orders or more, or over 500 payouts waiting. Click a tile to open that flow for the banker." />
      <FlowToolbar livemode={d?.livemode} banker={p.banker} asOf={d?.as_of} fetching={q.isFetching}
        onMode={p.setMode} onClearBanker={() => p.setBanker(null)}
        links={[{ href: "/flows/intent", label: "Intent" }, { href: "/flows/p2p", label: "P2P" }, { href: "/flows/payout", label: "Payouts" }, { href: "/gateway-health", label: "Gateway health" }]} />
      <ErrorNote error={q.error} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Problems" value={d?.counts.bad ?? "—"} variant={d?.counts.bad ? "danger" : "default"} loading={q.isLoading} />
        <KpiTile label="Watch" value={d?.counts.warn ?? "—"} variant={d?.counts.warn ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="OK" value={d?.counts.good ?? "—"} variant="success" loading={q.isLoading} />
        <KpiTile label="Bankers" value={d?.rows.length ?? "—"} sublabel="active in 24h or with payouts waiting" loading={q.isLoading} />
      </div>

      {(d?.alerts.length ?? 0) > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-[color:var(--color-danger)]"><AlertTriangle className="h-4 w-4" /> {d!.alerts.length} flow{d!.alerts.length === 1 ? "" : "s"} need attention</div>
          <ul className="mt-1 space-y-0.5">
            {d!.alerts.map((a) => (
              <li key={a.code + a.flow}>
                <Link className="font-medium hover:underline" href={`${FLOW_PATH[a.flow]}?banker=${encodeURIComponent(a.code)}${p.mode ? `&mode=${p.mode}` : ""}`}>{a.name} · {FLOW_LABEL[a.flow]}</Link>: {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Bankers × flows" description="Tile: state, success over 24 hours, the last hour's orders and failures."
        action={<CsvButton filename={`flow-health-${d?.livemode === false ? "test" : "live"}.csv`}
          headers={["banker_code", "banker", "merchant", "status", ...flows.flatMap((f) => [`${f.toLowerCase()}_state`, `${f.toLowerCase()}_orders_1h`, `${f.toLowerCase()}_failed_1h`, `${f.toLowerCase()}_orders_24h`, `${f.toLowerCase()}_success_24h_pct`]), "payout_waiting"]}
          rows={(d?.rows ?? []).map((r) => [r.code, r.name, r.provider_name, r.state,
            ...flows.flatMap((f) => { const t = r.tiles[f]; return [TONE_WORD[t.tone], t.orders_1h, t.failed_1h, t.orders_24h, t.success_24h == null ? null : Math.round(t.success_24h * 1000) / 10]; }),
            r.tiles.PAYOUT.queue ?? 0])} />}>
        {q.isLoading ? <Skeleton /> : !d?.rows.length ? (
          <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No banker took a pay-in or payout in the last 24 hours, and no payout is waiting.</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[640px] grid-cols-[minmax(12rem,1.3fr)_repeat(3,minmax(9rem,1fr))] gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-muted)]">Banker</div>
              {flows.map((f) => <div key={f} className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-muted)]">{FLOW_LABEL[f]}</div>)}
              {d.rows.map((r) => (
                <div key={r.code} className="contents">
                  <div className="flex flex-col justify-center gap-0.5 text-sm">
                    <BankerLink id={r.id} name={r.name} code={r.code} />
                    <span className="flex items-center gap-1 text-xs text-[color:var(--color-text-muted)]">{r.provider_name ?? ""} <StateBadge state={r.state} /></span>
                  </div>
                  {flows.map((f) => <TileBox key={f} flow={f} t={r.tiles[f]} code={r.code} mode={p.mode} />)}
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </>
  );
}
