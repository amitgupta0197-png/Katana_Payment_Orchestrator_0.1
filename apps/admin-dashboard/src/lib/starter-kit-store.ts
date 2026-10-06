// The facts a banker's Starter Kit is written from (lib/starter-kit): what it was set up for in
// the admin panel, its keys, its webhook and how far it is from live mode.

import { rows } from "@/lib/pg";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { getProviderServices } from "@/lib/merchant-services-store";
import { getCheckoutCreds, getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { listWebhookSettings } from "@/lib/webhook-settings";
import { activationState } from "@/lib/live-activation";
import { activePayoutProvider } from "@/lib/payout-providers";
import { getPayinLimits } from "@/lib/payin-limits-store";
import { effectivePayinLimits, platformPayinLimits } from "@/lib/payin-limits";
import { publicBase } from "@/lib/payin-providers/types";
import type { KitFacts } from "@/lib/starter-kit";
import { bankerLiveCheckoutMode } from "@/lib/checkout-mode-store";

export async function starterKitFacts(merchantCode: string): Promise<KitFacts> {
  const flow = await getEffectiveFlow(merchantCode);
  const [banker, services, test, live, hooks, activation, payout, ownLimits, checkout] = await Promise.all([
    rows<{ name: string }>("merchant",
      `SELECT COALESCE(NULLIF(brand_name, ''), legal_name) AS name FROM merchants WHERE merchant_code = $1`, [merchantCode]),
    getProviderServices(flow.providerId),
    getCheckoutCreds(merchantCode, false),
    getCheckoutCredsStatus(merchantCode, true),
    listWebhookSettings([merchantCode]).catch(() => []),
    activationState(merchantCode),
    activePayoutProvider(merchantCode).catch(() => null),
    getPayinLimits(merchantCode).catch(() => null),
    bankerLiveCheckoutMode(merchantCode).catch(() => null),
  ]);
  const hook = hooks[0];
  const limits = ownLimits ? effectivePayinLimits(ownLimits, platformPayinLimits()) : null;
  return {
    bankerName: banker[0]?.name?.trim() || merchantCode,
    merchantCode,
    baseUrl: publicBase(),
    services,
    flow: { flow: flow.flow, active: flow.active },
    testCreds: test ? { key: test.key, salt: test.salt, scheme: test.scheme } : null,
    liveKey: live.configured ? { key: live.key, saltHint: live.salt_hint } : null,
    liveMode: activation.status,
    liveChecklist: activation.checklist.map((i) => ({ label: i.label, done: i.done })),
    webhook: {
      url: hook?.callback_url && /^https?:\/\//i.test(hook.callback_url) ? hook.callback_url : null,
      version: hook?.effective_version ?? "v1",
      v2Pending: hook?.webhook_version === "v2" && !hook.has_secret,
      paidOnly: hook?.webhook_events === "PAID_ONLY",
      secretHint: hook?.secret_hint ?? null,
    },
    // Sandbox payout credentials at its gateway win; otherwise Katana's own (lib/fifo-payout).
    testPayouts: payout?.creds.env === "TEST" ? "GATEWAY" : "SANDBOX",
    limits: { min: limits?.min ?? null, max: limits?.max ?? limits?.upiMax ?? null, daily: limits?.daily ?? null },
    checkout,
  };
}
