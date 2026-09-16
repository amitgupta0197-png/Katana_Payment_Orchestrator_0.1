// PayU payout orders — how a whitelisted, approved payout becomes a PayU transfer and how
// PayU's answer closes it.
//
//   dispatchPayuPayout   QUEUED -> SUBMITTED, then asks PayU to pay. A definite refusal
//                        fails the order; no answer leaves it SUBMITTED for the sweep.
//   syncPayuPayout       asks PayU what happened (status lookup) and applies it. The webhook,
//                        the sweep and the admin "check now" all come through here, so a
//                        webhook body is never trusted on its own.
//
// Every move is a guarded UPDATE ... WHERE status=<from>, so a webhook and the sweep landing
// together move the order once and fire one merchant callback.
//
// No ledger posting: the money sits in the merchant's own PayU Payouts account and never
// passed through Katana's books (unlike operator-paid payouts, which debit MERCHANT_PAYABLE).

import { rows } from "@/lib/pg";
import { recordEvent, recordFraudAlert } from "@/lib/fifo";
import { sendPayoutCallback } from "@/lib/payout-api";
import { isMerchantSuspended } from "@/lib/payout-policy";
import {
  getPayuPayoutCreds, payuTransfer, payuTransferStatus, type PayoutRail,
} from "@/lib/payu-payout";

export interface PayuPayoutOrder {
  id: string; order_ref: string; txn_ref: string; merchant_id: string;
  amount_minor: string; currency: string; status: string; provider: string | null;
  payout_rail: PayoutRail | null; purpose: string | null; beneficiary_id: string | null;
  callback_url: string | null; utr: string | null; created_at: Date;
}

const ORDER_COLS = `id::text, order_ref, txn_ref, merchant_id, amount_minor::text, currency, status, provider,
  payout_rail, purpose, beneficiary_id::text, callback_url, utr, created_at`;

export async function loadPayuPayout(where: "id" | "txn_ref", value: string): Promise<PayuPayoutOrder | null> {
  const cond = where === "id" ? "id=$1::uuid" : "txn_ref=$1";
  return (await rows<PayuPayoutOrder>("fifo",
    `SELECT ${ORDER_COLS} FROM fifo_orders WHERE ${cond} AND direction='PAYOUT' AND provider='PAYU' LIMIT 1`,
    [value]).catch(() => []))[0] ?? null;
}

// Guarded move: only succeeds if the order is still in `from`. Returns false if someone
// else moved it first — the caller then does nothing more (no second callback).
async function moveIf(o: PayuPayoutOrder, from: string, to: string, reason: string,
  set: Record<string, string | null> = {}, payload?: Record<string, unknown>): Promise<boolean> {
  const sets = ["status=$3"]; const args: unknown[] = [o.id, from, to];
  if (to === "COMPLETED") sets.push("completed_at=now()");
  for (const [k, v] of Object.entries(set)) { args.push(v); sets.push(`${k}=$${args.length}`); }
  const r = await rows<{ id: string }>("fifo",
    `UPDATE fifo_orders SET ${sets.join(", ")} WHERE id=$1::uuid AND status=$2 RETURNING id::text`, args);
  if (!r.length) return false;
  await recordEvent({ orderId: o.id, from, to, actorKind: "gateway", reason, payload });
  return true;
}

async function note(o: PayuPayoutOrder, reason: string, payload?: Record<string, unknown>) {
  await recordEvent({ orderId: o.id, from: o.status, to: o.status, actorKind: "gateway", reason, payload });
}

async function notifyMerchant(o: PayuPayoutOrder) {
  await sendPayoutCallback(o.id);
}

export type DispatchResult = { status: string; error?: string };

/** Send a QUEUED PayU payout to PayU. Safe to call twice: only one call wins the QUEUED row. */
export async function dispatchPayuPayout(orderId: string): Promise<DispatchResult> {
  const o = await loadPayuPayout("id", orderId);
  if (!o) return { status: "UNKNOWN", error: "not a PayU payout" };
  if (o.status !== "QUEUED") return { status: o.status };

  const ben = (await rows<any>("fifo", `
    SELECT status, beneficiary_name, account_number, ifsc, upi_id FROM fifo_beneficiaries WHERE id=$1::uuid
  `, [o.beneficiary_id]).catch(() => []))[0];
  const creds = await getPayuPayoutCreds(o.merchant_id);
  // Checked before claiming: these cancel the payout without anything having been sent.
  const blocker = (await isMerchantSuspended(o.merchant_id)) ? "payouts are suspended for this merchant"
    : !creds ? "PayU payout credentials are not set for this merchant"
    : !ben ? "beneficiary no longer exists"
    : ben.status !== "APPROVED" ? `beneficiary is ${ben.status}`
    : null;
  if (blocker) {
    if (await moveIf(o, "QUEUED", "CANCELLED", blocker, { failure_reason: blocker })) await notifyMerchant(o);
    return { status: "CANCELLED", error: blocker };
  }

  if (!(await moveIf(o, "QUEUED", "SUBMITTED", `sent to PayU (${o.payout_rail})`, { submitted_at: new Date().toISOString() })))
    return { status: (await loadPayuPayout("id", orderId))?.status ?? "UNKNOWN" };
  o.status = "SUBMITTED";

  const t = await payuTransfer(creds!, {
    merchantRefId: o.txn_ref, amountMinor: BigInt(o.amount_minor), rail: o.payout_rail ?? "IMPS",
    purpose: o.purpose || "Payout", beneficiaryName: ben.beneficiary_name,
    accountNumber: ben.account_number, ifsc: ben.ifsc, vpa: ben.upi_id,
  });

  if (t.ok) {
    await rows("fifo", `UPDATE fifo_orders SET provider_status='ACCEPTED' WHERE id=$1::uuid`, [o.id]).catch(() => {});
    await note(o, "PayU accepted the transfer; waiting for the bank");
    return { status: "SUBMITTED" };
  }
  if (t.definite) {
    if (await moveIf(o, "SUBMITTED", "FAILED", `PayU refused the transfer: ${t.error}`, { failure_reason: t.error, provider_status: "REJECTED" }))
      await notifyMerchant(o);
    return { status: "FAILED", error: t.error };
  }
  // PayU may or may not have the request. The status lookup (by merchantRefId) settles it;
  // sending it again could pay twice.
  await rows("fifo", `UPDATE fifo_orders SET provider_status='UNKNOWN' WHERE id=$1::uuid`, [o.id]).catch(() => {});
  await note(o, `no clear answer from PayU (${t.error}); the status check will settle it`);
  return { status: "SUBMITTED", error: t.error };
}

export type SyncOutcome =
  | "completed" | "failed" | "reversed" | "pending" | "not_found"
  | "unknown" | "no_creds" | "mismatch" | "final" | "busy";

// Stops the webhook and the sweep from asking PayU about the same payout at the same moment.
async function claimCheck(orderId: string, minGapSeconds: number): Promise<boolean> {
  const r = await rows<{ id: string }>("fifo", `
    UPDATE fifo_orders SET provider_checked_at=now()
     WHERE id=$1::uuid AND (provider_checked_at IS NULL OR provider_checked_at < now() - ($2 || ' seconds')::interval)
    RETURNING id::text
  `, [orderId, String(minGapSeconds)]).catch(() => []);
  return r.length > 0;
}

/** Ask PayU about one payout and apply the answer. `hint` is the webhook event, for the record only. */
export async function syncPayuPayout(o: PayuPayoutOrder, opts: { hint?: string; timeoutMs?: number; minGapSeconds?: number } = {}): Promise<{ outcome: SyncOutcome; detail?: string }> {
  if (o.status !== "SUBMITTED" && o.status !== "COMPLETED") return { outcome: "final" };
  const creds = await getPayuPayoutCreds(o.merchant_id);
  if (!creds) return { outcome: "no_creds" };
  if (!(await claimCheck(o.id, opts.minGapSeconds ?? 2))) return { outcome: "busy" };

  const r = await payuTransferStatus(creds, o.txn_ref, new Date(o.created_at), opts.timeoutMs);
  if (!r.ok) return { outcome: "unknown", detail: r.error };
  const s = r.data;
  if (!s.found) return { outcome: "not_found" };
  if (opts.hint === "MANUAL_CHECK" && o.status === "SUBMITTED" && s.status !== "SUCCESS" && s.status !== "FAILED" && s.status !== "REVERSED")
    await note(o, `status checked: PayU says ${s.status}`, { payu_raw: s.raw });

  await rows("fifo", `UPDATE fifo_orders SET provider_status=$2, provider_ref=COALESCE($3, provider_ref) WHERE id=$1::uuid`,
    [o.id, s.status ?? null, s.payuRef ?? null]).catch(() => {});
  // PayU's answer is kept verbatim on the order timeline (the audit trail for this payout).
  const evidence = { payu_status: s.status, payu_ref: s.payuRef, bank_ref: s.bankRef, msg: s.msg, webhook_event: opts.hint, payu_raw: s.raw };

  if (o.status === "SUBMITTED") {
    if (s.status === "SUCCESS") {
      // PayU's amount must match ours. If it doesn't, something is badly wrong; don't close it.
      if (s.amountMinor != null && s.amountMinor !== BigInt(o.amount_minor)) {
        await recordFraudAlert({
          orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "CRITICAL",
          detail: `PayU paid ${s.amountMinor} paise, order is for ${o.amount_minor}`, payload: { kind: "PAYU_PAYOUT_AMOUNT_MISMATCH", ...evidence },
        });
        return { outcome: "mismatch" };
      }
      if (await moveIf(o, "SUBMITTED", "COMPLETED", "PayU confirmed the transfer", { utr: s.bankRef ?? null }, evidence))
        await notifyMerchant(o);
      return { outcome: "completed" };
    }
    if (s.status === "FAILED" || s.status === "REVERSED") {
      const why = s.msg ?? `PayU status ${s.status}`;
      if (await moveIf(o, "SUBMITTED", "FAILED", `PayU: ${why}`, { failure_reason: why }, evidence))
        await notifyMerchant(o);
      return { outcome: "failed" };
    }
    return { outcome: "pending", detail: s.status };
  }

  // COMPLETED: only a reversal can still change it.
  if (s.status === "REVERSED" || s.status === "FAILED") {
    const why = s.msg ?? "bank reversed the transfer";
    if (await moveIf(o, "COMPLETED", "REVERSED", `PayU: ${why}`, { failure_reason: why }, evidence)) {
      await recordFraudAlert({
        orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "HIGH",
        detail: `Payout reversed after success: ${why}`, payload: { kind: "PAYU_PAYOUT_REVERSED", ...evidence },
      });
      await notifyMerchant(o);
    }
    return { outcome: "reversed" };
  }
  if (opts.hint && /REVERS/i.test(opts.hint)) {
    // PayU's webhook says reversed but its lookup still says paid. Don't guess; tell ops.
    await note(o, `PayU webhook reported ${opts.hint} but the status lookup says ${s.status}; left as is`, evidence);
  }
  return { outcome: "final" };
}

/** Raise one ops alert for a payout PayU still has no record of long after it was sent. */
export async function flagPayoutMissingAtPayu(o: PayuPayoutOrder): Promise<void> {
  const exists = (await rows<{ n: number }>("fifo", `
    SELECT COUNT(*)::int AS n FROM fifo_fraud_alerts WHERE order_id=$1::uuid AND payload->>'kind'='PAYU_PAYOUT_NOT_FOUND'
  `, [o.id]).catch(() => []))[0]?.n ?? 0;
  if (exists) return;
  await recordFraudAlert({
    orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "HIGH",
    detail: "PayU has no record of this payout. Check the PayU dashboard before paying it another way.",
    payload: { kind: "PAYU_PAYOUT_NOT_FOUND", merchant_ref_id: o.txn_ref },
  });
}
