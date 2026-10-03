"use client";

// Whether a merchant's bankers are set up for what the merchant is onboarded for
// (lib/merchant-setup): the warning shown before a change is saved. Staff only.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { MerchantServicesSetting, SetupItem } from "@/lib/merchant-services";
import type { MerchantFlow, OrderFlow, PayinFlowSetting } from "@/lib/payin-flow";

export interface BankerReadiness {
  id: string; merchant_code: string; name: string; stage: string;
  flow: MerchantFlow; own_flow: boolean; items: SetupItem[]; result: "PASS" | "REVIEW" | "FAIL";
}
export interface MerchantReadiness {
  id: string; code: string; name: string; status: string;
  services: MerchantServicesSetting; flow: MerchantFlow;
  bankers: BankerReadiness[]; live_not_ready: number;
}

export const missingOf = (b: BankerReadiness) => b.items.filter((i) => i.state === "MISSING").map((i) => i.label);

/**
 * What a choice would mean for the merchant's bankers, before it is saved. Pass only what is
 * being changed; the rest is taken as saved. Renders nothing until there is something to say.
 */
export function ReadinessPreview({ providerId, services, flow, active, enabled = true }: {
  providerId: string; services?: MerchantServicesSetting | null; flow?: PayinFlowSetting | null; active?: OrderFlow | null; enabled?: boolean;
}) {
  const qs = new URLSearchParams();
  if (services) qs.set("services", services);
  if (flow) { qs.set("flow", flow); if (flow === "BOTH" && active) qs.set("active", active); }
  const q = useQuery({
    queryKey: ["merchant-readiness", providerId, qs.toString()],
    enabled,
    queryFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/onboarding-choice?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as MerchantReadiness;
    },
  });
  if (!enabled || !q.data) return null;
  const bankers = q.data.bankers;
  if (!bankers.length) return <p className="text-xs text-[color:var(--color-text-muted)]">This merchant has no bankers yet.</p>;
  const bad = bankers.filter((b) => b.result === "FAIL");
  const live = bad.filter((b) => b.stage === "LIVE");
  if (!bad.length) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[color:var(--color-success)]">
        <CheckCircle2 className="h-3.5 w-3.5" /> All {bankers.length} banker{bankers.length === 1 ? " is" : "s are"} set up for this.
      </p>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] p-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        {bad.length} of {bankers.length} banker{bankers.length === 1 ? "" : "s"} would not be ready
        {live.length ? `, ${live.length} of them live: their orders on this flow will be refused` : ""}.
      </div>
      <ul className="mt-1 space-y-0.5">
        {bad.slice(0, 8).map((b) => (
          <li key={b.id}><span className="font-medium">{b.merchant_code}</span> {b.name} ({b.stage}{b.own_flow ? ", own flow" : ""}): needs {missingOf(b).join("; ")}</li>
        ))}
        {bad.length > 8 && <li>and {bad.length - 8} more</li>}
      </ul>
    </div>
  );
}
