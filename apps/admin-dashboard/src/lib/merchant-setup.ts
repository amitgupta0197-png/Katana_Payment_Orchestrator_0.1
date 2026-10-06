// What a banker was onboarded for and whether it is set up for it: the go-live gate
// (lib/onboarding-gates) and the scheduled check on live bankers (lib/ops-monitor).
// The rules are pure, in lib/merchant-services; this reads the facts.

import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { flowReadiness } from "@/lib/payin-flow-api";
import { activePayoutProvider } from "@/lib/payout-providers";
import { rows } from "@/lib/pg";
import { setAlert } from "@/lib/ops-alert";
import { merchantFlowOf, type MerchantFlow } from "@/lib/payin-flow";
import { getProviderServices } from "@/lib/merchant-services-store";
import { bankerLiveCheckoutMode, getProviderNeedsH2h } from "@/lib/checkout-mode-store";
import {
  parseServices, setupItems, setupVerdict, type MerchantEvidence, type MerchantServicesSetting, type SetupItem,
} from "@/lib/merchant-services";

export interface BankerSetup {
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  /** The merchant the banker is mapped under; null when it is mapped under none. */
  provider_id: string | null;
  items: SetupItem[];
  result: "PASS" | "REVIEW" | "FAIL";
  summary: string;
}

/** What a banker was onboarded for and whether it is set up for it (the go-live gate). */
export async function bankerSetup(merchantCode: string): Promise<BankerSetup> {
  const flow = await getEffectiveFlow(merchantCode);
  const [services, ready, payout, needsH2h] = await Promise.all([
    getProviderServices(flow.providerId),
    flowReadiness([merchantCode]),
    activePayoutProvider(merchantCode).catch(() => null),
    getProviderNeedsH2h(flow.providerId),
  ]);
  const r = ready.get(merchantCode);
  const intentCheckout = needsH2h && r?.intent ? await bankerLiveCheckoutMode(merchantCode) : null;
  const items = setupItems(services, { flow: flow.flow, active: flow.active },
    { upiId: !!r?.p2p, payinGateway: !!r?.intent, payoutGateway: !!payout, needsH2h, intentCheckout });
  return { services, flow: { flow: flow.flow, active: flow.active }, provider_id: flow.providerId, items, ...setupVerdict(items) };
}

// ── Every merchant at once: the readiness screen, the save-time warning, the monitor ──────

export interface BankerReadiness {
  id: string; merchant_code: string; name: string; stage: string;
  flow: MerchantFlow;
  /** The banker has a flow of its own, which wins over its merchant's. */
  own_flow: boolean;
  items: SetupItem[];
  result: "PASS" | "REVIEW" | "FAIL";
}

export interface MerchantReadiness {
  id: string; code: string; name: string; status: string;
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  bankers: BankerReadiness[];
  /** Live bankers that are missing something required. */
  live_not_ready: number;
}

/** What a merchant would be changed to, to see its bankers' readiness before saving it. */
export interface ProposedChoice { services?: MerchantServicesSetting; flow?: MerchantFlow }

/**
 * Every merchant with what it was onboarded for and, per banker, what is still missing.
 * `only` narrows it to one merchant; `proposed` answers "what if this merchant were set to…".
 */
export async function merchantReadiness(only?: string | null, proposed?: ProposedChoice): Promise<MerchantReadiness[]> {
  const [providers, maps, bankers, own] = await Promise.all([
    rows<{ id: string; code: string; legal_name: string; status: string; services: string; payin_flow: string; payin_active_flow: string | null }>("provider", `
      SELECT id::text, code, legal_name, status, services, payin_flow, payin_active_flow
        FROM providers WHERE ($1::text IS NULL OR id::text = $1) ORDER BY legal_name
    `, [only ?? null]),
    rows<{ provider_id: string; merchant_id: string }>("provider", `
      SELECT provider_id::text, merchant_id::text FROM provider_merchant_mappings
       WHERE status = 'ACTIVE' AND ($1::text IS NULL OR provider_id::text = $1)
    `, [only ?? null]),
    rows<{ id: string; merchant_code: string; name: string; stage: string }>("merchant", `
      SELECT id::text, merchant_code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name, stage
        FROM merchants ORDER BY created_at DESC LIMIT 5000
    `),
    rows<{ merchant_code: string; payin_flow: string; payin_active_flow: string | null }>("merchant", `
      SELECT merchant_code, payin_flow, payin_active_flow FROM merchant_payment_config WHERE payin_flow <> 'UNSET'
    `).catch(() => []),
  ]);
  // A mapping holds the banker's uuid (older rows: its code).
  const mapped = new Map<string, string>();
  for (const m of maps) mapped.set(m.merchant_id, m.provider_id);
  const mine = bankers.filter((b) => mapped.has(b.id) || mapped.has(b.merchant_code));
  const codes = mine.map((b) => b.merchant_code);
  const [ready, payout] = await Promise.all([
    flowReadiness(codes),
    rows<{ owner_id: string }>("checkout", `
      SELECT DISTINCT owner_id FROM credential_vault
       WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND label = 'payout_gateway'
         AND enabled = true AND owner_id = ANY($1::text[])
    `, [codes]).catch(() => []),
  ]);
  const hasPayout = new Set(payout.map((p) => p.owner_id));
  // Merchants that need host-to-host, and the checkout mode of their bankers' accounts.
  // A database without provider 0023 has none.
  const h2hProviders = new Set((await rows<{ id: string }>("provider",
    `SELECT id::text FROM providers WHERE needs_h2h AND ($1::text IS NULL OR id::text = $1)`, [only ?? null]).catch(() => [])).map((r) => r.id));
  const h2hMode = new Map<string, "H2H" | "REDIRECT" | null>();
  for (const b of mine) {
    const pid = mapped.get(b.id) ?? mapped.get(b.merchant_code);
    if (pid && h2hProviders.has(pid) && ready.get(b.merchant_code)?.intent)
      h2hMode.set(b.merchant_code, await bankerLiveCheckoutMode(b.merchant_code).catch(() => null));
  }
  const ownFlow = new Map(own.map((o) => [o.merchant_code, merchantFlowOf(o.payin_flow, o.payin_active_flow)]));

  return providers.map((p) => {
    const services = proposed?.services ?? parseServices(p.services);
    const flow = proposed?.flow ?? merchantFlowOf(p.payin_flow, p.payin_active_flow);
    const list = mine.filter((b) => (mapped.get(b.id) ?? mapped.get(b.merchant_code)) === p.id).map((b): BankerReadiness => {
      const o = ownFlow.get(b.merchant_code);
      const eff = o ?? flow;
      const r = ready.get(b.merchant_code);
      const items = setupItems(services, eff, {
        upiId: !!r?.p2p, payinGateway: !!r?.intent, payoutGateway: hasPayout.has(b.merchant_code),
        needsH2h: h2hProviders.has(p.id), intentCheckout: h2hMode.get(b.merchant_code) ?? null,
      });
      return { id: b.id, merchant_code: b.merchant_code, name: b.name, stage: b.stage, flow: eff, own_flow: !!o, items, result: setupVerdict(items).result };
    });
    return {
      id: p.id, code: p.code, name: p.legal_name, status: p.status, services, flow, bankers: list,
      live_not_ready: list.filter((b) => b.stage === "LIVE" && b.result === "FAIL").length,
    };
  });
}

/**
 * The monitor's check: a LIVE banker missing something its merchant's choice requires. That
 * happens when a merchant's services or flow are changed after its bankers went live, or a
 * banker's UPI ID or gateway is removed. Its orders are then refused one by one.
 */
export async function checkBankerSetup(): Promise<{ merchants: number; not_ready: string[] }> {
  const all = await merchantReadiness();
  const bad = all.flatMap((m) => m.bankers.filter((b) => b.stage === "LIVE" && b.result === "FAIL")
    .map((b) => `${b.merchant_code} (${b.items.filter((i) => i.state === "MISSING").map((i) => i.label).join("; ")})`));
  await setAlert(bad.length > 0, {
    key: "onboarding:setup_missing", severity: "WARN", repeatMinutes: 360,
    title: `${bad.length} live banker${bad.length === 1 ? "" : "s"} not set up for what the merchant was onboarded for`,
    body: `${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ` and ${bad.length - 10} more` : ""}. Their orders on that flow are refused. Fix it on Merchant readiness.`,
  });
  return { merchants: all.length, not_ready: bad };
}

/** What one merchant's bankers did over the last `days` and have in place (suggestChoice). */
export async function merchantEvidence(providerId: string, days = 90): Promise<MerchantEvidence> {
  const maps = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text FROM provider_merchant_mappings WHERE status = 'ACTIVE' AND provider_id::text = $1
  `, [providerId]);
  const keys = maps.map((m) => m.merchant_id);
  const bankers = keys.length ? await rows<{ id: string; merchant_code: string }>("merchant", `
    SELECT id::text, merchant_code FROM merchants WHERE id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])
  `, [keys]) : [];
  const codes = bankers.map((b) => b.merchant_code);
  const all = [...new Set([...codes, ...bankers.map((b) => b.id)])];
  const [orders, payouts, ready, payoutGw] = await Promise.all([
    all.length ? rows<{ channel_type: string | null; n: number }>("vendorGateway", `
      SELECT channel_type, COUNT(*)::int AS n FROM vendor_payin_orders
       WHERE merchant_id = ANY($1::text[]) AND livemode AND created_at > now() - make_interval(days => $2::int)
       GROUP BY 1`, [all, days]).catch(() => []) : [],
    codes.length ? rows<{ n: number }>("fifo", `
      SELECT COUNT(*)::int AS n FROM fifo_orders
       WHERE merchant_id = ANY($1::text[]) AND direction = 'PAYOUT' AND COALESCE(livemode, true)
         AND created_at > now() - make_interval(days => $2::int)`, [codes, days]).catch(() => []) : [],
    flowReadiness(codes),
    codes.length ? rows<{ owner_id: string }>("checkout", `
      SELECT DISTINCT owner_id FROM credential_vault
       WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND label = 'payout_gateway' AND enabled = true AND owner_id = ANY($1::text[])
    `, [codes]).catch(() => []) : [],
  ]);
  const count = (t: string) => orders.filter((o) => o.channel_type === t).reduce((s, o) => s + o.n, 0);
  return {
    bankers: codes.length, p2pOrders: count("P2P"), intentOrders: count("INTENT"), payouts: payouts[0]?.n ?? 0,
    bankersWithUpi: codes.filter((c) => ready.get(c)?.p2p).length,
    bankersWithGateway: codes.filter((c) => ready.get(c)?.intent).length,
    bankersWithPayoutGateway: payoutGw.length, days,
  };
}
