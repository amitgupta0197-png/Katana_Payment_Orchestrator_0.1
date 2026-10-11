// One P2P method per banker (lib/p2p-method).
import { test } from "node:test";
import assert from "node:assert/strict";
import { asP2pMethod, inferP2pMethod, p2pProcessorAllowed, p2pReady, p2pSteps, switchSummary, type P2pFacts } from "@/lib/p2p-method";

const none: P2pFacts = { upiId: null, bharatpeMid: null, bharatpeAny: 0, payatomP2p: null, phones: { enrolled: 0, online: 0 } };

test("only the chosen method may use a P2P processor account; none chosen keeps the old routing", () => {
  assert.equal(p2pProcessorAllowed(null), true);
  assert.equal(p2pProcessorAllowed("PAYATOM"), true);
  assert.equal(p2pProcessorAllowed("UPI_ID"), false);
  assert.equal(p2pProcessorAllowed("BHARATPE"), false);
});

test("inferred method follows today's routing: processor, then BharatPe, then UPI ID", () => {
  assert.equal(inferP2pMethod(none), null);
  assert.equal(inferP2pMethod({ ...none, upiId: "a@b" }), "UPI_ID");
  assert.equal(inferP2pMethod({ ...none, upiId: "a@b", bharatpeMid: { label: "x", env: "TEST" } }), "BHARATPE");
  assert.equal(inferP2pMethod({ ...none, upiId: "a@b", payatomP2p: { env: "PROD" } }), "PAYATOM");
});

test("readiness is the chosen method's own; a phone is recommended, not required", () => {
  assert.equal(p2pReady("UPI_ID", { ...none, upiId: "a@b" }), true);
  assert.equal(p2pReady("BHARATPE", { ...none, upiId: "a@b" }), false);          // a plain UPI ID is not a BharatPe MID
  assert.equal(p2pReady("BHARATPE", { ...none, upiId: "a@b", bharatpeMid: { label: "x", env: "TEST" } }), true);
  assert.equal(p2pReady("PAYATOM", { ...none, upiId: "a@b" }), false);           // PayAtom never falls back to the UPI ID
  assert.equal(p2pReady("PAYATOM", { ...none, payatomP2p: { env: "PROD" } }), true);
  assert.equal(p2pReady(null, { ...none, upiId: "a@b" }), true);
  assert.equal(p2pReady(null, none), false);
  const phone = p2pSteps("UPI_ID", { ...none, upiId: "a@b" }).steps.find((s) => s.key === "PHONE")!;
  assert.equal(phone.done, false);
  assert.equal(phone.required, false);
});

test("switching says what changes and that nothing is deleted", () => {
  const lines = switchSummary("UPI_ID", "PAYATOM", { ...none, upiId: "a@b" });
  assert.match(lines[0], /PayAtom/);
  assert.ok(lines.some((l) => /stays saved/.test(l)));
  assert.ok(lines.some((l) => /refused until/.test(l)));
  assert.ok(switchSummary("UPI_ID", "BHARATPE", { ...none, upiId: "a@b" }).some((l) => /in place of a@b/.test(l)));
  assert.ok(!switchSummary(null, "UPI_ID", { ...none, upiId: "a@b" }).some((l) => /stays saved|refused/.test(l)));
});

test("only known methods are accepted", () => {
  assert.equal(asP2pMethod("PAYATOM"), "PAYATOM");
  assert.equal(asP2pMethod("payatom"), null);
  assert.equal(asP2pMethod(null), null);
});
