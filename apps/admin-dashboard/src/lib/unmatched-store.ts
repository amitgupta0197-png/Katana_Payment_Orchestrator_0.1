// "Unmatched payments" (lib/unmatched): the queue, and what a person decides about each payment.
// A link is made only through lib/credit-link-store (linkCreditToOrder → confirmKatanaOrder), the
// same path the staff banker page uses; from a merchant or banker login it is a request staff approve.
// Every action is audited in vendor_recon_audit.

import { rows } from "@/lib/pg";
import type { Session } from "@/lib/auth";
import { inScope, portalScope, type PortalScope } from "@/lib/portal-scope";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { paymentAppOf } from "@/lib/payment-app";
import { possibleOrders, type LinkableOrder } from "@/lib/credit-link";
import { LinkError, linkCreditToOrder, openOrdersForLinking } from "@/lib/credit-link-store";
import { actionRefusal, isLinkRole, maskVpa, reviewLabel, type Review, type UnmatchedAction } from "@/lib/unmatched";

export class UnmatchedError extends Error { constructor(public status: number, message: string) { super(message); } }

export interface UnmatchedPayment {
  id: string; banker: string; amount: number; received_at: string; utr: string | null;
  payer: string | null; app: string | null; outcome: string;
  candidates: { id: string; order_id: string; created_at: string; status: string }[];
  review: Review | null; state: string;
}

interface AlertRow { id: string; banker: string; amount: number; received_at: string; utr: string | null; payer_vpa: string | null; outcome: string; bank: string | null; sender: string | null; source: string | null }

const ALERT_COLS = `a.id::text, a.merchant_id AS banker, a.amount::float AS amount, COALESCE(a.event_time, a.created_at) AS received_at,
  NULLIF(a.utr, '') AS utr, a.payer_vpa, a.outcome, a.bank, a.sender, a.source`;

async function reviewsFor(ids: string[]): Promise<Map<string, Review>> {
  if (!ids.length) return new Map();
  const r = await rows<Review & { alert_id: string }>("vendorGateway", `
    SELECT alert_id::text, decision, status, order_id::text, order_ref, requested_by, requested_as, note
      FROM unmatched_credit_reviews WHERE alert_id = ANY($1::uuid[])`, [ids]).catch(() => []);
  return new Map(r.map(({ alert_id, ...v }) => [alert_id, v]));
}

/** The queue for this login: its own bankers' payments (staff: all, or one banker). */
export async function listUnmatched(s: Session, opts: { banker?: string | null; showMarked?: boolean } = {}): Promise<{ payments: UnmatchedPayment[]; staff: boolean; canLink: boolean }> {
  const scope = await portalScope(s);
  const codes = scope.codes === null ? (opts.banker ? [opts.banker] : null) : scope.codes.filter((c) => !opts.banker || c === opts.banker);
  if (codes && !codes.length) return { payments: [], staff: scope.staff, canLink: false };
  const list = await rows<AlertRow>("vendorGateway", `
    SELECT ${ALERT_COLS}
      FROM vendor_txn_alerts a
     WHERE a.direction = 'CREDIT' AND a.livemode = true AND a.outcome IN ('UNMATCHED', 'AMBIGUOUS')
       AND a.matched_order_id IS NULL AND a.merchant_id IS NOT NULL
       AND COALESCE(a.event_time, a.created_at) > now() - interval '30 days'
       AND ${IS_COLLECTION}
       ${codes ? "AND a.merchant_id = ANY($1::text[])" : ""}
     ORDER BY COALESCE(a.event_time, a.created_at) DESC LIMIT 300`, codes ? [codes] : []);
  const reviews = await reviewsFor(list.map((a) => a.id));
  const open = new Map<string, LinkableOrder[]>();
  for (const code of new Set(list.map((a) => a.banker))) open.set(code, await openOrdersForLinking(code).catch(() => []));

  const payments: UnmatchedPayment[] = [];
  for (const a of list) {
    const review = reviews.get(a.id) ?? null;
    if (!opts.showMarked && review?.decision === "NOT_ORDER" && review.status === "DONE") continue;
    payments.push({
      id: a.id, banker: a.banker, amount: a.amount, received_at: a.received_at, utr: a.utr,
      payer: scope.staff ? a.payer_vpa : maskVpa(a.payer_vpa),
      app: scope.staff ? paymentAppOf({ bank: a.bank, sender: a.sender, source: a.source }).label : null,
      outcome: a.outcome,
      candidates: possibleOrders({ amount: a.amount, received_at: a.received_at }, open.get(a.banker) ?? [])
        .map((o) => ({ id: o.id, order_id: o.order_id, created_at: o.created_at, status: o.status })),
      review, state: reviewLabel(review),
    });
  }
  return { payments, staff: scope.staff, canLink: isLinkRole(s.persona) };
}

async function alertInScope(scope: PortalScope, alertId: string): Promise<AlertRow> {
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) throw new UnmatchedError(404, "payment not found");
  const a = (await rows<AlertRow>("vendorGateway", `
    SELECT ${ALERT_COLS} FROM vendor_txn_alerts a
     WHERE a.id = $1::uuid AND a.direction = 'CREDIT' AND a.livemode = true`, [alertId]))[0];
  if (!a || !inScope(scope, a.banker)) throw new UnmatchedError(404, "payment not found");
  return a;
}

async function audit(actor: string, action: string, alertId: string, detail: string) {
  await rows("vendorGateway", `INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail) VALUES ($1, $2, 'txn_alert', $3, $4)`,
    [actor, action, alertId, detail.slice(0, 500)]).catch(() => {});
}

async function setReview(alertId: string, banker: string, v: { decision: "LINK" | "NOT_ORDER"; status: "PENDING" | "DONE" | "REJECTED"; orderId?: string | null; orderRef?: string | null; note?: string | null; by: string; as: string; decided?: boolean }) {
  await rows("vendorGateway", `
    INSERT INTO unmatched_credit_reviews (alert_id, merchant_id, decision, order_id, order_ref, status, note, requested_by, requested_as, decided_by, decided_at)
    VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, CASE WHEN $10 THEN $8 END, CASE WHEN $10 THEN now() END)
    ON CONFLICT (alert_id) DO UPDATE SET decision = EXCLUDED.decision, order_id = EXCLUDED.order_id, order_ref = EXCLUDED.order_ref,
      status = EXCLUDED.status, note = EXCLUDED.note, requested_by = EXCLUDED.requested_by, requested_as = EXCLUDED.requested_as,
      decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at, updated_at = now()`,
    [alertId, banker, v.decision, v.orderId ?? null, v.orderRef ?? null, v.status, v.note ?? null, v.by, v.as, !!v.decided]);
}

/** One person's decision on one payment. Returns the payment's new state in plain words. */
export async function actOnUnmatched(s: Session, alertId: string, action: UnmatchedAction, input: { orderId?: string; note?: string } = {}): Promise<{ state: string; linked?: string }> {
  const scope = await portalScope(s);
  const a = await alertInScope(scope, alertId);
  const review = (await reviewsFor([a.id])).get(a.id) ?? null;
  const staff = scope.staff;
  const refusal = actionRefusal(action, staff, review);
  if (refusal) throw new UnmatchedError(409, refusal);
  const linker = isLinkRole(s.persona);

  if (action === "link") {
    if (!input.orderId) throw new UnmatchedError(400, "Choose the order this payment is for.");
    const order = possibleOrders({ amount: a.amount, received_at: a.received_at }, await openOrdersForLinking(a.banker))
      .find((o) => o.id === input.orderId);
    if (!order) throw new UnmatchedError(409, "That order can't take this payment: a different amount, too old, or already paid.");
    if (linker) {
      try { await linkCreditToOrder({ code: a.banker, alertId: a.id, orderId: order.id, actor: s.email }); }
      catch (e) { if (e instanceof LinkError) throw new UnmatchedError(e.status, e.message); throw e; }
      await setReview(a.id, a.banker, { decision: "LINK", status: "DONE", orderId: order.id, orderRef: order.order_id, note: input.note, by: s.email, as: s.persona, decided: true });
      await audit(s.email, "UNMATCHED_LINKED", a.id, `${order.order_id} ₹${a.amount.toFixed(2)}`);
      return { state: reviewLabel({ decision: "LINK", status: "DONE", order_id: order.id, order_ref: order.order_id, requested_by: s.email, requested_as: s.persona, note: null }), linked: order.order_id };
    }
    await setReview(a.id, a.banker, { decision: "LINK", status: "PENDING", orderId: order.id, orderRef: order.order_id, note: input.note, by: s.email, as: s.persona });
    await audit(s.email, "UNMATCHED_LINK_REQUESTED", a.id, `${order.order_id} ₹${a.amount.toFixed(2)} by ${s.persona}`);
    return { state: reviewLabel({ decision: "LINK", status: "PENDING", order_id: order.id, order_ref: order.order_id, requested_by: s.email, requested_as: s.persona, note: null }) };
  }

  if (action === "not_order") {
    await setReview(a.id, a.banker, { decision: "NOT_ORDER", status: "DONE", note: input.note, by: s.email, as: s.persona, decided: true });
    await audit(s.email, "UNMATCHED_NOT_ORDER", a.id, `₹${a.amount.toFixed(2)} ${input.note ?? ""}`);
    return { state: "Not an order payment" };
  }

  if (action === "approve") {
    if (!linker) throw new UnmatchedError(403, "Only Katana staff who resolve payments can approve a link.");
    try { await linkCreditToOrder({ code: a.banker, alertId: a.id, orderId: review!.order_id!, actor: s.email }); }
    catch (e) { if (e instanceof LinkError) throw new UnmatchedError(e.status, e.message); throw e; }
    await rows("vendorGateway", `UPDATE unmatched_credit_reviews SET status = 'DONE', decided_by = $2, decided_at = now(), updated_at = now() WHERE alert_id = $1::uuid`, [a.id, s.email]);
    await audit(s.email, "UNMATCHED_LINK_APPROVED", a.id, `${review!.order_ref} requested by ${review!.requested_by}`);
    return { state: `Linked to ${review!.order_ref}`, linked: review!.order_ref ?? undefined };
  }

  if (action === "reject") {
    await rows("vendorGateway", `UPDATE unmatched_credit_reviews SET status = 'REJECTED', decided_by = $2, decided_at = now(), note = COALESCE($3, note), updated_at = now() WHERE alert_id = $1::uuid`, [a.id, s.email, input.note ?? null]);
    await audit(s.email, "UNMATCHED_LINK_REJECTED", a.id, `${review!.order_ref} ${input.note ?? ""}`);
    return { state: "Link refused by Katana" };
  }

  // undo a "not an order payment" mark (staff)
  await rows("vendorGateway", `DELETE FROM unmatched_credit_reviews WHERE alert_id = $1::uuid`, [a.id]);
  await audit(s.email, "UNMATCHED_UNDO", a.id, "not an order payment undone");
  return { state: "Needs an order" };
}
