"use client";

// The top of a banker's page: where onboarding stands, and a row of status lights that answer
// "what can this banker do right now?". Each light opens the tab where that thing is set up.
//
// The queries reuse the cards' query keys with the same fetch and result shape, so the lights
// and the cards share one cache entry and update together.

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useLiveActivation } from "@/components/merchant/live-activation-card";
import { cn, formatAmount } from "@/lib/utils";

type Tone = "good" | "warn" | "bad" | "idle";

const TONE: Record<Tone, string> = {
  good: "var(--color-success)",
  warn: "var(--color-warning)",
  bad: "var(--color-danger)",
  idle: "var(--color-text-subtle)",
};

export interface JourneyStep { label: string; done: boolean }

/** Six onboarding steps as one segmented bar, with the current step named. */
export function JourneyBar({ steps, stage, action }: { steps: JourneyStep[]; stage: string; action?: React.ReactNode }) {
  const next = steps.findIndex((s) => !s.done);
  const stopped = stage === "REJECTED" || stage === "TERMINATED";
  const done = steps.filter((s) => s.done).length;
  const headline = stopped
    ? `Onboarding stopped: ${stage.toLowerCase()}`
    : next < 0 ? "Onboarding complete"
    : `Step ${next + 1} of ${steps.length}: ${steps[next].label}`;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("text-sm font-medium", stopped && "text-[color:var(--color-danger)]")}>{headline}</span>
          <span className="shrink-0 text-xs tabular-nums text-[color:var(--color-text-muted)]">{done}/{steps.length} done</span>
        </div>
        <ol className="mt-2 grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Onboarding steps">
          {steps.map((s, i) => {
            const current = i === next && !stopped;
            return (
              <li key={s.label} className="min-w-0" aria-current={current ? "step" : undefined}>
                <div
                  className={cn("h-1.5 rounded-full", current && "animate-pulse motion-reduce:animate-none")}
                  style={{
                    background: s.done ? "var(--color-success)"
                      : current ? "var(--color-brand)"
                      : stopped ? "var(--color-danger-muted)" : "var(--color-border)",
                  }}
                />
                <div className={cn(
                  "mt-1.5 hidden items-center gap-1 truncate text-[11px] md:flex",
                  s.done ? "text-[color:var(--color-text-muted)]" : current ? "font-medium text-[color:var(--color-text)]" : "text-[color:var(--color-text-subtle)]",
                )}>
                  {s.done && <Check className="h-3 w-3 shrink-0 text-[color:var(--color-success)]" />}
                  <span className="truncate">{s.label}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface Light { key: string; label: string; value: string; hint: string; tone: Tone; tab: string }

async function json<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d as T;
}

type GatewayStatus = { configured: boolean; gateway_name?: string; connector?: boolean; env?: "TEST" | "PROD" };

/** Status lights for one banker. `onOpen` switches to the tab named by the light. */
export function StatusLights({ merchantId, onOpen }: { merchantId: string; onOpen: (tab: string) => void }) {
  const orders = useQuery({
    queryKey: ["merchant", merchantId, "payin-orders"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-orders`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchant_code: string; live: { id: string }[]; all: { status: string; amount: number }[] };
    },
    refetchInterval: 10_000,
  });
  const payin = useQuery({
    queryKey: ["merchant", merchantId, "gateway-mid"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/gateway-mid`);
      if (r.status === 403) return { restricted: true as const };
      return json<{ status: GatewayStatus }>(r);
    },
  });
  const payout = useQuery({
    queryKey: ["merchant", merchantId, "payout-gateway"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payout-gateway`);
      if (r.status === 403) return { restricted: true as const };
      return json<{ status: GatewayStatus; webhook_url: string }>(r);
    },
  });
  const devices = useQuery({
    queryKey: ["merchant", merchantId, "devices"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/devices`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { devices: { online: boolean; permitted: boolean }[]; any_permitted: boolean; inboxes: unknown[] };
    },
    refetchInterval: 20_000,
  });
  const config = useQuery({
    queryKey: ["merchant", merchantId, "payment-config"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payment-config`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { poolpay?: { settlement_vpa?: string | null } };
    },
  });
  const live = useLiveActivation(merchantId);

  const all = orders.data?.all ?? [];
  const paid = all.filter((o) => o.status === "SUCCESS" || o.status === "SUCCEEDED");
  const collected = paid.reduce((s, o) => s + (o.amount ?? 0), 0);
  const active = orders.data?.live.length ?? 0;

  const gatewayLight = (q: typeof payin | typeof payout, key: string, label: string, fallback: string): Light => {
    const d = q.data as { restricted?: true; status?: GatewayStatus } | undefined;
    const s = d?.status;
    if (d?.restricted) return { key, label, value: "Super Admin only", hint: "", tone: "idle", tab: "gateways" };
    if (!s?.configured) return { key, label, value: fallback, hint: "No gateway connected", tone: "idle", tab: "gateways" };
    if (!s.connector) return { key, label, value: `${s.gateway_name}, not connected`, hint: "Saved, but Katana can't use it yet", tone: "warn", tab: "gateways" };
    return { key, label, value: s.gateway_name ?? "", hint: s.env === "PROD" ? "Live account" : "Sandbox account", tone: s.env === "PROD" ? "good" : "warn", tab: "gateways" };
  };

  const devs = devices.data?.devices ?? [];
  const onlineDevs = devs.filter((d) => d.online && d.permitted).length;
  const vpa = config.data?.poolpay?.settlement_vpa;
  const liveStatus = live.data?.status;

  const lights: Light[] = [
    {
      key: "money", label: "Collected", tab: "payments",
      value: formatAmount(collected, "INR"),
      hint: `${paid.length} paid of ${all.length} payment${all.length === 1 ? "" : "s"}${active ? `, ${active} open` : ""}`,
      tone: paid.length ? "good" : "idle",
    },
    gatewayLight(payin, "payin", "Pay-ins", "Katana UPI route"),
    gatewayLight(payout, "payout", "Payouts", "Paid by hand"),
    {
      key: "vpa", label: "Settlement UPI ID", tab: "collection",
      value: vpa || "Not set",
      hint: vpa ? "Payments are credited here" : "Captured payments can't be credited",
      tone: vpa ? "good" : "bad",
    },
    {
      key: "agent", label: "Agent phone", tab: "collection",
      value: !devs.length ? "Not installed" : onlineDevs ? `${onlineDevs} online` : "Offline",
      hint: !devs.length ? "Install the agent to confirm payments" : devices.data?.any_permitted ? `${devs.length} enrolled` : "Waiting for permissions",
      tone: !devs.length ? "warn" : onlineDevs ? "good" : "bad",
    },
    {
      key: "live", label: "Live mode", tab: "developer",
      value: liveStatus === "ACTIVATED" ? "On" : liveStatus === "REQUESTED" ? "Awaiting approval" : liveStatus === "REJECTED" ? "Not approved" : "Off",
      hint: liveStatus === "ACTIVATED" ? "Real payments allowed" : liveStatus === "REQUESTED" ? "Review the request" : "Test payments only",
      tone: liveStatus === "ACTIVATED" ? "good" : liveStatus === "REQUESTED" ? "warn" : liveStatus === "REJECTED" ? "bad" : "idle",
    },
  ];

  const loading = orders.isLoading || payin.isLoading || payout.isLoading || devices.isLoading || config.isLoading || live.isLoading;

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border bg-[color:var(--color-surface)] md:grid-cols-3 xl:grid-cols-6">
      {lights.map((l) => (
        <button
          key={l.key}
          type="button"
          onClick={() => onOpen(l.tab)}
          className="group relative -mb-px -mr-px min-w-0 border-b border-r p-3 text-left transition-colors hover:bg-[color:var(--color-surface-muted)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--color-brand)]"
        >
          <span className="flex items-center gap-1.5 text-xs text-[color:var(--color-text-muted)]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: loading ? "var(--color-border)" : TONE[l.tone], boxShadow: !loading && l.tone !== "idle" ? `0 0 0 3px color-mix(in srgb, ${TONE[l.tone]} 22%, transparent)` : undefined }}
              aria-hidden
            />
            {l.label}
          </span>
          <span className="mt-1.5 block truncate text-sm font-semibold" title={l.value}>
            {loading ? <span className="inline-block h-4 w-20 animate-pulse rounded bg-[color:var(--color-surface-muted)]" /> : l.value}
          </span>
          <span className="mt-0.5 block truncate text-xs text-[color:var(--color-text-subtle)] group-hover:text-[color:var(--color-text-muted)]" title={l.hint}>
            {loading ? " " : l.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
