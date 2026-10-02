// Refunds (BRD §7 P3 state machine + §10 P6 refund ledger).
//
// Post a balanced refund.posted journal:
//   Debit  LIABILITIES.MERCHANT_PAYABLE.<mid>   amount
//   Credit ASSETS.PG_FLOAT.<provider>            amount
//
// Order state transitions SUCCESS → REFUND_REQUESTED → REFUNDED|PARTIALLY_REFUNDED.

import { db, rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";
import { publish } from "@/lib/events";

export interface CreateRefundInput {
  txnId: string;
  amountMinor: bigint | string | number;
  reason: string;
  requestedBy?: string | null;
  /**
   * The merchant codes the caller may refund for. Set for a banker's own session; absent for
   * Katana staff, who may refund any order. An order outside the scope is "not found": the
   * caller is not told that another merchant's order exists.
   */
  merchantScope?: string[] | null;
}

/** A refund that cannot be made, with the reason for the caller. The route answers 400. */
export class RefundError extends Error {}

const inr = (minor: bigint) => `₹${(Number(minor) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export async function createRefund(input: CreateRefundInput): Promise<{
  refund_id: string; journal_id: string; status: string; new_order_state: string | null;
}> {
  if (!/^[0-9]+$/.test(String(input.amountMinor))) throw new RefundError("refund amount must be a whole number of paise");
  const amt = BigInt(String(input.amountMinor));
  // A negative "refund" would be a credit to the merchant's balance.
  if (amt <= 0n) throw new RefundError("refund amount must be above zero");

  // RESERVE THE REFUND UNDER THE ORDER'S ROW LOCK. Two refunds of one order arriving together
  // each used to see the order before the other and could add up to more than was paid. The
  // lock makes them queue; the second one sees the first one's row in the total.
  const client = await db("checkout").connect();
  let o: { id: string; merchant_id: string; status: string; selected_rail: string | null; amount_minor: string; currency: string };
  let refundId: string;
  let total: bigint;
  try {
    await client.query("BEGIN");
    const order = await client.query(`
      SELECT id::text, merchant_id, status, selected_rail, amount_minor::text AS amount_minor, currency, livemode
        FROM checkout_orders
       WHERE txn_id = $1 AND ($2::text[] IS NULL OR merchant_id = ANY($2::text[]))
       LIMIT 1 FOR UPDATE`, [input.txnId, input.merchantScope ?? null]);
    if (!order.rows.length) throw new RefundError("order not found");
    o = order.rows[0];
    // A refund posts a journal against the merchant's real balance; a test order moved no money.
    if (order.rows[0].livemode === false) throw new RefundError("test orders cannot be refunded — no money moved");
    if (o.status !== "SUCCESS" && o.status !== "PARTIALLY_REFUNDED")
      throw new RefundError(`cannot refund from status ${o.status}`);
    // Everything already refunded or being refunded counts; a refund that failed does not.
    const done = BigInt((await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS s FROM refunds WHERE order_id = $1::uuid AND status IN ('PENDING','POSTED')`,
      [o.id])).rows[0].s);
    total = done + amt;
    if (total > BigInt(o.amount_minor))
      throw new RefundError(done > 0n
        ? `refund exceeds what is left of the order: ${inr(done)} of ${inr(BigInt(o.amount_minor))} is already refunded`
        : "refund exceeds order amount");
    refundId = (await client.query(`
      INSERT INTO refunds (order_id, txn_id, merchant_id, amount_minor, currency, reason, status, partial, requested_by)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, 'PENDING', $7, $8)
      RETURNING refund_id::text
    `, [o.id, input.txnId, o.merchant_id, amt.toString(), o.currency, input.reason,
        total < BigInt(o.amount_minor), input.requestedBy ?? null])).rows[0].refund_id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const isPartial = total < BigInt(o.amount_minor);
  // The journal is keyed by the refund, so two refunds of the same amount are two journals,
  // and a retry of this one is the same journal. The currency is the order's, not the caller's.
  let journal: { journal_id: string };
  try {
    journal = await postJournal({
      journal_type: "refund.posted",
      narration: `Refund for ${input.txnId}`,
      currency: o.currency,
      merchant_id: o.merchant_id,
      ref: { type: "refund", id: input.txnId },
      idempotency_key: `refund.posted:${refundId}`,
      lines: [
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${o.merchant_id}`, account_type: "LIABILITY",
          side: "D", amount_minor: amt, currency: o.currency },
        { account_code: `ASSETS.PG_FLOAT.${o.selected_rail ?? "UNKNOWN"}`, account_type: "ASSET",
          side: "C", amount_minor: amt, currency: o.currency },
      ],
    });
  } catch (err) {
    // Nothing was posted: release the amount this refund was holding.
    await rows("checkout", `UPDATE refunds SET status = 'FAILED', failure_reason = $2 WHERE refund_id = $1::uuid`,
      [refundId, (err as Error).message.slice(0, 300)]).catch(() => {});
    throw err;
  }

  await rows("checkout",
    `UPDATE refunds SET status = 'POSTED', journal_id = $2::uuid, posted_at = now() WHERE refund_id = $1::uuid`,
    [refundId, journal.journal_id]);

  const newState = isPartial ? "PARTIALLY_REFUNDED" : "REFUNDED";
  await rows("checkout",
    `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid`, [newState, o.id]);
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason)
    VALUES ($1::uuid, $2, $3, 'admin', $4, $5)
  `, [o.id, o.status, newState, input.requestedBy ?? null, `refund: ${input.reason}`]).catch(() => null);

  await publish({
    eventType: "payment.succeeded", producer: "payment_core",
    entityType: "refund", entityId: refundId, actorId: null,
    payload: { kind: "refund_posted", txn_id: input.txnId, amount_minor: amt.toString(), partial: isPartial, journal_id: journal.journal_id },
  });

  return { refund_id: refundId, journal_id: journal.journal_id, status: "POSTED", new_order_state: newState };
}
