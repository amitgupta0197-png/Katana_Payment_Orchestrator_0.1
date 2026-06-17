// Refunds (BRD §7 P3 state machine + §10 P6 refund ledger).
//
// Post a balanced refund.posted journal:
//   Debit  LIABILITIES.MERCHANT_PAYABLE.<mid>   amount
//   Credit ASSETS.PG_FLOAT.<provider>            amount
//
// Order state transitions SUCCESS → REFUND_REQUESTED → REFUNDED|PARTIALLY_REFUNDED.

import { rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";
import { publish } from "@/lib/events";

export interface CreateRefundInput {
  txnId: string;
  amountMinor: bigint | string | number;
  currency: string;
  reason: string;
  partial?: boolean;
  requestedBy?: string | null;
}

export async function createRefund(input: CreateRefundInput): Promise<{
  refund_id: string; journal_id: string; status: string; new_order_state: string | null;
}> {
  const amt = BigInt(String(input.amountMinor));
  const order = await rows<any>("checkout",
    `SELECT id::text, merchant_id, status, selected_rail, amount_minor::text AS amount_minor
       FROM checkout_orders WHERE txn_id=$1 LIMIT 1`, [input.txnId]);
  if (!order.length) throw new Error("order not found");
  const o = order[0];
  if (o.status !== "SUCCESS" && o.status !== "PARTIALLY_REFUNDED")
    throw new Error(`cannot refund from status ${o.status}`);
  if (BigInt(o.amount_minor) < amt)
    throw new Error("refund exceeds order amount");

  const isPartial = input.partial ?? (BigInt(o.amount_minor) > amt);
  const journal = await postJournal({
    journal_type: "refund.posted",
    narration: `Refund for ${input.txnId}`,
    currency: input.currency,
    merchant_id: o.merchant_id,
    ref: { type: "refund", id: input.txnId },
    idempotency_key: `refund.posted:${input.txnId}:${amt.toString()}`,
    lines: [
      { account_code: `LIABILITIES.MERCHANT_PAYABLE.${o.merchant_id}`, account_type: "LIABILITY",
        side: "D", amount_minor: amt, currency: input.currency },
      { account_code: `ASSETS.PG_FLOAT.${o.selected_rail ?? "UNKNOWN"}`, account_type: "ASSET",
        side: "C", amount_minor: amt, currency: input.currency },
    ],
  });

  const refundRow = await rows<{ refund_id: string }>("checkout", `
    INSERT INTO refunds
      (order_id, txn_id, merchant_id, amount_minor, currency, reason,
       status, partial, journal_id, requested_by, posted_at)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, 'POSTED', $7, $8::uuid, $9, now())
    RETURNING refund_id::text
  `, [o.id, input.txnId, o.merchant_id, amt.toString(), input.currency,
      input.reason, isPartial, journal.journal_id, input.requestedBy ?? null]);

  const newState = isPartial ? "PARTIALLY_REFUNDED" : "REFUNDED";
  await rows("checkout",
    `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid`, [newState, o.id]);
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, actor_id, reason)
    VALUES ($1::uuid, $2, $3, 'admin', $4, $5)
  `, [o.id, o.status, newState, input.requestedBy ?? null, `refund: ${input.reason}`]).catch(() => null);

  await publish({
    eventType: "payment.succeeded", producer: "payment_core",
    entityType: "refund", entityId: refundRow[0].refund_id, actorId: null,
    payload: { kind: "refund_posted", txn_id: input.txnId, amount_minor: amt.toString(), partial: isPartial, journal_id: journal.journal_id },
  });

  return {
    refund_id: refundRow[0].refund_id, journal_id: journal.journal_id,
    status: "POSTED", new_order_state: newState,
  };
}
