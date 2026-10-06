// The support bot's get_limits view (lib/support-bot/limits-view): the amounts met on 2026-10-06.
import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsView } from "@/lib/support-bot/limits-view";
import type { BankerCheckFacts } from "@/lib/banker-check";

function facts(over: Partial<BankerCheckFacts> = {}): BankerCheckFacts {
  return {
    code: "BANKER", name: "Banker", blocked: false, stageClosed: false, stage: "LIVE", providerClosed: false,
    services: "UNSET", flow: { flow: "INTENT", active: null }, partnerExclusive: false, partnerName: null,
    liveActivated: true, activationStatus: "ACTIVATED", setup: [], account: null, upiId: null,
    phones: { enrolled: 0, online: 0, lastHeartbeat: null },
    limits: { min: 1, max: null, daily: null, upiMax: 100000 }, liveKey: true,
    callback: { url: null, lastOk: null, lastAt: null, lastHttp: null },
    ...over,
  };
}

const rubyvault = (golive: "VERIFYING" | "LIVE" | null, verifyCap = 1000) => ({
  gateway: "RUBYVAULT", gatewayName: "RubyVault", env: "PROD", connector: true, channel: "INTENT" as const,
  checkout: "REDIRECT" as const, golive, verifyCap, minAmount: 1000,
});

test("BBUY88 live on a ₹1,000-minimum account: ₹1,000 up to the UPI ceiling, redirect", () => {
  const v = limitsView(facts({ account: rubyvault("LIVE") }), null, 20);
  assert.equal(v.min_per_payment_rupees, 1000);
  assert.equal(v.max_per_payment_rupees, 100000);
  assert.equal(v.being_verified, false);
  assert.equal(v.no_amount_works, false);
  assert.equal(v.checkout, "REDIRECT");
  assert.ok(v.why.some((w) => /₹1,000 or more/.test(w)));
});

test("verifying: the cap is the maximum and the payments left are counted", () => {
  const v = limitsView(facts({ account: rubyvault("VERIFYING") }), 3, 20);
  assert.equal(v.min_per_payment_rupees, 1000);
  assert.equal(v.max_per_payment_rupees, 1000);
  assert.equal(v.being_verified, true);
  assert.equal(v.verification_payments_left, 17);
  assert.equal(v.no_amount_works, false);
});

test("verifying with a cap under the account's minimum: no amount works (the ₹500 cap of 2026-10-06)", () => {
  const v = limitsView(facts({ account: rubyvault("VERIFYING", 500) }), 0, 20);
  assert.equal(v.no_amount_works, true);
});

test("all verification payments used: no amount works", () => {
  const v = limitsView(facts({ account: rubyvault("VERIFYING") }), 20, 20);
  assert.equal(v.verification_payments_left, 0);
  assert.equal(v.no_amount_works, true);
});

test("the banker's own limits win over the defaults; the daily limit is reported", () => {
  const v = limitsView(facts({ account: rubyvault("LIVE"), limits: { min: 2000, max: 25000, daily: 500000, upiMax: 100000 } }), null, 20);
  assert.equal(v.min_per_payment_rupees, 2000);
  assert.equal(v.max_per_payment_rupees, 25000);
  assert.equal(v.daily_limit_rupees, 500000);
});

test("P2P on the banker's own UPI ID: no gateway minimum, H2H", () => {
  const v = limitsView(facts({ flow: { flow: "P2P", active: null }, upiId: "shop@okaxis" }), null, 20);
  assert.equal(v.min_per_payment_rupees, 1);
  assert.equal(v.checkout, "H2H");
});

test("an Intent account does not bound P2P orders", () => {
  const v = limitsView(facts({ flow: { flow: "P2P", active: null }, upiId: "shop@okaxis", account: rubyvault("VERIFYING") }), 0, 20);
  assert.equal(v.min_per_payment_rupees, 1);
  assert.equal(v.being_verified, false);
});

test("no gateway name reaches the merchant view", () => {
  const v = limitsView(facts({ account: rubyvault("VERIFYING") }), 1, 20);
  assert.doesNotMatch(JSON.stringify(v), /rubyvault/i);
});
