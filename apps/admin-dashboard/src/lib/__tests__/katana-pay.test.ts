// Katana Pay order core (lib/katana-pay): status rules, test-order outcomes and the callback hash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildKatanaSignString, decideKatanaStatus, resolveKatanaStatus, signKatanaHash, verifyKatanaHash, payinCallbackSent, PENDING_EXPIRY_SECONDS,
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
