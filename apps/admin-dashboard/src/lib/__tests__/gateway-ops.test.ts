// The go-live checklist (lib/gateway-golive), the gateway health alerts (lib/gateway-performance)
// and what the request log keeps of a body (lib/api-log). Rules only: no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { goLiveChecklist, canGoLive, verifyingBlocker, gatewaySendsWebhooks, type GoLiveRow } from "@/lib/gateway-golive";
import { gatewayHealthAlerts, type GatewayHealth } from "@/lib/gateway-performance";
import { redactBody } from "@/lib/api-log";
import { outcomeOf } from "@/lib/gateway-webhook-log";

const account = (o: Partial<GoLiveRow> = {}): GoLiveRow => ({
  merchant_id: "M1", gateway: "RAZORPAY", status: "VERIFYING",
  ping_ok: null, ping_http_status: null, ping_at: null, ping_by: null,
  webhook_order_id: null, webhook_txn_id: null, webhook_at: null, webhook_by: null,
  status_order_id: null, status_at: null, status_by: null,
  live_at: null, live_by: null, note: null, created_at: "2026-10-03T00:00:00Z", created_by: "a@k", ...o,
});
const PING = { ping_ok: true, ping_http_status: 200, ping_at: "t1", ping_by: "a@k" };
const HOOK = { webhook_order_id: "o1", webhook_txn_id: "kp_1", webhook_at: "t2", webhook_by: "a@k" };
const STATUS = { status_order_id: "o1", status_at: "t3", status_by: "b@k" };

test("a new account has nothing done and cannot go live", () => {
  assert.deepEqual(goLiveChecklist(account()).map((i) => i.done), [false, false, false, false]);
  assert.equal(canGoLive(account()), false);
});

test("each missing step keeps the account from going live", () => {
  assert.equal(canGoLive(account({ ...HOOK, ...STATUS })), false);                 // no ping
  assert.equal(canGoLive(account({ ...PING, ...STATUS })), false);                 // no webhook payment
  assert.equal(canGoLive(account({ ...PING, ...HOOK })), false);                   // no status check
  assert.equal(canGoLive(account({ ...PING, ...HOOK, ...STATUS, ping_ok: false, ping_http_status: 502 })), false);
  assert.equal(canGoLive(account({ ...PING, ...HOOK, ...STATUS })), true);
});

test("the status check must be of the payment the webhook confirmed", () => {
  assert.equal(canGoLive(account({ ...PING, ...HOOK, ...STATUS, status_order_id: "another" })), false);
});

test("the results carry who recorded them", () => {
  const items = goLiveChecklist(account({ ...PING, ...HOOK, ...STATUS }));
  assert.deepEqual(items.slice(0, 3).map((i) => i.by), ["a@k", "a@k", "b@k"]);
  assert.equal(canGoLive(account({ ...PING, ...HOOK, ...STATUS, status_by: null })), false);
});

test("an account being verified takes small payments, and only so many", () => {
  assert.equal(verifyingBlocker(100, 0, 100, 20), null);
  assert.match(verifyingBlocker(100.01, 0, 100, 20) ?? "", /up to ₹100/);
  assert.equal(verifyingBlocker(50, 19, 100, 20), null);
  assert.match(verifyingBlocker(50, 20, 100, 20) ?? "", /have been used/);
});

test("PayU with a Client ID sends no webhook; every other account does", () => {
  assert.equal(gatewaySendsWebhooks("PAYU", "client_credentials"), false);
  assert.equal(gatewaySendsWebhooks("PAYU", "key_salt"), true);
  assert.equal(gatewaySendsWebhooks("RAZORPAY", null), true);
});

const gw = (o: Partial<Omit<GatewayHealth, "alerts">> = {}): Omit<GatewayHealth, "alerts"> => ({
  gateway_name: "PAYU", orders_last_24h: 40, paid_last_24h: 30, pct_confirmed: 0.75, median_confirm_latency_minutes: 2,
  webhooks_received_last_24h: 28, pct_revived_after_expiry: 0.03, last_webhook_at: "2026-10-03T00:00:00Z", ...o,
});

test("a gateway doing its job raises nothing", () => {
  assert.deepEqual(gatewayHealthAlerts(gw()), []);
});

test("orders but no webhook in 24 hours is an alert; no orders and no webhook is not", () => {
  assert.deepEqual(gatewayHealthAlerts(gw({ webhooks_received_last_24h: 0 })), ["NO_WEBHOOK"]);
  assert.deepEqual(gatewayHealthAlerts(gw({ orders_last_24h: 0, paid_last_24h: 0, webhooks_received_last_24h: 0, pct_confirmed: null, median_confirm_latency_minutes: null, pct_revived_after_expiry: null })), []);
});

test("a median confirmation over 30 minutes is an alert", () => {
  assert.deepEqual(gatewayHealthAlerts(gw({ median_confirm_latency_minutes: 30 })), []);
  assert.deepEqual(gatewayHealthAlerts(gw({ median_confirm_latency_minutes: 30.1 })), ["SLOW_CONFIRMATION"]);
});

test("more than a fifth of paid orders paid after expiry is an alert, once there are enough to judge", () => {
  assert.deepEqual(gatewayHealthAlerts(gw({ pct_revived_after_expiry: 0.2 })), []);
  assert.deepEqual(gatewayHealthAlerts(gw({ pct_revived_after_expiry: 0.21 })), ["HIGH_REVIVAL"]);
  assert.deepEqual(gatewayHealthAlerts(gw({ pct_revived_after_expiry: 1, paid_last_24h: 1 })), []);
});

test("a credential in a logged body is cut to a hint, at any depth", () => {
  const out = redactBody({ key: "mk_live_0123456789abcdef", hash: "a".repeat(64), amount: 100, nested: { salt: "s3cret-salt-value", note: "kept" }, list: [{ token: "tok_1234567890" }] }) as any;
  assert.equal(out.amount, 100);
  assert.equal(out.nested.note, "kept");
  for (const v of [out.key, out.hash, out.nested.salt, out.list[0].token]) assert.match(v, /^.{4}…\(\d+\)$/);
  assert.equal(JSON.stringify(out).includes("0123456789abcdef"), false);
  assert.equal(JSON.stringify(out).includes("s3cret"), false);
});

test("what a gateway check answered is recorded as one outcome", () => {
  assert.equal(outcomeOf({ applied: true }), "APPLIED");
  assert.equal(outcomeOf({ applied: false, reason: "already_final" }), "ALREADY_FINAL");
  assert.equal(outcomeOf({ applied: false, reason: "still pending" }), "NOT_FINAL");
  assert.equal(outcomeOf({ applied: false, reason: "lookup_failed" }), "LOOKUP_FAILED");
  assert.equal(outcomeOf({ applied: false, reason: "amount mismatch: x" }), "NOT_APPLIED");
});
