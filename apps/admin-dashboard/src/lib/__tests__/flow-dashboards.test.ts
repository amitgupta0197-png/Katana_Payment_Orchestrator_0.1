// Flow dashboards (lib/flow-dashboards): the pure rules behind /flows/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countBuckets, expiryBuckets, hourlySeries, istHour, lowSuccessMerchants, median, parseBanker, parseMode,
  payinFailureBucket, payoutFailureBucket, payoutMode, rateTone, rollUpToMerchants, successRate, tileReason, tileTone, toCsv,
} from "@/lib/flow-dashboards";

test("success rate is paid over ended, null when nothing ended", () => {
  assert.equal(successRate(0, 0), null);
  assert.equal(successRate(17, 20), 0.85);
  assert.equal(successRate(1, 3), 0.3333);
});

test("rate tone: green at 85% and over, amber from 60%, red under", () => {
  assert.equal(rateTone(0.85), "good");
  assert.equal(rateTone(0.8499), "warn");
  assert.equal(rateTone(0.6), "warn");
  assert.equal(rateTone(0.5999), "bad");
  assert.equal(rateTone(null), "none");
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("pay-in failure buckets", () => {
  assert.equal(payinFailureBucket("EXPIRED", null), "EXPIRED_UNPAID");
  assert.equal(payinFailureBucket("FAILED", "U30"), "FAILED_AT_GATEWAY");
  assert.equal(payinFailureBucket("FAILED", "order create failed at processor"), "CREATE_FAILED");
  assert.equal(payinFailureBucket("CANCELLED", null), "OTHER");
});

test("payout failure buckets", () => {
  assert.equal(payoutFailureBucket("FAILED", "Insufficient balance in account"), "INSUFFICIENT_FUNDS");
  assert.equal(payoutFailureBucket("FAILED", "Invalid IFSC"), "BENEFICIARY");
  assert.equal(payoutFailureBucket("REJECTED", null), "REJECTED");
  assert.equal(payoutFailureBucket("FAILED", "gateway timeout"), "PROCESSOR");
  assert.equal(payoutFailureBucket("REVERSED", null), "RETURNED");
  assert.equal(payoutFailureBucket("FAILED", "something odd"), "OTHER");
});

test("countBuckets keeps every bucket, zero included, in order, with weights", () => {
  assert.deepEqual(countBuckets(["B", "A", "B"], ["A", "B", "C"] as const, [1, 2, 3]),
    [{ key: "A", n: 2 }, { key: "B", n: 4 }, { key: "C", n: 0 }]);
});

test("payout mode from the first rail that says", () => {
  assert.equal(payoutMode(null, "FT_IMPS", "BANK"), "IMPS");
  assert.equal(payoutMode("NEFT", "FT_IMPS"), "NEFT");
  assert.equal(payoutMode(null, "UPI_PAY", "UPI"), "UPI");
  assert.equal(payoutMode(null, null, "BANK"), "OTHER");
});

test("hourly series: 24 IST hours ending with the current one, gaps filled", () => {
  const now = new Date("2026-10-05T10:10:00Z"); // 15:40 IST
  assert.equal(istHour(now), 15);
  const thisHour = "2026-10-05T09:30:00.000Z"; // 15:00 IST
  const s = hourlySeries([{ hour: thisHour, orders: 10, paid: 8, ended: 9 }, { hour: "2026-10-05T07:30:00Z", orders: 2, paid: 0, ended: 2 }], now);
  assert.equal(s.length, 24);
  assert.equal(s[23].label, "15:00");
  assert.equal(s[23].hour, thisHour);
  assert.equal(s[23].rate, 0.8889);
  assert.equal(s[21].label, "13:00");
  assert.equal(s[21].rate, 0);
  assert.equal(s[0].label, "16:00");
  assert.equal(s[0].orders, 0);
  assert.equal(s[0].rate, null);
});

test("pending orders by time left", () => {
  assert.deepEqual(expiryBuckets([-5, 0, 100, 3600, 3601, 14_400, 20_000, 90_000]),
    { overdue: 2, within_1h: 2, within_4h: 2, within_24h: 1, later: 1 });
});

test("merchants under 80% in the last hour need 5 orders", () => {
  const merchantOf = new Map([["B1", { id: "p1", name: "Acme" }], ["B2", { id: "p1", name: "Acme" }], ["B3", { id: "p2", name: "Globex" }]]);
  const m = rollUpToMerchants([
    { code: "B1", orders: 3, paid: 2, ended: 3 }, { code: "B2", orders: 3, paid: 2, ended: 3 },
    { code: "B3", orders: 4, paid: 0, ended: 4 }, { code: "B9", orders: 50, paid: 0, ended: 50 },
  ], merchantOf);
  assert.equal(m.length, 2);
  const low = lowSuccessMerchants(m);
  assert.deepEqual(low.map((x) => [x.provider_id, x.rate]), [["p1", 0.6667]]); // Globex has only 4 orders
  assert.equal(lowSuccessMerchants([{ provider_id: "x", provider_name: "x", orders: 10, paid: 8, ended: 10 }]).length, 0); // 80% is not under
});

test("tile tone: red over 10% failed with 10+ orders, or a queue over 500", () => {
  assert.equal(tileTone({ orders_1h: 10, ended_1h: 10, failed_1h: 2, orders_24h: 50 }), "bad");
  assert.equal(tileTone({ orders_1h: 9, ended_1h: 9, failed_1h: 5, orders_24h: 50 }), "warn"); // too few to call red
  assert.equal(tileTone({ orders_1h: 20, ended_1h: 20, failed_1h: 2, orders_24h: 50 }), "good"); // exactly 10% is not over
  assert.equal(tileTone({ orders_1h: 0, ended_1h: 0, failed_1h: 0, orders_24h: 0, queue: 501 }), "bad");
  assert.equal(tileTone({ orders_1h: 0, ended_1h: 0, failed_1h: 0, orders_24h: 0, queue: 300 }), "warn");
  assert.equal(tileTone({ orders_1h: 0, ended_1h: 0, failed_1h: 0, orders_24h: 0 }), "none");
  assert.match(tileReason({ orders_1h: 10, ended_1h: 10, failed_1h: 2, orders_24h: 50 })!, /20% failed/);
  assert.match(tileReason({ orders_1h: 0, ended_1h: 0, failed_1h: 0, orders_24h: 0, queue: 600 })!, /600 payouts waiting/);
  assert.equal(tileReason({ orders_1h: 20, ended_1h: 20, failed_1h: 2, orders_24h: 50 }), null);
});

test("request parsing", () => {
  assert.equal(parseBanker(" BCB-MER-0001 "), "BCB-MER-0001");
  assert.equal(parseBanker("x' OR 1=1"), null);
  assert.equal(parseBanker(null), null);
  assert.equal(parseMode("test", true), false);
  assert.equal(parseMode("live", false), true);
  assert.equal(parseMode("bogus", false), false);
  assert.equal(parseMode(null, true), true);
});

test("CSV quotes, escapes and defuses formulas", () => {
  assert.equal(toCsv(["a", "b"], [["x,y", 'say "hi"'], [null, -5], ["=SUM(A1)", "+91"]]),
    'a,b\r\n"x,y","say ""hi"""\r\n,-5\r\n\'=SUM(A1),\'+91\r\n');
});
