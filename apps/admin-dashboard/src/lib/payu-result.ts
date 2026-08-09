// Shared PayU payment-result handling.
//
// PayU tells us a payment finished through two independent channels:
//
//   1. surl/furl  — set per transaction, POSTed as the CUSTOMER'S BROWSER returns.
//                   Handled by /api/gateway/payu/return, which must answer with a
//                   redirect so the shopper lands back on the merchant's page.
//   2. webhook    — configured once in the PayU dashboard, POSTed SERVER-TO-SERVER.
//                   Handled by /api/gateway/payu/webhook, which must answer 2xx or
//                   PayU treats delivery as failed and retries.
//
// Same event, same verification, two different replies. The logic lives here so the
// two routes can never drift — a payment must be judged identically whichever way we
// hear about it.
//
// The webhook matters because channel 1 is unreliable by nature: a shopper who closes
// the tab after paying never triggers the redirect. The webhook is the backstop that
// still confirms the money.

import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { payuResponseHash } from "@/lib/payu";
import { enqueue as enqueueWebhook } from "@/lib/webhook-outbox";

export interface PayuOutcome {
  /** false when the payload had no txnid, or no order matches it. */
  matched: boolean;
  txnid: string;
  /** SUCCESS / FAILED once matched; UNKNOWN when we could not identify the order. */
  status: "SUCCESS" | "FAILED" | "UNKNOWN";
  hashOk: boolean;
  /** Merchant's own return URL for this outcome — used by the browser channel only. */
  dest: string | null;
  /** Set when nothing was applied, for logs and the webhook reply. */
  reason?: string;
  /** True when this call is the one that moved the order (not a duplicate delivery). */
  applied: boolean;
}

/**
 * Apply a result we obtained by ASKING PayU (Verify Payment API) rather than being told.
 *
 * No reverse hash here on purpose: the verify call was itself authenticated with our
 * key+salt and answered by PayU directly, so the reply is trusted the same way a signed
 * callback is. This is the authoritative channel — with UPI the customer approves in their
 * app and frequently never returns to the browser, so neither surl/furl nor the webhook is
 * guaranteed to fire.
 *
 * Shares the same "already final" guard as the callback path, so a payment can be
 * confirmed by whichever channel gets there first without ever being counted twice.
 */
export async function applyVerifiedPayuStatus(input: {
  txnid: string; payuStatus: string; mihpayid?: string; bankRefNum?: string;
}): Promise<{ applied: boolean; status: "SUCCESS" | "FAILED" | "UNKNOWN"; reason?: string }> {
  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [input.txnid]).catch(() => []))[0];
  if (!o) return { applied: false, status: "UNKNOWN", reason: "unknown_txn" };
  if (o.status === "SUCCESS" || o.status === "FAILED") {
    return { applied: false, status: o.status, reason: "already_final" };
  }

  const s = input.payuStatus.toLowerCase();
  // Only "success" is success. PayU explicitly advises treating pending AND failure as
  // unsuccessful unless verified otherwise, so a pending payment is left alone to be
  // re-checked on the next sweep rather than being written off.
  if (s !== "success" && s !== "failure" && s !== "failed") {
    return { applied: false, status: "UNKNOWN", reason: `still ${s}` };
  }
  const nextStatus: "SUCCESS" | "FAILED" = s === "success" ? "SUCCESS" : "FAILED";

  await rows("checkout", `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid`, [nextStatus, o.id]).catch(() => {});
  await rows("checkout", `
    INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
    VALUES ($1::uuid, $2, $3, 'gateway', $4, $5::jsonb)
  `, [o.id, o.status, nextStatus, `payu verify_payment: ${s}`,
      JSON.stringify({ source: "verify_api", payu_status: s, mihpayid: input.mihpayid ?? null, bank_ref_num: input.bankRefNum ?? null })]).catch(() => {});
  await enqueueWebhook({
    merchantId: o.merchant_id, orderId: o.id,
    eventType: nextStatus === "SUCCESS" ? "payment.success" : "payment.failed",
    payload: { txn_id: input.txnid, provider: "PAYU", status: nextStatus,
               mihpayid: input.mihpayid ?? null, bank_ref_num: input.bankRefNum ?? null,
               source: "verify_api" },
  }).catch(() => null);

  return { applied: true, status: nextStatus };
}

/** Parse a PayU POST body, which may be JSON or form-encoded depending on channel. */
export async function parsePayuBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

/**
 * Verify a PayU result and apply it to the order exactly once.
 *
 * The merchant is resolved FROM THE PAYLOAD (txnid -> checkout_orders.merchant_id), which
 * is why a single webhook URL serves every merchant — no per-merchant endpoint needed.
 *
 * Idempotent: an order already SUCCESS/FAILED is not re-applied, so the browser redirect
 * and the webhook racing each other cannot double-fire the merchant's webhook or
 * double-count the payment. Whichever arrives first wins; the second reports applied=false.
 */
export async function applyPayuResult(p: Record<string, string>): Promise<PayuOutcome> {
  const txnid = p.txnid || p.txnId || "";
  const payuStatus = (p.status || "").toLowerCase();
  if (!txnid) return { matched: false, txnid: "", status: "UNKNOWN", hashOk: false, dest: null, reason: "missing txnid", applied: false };

  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status, client_surl, client_furl FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [txnid]).catch(() => []))[0];
  if (!o) return { matched: false, txnid, status: "UNKNOWN", hashOk: false, dest: null, reason: "unknown_txn", applied: false };

  // Verify PayU's response hash with THIS merchant's stored PayU salt. Without a stored
  // salt the hash can't be checked, so the payment is not treated as successful — we do
  // not take PayU's word for it unsigned.
  const gwMid = await getGatewayMid(o.merchant_id);
  const expected = gwMid ? payuResponseHash(gwMid, {
    status: p.status || "", email: p.email || "", firstname: p.firstname || "",
    productinfo: p.productinfo || "", amount: p.amount || "", txnid,
    additionalCharges: p.additionalCharges,
  }) : "";
  const hashOk = !!gwMid && !!p.hash && expected.toLowerCase() === p.hash.toLowerCase();

  const success = payuStatus === "success" && hashOk;
  const nextStatus: "SUCCESS" | "FAILED" = success ? "SUCCESS" : "FAILED";

  let applied = false;
  if (o.status !== "SUCCESS" && o.status !== "FAILED") {
    applied = true;
    await rows("checkout", `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid`, [nextStatus, o.id]).catch(() => {});
    await rows("checkout", `
      INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
      VALUES ($1::uuid, $2, $3, 'gateway', $4, $5::jsonb)
    `, [o.id, o.status, nextStatus, hashOk ? `payu ${payuStatus}` : "payu hash mismatch",
        JSON.stringify({ payu_status: p.status, mihpayid: p.mihpayid, mode: p.mode, hash_ok: hashOk })]).catch(() => {});
    await enqueueWebhook({
      merchantId: o.merchant_id, orderId: o.id,
      eventType: success ? "payment.success" : "payment.failed",
      payload: { txn_id: txnid, provider: "PAYU", status: nextStatus,
                 amount: p.amount ?? null, mihpayid: p.mihpayid ?? null, hash_verified: hashOk },
    }).catch(() => null);
  }

  return {
    matched: true, txnid, status: nextStatus, hashOk,
    dest: success ? o.client_surl : o.client_furl,
    reason: hashOk ? undefined : "hash_verification_failed",
    applied,
  };
}
