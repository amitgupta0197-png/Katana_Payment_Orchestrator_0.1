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
import { capturePaymentDetails } from "@/lib/payment-details";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";
import { verifyPayuTxn } from "@/lib/payu-verify";

// PayU pay-ins created through the Katana Pay order flow (lib/poolpay-order) live in
// vendor_payin_orders, not checkout_orders, keyed by the PayU txnid Katana generated. They
// are settled through confirmPoolPayOrder so the pay page, the merchant's status callback
// and the reports see the payment exactly as they see any other pay-in.
async function findPayuPayin(txnid: string): Promise<{ id: string; merchant_id: string; meta: any } | null> {
  return (await rows<{ id: string; merchant_id: string; meta: any }>("vendorGateway", `
    SELECT id::text, merchant_id, meta FROM vendor_payin_orders
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1 AND meta->'gateway'->>'provider' = 'PAYU'
     LIMIT 1
  `, [txnid]).catch(() => []))[0] ?? null;
}

async function settlePayuPayin(
  orderId: string, outcome: "SUCCESS" | "FAILED",
  detail: { utr?: string; mihpayid?: string; source: string },
): Promise<{ applied: boolean; reason?: string }> {
  const r = await confirmPoolPayOrder({
    id: orderId,
    livemode: true,               // PayU intents are only ever issued for live orders
    outcome,
    utr: detail.utr?.trim() || null,
    evidence: "WEBHOOK",
    actor: "gateway:payu",
    note: `PayU ${detail.source}${detail.mihpayid ? ` (mihpayid ${detail.mihpayid})` : ""}`,
  });
  if (!r.ok) return { applied: false, reason: r.error };
  return r.idempotent ? { applied: false, reason: "already_final" } : { applied: true };
}

function payuOutcome(status: string): "SUCCESS" | "FAILED" | null {
  const s = status.toLowerCase();
  if (s === "success") return "SUCCESS";
  if (s === "failure" || s === "failed") return "FAILED";
  return null;
}

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
  /** PayU's transaction_details entry, kept verbatim for the merchant-facing detail view. */
  raw?: Record<string, unknown>;
}): Promise<{ applied: boolean; status: "SUCCESS" | "FAILED" | "UNKNOWN"; reason?: string }> {
  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [input.txnid]).catch(() => []))[0];
  if (!o) {
    const v = await findPayuPayin(input.txnid);
    if (!v) return { applied: false, status: "UNKNOWN", reason: "unknown_txn" };
    const outcome = payuOutcome(input.payuStatus);
    if (!outcome) return { applied: false, status: "UNKNOWN", reason: `still ${input.payuStatus.toLowerCase()}` };
    const r = await settlePayuPayin(v.id, outcome, { utr: input.bankRefNum, mihpayid: input.mihpayid, source: "verify_api" });
    return { applied: r.applied, status: outcome, reason: r.reason };
  }

  // Detail is worth keeping even for an order that is already final or still pending:
  // this is often the only channel that ever describes a payment whose callback was lost.
  await capturePaymentDetails({
    orderId: o.id, provider: "PAYU", source: "verify_api",
    payload: { ...(input.raw ?? {}), status: input.payuStatus,
               mihpayid: input.mihpayid, bank_ref_num: input.bankRefNum },
  });

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

/**
 * Stamp a PayU pay-in as checked now — atomically, and only if it was last checked more than
 * `minIntervalSec` ago. False when someone else checked it moments ago, when PayU already gave a
 * final failure, or when the order is settled. This single UPDATE is what stops several open pay
 * pages plus the 15s sweep from multiplying PayU verify calls for one order.
 */
export async function claimPayuPayinCheck(txnid: string, minIntervalSec: number): Promise<boolean> {
  const r = await rows<{ id: string }>("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = jsonb_set(meta, '{gateway,checked_at}',
                            to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1
       AND meta->'gateway'->>'provider' = 'PAYU'
       AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED')
       AND COALESCE(meta->'gateway'->>'final', '') = ''
       AND (meta->'gateway'->>'checked_at' IS NULL
            OR (meta->'gateway'->>'checked_at')::timestamptz < now() - make_interval(secs => $2::double precision))
    RETURNING id::text
  `, [txnid, minIntervalSec]).catch(() => []);
  return r.length > 0;
}

/** Remember PayU's definite failure: an EXPIRED order cannot become FAILED, so it must not be asked again. */
export async function markPayuPayinFinal(txnid: string, payuStatus: string): Promise<void> {
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = jsonb_set(meta, '{gateway,final}', to_jsonb($2::text))
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1 AND meta->'gateway'->>'provider' = 'PAYU'
  `, [txnid, payuStatus]).catch(() => {});
}

/**
 * Ask PayU now whether a PayU pay-in was paid, and settle it if so. Called from the pay-status poll
 * so the customer's page flips within seconds of approving in their UPI app — without waiting for
 * PayU's webhook (which may not be configured) or the sweep. Throttled by claimPayuPayinCheck.
 */
export async function checkPayuPayinNow(txnid: string, merchantId: string, minIntervalSec: number): Promise<{ applied: boolean }> {
  if (!(await claimPayuPayinCheck(txnid, minIntervalSec))) return { applied: false };
  const mid = await getGatewayMid(merchantId);
  if (!mid || mid.gateway !== "PAYU") return { applied: false };
  const v = await verifyPayuTxn(mid, txnid);
  if (!v.found) return { applied: false };
  if (v.status === "failure" || v.status === "failed") await markPayuPayinFinal(txnid, v.status);
  const r = await applyVerifiedPayuStatus({
    txnid, payuStatus: v.status, mihpayid: v.mihpayid, bankRefNum: v.bankRefNum, raw: v.raw,
  });
  return { applied: r.applied };
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
export async function applyPayuResult(
  p: Record<string, string>,
  source: "webhook" | "return" = "webhook",
): Promise<PayuOutcome> {
  const txnid = p.txnid || p.txnId || "";
  const payuStatus = (p.status || "").toLowerCase();
  if (!txnid) return { matched: false, txnid: "", status: "UNKNOWN", hashOk: false, dest: null, reason: "missing txnid", applied: false };

  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status, client_surl, client_furl FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [txnid]).catch(() => []))[0];
  if (!o) {
    const v = await findPayuPayin(txnid);
    if (!v) return { matched: false, txnid, status: "UNKNOWN", hashOk: false, dest: null, reason: "unknown_txn", applied: false };
    const mid = await getGatewayMid(v.merchant_id).then((m) => (m?.gateway === "PAYU" ? m : null));
    const hashOk = !!mid && !!p.hash && payuResponseHash(mid, {
      status: p.status || "", email: p.email || "", firstname: p.firstname || "",
      productinfo: p.productinfo || "", amount: p.amount || "", txnid,
      additionalCharges: p.additionalCharges,
    }).toLowerCase() === p.hash.toLowerCase();
    const dest = typeof v.meta?.return_url === "string" ? v.meta.return_url : null;
    // Unlike a checkout order, an unverified payload here is IGNORED rather than recorded as
    // FAILED: this URL is public, and a forged "failure" must not close an order the customer
    // can still pay. The verify sweep settles it from PayU's own answer.
    if (!hashOk) return { matched: true, txnid, status: "UNKNOWN", hashOk, dest, reason: "hash_verification_failed", applied: false };
    const outcome = payuOutcome(payuStatus);
    if (!outcome) return { matched: true, txnid, status: "UNKNOWN", hashOk, dest, reason: `still ${payuStatus}`, applied: false };
    const r = await settlePayuPayin(v.id, outcome, { utr: p.bank_ref_num || p.bank_ref_no, mihpayid: p.mihpayid, source });
    return { matched: true, txnid, status: outcome, hashOk, dest, reason: r.reason, applied: r.applied };
  }

  // Verify PayU's response hash with THIS merchant's stored PayU salt. Without a stored
  // salt the hash can't be checked, so the payment is not treated as successful — we do
  // not take PayU's word for it unsigned.
  // Only PayU credentials can check a PayU hash; a merchant on another gateway has none.
  const gwMid = await getGatewayMid(o.merchant_id).then((m) => (m?.gateway === "PAYU" ? m : null));
  const expected = gwMid ? payuResponseHash(gwMid, {
    status: p.status || "", email: p.email || "", firstname: p.firstname || "",
    productinfo: p.productinfo || "", amount: p.amount || "", txnid,
    additionalCharges: p.additionalCharges,
  }) : "";
  const hashOk = !!gwMid && !!p.hash && expected.toLowerCase() === p.hash.toLowerCase();

  const success = payuStatus === "success" && hashOk;
  const nextStatus: "SUCCESS" | "FAILED" = success ? "SUCCESS" : "FAILED";

  // Record the gateway's own account of the payment before the status guard below —
  // a duplicate delivery applies nothing to the order but may still carry detail the
  // first delivery lacked, and there is no reason to discard it.
  await capturePaymentDetails({
    orderId: o.id, provider: "PAYU", source, hashVerified: hashOk, payload: p,
  });

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
