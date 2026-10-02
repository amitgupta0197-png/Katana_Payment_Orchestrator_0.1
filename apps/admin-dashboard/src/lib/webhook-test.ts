// Sample events, sent from the portal to a banker's registered callback URL so an integration
// can be tried without waiting for a payment.
//
// A sample belongs to no order and touches none: it is its own outbox row (is_test), attempted
// once, never retried, never counted as a callback owed. It is sent in the banker's own
// contract — a v2 banker gets the v2 event with its header signature, a v1 banker the v1
// callback with its HASH — so what is tested is what will really arrive.

import { enqueue, deliverNow, type DeliveryResult } from "@/lib/webhook-outbox";
import { webhookDelivery } from "@/lib/webhook-settings";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { callbackStatus, signKatanaHash } from "@/lib/katana-pay";
import { newEventId, v2SampleBody, v2StatusOfEvent, type V2Event } from "@/lib/webhook-v2";

export type TestEventResult =
  | { ok: true; outbox_id: string; version: "v1" | "v2"; event: V2Event; target_url: string; result: DeliveryResult }
  | { ok: false; error: string };

export async function sendTestEvent(merchantCode: string, event: V2Event, by: string): Promise<TestEventResult> {
  const d = await webhookDelivery(merchantCode);
  if (!d.url) return { ok: false, error: "set a callback URL first" };

  let payload: Record<string, unknown>, eventType: string, eventId: string | null = null;
  if (d.version === "v2") {
    eventId = newEventId();
    payload = v2SampleBody(event, eventId) as unknown as Record<string, unknown>;
    eventType = event;
  } else {
    // Signed with the test Salt when there is one, so a sample never needs the live secret.
    const creds = (await getCheckoutCreds(merchantCode, false)) ?? (await getCheckoutCreds(merchantCode, true));
    if (!creds?.salt) return { ok: false, error: "issue a Key + Salt first: the callback is signed with the Salt" };
    const st = callbackStatus(v2StatusOfEvent(event));
    const v1: Record<string, string> = {
      PAY_ID: "pay_test", ORDER_ID: "test-event", TXN_ID: "txn_test", AMOUNT: "100", CURRENCY_CODE: "356",
      STATUS: st.STATUS, RESPONSE_CODE: st.RESPONSE_CODE, RRN: event === "payment.success" ? "000000000000" : "",
      RESPONSE_DATE_TIME: new Date().toISOString(), LIVEMODE: "false",
    };
    payload = { ...v1, HASH: signKatanaHash(v1, creds.salt) };
    eventType = "payin.status";
  }

  const outboxId = await enqueue({
    merchantId: merchantCode, eventType, payload, targetUrlOverride: d.url, livemode: false,
    version: d.version, eventId, isTest: true, requestedBy: by,
  });
  if (!outboxId) return { ok: false, error: "webhooks are switched off for this account" };
  const result = await deliverNow(outboxId);
  if (!result) return { ok: false, error: "the test event could not be sent" };
  return { ok: true, outbox_id: outboxId, version: d.version, event, target_url: d.url, result };
}
