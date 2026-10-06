// "Before you save" (lib/change-impact): what a risky change would do, from recent orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountImpact, blockImpact, exclusiveImpact, flowImpact, type BankerOrderCounts } from "@/lib/change-impact";

const c = (over: Partial<BankerOrderCounts> = {}): BankerOrderCounts =>
  ({ code: "BAVTDV01", total: 0, intent: 0, p2p: 0, own: 0, open: 0, lastAt: null, ...over });

test("exclusive partner: warns only when a banker took its own orders (the BUDY-PAY case)", () => {
  const quiet = exclusiveImpact("BUDY-PAY", [c({ total: 3, own: 0 })], 7);
  assert.equal(quiet.none, true);
  const hit = exclusiveImpact("BUDY-PAY", [c({ total: 2, p2p: 2, own: 2, lastAt: "2026-10-03T13:24:00Z" })], 7);
  assert.equal(hit.none, false);
  assert.equal(hit.title, "This will stop BAVTDV01's own orders");
  assert.match(hit.body.join(" "), /partner API only/);
  assert.deepEqual(hit.rows[0], { label: "BAVTDV01 · its own live key", value: "2 orders in 7 days" });
  assert.equal(hit.keepLabel, "Keep its own orders working");
  assert.equal(hit.proceedLabel, "Partner orders only");
});

test("flow: moving off a used flow, or onto one that isn't set up, is warned; a ready, unused change isn't", () => {
  assert.equal(flowImpact("PAYATOM", "INTENT", c(), true, 7).none, true);
  const notReady = flowImpact("PAYATOM", "INTENT", c(), false, 7);
  assert.equal(notReady.none, false);
  assert.match(notReady.title, /won't be able to take live orders/);
  assert.match(notReady.body.join(" "), /no live payment account/);
  const moving = flowImpact("BAVTDV01", "INTENT", c({ total: 4, p2p: 4 }), true, 7);
  assert.equal(moving.none, false);
  assert.match(moving.body[0], /4 P2P orders/);
});

test("replacing the payment account mentions open orders and the new verification", () => {
  const r = accountImpact("BBUY88", "PayU", "RubyVault", c({ total: 3, intent: 3, open: 1 }), 7);
  assert.equal(r.none, false);
  assert.match(r.body.join(" "), /1 order still open/);
  assert.match(r.body.join(" "), /verification/);
  assert.equal(accountImpact("NEW", null, "RubyVault", c(), 7).none, true);
});

test("blocking always asks, and says open orders can still be paid", () => {
  const r = blockImpact("CVSBOR", c({ total: 19, open: 2 }), 7);
  assert.equal(r.none, false);
  assert.match(r.body.join(" "), /19 live orders/);
  assert.match(r.body.join(" "), /2 orders already open can still be paid/);
});
