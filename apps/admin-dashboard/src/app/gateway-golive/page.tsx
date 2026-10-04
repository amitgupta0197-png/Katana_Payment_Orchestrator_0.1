"use client";

// The gateway go-live checklist (lib/gateway-golive). A banker's gateway account takes only a
// few small verification payments until every item is recorded, then a named member of staff
// sets it LIVE. STAFF ONLY — this page names gateways.

import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GoLiveAccountCard, type GoLiveAccount } from "@/components/gateway/golive-account";

export default function GatewayGoLivePage() {
  const q = useQuery({
    queryKey: ["ops:gateway-golive"],
    queryFn: async () => {
      const r = await fetch("/api/ops/gateway-golive");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { accounts: GoLiveAccount[]; limits: { max_amount: number; max_orders: number } };
    },
    refetchInterval: 30_000,
  });
  const accounts = q.data?.accounts ?? [];
  const l = q.data?.limits;
  return (
    <div>
      <PageHeader title="Gateway go-live" icon={Rocket}
        description="A gateway account is set LIVE only after its callback URL answers, a real payment was reported by the gateway, and a status check confirmed the same payment." />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            An account appears here when live credentials are saved for a banker.
            {l ? ` While it is verifying it takes at most ${l.max_orders} live payments of up to ₹${l.max_amount} each (or the gateway's own minimum, when that is higher: RubyVault ₹500).` : ""} Accounts that were live before the checklist existed are not listed and are not restricted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : accounts.length === 0 ? <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No account is on the checklist.</p>
            : <ul className="space-y-3">{accounts.map((a) => <GoLiveAccountCard key={a.merchant_id + a.gateway + a.account} a={a} />)}</ul>}
        </CardContent>
      </Card>
    </div>
  );
}
