// "Unmatched payments" rules (lib/unmatched): who may do what, masking, plain-words states, and
// which orders a payment is offered (lib/credit-link possibleOrders).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionRefusal, isLinkRole, maskVpa, reviewLabel, type Review } from "@/lib/unmatched";
import { possibleOrders } from "@/lib/credit-link";

const rv = (over: Partial<Review>): Review => ({ decision: "LINK", status: "PENDING", order_id: "o1", order_ref: "ORD-1", requested_by: "b@x", requested_as: "MERCHANT", note: null, ...over });

test("a banker can ask for a link or mark 'not an order', but not approve", () => {
  assert.equal(actionRefusal("link", false, null), null);
  assert.equal(actionRefusal("not_order", false, null), null);
  assert.match(actionRefusal("approve", false, rv({}))!, /Only Katana staff/);
  assert.match(actionRefusal("undo", false, rv({ decision: "NOT_ORDER", status: "DONE" }))!, /Only Katana staff/);
});

test("one link per payment: a waiting request blocks another; a done link blocks everything", () => {
  assert.match(actionRefusal("link", false, rv({}))!, /already waiting/);
  assert.match(actionRefusal("link", true, rv({ status: "DONE" }))!, /already linked/);
  assert.match(actionRefusal("not_order", true, rv({ status: "DONE" }))!, /already linked/);
  assert.equal(actionRefusal("approve", true, rv({})), null);
  assert.equal(actionRefusal("reject", true, rv({})), null);
  assert.match(actionRefusal("approve", true, null)!, /nothing|no link/i);
  assert.equal(actionRefusal("link", false, rv({ status: "REJECTED" })), null, "a refused link can be asked again");
});

test("'not an order' must be undone (by staff) before it can be linked", () => {
  const marked = rv({ decision: "NOT_ORDER", status: "DONE", order_id: null, order_ref: null });
  assert.match(actionRefusal("link", true, marked)!, /Undo that first/);
  assert.equal(actionRefusal("undo", true, marked), null);
});

test("payer UPI IDs are masked; states are plain words", () => {
  assert.equal(maskVpa("ankit.kumar@okaxis"), "an***@okaxis");
  assert.equal(maskVpa("a@ybl"), "a***@ybl");
  assert.equal(maskVpa(""), null);
  assert.equal(reviewLabel(null), "Needs an order");
  assert.equal(reviewLabel(rv({})), "Waiting for Katana: link to ORD-1");
  assert.equal(reviewLabel(rv({ status: "DONE" })), "Linked to ORD-1");
  assert.equal(reviewLabel(rv({ decision: "NOT_ORDER", status: "DONE" })), "Not an order payment");
  assert.ok(isLinkRole("FINANCE") && !isLinkRole("MERCHANT") && !isLinkRole("SUPPORT"));
});

test("a ₹1 payment is offered every open ₹1 order of the 30 minutes before it, newest first", () => {
  const at = "2026-10-03T11:32:00Z";
  const orders = [
    { id: "a", order_id: "ORD_771519_LLND-TEST", amount: 1, created_at: "2026-10-03T11:22:00Z", status: "EXPIRED" },
    { id: "b", order_id: "ORD_771519_LLND-TEST2", amount: 1, created_at: "2026-10-03T11:31:00Z", status: "PENDING" },
    { id: "c", order_id: "OLD", amount: 1, created_at: "2026-10-03T10:00:00Z", status: "EXPIRED" },
    { id: "d", order_id: "TWO", amount: 2, created_at: "2026-10-03T11:30:00Z", status: "PENDING" },
  ];
  assert.deepEqual(possibleOrders({ amount: 1, received_at: at }, orders).map((o) => o.id), ["b", "a"]);
});
