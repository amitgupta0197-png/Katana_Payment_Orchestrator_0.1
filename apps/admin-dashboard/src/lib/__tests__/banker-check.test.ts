// "Check this banker" (lib/banker-check): the cases met on 2026-10-06.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBanker, type BankerCheckFacts } from "@/lib/banker-check";
import { setupItems } from "@/lib/merchant-services";

const NOW = new Date("2026-10-06T14:00:00Z");

function facts(over: Partial<BankerCheckFacts> = {}): BankerCheckFacts {
  const base: BankerCheckFacts = {
    code: "BANKER", name: "Banker", blocked: false, stageClosed: false, stage: "LIVE", providerClosed: false,
    services: "UNSET", flow: { flow: "UNSET", active: null }, partnerExclusive: false, partnerName: null,
    liveActivated: true, activationStatus: "ACTIVATED", setup: [], account: null, upiId: null,
    phones: { enrolled: 0, online: 0, lastHeartbeat: null },
    limits: { min: 1, max: null, daily: null, upiMax: 100000 }, liveKey: true,
    callback: { url: "https://merchant.example/cb", lastOk: true, lastAt: "2026-10-06T13:58:00Z", lastHttp: 200 },
  };
  const f = { ...base, ...over };
  // The SETUP items come from the real rule, as the store reads them (lib/merchant-setup bankerSetup).
  if (!over.setup) {
    const intent = !!f.account && f.account.channel === "INTENT";
    f.setup = setupItems(f.services, f.flow, { upiId: !!f.upiId || (!!f.account && f.account.channel === "P2P"), payinGateway: intent, payoutGateway: false });
  }
  return f;
}

const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

test("PAYATOM: on Intent with no payment account is refused, with the fix", () => {
  const r = checkBanker(facts({ code: "PAYATOM", services: "UNSET", flow: { flow: "INTENT", active: null } }), NOW);
  assert.equal(r.ready, false);
  assert.match(r.headline, /PAYATOM would refuse a live order/);
  const b = r.blockers.find((x) => x.key === "NO_PAYMENT_ACCOUNT");
  assert.ok(b, `blockers: ${keys(r.blockers)}`);
  assert.equal(b!.fix?.tab, "intent");
});

test("BAVTDV01: an exclusive partner's banker refuses its own orders", () => {
  const r = checkBanker(facts({
    code: "BAVTDV01", partnerExclusive: true, partnerName: "BUDY-PAY", upiId: "paytm.s2uizkk@pty",
    phones: { enrolled: 1, online: 1, lastHeartbeat: "2026-10-06T13:58:00Z" },
  }), NOW);
  assert.equal(r.ready, false);
  assert.deepEqual(keys(r.blockers), ["PARTNER_ONLY"]);
  assert.match(r.blockers[0].detail, /BUDY-PAY/);
  assert.ok(keys(r.passed).includes("PHONE"));
});

test("BBUY88: a live RubyVault account on Intent is ready", () => {
  const r = checkBanker(facts({
    code: "BBUY88", flow: { flow: "INTENT", active: null },
    account: { gateway: "RUBYVAULT", gatewayName: "RubyVault", env: "PROD", connector: true, channel: "INTENT", checkout: "REDIRECT", golive: "LIVE", verifyCap: 1000, minAmount: 1000 },
  }), NOW);
  assert.equal(r.ready, true, `blockers: ${keys(r.blockers)}`);
  assert.match(r.headline, /would take a live order/);
  assert.ok(keys(r.passed).includes("ACCOUNT"));
  assert.ok(keys(r.notes).includes("GATEWAY_MINIMUM"));
  assert.ok(!keys(r.notes).includes("VERIFYING"));
});

test("a verifying RubyVault account says its cap and the gateway minimum", () => {
  const r = checkBanker(facts({
    flow: { flow: "INTENT", active: null },
    account: { gateway: "RUBYVAULT", gatewayName: "RubyVault", env: "PROD", connector: true, channel: "INTENT", checkout: "REDIRECT", golive: "VERIFYING", verifyCap: 1000, minAmount: 1000 },
  }), NOW);
  assert.equal(r.ready, true);
  const v = r.notes.find((n) => n.key === "VERIFYING");
  assert.match(v?.detail ?? "", /₹1,000/);
  assert.ok(keys(r.notes).includes("GATEWAY_MINIMUM"));
});

test("a gateway minimum above the verifying cap is called out", () => {
  const r = checkBanker(facts({
    flow: { flow: "INTENT", active: null },
    account: { gateway: "RUBYVAULT", gatewayName: "RubyVault", env: "PROD", connector: true, channel: "INTENT", checkout: "REDIRECT", golive: "VERIFYING", verifyCap: 500, minAmount: 1000 },
  }), NOW);
  assert.match(r.notes.find((n) => n.key === "GATEWAY_MINIMUM")?.detail ?? "", /above the verification cap/);
});

test("live mode off, blocked, no key and a failing callback are each named", () => {
  const r = checkBanker(facts({
    blocked: true, liveActivated: false, activationStatus: "REQUESTED", liveKey: false,
    callback: { url: "https://m.example/cb", lastOk: false, lastAt: "2026-10-06T13:00:00Z", lastHttp: 404 },
  }), NOW);
  assert.deepEqual(keys(r.blockers).sort(), ["BLOCKED", "LIVE_MODE", "NO_LIVE_KEY"]);
  assert.match(r.blockers.find((b) => b.key === "LIVE_MODE")!.detail, /waiting for a Super Admin/);
  assert.match(r.notes.find((n) => n.key === "CALLBACK_FAILING")!.detail, /404/);
});

test("P2P with no UPI ID is refused; a sandbox account is refused on Intent", () => {
  const p2p = checkBanker(facts({ services: "PAYIN", flow: { flow: "P2P", active: null } }), NOW);
  assert.ok(keys(p2p.blockers).includes("NO_UPI_ID"));
  const sandbox = checkBanker(facts({
    flow: { flow: "INTENT", active: null },
    account: { gateway: "PAYU", gatewayName: "PayU", env: "TEST", connector: true, channel: "INTENT", checkout: "H2H", golive: null, verifyCap: 100, minAmount: null },
  }), NOW);
  assert.deepEqual(keys(sandbox.blockers), ["ACCOUNT_SANDBOX"]);
});

test("a payout-only merchant refuses pay-ins", () => {
  const r = checkBanker(facts({ services: "PAYOUT" }), NOW);
  assert.ok(keys(r.blockers).includes("PAYIN_NOT_ENABLED"));
});
