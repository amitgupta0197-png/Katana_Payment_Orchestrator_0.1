// The banker page's "What's left" (lib/banker-todo) and the plain words for refused orders
// (lib/plain-errors).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bankerTodo, type BankerTodoFacts } from "@/lib/banker-todo";
import type { BankerCheckFacts } from "@/lib/banker-check";
import { plainRefusal } from "@/lib/plain-errors";

const check = (over: Partial<BankerCheckFacts> = {}): BankerCheckFacts => ({
  code: "PAYATOM", name: "PAYATOM", blocked: false, stageClosed: false, stage: "CONFIG", providerClosed: false,
  services: "UNSET", flow: { flow: "INTENT", active: null }, partnerExclusive: false, partnerName: null,
  liveActivated: false, activationStatus: "NOT_REQUESTED", setup: [], account: null, upiId: null,
  phones: { enrolled: 0, online: 0, lastHeartbeat: null },
  limits: { min: 1, max: null, daily: null, upiMax: 100000 }, liveKey: true,
  callback: { url: null, lastOk: null, lastAt: null, lastHttp: null }, ...over,
});
const todo = (over: Partial<BankerTodoFacts> = {}, c: Partial<BankerCheckFacts> = {}): BankerTodoFacts => ({
  check: check(c),
  steps: { application: true, kyb: true, screening: true, bankVerify: true, approval: false },
  golive: null, livePaid: { intent: 0, p2p: 0 }, ...over,
});
const RV = { gateway: "RUBYVAULT", gatewayName: "RubyVault", env: "PROD", connector: true, channel: "INTENT" as const, checkout: "REDIRECT" as const, verifyCap: 1000, minAmount: 1000 };

test("PAYATOM on Intent with no account: 2 of 5, step 3 is next, later steps wait", () => {
  const t = bankerTodo(todo());
  assert.equal(t.live, false);
  assert.equal(t.done, 2);
  assert.match(t.headline, /PAYATOM can't take live payments yet/);
  const [, , account, test4, live5] = t.steps;
  assert.equal(account.key, "ACCOUNT");
  assert.equal(account.done, false);
  assert.equal(account.waitingFor, null);
  assert.equal(account.action?.tab, "intent");
  assert.equal(test4.waitingFor, 3);
  assert.equal(live5.waitingFor, 3);
});

test("the test payment step names the gateway's minimum and ticks from the go-live proof", () => {
  const before = bankerTodo(todo({ golive: { webhookAt: null, statusAt: null } }, { account: { ...RV, golive: "VERIFYING" } }));
  assert.equal(before.steps[3].title, "Make one real ₹1,000 payment");
  assert.equal(before.steps[3].done, false);
  const after = bankerTodo(todo({ golive: { webhookAt: "2026-10-06T13:36:38Z", statusAt: "2026-10-06T13:46:00Z" } }, { account: { ...RV, golive: "VERIFYING" } }));
  assert.equal(after.steps[3].done, true);
  // Live mode on, but the account still verifying: step 5 points at Gateway go-live.
  const s5 = bankerTodo(todo({ steps: { application: true, kyb: true, screening: true, bankVerify: true, approval: true }, golive: { webhookAt: "x", statusAt: "y" } },
    { liveActivated: true, account: { ...RV, golive: "VERIFYING" } })).steps[4];
  assert.equal(s5.done, false);
  assert.equal(s5.action?.href, "/gateway-golive");
});

test("BBUY88 live on RubyVault: every step done, a one-line summary", () => {
  const t = bankerTodo(todo({ steps: { application: true, kyb: true, screening: true, bankVerify: true, approval: true }, golive: { webhookAt: "x", statusAt: "y" } },
    { code: "BBUY88", liveActivated: true, account: { ...RV, golive: "LIVE" } }));
  assert.equal(t.live, true);
  assert.equal(t.done, 5);
  assert.match(t.headline, /BBUY88 takes live payments/);
});

test("P2P: the account step asks for the UPI ID and the test is ₹1 paid on P2P", () => {
  const t = bankerTodo(todo({}, { flow: { flow: "P2P", active: null } }));
  assert.equal(t.steps[2].title, "Save the UPI ID money lands on");
  assert.equal(t.steps[2].action?.tab, "p2p");
  assert.equal(t.steps[3].title, "Make one real ₹1 payment");
  const paid = bankerTodo(todo({ livePaid: { intent: 0, p2p: 1 } }, { flow: { flow: "P2P", active: null }, upiId: "x@okaxis" }));
  assert.equal(paid.steps[2].done, true);
  assert.equal(paid.steps[3].done, true);
});

test("a sandbox account doesn't count as connected", () => {
  const t = bankerTodo(todo({}, { account: { ...RV, env: "TEST", golive: null } }));
  assert.equal(t.steps[2].done, false);
  assert.match(t.steps[2].detail, /test credentials/);
});

test("refused orders in plain words: by code, by the processor's text, else the text itself", () => {
  assert.equal(plainRefusal("FLOW_NOT_READY").fix?.tab, "intent");
  assert.match(plainRefusal("PARTNER_ONLY").text, /exclusive partner/);
  assert.equal(plainRefusal("SIGNATURE_MISMATCH").merchantSide, true);
  assert.match(plainRefusal(null, "RubyVault did not start the checkout: Minimum amount should be 1000").text, /minimum of ₹1000/);
  assert.match(plainRefusal(null, "The payment processor is rate-limiting this request (HTTP 429). If this continues, contact Katana support with reference KP-1").text, /credentials/);
  assert.equal(plainRefusal(null, "Something odd. If this continues, contact Katana support with reference KP-2.").text, "Something odd");
  assert.equal(plainRefusal(null, null).text, "the order was refused");
});
