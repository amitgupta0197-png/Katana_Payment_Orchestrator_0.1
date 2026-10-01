// The pay-in flow rules (lib/payin-flow): which flow a new order takes for each merchant setting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedFlows, decideOrderFlow, isOnFlow, merchantFlowOf, validateMerchantFlow, type MerchantFlow } from "@/lib/payin-flow";

const UNSET: MerchantFlow = { flow: "UNSET", active: null };
const P2P: MerchantFlow = { flow: "P2P", active: null };
const INTENT: MerchantFlow = { flow: "INTENT", active: null };
const both = (active: "P2P" | "INTENT"): MerchantFlow => ({ flow: "BOTH", active });

test("a merchant with no flow selected keeps the inferred routing on the general API", () => {
  assert.deepEqual(decideOrderFlow(UNSET), { ok: true, flow: null });
});

test("a flow's own API is refused until a flow is selected", () => {
  const d = decideOrderFlow(UNSET, "P2P");
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.code, "FLOW_NOT_SELECTED");
});

test("a single-flow merchant always takes its flow and is refused the other one", () => {
  assert.deepEqual(decideOrderFlow(P2P), { ok: true, flow: "P2P" });
  assert.deepEqual(decideOrderFlow(P2P, "P2P"), { ok: true, flow: "P2P" });
  assert.deepEqual(decideOrderFlow(INTENT), { ok: true, flow: "INTENT" });
  const d = decideOrderFlow(P2P, "INTENT");
  assert.equal(!d.ok && d.code, "FLOW_NOT_ENABLED");
  const e = decideOrderFlow(INTENT, "P2P");
  assert.equal(!e.ok && e.code, "FLOW_NOT_ENABLED");
});

test("a BOTH merchant takes the flow in use, or the one asked for by name", () => {
  assert.deepEqual(decideOrderFlow(both("INTENT")), { ok: true, flow: "INTENT" });
  assert.deepEqual(decideOrderFlow(both("INTENT"), "P2P"), { ok: true, flow: "P2P" });
  assert.deepEqual(decideOrderFlow(both("P2P"), "INTENT"), { ok: true, flow: "INTENT" });
});

test("BOTH must name its flow in use; a single flow must not", () => {
  assert.ok(validateMerchantFlow("BOTH", null));
  assert.equal(validateMerchantFlow("BOTH", "P2P"), null);
  assert.ok(validateMerchantFlow("P2P", "INTENT"));
  assert.equal(validateMerchantFlow("INTENT", null), null);
});

test("stored values are read back safely", () => {
  assert.deepEqual(merchantFlowOf("both", "intent"), both("INTENT"));
  assert.deepEqual(merchantFlowOf("BOTH", null), UNSET);          // BOTH with no selection is unset
  assert.deepEqual(merchantFlowOf("P2P", "INTENT"), P2P);         // a stray selection is dropped
  assert.deepEqual(merchantFlowOf("nonsense", null), UNSET);
});

test("BOTH is listed under each flow; UNSET under none", () => {
  assert.deepEqual(allowedFlows(both("P2P")), ["P2P", "INTENT"]);
  assert.ok(isOnFlow(both("P2P"), "INTENT"));
  assert.ok(!isOnFlow(P2P, "INTENT"));
  assert.deepEqual(allowedFlows(UNSET), []);
});
