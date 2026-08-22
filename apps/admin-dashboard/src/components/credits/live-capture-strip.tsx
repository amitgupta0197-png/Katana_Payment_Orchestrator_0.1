"use client";

// IS THE MONEY STILL ARRIVING? — the one question this screen exists to answer.
//
// The credit feed already refetched every fifteen seconds, but nothing on the page SAID so, and
// its only timestamp ("last 22 Aug 2026, 18:19") reads like page staleness rather than the
// newest payment. On 2026-08-22 that cost two false alarms: capture was working the whole time
// and the operator could not tell, because "the number stopped going up" is exactly what a dead
// agent looks like too. This strip separates the two questions it was conflating —
//
//   is the PAGE live?    a ticking "updated Ns ago" against the last successful fetch
//   is the AGENT live?   the phone's own state, and how long since the last payment
//
// — so a quiet stretch reads as a quiet stretch, and a broken phone reads as a broken phone.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface Device {
  device_id: string;
  online: boolean;
  permitted: boolean;
  rrn_capture_ready: boolean;
  capture_apps: string;
  auto_capture: boolean | null;
  screen_state?: "stays_awake" | "may_sleep" | "overlay_missing" | "unplugged" | "unknown";
  last_heartbeat: string | null;
}

/** "4s" / "12m" / "3h" — short enough to sit inline without wrapping on a phone. */
function ago(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function LiveCaptureStrip({
  /** When the credit feed last came back from the server (react-query's dataUpdatedAt). */
  dataUpdatedAt,
  /** Newest payment, by the time the payment app stated — not when we ingested it. */
  lastPaymentAt,
}: { dataUpdatedAt: number; lastPaymentAt: string | null }) {
  // A ticking clock so "updated 4s ago" actually counts up between fetches. Without it the
  // page looks frozen in precisely the way that caused the false alarms.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const agentQ = useQuery({
    queryKey: ["mp:agent-strip"],
    queryFn: async () => (await fetch("/api/banker-portal/agent").then((r) => r.json())) as { devices: Device[] },
    refetchInterval: 30_000,
  });

  // The phone actually doing the collecting: prefer one that is online and capturing.
  const devices = agentQ.data?.devices ?? [];
  const d = devices.find((x) => x.online && x.rrn_capture_ready) ?? devices.find((x) => x.online) ?? devices[0];

  const paymentGapMin = lastPaymentAt ? (now - +new Date(lastPaymentAt)) / 60000 : null;

  // Capture is only genuinely healthy when the phone is reachable AND armed. "Online" alone is
  // the state that has lied before: heartbeats fine, no payment app selected, nothing captured.
  const capturing = !!d?.online && !!d?.rrn_capture_ready;
  const sleeps = d?.screen_state === "may_sleep" || d?.screen_state === "overlay_missing";
  const unplugged = d?.screen_state === "unplugged";

  const tone = !d || !d.online ? "danger" : !capturing || sleeps ? "warning" : "success";
  const dot =
    tone === "success" ? "bg-[color:var(--color-success)]"
    : tone === "warning" ? "bg-[color:var(--color-warning)]"
    : "bg-[color:var(--color-danger)]";

  const state =
    !d ? "no collection phone enrolled"
    : !d.online ? "phone offline"
    : !d.capture_apps ? "no payment app selected"
    : d.auto_capture === false ? "auto-capture off"
    : "capturing";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {/* IS THE PAGE LIVE — about this browser tab, nothing else. */}
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--color-success)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--color-success)]" />
        </span>
        LIVE
        <span className="text-[color:var(--color-text-subtle)]">· updated {ago(dataUpdatedAt, now)} ago</span>
      </span>

      {/* IS THE AGENT LIVE — about the phone. */}
      <span className="inline-flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-medium">{state}</span>
        {d?.capture_apps && <span className="text-[color:var(--color-text-subtle)]">· {d.capture_apps}</span>}
        {unplugged && <span className="text-[color:var(--color-warning)]">· on battery</span>}
        {sleeps && <span className="text-[color:var(--color-danger)]">· screen can sleep</span>}
      </span>

      {/* WHEN THE MONEY LAST ARRIVED — the number people were actually reading off the old badge. */}
      {lastPaymentAt && (
        <span className="text-[color:var(--color-text-subtle)]">
          last payment {new Date(lastPaymentAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}
          {" · "}{ago(+new Date(lastPaymentAt), now)} ago
        </span>
      )}

      {/* A GAP IS ONLY NEWS WHEN THE PHONE CLAIMS TO BE FINE. Said plainly, and hedged, because a
          quiet half-hour is normal outside trading peaks and crying wolf here trains people to
          ignore the strip on the day it matters. */}
      {capturing && paymentGapMin !== null && paymentGapMin > 20 && (
        <span className="text-[color:var(--color-warning)]">
          nothing captured for {Math.round(paymentGapMin)} min — check the phone is on the payment app
        </span>
      )}
    </div>
  );
}
