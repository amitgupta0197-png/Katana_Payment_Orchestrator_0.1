// Guided PayAtom setup (lib/payatom-setup): where each PayAtom account goes for what staff choose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN, payatomNow, planPayatom, type AccountNow } from "@/lib/payatom-setup";
import { gatewayDef, gatewayTakesIntent } from "@/lib/pg-catalog";

const acc = (vault_label: string, gateway: string, channel: "P2P" | "INTENT"): AccountNow => ({ vault_label, gateway, channel });
const P2P_MAIN = acc(MAIN, "PAYATOM", "P2P"), INTENT_MAIN = acc(MAIN, "PAYATOM", "INTENT");
const INTENT_EXTRA = acc(`${MAIN}:x`, "PAYATOM", "INTENT"), PAYU_MAIN = acc(MAIN, "PAYU", "INTENT");

test("PayAtom P2P is always the main account", () => {
  assert.deepEqual(planPayatom([], false), { ok: true, plan: { p2p: { label: MAIN }, replaces: null } });
  // Rotating the same setup replaces nothing.
  const r = planPayatom([P2P_MAIN, INTENT_EXTRA], false);
  assert.ok(r.ok && r.plan.replaces === null);
});

test("another gateway, or a retired PayAtom Intent account, in the main account is replaced only when confirmed", () => {
  const r = planPayatom([PAYU_MAIN], false);
  assert.ok(!r.ok && r.code === "MAIN_TAKEN" && r.replaces?.gateway === "PAYU");
  assert.ok(planPayatom([PAYU_MAIN], true).ok);
  const old = planPayatom([INTENT_MAIN], false);
  assert.ok(!old.ok && /no longer used/.test(old.error));
  const ok = planPayatom([INTENT_MAIN], true);
  assert.ok(ok.ok && ok.plan.replaces === INTENT_MAIN);
});

test("what PayAtom does now: P2P, and any Intent account shown as retired", () => {
  assert.deepEqual(payatomNow([P2P_MAIN, INTENT_EXTRA]), { p2p: P2P_MAIN, retiredIntent: INTENT_EXTRA });
  assert.deepEqual(payatomNow([INTENT_MAIN]), { p2p: null, retiredIntent: INTENT_MAIN });
  assert.deepEqual(payatomNow([PAYU_MAIN]), { p2p: null, retiredIntent: null });
});

test("PayAtom takes no Intent order and is saved as P2P only", () => {
  assert.equal(gatewayTakesIntent("PAYATOM"), false);
  assert.equal(gatewayTakesIntent("PAYU"), true);
  assert.equal(gatewayTakesIntent("RUBYVAULT"), true);
  const channel = gatewayDef("PAYATOM")!.payin.fields.find((f) => f.name === "channel")!;
  assert.deepEqual(channel.options!.map((o) => o.value), ["P2P"]);
});
