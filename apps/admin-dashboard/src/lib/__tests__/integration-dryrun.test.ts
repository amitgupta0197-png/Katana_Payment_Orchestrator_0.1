// "Test my integration" rules (lib/integration-dryrun): reading what a merchant pastes, the amount
// checks, and merchant wording that names no gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amountProblems, dryRunResult, parseRequestText, setupProblem, SIGNATURE_FIX, BLOCKS_TEST_ORDERS } from "@/lib/integration-dryrun";

const GATEWAYS = /payu|razorpay|cashfree|ccavenue|phonepe|paytm|rubyvault|ismartpay|payatom/i;

test("a curl from Postman: the endpoint, the flow it asks for and the body", () => {
  const p = parseRequestText(`curl --location 'https://katanapay.co/api/v1/intent/order' \\
--header 'Content-Type: application/json' \\
--data-raw '{
  "key": "mk_test_abc", "txnid": "1vcesd", "amount": "20", "hash": "984d"
}'`);
  assert.equal(p.error, null);
  assert.equal(p.endpoint, "/api/v1/intent/order");
  assert.equal(p.flow, "INTENT");
  assert.equal(p.host, "katanapay.co");
  assert.equal(p.body?.txnid, "1vcesd");
});

test("a bare JSON body, or one pasted inside a chat message, goes to the general order API", () => {
  const a = parseRequestText(`{"key":"k","txnid":"t","amount":"1","hash":"h"}`);
  assert.equal(a.endpoint, "/api/v1/katana-pay/order");
  assert.equal(a.flow, null);
  const b = parseRequestText(`Request:\n{"key":"k","txnid":"t","amount":"1","hash":"h"}\nResponse: …`);
  assert.equal(b.body?.key, "k");
});

test("unreadable input says what to paste", () => {
  assert.match(parseRequestText("hello").error ?? "", /Paste the order request/);
  assert.match(parseRequestText(`{"key": "k",}`).error ?? "", /isn't valid JSON/);
});

test("live amounts: the larger of the banker's and the account's minimum, the verification cap", () => {
  const f = { min: 1, max: null, upiMax: 100000, accountMin: 1000, verifyCap: 1000 };
  assert.deepEqual(amountProblems(500, true, f).map((p) => p.code), ["AMOUNT_BELOW_MIN"]);
  assert.match(amountProblems(500, true, f)[0].title, /₹1,000/);
  assert.deepEqual(amountProblems(1500, true, f).map((p) => p.code), ["ACCOUNT_NOT_LIVE"]);
  assert.deepEqual(amountProblems(1000, true, f), []);
  assert.deepEqual(amountProblems(200000, true, { ...f, verifyCap: null }).map((p) => p.code), ["AMOUNT_ABOVE_MAX"]);
  assert.deepEqual(amountProblems(5, false, f), [], "test orders have no live minimum");
  assert.deepEqual(amountProblems(0, false, f).map((p) => p.code), ["INVALID_AMOUNT"]);
});

test("merchant wording names no gateway", () => {
  for (const k of ["BLOCKED", "LIVE_MODE", "PAYIN_NOT_ENABLED", "PARTNER_ONLY", "NO_PAYMENT_ACCOUNT", "ACCOUNT_SANDBOX"]) {
    const p = setupProblem(k)!;
    assert.ok(p, k);
    assert.doesNotMatch(p.title + p.fix, GATEWAYS);
  }
  for (const v of Object.values(SIGNATURE_FIX)) assert.doesNotMatch(v, GATEWAYS);
  assert.equal(setupProblem("NO_CALLBACK"), null);
  assert.ok(BLOCKS_TEST_ORDERS.has("PARTNER_ONLY") && !BLOCKS_TEST_ORDERS.has("LIVE_MODE"));
});

test("the headline says accepted or how many things to fix", () => {
  const ok = dryRunResult({ banker: "B", livemode: false, endpoint: "/x", problems: [], notes: [], passed: [] });
  assert.equal(ok.accepted, true);
  assert.match(ok.headline, /test order would be accepted/);
  const bad = dryRunResult({ banker: "B", livemode: true, endpoint: "/x", problems: [{ code: "A", title: "a", fix: "f" }, { code: "B", title: "b", fix: "f" }], notes: [], passed: [] });
  assert.equal(bad.accepted, false);
  assert.match(bad.headline, /2 things to fix/);
});
