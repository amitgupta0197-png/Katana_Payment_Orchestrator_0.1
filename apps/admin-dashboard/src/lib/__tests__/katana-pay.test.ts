// Katana Pay order core (lib/katana-pay): status rules, test-order outcomes and the callback hash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildKatanaSignString, decideKatanaStatus, resolveKatanaStatus, signKatanaHash, verifyKatanaHash, payinCallbackSent, PENDING_EXPIRY_SECONDS,
  gatewayCheckNote, confirmWindowSeconds, orderExpirySeconds, inConfirmWindow, CONFIRM_WINDOW_MAX_SECONDS,
} from "@/lib/katana-pay";

test("a live order never changes state on its amount", () => {
  for (const paise of [1399, 1311, 1399 + 86, 49999]) assert.equal(decideKatanaStatus(paise, 60, true).status, "PENDING");
});

test("a test order's paise force the outcome", () => {
  assert.equal(decideKatanaStatus(10013, 1, false).status, "FAILED");
  assert.equal(decideKatanaStatus(10011, 1, false).status, "EXPIRED");
  assert.equal(decideKatanaStatus(10099, 3, false).status, "PENDING");   // not before ~8s
  assert.equal(decideKatanaStatus(10099, 9, false).status, "SUCCESS");
  assert.equal(decideKatanaStatus(10000, 60, false).status, "PENDING");
});

test("a terminal status is final; a pending order expires after the limit", () => {
  assert.deepEqual(resolveKatanaStatus("SUCCESS", 10013, 9999, false), { status: "SUCCESS", response_code: "", changed: false });
  assert.equal(resolveKatanaStatus("PENDING", 10000, PENDING_EXPIRY_SECONDS - 1).status, "PENDING");
  const e = resolveKatanaStatus("PENDING", 10000, PENDING_EXPIRY_SECONDS);
  assert.deepEqual([e.status, e.changed], ["EXPIRED", true]);
});

test("the confirmation window is off until set, and only a live gateway order has one", () => {
  const gw = { gateway: { provider: "PAYU" } };
  assert.equal(confirmWindowSeconds(gw, true, {}), 0);
  assert.equal(orderExpirySeconds(gw, true, {}), PENDING_EXPIRY_SECONDS);
  const env = { PAYIN_CONFIRM_WINDOW_SECONDS: "1800" };
  assert.equal(confirmWindowSeconds(gw, true, env), 1800);
  assert.equal(confirmWindowSeconds({}, true, env), 0);            // P2P: no gateway to wait for
  assert.equal(confirmWindowSeconds(null, true, env), 0);
  assert.equal(confirmWindowSeconds(gw, false, env), 0);           // a test order
  assert.equal(orderExpirySeconds(gw, true, env), PENDING_EXPIRY_SECONDS + 1800);
});

test("a gateway's own window wins, and a bad or huge value is not trusted", () => {
  const gw = (provider: string) => ({ gateway: { provider } });
  const env = { PAYIN_CONFIRM_WINDOW_SECONDS: "1800", PAYIN_CONFIRM_WINDOW_SECONDS_PAYU: "7200", PAYIN_CONFIRM_WINDOW_SECONDS_CASHFREE: "0" };
  assert.equal(confirmWindowSeconds(gw("payu"), true, env), 7200);
  assert.equal(confirmWindowSeconds(gw("CASHFREE"), true, env), 0);   // switched off for this one
  assert.equal(confirmWindowSeconds(gw("RAZORPAY"), true, env), 1800);
  assert.equal(confirmWindowSeconds(gw("PAYU"), true, { PAYIN_CONFIRM_WINDOW_SECONDS: "soon" }), 0);
  assert.equal(confirmWindowSeconds(gw("PAYU"), true, { PAYIN_CONFIRM_WINDOW_SECONDS: "-5" }), 0);
  assert.equal(confirmWindowSeconds(gw("PAYU"), true, { PAYIN_CONFIRM_WINDOW_SECONDS: "999999" }), CONFIRM_WINDOW_MAX_SECONDS);
});

test("in the window the order stays pending and the customer's time is over; after it, it expires", () => {
  const gw = { gateway: { provider: "PAYU" } };
  const env = { PAYIN_CONFIRM_WINDOW_SECONDS: "1800" };
  const limit = orderExpirySeconds(gw, true, env);
  assert.equal(resolveKatanaStatus("PENDING", 10000, PENDING_EXPIRY_SECONDS, true, limit).status, "PENDING");
  assert.equal(resolveKatanaStatus("PENDING", 10000, limit - 1, true, limit).status, "PENDING");
  assert.equal(resolveKatanaStatus("PENDING", 10000, limit, true, limit).status, "EXPIRED");
  assert.equal(inConfirmWindow("PENDING", PENDING_EXPIRY_SECONDS - 1, gw, true, env), false);
  assert.equal(inConfirmWindow("PENDING", PENDING_EXPIRY_SECONDS, gw, true, env), true);
  assert.equal(inConfirmWindow("PENDING", limit, gw, true, env), false);
  assert.equal(inConfirmWindow("SUCCESS", PENDING_EXPIRY_SECONDS + 5, gw, true, env), false);
  assert.equal(inConfirmWindow("PENDING", PENDING_EXPIRY_SECONDS + 5, gw, true, {}), false);   // no window set
  assert.equal(inConfirmWindow("PENDING", PENDING_EXPIRY_SECONDS + 5, {}, true, env), false);  // P2P
});

test("a status callback is sent once per status: an expired or failed order paid afterwards is still told Captured", () => {
  assert.ok(!payinCallbackSent(null, "EXPIRED"));
  assert.ok(!payinCallbackSent({ status: "Expired" }, "EXPIRED"));   // a recorded skip is not a send
  const expired = { sent_at: "2026-10-01T13:41:53.377Z", status: "Expired" };
  assert.ok(payinCallbackSent(expired, "EXPIRED"));
  assert.ok(!payinCallbackSent(expired, "SUCCESS"));
  const captured = { sent_at: "2026-10-01T14:34:39.000Z", status: "Captured" };
  assert.ok(payinCallbackSent(captured, "SUCCESS"));
  assert.ok(payinCallbackSent(captured, "SUCCEEDED"));
  assert.ok(payinCallbackSent(captured, "EXPIRED"));   // Captured is final: nothing follows it
  assert.ok(payinCallbackSent(captured, "FAILED"));
  const failed = { sent_at: "2026-10-01T14:34:39.000Z", status: "Failed" };
  assert.ok(payinCallbackSent(failed, "FAILED"));
  assert.ok(!payinCallbackSent(failed, "SUCCESS"));     // a failed attempt, then a payment that went through
  assert.ok(payinCallbackSent({ sent_at: "2026-10-01T14:34:39.000Z" }, "SUCCESS"));   // a stamp with no status blocks any repeat
});

test("the callback hash is SHA256 over the sorted KEY=value pairs joined by ~, plus the salt, uppercased", () => {
  const body = { ORDER_ID: "ORDER-1", STATUS: "Captured", AMOUNT: "100", RESPONSE_CODE: "000", EMPTY: null, HASH: "ignored" };
  assert.equal(buildKatanaSignString(body), "AMOUNT=100~EMPTY=~ORDER_ID=ORDER-1~RESPONSE_CODE=000~STATUS=Captured");
  const want = createHash("sha256").update("AMOUNT=100~EMPTY=~ORDER_ID=ORDER-1~RESPONSE_CODE=000~STATUS=Captured" + "salt").digest("hex").toUpperCase();
  assert.equal(signKatanaHash(body, "salt"), want);
  assert.ok(verifyKatanaHash(body, "salt", want.toLowerCase()));
  assert.ok(!verifyKatanaHash(body, "other-salt", want));
  assert.ok(!verifyKatanaHash({ ...body, AMOUNT: "101" }, "salt", want));
});

test("a staff refresh says what the gateway answered when nothing changed", () => {
  assert.match(gatewayCheckNote({ status: "UNKNOWN", reason: "still pending" }), /payment is PENDING/);
  assert.match(gatewayCheckNote({ status: "UNKNOWN", reason: "lookup_failed", lookupError: "lookup failed: HTTP 500" }), /no usable answer: lookup failed: HTTP 500/);
  assert.match(gatewayCheckNote({ status: "UNKNOWN", reason: "not_found_at_gateway" }), /no order under this reference/);
  assert.match(gatewayCheckNote({ status: "UNKNOWN", reason: "no_gateway_credentials" }), /could not be asked/);
  // Paid at the gateway but refused by the confirmation (lib/katana-order): the refusal is shown.
  assert.match(gatewayCheckNote({ status: "SUCCESS", reason: "duplicate UTR — already used by order ORD-9" }), /went through, but it was not applied: duplicate UTR — already used by order ORD-9/);
  assert.match(gatewayCheckNote({ status: "UNKNOWN", reason: "amount mismatch: 200000, order 2000" }), /not applied: amount mismatch/);
  // A failure never moves an expired order.
  assert.match(gatewayCheckNote({ status: "FAILED", reason: "order already EXPIRED" }), /payment failed; the order was left as it is \(order already EXPIRED\)/);
  assert.match(gatewayCheckNote({ status: "UNKNOWN" }), /no final answer/);
});
