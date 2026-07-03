// Outbound merchant STATUS CALLBACK for Katana Pay pay-ins.
//
// When a pay-in reaches a terminal status we POST a PoolPay-style status callback
// to the merchant's server so any-language website can reconcile the order. The
// body carries a HASH the merchant verifies with their checkout SALT (the same
// Key+Salt they already use to sign requests) — see signPoolPay. The merchant
// should respond HTTP 200.
//
// Target precedence: the per-order notify_url (passed at order creation) → the
// merchant's configured webhook_url. Delivery + retries go through the existing
// webhook_outbox engine; we also kick an immediate dispatch so the first attempt
// is instant. Idempotent: meta.callback.sent_at guards against double-sends.

import { rows } from "@/lib/pg";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { signPoolPay } from "@/lib/provider-integration";
import { enqueue, dispatchPending } from "@/lib/webhook-outbox";
import { POOLPAY_TERMINAL } from "@/lib/poolpay";

// Map our internal status → PoolPay-style (STATUS, RESPONSE_CODE) for the callback.
function poolpayStatus(status: string): { STATUS: string; RESPONSE_CODE: string } {
  switch (status) {
    case "SUCCESS": case "SUCCEEDED": return { STATUS: "Captured", RESPONSE_CODE: "000" };
    case "FAILED": return { STATUS: "Failed", RESPONSE_CODE: "004" };
    case "EXPIRED": return { STATUS: "Expired", RESPONSE_CODE: "003" };
    default: return { STATUS: status, RESPONSE_CODE: "005" };
  }
}

async function merchantWebhookUrl(merchantCode: string): Promise<string | null> {
  const r = await rows<{ webhook_url: string | null }>(
    "merchant", `SELECT webhook_url FROM merchants WHERE merchant_code = $1`, [merchantCode],
  ).catch(() => []);
  const u = r[0]?.webhook_url?.trim();
  return u && /^https?:\/\//i.test(u) ? u : null;
}

// Send the status callback for a pay-in (by vendor_payin_orders.id). Safe to call
// from any terminal-transition point — it self-guards on terminal + already-sent.
export async function sendPayinCallback(orderRowId: string): Promise<{ sent: boolean; reason?: string }> {
  const cur = (await rows<any>("vendorGateway", `
    SELECT id::text, order_id, merchant_id, pay_id, vendor_txn_id, amount::float AS amount,
           currency_code, status, COALESCE(rrn,'') AS rrn, meta
      FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'
  `, [orderRowId]).catch(() => []))[0];
  if (!cur) return { sent: false, reason: "not found" };
  if (!POOLPAY_TERMINAL.has(cur.status)) return { sent: false, reason: "not terminal" };

  const meta = cur.meta ?? {};
  if (meta.callback?.sent_at) return { sent: false, reason: "already sent" };       // idempotent
  const merchantCode: string | null = cur.merchant_id ?? null;
  if (!merchantCode) return { sent: false, reason: "no merchant" };

  const target = (meta.notify_url && /^https?:\/\//i.test(meta.notify_url)) ? meta.notify_url : await merchantWebhookUrl(merchantCode);
  if (!target) {
    // Record the attempt so ops can see "no callback target configured".
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { skipped: "no target", at: new Date().toISOString() } })]).catch(() => {});
    return { sent: false, reason: "no target" };
  }

  const st = poolpayStatus(cur.status);
  // PoolPay-style payload. Keys are uppercase so the SHA256 sort matches the doc.
  const payload: Record<string, string> = {
    PAY_ID: String(cur.pay_id ?? ""),
    ORDER_ID: String(cur.order_id),
    TXN_ID: String(cur.vendor_txn_id ?? ""),
    AMOUNT: String(cur.amount),
    CURRENCY_CODE: cur.currency_code === "INR" ? "356" : String(cur.currency_code ?? ""),
    STATUS: st.STATUS,
    RESPONSE_CODE: st.RESPONSE_CODE,
    RRN: String(cur.rrn ?? ""),
    RESPONSE_DATE_TIME: new Date().toISOString(),
  };

  // Sign with the merchant's checkout SALT so they verify with their existing creds.
  let hash = "";
  try {
    const creds = await getCheckoutCreds(merchantCode);
    if (creds?.salt) hash = signPoolPay(payload, creds.salt);
  } catch { /* unsigned if creds missing — body still delivered */ }
  const body = { ...payload, HASH: hash };

  const outboxId = await enqueue({
    merchantId: merchantCode, eventType: "payin.status", orderId: orderRowId,
    payload: body, targetUrlOverride: target,
  }).catch(() => null);

  // Stamp BEFORE dispatching so a retry/parallel caller won't double-enqueue.
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1::uuid
  `, [orderRowId, JSON.stringify({ callback: { sent_at: new Date().toISOString(), target, outbox_id: outboxId, status: payload.STATUS } })]).catch(() => {});

  // Kick an immediate delivery attempt; retries are handled by the outbox/cron.
  await dispatchPending({ limit: 5 }).catch(() => {});
  return { sent: true };
}
