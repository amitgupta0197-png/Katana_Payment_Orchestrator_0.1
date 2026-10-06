// Recent orders of bankers, for "before you save" (lib/change-impact). Reads only.

import { rows } from "@/lib/pg";
import type { BankerOrderCounts } from "@/lib/change-impact";

export const IMPACT_DAYS = 7;

/** Live pay-ins of each banker in the last `days` days, by channel, own (not partner) and still open. */
export async function bankerOrderCounts(codes: string[], days = IMPACT_DAYS): Promise<Map<string, BankerOrderCounts>> {
  const out = new Map<string, BankerOrderCounts>(codes.map((c) => [c, { code: c, total: 0, intent: 0, p2p: 0, own: 0, open: 0, lastAt: null }]));
  if (!codes.length) return out;
  const r = await rows<{ code: string; total: number; intent: number; p2p: number; own: number; open: number; last: string | null }>("vendorGateway", `
    SELECT merchant_id AS code,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE channel_type = 'INTENT')::int AS intent,
           COUNT(*) FILTER (WHERE channel_type = 'P2P')::int AS p2p,
           COUNT(*) FILTER (WHERE partner_id IS NULL AND COALESCE(signed_by, '') NOT LIKE 'partner:%' AND NOT (meta ? 'staff_test'))::int AS own,
           COUNT(*) FILTER (WHERE status = 'PENDING')::int AS open,
           MAX(created_at)::text AS last
      FROM vendor_payin_orders
     WHERE merchant_id = ANY($1::text[]) AND livemode AND created_at > now() - make_interval(days => $2::int)
     GROUP BY merchant_id`, [codes, days]);
  for (const x of r) out.set(x.code, { code: x.code, total: x.total, intent: x.intent, p2p: x.p2p, own: x.own, open: x.open, lastAt: x.last });
  return out;
}
