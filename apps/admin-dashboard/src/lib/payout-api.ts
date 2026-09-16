// Merchant-facing payout API: request signing, the public status vocabulary, and the
// signed status callback.
//
// AUTH. Same Key + Salt the merchant already uses for pay-ins, and the key's prefix decides
// test or live (lib/merchant-checkout). The signed string is payout-specific, because a
// payout's money-bearing fields (who is paid, how much, on which rail) are not the pay-in
// fields, and each must be covered:
//
//   PAYU_SHA512   hash = sha512(key|f1|f2|...|salt)          lowercase hex
//   HMAC_SHA256   hash = HMAC_SHA256(key + salt, f1|f2|...)   lowercase hex
//
//   create payout      txnid|amount|beneficiary|rail|purpose
//                      (beneficiary = the beneficiary_ref or beneficiary_id you send)
//   register bene      beneficiary_ref|name|account_number|ifsc|upi_id
//   payout status      txnid
//
// A field the merchant leaves out is signed as an empty string in its position.
//
// CALLBACK. On a final status Katana POSTs the same kind of body as the pay-in callback,
// signed the same way (sorted NAME=value pairs joined by "~", salt appended, SHA-256,
// uppercase), so the merchant's existing verifier works unchanged. EVENT tells them apart.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { rows } from "@/lib/pg";
import { recordEvent } from "@/lib/fifo";
import { fromMinor } from "@/lib/money";
import { resolveCheckoutKey, getCheckoutCreds, type CheckoutCreds } from "@/lib/merchant-checkout";
import { isLiveActivated } from "@/lib/live-activation";
import { signPoolPay } from "@/lib/provider-integration";
import { enqueue, dispatchPending } from "@/lib/webhook-outbox";

export function payoutSignature(creds: CheckoutCreds, fields: (string | null | undefined)[]): string {
  const parts = fields.map((f) => f ?? "");
  if (creds.scheme === "HMAC_SHA256")
    return createHmac("sha256", `${creds.key}${creds.salt}`).update(parts.join("|")).digest("hex");
  return createHash("sha512").update([creds.key, ...parts, creds.salt].join("|")).digest("hex");
}

export type PayoutAuth =
  | { ok: true; merchantCode: string; livemode: boolean; creds: CheckoutCreds }
  | { ok: false; status: number; error: string; code?: string };

/** Check the key, the mode's activation and the signature over `fields`. */
export async function authPayoutRequest(key: string, hash: string, fields: (string | null | undefined)[]): Promise<PayoutAuth> {
  const resolved = await resolveCheckoutKey(key);
  if (!resolved) return { ok: false, status: 401, error: "invalid key" };
  const creds = await getCheckoutCreds(resolved.merchantCode, resolved.livemode);
  if (!creds || creds.key !== key) return { ok: false, status: 401, error: "invalid key" };

  const want = Buffer.from(payoutSignature(creds, fields), "hex");
  const got = /^[0-9a-f]+$/i.test(hash) ? Buffer.from(hash.toLowerCase(), "hex") : Buffer.alloc(0);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, status: 401, error: "signature mismatch" };

  if (resolved.livemode && !(await isLiveActivated(resolved.merchantCode)))
    return { ok: false, status: 403, error: "live mode is not activated for this merchant", code: "LIVE_MODE_NOT_ACTIVATED" };
  return { ok: true, ...resolved, creds };
}

/** Merchant servers send JSON or a form, like the pay-in endpoint accepts. */
export async function parseMerchantBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

// ── Public status ────────────────────────────────────────────────────────────
// Merchants see six statuses, not the internal operations lifecycle.
export type PublicPayoutStatus = "PROCESSING" | "ON_HOLD" | "SUCCESS" | "FAILED" | "REJECTED" | "REVERSED";

export function publicPayoutStatus(internal: string): PublicPayoutStatus {
  switch (internal) {
    case "COMPLETED": case "SETTLED": return "SUCCESS";
    case "FAILED": return "FAILED";
    case "REJECTED": case "CANCELLED": return "REJECTED";
    case "REVERSED": return "REVERSED";
    case "HOLD": return "ON_HOLD";
    default: return "PROCESSING";
  }
}

/** Final for the merchant's purposes. SUCCESS can still become REVERSED if the bank returns it. */
export function isFinalPayoutStatus(s: PublicPayoutStatus): boolean {
  return s === "SUCCESS" || s === "FAILED" || s === "REJECTED" || s === "REVERSED";
}

export interface PayoutView {
  payout_id: string; txnid: string | null; status: PublicPayoutStatus; terminal: boolean;
  amount: string; currency: string; rail: string | null; beneficiary_id: string | null;
  utr: string | null; failure_reason: string | null; livemode: boolean;
  created_at: string; completed_at: string | null;
}

export const PAYOUT_VIEW_COLS = `order_ref, merchant_txn_id, status, amount_minor::text, currency, payout_rail,
  beneficiary_id::text, utr, failure_reason, livemode, created_at, completed_at`;

export function payoutView(r: any): PayoutView {
  const status = publicPayoutStatus(r.status);
  return {
    payout_id: r.order_ref, txnid: r.merchant_txn_id ?? null, status, terminal: isFinalPayoutStatus(status),
    amount: fromMinor(r.amount_minor, r.currency), currency: r.currency, rail: r.payout_rail ?? null,
    beneficiary_id: r.beneficiary_id ?? null, utr: r.utr ?? null,
    // Only a reason the merchant can act on; internal notes stay internal.
    failure_reason: status === "FAILED" || status === "REJECTED" || status === "REVERSED" ? r.failure_reason ?? null : null,
    livemode: r.livemode !== false,
    created_at: new Date(r.created_at).toISOString(),
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

// ── Callback ─────────────────────────────────────────────────────────────────
async function merchantWebhookUrl(merchantCode: string): Promise<string | null> {
  const r = await rows<{ webhook_url: string | null }>(
    "merchant", `SELECT webhook_url FROM merchants WHERE merchant_code = $1`, [merchantCode],
  ).catch(() => []);
  const u = r[0]?.webhook_url?.trim();
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * Queue the signed callback for a payout's current status, once per status. Safe to call from
 * every place a payout reaches a final status. Delivery and retries go through webhook_outbox.
 */
export async function sendPayoutCallback(orderId: string): Promise<{ sent: boolean; reason?: string }> {
  const o = (await rows<any>("fifo", `
    SELECT id::text, merchant_id, callback_url, callback_status, ${PAYOUT_VIEW_COLS}
      FROM fifo_orders WHERE id=$1::uuid AND direction='PAYOUT'
  `, [orderId]).catch(() => []))[0];
  if (!o) return { sent: false, reason: "not found" };
  const view = payoutView(o);
  if (!view.terminal) return { sent: false, reason: "not final" };

  const note = (reason: string, payload?: Record<string, unknown>) =>
    recordEvent({ orderId, from: o.status, to: o.status, actorKind: "system", reason, payload });

  const target = (o.callback_url && /^https?:\/\//i.test(o.callback_url)) ? o.callback_url : await merchantWebhookUrl(o.merchant_id);
  if (!target) { await note("no payout callback sent: no callback URL"); return { sent: false, reason: "no target" }; }
  const creds = await getCheckoutCreds(o.merchant_id, view.livemode).catch(() => null);
  // Never send an unsigned callback: the merchant couldn't tell it from a forgery.
  if (!creds?.salt) { await note("no payout callback sent: no Key + Salt to sign it"); return { sent: false, reason: "no signing creds" }; }

  // Claim this status so a webhook and the sweep landing together queue one callback.
  const claimed = await rows<{ id: string }>("fifo", `
    UPDATE fifo_orders SET callback_status=$2
     WHERE id=$1::uuid AND callback_status IS DISTINCT FROM $2 RETURNING id::text
  `, [orderId, view.status]);
  if (!claimed.length) return { sent: false, reason: "already sent" };

  const payload: Record<string, string> = {
    EVENT: "payout.status",
    PAYOUT_ID: view.payout_id,
    ORDER_ID: view.txnid ?? "",
    AMOUNT: view.amount,
    CURRENCY_CODE: view.currency === "INR" ? "356" : view.currency,
    STATUS: view.status,
    RAIL: view.rail ?? "",
    UTR: view.utr ?? "",
    FAILURE_REASON: view.failure_reason ?? "",
    RESPONSE_DATE_TIME: new Date().toISOString(),
  };
  if (!view.livemode) payload.LIVEMODE = "false";
  const body = { ...payload, HASH: signPoolPay(payload, creds.salt) };

  try {
    const outboxId = await enqueue({
      merchantId: o.merchant_id, eventType: "payout.status", orderId,
      payload: body, targetUrlOverride: target, livemode: view.livemode,
    });
    await note(`payout callback queued (${view.status})`, { target, outbox_id: outboxId });
  } catch (err) {
    // Release the claim so the next final-status touch (or the sweep) tries again.
    await rows("fifo", `UPDATE fifo_orders SET callback_status=$2 WHERE id=$1::uuid`, [orderId, o.callback_status ?? null]).catch(() => {});
    await note(`payout callback not queued: ${(err as Error).message}`);
    return { sent: false, reason: "enqueue failed" };
  }
  await dispatchPending({ limit: 5 }).catch(() => {});
  return { sent: true };
}
