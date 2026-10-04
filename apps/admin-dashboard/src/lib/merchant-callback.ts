// Outbound merchant STATUS CALLBACK for Katana Pay pay-ins.
//
// When a pay-in reaches a terminal status we POST a Katana status callback
// to the merchant's server so any-language website can reconcile the order. The
// body carries a HASH the merchant verifies with their checkout SALT (the same
// Key+Salt they already use to sign requests) — see signKatanaHash. The merchant
// should respond HTTP 200.
//
// Target precedence: the per-order notify_url (passed at order creation) → the
// merchant's configured webhook_url. Delivery + retries go through the existing
// webhook_outbox engine; we also kick an immediate dispatch so the first attempt
// is instant. Idempotent per status: meta.callback (sent_at + status) guards against
// double-sends, while an EXPIRED order revived by a late payment is still told "Captured".
//
// A BANKER ON WEBHOOK v2 WITH A SIGNING SECRET (lib/webhook-settings) is sent the v2 event instead: payment.success /
// payment.failed / payment.expired with the header signature (lib/webhook-v2). Everything around
// it is shared — the target, the once-per-status guard, the outbox and its retries — so a v2
// banker is told about exactly the same moments as a v1 one. A banker on v1 is never sent v2.
//
// AN ORDER THE BANKER SWITCH MOVED (lib/banker-switch, meta.signed_by) is called back as the
// SIGNING banker's own order would be: its target, its webhook version and events, its Salt or
// signing secret. The merchant's server verifies it with the Salt it signed the order with. The
// order itself, its money and its settlement are the banker's that took it.

import { rows } from "@/lib/pg";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { signKatanaHash, callbackStatus, payinCallbackSent } from "@/lib/katana-pay";
import { enqueue, dispatchPending, deliverNow } from "@/lib/webhook-outbox";
import { KATANA_TERMINAL } from "@/lib/katana-pay";
import { webhookDelivery } from "@/lib/webhook-settings";
import { newEventId, v2Body, v2Status, wantsEvent } from "@/lib/webhook-v2";

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
           currency_code, status, COALESCE(rrn,'') AS rrn, meta, livemode, created_at, updated_at
      FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'
  `, [orderRowId]).catch(() => []))[0];
  if (!cur) return { sent: false, reason: "not found" };
  if (!KATANA_TERMINAL.has(cur.status)) return { sent: false, reason: "not terminal" };

  const meta = cur.meta ?? {};
  // Idempotent per status: an order told "Expired" and then paid late still gets its "Captured".
  if (payinCallbackSent(meta.callback, cur.status)) return { sent: false, reason: "already sent" };
  // Whose callback this is: the signing banker's when the banker switch moved the order.
  const merchantCode: string | null = (typeof meta.signed_by === "string" && meta.signed_by) || cur.merchant_id || null;
  if (!merchantCode) return { sent: false, reason: "no merchant" };

  const delivery = await webhookDelivery(merchantCode).catch(() => null);
  const target = (meta.notify_url && /^https?:\/\//i.test(meta.notify_url)) ? meta.notify_url
    : delivery ? delivery.url : await merchantWebhookUrl(merchantCode);
  if (!target) {
    // Record the attempt so ops can see "no callback target configured".
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { skipped: "no target", at: new Date().toISOString() } })]).catch(() => {});
    return { sent: false, reason: "no target" };
  }

  const st = callbackStatus(cur.status);
  // "Paid only" (the banker's own choice, either version): failed and expired are left for the
  // merchant to read from the status API. The status is kept on the stamp, so a payment that
  // lands later is still announced, and the sweep's backstop still covers it.
  if (delivery && !wantsEvent(delivery.events, v2Status(cur.status))) {
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { skipped: "not subscribed", status: st.STATUS, at: new Date().toISOString(), target } })]).catch(() => {});
    return { sent: false, reason: "not subscribed" };
  }
  if (delivery?.version === "v2")
    return sendV2(orderRowId, cur, merchantCode, target, st.STATUS);
  // Katana payload. Keys are uppercase so the SHA256 sort matches the doc.
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
  // Test callbacks say so. The field is added ONLY for test orders, so a live payload — and
  // the HASH every merchant already verifies — is exactly what it was before test mode.
  const livemode = cur.livemode !== false;
  if (!livemode) payload.LIVEMODE = "false";

  // Sign with the merchant's checkout SALT so they verify with their existing creds.
  let hash = "";
  try {
    const creds = await getCheckoutCreds(merchantCode, livemode);   // the salt of the order's own mode
    if (creds?.salt) hash = signKatanaHash(payload, creds.salt);
  } catch { /* handled below */ }
  if (!hash) {
    // Never deliver an UNSIGNED status callback (audit M5) — a merchant can't distinguish it
    // from a spoof. Record the skip (visible + retryable once signing creds are configured).
    await rows("vendorGateway", `
      UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1::uuid
    `, [orderRowId, JSON.stringify({ callback: { skipped: "no signing creds", at: new Date().toISOString(), target } })]).catch(() => {});
    return { sent: false, reason: "no signing creds" };
  }
  const body = { ...payload, HASH: hash };

  let outboxId: string | null = null, queueError = false;
  try {
    outboxId = await enqueue({
      merchantId: merchantCode, eventType: "payin.status", orderId: orderRowId,
      payload: body, targetUrlOverride: target, livemode,
    });
  } catch { queueError = true; }
  if (!outboxId) {
    // NOTHING WAS QUEUED, so this is not recorded as sent. "not queued" (the outbox write failed)
    // is picked up again by the status sweep; a merchant whose webhooks are switched off is not.
    const skipped = queueError ? "not queued" : "webhooks disabled";
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { skipped, at: new Date().toISOString(), target } })]).catch(() => {});
    return { sent: false, reason: skipped };
  }

  // Stamp BEFORE dispatching so a retry/parallel caller won't double-enqueue.
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1::uuid
  `, [orderRowId, JSON.stringify({ callback: { sent_at: new Date().toISOString(), target, outbox_id: outboxId, status: payload.STATUS } })]).catch(() => {});

  // The first attempt is of THIS callback, now. Draining "whatever is due" alone sends older rows
  // first, and with five failing ones queued this order's callback waited for the next scheduled
  // drain. The drain still follows, as before; retries are handled by the outbox/cron.
  await deliverNow(outboxId).catch(() => {});
  await dispatchPending({ limit: 5 }).catch(() => {});
  return { sent: true };
}

// The v2 event for the same moment. `stampStatus` is the word the shared once-per-status guard
// (payinCallbackSent, the status sweep) reads from meta.callback; it never reaches the merchant.
async function sendV2(
  orderRowId: string, cur: any, merchantCode: string, target: string, stampStatus: string,
): Promise<{ sent: boolean; reason?: string }> {
  const stamp = (callback: Record<string, unknown>) =>
    rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { ...callback, version: "v2" } })]).catch(() => {});
  const at = new Date().toISOString();

  // A banker reaches here only with a signing secret (lib/webhook-settings: without one the v1
  // callback is sent instead), so the event is never queued unsigned.
  const livemode = cur.livemode !== false;
  const eventId = newEventId();
  const body = v2Body(cur, eventId);
  let outboxId: string | null = null, queueError = false;
  try {
    outboxId = await enqueue({
      merchantId: merchantCode, eventType: body.event!, orderId: orderRowId,
      payload: body as unknown as Record<string, unknown>, targetUrlOverride: target, livemode,
      version: "v2", eventId,
    });
  } catch { queueError = true; }
  if (!outboxId) {
    const skipped = queueError ? "not queued" : "webhooks disabled";
    await stamp({ skipped, at, target });
    return { sent: false, reason: skipped };
  }
  await stamp({ sent_at: at, target, outbox_id: outboxId, status: stampStatus, event_id: eventId });
  // The first attempt is of THIS row, now. Draining "whatever is due" (as the v1 path does) sends
  // older, failing rows first, and with a handful of those queued this one would wait for the
  // next scheduled drain. Retries are the outbox's.
  await deliverNow(outboxId).catch(() => {});
  return { sent: true };
}
