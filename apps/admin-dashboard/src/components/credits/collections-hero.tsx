"use client";

// THE BANKER DASHBOARD LED WITH THE WRONG MONEY.
//
// Every KPI on it is built from gateway orders — checkout_orders and vendor_payin_orders. For a
// banker collecting on a UPI QR that is permanently zero: on 2026-08-22 GUFFI-01 took 535
// payments worth Rs9,71,707 and the dashboard showed Rs0.00, 0 txns, no success rate. The page
// was not broken, it was measuring a rail this merchant does not use, and a screen of zeros is
// indistinguishable from a business that has stopped.
//
// So the collections come first, in the shape the agent's own home screen settled on: the count
// leads, because a figure that climbs is the only thing that cannot look healthy while capture
// is dead. The gateway tiles keep their place below for bankers who do use checkout.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { formatAmount } from "@/lib/utils";

interface Device {
  online: boolean; rrn_capture_ready: boolean; capture_apps: string;
  auto_capture: boolean | null;
  screen_state?: "stays_awake" | "may_sleep" | "overlay_missing" | "unplugged" | "unknown";
}

interface CreditsResponse {
  credits: Array<{ event_time: string | null; created_at: string }>;
  summary: {
    today_count: number;
    today_verified_amount?: number;
    today_awaiting_count?: number;
    today_awaiting_amount?: number;
  };
}

function ago(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Tile({ label, value, tone = "default", href }: {
  label: string; value: string; tone?: "default" | "success" | "warning" | "danger"; href?: string;
}) {
  const colour =
    tone === "success" ? "text-[color:var(--color-success)]"
    : tone === "warning" ? "text-[color:var(--color-warning)]"
    : tone === "danger" ? "text-[color:var(--color-danger)]"
    : "text-[color:var(--color-text)]";
  const body = (
    <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-2,transparent)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]">{label}</div>
      <div className={`mt-1 truncate text-sm font-medium ${colour}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href} className="block transition-opacity hover:opacity-80">{body}</Link> : body;
}

export function CollectionsHero() {
  // Ticks so "2m ago" actually moves; a frozen relative time is worse than none.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const creditsQ = useQuery({
    queryKey: ["mp:credits"],   // shared with /transactions — one fetch serves both
    queryFn: async () => (await fetch("/api/banker-portal/credits").then((r) => r.json())) as CreditsResponse,
    refetchInterval: 15_000,
  });
  const agentQ = useQuery({
    queryKey: ["mp:agent-strip"],
    queryFn: async () => (await fetch("/api/banker-portal/agent").then((r) => r.json())) as { devices: Device[] },
    refetchInterval: 30_000,
  });

  const s = creditsQ.data?.summary;
  const count = s?.today_count ?? 0;
  const verified = s?.today_verified_amount ?? 0;
  const awaitingN = s?.today_awaiting_count ?? 0;
  const awaitingAmt = s?.today_awaiting_amount ?? 0;

  const first = creditsQ.data?.credits?.[0];
  const lastAt = first?.event_time ?? first?.created_at ?? null;

  const devices = agentQ.data?.devices ?? [];
  const d = devices.find((x) => x.online && x.rrn_capture_ready) ?? devices.find((x) => x.online) ?? devices[0];
  const capturing = !!d?.online && !!d?.rrn_capture_ready;
  const sleeps = d?.screen_state === "may_sleep" || d?.screen_state === "overlay_missing";

  // The state names itself, exactly as the phone does — the two screens should never disagree.
  const state =
    !d ? "NO COLLECTION PHONE"
    : !d.online ? "PHONE OFFLINE"
    : !d.capture_apps ? "NO PAYMENT APP SELECTED"
    : d.auto_capture === false ? "AUTO-CAPTURE OFF"
    : "CAPTURING";
  const tone = !d || !d.online ? "danger" : !capturing || sleeps ? "warning" : "success";
  const pill =
    tone === "success" ? "text-[color:var(--color-success)] bg-[color:var(--color-success)]/10"
    : tone === "warning" ? "text-[color:var(--color-warning)] bg-[color:var(--color-warning)]/10"
    : "text-[color:var(--color-danger)] bg-[color:var(--color-danger)]/10";
  const dot =
    tone === "success" ? "bg-[color:var(--color-success)]"
    : tone === "warning" ? "bg-[color:var(--color-warning)]"
    : "bg-[color:var(--color-danger)]";

  return (
    <Card className="mb-6">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold tracking-wider ${pill}`}>
            <span className="relative flex h-2 w-2">
              {tone === "success" && (
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dot} opacity-60`} />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
            </span>
            {state}
          </span>
          {d?.capture_apps && (
            <span className="text-xs text-[color:var(--color-text-subtle)]">· {d.capture_apps}</span>
          )}
        </div>

        {/* THE NUMBER. Same decision as the agent's home screen: a count that climbs is the only
            figure that cannot be green while collection is dead. */}
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3">
          <span className="text-5xl font-bold leading-none tracking-tight">{count}</span>
          <span className="text-sm text-[color:var(--color-text-muted)]">
            {count === 1 ? "payment collected today" : "payments collected today"}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-[color:var(--color-success)]">{formatAmount(verified)} verified</span>
          {lastAt && (
            <span className="text-[color:var(--color-text-subtle)]">
              · last {new Date(lastAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })} · {ago(+new Date(lastAt), now)}
            </span>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Tile label="Verified" value={formatAmount(verified)} tone="success" href="/banker-portal/transactions" />
          {/* Named, never folded into the day's takings: a credit with no RRN is a claim the
              phone made, not money the network has confirmed. */}
          <Tile
            label="Awaiting RRN"
            value={awaitingN > 0 ? `${formatAmount(awaitingAmt)} (${awaitingN})` : "none"}
            tone={awaitingN > 0 ? "warning" : "default"}
            href="/banker-portal/transactions"
          />
          <Tile
            label="Collection phone"
            value={!d ? "not enrolled" : !d.online ? "offline" : sleeps ? "screen can sleep" : d.screen_state === "unplugged" ? "on battery" : "online"}
            tone={!d || !d.online ? "danger" : sleeps || d.screen_state === "unplugged" ? "warning" : "success"}
          />
          <Tile label="Reading" value={d?.capture_apps || "none selected"} tone={d?.capture_apps ? "default" : "warning"} />
        </div>

        {/* Only said when the phone claims to be fine AND nothing has landed for a while — a
            quiet half-hour is normal, and false alarms train people to ignore the real one. */}
        {capturing && lastAt && (now - +new Date(lastAt)) / 60000 > 20 && (
          <p className="mt-3 text-xs text-[color:var(--color-warning)]">
            Nothing collected for {Math.round((now - +new Date(lastAt)) / 60000)} minutes — check the
            collection phone still has the payment app open on screen.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
