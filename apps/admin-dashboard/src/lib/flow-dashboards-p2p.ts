// Flow dashboards: the P2P pay-in dashboard (/flows/p2p). STAFF ONLY, read-only.
// P2P = the customer pays the banker's own UPI ID and a bank credit proves it. Money that came
// in with no order is read through lib/merchant-credits (live only: a credit is real money).

import { rows } from "@/lib/pg";
import { PENDING_EXPIRY_SECONDS } from "@/lib/katana-pay";
import { vpasFromConfig } from "@/lib/settlement-vpa";
import { unlinkedCredits } from "@/lib/merchant-credits";
import { expiryBuckets, hourlySeries, successRate, type ExpiryBuckets, type HourPoint } from "@/lib/flow-dashboards";
import { bankerDirectory, bankerState, ENDED_SQL, IST_HOUR, IST_TODAY, orNone, PAID_SQL } from "@/lib/flow-dashboards-store";

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const IST_MS = 5.5 * 3600_000;
/** The IST calendar date `daysBack` days before `now`, as YYYY-MM-DD. */
export const istDate = (now: Date, daysBack = 0) => new Date(now.getTime() + IST_MS - daysBack * 86_400_000).toISOString().slice(0, 10);

export interface UpiIdRow {
  banker: string; upi_id: string; source: "MID" | "SETTLEMENT"; status: string;
  orders_today: number; paid_today: number; amount_today: number;
  daily_amount: number | null; daily_count: number | null;
  /** Use against the tighter of its day limits, 0 to 1; null without a limit. */
  use: number | null;
}

export interface P2pBankerRow {
  code: string; id: string | null; name: string; provider_name: string | null; state: ReturnType<typeof bankerState>;
  upi_ids: number; orders: number; paid: number; lost: number; pending: number; success: number | null;
  unmatched_count: number; unmatched_amount: number;
}

export interface P2pDashboard {
  livemode: boolean; banker: string | null; as_of: string;
  kpi: { deposits: number; credited: number; pending: number; expired: number; failed: number; paid_amount: number; avg_credit_min: number | null; active_upi_ids: number };
  hourly: HourPoint[];
  pending_by_expiry: ExpiryBuckets;
  upi_ids: UpiIdRow[];
  bankers: P2pBankerRow[];
  recon: {
    unmatched: { count: number; amount: number; rows: { banker: string; amount: number; utr: string | null; at: string; status: string }[] };
    stale: { count: number; rows: { id: string; order_id: string; banker: string; amount: number; created_at: string; payee_vpa: string | null }[] };
  };
}

export async function p2pDashboard(livemode: boolean, banker: string | null): Promise<P2pDashboard> {
  const args: unknown[] = [livemode];
  let scope = "";
  if (banker) { args.push(banker); scope = `AND p.merchant_id = $${args.length}`; }
  const base = `FROM vendor_payin_orders p LEFT JOIN katana_p2p_orders k ON k.order_id = p.id
     WHERE p.vendor = 'KATANA' AND p.channel_type = 'P2P' AND p.livemode = $1 ${scope}`;
  const now = new Date();

  const [kpi, hourly, pending, byBanker, byVpa, mids, stale, staleCount, dir] = await Promise.all([
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT COUNT(*)::text AS deposits, COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS credited,
             COUNT(*) FILTER (WHERE NOT p.${ENDED_SQL})::text AS pending,
             COUNT(*) FILTER (WHERE p.status = 'EXPIRED')::text AS expired,
             COUNT(*) FILTER (WHERE p.status = 'FAILED')::text AS failed,
             COALESCE(SUM(p.amount) FILTER (WHERE p.${PAID_SQL}), 0)::text AS paid_amount,
             (AVG(EXTRACT(EPOCH FROM (COALESCE(k.confirmed_at, p.updated_at) - p.created_at)) / 60.0) FILTER (WHERE p.${PAID_SQL}))::text AS avg_min
        ${base} AND p.created_at >= ${IST_TODAY}`, args),
    rows<Record<string, string>>("vendorGateway", `
      SELECT ${IST_HOUR("p.created_at")}::text AS hour, COUNT(*)::text AS orders,
             COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid, COUNT(*) FILTER (WHERE p.${ENDED_SQL})::text AS ended
        ${base} AND p.created_at > now() - interval '24 hours' GROUP BY 1`, args),
    rows<{ left_s: string }>("vendorGateway", `
      SELECT (EXTRACT(EPOCH FROM (p.created_at + make_interval(secs => ${PENDING_EXPIRY_SECONDS}) - now())))::text AS left_s
        ${base} AND NOT p.${ENDED_SQL} AND p.created_at > now() - interval '3 days' LIMIT 5000`, args),
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT p.merchant_id AS code, COUNT(*)::text AS orders, COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid,
             COUNT(*) FILTER (WHERE p.status IN ('FAILED','EXPIRED'))::text AS lost,
             COUNT(*) FILTER (WHERE NOT p.${ENDED_SQL})::text AS pending
        ${base} AND p.created_at >= ${IST_TODAY} AND p.merchant_id IS NOT NULL
       GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 500`, args),
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT p.merchant_id AS code, lower(k.payee_vpa) AS vpa, COUNT(*)::text AS orders,
             COUNT(*) FILTER (WHERE p.${PAID_SQL})::text AS paid,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status NOT IN ('FAILED','EXPIRED')), 0)::text AS amount
        ${base} AND p.created_at >= ${IST_TODAY} AND k.payee_vpa IS NOT NULL GROUP BY 1, 2 LIMIT 2000`, args),
    orNone(rows<Record<string, string | null>>("vendorGateway", `
      SELECT banker_code AS code, lower(upi_id) AS vpa, status, daily_amount::text AS daily_amount, daily_count::text AS daily_count
        FROM payin_mids WHERE kind = 'UPI' AND upi_id IS NOT NULL ${banker ? "AND banker_code = $1" : ""} LIMIT 2000`, banker ? [banker] : [])),
    // Waiting over 30 minutes with no bank reference from any credit or proof: a credit may be unmatched.
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT p.id::text AS id, p.order_id, p.merchant_id AS banker, p.amount::text AS amount, p.created_at::text AS created_at, k.payee_vpa
        ${base} AND p.status = 'PENDING' AND p.created_at BETWEEN now() - interval '3 days' AND now() - interval '30 minutes'
         AND k.utr IS NULL AND k.proof_utr IS NULL
       ORDER BY p.created_at LIMIT 20`, args),
    rows<{ c: string }>("vendorGateway", `
      SELECT COUNT(*)::text AS c ${base} AND p.status = 'PENDING' AND p.created_at BETWEEN now() - interval '3 days' AND now() - interval '30 minutes'
         AND k.utr IS NULL AND k.proof_utr IS NULL`, args),
    bankerDirectory(),
  ]);

  // Settlement UPI IDs of every banker that took P2P orders today or has UPI MIDs (or the one filtered to).
  const codes = [...new Set([...byBanker.map((b) => b.code!), ...mids.map((m) => m.code!), ...(banker ? [banker] : [])])];
  const cfg = codes.length ? await rows<{ code: string; katana_pay: unknown }>("merchant",
    `SELECT merchant_code AS code, katana_pay FROM merchant_payment_config WHERE merchant_code = ANY($1::text[])`, [codes]) : [];
  const credits = await unlinkedCredits({ codes: banker ? [banker] : null, from: istDate(now, 2), to: istDate(now), status: null, livemode }, 2000);

  const use = new Map(byVpa.map((v) => [`${v.code}|${v.vpa}`, v]));
  const upi: UpiIdRow[] = [];
  const seen = new Set<string>();
  for (const m of mids) {
    const key = `${m.code}|${m.vpa}`; seen.add(key);
    const u = use.get(key);
    const amount = n(u?.amount), orders = n(u?.orders);
    const da = m.daily_amount != null ? Number(m.daily_amount) : null, dc = m.daily_count != null ? Number(m.daily_count) : null;
    const shares = [da ? amount / da : null, dc ? orders / dc : null].filter((x): x is number => x != null);
    upi.push({ banker: m.code!, upi_id: m.vpa!, source: "MID", status: m.status ?? "ACTIVE", orders_today: orders, paid_today: n(u?.paid), amount_today: amount,
      daily_amount: da, daily_count: dc, use: shares.length ? Math.round(Math.max(...shares) * 1000) / 1000 : null });
  }
  const vpaCount = new Map<string, number>();
  for (const c of cfg) {
    const vpas = vpasFromConfig(c.katana_pay);
    vpaCount.set(c.code, vpas.length);
    for (const v of vpas) {
      const key = `${c.code}|${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = use.get(key);
      upi.push({ banker: c.code, upi_id: v, source: "SETTLEMENT", status: "ACTIVE", orders_today: n(u?.orders), paid_today: n(u?.paid), amount_today: n(u?.amount), daily_amount: null, daily_count: null, use: null });
    }
  }
  upi.sort((a, b) => (b.use ?? -1) - (a.use ?? -1) || b.amount_today - a.amount_today);

  const unmatchedBy = new Map<string, { c: number; a: number }>();
  for (const c of credits) { const x = unmatchedBy.get(c.merchant_id) ?? { c: 0, a: 0 }; x.c++; x.a += c.amount; unmatchedBy.set(c.merchant_id, x); }
  const midCount = new Map<string, number>();
  for (const m of mids) midCount.set(m.code!, (midCount.get(m.code!) ?? 0) + 1);

  const bankerCodes = [...new Set([...byBanker.map((b) => b.code!), ...unmatchedBy.keys()])].filter((c) => c !== "—");
  const bb = new Map(byBanker.map((b) => [b.code!, b]));
  const bankers: P2pBankerRow[] = bankerCodes.map((code) => {
    const b = bb.get(code), info = dir.get(code), um = unmatchedBy.get(code);
    const paid = n(b?.paid), lost = n(b?.lost);
    return {
      code, id: info?.id ?? null, name: info?.name ?? code, provider_name: info?.provider_name ?? null, state: bankerState(info),
      upi_ids: Math.max(vpaCount.get(code) ?? 0, midCount.get(code) ?? 0),
      orders: n(b?.orders), paid, lost, pending: n(b?.pending), success: successRate(paid, paid + lost),
      unmatched_count: um?.c ?? 0, unmatched_amount: Math.round((um?.a ?? 0) * 100) / 100,
    };
  }).sort((a, b) => b.orders - a.orders || b.unmatched_count - a.unmatched_count);

  const k = kpi[0] ?? {};
  return {
    livemode, banker, as_of: now.toISOString(),
    kpi: {
      deposits: n(k.deposits), credited: n(k.credited), pending: n(k.pending), expired: n(k.expired), failed: n(k.failed),
      paid_amount: n(k.paid_amount), avg_credit_min: k.avg_min != null ? Math.round(Number(k.avg_min) * 10) / 10 : null,
      active_upi_ids: upi.filter((u) => u.status === "ACTIVE").length,
    },
    hourly: hourlySeries(hourly.map((h) => ({ hour: h.hour, orders: n(h.orders), paid: n(h.paid), ended: n(h.ended) })), now),
    pending_by_expiry: expiryBuckets(pending.map((p) => Number(p.left_s))),
    upi_ids: upi.slice(0, 200),
    bankers,
    recon: {
      unmatched: {
        count: credits.length, amount: Math.round(credits.reduce((s, c) => s + c.amount, 0) * 100) / 100,
        rows: credits.slice(0, 20).map((c) => ({ banker: c.merchant_id, amount: c.amount, utr: c.utr, at: c.created_at, status: c.status })),
      },
      stale: {
        count: n(staleCount[0]?.c),
        rows: stale.map((s) => ({ id: s.id!, order_id: s.order_id ?? s.id!, banker: s.banker ?? "—", amount: n(s.amount), created_at: new Date(s.created_at!).toISOString(), payee_vpa: s.payee_vpa })),
      },
    },
  };
}
