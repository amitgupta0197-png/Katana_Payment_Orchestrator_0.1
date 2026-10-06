// Host-to-host vs redirect (lib/pg-catalog gatewayCheckoutMode) and the readiness flag for a
// merchant that needs host-to-host (lib/merchant-services setupItems).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKOUT_MODE_WORDS, GATEWAYS, gatewayCheckoutMode } from "@/lib/pg-catalog";
import { payinConnector } from "@/lib/payin-providers";
import { setupItems } from "@/lib/merchant-services";
import { namesGateway } from "@/lib/merchant-safe";

test("each gateway's checkout mode", () => {
  const table = Object.fromEntries(GATEWAYS.map((g) => [g.id, gatewayCheckoutMode(g.id)]));
  assert.deepEqual(table, {
    PAYU: "H2H", RAZORPAY: "H2H", CASHFREE: "H2H", PHONEPE: "H2H", PAYTM: "H2H", PAYATOM: "H2H",
    CCAVENUE: "REDIRECT", RUBYVAULT: "REDIRECT", ISMARTPAY: "REDIRECT",
  });
  // PayU with a Client ID + Secret is Payment Links: a hosted page only.
  assert.equal(gatewayCheckoutMode("PAYU", "client_credentials"), "REDIRECT");
  assert.equal(gatewayCheckoutMode("PAYU", "key_salt"), "H2H");
  assert.equal(gatewayCheckoutMode("NOPE"), null);
  assert.equal(gatewayCheckoutMode(null), null);
});

test("the catalog's H2H flag matches what each connector can do", () => {
  // A connector with a UPI intent call is host-to-host; one without is redirect. PayU Key + Salt
  // has its own S2S intent (lib/payu-intent) and no entry in the connector table.
  for (const g of GATEWAYS) {
    if (g.id === "PAYU") continue;
    const c = payinConnector(g.id);
    assert.ok(c, `${g.id} has a connector`);
    assert.equal(!!c!.upiIntent, gatewayCheckoutMode(g.id) === "H2H", `${g.id}: catalog h2h vs connector upiIntent`);
  }
});

test("the plain words name no gateway", () => {
  for (const w of Object.values(CHECKOUT_MODE_WORDS)) for (const t of Object.values(w)) assert.ok(!namesGateway(t), t);
});

test("a merchant that needs H2H is flagged, never refused, on a redirect-only account", () => {
  const intent = { flow: "INTENT" as const, active: null };
  const facts = { upiId: false, payinGateway: true, payoutGateway: false };
  const item = (f: object) => setupItems("PAYIN", intent, { ...facts, ...f }).find((i) => i.key === "INTENT_H2H");
  assert.equal(item({}), undefined);                                                    // not needed: no item
  assert.equal(item({ needsH2h: true, intentCheckout: "REDIRECT" })?.state, "OPTIONAL_MISSING");
  assert.equal(item({ needsH2h: true, intentCheckout: "H2H" })?.state, "DONE");
  // No account yet: the INTENT_GATEWAY item says so; no H2H item on top.
  assert.equal(setupItems("PAYIN", intent, { ...facts, payinGateway: false, needsH2h: true }).some((i) => i.key === "INTENT_H2H"), false);
  // P2P only: never asked.
  assert.equal(setupItems("PAYIN", { flow: "P2P", active: null }, { ...facts, upiId: true, needsH2h: true, intentCheckout: "REDIRECT" })
    .some((i) => i.key === "INTENT_H2H"), false);
});
