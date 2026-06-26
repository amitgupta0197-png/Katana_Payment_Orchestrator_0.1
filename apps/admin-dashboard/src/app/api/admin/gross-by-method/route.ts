// Operations console: gross value by payment method × merchant (SUPER_ADMIN).
// Unions checkout_orders (method) + vendor_payin_orders (channel = method),
// counts successful collections as gross.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const SUCCESS = new Set(["SUCCESS", "SUCCEEDED"]);
interface Row { merchant_id: string; method: string; channel: string; status: string; amount: number }

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  try {
    const checkout = await rows<Row>("checkout", `
      SELECT COALESCE(NULLIF(merchant_id,''),'—') AS merchant_id,
             COALESCE(NULLIF(method,''),'UNKNOWN') AS method,
             COALESCE(NULLIF(selected_rail,''),'DIRECT') AS channel,
             status, amount::float AS amount
        FROM checkout_orders LIMIT 5000
    `).catch(() => []);
    const payin = await rows<Row>("vendorGateway", `
      SELECT COALESCE(NULLIF(merchant_id,''),'—') AS merchant_id,
             COALESCE(NULLIF(channel,''),'UNKNOWN') AS method,
             vendor AS channel, status, amount::float AS amount
        FROM vendor_payin_orders WHERE merchant_id IS NOT NULL LIMIT 5000
    `).catch(() => []);

    const all = [...checkout, ...payin];
    const methods = new Set<string>();
    const channels = new Set<string>();
    const byMerchant = new Map<string, { merchant_id: string; total: number; count: number; by_method: Record<string, number> }>();
    const totalsByMethod: Record<string, number> = {};
    const totalsByChannel: Record<string, number> = {};
    let grandGross = 0;

    for (const t of all) {
      methods.add(t.method);
      channels.add(t.channel);
      const ok = SUCCESS.has(t.status);
      const m = byMerchant.get(t.merchant_id) ?? { merchant_id: t.merchant_id, total: 0, count: 0, by_method: {} };
      m.count++;
      if (ok) {
        m.total += t.amount;
        m.by_method[t.method] = (m.by_method[t.method] ?? 0) + t.amount;
        totalsByMethod[t.method] = (totalsByMethod[t.method] ?? 0) + t.amount;
        totalsByChannel[t.channel] = (totalsByChannel[t.channel] ?? 0) + t.amount;
        grandGross += t.amount;
      }
      byMerchant.set(t.merchant_id, m);
    }

    return NextResponse.json({
      methods: [...methods].sort(),
      channels: [...channels].sort(),
      rows: [...byMerchant.values()].sort((a, b) => b.total - a.total),
      totals: { gross: grandGross, by_method: totalsByMethod, by_channel: totalsByChannel },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
