// The pay-in limit rules (lib/payin-limits): which limit refuses an order, and where it comes from.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPayinLimits, effectivePayinLimits, platformPayinLimits, validatePayinLimits, payinLimitBody,
  accountMinimumBreach, gatewayMinimumFrom,
  NO_LIMITS, type PayinLimits, type PayinUsage,
} from "@/lib/payin-limits";

const PLATFORM = platformPayinLimits({});
const IDLE: PayinUsage = { dayAmount: 0, lastSecond: 0 };
const own = (l: Partial<PayinLimits>): PayinLimits => ({ ...NO_LIMITS, ...l });
const check = (amount: number, l: Partial<PayinLimits> = {}, o: { usage?: PayinUsage; upi?: boolean; livemode?: boolean } = {}) =>
  checkPayinLimits({
    amount, livemode: o.livemode ?? true, upi: o.upi ?? true,
    limits: effectivePayinLimits(own(l), PLATFORM), usage: o.usage ?? IDLE,
  });

test("the platform defaults are the UPI floor and ceiling, with no daily or rate limit", () => {
  assert.deepEqual(PLATFORM, { min: 1, max: null, upiMax: 100000, daily: null, maxTps: null });
});

test("a default is changed by its environment value and switched off by 0", () => {
  const p = platformPayinLimits({ PAYIN_MIN_AMOUNT: "10", PAYIN_UPI_MAX_AMOUNT: "0", PAYIN_DEFAULT_DAILY_AMOUNT: "500000", PAYIN_DEFAULT_MAX_TPS: "25" });
  assert.deepEqual(p, { min: 10, max: null, upiMax: null, daily: 500000, maxTps: 25 });
  assert.equal(platformPayinLimits({ PAYIN_MIN_AMOUNT: "abc" }).min, null);
});

test("an ordinary order passes", () => {
  assert.equal(check(101), null);
  assert.equal(check(1), null);
  assert.equal(check(100000), null);
});

test("an order under the minimum is refused with the limit and the amount", () => {
  const b = check(0.5);
  assert.deepEqual([b?.code, b?.status, b?.field, b?.limit, b?.actual], ["AMOUNT_BELOW_MIN", 422, "amount", 1, 0.5]);
  assert.equal(check(49.99, { min: 50 })?.code, "AMOUNT_BELOW_MIN");
  assert.equal(check(50, { min: 50 }), null);
});

test("a UPI order over ₹1,00,000 is refused; the same amount on a hosted page is not", () => {
  assert.equal(check(100000.01)?.code, "UPI_LIMIT_EXCEEDED");
  assert.equal(check(250000, {}, { upi: false }), null);
});

test("a banker's own maximum replaces the UPI ceiling, in both directions", () => {
  assert.equal(check(150000, { max: 200000 }), null);
  assert.equal(check(200000.01, { max: 200000 })?.code, "AMOUNT_ABOVE_MAX");
  assert.equal(check(6000, { max: 5000 })?.code, "AMOUNT_ABOVE_MAX");
  assert.equal(check(6000, { max: 5000 }, { upi: false })?.code, "AMOUNT_ABOVE_MAX");
});

test("the daily limit counts what is already taken today, to the paisa", () => {
  assert.equal(check(100, { daily: 1000 }, { usage: { dayAmount: 900, lastSecond: 0 } }), null);
  const b = check(100.01, { daily: 1000 }, { usage: { dayAmount: 900, lastSecond: 0 } });
  assert.deepEqual([b?.code, b?.limit, b?.actual], ["DAILY_LIMIT_EXCEEDED", 1000, 1000.01]);
  // 0.1 + 0.2 is not 0.3 in floating point; the limit must still be met exactly.
  assert.equal(check(0.2, { min: 0.1, daily: 0.3 }, { usage: { dayAmount: 0.1, lastSecond: 0 } }), null);
});

test("the rate limit refuses the order after the last one allowed in a second", () => {
  assert.equal(check(101, { maxTps: 5 }, { usage: { dayAmount: 0, lastSecond: 4 } }), null);
  const b = check(101, { maxTps: 5 }, { usage: { dayAmount: 0, lastSecond: 5 } });
  assert.deepEqual([b?.code, b?.status, b?.limit], ["RATE_LIMITED", 429, 5]);
});

test("a test order is only rate limited: it moves no money", () => {
  assert.equal(check(0.5, { max: 10, daily: 1 }, { livemode: false }), null);
  assert.equal(check(500000, {}, { livemode: false }), null);
  assert.equal(check(101, { maxTps: 1 }, { livemode: false, usage: { dayAmount: 0, lastSecond: 1 } })?.code, "RATE_LIMITED");
});

test("the refusal body carries the code, field, limit and amount and names no gateway", () => {
  const body = payinLimitBody(check(100000.01)!);
  assert.deepEqual(Object.keys(body).sort(), ["actual", "code", "error", "field", "limit"]);
  assert.equal(/payu|razorpay|cashfree|paytm|phonepe|ccavenue|rubyvault|ismartpay/i.test(JSON.stringify(body)), false);
});

test("limits that contradict each other cannot be saved", () => {
  assert.equal(validatePayinLimits(NO_LIMITS), null);
  assert.equal(validatePayinLimits(own({ min: 10, max: 5000, daily: 100000, maxTps: 10 })), null);
  assert.match(validatePayinLimits(own({ min: 100, max: 50 }))!, /minimum is above maximum/);
  assert.match(validatePayinLimits(own({ max: 5000, daily: 1000 }))!, /above the daily limit/);
  assert.match(validatePayinLimits(own({ min: 0 }))!, /above zero/);
  assert.match(validatePayinLimits(own({ maxTps: 1.5 }))!, /whole number/);
});

// The payment account's own minimum (2026-10-06: ₹200 and ₹500 orders on a ₹1,000-minimum account).

test("an order under the payment account's minimum is AMOUNT_BELOW_MIN, naming no gateway", () => {
  const b = accountMinimumBreach(500, 1000);
  assert.deepEqual([b?.code, b?.status, b?.field, b?.limit, b?.actual], ["AMOUNT_BELOW_MIN", 422, "amount", 1000, 500]);
  assert.equal(b?.message, "this payment account takes ₹1,000 or more per payment");
  assert.equal(accountMinimumBreach(1000, 1000), null);
  assert.equal(accountMinimumBreach(999.99, 1000)?.code, "AMOUNT_BELOW_MIN");
  assert.equal(accountMinimumBreach(5, null), null);
  assert.equal(accountMinimumBreach(5, undefined), null);
});

test("the minimum a gateway's refusal names", () => {
  assert.equal(gatewayMinimumFrom("RubyVault did not start the checkout: Minimum amount should be 1000"), 1000);
  assert.equal(gatewayMinimumFrom("Minimum checkout amount should be 500"), 500);
  assert.equal(gatewayMinimumFrom("PayAtom refused: amount should be greater than : 200"), 201);
  assert.equal(gatewayMinimumFrom("Invalid hash"), null);
  assert.equal(gatewayMinimumFrom("No valid channel found"), null);
});
