// The rule that a merchant never learns which gateway sits behind Katana (lib/merchant-safe).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  merchantSafeBody, merchantSafeChannel, merchantSafeError, merchantSafeScheme, namesGateway, seesGatewayNames, stripGatewayNames,
} from "@/lib/merchant-safe";

// merchantSafeError logs the full text for operators; keep the test output quiet.
const realError = console.error;
before(() => { console.error = () => {}; });
after(() => { console.error = realError; });

const GATEWAY_ERRORS = [
  "PayU is rate-limiting this request (HTTP 429): Sorry, we are unable to process your payment due to Too many Requests. Kindly reach out to care@payu.in",
  "PayU returned a non-JSON reply (HTTP 429) — check the MID has UPI Intent S2S enabled and the Key + Salt are right",
  "PayU did not return a UPI intent (EX087): hash incorrectly calculated",
  "PayU unreachable",
  "iSmartPay takes ₹100 to ₹2,00,000 per payment",
  "this merchant's RubyVault credentials are sandbox (TEST); live orders need live credentials",
  "live PayU (Client ID) payments are not switched on yet",
  "Cashfree Payments has no UPI intent; use the hosted checkout (redirect=true)",
  "Cashfree refused the order: order_amount_invalid",
  "Razorpay did not return a UPI intent: BAD_REQUEST_ERROR",
];

test("no gateway error reaches a merchant with a gateway's name or its own words", () => {
  for (const e of GATEWAY_ERRORS) {
    const out = merchantSafeError(e, "test");
    assert.equal(namesGateway(out), false, out);
    assert.ok(!/care@|EX087: hash|order_amount_invalid|BAD_REQUEST_ERROR|Key \+ Salt/.test(out), out);
    assert.match(out, /reference KP-[0-9A-F]{8}\.$/);
  }
});

test("Katana's own facts in a gateway error are kept", () => {
  assert.match(merchantSafeError(GATEWAY_ERRORS[0], "test"), /^The payment processor is rate-limiting this request \(HTTP 429\)\./);
  assert.match(merchantSafeError(GATEWAY_ERRORS[4], "test"), /takes ₹100 to ₹2,00,000 per payment/);
});

test("an error that names no gateway is returned unchanged", () => {
  for (const e of ["txnid already used", "signature mismatch", "invalid amount"]) assert.equal(merchantSafeError(e, "test"), e);
});

test("a response body loses gateway keys, keeps the UPI app links, and renames gateway-named keys", () => {
  const out = merchantSafeBody({
    gateway: "PAYU", gateway_name: "PayU", payu_payment_id: "61", reused: false,
    order: { id: "x", channel_type: "INTENT", channel_id: "PAYU" },
    deeplinks: { phonepe: "phonepe://x", paytm: "paytm://y" },
  }, "test");
  assert.deepEqual(out, {
    gateway_payment_id: "61", reused: false,
    order: { id: "x", channel_type: "INTENT" },
    deeplinks: { phonepe: "phonepe://x", paytm: "paytm://y" },
  });
});

test("rail labels: Katana's own rail keeps its product name, every gateway is just a gateway", () => {
  assert.equal(merchantSafeChannel("KATANA"), "Katana Pay");
  assert.equal(merchantSafeChannel("PAYU"), "Gateway");
  assert.equal(merchantSafeChannel("rubyvault"), "Gateway");
  assert.equal(merchantSafeChannel("DIRECT"), "Direct");
  assert.equal(merchantSafeChannel("UPI_DIRECT"), "UPI_DIRECT");
  assert.equal(merchantSafeChannel(""), "—");
});

test("text and scheme ids", () => {
  assert.equal(stripGatewayNames("payu upi intent refused"), "gateway upi intent refused");
  assert.equal(merchantSafeScheme("PAYU_SHA512"), "SHA512_LEGACY");
  assert.equal(merchantSafeScheme("HMAC_SHA256"), "HMAC_SHA256");
});

test("only Katana staff see gateway names", () => {
  for (const p of ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE"]) assert.equal(seesGatewayNames(p), true, p);
  for (const p of ["PROVIDER", "MERCHANT", "BANKER", null, undefined, ""]) assert.equal(seesGatewayNames(p), false, String(p));
});
