// Integration health per banker, for the merchant and banker portals (GET /api/portal/integration-health).
//
//   api        the banker's own API requests in the last 24h (api_request_log): how many, how many
//              refused, the last error code
//   callbacks  payment messages to the banker's server in the last 24h (webhook_outbox): delivered,
//              still retrying, given up (7 days), and the last error
//   capture    the last money seen on the banker's UPI IDs (vendor_txn_alerts, live only)
//
// The rule is lib/integration-health-rules (pure); the reads are scoped by the caller (lib/portal-scope).
// A callback error is the banker's own server's answer, but it is scrubbed anyway (lib/merchant-safe).

import { rows } from "@/lib/pg";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { stripGatewayNames } from "@/lib/merchant-safe";
import { verdict, type BankerHealth, type Counts } from "@/lib/integration-health-rules";

export type { BankerHealth, HealthState } from "@/lib/integration-health-rules";

const TODAY_IST = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const n = (v: unknown) => Number(v ?? 0) || 0;

export async function integrationHealth(codes: string[], livemode: boolean): Promise<BankerHealth[]> {
  if (!codes.length) return [];
  const [api, hooks, credits] = await Promise.all([
    rows<{ m: string; requests: number; refused: number; last_at: string | null; last_error: string | null }>("audit", `
      SELECT merchant_id AS m, COUNT(*)::int AS requests,
             COUNT(*) FILTER (WHERE http_status >= 400)::int AS refused,
             MAX(created_at) AS last_at,
             (ARRAY_AGG(COALESCE(error_code, 'HTTP ' || http_status) ORDER BY created_at DESC)
               FILTER (WHERE http_status >= 400))[1] AS last_error
        FROM api_request_log
       WHERE merchant_id = ANY($1::text[]) AND COALESCE(livemode, true) = $2 AND created_at > now() - interval '24 hours'
       GROUP BY 1`, [codes, livemode]).catch(() => []),
    rows<{ m: string; delivered: number; retrying: number; failed: number; last_delivered_at: string | null; last_error: string | null }>("notification", `
      SELECT merchant_id AS m,
             COUNT(*) FILTER (WHERE status = 'DELIVERED' AND created_at > now() - interval '24 hours')::int AS delivered,
             COUNT(*) FILTER (WHERE status = 'PENDING' AND attempts > 0)::int AS retrying,
             COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS failed,
             MAX(delivered_at) AS last_delivered_at,
             (ARRAY_AGG(last_error ORDER BY created_at DESC) FILTER (WHERE last_error IS NOT NULL AND status <> 'DELIVERED'))[1] AS last_error
        FROM webhook_outbox
       WHERE merchant_id = ANY($1::text[]) AND NOT COALESCE(is_test, false) AND COALESCE(livemode, true) = $2
         AND created_at > now() - interval '7 days'
       GROUP BY 1`, [codes, livemode]).catch(() => []),
    // Money on the UPI IDs is real money only: live, whatever the switch says.
    rows<{ m: string; last_at: string | null; today: number }>("vendorGateway", `
      SELECT merchant_id AS m, MAX(COALESCE(event_time, created_at)) AS last_at,
             COUNT(*) FILTER (WHERE COALESCE(event_time, created_at) >= ${TODAY_IST})::int AS today
        FROM vendor_txn_alerts
       WHERE direction = 'CREDIT' AND ${IS_COLLECTION} AND livemode = true AND merchant_id = ANY($1::text[])
         AND created_at > now() - interval '30 days'
       GROUP BY 1`, [codes]).catch(() => []),
  ]);

  return codes.map((code) => {
    const a = api.find((r) => r.m === code);
    const h = hooks.find((r) => r.m === code);
    const c = credits.find((r) => r.m === code);
    const counts: Counts = {
      api: { requests: n(a?.requests), refused: n(a?.refused), last_at: iso(a?.last_at), last_error: a?.last_error ?? null },
      callbacks: {
        delivered: n(h?.delivered), retrying: n(h?.retrying), failed: n(h?.failed),
        last_delivered_at: iso(h?.last_delivered_at),
        last_error: h?.last_error ? stripGatewayNames(h.last_error).slice(0, 120) : null,
      },
    };
    return { code, ...counts, capture: { last_credit_at: iso(c?.last_at), today: n(c?.today) }, ...verdict(counts) };
  });
}
