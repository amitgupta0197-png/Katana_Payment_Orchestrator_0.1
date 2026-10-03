// Which open orders a captured payment could belong to (lib/credit-link-store, the staff banker page).
//
// The reconciler links a credit by itself only when exactly one open order of that amount exists
// (lib/txn-reconcile, MATCH_WINDOW_MIN). Two ₹1 test orders open together left both payments as
// "No order" with nothing to act on (2026-10-03, ORD_771519_LLND-TEST2 / -TEST-3). This lists the
// same candidates the reconciler weighed, so a person can pick one. PURE: no database.

/** The reconciler's own recency window, in minutes. */
export const LINK_WINDOW_MIN = 30;
/** A phone's clock and the server's differ a little; an order made just after the credit still counts. */
const CLOCK_SKEW_MS = 2 * 60_000;

export interface LinkableOrder { id: string; order_id: string; amount: number; created_at: string; status: string }
export interface LinkableCredit { amount: number; received_at: string }

/** Orders of the credit's amount, created in the window before it arrived, newest first. */
export function possibleOrders(credit: LinkableCredit, orders: LinkableOrder[]): LinkableOrder[] {
  const at = +new Date(credit.received_at);
  if (!Number.isFinite(at)) return [];
  return orders
    .filter((o) => Math.abs(Number(o.amount) - Number(credit.amount)) < 0.005)
    .filter((o) => {
      const t = +new Date(o.created_at);
      return t <= at + CLOCK_SKEW_MS && t >= at - LINK_WINDOW_MIN * 60_000;
    })
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
}
