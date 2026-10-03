// Linking a captured payment to an order by hand (lib/credit-link for which orders qualify).
//
// The order is confirmed through confirmKatanaOrder, the one path every confirmation takes, with the
// payment's own bank reference; the payment is then marked as that order's, and both are audited.
// Live only: a captured credit is live money and may only settle a live order.

import { rows } from "@/lib/pg";
import { confirmKatanaOrder } from "@/lib/katana-order";
import { LINK_WINDOW_MIN, possibleOrders, type LinkableOrder } from "@/lib/credit-link";

/** Open, unpaid P2P orders of this banker that a payment in the last two days could belong to. */
export async function openOrdersForLinking(code: string): Promise<LinkableOrder[]> {
  return rows<LinkableOrder>("vendorGateway", `
    SELECT o.id::text, o.order_id, o.amount::float AS amount, o.created_at, o.status
      FROM vendor_payin_orders o
     WHERE o.vendor = 'KATANA' AND o.merchant_id = $1 AND o.livemode = true AND o.channel_type = 'P2P'
       AND o.status NOT IN ('SUCCESS', 'SUCCEEDED', 'FAILED')
       AND COALESCE(o.meta->'gateway'->>'provider', '') = ''
       AND COALESCE(o.rrn, '') = ''
       AND o.created_at > now() - interval '2 days' - make_interval(mins => $2::int)
       AND NOT EXISTS (SELECT 1 FROM vendor_txn_alerts a WHERE a.matched_order_id = o.id AND a.outcome = 'CONFIRMED')
     ORDER BY o.created_at DESC LIMIT 200
  `, [code, LINK_WINDOW_MIN]);
}

export class LinkError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function linkCreditToOrder(input: { code: string; alertId: string; orderId: string; actor: string }) {
  const alert = (await rows<{ id: string; amount: number; utr: string | null; received_at: string; matched: string | null; outcome: string }>("vendorGateway", `
    SELECT id::text, amount::float AS amount, NULLIF(utr, '') AS utr, COALESCE(event_time, created_at) AS received_at,
           matched_order_id::text AS matched, outcome
      FROM vendor_txn_alerts
     WHERE id = $1::uuid AND merchant_id = $2 AND direction = 'CREDIT' AND livemode = true
  `, [input.alertId, input.code]))[0];
  if (!alert) throw new LinkError(404, "payment not found");
  if (alert.matched && alert.outcome === "CONFIRMED") throw new LinkError(409, "this payment is already linked to an order");
  if (alert.outcome === "DUPLICATE") throw new LinkError(409, "this payment is a duplicate of another; link the original");

  // Only an order the payment could belong to: same banker, amount and window as the reconciler uses.
  const order = possibleOrders(alert, await openOrdersForLinking(input.code)).find((o) => o.id === input.orderId);
  if (!order) throw new LinkError(409, "that order is not open for this payment (amount, time or already paid)");

  const r = await confirmKatanaOrder({
    id: order.id, outcome: "SUCCESS", utr: alert.utr, livemode: true,
    evidence: alert.utr ? "UTR" : "MANUAL", actor: input.actor,
    note: `linked by staff to captured payment ${alert.id}`,
  });
  if (!r.ok) throw new LinkError(r.status, r.error ?? "the order could not be confirmed");

  await rows("vendorGateway", `
    UPDATE vendor_txn_alerts
       SET matched_order_id = $2::uuid, matched_order_ref = $3, outcome = 'CONFIRMED', match_confidence = 100,
           detail = COALESCE(detail, '') || ' · linked to ' || $3 || ' by ' || $4
     WHERE id = $1::uuid
  `, [alert.id, order.id, order.order_id, input.actor]);
  await rows("vendorGateway", `
    INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail) VALUES ($1, 'CREDIT_LINKED', 'txn_alert', $2, $3)
  `, [input.actor, alert.id, `${order.order_id} ₹${Number(alert.amount).toFixed(2)} utr ${alert.utr ?? "-"}`]).catch(() => {});
  return { order: r.order, order_id: order.order_id };
}
