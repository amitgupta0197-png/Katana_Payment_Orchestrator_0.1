// How each pay-in gateway is doing, from the orders it actually took (katana_intent_orders and
// their outcome on vendor_payin_orders). STAFF ONLY: this names gateways, so it goes to the
// admin dashboard and the admin Telegram chats and never to a merchant (lib/merchant-safe).
//
// Two figures per gateway:
//
//   the window        every live order created in the last N hours: counts, paid amount and the
//                     success rate among those that reached an end
//   the last orders   the success rate of its most recent ended orders (50 by default) — the
//                     figure the health check watches, because it moves when a gateway starts
//                     failing even if the day as a whole still looks fine
//
// An order "ended" when it is paid, failed or expired. An expired order counts against the
// gateway: a customer who could not complete the payment is what a failing gateway looks like.
// It is also what an uninterested customer looks like, so the threshold is a prompt to look.
//
// WHAT THIS DOES NOT DO. It does not move traffic. Every merchant has one pay-in gateway, so
// there is nowhere to move an order to; when a gateway is unhealthy a person is told
// (gateway:health:<GATEWAY> through lib/ops-alert) and decides.

import { rows } from "@/lib/pg";
import { setAlert } from "@/lib/ops-alert";

export interface GatewayPerformance {
  gateway: string;
  orders: number;
  paid: number;
  failed: number;
  expired: number;
  pending: number;
  paid_amount: number;
  /** Paid over ended, 0 to 1; null when nothing has ended. */
  success_rate: number | null;
  /** The same over its most recent ended orders, and how many that is. */
  recent_rate: number | null;
  recent_sample: number;
}

const rate = (paid: number, ended: number) => (ended ? Math.round((paid / ended) * 10_000) / 10_000 : null);

export const HEALTH_SAMPLE = Number(process.env.GATEWAY_HEALTH_SAMPLE ?? 50);
export const HEALTH_MIN_SAMPLE = Number(process.env.GATEWAY_HEALTH_MIN_SAMPLE ?? 20);
export const HEALTH_MIN_RATE = Number(process.env.GATEWAY_HEALTH_MIN_RATE ?? 0.65);

export async function gatewayPerformance(hours = 24): Promise<GatewayPerformance[]> {
  const r = await rows<Record<string, string>>("vendorGateway", `
    WITH o AS (
      SELECT upper(i.gateway) AS gateway, p.status, p.amount, p.created_at,
             p.status IN ('SUCCESS','SUCCEEDED') AS paid,
             p.status IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED') AS ended
        FROM katana_intent_orders i JOIN vendor_payin_orders p ON p.id = i.order_id
       WHERE i.livemode AND i.gateway IS NOT NULL AND p.created_at > now() - make_interval(hours => $1::int)
    ),
    recent AS (
      SELECT gateway, COUNT(*) AS n, COUNT(*) FILTER (WHERE paid) AS paid FROM (
        SELECT gateway, paid, ROW_NUMBER() OVER (PARTITION BY gateway ORDER BY created_at DESC) AS rn
          FROM o WHERE ended) x
       WHERE rn <= $2::int GROUP BY 1
    )
    SELECT o.gateway, COUNT(*)::text AS orders,
           COUNT(*) FILTER (WHERE o.paid)::text AS paid,
           COUNT(*) FILTER (WHERE o.status = 'FAILED')::text AS failed,
           COUNT(*) FILTER (WHERE o.status = 'EXPIRED')::text AS expired,
           COUNT(*) FILTER (WHERE NOT o.ended)::text AS pending,
           COALESCE(SUM(o.amount) FILTER (WHERE o.paid), 0)::text AS paid_amount,
           COALESCE(r.n, 0)::text AS recent_n, COALESCE(r.paid, 0)::text AS recent_paid
      FROM o LEFT JOIN recent r USING (gateway)
     GROUP BY o.gateway, r.n, r.paid ORDER BY COUNT(*) DESC
  `, [hours, HEALTH_SAMPLE]);
  return r.map((x) => {
    const paid = Number(x.paid), failed = Number(x.failed), expired = Number(x.expired);
    return {
      gateway: x.gateway, orders: Number(x.orders), paid, failed, expired, pending: Number(x.pending),
      paid_amount: Number(x.paid_amount), success_rate: rate(paid, paid + failed + expired),
      recent_rate: rate(Number(x.recent_paid), Number(x.recent_n)), recent_sample: Number(x.recent_n),
    };
  });
}

/** A gateway is unhealthy when enough of its recent orders ended and too few of them were paid. Pure. */
export function isUnhealthy(g: Pick<GatewayPerformance, "recent_rate" | "recent_sample">, minRate = HEALTH_MIN_RATE, minSample = HEALTH_MIN_SAMPLE): boolean {
  return g.recent_sample >= minSample && g.recent_rate != null && g.recent_rate < minRate;
}

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

/** Raise or clear the health alert of every gateway that took orders in the last day. */
export async function checkGatewayHealth(): Promise<{ gateways: number; unhealthy: string[] }> {
  const perf = await gatewayPerformance(24);
  const unhealthy: string[] = [];
  for (const g of perf) {
    const bad = isUnhealthy(g);
    if (bad) unhealthy.push(g.gateway);
    await setAlert(bad, {
      key: `gateway:health:${g.gateway}`, severity: "CRITICAL", repeatMinutes: 360,
      title: `${g.gateway}: ${pct(g.recent_rate)} of its last ${g.recent_sample} orders were paid`,
      body: `Below the ${pct(HEALTH_MIN_RATE)} line. Last 24 hours: ${g.paid} paid, ${g.failed} failed, ${g.expired} expired. No traffic is moved automatically: its merchants have no other gateway.`,
    });
  }
  return { gateways: perf.length, unhealthy };
}

export interface PlatformSummary {
  date: string;
  payins: { flow: string; orders: number; paid: number; paid_amount: number; success_rate: number | null }[];
  payouts: { paid: number; paid_amount: number; pending: number };
  open: { manual_cases: number; compliance_flags: number; ops_alerts: number; dead_letter_callbacks_24h: number };
}

/** The platform's day so far (India time): live pay-ins by flow, payouts, and what is waiting on a person. */
export async function platformSummary(): Promise<PlatformSummary> {
  const DAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  const one = async <T,>(p: Promise<T[]>, fallback: T): Promise<T> => (await p.catch(() => []))[0] ?? fallback;
  const [date, payins, payouts, cases, flags, alerts, dlq] = await Promise.all([
    one(rows<{ d: string }>("vendorGateway", `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`), { d: "" }),
    rows<Record<string, string>>("vendorGateway", `
      SELECT COALESCE(channel_type, 'OTHER') AS flow, COUNT(*)::text AS orders,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED'))::text AS paid,
             COUNT(*) FILTER (WHERE status IN ('FAILED','EXPIRED'))::text AS lost,
             COALESCE(SUM(amount) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED')), 0)::text AS paid_amount
        FROM vendor_payin_orders WHERE vendor = 'KATANA' AND livemode AND created_at >= ${DAY} GROUP BY 1 ORDER BY 1`).catch(() => []),
    one(rows<Record<string, string>>("fifo", `
      SELECT COUNT(*) FILTER (WHERE status IN ('COMPLETED','SETTLED'))::text AS paid,
             COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('COMPLETED','SETTLED')), 0)::text AS paid_minor,
             COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','SETTLED','FAILED','REJECTED','CANCELLED','REFUND','REVERSED'))::text AS pending
        FROM fifo_orders WHERE direction = 'PAYOUT' AND livemode AND created_at >= ${DAY}`), { paid: "0", paid_minor: "0", pending: "0" }),
    one(rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int AS n FROM vendor_manual_cases WHERE status = 'OPEN' AND reason <> 'UNMATCHED' AND created_at > now() - interval '7 days'`), { n: 0 }),
    one(rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int AS n FROM payin_compliance_flags WHERE status = 'OPEN' AND severity <> 'INFO'`), { n: 0 }),
    one(rows<{ n: number }>("audit", `SELECT COUNT(*)::int AS n FROM ops_alerts WHERE resolved_at IS NULL`), { n: 0 }),
    one(rows<{ n: number }>("notification", `SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE status = 'DEAD_LETTER' AND dead_lettered_at > now() - interval '24 hours'`), { n: 0 }),
  ]);
  return {
    date: date.d,
    payins: payins.map((p) => ({
      flow: p.flow, orders: Number(p.orders), paid: Number(p.paid), paid_amount: Number(p.paid_amount),
      success_rate: rate(Number(p.paid), Number(p.paid) + Number(p.lost)),
    })),
    payouts: { paid: Number(payouts.paid), paid_amount: Number(payouts.paid_minor) / 100, pending: Number(payouts.pending) },
    open: { manual_cases: cases.n, compliance_flags: flags.n, ops_alerts: alerts.n, dead_letter_callbacks_24h: dlq.n },
  };
}
