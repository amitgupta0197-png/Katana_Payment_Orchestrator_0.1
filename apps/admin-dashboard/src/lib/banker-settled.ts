// Which paid pay-ins the banker has settled to the merchant.
//
// On both rails the customer's money ends up with the banker (INTENT: the gateway pays the
// banker out; P2P: it lands in the banker's own UPI account), and the banker then settles it
// to the merchant through the provider ↔ branch settlement workflow
// (provider_branch_settlements, tools/migrations/provider/0004). So "settled" means the same
// thing on INTENT and P2P: the banker's verified settlements cover this order.
//
// A settlement is a lump sum per banker, not a list of orders, so coverage is DERIVED:
// a banker's verified settlements are applied to that banker's paid live pay-ins oldest first.
// An order is settled when the running total of the banker's paid orders, up to and including
// it, fits inside what the banker has settled. This is the same arithmetic as the outstanding
// balance (lib/branch-settlement: collected − settled), read per order instead of in total.
//
// The two sides live in different databases, so the settlements are read here and handed to
// the pay-in query as arrays (see coverageCte).

import { rows } from "@/lib/pg";

// A settlement the merchant has confirmed receiving. RECONCILED is the step after VERIFIED.
const SETTLED_STATUSES = `('VERIFIED','RECONCILED')`;

export interface BankerSettlement { banker: string; amount: number; utr: string | null; at: string }

export interface BankerCoverage {
  /** Every key a pay-in may carry in merchant_id (merchant code or uuid), and the banker it means. */
  keys: string[];
  keyBanker: string[];
  /** Bankers with a verified settlement, and the total each has settled. */
  bankers: string[];
  totals: number[];
  /** Each banker's verified settlements, oldest first. */
  settlements: Map<string, BankerSettlement[]>;
  /** merchant_id on a pay-in → the banker it means. */
  bankerOf: Map<string, string>;
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

  const raw = await rows<{ merchant_key: string; amount: number; utr: string | null; at: string }>("provider", `
    SELECT merchant_key, amount::float AS amount, utr,
           COALESCE(verified_at, confirmed_at, updated_at) AS at
      FROM provider_branch_settlements
     WHERE status IN ${SETTLED_STATUSES}
       ${providerId ? "AND provider_id = $1::uuid" : ""}
     ORDER BY COALESCE(verified_at, confirmed_at, updated_at) ASC, created_at ASC
  `, providerId ? [providerId] : []).catch(() => []);

  const settlements = new Map<string, BankerSettlement[]>();
  for (const r of raw) {
    const banker = bankerOf.get(r.merchant_key);
    if (!banker) continue;   // a settlement for a banker outside this scope
    const list = settlements.get(banker) ?? [];
    list.push({ banker, amount: r.amount, utr: r.utr, at: new Date(r.at).toISOString() });
    settlements.set(banker, list);
  }

  const bankers = [...settlements.keys()];
  return {
    keys: [...bankerOf.keys()],
    keyBanker: [...bankerOf.values()],
    bankers,
    totals: bankers.map((b) => Math.round(settlements.get(b)!.reduce((a, x) => a + x.amount, 0) * 100) / 100),
    settlements,
    bankerOf,
  };
}

/** The four array parameters coverageCte reads, in order. */
export function coverageArgs(c: BankerCoverage): unknown[] {
  return [c.keys, c.keyBanker, c.bankers, c.totals];
}

/**
 * CTE `cover`: one row per paid live pay-in of a banker in scope, with `cum` (the banker's
 * paid total up to and including it, oldest first) and `settled_total` (what the banker has
 * settled). The order is settled when cum fits inside settled_total. `at` is the 1-based
 * position of the first of the four coverageArgs parameters.
 *
 * It ranks ALL of a banker's paid orders, not only those in the page's date window: an old
 * unsettled order is ahead of today's in the queue whether or not it is on screen.
 */
export function coverageCte(at: number): string {
  return `
  cover AS (
    SELECT p.id,
           SUM(p.amount) OVER (PARTITION BY k.banker ORDER BY p.created_at, p.id)::float AS cum,
           COALESCE(t.total, 0)::float AS settled_total
      FROM vendor_payin_orders p
      JOIN unnest($${at}::text[], $${at + 1}::text[]) AS k(key, banker) ON k.key = p.merchant_id
      LEFT JOIN unnest($${at + 2}::text[], $${at + 3}::float8[]) AS t(banker, total) ON t.banker = k.banker
     WHERE p.vendor = 'KATANA' AND p.status IN ('SUCCESS','SUCCEEDED')
       AND p.livemode = true   -- a test order never creates a settlement receivable
  )`;
}

/** `cover.cum` fits inside what the banker has settled (half a paisa of float slack). */
export const COVERED_SQL = `COALESCE(c.cum <= c.settled_total + 0.005, false)`;

/**
 * The settlement that covered an order: the first of the banker's settlements, oldest first,
 * whose running total reaches the order's position in the queue. null when not yet covered.
 */
export function settlementCovering(c: BankerCoverage, merchantId: string | null | undefined, cum: number | null | undefined): BankerSettlement | null {
  const banker = merchantId ? c.bankerOf.get(merchantId) : null;
  if (!banker || cum == null) return null;
  let run = 0;
  for (const s of c.settlements.get(banker) ?? []) {
    run += s.amount;
    if (cum <= run + 0.005) return s;
  }
  return null;
}
