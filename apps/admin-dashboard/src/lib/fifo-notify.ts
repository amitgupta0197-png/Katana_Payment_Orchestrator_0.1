// Merchant status callbacks (PayTech BRD §19, AC-006). On a final status the
// module POSTs a signed payload to the order's callback_url. The signature is
// HMAC-SHA256 over the canonical body, so merchants can verify authenticity.

import { createHmac } from "crypto";
import { rows } from "@/lib/pg";
import { recordEvent } from "@/lib/fifo";

const SECRET = process.env.FIFO_WEBHOOK_SECRET ?? process.env.SESSION_SECRET ?? "dev-webhook-secret";

export function signPayload(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

// Fire a signed status callback for an order. Best-effort: failures are recorded
// as events but never block the operator action.
export async function sendStatusCallback(order: {
  id: string; order_ref: string; txn_ref?: string | null; callback_url?: string | null;
  amount_minor?: string | bigint | null; currency?: string | null; status: string;
  utr?: string | null; tx_hash?: string | null;
}): Promise<void> {
  if (!order.callback_url) return;
  const payload = {
    order_id: order.order_ref,
    transaction_id: order.txn_ref ?? null,
    status: order.status,
    amount_minor: order.amount_minor ? String(order.amount_minor) : null,
    currency: order.currency ?? null,
    utr: order.utr ?? null,
    tx_hash: order.tx_hash ?? null,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(body);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(order.callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-signature": signature, "x-signature-alg": "HMAC-SHA256" },
      body, signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    await recordEvent({ orderId: order.id, from: order.status, to: order.status, actorKind: "system",
      reason: `callback ${r.ok ? "delivered" : "failed"} (HTTP ${r.status})`, payload: { callback_url: order.callback_url, http_status: r.status } });
  } catch (e) {
    await recordEvent({ orderId: order.id, from: order.status, to: order.status, actorKind: "system",
      reason: `callback error: ${(e as Error).message}`, payload: { callback_url: order.callback_url } });
  }
}

// Persist a callback_url on an order (used at intake).
export async function setCallbackUrl(orderId: string, url?: string | null): Promise<void> {
  if (!url) return;
  await rows("fifo", `UPDATE fifo_orders SET callback_url=$2 WHERE id=$1::uuid`, [orderId, url]).catch(() => {});
}
