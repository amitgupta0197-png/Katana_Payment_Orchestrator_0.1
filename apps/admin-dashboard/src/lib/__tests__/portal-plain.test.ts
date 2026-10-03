// The portals' plain words, payment stories and Home actions (lib/plain-words, lib/payment-story,
// lib/portal-home-rules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { plainPaymentStatus, plainPayoutStatus, rupees, istTime, PLAIN_TERMS } from "@/lib/plain-words";
import { classifyQuery, orderStory, creditStory, type StoryOrder } from "@/lib/payment-story";
import {
  stepAction, requestLiveAction, askAction, lateMoneyItem, webhookItem, payoutItem, apiErrorItem, sortAttention, blockedItem,
} from "@/lib/portal-home-rules";

const NOW = new Date("2026-10-03T06:00:00Z"); // 11:30 AM IST

test("every payment status a portal can show is one of five plain words", () => {
  const words = (xs: string[]) => [...new Set(xs.map((x) => plainPaymentStatus(x).word))];
  assert.deepEqual(words(["SUCCESS", "SUCCEEDED", "Captured", "PAID", "COMPLETED"]), ["Paid"]);
  assert.deepEqual(words(["PENDING", "CREATED", "INITIATED", "", "PROCESSING"]), ["Waiting"]);
  assert.deepEqual(words(["FAILED", "DECLINED", "REJECTED"]), ["Failed"]);
  assert.deepEqual(words(["EXPIRED", "TIMEOUT"]), ["Expired"]);
  assert.deepEqual(words(["REFUNDED", "REVERSED"]), ["Refunded"]);
  assert.equal(plainPayoutStatus("COMPLETED").word, "Sent");
  assert.equal(plainPayoutStatus("HOLD").word, "On hold");
  assert.equal(plainPayoutStatus("QUEUED").word, "On its way");
  assert.equal(plainPayoutStatus("REVERSED").word, "Returned");
  for (const v of Object.values(PLAIN_TERMS)) assert.doesNotMatch(v, /\b(VPA|RRN)\b(?! \()/, v);
});

test("money and times read the way people in India read them", () => {
  assert.equal(rupees(123456), "Rs 1,23,456");
  assert.equal(rupees(499.5), "Rs 499.50");
  assert.equal(rupees("25.00"), "Rs 25");
  assert.equal(istTime("2026-10-03T05:30:00Z", NOW), "11:00 AM");
  assert.equal(istTime("2026-10-01T05:30:00Z", NOW), "1 Oct, 11:00 AM");
  assert.equal(istTime(null, NOW), "");
});

test("what was pasted into search is worked out", () => {
  assert.deepEqual(classifyQuery("512345678901").kinds, ["utr", "reference"]);
  assert.deepEqual(classifyQuery("+91 98765 43210"), { kinds: ["phone", "reference"], value: "9876543210", amount: null });
  assert.deepEqual(classifyQuery("Rs 1,499.50"), { kinds: ["amount"], value: "Rs 1,499.50", amount: 1499.5 });
  assert.deepEqual(classifyQuery("499").kinds, ["amount", "reference"], "a short number may be an amount or a txnid");
  assert.deepEqual(classifyQuery("GL-1007").kinds, ["reference"]);
  assert.deepEqual(classifyQuery("KTN_433b9cfcfab2448796d7415c7663484b").kinds, ["reference"]);
});

const order = (o: Partial<StoryOrder> = {}): StoryOrder => ({
  txnid: "GL-1007", amount: 499, status: "EXPIRED", created_at: "2026-10-02T23:31:00Z", expires_at: "2026-10-02T23:46:00Z", livemode: true, ...o,
});

test("an order that expired, with the money arriving late, is told in order", () => {
  const story = orderStory(order(), [{ at: "2026-10-02T23:46:00Z", from: "PENDING", to: "EXPIRED" }],
    [{ amount: 499, utr: "512345678901", paid_at: "2026-10-02T23:49:00Z", linked: false }], [], NOW);
  assert.deepEqual(story, [
    "Order GL-1007 for Rs 499 was made at 5:01 AM.",
    "It expired at 5:16 AM because no payment came in time.",
    "Rs 499 arrived at 5:19 AM (UTR 512345678901), after the order expired, and was not linked to this order.",
    "Send the UTR to Katana support so they can check it.",
    "No message was sent to your server for this order.",
  ]);
});

test("a paid order says when, the bank reference, and whether the server was told", () => {
  const story = orderStory(order({ status: "SUCCESS", paid_at: "2026-10-03T05:00:00Z", rrn: "302541783125" }), [], [],
    [{ status: "DELIVERED", attempts: [{ at: "2026-10-03T05:00:05Z", http_status: 200, error: null }] }], NOW);
  assert.equal(story[1], "It was paid at 10:30 AM.");
  assert.equal(story[2], "Bank reference (UTR): 302541783125.");
  assert.equal(story[3], "We told your server at 10:30 AM (it answered 200).");
  const made = orderStory(order({ status: "SUCCESS", rrn: "302541783125", rrn_is_synthetic: true }), [], [], [], NOW);
  assert.ok(!made.some((s) => s.includes("UTR")), "a reference Katana made up is not shown as the bank's");
});

test("paid after it expired, a test order, and a server we could not reach", () => {
  const late = orderStory(order({ status: "SUCCESS", paid_at: "2026-10-03T00:00:00Z" }),
    [{ at: "2026-10-02T23:46:00Z", from: "PENDING", to: "EXPIRED" }, { at: "2026-10-03T00:00:00Z", from: "EXPIRED", to: "SUCCESS" }], [], [], NOW);
  assert.match(late[1], /^It expired at .*, then the money came in late and it was marked paid at /);
  assert.match(orderStory(order({ livemode: false }), [], [], [], NOW)[0], /^Test order GL-1007/);
  assert.ok(!orderStory(order({ livemode: false }), [], [], [], NOW).some((s) => s.includes("not seen this money")), "test money never arrives anyway");
  const down = orderStory(order({ status: "FAILED" }), [], [],
    [{ status: "PENDING", next_attempt_at: "2026-10-03T06:15:00Z", attempts: [{ at: "2026-10-03T06:00:00Z", http_status: 500, error: null }] }], NOW);
  assert.equal(down[down.length - 1], "We have not been able to tell your server yet (it answered 500). We will try again at 11:45 AM.");
  const stale = orderStory(order({ status: "FAILED" }), [], [],
    [{ status: "PENDING", next_attempt_at: "2026-10-03T05:00:00Z", attempts: [{ at: "2026-10-03T04:59:00Z", http_status: null, error: "ECONNREFUSED" }] }], NOW);
  assert.equal(stale[stale.length - 1], "We have not been able to tell your server yet (it did not answer).", "no retry time that has already passed");
  assert.equal(orderStory(order({ status: "PENDING", expires_at: "2026-10-03T06:10:00Z" }), [], [], [], NOW).length, 2, "a waiting order says only that");
});

test("money that no order explains", () => {
  assert.deepEqual(creditStory({ amount: 250, utr: "111122223333", paid_at: "2026-10-03T05:00:00Z", linked: false }, NOW), [
    "Rs 250 arrived at 10:30 AM (UTR 111122223333).",
    "It is not linked to any order. If a customer paid for an order with it, send the UTR to Katana support.",
  ]);
  assert.equal(creditStory({ amount: 250, utr: null, paid_at: "2026-10-03T05:00:00Z", linked: true, order_txnid: "T-9" }, NOW)[1], "It was linked to order T-9.");
});

test("each go-live step leads to where it is done, in the portal the person is in", () => {
  assert.deepEqual(stepAction("webhook_url", "/banker-portal", null).action?.href, "/banker-portal/webhooks");
  assert.deepEqual(stepAction("test_payment", "/merchant-portal", "b1").action?.href, "/merchant-portal/integration");
  assert.deepEqual(stepAction("settlement_vpa", "/banker-portal", null), { action: null, katana: true });
  assert.equal(stepAction("onboarding", "/merchant-portal", "b1").action?.href, "/merchant-portal/kyc");
  assert.equal(requestLiveAction("/merchant-portal", "b1").href, "/merchant-portal/bankers/b1");
  assert.equal(requestLiveAction("/banker-portal", "b1").href, "/banker-portal/integration");
});

test("attention items: what they say, where they lead, most urgent first", () => {
  const late = lateMoneyItem({ amount: 499, utr: "512345678901", paid_at: "2026-10-02T23:49:00Z", order_txnid: "GL-1007", order_status: "EXPIRED" }, "/banker-portal", NOW);
  assert.equal(late.title, "Rs 499 came in after order GL-1007 expired");
  assert.equal(late.action?.href, "/banker-portal/find?q=512345678901");
  assert.equal(webhookItem(0, 0, "/banker-portal"), null);
  assert.equal(webhookItem(1, 2, "/banker-portal")?.title, "3 payment messages did not reach your server");
  assert.equal(webhookItem(0, 1, "/banker-portal")?.level, "warn");
  assert.equal(payoutItem({ held: 0, failed: 0, returned: 0 }, "/banker-portal", true), null);
  const held = payoutItem({ held: 1, failed: 0, returned: 0 }, "/merchant-portal", true)!;
  assert.equal(held.level, "warn");
  assert.match(held.action!.href, /^\/merchant-portal\/assistant\?ask=/);
  assert.equal(payoutItem({ held: 0, failed: 2, returned: 0 }, "/merchant-portal", false)!.action!.href, "/merchant-portal/tickets", "no assistant: support");
  assert.equal(askAction("/banker-portal", false, "x").href, "/banker-portal/help");
  assert.equal(apiErrorItem(2, "SIGNATURE", "/banker-portal"), null, "a couple of errors is not worth a person's attention");
  assert.match(apiErrorItem(5, "FLOW_NOT_ENABLED", "/banker-portal")!.detail, /FLOW_NOT_ENABLED/);
  const sorted = sortAttention([webhookItem(0, 1, "/banker-portal")!, blockedItem("/banker-portal"), late]);
  assert.deepEqual(sorted.map((x) => x.level), ["urgent", "urgent", "warn"]);
});
