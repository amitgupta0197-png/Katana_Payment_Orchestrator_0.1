"use client";

// The gateway alerts that are open now, across the top of every staff page: a gateway that has
// stopped sending webhooks, confirms slowly or pays after expiry (lib/gateway-performance).
// Nothing is rendered for a login that is not staff (the API refuses it) or when nothing is open.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

interface Alert { key: string; severity: string; title: string; since: string }

export function GatewayAlertBanner() {
  const q = useQuery({
    queryKey: ["ops:gateway-alerts"],
    queryFn: async () => {
      const r = await fetch("/api/ops/alerts");
      if (!r.ok) return [] as Alert[];
      return ((await r.json()) as { alerts: Alert[] }).alerts;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const alerts = q.data ?? [];
  if (!alerts.length) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] px-4 py-2 text-sm md:px-6">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
      <span className="font-medium text-[color:var(--color-danger)]">{alerts.length === 1 ? alerts[0].title : `${alerts.length} gateway alerts`}</span>
      {alerts.length > 1 && <span className="text-xs text-[color:var(--color-text-muted)]">{alerts.map((a) => a.title).join(" · ")}</span>}
      <Link href="/gateway-health" className="ml-auto text-xs font-medium underline">Gateway health</Link>
    </div>
  );
}
