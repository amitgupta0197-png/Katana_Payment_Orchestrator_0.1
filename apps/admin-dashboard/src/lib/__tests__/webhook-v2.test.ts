// The v2 contract (lib/webhook-v2): the four statuses, the order id, the body a webhook and the
// status API share, and the header signature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { genRrn } from "@/lib/katana-pay";
import {
  v2Status, v2EventFor, v2OrderId, orderUuidFrom, v2Body, v2ExpiresAt, v2SampleBody, rrnIsSynthetic,
  v2SignatureHeader, verifyV2Signature, wantsEvent, V2_STATUSES, type V2OrderRow,
} from "@/lib/webhook-v2";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";
const order = (o: Partial<V2OrderRow> = {}): V2OrderRow => ({
  id: ID, order_id: "inv-1001", status: "PENDING", amount: "2000.00", currency_code: "INR", rrn: null,
  meta: {}, created_at: "2026-10-02T14:00:00Z", updated_at: "2026-10-02T14:00:00Z", ...o,
});

test("every stored status is one of the four v2 words", () => {
  const stored = ["INITIATED", "PENDING", "PROOF_SUBMITTED", "SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "", null, "Captured", "anything"];
  for (const s of stored) assert.ok((V2_STATUSES as readonly string[]).includes(v2Status(s)), String(s));
  assert.deepEqual(["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "PENDING", "INITIATED"].map(v2Status),
    ["SUCCESS", "SUCCESS", "FAILED", "EXPIRED", "PENDING", "PENDING"]);
});

test("a final status has an event and a pending order has none", () => {
  assert.deepEqual(V2_STATUSES.map(v2EventFor), [null, "payment.success", "payment.failed", "payment.expired"]);
});

test("an order id is KTN_ and the order's own id, and reads back to it", () => {
  const ktn = v2OrderId(ID);
  assert.equal(ktn, "KTN_3f2b8c1e9a4d4e6f8b7a0c1d2e3f4a5b");
  assert.equal(orderUuidFrom(ktn), ID);
  assert.equal(orderUuidFrom(ID), ID);
  assert.equal(orderUuidFrom("inv-1001"), null);
  assert.equal(orderUuidFrom("KTN_short"), null);
});

test("a pending order: minor units, no event, no bank reference, no gateway", () => {
  assert.deepEqual(v2Body(order()), {
    event: null, event_id: null, order_id: v2OrderId(ID), reference: "inv-1001", status: "PENDING",
    amount: 200000, currency: "INR", rrn: null, rrn_is_synthetic: false, paid_at: null, gateway: null,
  });
  assert.equal(v2ExpiresAt(order(), {}), "2026-10-02T14:15:00.000Z");
});

test("expires_at is when the order is told EXPIRED: a gateway order's includes its confirmation window", () => {
  const env = { PAYIN_CONFIRM_WINDOW_SECONDS: "1800" };
  assert.equal(v2ExpiresAt(order(), env), "2026-10-02T14:15:00.000Z");   // no gateway: the 15 minutes
  assert.equal(v2ExpiresAt(order({ meta: { gateway: { provider: "PAYU" } } }), env), "2026-10-02T14:45:00.000Z");
  assert.equal(v2ExpiresAt(order({ meta: { gateway: { provider: "PAYU" } }, livemode: false }), env), "2026-10-02T14:15:00.000Z");
});

test("a paid order carries its bank reference and when it was confirmed", () => {
  const b = v2Body(order({ status: "SUCCESS", rrn: "123456789012", meta: { confirmation: { at: "2026-10-02T14:32:00.000Z" }, gateway: { provider: "PAYU" } } }), "evt_1");
  assert.deepEqual([b.event, b.event_id, b.status, b.rrn, b.rrn_is_synthetic, b.paid_at], ["payment.success", "evt_1", "SUCCESS", "123456789012", false, "2026-10-02T14:32:00.000Z"]);
  assert.equal(b.gateway, null);                      // never named, whatever took the payment
  assert.equal("previous_status" in b, false);
  assert.equal(JSON.stringify(b).includes("PAYU"), false);
  assert.equal(v2ExpiresAt(order({ status: "SUCCESS" })), null);
});

test("a payment that landed after the order expired or failed says what it was before", () => {
  assert.equal(v2Body(order({ status: "SUCCESS", rrn: "1", meta: { revived_from_expired: { at: "x" } } })).previous_status, "EXPIRED");
  assert.equal(v2Body(order({ status: "SUCCESS", rrn: "1", meta: { revived_from_failed: { at: "x" } } })).previous_status, "FAILED");
  assert.equal("previous_status" in v2Body(order({ status: "EXPIRED", meta: { revived_from_expired: { at: "x" } } })), false);
});

test("a bank reference Katana made is marked synthetic; one from a bank is not", () => {
  const made = genRrn(ID);
  assert.equal(rrnIsSynthetic(ID, made), true);
  assert.equal(rrnIsSynthetic(ID, "123456789012"), false);
  assert.equal(rrnIsSynthetic(ID, null), false);
  assert.equal(v2Body(order({ status: "SUCCESS", rrn: made })).rrn_is_synthetic, true);
});

test("an expired or failed order states no bank reference and no paid time", () => {
  for (const status of ["EXPIRED", "FAILED"]) {
    const b = v2Body(order({ status, rrn: "123456789012" }));
    assert.deepEqual([b.rrn, b.rrn_is_synthetic, b.paid_at], [null, false, null]);
  }
});

test("an order held for a manual check has no expiry", () => {
  assert.equal(v2ExpiresAt(order({ meta: { hold: true } })), null);
});

test("the signature is HMAC-SHA256 of timestamp.body with the webhook secret", () => {
  const body = JSON.stringify(v2Body(order({ status: "SUCCESS", rrn: "123456789012" }), "evt_1"));
  const h = v2SignatureHeader("whsec_test", 1_790_000_000, body);
  assert.equal(h, `t=1790000000,v1=${createHmac("sha256", "whsec_test").update(`1790000000.${body}`).digest("hex")}`);
  assert.equal(verifyV2Signature(h, body, "whsec_test", 1_790_000_000), true);
});

test("a delivery is refused when it is altered, signed with another secret, or older than 300 seconds", () => {
  const body = '{"status":"SUCCESS"}';
  const h = v2SignatureHeader("whsec_test", 1_790_000_000, body);
  assert.equal(verifyV2Signature(h, '{"status":"FAILED"}', "whsec_test", 1_790_000_000), false);
  assert.equal(verifyV2Signature(h, body, "whsec_other", 1_790_000_000), false);
  assert.equal(verifyV2Signature(h, body, "whsec_test", 1_790_000_300), true);
  assert.equal(verifyV2Signature(h, body, "whsec_test", 1_790_000_301), false);
  assert.equal(verifyV2Signature(h, body, "whsec_test", 1_789_999_699), false);
  for (const bad of [null, "", "v1=abc", "t=abc,v1=abc"]) assert.equal(verifyV2Signature(bad, body, "whsec_test", 1_790_000_000), false);
});

test("paid-only keeps success and drops the other outcomes; all keeps every one", () => {
  assert.deepEqual(V2_STATUSES.map((s) => wantsEvent("PAID_ONLY", s)), [false, true, false, false]);
  assert.deepEqual(V2_STATUSES.map((s) => wantsEvent("ALL", s)), [true, true, true, true]);
});

test("a sample event has the shape of a real one and is plainly not an order", () => {
  for (const e of ["payment.success", "payment.failed", "payment.expired"] as const) {
    const s = v2SampleBody(e, "evt_t");
    assert.deepEqual(Object.keys(s).sort(), Object.keys(v2Body(order({ status: "SUCCESS", rrn: "1" }), "x")).sort());
    assert.equal(s.event, e);
    assert.equal(s.reference, "test-event");
    assert.equal(orderUuidFrom(s.order_id), null);     // it cannot be read back as an order
  }
});

// The guide is what a merchant integrates from, so it is held to the code.
import { readFileSync } from "node:fs";
import { namesGateway } from "@/lib/merchant-safe";

const GUIDE = readFileSync(new URL("../../../public/katana-v2-guide.html", import.meta.url), "utf8");

test("the v2 guide states that the status API is the authority, in the agreed words", () => {
  assert.ok(GUIDE.includes("Webhooks are notifications; they can fail or retry. Always confirm order status by calling GET /v2/orders/{id} before fulfilling."));
});

test("the v2 guide names no gateway and uses no v1 status word", () => {
  const text = GUIDE.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
  assert.equal(namesGateway(text), false);
  assert.equal(/Captured|RESPONSE_CODE/.test(text), false);
});
