// Readable answers to a refused v1 order request (lib/order-request-errors).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { describeOrderRequestError, signingRuleFor, SIGNING_RULE } from "@/lib/order-request-errors";

const schema = z.object({ key: z.string().min(1), txnid: z.string().min(1), amount: z.string().min(1), hash: z.string().min(1) });
const why = (body: Record<string, unknown>) => {
  const r = schema.safeParse(body);
  assert.equal(r.success, false);
  return describeOrderRequestError(body, (r as { error: z.ZodError }).error);
};

test("a test page's other-gateway field names are named, not dumped", () => {
  // The body a merchant's own test page sent on 2026-10-03.
  const e = why({ key: "mk_live_x", order_id: "T1", amount: "1.00", customer_email: "a@b.co", signature: "abc" });
  assert.deepEqual(e.missing, ["txnid", "hash"]);
  assert.equal(e.code, "INVALID_REQUEST");
  assert.match(e.error, /^invalid request: missing: txnid, hash$/);
  assert.deepEqual(e.hints, [
    'you sent "order_id": Katana reads "txnid"',
    'you sent "customer_email": Katana reads "email"',
    'you sent "signature": Katana reads "hash"',
  ]);
  assert.ok(!/too_small|"code"/.test(e.error), "no validator dump");
});

test("a field sent under both names gets no hint", () => {
  const e = why({ key: "k", txnid: "", order_id: "T1", amount: "1", hash: "h" });
  assert.deepEqual(e.missing, ["txnid"]);
  assert.deepEqual(e.hints, []);
});

test("a present but wrong field is 'not valid', not 'missing'", () => {
  const e = why({ key: "k", txnid: "T1", amount: 5, hash: "h" });
  assert.deepEqual(e.missing, []);
  assert.equal(e.invalid[0].field, "amount");
});

test("the signing hint follows the key's scheme", () => {
  assert.equal(signingRuleFor("HMAC_SHA256"), SIGNING_RULE);
  assert.match(SIGNING_RULE, /HMAC-SHA256 hex of txnid\|amount\|productinfo\|email/);
  assert.match(signingRuleFor("PAYU_SHA512"), /^hash = SHA-512 hex of key\|txnid\|amount\|productinfo\|firstname\|email\|{11}salt/);
});
