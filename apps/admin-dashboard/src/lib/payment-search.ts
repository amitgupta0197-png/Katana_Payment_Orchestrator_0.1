// Finding a payment from whatever a merchant has in hand: a txnid, Katana's order id, a UTR, an
// amount or the customer's phone number. Used by the portals' search (GET /api/portal/find) and
// by the support assistant's find_payment lookup, so both trace a payment the same way.
//
// Always limited to the bankers in `codes` (lib/portal-scope). Money seen arriving is read only
// from rows tagged with one of those bankers: a UPI ID can be shared between bankers, so an
// untagged row is not known to be theirs.

import { rows } from "@/lib/pg";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { orderTimeline, searchOrders } from "@/lib/order-timeline";
import { classifyQuery, creditStory, orderStory, type QueryKind, type StoryCredit } from "@/lib/payment-story";
import { plainPaymentStatus, type PlainStatus } from "@/lib/plain-words";

const MIN = 60_000;

export interface CreditRow { id: string; merchant_id: string; amount: number; utr: string | null; outcome: string; matched_order_id: string | null; event_time: string | null; created_at: string; livemode: boolean | null }
export interface OrderRow { id: string; order_id: string; status: string; amount: number; merchant_id: string; channel_type: string | null; livemode: boolean | null; created_at: string; updated_at: string; rrn: string | null }

/**
 * Money seen arriving and orders that fit: by UTR (exactly), by amount in a time window, by the
 * customer's phone, or orders that money was matched to.
 */
export async function traceRows(codes: string[], q: {
  utr?: string | null; amount?: number | null; phone?: string | null;
  from: Date; to: Date; orderFrom?: Date; orderTo?: Date;
}): Promise<{ credits: CreditRow[]; orders: OrderRow[] }> {
  if (!codes.length) return { credits: [], orders: [] };
  const utr = q.utr || null, amount = q.amount ?? null, phone = q.phone || null;
  const credits = (utr || amount) ? await rows<CreditRow>("vendorGateway", `
    SELECT id::text, merchant_id, amount::float AS amount, utr, outcome, matched_order_id::text, event_time, created_at, livemode
      FROM vendor_txn_alerts
     WHERE direction = 'CREDIT' AND ${IS_COLLECTION}
       AND merchant_id = ANY($1::text[])
       AND (($2::text IS NOT NULL AND utr = $2)
            OR ($3::numeric IS NOT NULL AND amount = $3 AND COALESCE(event_time, created_at) BETWEEN $4 AND $5))
     ORDER BY (utr = $2) DESC NULLS LAST, COALESCE(event_time, created_at) DESC
     LIMIT 10
  `, [codes, utr, amount, q.from, q.to]).catch(() => []) : [];
  const orders = await rows<OrderRow>("vendorGateway", `
    SELECT id::text, order_id, status, amount::float AS amount, merchant_id, channel_type, livemode, created_at, updated_at, rrn
      FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND merchant_id = ANY($1::text[])
       AND (($2::text IS NOT NULL AND rrn = $2)
            OR ($3::numeric IS NOT NULL AND amount = $3 AND created_at BETWEEN $4 AND $5)
            OR ($7::text IS NOT NULL AND right(regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g'), 10) = $7 AND created_at > now() - interval '30 days')
            OR id::text = ANY($6::text[]))
     ORDER BY (rrn = $2) DESC NULLS LAST, created_at DESC
     LIMIT 10
  `, [codes, utr, amount, q.orderFrom ?? new Date(q.from.getTime() - 30 * MIN), q.orderTo ?? q.to,
      credits.map((c) => c.matched_order_id).filter(Boolean), phone]).catch(() => []);
  return { credits, orders };
}

export interface FoundPayment {
  kind: "order" | "money";
  id: string;
  /** The merchant's own reference (txnid), when it is an order. */
  txnid: string | null;
  amount: number;
  status: PlainStatus;
  /** The v2 status, for code that needs it (the "customer says they paid" button). */
  raw_status: string | null;
  livemode: boolean;
  at: string;
  account: string | null;
  utr: string | null;
  story: string[];
}

/** Search for a merchant: every match with its story, newest first. */
export async function searchPayments(raw: string, codes: string[], names: Record<string, string> = {}): Promise<{ kinds: QueryKind[]; results: FoundPayment[] }> {
  const { kinds, value, amount } = classifyQuery(raw);
  if (!codes.length || value.length < 3 && !amount) return { kinds, results: [] };
  const now = new Date();
  const scope = { staff: false, codes };
  const account = (code: string | null) => (codes.length > 1 && code ? `${names[code] ?? code} (${code})` : null);

  const ids = new Set<string>();
  if (kinds.includes("reference")) for (const h of await searchOrders(value, scope)) ids.add(h.id);
  const traced = await traceRows(codes, {
    utr: kinds.includes("utr") ? value : null,
    phone: kinds.includes("phone") ? value : null,
    amount: kinds.includes("amount") ? amount : null,
    from: new Date(now.getTime() - 3 * 24 * 60 * MIN), to: now,
  });
  for (const o of traced.orders) ids.add(o.id);
  // Money no order was matched to: the order it most likely paid for is one of the same amount
  // that expired or failed in the two hours before it arrived.
  for (const c of traced.credits.filter((x) => !x.matched_order_id).slice(0, 3)) {
    const t = new Date(c.event_time ?? c.created_at);
    const likely = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id = $1 AND amount = $2 AND status IN ('EXPIRED', 'FAILED')
         AND created_at BETWEEN $3::timestamptz - interval '2 hours' AND $3::timestamptz
       ORDER BY created_at DESC LIMIT 1`, [c.merchant_id, c.amount, t]).catch(() => []);
    if (likely[0]) ids.add(likely[0].id);
  }

  const results: FoundPayment[] = [];
  const explained = new Set<string>();
  for (const id of [...ids].slice(0, 8)) {
    const t = await orderTimeline(id, scope);
    if (!t) continue;
    const o = t.order;
    // Money of the same amount for the same banker, from the order's start to two hours later.
    const near = await rows<CreditRow>("vendorGateway", `
      SELECT id::text, merchant_id, amount::float AS amount, utr, outcome, matched_order_id::text, event_time, created_at, livemode
        FROM vendor_txn_alerts
       WHERE direction = 'CREDIT' AND ${IS_COLLECTION} AND merchant_id = $1 AND amount = $2
         AND COALESCE(event_time, created_at) BETWEEN $3 AND $3::timestamptz + interval '2 hours'
         AND (matched_order_id IS NULL OR matched_order_id = $4::uuid)
       ORDER BY COALESCE(event_time, created_at) LIMIT 3
    `, [o.merchant_id, o.amount, o.created_at, o.id]).catch(() => []);
    near.forEach((c) => explained.add(c.id));
    const credits: StoryCredit[] = near.map((c) => ({ amount: c.amount, utr: c.utr, paid_at: new Date(c.event_time ?? c.created_at).toISOString(), linked: c.matched_order_id === o.id }));
    results.push({
      kind: "order", id: o.id, txnid: o.reference, amount: o.amount, status: plainPaymentStatus(o.status), raw_status: o.status,
      livemode: o.livemode, at: o.created_at, account: account(o.merchant_id), utr: o.rrn_is_synthetic ? null : o.rrn,
      story: orderStory({
        txnid: o.reference, amount: o.amount, status: o.status, created_at: o.created_at, expires_at: o.expires_at,
        paid_at: o.paid_at, livemode: o.livemode, rrn: o.rrn, rrn_is_synthetic: o.rrn_is_synthetic,
      }, t.steps, credits, t.deliveries.map((d) => ({
        status: d.status, next_attempt_at: d.next_attempt_at,
        attempts: d.attempts.map((a) => ({ at: a.sent_at, http_status: a.http_status, error: a.error })),
      })), now),
    });
  }
  const orderTxn = new Map(traced.orders.map((o) => [o.id, o.order_id]));
  for (const c of traced.credits) {
    if (explained.has(c.id)) continue;
    const linked = !!c.matched_order_id;
    results.push({
      kind: "money", id: c.id, txnid: null, amount: c.amount,
      status: linked ? plainPaymentStatus("SUCCESS") : { word: "Not linked", tone: "warning", meaning: "Money arrived but no order is linked to it." },
      raw_status: null, livemode: c.livemode !== false, at: new Date(c.event_time ?? c.created_at).toISOString(),
      account: account(c.merchant_id), utr: c.utr,
      story: creditStory({ amount: c.amount, utr: c.utr, paid_at: new Date(c.event_time ?? c.created_at).toISOString(), linked, order_txnid: c.matched_order_id ? orderTxn.get(c.matched_order_id) ?? null : null }, now),
    });
  }
  results.sort((a, b) => b.at.localeCompare(a.at));
  return { kinds, results };
}
