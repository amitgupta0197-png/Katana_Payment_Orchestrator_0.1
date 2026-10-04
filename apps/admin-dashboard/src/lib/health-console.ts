// What the Operations console (super-admin-cockpit) adds from the health engine, per flow, and
// against the same time yesterday. Read by /api/admin/stats; every query falls back on error.
// Staff (Super Admin) only.

import { rows } from "@/lib/pg";
import { alarmingActors, type CachedHealth } from "@/lib/health-store";

const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

/** The merchant funnel's stages, from providers columns (cumulative: each is a subset of the one before). */
export const MERCHANT_FUNNEL = ["CREATED", "KYC_APPROVED", "CHOICE_MADE", "HAS_BANKER", "LIVE"] as const;

export interface IntegrationAlert { banker_id: string | null; code: string; problems: string[] }

export async function consoleExtras(todayIso: string, livemode: boolean) {
  const yStart = new Date(Date.parse(todayIso) - 86400_000).toISOString();
  const yNow = new Date(Date.now() - 86400_000).toISOString();
  const [tsps, bankersLive, merchantsLive, mids, tspStages, intent, p2p, payouts, yPayin, yCheckout, ySettle, health, integ, mFunnel] = await Promise.all([
    safe(rows<{ total: number; live: number }>("merchant", `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE stage = 'LIVE')::int AS live FROM tsps`), []),
    safe(rows<{ id: string; merchant_code: string }>("merchant", `SELECT id::text, merchant_code FROM merchants WHERE stage = 'LIVE'`), []),
    safe(rows<{ provider_id: string; merchant_id: string }>("provider", `
      SELECT m.provider_id::text, m.merchant_id::text FROM provider_merchant_mappings m JOIN providers p ON p.id = m.provider_id
       WHERE m.status = 'ACTIVE' AND p.status = 'ACTIVE'`), []),
    safe(rows<{ n: number }>("merchant", `SELECT COUNT(*)::int AS n FROM issued_mids WHERE status = 'ACTIVE'`), []),
    safe(rows<{ stage: string; n: number }>("merchant", `SELECT stage, COUNT(*)::int AS n FROM tsps GROUP BY stage`), []),
    safe(rows<{ total: number; paid: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS paid FROM vendor_payin_orders
       WHERE channel_type = 'INTENT' AND livemode = $2 AND created_at >= $1`, [todayIso, livemode]), []),
    safe(rows<{ n: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS n FROM vendor_payin_orders
       WHERE channel_type = 'P2P' AND status = 'PENDING' AND livemode = $1 AND created_at > now() - interval '24 hours'`, [livemode]), []),
    safe(rows<{ pending: number; lag_min: number | null }>("fifo", `
      SELECT COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','REJECTED','CANCELLED','REVERSED','RETURNED'))::int AS pending,
             (AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $1) / 60)::float AS lag_min
        FROM fifo_orders WHERE direction = 'PAYOUT' AND COALESCE(livemode, true) = $2 AND created_at > now() - interval '7 days'`, [todayIso, livemode]), []),
    safe(rows<{ n: number; gross: number; failed: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount)::float, 0) AS gross,
             COUNT(*) FILTER (WHERE status IN ('FAILED','EXPIRED'))::int AS failed
        FROM vendor_payin_orders WHERE created_at >= $1 AND created_at < $2 AND livemode = $3`, [yStart, yNow, livemode]), []),
    safe(rows<{ n: number; gross: number; failed: number }>("checkout", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount)::float, 0) AS gross,
             COUNT(*) FILTER (WHERE status IN ('FAILED','EXPIRED'))::int AS failed
        FROM checkout_orders WHERE created_at >= $1 AND created_at < $2 AND livemode = $3`, [yStart, yNow, livemode]), []),
    safe(rows<{ batches: number }>("settlement", `
      SELECT COUNT(*)::int AS batches FROM settlement_batches WHERE batch_date >= $1 AND batch_date < $2`, [yStart, yNow]), []),
    alarmingActors(10),
    safe(rows<{ actor_id: string; items: CachedHealth["items"] }>("merchant", `
      SELECT actor_id, items FROM actor_health
       WHERE actor_type = 'INTEGRATION' AND items @> '[{"state":"MISSING"}]'::jsonb
         AND (items @> '[{"key":"key","state":"MISSING"}]'::jsonb OR items @> '[{"key":"callback","state":"MISSING"}]'::jsonb)
       ORDER BY live DESC, actor_id LIMIT 60`), []),
    merchantFunnel(),
  ]);
  return {
    actors: {
      tsps_total: tsps[0]?.total ?? 0, tsps_live: tsps[0]?.live ?? 0,
      bankers_live: bankersLive.length,
      merchants_live: liveMerchants(merchantsLive, bankersLive),
      mids_active: mids[0]?.n ?? 0,
    },
    flows: {
      intent_total_today: intent[0]?.total ?? 0,
      intent_success_pct: intent[0]?.total ? Math.round((intent[0].paid / intent[0].total) * 1000) / 10 : null,
      p2p_pending: p2p[0]?.n ?? 0,
      payout_pending: payouts[0]?.pending ?? 0,
      payout_avg_lag_min: payouts[0]?.lag_min == null ? null : Math.round(payouts[0].lag_min),
    },
    yesterday: yesterdayFigures(yPayin[0], yCheckout[0], ySettle[0]?.batches ?? 0),
    health_alerts: health.map((h) => ({ type: h.actor_type, id: h.actor_id, label: h.label, band: h.band, score: h.score,
      missing: h.items.filter((i) => i.state === "MISSING").map((i) => i.label).slice(0, 3) })),
    integration_alerts: integrationAlerts(integ, bankersLive),
    funnels: {
      tsp: tspStages,
      merchant: mFunnel,
    },
  };
}

/** Active merchants with at least one LIVE banker (a mapping holds the banker's uuid, or older rows its code). */
function liveMerchants(maps: { provider_id: string; merchant_id: string }[], live: { id: string; merchant_code: string }[]): number {
  const keys = new Set(live.flatMap((b) => [b.id, b.merchant_code]));
  return new Set(maps.filter((m) => keys.has(m.merchant_id)).map((m) => m.provider_id)).size;
}

type Day = { n: number; gross: number; failed: number } | undefined;
function yesterdayFigures(p: Day, c: Day, batches: number) {
  const n = (p?.n ?? 0) + (c?.n ?? 0);
  const failed = (p?.failed ?? 0) + (c?.failed ?? 0);
  return {
    transactions: n, gross: (p?.gross ?? 0) + (c?.gross ?? 0), failed,
    success_rate: n > 0 ? Math.round(((n - failed) / n) * 1000) / 10 : null,
    settlement_batches: batches,
  };
}

/** Up to five bankers whose integration has no live Key or no callback reached in 24 h. */
function integrationAlerts(list: { actor_id: string; items: CachedHealth["items"] }[], live: { id: string; merchant_code: string }[]): IntegrationAlert[] {
  const by = new Map<string, Set<string>>();
  for (const r of list) {
    const code = r.actor_id.slice(0, r.actor_id.lastIndexOf(":"));
    const set = by.get(code) ?? new Set<string>();
    for (const i of r.items) if (i.state === "MISSING" && (i.key === "key" || i.key === "callback"))
      set.add(i.key === "key" ? "no live Key" : "callback not reached in 24 h");
    by.set(code, set);
  }
  const idOf = new Map(live.map((b) => [b.merchant_code, b.id]));
  return [...by.entries()].slice(0, 5).map(([code, s]) => ({ banker_id: idOf.get(code) ?? null, code, problems: [...s] }));
}

/** CREATED → KYC_APPROVED → CHOICE_MADE → HAS_BANKER → LIVE, from providers and their mappings. */
async function merchantFunnel(): Promise<{ stage: string; n: number }[]> {
  const [p, live] = await Promise.all([
    safe(rows<{ created: number; kyc: number; choice: number; banker: number }>("provider", `
      SELECT COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE kyc_status = 'APPROVED')::int AS kyc,
             COUNT(*) FILTER (WHERE kyc_status = 'APPROVED' AND services <> 'UNSET')::int AS choice,
             COUNT(*) FILTER (WHERE kyc_status = 'APPROVED' AND services <> 'UNSET'
               AND EXISTS (SELECT 1 FROM provider_merchant_mappings m WHERE m.provider_id = p.id AND m.status = 'ACTIVE'))::int AS banker
        FROM providers p WHERE tenant_id = 'tenant-default'`), []),
    safe(rows<{ n: number }>("merchant", `SELECT COUNT(*)::int AS n FROM actor_health WHERE actor_type = 'MERCHANT' AND live`), []),
  ]);
  const r = p[0];
  return [
    { stage: "CREATED", n: r?.created ?? 0 }, { stage: "KYC_APPROVED", n: r?.kyc ?? 0 },
    { stage: "CHOICE_MADE", n: r?.choice ?? 0 }, { stage: "HAS_BANKER", n: r?.banker ?? 0 },
    { stage: "LIVE", n: live[0]?.n ?? 0 },
  ];
}
