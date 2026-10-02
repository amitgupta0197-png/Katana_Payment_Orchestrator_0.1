// The pay-in compliance rules (lib/payin-compliance): which transaction patterns raise a flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCompliance, type MerchantDayStats } from "@/lib/payin-compliance";

// An established banker on an ordinary day: nothing to flag.
const QUIET: MerchantDayStats = {
  merchantId: "M1", dayAmount: 20_000, dayCount: 12, roundCount: 3, highValueCount: 0, highValueAmount: 0,
  nearThresholdInHour: 0, priorAmount: 600_000, priorActiveDays: 25, ageDays: 200, lifetimeAmount: 5_000_000,
};
const rules = (s: Partial<MerchantDayStats>) => evaluateCompliance({ ...QUIET, ...s }).map((f) => f.rule);

test("an ordinary day raises nothing", () => {
  assert.deepEqual(rules({}), []);
});

test("three orders just under ₹50,000 within an hour is structuring; two is not", () => {
  assert.deepEqual(rules({ nearThresholdInHour: 2 }), []);
  const f = evaluateCompliance({ ...QUIET, nearThresholdInHour: 3 });
  assert.deepEqual([f[0].rule, f[0].severity, f[0].detail.from, f[0].detail.below], ["STRUCTURING", "CRITICAL", 45_000, 50_000]);
});

test("a day over three times the 30-day average is a spike, for a banker with history and a real amount", () => {
  // average = 600,000 / 30 = 20,000 a day
  assert.deepEqual(rules({ dayAmount: 60_000 }), []);                              // exactly three times: not over
  assert.deepEqual(rules({ dayAmount: 60_001 }), ["VOLUME_SPIKE"]);
  assert.deepEqual(rules({ dayAmount: 60_001, priorActiveDays: 6 }), []);          // too little history to call it a spike
  assert.deepEqual(rules({ dayAmount: 40_000, priorAmount: 30_000 }), []);         // over three times, but under the floor
});

test("a banker in its first week with over ₹5,00,000 is flagged, and not after the week", () => {
  assert.deepEqual(rules({ ageDays: 3, lifetimeAmount: 500_001, priorActiveDays: 2 }), ["NEW_MERCHANT_VOLUME"]);
  assert.deepEqual(rules({ ageDays: 3, lifetimeAmount: 500_000, priorActiveDays: 2 }), []);
  assert.deepEqual(rules({ ageDays: 8, lifetimeAmount: 900_000 }), []);
});

test("mostly round-thousand amounts are flagged once there are enough orders to say so", () => {
  assert.deepEqual(rules({ dayCount: 10, roundCount: 9 }), ["ROUND_AMOUNTS"]);
  assert.deepEqual(rules({ dayCount: 10, roundCount: 8 }), []);                    // exactly 80%: not over
  assert.deepEqual(rules({ dayCount: 9, roundCount: 9 }), []);                     // too few orders
});

test("a day over ₹10,00,000 is flagged for a cash-transaction-report review", () => {
  assert.deepEqual(rules({ dayAmount: 1_000_000, priorAmount: 30_000_000 }), []);
  assert.deepEqual(rules({ dayAmount: 1_000_001, priorAmount: 30_000_000 }), ["CTR_THRESHOLD"]);
});

test("high-value orders are recorded as information, not as an alert", () => {
  const f = evaluateCompliance({ ...QUIET, highValueCount: 2, highValueAmount: 130_000, dayAmount: 150_000, priorAmount: 3_000_000 });
  assert.deepEqual(f.map((x) => [x.rule, x.severity]), [["HIGH_VALUE", "INFO"]]);
  assert.deepEqual(f[0].detail, { orders: 2, amount: 130_000, threshold: 50_000 });
});

test("one day can raise several flags at once", () => {
  assert.deepEqual(rules({ nearThresholdInHour: 4, dayAmount: 1_200_000, dayCount: 30, roundCount: 28, highValueCount: 1, highValueAmount: 60_000 }),
    ["STRUCTURING", "VOLUME_SPIKE", "ROUND_AMOUNTS", "CTR_THRESHOLD", "HIGH_VALUE"]);
});
