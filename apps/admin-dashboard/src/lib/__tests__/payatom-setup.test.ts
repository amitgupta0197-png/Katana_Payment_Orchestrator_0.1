// Guided PayAtom setup (lib/payatom-setup): where each PayAtom account goes for what staff choose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN, payatomNow, planPayatom, type AccountNow } from "@/lib/payatom-setup";

const acc = (vault_label: string, gateway: string, channel: "P2P" | "INTENT"): AccountNow => ({ vault_label, gateway, channel });
const P2P_MAIN = acc(MAIN, "PAYATOM", "P2P"), INTENT_MAIN = acc(MAIN, "PAYATOM", "INTENT");
const INTENT_EXTRA = acc(`${MAIN}:x`, "PAYATOM", "INTENT"), PAYU_MAIN = acc(MAIN, "PAYU", "INTENT");

test("nothing chosen is refused", () => {
  assert.deepEqual(planPayatom([], { p2p: false, intent: false }, false).ok, false);
});

test("a banker with no processor: the chosen product is the main account", () => {
  assert.deepEqual(planPayatom([], { p2p: true, intent: false }, false), { ok: true, plan: { p2p: { label: MAIN }, intent: null, replaces: null } });
  assert.deepEqual(planPayatom([], { p2p: false, intent: true }, false), { ok: true, plan: { p2p: null, intent: { label: MAIN, addToSwitch: false }, replaces: null } });
});

test("both: P2P is the main account, Intent a new extra account in the switch", () => {
  assert.deepEqual(planPayatom([], { p2p: true, intent: true }, false),
    { ok: true, plan: { p2p: { label: MAIN }, intent: { label: "new", addToSwitch: true }, replaces: null } });
  // An Intent extra account already there is reused, not duplicated.
  const r = planPayatom([P2P_MAIN, INTENT_EXTRA], { p2p: true, intent: true }, false);
  assert.ok(r.ok && r.plan.intent?.label === INTENT_EXTRA.vault_label);
});

test("both, with PayAtom Intent in the main account today: it moves out, nothing is replaced", () => {
  const r = planPayatom([INTENT_MAIN], { p2p: true, intent: true }, false);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.plan.p2p?.label, r.plan.intent?.label, r.plan.replaces], [MAIN, "new", null]);
});

test("another gateway in the main account is replaced only when confirmed", () => {
  const r = planPayatom([PAYU_MAIN], { p2p: true, intent: false }, false);
  assert.ok(!r.ok && r.code === "MAIN_TAKEN" && r.replaces?.gateway === "PAYU");
  const ok = planPayatom([PAYU_MAIN], { p2p: true, intent: false }, true);
  assert.ok(ok.ok && ok.plan.replaces?.gateway === "PAYU");
  // Switching a banker from PayAtom P2P to PayAtom Intent only is a replacement too.
  assert.equal(planPayatom([P2P_MAIN], { p2p: false, intent: true }, false).ok, false);
});

test("rotating the same setup replaces nothing", () => {
  const r = planPayatom([P2P_MAIN, INTENT_EXTRA], { p2p: true, intent: false }, false);
  assert.ok(r.ok && r.plan.replaces === null);
});

test("what PayAtom does now: an extra Intent account counts only when it is in the switch", () => {
  assert.deepEqual(payatomNow([P2P_MAIN, INTENT_EXTRA], false), { p2p: P2P_MAIN, intent: INTENT_EXTRA, intentReachable: false });
  assert.equal(payatomNow([P2P_MAIN, INTENT_EXTRA], true).intentReachable, true);
  assert.equal(payatomNow([INTENT_MAIN], false).intentReachable, true);
  assert.deepEqual(payatomNow([PAYU_MAIN], false), { p2p: null, intent: null, intentReachable: false });
});
