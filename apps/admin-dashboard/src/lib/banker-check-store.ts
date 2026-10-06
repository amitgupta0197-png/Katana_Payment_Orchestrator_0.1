// The facts "Check this banker" (lib/banker-check) answers from, read with the same functions the
// order path uses: nothing is created, no gateway is asked, no callback is sent. A lookup that
// fails reads as the unsafe answer (not set / not working), so the check may under-report readiness,
// never over-report it.

import { rows } from "@/lib/pg";
import { CLOSED_STAGES, CLOSED_STATUSES } from "@/lib/katana-order";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { getProviderServices } from "@/lib/merchant-services-store";
import { bankerSetup } from "@/lib/merchant-setup";
import { isExclusivePartner } from "@/lib/partner/exclusive";
import { isLiveActivated } from "@/lib/live-activation";
import { getGatewayMid, getGatewayMidStatus } from "@/lib/gateway-creds";
import { gatewayCheckoutMode, gatewayDef } from "@/lib/pg-catalog";
import { getGoLive, verifyMaxAmountFor } from "@/lib/gateway-golive";
import { effectivePayinLimits, platformPayinLimits } from "@/lib/payin-limits";
import { getPayinLimits } from "@/lib/payin-limits-store";
import { getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { checkBanker, type BankerCheckFacts, type BankerCheckResult } from "@/lib/banker-check";

/** Heartbeat fresher than this = online (as the devices route). */
const ONLINE_SEC = 600;

export async function bankerCheckFacts(merchantId: string): Promise<BankerCheckFacts | null> {
  const m = (await rows<{ code: string; name: string; stage: string; webhook_url: string | null }>("merchant", `
    SELECT merchant_code AS code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name, stage, webhook_url
      FROM merchants WHERE id::text = $1 OR merchant_code = $1 LIMIT 1`, [merchantId]))[0];
  if (!m) return null;
  const code = m.code;
  const flow = await getEffectiveFlow(code);

  const [cfg, provider, services, exclusive, partner, live, activation, setup, status, mid, limitsOwn, key, phones, cb] = await Promise.all([
    rows<{ blocked: boolean | null; vpa: string | null; vpas: unknown }>("merchant", `
      SELECT blocked, katana_pay->>'settlement_vpa' AS vpa, katana_pay->'settlement_vpas' AS vpas
        FROM merchant_payment_config WHERE merchant_code = $1`, [code]).catch(() => []),
    flow.providerId
      ? rows<{ status: string }>("provider", `SELECT status FROM providers WHERE id = $1::uuid`, [flow.providerId]).catch(() => [])
      : Promise.resolve([]),
    getProviderServices(flow.providerId),
    isExclusivePartner(flow.providerId).catch(() => false),
    flow.providerId
      ? rows<{ name: string }>("vendorGateway", `SELECT name FROM partners WHERE provider_id = $1`, [flow.providerId]).catch(() => [])
      : Promise.resolve([]),
    isLiveActivated(code).catch(() => false),
    rows<{ status: string }>("merchant", `SELECT status FROM merchant_live_activation WHERE merchant_code = $1`, [code]).catch(() => []),
    bankerSetup(code),
    getGatewayMidStatus(code).catch(() => ({ configured: false as const })),
    getGatewayMid(code).catch(() => null),
    getPayinLimits(code).catch(() => ({ min: null, max: null, daily: null, maxTps: null })),
    getCheckoutCredsStatus(code, true).catch(() => ({ configured: false as const })),
    rows<{ enrolled: number; online: number; last: string | null }>("vendorGateway", `
      SELECT COUNT(*)::int AS enrolled,
             COUNT(*) FILTER (WHERE status = 'TRUSTED' AND notif_access = true AND agent_enabled IS DISTINCT FROM false
                                AND last_heartbeat >= now() - ($2 || ' seconds')::interval)::int AS online,
             MAX(last_heartbeat)::text AS last
        FROM vendor_devices WHERE merchant_id = $1`, [code, String(ONLINE_SEC)]).catch(() => []),
    // The newest real (live, not a sample) callback owed to this banker's merchant, and how it went.
    rows<{ status: string; at: string; http: number | null }>("notification", `
      SELECT o.status, COALESCE(o.delivered_at, o.created_at)::text AS at,
             (SELECT a.response_status FROM webhook_dispatch_attempts a WHERE a.outbox_id = o.outbox_id ORDER BY a.attempt_no DESC LIMIT 1) AS http
        FROM webhook_outbox o
       WHERE o.merchant_id = $1 AND o.livemode AND NOT COALESCE(o.is_test, false)
       ORDER BY o.created_at DESC LIMIT 1`, [code]).catch(() => []),
  ]);

  const c = cfg[0];
  const extraVpa = Array.isArray(c?.vpas) ? (c!.vpas as unknown[]).find((v) => typeof v === "string" && v.trim()) as string | undefined : undefined;
  const golive = status.configured ? await getGoLive(code, status.gateway).catch(() => null) : null;
  const lim = effectivePayinLimits(limitsOwn, platformPayinLimits());
  const last = cb[0];

  return {
    code, name: m.name,
    blocked: c?.blocked === true,
    stageClosed: CLOSED_STAGES.has(m.stage ?? ""),
    stage: m.stage ?? "",
    providerClosed: CLOSED_STATUSES.has(provider[0]?.status ?? ""),
    services,
    flow: { flow: flow.flow, active: flow.active },
    partnerExclusive: exclusive,
    partnerName: partner[0]?.name ?? null,
    liveActivated: live,
    activationStatus: activation[0]?.status ?? (live ? "ACTIVATED" : "NOT_REQUESTED"),
    setup: setup.items,
    account: status.configured ? {
      gateway: status.gateway, gatewayName: status.gateway_name, env: status.env, connector: status.connector,
      channel: status.channel,
      checkout: gatewayCheckoutMode(status.gateway, mid?.auth ?? null),
      golive: golive ? golive.status : null,
      verifyCap: verifyMaxAmountFor(status.gateway),
      minAmount: gatewayDef(status.gateway)?.payin.minAmount ?? null,
    } : null,
    upiId: c?.vpa?.trim() || extraVpa?.trim() || null,
    phones: { enrolled: phones[0]?.enrolled ?? 0, online: phones[0]?.online ?? 0, lastHeartbeat: phones[0]?.last ?? null },
    limits: { min: lim.min, max: lim.max, daily: lim.daily, upiMax: lim.upiMax },
    liveKey: key.configured,
    callback: {
      url: m.webhook_url?.trim() || null,
      lastOk: last ? last.status === "DELIVERED" ? true : last.status === "DEAD_LETTER" || last.status === "FAILED" ? false : null : null,
      lastAt: last?.at ?? null,
      lastHttp: last?.http ?? null,
    },
  };
}

export async function checkBankerById(merchantId: string): Promise<{ facts: BankerCheckFacts; result: BankerCheckResult } | null> {
  const facts = await bankerCheckFacts(merchantId);
  return facts ? { facts, result: checkBanker(facts) } : null;
}
