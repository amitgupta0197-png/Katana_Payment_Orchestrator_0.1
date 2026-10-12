// Quasi-headless checkout (lib/headless): PSP routing by UPI handle, the app link, the one-PSP rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPsp, pspAppLink, pspForVpa, shellDoneUrl, startRefusal, validVpa } from "@/lib/headless";
import { P2P_KIND_OF, p2pProcessorAllowed, p2pSteps, type P2pFacts } from "@/lib/p2p-method";
import { gatewayDef } from "@/lib/pg-catalog";

test("the UPI handle picks the PSP: @ybl / @ibl / @axl → PhonePe, @paytm / @pt* → Paytm", () => {
  assert.equal(pspForVpa("rahul@ybl"), "PHONEPE");
  assert.equal(pspForVpa(" Rahul@IBL "), "PHONEPE");
  assert.equal(pspForVpa("a.b@axl"), "PHONEPE");
  assert.equal(pspForVpa("98765@paytm"), "PAYTM");
  assert.equal(pspForVpa("x@ptyes"), "PAYTM");
  assert.equal(pspForVpa("x@okaxis"), null);
  assert.equal(pspForVpa(""), null);
  assert.equal(pspForVpa(null), null);
});

test("pre-selected app: the handle's when the banker has it, else the banker's first", () => {
  assert.equal(defaultPsp("r@ybl", ["PHONEPE", "PAYTM"]), "PHONEPE");
  assert.equal(defaultPsp("r@paytm", ["PHONEPE", "PAYTM"]), "PAYTM");
  assert.equal(defaultPsp("r@paytm", ["PHONEPE"]), "PHONEPE");
  assert.equal(defaultPsp("r@okhdfc", ["PAYTM"]), "PAYTM");
  assert.equal(defaultPsp(null, []), null);
});

test("UPI IDs are checked for shape", () => {
  assert.ok(validVpa("rahul.k-1@ybl"));
  assert.ok(!validVpa("rahul"));
  assert.ok(!validVpa("@ybl"));
  assert.ok(!validVpa("a b@ybl"));
});

test("the Pay link: the PSP's own app link, else the app scheme, with upi:// as fallback", () => {
  assert.deepEqual(pspAppLink("PHONEPE", "pa=x@ybl&am=1"), { app: "phonepe://pay?pa=x@ybl&am=1", upi: "upi://pay?pa=x@ybl&am=1" });
  assert.equal(pspAppLink("PAYTM", "pa=x@paytm").app, "paytmmp://pay?pa=x@paytm");
  assert.equal(pspAppLink("PAYTM", "q", { paytm: "paytmmp://own" }).app, "paytmmp://own");
  assert.match(shellDoneUrl("u-1", "ORD 1", "SUCCESS"), /^katana:\/\/checkout\/done\?id=u-1&order_id=ORD\+1&status=SUCCESS$/);
});

test("a Pay tap is refused when it can't start, and the app can't change once started", () => {
  const base = { headless: true, status: "PENDING", expired: false, chosen: null, psp: "PHONEPE" as const, available: ["PHONEPE" as const, "PAYTM" as const] };
  assert.equal(startRefusal(base), null);
  assert.equal(startRefusal({ ...base, headless: false })?.code, "NOT_HEADLESS");
  assert.equal(startRefusal({ ...base, status: "SUCCESS" })?.code, "NOT_PAYABLE");
  assert.equal(startRefusal({ ...base, expired: true })?.code, "EXPIRED");
  assert.equal(startRefusal({ ...base, available: ["PAYTM"] })?.code, "PSP_UNAVAILABLE");
  assert.equal(startRefusal({ ...base, chosen: "PAYTM" })?.code, "PSP_LOCKED");
  assert.equal(startRefusal({ ...base, chosen: "PHONEPE" }), null);
  // Customer-facing words name the app, never a gateway.
  assert.doesNotMatch(startRefusal({ ...base, chosen: "PAYTM" })!.message, /gateway|PG\b/i);
});

test("HEADLESS is a quasi P2P method, ready with a PhonePe or Paytm P2P account, and never routed at order time", () => {
  const f: P2pFacts = { upiId: null, bharatpeMid: null, bharatpeAny: 0, payatomP2p: null, phones: { enrolled: 0, online: 0 } };
  assert.equal(P2P_KIND_OF.HEADLESS, "QUASI");
  assert.equal(p2pSteps("HEADLESS", f).ready, false);
  assert.equal(p2pSteps("HEADLESS", { ...f, headlessPsps: ["PAYTM"] }).ready, true);
  assert.equal(p2pProcessorAllowed("HEADLESS"), false);
});

test("PhonePe and Paytm accounts may be saved for P2P; blank stays Intent", () => {
  for (const id of ["PHONEPE", "PAYTM"]) {
    const d = gatewayDef(id)!;
    assert.equal(d.payin.p2p, true);
    const ch = d.payin.fields.find((x) => x.name === "channel")!;
    assert.equal(ch.optional, true);
    assert.deepEqual(ch.options!.map((o) => o.value), ["INTENT", "P2P"]);
  }
});
