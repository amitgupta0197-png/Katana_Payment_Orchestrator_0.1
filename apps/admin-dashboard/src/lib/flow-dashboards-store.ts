// Flow dashboards: shared reads (banker directory, callback health) and the Intent pay-in
// dashboard. STAFF ONLY (names gateways). Read-only: every query is a SELECT, bounded by a
// time window and a LIMIT, on indexed columns (vendor_payin_orders (merchant_id, channel_type,
// created_at), (vendor, created_at); webhook_outbox (merchant_id, created_at)).
// Rules (rates, buckets, tones) are in lib/flow-dashboards.ts.

import { rows } from "@/lib/pg";
import {
  countBuckets, hourlySeries, lowSuccessMerchants, payinFailureBucket, rollUpToMerchants, successRate,
  type HourPoint, type PayinFailureBucket,
} from "@/lib/flow-dashboards";

/** Midnight IST today, as a timestamptz SQL expression. */
export const IST_TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
/** created_at truncated to its IST hour, as a timestamptz. */
export const IST_HOUR = (col: string) => `(date_trunc('hour', ${col} AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export const PAID_SQL = `status IN ('SUCCESS','SUCCEEDED')`;
export const ENDED_SQL = `status IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')`;
export const LOST_SQL = `status IN ('FAILED','EXPIRED')`;

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const nn = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
/** A missing table (an older database) reads as no rows; any other error is real. */
export const orNone = <T,>(p: Promise<T[]>): Promise<T[]> =>
  p.catch((err) => ((err as { code?: string }).code === "42P01" || (err as { code?: string }).code === "42703" ? [] : Promise.reject(err)));

export interface BankerInfo {
  id: string; code: string; name: string; stage: string | null; blocked: boolean;
  provider_id: string | null; provider_name: string | null; provider_status: string | null;
}

/** Every banker with its merchant (provider). Bounded: 5,000 bankers. */
export async function bankerDirectory(): Promise<Map<string, BankerInfo>> {
  const [ms, maps] = await Promise.all([
    rows<{ id: string; code: string; name: string; stage: string | null; blocked: boolean | null }>("merchant", `
      SELECT m.id::text AS id, m.merchant_code AS code,
             COALESCE(NULLIF(m.brand_name, ''), NULLIF(m.legal_name, ''), m.merchant_code) AS name,
             m.stage, c.blocked
        FROM merchants m LEFT JOIN merchant_payment_config c ON c.merchant_code = m.merchant_code
       WHERE m.merchant_code IS NOT NULL
       LIMIT 5000`),
    orNone(rows<{ merchant_id: string; provider_id: string; name: string; status: string | null }>("provider", `
      SELECT pm.merchant_id::text AS merchant_id, p.id::text AS provider_id,
             COALESCE(NULLIF(p.legal_name, ''), p.code) AS name, p.status
        FROM provider_merchant_mappings pm JOIN providers p ON p.id = pm.provider_id
       WHERE COALESCE(pm.status, 'ACTIVE') = 'ACTIVE'
       LIMIT 10000`)),
  ]);
  const prov = new Map(maps.map((m) => [m.merchant_id, m]));
  const out = new Map<string, BankerInfo>();
  for (const m of ms) {
    const p = prov.get(m.id);
    out.set(m.code, {
      id: m.id, code: m.code, name: m.name, stage: m.stage, blocked: m.blocked === true,
      provider_id: p?.provider_id ?? null, provider_name: p?.name ?? null, provider_status: p?.status ?? null,
    });
  }
  return out;
}

/** Blocked, suspended / closed, live or onboarding — the banker's state in a word. */
export function bankerState(b: BankerInfo | undefined): "BLOCKED" | "SUSPENDED" | "LIVE" | "ONBOARDING" | "UNKNOWN" {
  if (!b) return "UNKNOWN";
  if (b.blocked) return "BLOCKED";
  if (["SUSPENDED", "TERMINATED", "REJECTED"].includes(b.stage ?? "") || ["SUSPENDED", "TERMINATED"].includes(b.provider_status ?? "")) return "SUSPENDED";
  if (b.stage === "LIVE") return "LIVE";
  return "ONBOARDING";
}

export interface CallbackHealth { code: string; last_status: string | null; last_at: string | null; last_error: string | null; dead_24h: number; delivered_24h: number }

/** The last pay-in callback to each banker (7 days) and its last 24 hours, from webhook_outbox. */
export async function callbackHealth(codes: string[], livemode: boolean): Promise<Map<string, CallbackHealth>> {
  if (!codes.length) return new Map();
  const r = await orNone(rows<Record<string, string | null>>("notification", `
    WITH w AS (
      SELECT merchant_id, status, created_at, delivered_at, dead_lettered_at, last_error
        FROM webhook_outbox
       WHERE merchant_id = ANY($1::text[]) AND created_at > now() - interval '7 days'
         AND COALESCE(livemode, true) = $2 AND NOT COALESCE(is_test, false)
         AND event_type NOT LIKE 'payout%' AND event_type NOT LIKE 'settlement%' AND event_type NOT LIKE 'refund%'
    ), last AS (
      SELECT DISTINCT ON (merchant_id) merchant_id, status, COALESCE(delivered_at, dead_lettered_at, created_at) AS at, last_error
        FROM w ORDER BY merchant_id, created_at DESC
    )
    SELECT l.merchant_id, l.status, l.at::text AS at, left(l.last_error, 200) AS last_error,
           (SELECT COUNT(*) FROM w WHERE w.merchant_id = l.merchant_id AND w.status = 'DEAD_LETTER' AND w.created_at > now() - interval '24 hours')::text AS dead,
           (SELECT COUNT(*) FROM w WHERE w.merchant_id = l.merchant_id AND w.status = 'DELIVERED' AND w.created_at > now() - interval '24 hours')::text AS ok
      FROM last l`, [codes, livemode]));
  return new Map(r.map((x) => [x.merchant_id!, {
    code: x.merchant_id!, last_status: x.status, last_at: x.at ? new Date(x.at).toISOString() : null,
    last_error: x.last_error, dead_24h: n(x.dead), delivered_24h: n(x.ok),
  }]));
}

// ── Intent ───────────────────────────────────────────────────────────────────────

export interface IntentBankerRow {
  code: string; id: string | null; name: string; provider_id: string | null; provider_name: string | null;
  state: ReturnType<typeof bankerState>;
  gateways: string[]; gateway_mids: number;
  orders_24h: number; paid_24h: number; failed_24h: number; expired_24h: number; pending_24h: number;
  success_24h: number | null; median_confirm_min: number | null;
  paid_today: number; lost_today: number;
  callback: CallbackHealth | null;
}

export interface IntentDashboard {
  livemode: boolean; banker: string | null; as_of: string;
  kpi: { initiated: number; paid: number; failed: number; expired: number; pending: number; success_rate: number | null; median_confirm_min: number | null; create_failures: number | null; paid_amount: number };
  hourly: HourPoint[];
  failures: { key: PayinFailureBucket; n: number }[];
  bankers: IntentBankerRow[];
  low_merchants: { provider_id: string; provider_name: string; orders: number; paid: number; ended: number; rate: number | null }[];
}

export async function intentDashboard(livemode: boolean, banker: string | null): Promise<IntentDashboard> {
  const args: unknown[] = [livemode];
  let scope = "";
  if (banker) { args.push(banker); scope = `AND p.merchant_id = $${args.length}`; }
  const base = `FROM vendor_payin_orders p LEFT JOIN katana_intent_orders i ON i.order_id = p.id
     WHERE p.vendor = 'KATANA' AND p.channel_type = 'INTENT' AND p.livemode = $1 ${scope}`;
  const confirmMin = `EXTRACT(EPOCH FROM (COALESCE(i.confirmed_at, p.updated_at) - p.created_at)) / 60.0`;

  const [kpi, hourly, byBanker, reasons, createFails, mids, dir] = await Promise.all([
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT COUNT(*)::text AS initiated,
             COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid,
             COUNT(*) FILTER (WHERE p.status = 'FAILED')::text AS failed,
             COUNT(*) FILTER (WHERE p.status = 'EXPIRED')::text AS expired,
             COUNT(*) FILTER (WHERE NOT p.${ENDED_SQL})::text AS pending,
             COALESCE(SUM(p.amount) FILTER (WHERE p.${PAID_SQL}), 0)::text AS paid_amount,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${confirmMin}) FILTER (WHERE p.${PAID_SQL}))::text AS median_min
        ${base} AND p.created_at >= ${IST_TODAY}`, args),
    rows<Record<string, string>>("vendorGateway", `
      SELECT ${IST_HOUR("p.created_at")}::text AS hour, COUNT(*)::text AS orders,
             COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid, COUNT(*) FILTER (WHERE p.${ENDED_SQL})::text AS ended
        ${base} AND p.created_at > now() - interval '24 hours' GROUP BY 1`, args),
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT p.merchant_id AS code, COUNT(*)::text AS orders,
             COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid,
             COUNT(*) FILTER (WHERE p.status = 'FAILED')::text AS failed,
             COUNT(*) FILTER (WHERE p.status = 'EXPIRED')::text AS expired,
             COUNT(*) FILTER (WHERE NOT p.${ENDED_SQL})::text AS pending,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${confirmMin}) FILTER (WHERE p.${PAID_SQL}))::text AS median_min,
             COUNT(*) FILTER (WHERE p.${PAID_SQL} AND p.created_at >= ${IST_TODAY})::text AS paid_today,
             COUNT(*) FILTER (WHERE p.${LOST_SQL} AND p.created_at >= ${IST_TODAY})::text AS lost_today,
             COUNT(*) FILTER (WHERE p.created_at > now() - interval '1 hour')::text AS orders_1h,
             COUNT(*) FILTER (WHERE p.created_at > now() - interval '1 hour' AND p.${PAID_SQL})::text AS paid_1h,
             COUNT(*) FILTER (WHERE p.created_at > now() - interval '1 hour' AND p.${ENDED_SQL})::text AS ended_1h,
             array_remove(array_agg(DISTINCT upper(i.gateway)), NULL) AS gateways
        ${base} AND p.created_at > now() - interval '24 hours' AND p.merchant_id IS NOT NULL
       GROUP BY p.merchant_id ORDER BY COUNT(*) DESC LIMIT 500`, args),
    rows<{ status: string; reason: string | null; n: string }>("vendorGateway", `
      SELECT p.status, left(COALESCE(p.meta->'gateway'->>'error', p.meta->>'error', p.response_code), 120) AS reason, COUNT(*)::text AS n
        ${base} AND p.created_at >= ${IST_TODAY} AND p.${LOST_SQL} GROUP BY 1, 2 LIMIT 500`, args),
    // Gateway accounts that could not create an order (MID switch). Only live orders use the switch.
    livemode
      ? orNone(rows<{ n: string }>("vendorGateway", `
          SELECT COUNT(*)::text AS n FROM payin_mid_events
           WHERE action = 'CREATE_FAILED' AND at >= ${IST_TODAY} ${banker ? "AND banker_code = $1" : ""}`, banker ? [banker] : []))
      : Promise.resolve(null),
    orNone(rows<{ code: string; n: string }>("vendorGateway", `
      SELECT banker_code AS code, COUNT(*)::text AS n FROM payin_mids
       WHERE kind = 'GATEWAY' AND status <> 'DISABLED' GROUP BY 1`)),
    bankerDirectory(),
  ]);

  const k = kpi[0] ?? {};
  const createFailures = createFails == null ? null : n(createFails[0]?.n);
  const reasonKeys: PayinFailureBucket[] = [], weights: number[] = [];
  for (const r of reasons) { reasonKeys.push(payinFailureBucket(r.status, r.reason)); weights.push(n(r.n)); }
  if (createFailures) { reasonKeys.push("CREATE_FAILED"); weights.push(createFailures); }
  const midCount = new Map(mids.map((m) => [m.code, n(m.n)]));
  const codes = byBanker.map((b) => b.code!);
  const cb = await callbackHealth(codes, livemode);

  const bankers: IntentBankerRow[] = byBanker.map((b) => {
    const info = dir.get(b.code!);
    const paid = n(b.paid), failed = n(b.failed), expired = n(b.expired);
    return {
      code: b.code!, id: info?.id ?? null, name: info?.name ?? b.code!, provider_id: info?.provider_id ?? null, provider_name: info?.provider_name ?? null,
      state: bankerState(info),
      gateways: (b.gateways as unknown as string[] | null) ?? [], gateway_mids: midCount.get(b.code!) ?? 0,
      orders_24h: n(b.orders), paid_24h: paid, failed_24h: failed, expired_24h: expired, pending_24h: n(b.pending),
      success_24h: successRate(paid, paid + failed + expired), median_confirm_min: nn(b.median_min),
      paid_today: n(b.paid_today), lost_today: n(b.lost_today),
      callback: cb.get(b.code!) ?? null,
    };
  });

  const merchantOf = new Map<string, { id: string; name: string }>();
  for (const b of bankers) if (b.provider_id) merchantOf.set(b.code, { id: b.provider_id, name: b.provider_name ?? b.provider_id });
  const lastHour = byBanker.map((b) => ({ code: b.code!, orders: n(b.orders_1h), paid: n(b.paid_1h), ended: n(b.ended_1h) }));

  const paid = n(k.paid), failed = n(k.failed), expired = n(k.expired);
  return {
    livemode, banker, as_of: new Date().toISOString(),
    kpi: {
      initiated: n(k.initiated), paid, failed, expired, pending: n(k.pending), paid_amount: n(k.paid_amount),
      success_rate: successRate(paid, paid + failed + expired), median_confirm_min: nn(k.median_min), create_failures: createFailures,
    },
    hourly: hourlySeries(hourly.map((h) => ({ hour: h.hour, orders: n(h.orders), paid: n(h.paid), ended: n(h.ended) })), new Date()),
    failures: countBuckets(reasonKeys, ["EXPIRED_UNPAID", "FAILED_AT_GATEWAY", "CREATE_FAILED", "OTHER"] as const, weights),
    bankers,
    low_merchants: lowSuccessMerchants(rollUpToMerchants(lastHour, merchantOf)),
  };
}

