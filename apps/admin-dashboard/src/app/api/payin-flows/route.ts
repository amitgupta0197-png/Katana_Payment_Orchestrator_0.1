// GET /api/payin-flows — the bifurcation of merchants and bankers by pay-in flow.
//
// Every merchant (`providers`) with the flow selected for it, and every banker (`merchants`)
// with the flow in force for it: its own when it has one, else its merchant's. A merchant or
// banker on BOTH counts under P2P and under Intent, because it is set up for each.
//
// ?flow=P2P|INTENT narrows both lists to those on that flow (BOTH included).
//
// SUPER_ADMIN only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { isOnFlow, merchantFlowOf, parseOrderFlow, type MerchantFlow, type PayinFlowSetting } from "@/lib/payin-flow";
import { flowReadiness } from "@/lib/payin-flow-api";
import type { FlowSource } from "@/lib/payin-flow-store";

export const dynamic = "force-dynamic";

const SETTINGS: PayinFlowSetting[] = ["P2P", "INTENT", "BOTH", "UNSET"];
const tally = () => Object.fromEntries(SETTINGS.map((k) => [k, 0])) as Record<PayinFlowSetting, number>;

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const only = parseOrderFlow(new URL(req.url).searchParams.get("flow"));

  try {
    const [providers, maps, merchants, own] = await Promise.all([
      rows<{ id: string; code: string; legal_name: string; status: string; payin_flow: string; payin_active_flow: string | null; payin_flow_set_at: string | null }>("provider", `
        SELECT id::text, code, legal_name, status, payin_flow, payin_active_flow, payin_flow_set_at
          FROM providers ORDER BY legal_name
      `),
      rows<{ provider_id: string; merchant_id: string }>("provider", `
        SELECT provider_id::text, merchant_id::text FROM provider_merchant_mappings WHERE status = 'ACTIVE'
      `).catch(() => []),
      rows<{ id: string; merchant_code: string; name: string; stage: string }>("merchant", `
        SELECT id::text, merchant_code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name, stage
          FROM merchants ORDER BY created_at DESC LIMIT 2000
      `),
      rows<{ merchant_code: string; payin_flow: string; payin_active_flow: string | null }>("merchant", `
        SELECT merchant_code, payin_flow, payin_active_flow FROM merchant_payment_config WHERE payin_flow <> 'UNSET'
      `).catch(() => []),
    ]);

    const providerFlow = new Map<string, MerchantFlow>(providers.map((p) => [p.id, merchantFlowOf(p.payin_flow, p.payin_active_flow)]));
    const providerName = new Map(providers.map((p) => [p.id, p.legal_name]));
    // A mapping holds the banker's uuid (older rows: its code).
    const providerOfBanker = new Map<string, string>();
    for (const m of maps) providerOfBanker.set(m.merchant_id, m.provider_id);
    const ownFlow = new Map<string, MerchantFlow>(own.map((o) => [o.merchant_code, merchantFlowOf(o.payin_flow, o.payin_active_flow)]));
    const ready = await flowReadiness(merchants.map((m) => m.merchant_code));

    const bankers = merchants.map((m) => {
      const providerId = providerOfBanker.get(m.id) ?? providerOfBanker.get(m.merchant_code) ?? null;
      const mine = ownFlow.get(m.merchant_code);
      const parent = providerId ? providerFlow.get(providerId) : undefined;
      const eff: MerchantFlow = mine ?? (parent && parent.flow !== "UNSET" ? parent : { flow: "UNSET", active: null });
      const source: FlowSource = mine ? "BANKER" : eff.flow !== "UNSET" ? "MERCHANT" : "NONE";
      return {
        id: m.id, merchant_code: m.merchant_code, name: m.name, stage: m.stage,
        provider_id: providerId, provider_name: providerId ? providerName.get(providerId) ?? null : null,
        flow: eff.flow, active: eff.active, source,
        readiness: ready.get(m.merchant_code) ?? { p2p: false, intent: false },
      };
    });

    const merchantRows = providers.map((p) => {
      const f = providerFlow.get(p.id)!;
      return {
        id: p.id, code: p.code, name: p.legal_name, status: p.status,
        flow: f.flow, active: f.active, set_at: p.payin_flow_set_at,
        bankers: bankers.filter((b) => b.provider_id === p.id).length,
      };
    });

    const counts = { merchants: tally(), bankers: tally() };
    for (const m of merchantRows) counts.merchants[m.flow]++;
    for (const b of bankers) counts.bankers[b.flow]++;

    const on = <T extends MerchantFlow>(list: T[]) => (only ? list.filter((x) => isOnFlow(x, only)) : list);
    return NextResponse.json({ flow: only, counts, merchants: on(merchantRows), bankers: on(bankers) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
