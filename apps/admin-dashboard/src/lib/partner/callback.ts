// The callback of a partner's order (lib/partner): sent to the PARTNER, never to the banker that
// took the order. Always the v2 event (lib/webhook-v2) with the sub-merchant added, signed with the
// partner's own secret (X-Katana-Signature). Delivery and retries are the shared outbox's (owner
// "partner:<id>", which lib/webhook-outbox signs with the partner's secret).
//
// Target: the order's own callback_url, else the partner's webhook URL. A partner with no signing
// secret is not sent anything (never an unsigned callback); the order says why.

import { rows } from "@/lib/pg";
import { enqueue, deliverNow } from "@/lib/webhook-outbox";
import { newEventId, v2Body, v2Status, wantsEvent } from "@/lib/webhook-v2";
import { PARTNER_OUTBOX_PREFIX } from "@/lib/partner/rules";
import { getPartner, partnerWebhookSecret } from "@/lib/partner/store";

/** The body a partner receives (and reads from GET /api/v1/partner/orders/{id}). */
export function partnerOrderBody(o: Parameters<typeof v2Body>[0], eventId: string | null = null) {
  const p = o.meta?.partner ?? {};
  return {
    ...v2Body(o, eventId),
    sub_merchant_id: typeof p.sub_merchant === "string" ? p.sub_merchant : null,
    external_id: typeof p.external_id === "string" ? p.external_id : null,
    livemode: o.livemode !== false,
  };
}

export async function sendPartnerCallback(orderRowId: string, cur: any, stampStatus: string): Promise<{ sent: boolean; reason?: string }> {
  const stamp = (callback: Record<string, unknown>) =>
    rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
      [orderRowId, JSON.stringify({ callback: { ...callback, version: "partner" } })]).catch(() => {});
  const at = new Date().toISOString();
  const meta = cur.meta ?? {};
  const partner = await getPartner(String(meta.partner?.id ?? ""));
  if (!partner) { await stamp({ skipped: "no partner", at }); return { sent: false, reason: "no partner" }; }

  const target = (typeof meta.notify_url === "string" && /^https?:\/\//i.test(meta.notify_url) ? meta.notify_url : null)
    ?? partner.webhook_url;
  if (!target) { await stamp({ skipped: "no target", at }); return { sent: false, reason: "no target" }; }
  // "Paid only": failed and expired are left for the status API. The status is still stamped, so a
  // payment that lands later is announced.
  if (!wantsEvent(partner.webhook_events, v2Status(cur.status))) {
    await stamp({ skipped: "not subscribed", status: stampStatus, at, target });
    return { sent: false, reason: "not subscribed" };
  }
  if (!(await partnerWebhookSecret(partner.id))) {
    await stamp({ skipped: "no signing secret", at, target });
    return { sent: false, reason: "no signing secret" };
  }

  const eventId = newEventId();
  const body = partnerOrderBody(cur, eventId);
  let outboxId: string | null = null, queueError = false;
  try {
    outboxId = await enqueue({
      merchantId: `${PARTNER_OUTBOX_PREFIX}${partner.id}`, eventType: body.event!, orderId: orderRowId,
      payload: body as unknown as Record<string, unknown>, targetUrlOverride: target, livemode: cur.livemode !== false,
      version: "v2", eventId,
    });
  } catch { queueError = true; }
  if (!outboxId) {
    const skipped = queueError ? "not queued" : "webhooks disabled";
    await stamp({ skipped, at, target });
    return { sent: false, reason: skipped };
  }
  await stamp({ sent_at: at, target, outbox_id: outboxId, status: stampStatus, event_id: eventId });
  await deliverNow(outboxId).catch(() => {});
  return { sent: true };
}
