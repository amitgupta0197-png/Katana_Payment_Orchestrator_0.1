// Which paid pay-ins the banker has settled to the merchant.
//
// On both rails the customer's money ends up with the banker (INTENT: the gateway pays the
// banker out; P2P: it lands in the banker's own UPI account), and the banker then settles it
// to the merchant through the provider ↔ branch settlement workflow
// (provider_branch_settlements, tools/migrations/provider/0004). So "settled" means the same
// thing on INTENT and P2P: the banker's verified settlements cover this order.
//
// A settlement is a lump sum per banker, not a list of orders, so coverage is DERIVED, and it is
// derived INSIDE A CHANNEL (provider 0020):
//
//   1. a settlement raised for INTENT is applied to the banker's paid INTENT pay-ins oldest first,
//      and one for P2P to its P2P pay-ins. Neither ever covers an order of the other channel.
//   2. a settlement with no channel (every one from before, and one raised for both) is applied
//      to what step 1 left unsettled, oldest first across the channels.
//
// An order is settled when the running total of its queue, up to and including it, fits inside
// what was settled to that queue. Every order covered is settled in its own channel either way,
// so the per-channel settled / unsettled figures always add up to the total.
//
// The two sides live in different databases, so the settlements are read here and handed to
// the pay-in query as arrays (see coverageCte).

import { rows } from "@/lib/pg";
import type { PayinChannel } from "@/lib/payin-channel";

// A settlement the merchant has confirmed receiving. RECONCILED is the step after VERIFIED.
const SETTLED_STATUSES = `('VERIFIED','RECONCILED')`;

/** The channel a settlement was raised for; null = no channel (from before, or both). */
export type SettlementChannel = Extract<PayinChannel, "INTENT" | "P2P"> | null;

export interface BankerSettlement { banker: string; channel: SettlementChannel; amount: number; utr: string | null; at: string }

export interface BankerCoverage {
  /** Every key a pay-in may carry in merchant_id (merchant code or uuid), and the banker it means. */
  keys: string[];
  keyBanker: string[];
  /** What each banker settled to each channel: parallel arrays (banker, channel, total). */
  chBankers: string[];
  chChannels: string[];
  chTotals: number[];
  /** What each banker settled with no channel: parallel arrays (banker, total). */
  restBankers: string[];
  restTotals: number[];
  /** Each queue's verified settlements, oldest first, keyed queueKey(banker, channel). */
  settlements: Map<string, BankerSettlement[]>;
  /** merchant_id on a pay-in → the banker it means. */
  bankerOf: Map<string, string>;
}

export const queueKey = (banker: string, channel: SettlementChannel) => `${banker}|${channel ?? ""}`;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Group settlements into their queues and total each. Pure, so the arithmetic is tested. */
export function buildCoverage(list: BankerSettlement[], bankerOf: Map<string, string>): BankerCoverage {
  const settlements = new Map<string, BankerSettlement[]>();
  for (const s of list) {
    const k = queueKey(s.banker, s.channel);
    settlements.set(k, [...(settlements.get(k) ?? []), s]);
  }
  const ch: [string, string, number][] = [];
  const rest: [string, number][] = [];
  for (const [k, l] of settlements) {
    const total = r2(l.reduce((a, x) => a + x.amount, 0));
    const { banker, channel } = l[0];
    if (channel) ch.push([banker, channel, total]); else rest.push([banker, total]);
  }
  return {
    keys: [...bankerOf.keys()], keyBanker: [...bankerOf.values()],
    chBankers: ch.map((x) => x[0]), chChannels: ch.map((x) => x[1]), chTotals: ch.map((x) => x[2]),
    restBankers: rest.map((x) => x[0]), restTotals: rest.map((x) => x[1]),
    settlements, bankerOf,
  };
}

/**
 * The verified banker settlements in scope. `providerId` narrows to one provider's settlements
 * (a provider's own view); `codes` narrows to those bankers (null = every banker).
 */
export async function bankerCoverage(providerId: string | null, codes: string[] | null): Promise<BankerCoverage> {
  // merchant_id on a pay-in and merchant_key on a settlement can each be the merchant code
  // or the merchant uuid, so both resolve to the code.
  const merchants = await rows<{ id: string; merchant_code: string }>("merchant", `
    SELECT id::text, merchant_code FROM merchants
     ${codes ? "WHERE merchant_code = ANY($1::text[]) OR id::text = ANY($1::text[])" : ""}
  `, codes ? [codes] : []).catch(() => []);
  const bankerOf = new Map<string, string>();
  for (const c of codes ?? []) bankerOf.set(c, c);
  for (const m of merchants) { bankerOf.set(m.id, m.merchant_code); bankerOf.set(m.merchant_code, m.merchant_code); }

  const raw = await rows<{ merchant_key: string; channel_type: string | null; amount: number; utr: string | null; at: string }>("provider", `
    SELECT merchant_key, channel_type, amount::float AS amount, utr,
           COALESCE(verified_at, confirmed_at, updated_at) AS at
      FROM provider_branch_settlements
     WHERE status IN ${SETTLED_STATUSES}
       ${providerId ? "AND provider_id = $1::uuid" : ""}
     ORDER BY COALESCE(verified_at, confirmed_at, updated_at) ASC, created_at ASC
  `, providerId ? [providerId] : []).catch(() => []);

  const list: BankerSettlement[] = [];
  for (const r of raw) {
    const banker = bankerOf.get(r.merchant_key);
    if (!banker) continue;   // a settlement for a banker outside this scope
    const channel = r.channel_type === "INTENT" || r.channel_type === "P2P" ? r.channel_type : null;
    list.push({ banker, channel, amount: r.amount, utr: r.utr, at: new Date(r.at).toISOString() });
  }
  return buildCoverage(list, bankerOf);
}

/** The seven array parameters coverageCte reads, in order. */
export function coverageArgs(c: BankerCoverage): unknown[] {
  return [c.keys, c.keyBanker, c.chBankers, c.chChannels, c.chTotals, c.restBankers, c.restTotals];
}

/**
 * CTEs `cover0` and `cover`: one row per paid live pay-in of a banker in scope.
 *   cum_ch / ch_total     the order's place in its banker's queue for its own channel, and what
 *                         the banker settled to that channel
 *   cum_rest / rest_total its place among the orders the channel settlements left unsettled,
 *                         and what the banker settled with no channel
 * `at` is the 1-based position of the first of the seven coverageArgs parameters.
 *
 * It ranks ALL of a banker's paid orders, not only those in the page's date window: an old
 * unsettled order is ahead of today's in the queue whether or not it is on screen.
 */
export function coverageCte(at: number): string {
  const p = (i: number) => `$${at + i}`;
  return `
  cover0 AS (
    SELECT p.id, k.banker, p.channel_type, p.amount::float AS amount, p.created_at,
           SUM(p.amount) OVER (PARTITION BY k.banker, p.channel_type ORDER BY p.created_at, p.id)::float AS cum_ch,
           COALESCE(t.total, 0)::float AS ch_total
      FROM vendor_payin_orders p
      JOIN unnest(${p(0)}::text[], ${p(1)}::text[]) AS k(key, banker) ON k.key = p.merchant_id
      LEFT JOIN unnest(${p(2)}::text[], ${p(3)}::text[], ${p(4)}::float8[]) AS t(banker, channel, total)
             ON t.banker = k.banker AND t.channel = p.channel_type
     WHERE p.vendor = 'KATANA' AND p.status IN ('SUCCESS','SUCCEEDED')
       AND p.livemode = true   -- a test order never creates a settlement receivable
  ),
  cover AS (
    SELECT c.id, c.channel_type, c.cum_ch, c.ch_total,
           (c.cum_ch <= c.ch_total + 0.005) AS by_channel,
           SUM(CASE WHEN c.cum_ch <= c.ch_total + 0.005 THEN 0 ELSE c.amount END)
             OVER (PARTITION BY c.banker ORDER BY c.created_at, c.id)::float AS cum_rest,
           COALESCE(r.total, 0)::float AS rest_total
      FROM cover0 c
      LEFT JOIN unnest(${p(5)}::text[], ${p(6)}::float8[]) AS r(banker, total) ON r.banker = c.banker
  )`;
}

/** The order is covered by a settlement of its channel, or else by one with no channel (half a paisa of float slack). */
export const COVERED_SQL = `COALESCE(c.by_channel OR c.cum_rest <= c.rest_total + 0.005, false)`;

/** Where an order sits in its queues, as the cover CTE reports it. */
export interface QueuePosition { channel: string | null; by_channel: boolean | null; cum_ch: number | null; cum_rest: number | null }

/**
 * The settlement that covered an order: the first settlement of its queue, oldest first, whose
 * running total reaches the order's position. null when not yet covered.
 */
export function settlementCovering(c: BankerCoverage, merchantId: string | null | undefined, pos: QueuePosition | null | undefined): BankerSettlement | null {
  const banker = merchantId ? c.bankerOf.get(merchantId) : null;
  if (!banker || !pos) return null;
  const channel = pos.channel === "INTENT" || pos.channel === "P2P" ? pos.channel : null;
  const [queue, cum] = pos.by_channel && channel ? [queueKey(banker, channel), pos.cum_ch] : [queueKey(banker, null), pos.cum_rest];
  if (cum == null) return null;
  let run = 0;
  for (const s of c.settlements.get(queue) ?? []) {
    run += s.amount;
    if (cum <= run + 0.005) return s;
  }
  return null;
}
