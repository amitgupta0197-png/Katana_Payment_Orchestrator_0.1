// Which open orders a captured payment could belong to (lib/credit-link), and its words (lib/plain-words).

import { test } from "node:test";
import assert from "node:assert/strict";
import { possibleOrders, LINK_WINDOW_MIN } from "@/lib/credit-link";
import { plainPaymentStatus } from "@/lib/plain-words";
import { verificationLabel } from "@/lib/credit-verification";

const at = (hhmm: string) => `2026-10-03T${hhmm}:00+05:30`;
const order = (order_id: string, hhmm: string, amount = 1) => ({ id: order_id.toLowerCase(), order_id, amount, created_at: at(hhmm), status: "PENDING" });

test("the two open ₹1 orders of 2026-10-03 are both offered for the 17:07 payment, newest first", () => {
  const orders = [order("TEST2", "17:01"), order("TEST-3", "17:06"), order("CC_163327", "16:33")];
  assert.deepEqual(possibleOrders({ amount: 1, received_at: at("17:07") }, orders).map((o) => o.order_id), ["TEST-3", "TEST2"]);
  // At 17:02 only TEST2 and the 16:33 order (29 minutes earlier) were open.
  assert.deepEqual(possibleOrders({ amount: 1, received_at: at("17:02") }, orders).map((o) => o.order_id), ["TEST2", "CC_163327"]);
});

test("another amount, an order from after the payment, or one older than the window is not offered", () => {
  assert.equal(LINK_WINDOW_MIN, 30);
  const orders = [order("OTHER", "17:05", 2), order("LATER", "17:20"), order("OLD", "16:30")];
  assert.deepEqual(possibleOrders({ amount: 1, received_at: at("17:07") }, orders), []);
  assert.deepEqual(possibleOrders({ amount: 1, received_at: "not a time" }, [order("X", "17:05")]), []);
});

test("money with no order is 'Received, no order', not Paid", () => {
  assert.equal(plainPaymentStatus("RECEIVED").word, "Received, no order");
  assert.equal(plainPaymentStatus("SUCCESS").word, "Paid");
  assert.equal(verificationLabel("verified"), "Confirmed by bank, no order");
  assert.equal(verificationLabel("matched"), "Linked to an order");
});
